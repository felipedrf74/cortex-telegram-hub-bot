// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * HTTP request ledger — sampled per-request rows in `http_request_log` for
 * the portal Requests explorer (lookup by x-request-id, latency percentiles
 * per normalised route, error rates).
 *
 * Fed from the portal server's response `finish` hook (see server.ts) and
 * written in batches off the request path. Storage rules
 * (`shouldStoreRequest`): every non-2xx, every slow request, every portal
 * mutation, a 1-in-50 sample of health/snapshot polling, and a configurable
 * sample of the remaining fast 2xx traffic.
 */

import crypto from 'crypto';

export type HttpSurface = 'ios' | 'portal' | 'webhook' | 'health' | 'oauth' | 'public' | 'static';

export interface HttpRequestLogEntry {
  ts: string;
  reqId: string;
  surface: HttpSurface;
  method: string;
  path: string;
  route: string;
  status: number;
  durationMs: number;
  userId: number | null;
  ipHash: string | null;
  userAgent: string | null;
  bytesOut: number | null;
  sampled: boolean;
}

export interface HttpRequestQuery {
  reqId?: string;
  userId?: number;
  path?: string;        // prefix match on raw path
  route?: string;
  status?: number;      // exact
  statusClass?: 2 | 3 | 4 | 5;
  minDurationMs?: number;
  surface?: HttpSurface;
  since?: string;
  until?: string;
  beforeId?: number;
  limit?: number;
}

export interface RouteLatency {
  route: string;
  method: string;
  count: number;
  errorCount: number;
  errorRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

// Type-only: keeps this module free of a runtime better-sqlite3 dependency.
type MinimalDb = Pick<import('better-sqlite3').Database, 'prepare' | 'transaction'>;

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_MAX_ROWS = 200;
const PENDING_MAX = 5000;
const SLOW_REQUEST_MS = 500;
const POLLING_SAMPLE_RATE = 1 / 50;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_MAX_AGE_DAYS = 7;
const PRUNE_MAX_ROWS = 500_000;
const USER_AGENT_MAX = 200;
const POLLING_PATHS = new Set(['/health', '/public-status', '/api/snapshot', '/api/usage/summary']);

let pending: HttpRequestLogEntry[] = [];
let getDbRef: (() => MinimalDb) | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let droppedRows = 0;
let flushedRows = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;
const LONG_TOKEN_RE = /^[A-Za-z0-9_-]{24,}$/;

export function normalizeRoute(path: string): string {
  const clean = path.split('?')[0] || '/';
  const segments = clean.split('/').map((segment) => {
    if (!segment) return segment;
    if (NUMERIC_RE.test(segment) || UUID_RE.test(segment) || HEX_RE.test(segment) || LONG_TOKEN_RE.test(segment)) return ':id';
    return segment;
  });
  return segments.join('/') || '/';
}

export function classifySurface(path: string): HttpSurface {
  if (path.startsWith('/api/v1/')) return 'ios';
  if (path.startsWith('/api/')) return 'portal';
  if (path.startsWith('/webhooks') || path.startsWith('/api/webhooks')) return 'webhook';
  if (path === '/health' || path.startsWith('/health/') || path === '/public-status') return 'health';
  if (path.startsWith('/oauth/')) return 'oauth';
  if (path.startsWith('/waitlist') || path.startsWith('/billing')) return 'public';
  return 'static';
}

export function sampleRateFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HTTP_LOG_SAMPLE_RATE ?? '0.1');
  if (!Number.isFinite(raw)) return 0.1;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Returns `null` when the request should not be stored, otherwise whether it
 * was kept through sampling (`true`) or by rule (`false`).
 */
export function shouldStoreRequest(
  entry: Pick<HttpRequestLogEntry, 'path' | 'surface' | 'method' | 'status' | 'durationMs'>,
  options: { random?: () => number; sampleRate?: number } = {},
): { store: boolean; sampled: boolean } {
  const random = options.random ?? Math.random;
  const sampleRate = options.sampleRate ?? sampleRateFromEnv();
  if (POLLING_PATHS.has(entry.path)) {
    return { store: random() < POLLING_SAMPLE_RATE, sampled: true };
  }
  if (entry.status < 200 || entry.status >= 300) return { store: true, sampled: false };
  if (entry.durationMs >= SLOW_REQUEST_MS) return { store: true, sampled: false };
  if (entry.surface === 'portal' && entry.method !== 'GET' && entry.method !== 'HEAD' && entry.method !== 'OPTIONS') {
    return { store: true, sampled: false };
  }
  return { store: random() < sampleRate, sampled: true };
}

export function hashClientIp(ip: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ip) return null;
  const salt = env.HTTP_LOG_IP_SALT || 'nexus-http-log';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

export function attachHttpRequestLogDb(getDb: () => MinimalDb): void {
  getDbRef = getDb;
  flushHttpRequestLog();
  if (!pruneTimer) {
    pruneTimer = setInterval(() => {
      try { pruneHttpRequestLog(getDb()); } catch { /* retried next tick */ }
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }
}

function scheduleFlush(): void {
  if (flushTimer || !getDbRef) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushHttpRequestLog(); }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** Queue one request row; never throws (called from a response finish hook). */
export function recordHttpRequest(entry: HttpRequestLogEntry): void {
  if (pending.length >= PENDING_MAX) { droppedRows += 1; return; }
  pending.push({ ...entry, userAgent: entry.userAgent ? entry.userAgent.slice(0, USER_AGENT_MAX) : null });
  if (pending.length >= FLUSH_MAX_ROWS) flushHttpRequestLog(); else scheduleFlush();
}

export function flushHttpRequestLog(): number {
  if (!getDbRef || pending.length === 0) return 0;
  const batch = pending;
  pending = [];
  try {
    const db = getDbRef();
    const insert = db.prepare(`
      INSERT INTO http_request_log
        (ts, req_id, surface, method, path, route, status, duration_ms, user_id, ip_hash, user_agent, bytes_out, sampled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction((rows: HttpRequestLogEntry[]) => {
      for (const r of rows) {
        insert.run(r.ts, r.reqId, r.surface, r.method, r.path, r.route, r.status, r.durationMs, r.userId, r.ipHash, r.userAgent, r.bytesOut, r.sampled ? 1 : 0);
      }
    })(batch);
    flushedRows += batch.length;
    return batch.length;
  } catch {
    droppedRows += batch.length;
    return 0;
  }
}

export function pruneHttpRequestLog(db: MinimalDb, options: { maxAgeDays?: number; maxRows?: number } = {}): { byAge: number; byCount: number } {
  const cutoff = new Date(Date.now() - (options.maxAgeDays ?? PRUNE_MAX_AGE_DAYS) * 86_400_000).toISOString();
  const byAge = (db.prepare('DELETE FROM http_request_log WHERE ts < ?').run(cutoff) as { changes?: number })?.changes ?? 0;
  const byCount = (db.prepare(
    'DELETE FROM http_request_log WHERE id <= (SELECT id FROM http_request_log ORDER BY id DESC LIMIT 1 OFFSET ?)',
  ).run(options.maxRows ?? PRUNE_MAX_ROWS) as { changes?: number })?.changes ?? 0;
  return { byAge, byCount };
}

function rowToEntry(row: Record<string, unknown>): HttpRequestLogEntry & { id: number } {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    reqId: String(row.req_id),
    surface: row.surface as HttpSurface,
    method: String(row.method),
    path: String(row.path),
    route: String(row.route),
    status: Number(row.status),
    durationMs: Number(row.duration_ms),
    userId: row.user_id == null ? null : Number(row.user_id),
    ipHash: (row.ip_hash as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    bytesOut: row.bytes_out == null ? null : Number(row.bytes_out),
    sampled: Number(row.sampled) === 1,
  };
}

export function queryHttpRequests(db: MinimalDb, query: HttpRequestQuery = {}): Array<HttpRequestLogEntry & { id: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.reqId) { clauses.push('req_id = ?'); params.push(query.reqId); }
  if (query.userId != null) { clauses.push('user_id = ?'); params.push(query.userId); }
  if (query.path) { clauses.push("path LIKE ? ESCAPE '\\'"); params.push(`${query.path.replace(/[%_]/g, (c) => `\\${c}`)}%`); }
  if (query.route) { clauses.push('route = ?'); params.push(query.route); }
  if (query.status != null) { clauses.push('status = ?'); params.push(query.status); }
  if (query.statusClass != null) { clauses.push('status >= ? AND status < ?'); params.push(query.statusClass * 100, (query.statusClass + 1) * 100); }
  if (query.minDurationMs != null) { clauses.push('duration_ms >= ?'); params.push(query.minDurationMs); }
  if (query.surface) { clauses.push('surface = ?'); params.push(query.surface); }
  if (query.since) { clauses.push('ts >= ?'); params.push(query.since); }
  if (query.until) { clauses.push('ts <= ?'); params.push(query.until); }
  if (query.beforeId != null) { clauses.push('id < ?'); params.push(query.beforeId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
  const rows = db.prepare(`SELECT * FROM http_request_log ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

export function getLatencyFromLog(db: MinimalDb, windowMinutes = 60, maxRows = 50_000): RouteLatency[] {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const rows = db.prepare(
    'SELECT route, method, status, duration_ms FROM http_request_log WHERE ts >= ? AND sampled = 0 ORDER BY id DESC LIMIT ?',
  ).all(since, maxRows) as Array<{ route: string; method: string; status: number; duration_ms: number }>;
  const sampledRows = db.prepare(
    'SELECT route, method, status, duration_ms FROM http_request_log WHERE ts >= ? AND sampled = 1 ORDER BY id DESC LIMIT ?',
  ).all(since, maxRows) as Array<{ route: string; method: string; status: number; duration_ms: number }>;
  const buckets = new Map<string, { route: string; method: string; durations: number[]; errors: number }>();
  for (const row of [...rows, ...sampledRows]) {
    const key = `${row.method} ${row.route}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { route: row.route, method: row.method, durations: [], errors: 0 }; buckets.set(key, bucket); }
    bucket.durations.push(Number(row.duration_ms));
    if (Number(row.status) >= 500) bucket.errors += 1;
  }
  return Array.from(buckets.values()).map((bucket) => {
    const sorted = bucket.durations.slice().sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      route: bucket.route,
      method: bucket.method,
      count,
      errorCount: bucket.errors,
      errorRate: count ? Number((bucket.errors / count).toFixed(4)) : 0,
      avgMs: count ? Math.round(sum / count) : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: count ? sorted[count - 1] : 0,
    };
  }).sort((a, b) => b.count - a.count);
}

export function getHttpRequestLogStatus(): { dbAttached: boolean; pendingRows: number; droppedRows: number; flushedRows: number } {
  return { dbAttached: Boolean(getDbRef), pendingRows: pending.length, droppedRows, flushedRows };
}

export function _resetHttpRequestLogForTests(): void {
  pending = [];
  getDbRef = null;
  droppedRows = 0;
  flushedRows = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}
