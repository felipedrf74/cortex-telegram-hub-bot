// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  BackgroundJobTerminalError,
  claimPendingJobs,
  enqueueJob,
  markJobCompleted,
  markJobFailed,
  startJobLeaseHeartbeat,
  type JobRecord,
  type JobStatus,
} from './background-job-queue';
import {
  claimScheduledJobExecution,
  completeScheduledJobExecution,
  isScheduledJobExecutionLeaseActive,
  renewScheduledJobExecution,
  type ScheduledJobExecutionClaim,
} from './scheduled-job-execution-state';
import { getDb } from './database';
import {
  resolveDueReportSchedule,
  type ResolveDueReportOptions,
  type ScheduledReportJob,
} from './report-schedule-dispatcher';
import { logger } from '../utils/logger';

const REPORT_JOB_PREFIX = 'scheduled_report_delivery';
const CLAIM_BATCH_LIMIT = 50;
const REPORT_EXECUTION_LEASE_TTL_MS = 15 * 60_000;
const REPORT_EXECUTION_HEARTBEAT_MS = Math.floor(REPORT_EXECUTION_LEASE_TTL_MS / 3);

type ClaimedReportExecution = Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }>;

export interface ScheduledReportLease<T> {
  target: T;
  schedule: {
    job: ScheduledReportJob;
    userId: number;
    tenantId: number;
    localDate: string;
    timezone: string;
    capturedAt: string;
  };
  jobRecord: JobRecord;
  /** Inner local-date fence; the background job remains the durable dispatch owner. */
  executionClaim: ClaimedReportExecution;
}

export interface ScheduledReportCompletionReceipt {
  jobId: string;
  userId: number;
  tenantId: number;
  job: ScheduledReportJob;
  localDate: string;
  attempts: number;
  completedAt: string;
}

export interface ScheduledReportLeaseBatch<T> {
  leases: Array<ScheduledReportLease<T>>;
  failures: Array<{
    userId: number;
    tenantId: number;
    errorName: string;
  }>;
}

export interface ScheduledReportLeaseHeartbeat {
  assertActive(): void;
  stop(): void;
}

function reportJobType(job: ScheduledReportJob): string {
  return `${REPORT_JOB_PREFIX}:${job}`;
}

function reportIdempotencyKey(job: ScheduledReportJob, localDate: string): string {
  return `${job}:${localDate}`;
}

function reportExecutionScopeKey(schedule: ScheduledReportLease<unknown>['schedule']): string {
  return `tenant:${schedule.tenantId}:user:${schedule.userId}:local-date:${schedule.localDate}`;
}

/**
 * Yield an outer queue lease when the exact local-date effect is already
 * fenced by another worker. This is coordination, not a failed attempt: keep
 * the job pending and do not burn its bounded retry budget while the inner
 * lease is active.
 */
function deferOverlappingReportJob(record: JobRecord, db: ReturnType<typeof getDb>): boolean {
  const result = db.prepare(`
    UPDATE background_jobs
       SET status = 'pending',
           attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           not_before = datetime('now', '+30 seconds'),
           locked_at = NULL,
           lock_owner = NULL,
           fencing_token = NULL,
           lease_expires_at = NULL
     WHERE job_id = ?
       AND status = 'processing'
       AND lock_owner = ?
       AND fencing_token = ?
       AND lease_expires_at > datetime('now')
  `).run(record.jobId, record.lockOwner, record.fencingToken);
  return Number(result.changes) === 1;
}

function reportTargetScope(target: { tenantId: number; userId?: number }): string {
  return `${target.tenantId}:${target.userId ?? target.tenantId}`;
}

function reportRecordScope(record: Pick<JobRecord, 'tenantId' | 'userId'>): string {
  return `${record.tenantId}:${record.userId ?? record.tenantId}`;
}

function storedSchedule(
  record: JobRecord,
  expectedJob: ScheduledReportJob,
): ScheduledReportLease<unknown>['schedule'] | null {
  const payload = record.payload;
  const localDate = typeof payload.localDate === 'string' ? payload.localDate : '';
  const timezone = typeof payload.timezone === 'string' ? payload.timezone.trim() : '';
  const capturedAt = typeof payload.capturedAt === 'string' ? payload.capturedAt : '';
  if (
    payload.reportJob !== expectedJob
    || record.userId == null
    || !Number.isInteger(record.userId)
    || record.userId <= 0
    || !Number.isInteger(record.tenantId)
    || record.tenantId <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)
    || !DateTime.fromISO(localDate, { zone: 'utc' }).isValid
    || timezone.length === 0
    || timezone.length > 128
    || !DateTime.fromISO(capturedAt, { zone: 'utc' }).isValid
  ) {
    return null;
  }
  return {
    job: expectedJob,
    userId: record.userId,
    tenantId: record.tenantId,
    localDate,
    timezone,
    capturedAt,
  };
}

function safeErrorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw) ? raw : 'UnknownError';
}

/**
 * Enqueue and lease reports only after their local schedule is due.
 *
 * Unlike the legacy fire ledger, enqueueing is not completion: a failed or
 * expired lease stays retryable in the canonical background queue. The queue's
 * idempotency row prevents duplicate work, while completion writes an explicit
 * scoped receipt in the same transaction as the fenced terminal transition.
 */
export function claimDueScheduledReportLeases<T extends { tenantId: number; userId?: number }>(
  job: ScheduledReportJob,
  targets: T[],
  nowUtc: DateTime = DateTime.utc(),
  options: ResolveDueReportOptions<T> = {},
  lockOwner = `scheduled-report-${process.pid}`,
): Array<ScheduledReportLease<T>> {
  return claimDueScheduledReportLeaseBatch(job, targets, nowUtc, options, lockOwner).leases;
}

/** Detailed variant for schedulers that must fail/degrade on partial fan-out. */
export function claimDueScheduledReportLeaseBatch<T extends { tenantId: number; userId?: number }>(
  job: ScheduledReportJob,
  targets: T[],
  nowUtc: DateTime = DateTime.utc(),
  options: ResolveDueReportOptions<T> = {},
  lockOwner = `scheduled-report-${process.pid}`,
): ScheduledReportLeaseBatch<T> {
  if (targets.length === 0) return { leases: [], failures: [] };
  const db = getDb();
  const failures: ScheduledReportLeaseBatch<T>['failures'] = [];
  const targetsByScope = new Map(targets.map((target) => [reportTargetScope(target), target]));
  const candidateJobIds = new Set<string>();

  for (const target of targets) {
    try {
      const schedule = resolveDueReportSchedule(job, target, nowUtc, options);
      if (!schedule) continue;
      const record = enqueueJob({
        tenantId: schedule.tenantId,
        userId: schedule.userId,
        jobType: reportJobType(job),
        idempotencyKey: reportIdempotencyKey(job, schedule.localDate),
        maxAttempts: 5,
        priority: 30,
        payload: {
          reportJob: job,
          localDate: schedule.localDate,
          timezone: schedule.timezone,
          capturedAt: schedule.capturedAt,
        },
      }, db);
      candidateJobIds.add(record.jobId);
    } catch (error) {
      const failure = {
        errorName: safeErrorName(error),
        userId: target.userId ?? target.tenantId,
        tenantId: target.tenantId,
      };
      failures.push(failure);
      logger.warn({
        ...failure,
        job,
      }, 'Scheduled report enqueue failed for user; continuing');
    }
  }

  // A durable retry must not disappear merely because its original local-time
  // catch-up window has elapsed. Collect already-enqueued runnable jobs for
  // the active scoped targets as well as jobs first enqueued by this tick.
  const existingRunnable = db.prepare(`
    SELECT job_id AS jobId, tenant_id AS tenantId, user_id AS userId
      FROM background_jobs
     WHERE job_type = ?
       AND (
         (status IN ('pending', 'failed') AND not_before <= datetime('now'))
         OR (
           status = 'processing'
           AND (
             lease_expires_at <= datetime('now')
             OR (
               lease_expires_at IS NULL
               AND locked_at IS NOT NULL
               AND locked_at <= datetime('now', '-15 minutes')
             )
           )
         )
       )
  `).all(reportJobType(job)) as Array<{
    jobId: string;
    tenantId: number;
    userId: number | null;
  }>;
  for (const record of existingRunnable) {
    if (targetsByScope.has(reportRecordScope(record))) candidateJobIds.add(record.jobId);
  }

  const jobIds = [...candidateJobIds];
  const claimed: JobRecord[] = [];
  for (let offset = 0; offset < jobIds.length; offset += CLAIM_BATCH_LIMIT) {
    claimed.push(...claimPendingJobs(
      CLAIM_BATCH_LIMIT,
      lockOwner,
      db,
      [reportJobType(job)],
      jobIds.slice(offset, offset + CLAIM_BATCH_LIMIT),
    ));
  }

  const leases = claimed.flatMap((jobRecord) => {
    const target = targetsByScope.get(reportRecordScope(jobRecord));
    if (!target) return [];
    const schedule = storedSchedule(jobRecord, job);
    if (!schedule) {
      markJobFailed(
        jobRecord,
        new BackgroundJobTerminalError(
          'SCHEDULED_REPORT_PAYLOAD_INVALID',
          'Scheduled report job payload is malformed',
        ),
        db,
      );
      failures.push({
        userId: jobRecord.userId ?? jobRecord.tenantId,
        tenantId: jobRecord.tenantId,
        errorName: 'ScheduledReportPayloadInvalid',
      });
      return [];
    }
    let executionClaim: ClaimedReportExecution;
    try {
      const claim = claimScheduledJobExecution({
        jobName: `report:${job}`,
        scopeKey: reportExecutionScopeKey(schedule),
        leaseTtlMs: REPORT_EXECUTION_LEASE_TTL_MS,
      }, db);
      if (claim.kind !== 'claimed') {
        if (!deferOverlappingReportJob(jobRecord, db)) {
          throw new Error('SCHEDULED_REPORT_OVERLAP_DEFERRAL_NOT_WRITTEN');
        }
        logger.debug({
          job,
          userId: schedule.userId,
          tenantId: schedule.tenantId,
          localDate: schedule.localDate,
          overlapKind: claim.kind,
        }, 'Scheduled report queue lease deferred behind its local-date fence');
        return [];
      }
      executionClaim = claim;
    } catch (error) {
      try {
        markJobFailed(jobRecord, error, db);
      } catch {
        // A lost outer fence is already retryable by the queue after expiry.
      }
      failures.push({
        userId: schedule.userId,
        tenantId: schedule.tenantId,
        errorName: safeErrorName(error),
      });
      return [];
    }
    return [{
      target,
      schedule,
      jobRecord,
      executionClaim,
    }];
  });
  return { leases, failures };
}

export function completeScheduledReportLease<T>(lease: ScheduledReportLease<T>): boolean {
  const db = getDb();
  return db.transaction(() => {
    const completed = markJobCompleted(lease.jobRecord, db);
    if (!completed) return false;
    const receipt = db.prepare(`
      INSERT INTO scheduled_report_completion_receipts (
        receipt_id, job_id, user_id, tenant_id, report_job, local_date,
        attempts, completed_at
      )
      SELECT ?, job_id, ?, ?, ?, ?, attempts, completed_at
        FROM background_jobs
       WHERE job_id = ?
         AND status = 'completed'
         AND completed_at IS NOT NULL
    `).run(
      `scheduled-report-receipt:${lease.jobRecord.jobId}`,
      lease.schedule.userId,
      lease.schedule.tenantId,
      lease.schedule.job,
      lease.schedule.localDate,
      lease.jobRecord.jobId,
    );
    if (Number(receipt.changes) !== 1) {
      throw new Error('SCHEDULED_REPORT_COMPLETION_RECEIPT_NOT_WRITTEN');
    }
    if (!completeScheduledJobExecution(lease.executionClaim, 'success', db)) {
      throw new Error('SCHEDULED_REPORT_EXECUTION_CHECKPOINT_NOT_WRITTEN');
    }
    return true;
  })();
}

export function failScheduledReportLease<T>(
  lease: ScheduledReportLease<T>,
  error: unknown,
): JobStatus {
  // Report/provider failures may contain private report copy or raw provider
  // text. The durable queue needs a retry disposition, not that payload.
  const errorName = safeErrorName(error);
  const db = getDb();
  return db.transaction(() => {
    const status = markJobFailed(
      lease.jobRecord,
      new Error(`Scheduled report generation failed (${errorName})`),
      db,
    );
    if (!completeScheduledJobExecution(lease.executionClaim, 'failed', db)) {
      throw new Error('SCHEDULED_REPORT_FAILURE_CHECKPOINT_NOT_WRITTEN');
    }
    return status;
  })();
}

/** Keep a claimed report fenced while provider/generation work is in flight. */
export function startScheduledReportLeaseHeartbeat<T>(
  lease: ScheduledReportLease<T>,
  heartbeatIntervalMs?: number,
): ScheduledReportLeaseHeartbeat {
  const db = getDb();
  const outer = startJobLeaseHeartbeat(lease.jobRecord, db, heartbeatIntervalMs);
  const state = { leaseLost: false };
  const timer = setInterval(() => {
    if (state.leaseLost) return;
    try {
      state.leaseLost = !renewScheduledJobExecution(
        lease.executionClaim,
        db,
        new Date(),
        REPORT_EXECUTION_LEASE_TTL_MS,
      );
    } catch {
      state.leaseLost = true;
    }
  }, Math.min(heartbeatIntervalMs ?? REPORT_EXECUTION_HEARTBEAT_MS, REPORT_EXECUTION_HEARTBEAT_MS));
  timer.unref();
  return {
    assertActive(): void {
      outer.assertActive();
      if (state.leaseLost || !isScheduledJobExecutionLeaseActive(lease.executionClaim, db)) {
        throw new Error('SCHEDULED_REPORT_EXECUTION_LEASE_LOST');
      }
    },
    stop(): void {
      outer.stop();
      clearInterval(timer);
    },
  };
}

export function getScheduledReportCompletionReceipt(input: {
  userId: number;
  tenantId: number;
  job: ScheduledReportJob;
  localDate: string;
}): ScheduledReportCompletionReceipt | null {
  const row = getDb().prepare(`
    SELECT job_id, user_id, tenant_id, report_job, local_date, attempts, completed_at
      FROM scheduled_report_completion_receipts
     WHERE user_id = ?
       AND tenant_id = ?
       AND report_job = ?
       AND local_date = ?
     LIMIT 1
  `).get(
    input.userId,
    input.tenantId,
    input.job,
    input.localDate,
  ) as {
    job_id: string;
    user_id: number;
    tenant_id: number;
    report_job: ScheduledReportJob;
    local_date: string;
    attempts: number;
    completed_at: string;
  } | undefined;
  if (!row) return null;
  return {
    jobId: row.job_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    job: row.report_job,
    localDate: row.local_date,
    attempts: row.attempts,
    completedAt: row.completed_at,
  };
}
