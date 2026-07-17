// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared retry policy helpers for Microsoft Graph calls (M6 item 9).
 *
 * Graph advertises throttling budgets through the `Retry-After` response
 * header on 429/503. The two withRetry helpers (src/services/microsoft-todo.ts
 * and src/services/task-store/microsoft-todo-adapter.ts) previously ignored it
 * and used blind exponential backoff, which both under-waits (re-hitting the
 * throttle) and over-waits (sleeping 8s when Graph asked for 1s). This module
 * centralizes:
 *
 *   - `graphRetryAfterMs(err)`: parse Retry-After (delta-seconds or HTTP-date)
 *     out of a Graph client error, bounded to [1s, 60s]; null when absent.
 *   - `graphRetryDelayMs(err, attempt)`: Retry-After when present, otherwise
 *     the pre-existing exponential backoff (1s * 2^attempt, capped at 10s) —
 *     byte-identical to the legacy delay when the header is missing.
 *   - in-memory 429 counters per source, surfaced through the task sync
 *     operational metrics (`getTaskSyncOperationalMetrics`) so pull-side
 *     rate-limit pressure is visible without a new persistence surface.
 */

const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const LEGACY_BACKOFF_CAP_MS = 10_000;

type RateLimitCounter = { count: number; lastAt: string };

const rateLimitCounters = new Map<string, RateLimitCounter>();

function headerLookup(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown> & { get?: (key: string) => unknown };
  if (typeof record.get === 'function') {
    try {
      const viaGet = record.get(name);
      if (viaGet != null) return viaGet;
    } catch { /* Headers#get variants that throw are treated as absent */ }
  }
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) return record[key];
  }
  return undefined;
}

/**
 * Extract a bounded Retry-After delay (ms) from a Graph client error, looking
 * in the places the SDK and raw fetch surfaces put response headers. Returns
 * null when no usable header is present.
 */
export function graphRetryAfterMs(err: unknown): number | null {
  const candidates = [
    headerLookup((err as any)?.headers, 'retry-after'),
    headerLookup((err as any)?.response?.headers, 'retry-after'),
    headerLookup((err as any)?.rawResponse?.headers, 'retry-after'),
    (err as any)?.retryAfter,
    (err as any)?.retryAfterSeconds,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const raw = String(candidate).trim();
    if (!raw) continue;
    const asSeconds = Number(raw);
    if (Number.isFinite(asSeconds)) {
      const ms = Math.round(asSeconds * 1000);
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
    }
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      const ms = asDate - Date.now();
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
    }
  }
  return null;
}

/**
 * Delay before the next Graph retry attempt: honors Retry-After when the
 * provider sent one, otherwise falls back to the legacy exponential backoff
 * so header-less behavior is unchanged.
 */
export function graphRetryDelayMs(err: unknown, attempt: number): number {
  const retryAfter = graphRetryAfterMs(err);
  if (retryAfter != null) return retryAfter;
  return Math.min(1000 * 2 ** attempt, LEGACY_BACKOFF_CAP_MS);
}

/** Count a 429 observation (pull or write side) for the metrics surface. */
export function recordGraphRateLimitHit(source: string): void {
  const key = String(source || 'unknown');
  const existing = rateLimitCounters.get(key);
  rateLimitCounters.set(key, {
    count: (existing?.count ?? 0) + 1,
    lastAt: new Date().toISOString(),
  });
}

export function getGraphRateLimitCounters(): Array<{ source: string; count: number; lastAt: string }> {
  return Array.from(rateLimitCounters.entries()).map(([source, counter]) => ({
    source,
    count: counter.count,
    lastAt: counter.lastAt,
  }));
}

/** Test-only: clear the in-memory 429 counters between vitest runs. */
export function _resetGraphRateLimitCountersForTests(): void {
  rateLimitCounters.clear();
}
