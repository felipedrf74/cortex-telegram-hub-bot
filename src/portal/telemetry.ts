// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * In-process telemetry singleton for the Nexus Hub Status Portal.
 *
 * Owns:
 *  - Activity event ring buffer (200 entries, in-memory)
 *  - Scheduled job execution registry (name → last run metadata)
 *
 * Durable scheduled-job leases are delegated to a database-agnostic helper;
 * the database itself is still injected at boot to avoid circular imports.
 */
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { runWithContext, generateRequestId, type RequestSource } from '../utils/request-context';
import {
  claimScheduledJobExecution,
  completeScheduledJobExecution,
  isScheduledJobExecutionLeaseActive,
  renewScheduledJobExecution,
  DEFAULT_SCHEDULED_JOB_LEASE_HEARTBEAT_MS,
  type ScheduledJobExecutionClaim,
} from '../services/scheduled-job-execution-state';
import { safeContentLogErrorFields } from '../services/content-log-safety';

// ─── Activity Event Ring Buffer ──────────────────────────────────────

export type EventType = 'message' | 'tool_call' | 'error' | 'job' | 'api_call' | 'auth';

export interface ActivityEvent {
  ts: string;          // ISO 8601
  type: EventType;
  summary: string;     // max ~80 chars, displayed in table
  detail?: string;     // optional longer text
  domain?: string;     // 'secretary' | 'triathlon' | 'content'
  durationMs?: number;
}

const RING_SIZE = 200;
const ring: (ActivityEvent | null)[] = new Array(RING_SIZE).fill(null);
let ringHead = 0;
let ringCount = 0;

export function pushEvent(event: ActivityEvent): void {
  ring[ringHead] = event;
  ringHead = (ringHead + 1) % RING_SIZE;
  if (ringCount < RING_SIZE) ringCount++;
}

/** Returns events newest-first. */
export function getRecentEvents(): ActivityEvent[] {
  const result: ActivityEvent[] = [];
  for (let i = 0; i < ringCount; i++) {
    const idx = (ringHead - 1 - i + RING_SIZE) % RING_SIZE;
    const ev = ring[idx];
    if (ev) result.push(ev);
  }
  return result;
}

// ─── Scheduled Job Tracking ──────────────────────────────────────────

export type JobDomain = 'secretary' | 'triathlon' | 'content' | 'invoices' | 'system';

export interface JobStatus {
  name: string;
  label: string;           // human-readable name
  cronExpression: string;
  domain: JobDomain;
  lastRunAt: string | null;
  lastResult: 'success' | 'failed' | 'running' | 'never';
  lastDurationMs: number | null;
  lastError: string | null;
  wrappedFn?: () => Promise<void>; // stored by wrapJob for DST recovery
}

const jobMap = new Map<string, JobStatus>();
const inFlightJobs = new Set<string>();

export function registerJob(name: string, label: string, cronExpression: string, domain: JobDomain = 'system'): void {
  jobMap.set(name, {
    name,
    label,
    cronExpression,
    domain,
    lastRunAt: null,
    lastResult: 'never',
    lastDurationMs: null,
    lastError: null,
  });
}

// ─── Failure Notification Callback ────────────────────────────────────

type FailureNotifier = (jobLabel: string, errorMessage: string) => Promise<void>;
// ─── Sub-skill gating callback ──────────────────────────────────────
// Injected by scheduler.ts after skill-manager is initialized.
// Returns false if the cron job's owning sub-skill is disabled.
let _jobEnabledChecker: ((jobName: string) => boolean) | null = null;

export function setJobEnabledChecker(checker: (jobName: string) => boolean): void {
  _jobEnabledChecker = checker;
}

/** Check if a cron job is enabled (sub-skill not disabled). */
export function isJobEnabled(jobName: string): boolean {
  if (!_jobEnabledChecker) return true; // no checker registered → all jobs run
  return _jobEnabledChecker(jobName);
}

let _failureNotifier: FailureNotifier | null = null;

/** Register a callback invoked when jobs fail (records an operator alert). */
export function setJobFailureNotifier(fn: FailureNotifier): void {
  _failureNotifier = fn;
}

/**
 * Wraps an async job callback with timing and success/failure tracking.
 * On failure, invokes the failure notifier (if registered)
 * and re-throws so existing logger.error calls continue to work.
 *
 * The callback may return the sentinel string `'skipped'` to indicate that
 * the job was a no-op and should NOT be persisted to job_history. This is
 * for high-frequency cron jobs (e.g. reminders every minute) whose work
 * queue is empty 99%+ of the time — we want them to wake up and check, but
 * we don't want a row in job_history for every empty check. Existing void
 * callbacks remain unchanged: backwards-compatible.
 */
export type JobResult = void | 'skipped';

export class ScheduledJobLeaseLostError extends Error {
  readonly code = 'SCHEDULED_JOB_LEASE_LOST';
  readonly jobName: string;

  constructor(jobName: string) {
    super(`SCHEDULED_JOB_LEASE_LOST: ${jobName}`);
    this.name = 'ScheduledJobLeaseLostError';
    this.jobName = jobName;
  }
}

export class ScheduledJobLeaseStoreUnavailableError extends Error {
  readonly code = 'SCHEDULED_JOB_LEASE_STORE_UNAVAILABLE';
  readonly jobName: string;

  constructor(jobName: string) {
    super(`SCHEDULED_JOB_LEASE_STORE_UNAVAILABLE: ${jobName}`);
    this.name = 'ScheduledJobLeaseStoreUnavailableError';
    this.jobName = jobName;
  }
}

export interface ScheduledJobExecutionContext {
  readonly jobName: string;
  readonly signal: AbortSignal;
  /** Throw before the next external or user-visible effect if the fence is gone. */
  assertLeaseActive(): void;
}

export interface ScheduledJobWrapOptions {
  /** Override the tracing source for non-cron invocations such as startup. */
  requestSource?: RequestSource;
  /** Keep false for auxiliary invocations so DST recovery retains the cron callback. */
  storeForRecovery?: boolean;
  /** Persist, notify, and rethrow only bounded machine metadata for private jobs. */
  failureDetailPolicy?: 'default' | 'machine_only';
}

function usesMachineOnlyFailureDetails(
  status: JobStatus,
  options: ScheduledJobWrapOptions,
): boolean {
  return status.domain === 'content' || options.failureDetailPolicy === 'machine_only';
}

function scheduledJobFailureDetail(error: unknown, machineOnly: boolean): string {
  if (!machineOnly) return error instanceof Error ? error.message : String(error);
  return safeContentLogErrorFields(error).errorCode ?? 'CONTENT_SCHEDULED_JOB_FAILED';
}

function scheduledJobFailureLogFields(error: unknown, machineOnly: boolean): Record<string, unknown> {
  return machineOnly
    ? { ...safeContentLogErrorFields(error) }
    : { err: error instanceof Error ? error.message : String(error) };
}

function safeScheduledJobRethrow(error: unknown, machineOnly: boolean): unknown {
  if (!machineOnly) return error;
  const detail = scheduledJobFailureDetail(error, true);
  return Object.assign(new Error(detail), {
    name: 'ScheduledJobFailure',
    code: detail,
  });
}

function recordOverlapSkip(name: string, status: JobStatus): void {
  logger.warn({ job: name }, 'Cron job skipped — previous invocation still running');
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `${status.label}: skipped overlap`,
    detail: 'Previous invocation still running; skipped this tick to avoid duplicate work.',
  });
}

function recordJobFailure(
  name: string,
  status: JobStatus,
  startIso: string,
  startedAtMs: number,
  err: unknown,
  machineOnly: boolean,
): void {
  status.lastResult = 'failed';
  status.lastDurationMs = Date.now() - startedAtMs;
  status.lastError = scheduledJobFailureDetail(err, machineOnly);
  pushEvent({
    ts: startIso,
    type: 'error',
    summary: `${status.label}: failed — ${(status.lastError ?? '').slice(0, 80)}`,
    durationMs: status.lastDurationMs,
  });
  persistJobRun(name, 'failed', status.lastDurationMs, status.lastError);
  // Notification failures must never hide the original job/lease failure.
  if (_failureNotifier) {
    _failureNotifier(status.label, status.lastError ?? 'unknown error').catch(() => {});
  }
}

export function wrapJob(
  name: string,
  fn: (execution: ScheduledJobExecutionContext) => Promise<JobResult>,
  options: ScheduledJobWrapOptions = {},
): () => Promise<void> {
  const status = jobMap.get(name);
  if (!status) {
    throw new Error(`Cannot wrap unregistered scheduled job: ${name}`);
  }
  const machineOnlyFailureDetails = usesMachineOnlyFailureDetails(status, options);

  const wrapped = async () => {
    // Each invocation runs inside its own request context so all log lines
    // emitted during the job (and any HTTP calls it makes to content-engine
    // or external APIs) carry the same reqId. The source is "cron:<name>"
    // so logs can be filtered to a single job's history. (Quarter: tracing.)
    const requestId = generateRequestId();
    return runWithContext(
      { requestId, source: options.requestSource ?? `cron:${name}` as const },
      async () => {
        // Skip if the owning sub-skill is disabled
        if (!isJobEnabled(name)) {
          logger.debug({ job: name }, 'Cron job skipped — sub-skill disabled');
          return;
        }

        if (inFlightJobs.has(name)) {
          recordOverlapSkip(name, status);
          return;
        }

        let durableDb: Database.Database | null = null;
        let durableClaim: Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }> | null = null;
        let durableLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;
        const leaseAbortController = new AbortController();
        let leaseLostError: ScheduledJobLeaseLostError | null = null;
        const markLeaseLost = (): ScheduledJobLeaseLostError => {
          if (!leaseLostError) {
            leaseLostError = new ScheduledJobLeaseLostError(name);
            leaseAbortController.abort(leaseLostError);
          }
          return leaseLostError;
        };
        const execution: ScheduledJobExecutionContext = {
          jobName: name,
          signal: leaseAbortController.signal,
          assertLeaseActive(): void {
            if (leaseLostError) throw leaseLostError;
            if (!durableDb || !durableClaim) return;
            try {
              if (!isScheduledJobExecutionLeaseActive(durableClaim, durableDb)) {
                throw markLeaseLost();
              }
            } catch (err) {
              if (err instanceof ScheduledJobLeaseLostError) throw err;
              logger.error(
                { job: name, ...scheduledJobFailureLogFields(err, machineOnlyFailureDetails) },
                'Cron job durable lease effect guard failed',
              );
              throw markLeaseLost();
            }
          },
        };
        const leaseStartIso = new Date().toISOString();
        const leaseStartedAtMs = Date.now();
        try {
          if (!_getDb) {
            throw new ScheduledJobLeaseStoreUnavailableError(name);
          }
          durableDb = _getDb();
          const claim = claimScheduledJobExecution({ jobName: name }, durableDb);
          if (claim.kind !== 'claimed') {
            recordOverlapSkip(name, status);
            return;
          }
          durableClaim = claim;
          durableLeaseHeartbeat = setInterval(() => {
            try {
              if (!durableDb || !durableClaim) return;
              const renewed = renewScheduledJobExecution(durableClaim, durableDb);
              if (!renewed) {
                markLeaseLost();
                logger.error(
                  { job: name },
                  'Cron job durable lease heartbeat lost its fencing token',
                );
              }
            } catch (err) {
              markLeaseLost();
              logger.error(
                { job: name, ...scheduledJobFailureLogFields(err, machineOnlyFailureDetails) },
                'Cron job durable lease heartbeat failed',
              );
            }
          }, DEFAULT_SCHEDULED_JOB_LEASE_HEARTBEAT_MS);
          durableLeaseHeartbeat.unref?.();
        } catch (err) {
          // F36: an unavailable cluster fence is an operational failure, not
          // permission to run potentially duplicated work without a lease.
          status.lastRunAt = leaseStartIso;
          recordJobFailure(
            name,
            status,
            leaseStartIso,
            leaseStartedAtMs,
            err,
            machineOnlyFailureDetails,
          );
          throw safeScheduledJobRethrow(err, machineOnlyFailureDetails);
        }

        const startIso = new Date().toISOString();
        inFlightJobs.add(name);
        status.lastRunAt = startIso;
        status.lastResult = 'running';
        status.lastError = null;
        const start = Date.now();
        let durableResult: 'success' | 'skipped' | 'failed' = 'failed';

        try {
          execution.assertLeaseActive();
          const result = await fn(execution);
          execution.assertLeaseActive();
          status.lastDurationMs = Date.now() - start;
          // Skipped jobs don't get persisted or pushed to the activity ring —
          // they wake up, see no work, and exit silently. Status still updates
          // so the portal shows lastRunAt, but job_history is not written.
          if (result === 'skipped') {
            status.lastResult = 'success';
            durableResult = 'skipped';
            return;
          }
          status.lastResult = 'success';
          durableResult = 'success';
          pushEvent({
            ts: startIso,
            type: 'job',
            summary: `${status.label}: success (${status.lastDurationMs}ms)`,
            durationMs: status.lastDurationMs,
          });
          persistJobRun(name, 'success', status.lastDurationMs);
        } catch (err: any) {
          recordJobFailure(name, status, startIso, start, err, machineOnlyFailureDetails);
          // Private Content jobs preserve failure semantics without forwarding
          // provider/database messages into cron-library diagnostics.
          throw safeScheduledJobRethrow(err, machineOnlyFailureDetails);
        } finally {
          inFlightJobs.delete(name);
          if (durableLeaseHeartbeat) clearInterval(durableLeaseHeartbeat);
          if (durableDb && durableClaim) {
            try {
              const released = completeScheduledJobExecution(durableClaim, durableResult, durableDb);
              if (!released) {
                logger.warn({ job: name }, 'Cron job durable lease release lost its fencing token');
              }
            } catch (err: any) {
              logger.warn(
                { job: name, ...scheduledJobFailureLogFields(err, machineOnlyFailureDetails) },
                'Cron job durable lease release failed',
              );
            }
          }
        }
      },
    );
  };

  // Store the wrapped callback so DST watchdog can re-invoke missed jobs
  if (options.storeForRecovery !== false) status.wrappedFn = wrapped;

  return wrapped;
}

export function getJobStatuses(): JobStatus[] {
  return Array.from(jobMap.values());
}

/** Returns the internal job map — used by DST watchdog to access wrappedFn callbacks. */
export function getJobMap(): ReadonlyMap<string, JobStatus> {
  return jobMap;
}

let _isRestarting = false;

export function isRestarting(): boolean {
  return _isRestarting;
}

export function setIsRestarting(v: boolean): void {
  _isRestarting = v;
}

// ─── Bot Polling Status ──────────────────────────────────────────────

let _botPollingActive = false;
let _lastMessageAt: string | null = null;

export function setBotPollingActive(v: boolean): void {
  _botPollingActive = v;
}

export function isBotPollingActive(): boolean {
  return _botPollingActive;
}

export function recordMessageProcessed(): void {
  _lastMessageAt = new Date().toISOString();
}

export function getLastMessageAt(): string | null {
  return _lastMessageAt;
}

// ─── Garmin Status ───────────────────────────────────────────────────

let _lastGarminRefreshAt: string | null = null;
let _lastGarminRefreshOk = false;

export function recordGarminRefresh(ok: boolean): void {
  _lastGarminRefreshAt = new Date().toISOString();
  _lastGarminRefreshOk = ok;
}

export function getGarminRefreshStatus(): { at: string | null; ok: boolean } {
  return { at: _lastGarminRefreshAt, ok: _lastGarminRefreshOk };
}

// ─── Database Provider (lazy, avoids circular imports) ───────────────

type DbProvider = () => Database.Database;
let _getDb: DbProvider | null = null;

/** Set the database provider once the DB is initialized. */
export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
}

export function _resetTelemetryForTests(): void {
  ring.fill(null);
  ringHead = 0;
  ringCount = 0;
  jobMap.clear();
  inFlightJobs.clear();
  _jobEnabledChecker = null;
  _failureNotifier = null;
  _isRestarting = false;
  _botPollingActive = false;
  _lastMessageAt = null;
  _lastGarminRefreshAt = null;
  _lastGarminRefreshOk = false;
  _getDb = null;
}

/** Seed lastRunAt for all registered jobs from job_history. Call after DB init. */
export function seedJobLastRunFromHistory(): void {
  if (!_getDb) return;
  try {
    const db = _getDb() as any;
    const rows = db.prepare(`
      SELECT job_name, MAX(ts) as last_ts
      FROM job_history WHERE result = 'success'
      GROUP BY job_name
    `).all() as { job_name: string; last_ts: string }[];
    let seeded = 0;
    for (const row of rows) {
      const status = jobMap.get(row.job_name);
      if (status && !status.lastRunAt) {
        status.lastRunAt = new Date(row.last_ts + 'Z').toISOString();
        status.lastResult = 'success';
        seeded++;
      }
    }
    if (seeded > 0) {
      logger.info({ seeded }, 'DST watchdog: seeded lastRunAt from job_history');
    }
  } catch {
    // non-critical — watchdog will just be conservative
  }
}

/** Persist a job run to the job_history table (non-critical). */
function persistJobRun(jobName: string, result: string, durationMs: number | null, errorMessage?: string | null): void {
  if (!_getDb) return;
  try {
    _getDb().prepare(`
      INSERT INTO job_history (job_name, result, duration_ms, error_message)
      VALUES (?, ?, ?, ?)
    `).run(jobName, result, durationMs, errorMessage ?? null);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (/no such table/i.test(message)) {
      logger.debug({ jobName, result, err: message }, 'job_history persist skipped — table unavailable');
      return;
    }
    logger.warn({ jobName, result, err: message }, 'job_history persist failed');
  }
}
