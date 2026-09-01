// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SQLite-backed background job queue.
 *
 * This queue is intentionally small: one table, leases, bounded retries, and
 * idempotency keys. It lets Nexus defer projections/delivery without adding
 * Redis/Kafka or making background jobs the source of truth.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { getCurrentContext } from '../utils/request-context';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter' | 'canceled';

export interface JobInput {
  jobId?: string;
  tenantId: number;
  userId?: number | null;
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  notBefore?: string | null;
  idempotencyKey: string;
  correlationId?: string | null;
  causationEventId?: string | null;
}

export interface JobRecord {
  jobId: string;
  tenantId: number;
  userId: number | null;
  jobType: string;
  payload: Record<string, unknown>;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  notBefore: string;
  lockedAt: string | null;
  lockOwner: string | null;
  /** Present on claimed rows; optional so older/manual record fixtures remain source-compatible. */
  fencingToken?: string | null;
  /** Present on claimed rows; optional so older/manual record fixtures remain source-compatible. */
  leaseExpiresAt?: string | null;
  idempotencyKey: string;
  correlationId: string | null;
  causationEventId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface JobHandler {
  jobType: string;
  idempotent?: boolean;
  handle(job: JobRecord): Promise<void> | void;
}

const STALE_JOB_LEASE_MINUTES = 15;
const JOB_LEASE_SECONDS = 15 * 60;
const JOB_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

type JobLeaseIdentity = Pick<JobRecord, 'jobId' | 'lockOwner' | 'fencingToken'>;

export class BackgroundJobLeaseLostError extends Error {
  readonly code = 'BACKGROUND_JOB_LEASE_LOST';

  constructor() {
    super('BACKGROUND_JOB_LEASE_LOST: job lease is expired, missing, or owned by another worker');
    this.name = 'BackgroundJobLeaseLostError';
  }
}

/**
 * Explicit handler-to-queue contract for failures that cannot succeed on an
 * unchanged replay. Subclasses keep their domain-specific code/message while
 * the queue owns the terminal disposition and still performs the fenced
 * terminal write.
 */
export class BackgroundJobTerminalError extends Error {
  readonly retryable = false as const;

  constructor(
    readonly code: string,
    message = `BACKGROUND_JOB_TERMINAL: ${code}`,
  ) {
    super(message);
    this.name = 'BackgroundJobTerminalError';
  }
}

export function isBackgroundJobTerminalError(err: unknown): err is BackgroundJobTerminalError {
  return err instanceof BackgroundJobTerminalError;
}

export function ensureBackgroundJobTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      job_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter', 'canceled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      fencing_token TEXT,
      lease_expires_at TEXT,
      idempotency_key TEXT NOT NULL,
      correlation_id TEXT,
      causation_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_idempotency
      ON background_jobs(tenant_id, COALESCE(user_id, 0), job_type, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_due
      ON background_jobs(status, not_before, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_scope_created
      ON background_jobs(tenant_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_lease_expiry
      ON background_jobs(status, lease_expires_at);
    -- Mirror migration 279 in fresh/test databases: every claim must rotate a
    -- fencing token and install a named, unexpired lease before any handler
    -- can execute. Tokenless processing rows migrated in flight retain their
    -- terminal-write grace until a worker attempts another claim.
    CREATE TRIGGER IF NOT EXISTS trg_background_jobs_fenced_claim_transition
    BEFORE UPDATE OF status ON background_jobs
    FOR EACH ROW
    WHEN NEW.status = 'processing'
      AND NOT (
        NEW.fencing_token IS NOT NULL
        AND NEW.fencing_token IS NOT OLD.fencing_token
        AND NEW.lock_owner IS NOT NULL
        AND length(trim(NEW.lock_owner)) > 0
        AND NEW.locked_at IS NOT NULL
        AND NEW.lease_expires_at IS NOT NULL
        AND NEW.lease_expires_at > datetime('now')
      )
    BEGIN
      SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_background_jobs_fenced_terminal_transition
    BEFORE UPDATE OF status ON background_jobs
    FOR EACH ROW
    WHEN OLD.status = 'processing'
      AND OLD.fencing_token IS NOT NULL
      AND NEW.status IN ('completed', 'failed', 'dead_letter')
      AND NOT (
        OLD.lease_expires_at IS NOT NULL
        AND NEW.lease_expires_at IS NULL
        AND NEW.fencing_token IS OLD.fencing_token
      )
    BEGIN
      SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_background_jobs_terminal_tombstone
    BEFORE UPDATE OF status ON background_jobs
    FOR EACH ROW
    WHEN NEW.status IN ('completed', 'failed', 'dead_letter')
      AND OLD.status != 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
    END;
  `);
}

export function enqueueJob(input: JobInput, db: Database.Database = getDb()): JobRecord {
  assertJobScope(input);
  ensureBackgroundJobTables(db);
  const userScope = input.userId ?? null;
  const existing = db.prepare(`
    SELECT * FROM background_jobs
    WHERE tenant_id = ?
      AND COALESCE(user_id, 0) = COALESCE(?, 0)
      AND job_type = ?
      AND idempotency_key = ?
  `).get(input.tenantId, userScope, input.jobType, input.idempotencyKey) as any | undefined;
  if (existing) return mapJob(existing);

  const jobId = input.jobId ?? randomUUID();
  const context = getCurrentContext();
  db.prepare(`
    INSERT INTO background_jobs (
      job_id, tenant_id, user_id, job_type, payload_json, priority, max_attempts,
      not_before, idempotency_key, correlation_id, causation_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
  `).run(
    jobId,
    input.tenantId,
    userScope,
    input.jobType,
    JSON.stringify(input.payload ?? {}),
    clampInt(input.priority, 0, 100, 50),
    clampInt(input.maxAttempts, 1, 10, 3),
    input.notBefore ?? null,
    input.idempotencyKey,
    input.correlationId ?? context?.requestId ?? null,
    input.causationEventId ?? null,
  );
  return mapJob(db.prepare('SELECT * FROM background_jobs WHERE job_id = ?').get(jobId) as any);
}

export function claimPendingJobs(
  limit = 10,
  lockOwner = `worker-${process.pid}`,
  db: Database.Database = getDb(),
  jobTypes?: string[],
  jobIds?: string[],
): JobRecord[] {
  ensureBackgroundJobTables(db);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  const effectiveLockOwner = typeof lockOwner === 'string' && lockOwner.trim()
    ? lockOwner.trim().slice(0, 128)
    : `worker-${process.pid}`;
  const boundedJobTypes = jobTypes
    ? Array.from(new Set(jobTypes.filter((jobType) => typeof jobType === 'string' && jobType.trim()).map((jobType) => jobType.trim())))
    : [];
  if (jobTypes && boundedJobTypes.length === 0) return [];
  const boundedJobIds = jobIds
    ? Array.from(new Set(jobIds.filter((jobId) => typeof jobId === 'string' && jobId.trim()).map((jobId) => jobId.trim())))
    : [];
  if (jobIds && boundedJobIds.length === 0) return [];
  const typePredicate = boundedJobTypes.length > 0
    ? `AND job_type IN (${boundedJobTypes.map(() => '?').join(', ')})`
    : '';
  const idPredicate = boundedJobIds.length > 0
    ? `AND job_id IN (${boundedJobIds.map(() => '?').join(', ')})`
    : '';
  return (db.prepare(`
    UPDATE background_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?,
        fencing_token = lower(hex(randomblob(16))),
        lease_expires_at = datetime('now', ?),
        started_at = COALESCE(started_at, datetime('now'))
    WHERE job_id IN (
      SELECT job_id
      FROM background_jobs
      WHERE (
        (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND (
            lease_expires_at <= datetime('now')
            OR (
              lease_expires_at IS NULL
              AND locked_at IS NOT NULL
              AND locked_at <= datetime('now', ?)
            )
          )
        )
      )
        ${typePredicate}
        ${idPredicate}
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, priority ASC, created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all(
    effectiveLockOwner,
    `+${JOB_LEASE_SECONDS} seconds`,
    `-${STALE_JOB_LEASE_MINUTES} minutes`,
    ...boundedJobTypes,
    ...boundedJobIds,
    boundedLimit,
  ) as any[]).map(mapJob);
}

export function listDueJobs(
  jobTypes: string[],
  limit = 10,
  db: Database.Database = getDb(),
): JobRecord[] {
  ensureBackgroundJobTables(db);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  const boundedJobTypes = Array.from(new Set(
    jobTypes.filter((jobType) => typeof jobType === 'string' && jobType.trim()).map((jobType) => jobType.trim()),
  ));
  if (boundedJobTypes.length === 0) return [];
  return (db.prepare(`
    SELECT *
      FROM background_jobs
     WHERE (
       (status IN ('pending', 'failed') AND not_before <= datetime('now'))
       OR (
         status = 'processing'
         AND (
           lease_expires_at <= datetime('now')
           OR (
             lease_expires_at IS NULL
             AND locked_at IS NOT NULL
             AND locked_at <= datetime('now', ?)
           )
         )
       )
     )
       AND job_type IN (${boundedJobTypes.map(() => '?').join(', ')})
     ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, priority ASC, created_at ASC
     LIMIT ?
  `).all(`-${STALE_JOB_LEASE_MINUTES} minutes`, ...boundedJobTypes, boundedLimit) as any[]).map(mapJob);
}

export async function processPendingJobs(
  handlers: JobHandler[],
  opts: {
    limit?: number;
    lockOwner?: string;
    db?: Database.Database;
    disabled?: boolean;
    jobIds?: string[];
    heartbeatIntervalMs?: number;
  } = {},
): Promise<{ completed: number; failed: number; deadLetter: number; skipped: number }> {
  if (opts.disabled || process.env.EVENT_BACKBONE_JOBS_DISABLED === '1') {
    return { completed: 0, failed: 0, deadLetter: 0, skipped: 1 };
  }
  const db = opts.db ?? getDb();
  const startedAt = Date.now();
  const handlersByType = new Map(handlers.map((handler) => [handler.jobType, handler]));
  const claimableJobTypes = handlersByType.has('*') ? undefined : Array.from(handlersByType.keys());
  const claimed = claimPendingJobs(
    opts.limit ?? 10,
    opts.lockOwner ?? `worker-${process.pid}`,
    db,
    claimableJobTypes,
    opts.jobIds,
  );
  let completed = 0;
  let failed = 0;
  let deadLetter = 0;
  let leaseLost = 0;
  // Start every heartbeat immediately: later rows in a claimed batch must not
  // expire while an earlier async handler is still running.
  const heartbeats = new Map(claimed.map((job) => [
    job.jobId,
    startJobLeaseHeartbeat(job, db, opts.heartbeatIntervalMs),
  ]));

  try {
    for (const job of claimed) {
      const handler = handlersByType.get(job.jobType) ?? handlersByType.get('*');
      const heartbeat = heartbeats.get(job.jobId)!;
      try {
        heartbeat.assertActive();
        if (handler) await handler.handle(job);
        heartbeat.assertActive();
        if (markJobCompleted(job, db)) completed += 1;
      } catch (err) {
        if (err instanceof BackgroundJobLeaseLostError) {
          leaseLost += 1;
        } else {
          try {
            const status = markJobFailed(job, err, db);
            if (status === 'dead_letter') deadLetter += 1;
            else if (status === 'failed') failed += 1;
          } catch (markErr) {
            if (markErr instanceof BackgroundJobLeaseLostError) leaseLost += 1;
            else throw markErr;
          }
        }
      } finally {
        heartbeat.stop();
      }
    }
  } finally {
    for (const heartbeat of heartbeats.values()) heartbeat.stop();
  }

  logger.info(
    {
      scope: 'background_jobs',
      claimed: claimed.length,
      completed,
      failed,
      deadLetter,
      leaseLost,
      durationMs: Date.now() - startedAt,
    },
    'background_job_batch',
  );
  return { completed, failed, deadLetter, skipped: 0 };
}

export function renewJobLease(
  job: JobLeaseIdentity,
  db: Database.Database = getDb(),
): string {
  const lease = requireJobLeaseIdentity(job, db);
  if (!lease) throw new BackgroundJobLeaseLostError();
  const renewed = db.prepare(`
    UPDATE background_jobs
       SET locked_at = datetime('now'),
           lease_expires_at = datetime('now', ?)
     WHERE job_id = ?
       AND status = 'processing'
       AND lock_owner = ?
       AND fencing_token = ?
       AND lease_expires_at > datetime('now')
    RETURNING lease_expires_at AS leaseExpiresAt
  `).get(
    `+${JOB_LEASE_SECONDS} seconds`,
    lease.jobId,
    lease.lockOwner,
    lease.fencingToken,
  ) as { leaseExpiresAt: string } | undefined;
  if (!renewed) throw new BackgroundJobLeaseLostError();
  return renewed.leaseExpiresAt;
}

export function markJobCompleted(
  job: JobLeaseIdentity | string,
  db: Database.Database = getDb(),
): boolean {
  const lease = requireJobLeaseIdentity(job, db);
  if (!lease) return false;
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = 'completed',
        completed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL
    WHERE job_id = ?
      AND status = 'processing'
      AND lock_owner = ?
      AND fencing_token = ?
      AND lease_expires_at > datetime('now')
  `).run(lease.jobId, lease.lockOwner, lease.fencingToken);
  if (result.changes === 0) {
    if (readJobStatus(lease.jobId, db) === 'canceled') return false;
    throw new BackgroundJobLeaseLostError();
  }
  return true;
}

export function markJobFailed(
  job: JobLeaseIdentity | string,
  err: unknown,
  db: Database.Database = getDb(),
): JobStatus {
  const lease = requireJobLeaseIdentity(job, db);
  if (!lease) return 'canceled';
  const row = db.prepare('SELECT attempts, max_attempts, status FROM background_jobs WHERE job_id = ?').get(lease.jobId) as { attempts: number; max_attempts: number; status: JobStatus } | undefined;
  if (row?.status === 'canceled') return 'canceled';
  const attempts = row?.attempts ?? 1;
  const maxAttempts = row?.max_attempts ?? 3;
  const terminal = isBackgroundJobTerminalError(err);
  const dead = terminal || attempts >= maxAttempts;
  const baseDelaySeconds = Math.min(3600, 2 ** Math.max(0, attempts - 1) * 30);
  const delaySeconds = Math.min(3600, baseDelaySeconds + Math.floor(Math.random() * Math.max(1, baseDelaySeconds * 0.3)));
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = ?,
        not_before = datetime('now', ?),
        locked_at = NULL,
        lock_owner = NULL,
        lease_expires_at = NULL,
        last_error = ?
    WHERE job_id = ?
      AND status = 'processing'
      AND lock_owner = ?
      AND fencing_token = ?
      AND lease_expires_at > datetime('now')
  `).run(
    dead ? 'dead_letter' : 'failed',
    dead ? '+0 seconds' : `+${delaySeconds} seconds`,
    safeError(err),
    lease.jobId,
    lease.lockOwner,
    lease.fencingToken,
  );
  if (result.changes === 0) {
    if (readJobStatus(lease.jobId, db) === 'canceled') return 'canceled';
    throw new BackgroundJobLeaseLostError();
  }
  if (dead) {
    logger.warn(
      {
        scope: 'background_jobs',
        jobId: lease.jobId,
        attempts,
        maxAttempts,
        terminalCode: terminal ? err.code : null,
        lastError: safeError(err),
      },
      'job_dead_lettered',
    );
  }
  return dead ? 'dead_letter' : 'failed';
}

export function cancelJob(jobId: string, dbOrTenantId: Database.Database | number = getDb(), maybeDb?: Database.Database): boolean {
  const tenantId = typeof dbOrTenantId === 'number' ? dbOrTenantId : null;
  const db = typeof dbOrTenantId === 'number' ? (maybeDb ?? getDb()) : dbOrTenantId;
  const tenantPredicate = tenantId ? 'AND tenant_id = ?' : '';
  const params: unknown[] = tenantId ? [jobId, tenantId] : [jobId];
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = 'canceled',
        completed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        fencing_token = NULL,
        lease_expires_at = NULL
    WHERE job_id = ?
      ${tenantPredicate}
      AND status IN ('pending', 'failed', 'processing', 'dead_letter')
  `).run(...params);
  return result.changes > 0;
}

export function listDeadLetterJobs(input: {
  tenantId: number;
  userId?: number | null;
  limit?: number;
}, db: Database.Database = getDb()): JobRecord[] {
  if (!isValidTenantUserId(input.tenantId)) throw new Error('tenantId required: must be a positive integer');
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 200));
  const params: unknown[] = [input.tenantId];
  let userPredicate = '';
  if (input.userId != null) {
    if (!isValidTenantUserId(input.userId)) throw new Error('userId required: must be a positive integer when provided');
    userPredicate = 'AND user_id = ?';
    params.push(input.userId);
  }
  params.push(limit);
  ensureBackgroundJobTables(db);
  return (db.prepare(`
    SELECT * FROM background_jobs
    WHERE tenant_id = ?
      ${userPredicate}
      AND status = 'dead_letter'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...params) as any[]).map(mapJob);
}

export function replayJob(jobId: string, tenantId: number, db: Database.Database = getDb()): boolean {
  if (!isValidTenantUserId(tenantId)) throw new Error('tenantId required: must be a positive integer');
  ensureBackgroundJobTables(db);
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = 'pending',
        attempts = 0,
        not_before = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        fencing_token = NULL,
        lease_expires_at = NULL,
        completed_at = NULL,
        last_error = NULL
    WHERE job_id = ?
      AND tenant_id = ?
      AND status IN ('failed', 'dead_letter', 'canceled')
  `).run(jobId, tenantId);
  return result.changes > 0;
}

function assertJobScope(input: JobInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'background_job_enqueue',
      reason: 'invalid_user_scope',
      userId: typeof input.tenantId === 'number' ? input.tenantId : null,
      details: { jobType: input.jobType },
    });
    throw new Error('tenantId required: must be a positive integer');
  }
  if (input.userId != null && !isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'background_job_enqueue',
      reason: 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: { jobType: input.jobType },
    });
    throw new Error('userId required: must be a positive integer when provided');
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value as number));
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function requireJobLeaseIdentity(
  job: JobLeaseIdentity | string,
  db: Database.Database,
): { jobId: string; lockOwner: string; fencingToken: string } | null {
  const jobId = typeof job === 'string' ? job : job.jobId;
  if (typeof job !== 'string' && job.lockOwner && job.fencingToken) {
    return { jobId, lockOwner: job.lockOwner, fencingToken: job.fencingToken };
  }
  // Keep the predecessor id-only signature source-compatible, but never let it
  // bypass fencing. A cancellation remains an idempotent no-op for late work.
  if (readJobStatus(jobId, db) === 'canceled') return null;
  throw new BackgroundJobLeaseLostError();
}

function readJobStatus(jobId: string, db: Database.Database): JobStatus | null {
  const row = db.prepare('SELECT status FROM background_jobs WHERE job_id = ?').get(jobId) as { status: JobStatus } | undefined;
  return row?.status ?? null;
}

export function startJobLeaseHeartbeat(
  job: JobLeaseIdentity,
  db: Database.Database,
  requestedIntervalMs?: number,
): { assertActive(): void; stop(): void } {
  const intervalMs = Number.isFinite(requestedIntervalMs)
    ? Math.max(25, Math.min(Math.floor(requestedIntervalMs as number), JOB_HEARTBEAT_INTERVAL_MS))
    : JOB_HEARTBEAT_INTERVAL_MS;
  let renewalError: unknown = null;
  const timer = setInterval(() => {
    try {
      renewJobLease(job, db);
    } catch (err) {
      renewalError = err;
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref();
  return {
    assertActive() {
      if (renewalError) throw renewalError;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

function mapJob(row: any): JobRecord {
  return {
    jobId: row.job_id,
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    jobType: row.job_type,
    payload: parseJsonObject(row.payload_json),
    priority: Number(row.priority ?? 50),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    notBefore: row.not_before,
    lockedAt: row.locked_at ?? null,
    lockOwner: row.lock_owner ?? null,
    ...(row.status === 'processing' && row.fencing_token != null ? { fencingToken: row.fencing_token as string } : {}),
    ...(row.status === 'processing' && row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at as string } : {}),
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id ?? null,
    causationEventId: row.causation_event_id ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    lastError: row.last_error ?? null,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
