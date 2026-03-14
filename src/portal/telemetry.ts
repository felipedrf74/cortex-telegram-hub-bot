/**
 * In-process telemetry singleton for the Cortex Status Portal.
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

export interface JobStatus {
  name: string;
  label: string;           // human-readable name
  cronExpression: string;
  lastRunAt: string | null;
  lastResult: 'success' | 'failed' | 'running' | 'never';
  lastDurationMs: number | null;
  lastError: string | null;
}

const jobMap = new Map<string, JobStatus>();

export function registerJob(name: string, label: string, cronExpression: string): void {
  jobMap.set(name, {
    name,
    label,
    cronExpression,
    lastRunAt: null,
    lastResult: 'never',
    lastDurationMs: null,
    lastError: null,
  });
}

/**
 * Wraps an async job callback with timing and success/failure tracking.
 * The wrapped function still propagates errors so existing logger.error
 * calls in the scheduler continue to work.
 */
export function wrapJob(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
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
      throw err; // re-throw so existing catch blocks in scheduler still fire
    }
  };
}

export function getJobStatuses(): JobStatus[] {
  return Array.from(jobMap.values());
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
