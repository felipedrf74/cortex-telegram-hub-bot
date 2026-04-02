// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * In-process telemetry singleton for the Nexus Hub Status Portal.
 *
 * Owns:
 *  - Activity event ring buffer (200 entries, in-memory)
 *  - Scheduled job execution registry (name → last run metadata)
 *  - Bot reference storage (for restart polling action)
 *
 * This module has no project imports — it is a pure data store
 * with zero risk of circular dependencies.
 */
import type { Bot } from 'grammy';
import { logger } from '../utils/logger';

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

/** Register a callback to send Telegram alerts when jobs fail. */
export function setJobFailureNotifier(fn: FailureNotifier): void {
  _failureNotifier = fn;
}

/**
 * Wraps an async job callback with timing and success/failure tracking.
 * On failure, sends a Telegram notification (if notifier is registered)
 * and re-throws so existing logger.error calls continue to work.
 */
export function wrapJob(name: string, fn: () => Promise<void>): () => Promise<void> {
  const wrapped = async () => {
    // Skip if the owning sub-skill is disabled
    if (!isJobEnabled(name)) {
      logger.debug({ job: name }, 'Cron job skipped — sub-skill disabled');
      return;
    }

    const status = jobMap.get(name);
    if (!status) return fn(); // unregistered — run without tracking

    const startIso = new Date().toISOString();
    status.lastRunAt = startIso;
    status.lastResult = 'running';
    status.lastError = null;
    const start = Date.now();

    try {
      await fn();
      status.lastResult = 'success';
      status.lastDurationMs = Date.now() - start;
      pushEvent({
        ts: startIso,
        type: 'job',
        summary: `${status.label}: success (${status.lastDurationMs}ms)`,
        durationMs: status.lastDurationMs,
      });
      persistJobRun(name, 'success', status.lastDurationMs);
    } catch (err: any) {
      status.lastResult = 'failed';
      status.lastDurationMs = Date.now() - start;
      status.lastError = err?.message ?? String(err);
      pushEvent({
        ts: startIso,
        type: 'error',
        summary: `${status.label}: failed — ${(status.lastError ?? '').slice(0, 80)}`,
        durationMs: status.lastDurationMs,
      });
      persistJobRun(name, 'failed', status.lastDurationMs, status.lastError);
      // Notify user via Telegram (swallow notification errors to avoid masking the original)
      if (_failureNotifier) {
        _failureNotifier(status.label, status.lastError ?? 'unknown error').catch(() => {});
      }
      throw err; // re-throw so existing catch blocks in scheduler still fire
    }
  };

  // Store the wrapped callback so DST watchdog can re-invoke missed jobs
  const status = jobMap.get(name);
  if (status) status.wrappedFn = wrapped;

  return wrapped;
}

export function getJobStatuses(): JobStatus[] {
  return Array.from(jobMap.values());
}

/** Returns the internal job map — used by DST watchdog to access wrappedFn callbacks. */
export function getJobMap(): ReadonlyMap<string, JobStatus> {
  return jobMap;
}

// ─── Bot Reference (for restart polling) ─────────────────────────────

let _bot: Bot | null = null;
let _isRestarting = false;

export function setBotRef(bot: Bot): void {
  _bot = bot;
}

export function getBotRef(): Bot | null {
  return _bot;
}

export function isRestarting(): boolean {
  return _isRestarting;
}

export function setIsRestarting(v: boolean): void {
  _isRestarting = v;
}

// ─── Bot Identity (resolved via getMe at startup) ───────────────────

export interface BotIdentity {
  id: number;
  username: string;
  firstName: string;
  isBot: boolean;
}

let _botIdentity: BotIdentity | null = null;

export function setBotIdentity(identity: BotIdentity): void {
  _botIdentity = identity;
}

export function getBotIdentity(): BotIdentity | null {
  return _botIdentity;
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
let _garminConsecutiveFailures = 0;

export function recordGarminRefresh(ok: boolean): void {
  _lastGarminRefreshAt = new Date().toISOString();
  _lastGarminRefreshOk = ok;
  if (ok) {
    _garminConsecutiveFailures = 0;
  } else {
    _garminConsecutiveFailures++;
  }
}

export function getGarminRefreshStatus(): { at: string | null; ok: boolean } {
  return { at: _lastGarminRefreshAt, ok: _lastGarminRefreshOk };
}

// ─── Garmin Sync Health (activity fetch tracking) ───────────────────

export interface GarminSyncHealth {
  lastActivityFetchAt: string | null;
  lastActivityFetchOk: boolean;
  lastActivityCount: number;
  lastFetchError: string | null;
  consecutiveKeepaliveFailures: number;
  rateLimited: boolean;
  rateLimitedUntil: string | null;
  sessionAlive: boolean;
}

let _lastActivityFetchAt: string | null = null;
let _lastActivityFetchOk = false;
let _lastActivityCount = 0;
let _lastFetchError: string | null = null;
let _garminRateLimited = false;
let _garminRateLimitedUntil: string | null = null;
let _garminSessionAlive = false;

export function recordGarminActivityFetch(count: number, ok: boolean, error?: string): void {
  _lastActivityFetchAt = new Date().toISOString();
  _lastActivityFetchOk = ok;
  _lastActivityCount = count;
  _lastFetchError = ok ? null : (error ?? 'unknown error');
  if (ok) _garminSessionAlive = true;
}

export function recordGarminRateLimit(limited: boolean, untilIso?: string): void {
  _garminRateLimited = limited;
  _garminRateLimitedUntil = limited ? (untilIso ?? null) : null;
}

export function recordGarminSessionStatus(alive: boolean): void {
  _garminSessionAlive = alive;
}

export function getGarminSyncHealth(): GarminSyncHealth {
  return {
    lastActivityFetchAt: _lastActivityFetchAt,
    lastActivityFetchOk: _lastActivityFetchOk,
    lastActivityCount: _lastActivityCount,
    lastFetchError: _lastFetchError,
    consecutiveKeepaliveFailures: _garminConsecutiveFailures,
    rateLimited: _garminRateLimited,
    rateLimitedUntil: _garminRateLimitedUntil,
    sessionAlive: _garminSessionAlive,
  };
}

// ─── Database Provider (lazy, avoids circular imports) ───────────────

type DbProvider = () => { prepare(sql: string): { run(...args: any[]): void } };
let _getDb: DbProvider | null = null;

/** Set the database provider once the DB is initialized. */
export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
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
  } catch {
    // table may not exist yet — swallow
  }
}
