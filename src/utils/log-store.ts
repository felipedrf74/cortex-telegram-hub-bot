// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Runtime log store — makes pino output queryable from the operator portal.
 *
 * `createLogCaptureStream()` is attached as a second pino stream (see
 * `logger.ts`). Every line it sees has already passed pino redaction. Lines
 * go to:
 *   - an in-memory ring (all levels) that feeds the SSE live tail, and
 *   - a batched SQLite writer (info and above) into `runtime_logs`.
 *
 * This module lives in `utils/` and imports nothing from `services/` so the
 * logger can load it without creating a logger <-> database import cycle. The
 * database is handed in later via `attachLogStoreDb()` (called from
 * `src/index.ts` right after `initDatabase()`); until then rows buffer in
 * memory (bounded) and overflow is counted, never thrown.
 */

import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { sanitizeLogText } from './log-sanitizer';

export interface RuntimeLogLine {
  id?: number;
  ts: string;
  level: number;
  src: string | null;
  reqId: string | null;
  userId: number | null;
  msg: string;
  data: string | null;
}

export interface RuntimeLogFilter {
  level?: number;          // minimum pino level
  src?: string;
  reqId?: string;
  userId?: number;
  q?: string;              // substring match on msg
  since?: string;          // ISO lower bound (inclusive)
  until?: string;          // ISO upper bound (inclusive)
  beforeId?: number;       // pagination: rows with id < beforeId
  limit?: number;
}

export interface LogStoreStatus {
  enabled: boolean;
  dbAttached: boolean;
  ringSize: number;
  pendingRows: number;
  droppedLines: number;
  flushedRows: number;
  rowCount: number | null;
  oldestTs: string | null;
}

// Type-only: keeps this module free of a runtime better-sqlite3 dependency.
type MinimalDb = Pick<import('better-sqlite3').Database, 'prepare' | 'transaction'>;

export const LOG_STORE_RING_MAX = 2000;
export const LOG_STORE_MSG_MAX = 1000;
export const LOG_STORE_DATA_MAX = 4000;
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_MAX_ROWS = 200;
const PENDING_MAX_ATTACHED = 2000;
const PENDING_MAX_BOOT = 5000;
const MIN_PERSIST_LEVEL = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_MAX_AGE_HOURS = 72;
const PRUNE_MAX_ROWS = 500_000;
const OMITTED_DATA_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'reqId', 'src', 'userId', 'v']);

const ring: RuntimeLogLine[] = [];
let pending: RuntimeLogLine[] = [];
let getDbRef: (() => MinimalDb) | null = null;
let droppedLines = 0;
let flushedRows = 0;
let flushTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function isLogStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LOG_STORE_ENABLED ?? 'true') !== 'false';
}

function toIso(time: unknown): string {
  const n = typeof time === 'number' ? time : Number(time);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Normalise one parsed pino object into a storable line. */
export function normalizeLogObject(obj: Record<string, unknown>): RuntimeLogLine {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!OMITTED_DATA_KEYS.has(key)) rest[key] = value;
  }
  let data: string | null = null;
  if (Object.keys(rest).length > 0) {
    try {
      data = sanitizeLogText(JSON.stringify(rest)).slice(0, LOG_STORE_DATA_MAX);
    } catch {
      data = null;
    }
  }
  const rawMsg = typeof obj.msg === 'string' ? obj.msg : (obj.msg == null ? '' : String(obj.msg));
  return {
    ts: toIso(obj.time),
    level: toInt(obj.level) ?? 30,
    src: typeof obj.src === 'string' ? obj.src.slice(0, 64) : null,
    reqId: typeof obj.reqId === 'string' ? obj.reqId.slice(0, 64) : null,
    userId: toInt(obj.userId),
    msg: sanitizeLogText(rawMsg).slice(0, LOG_STORE_MSG_MAX),
    data,
  };
}

function scheduleFlush(): void {
  if (flushTimer || !getDbRef) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogStore();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** Ingest one already-parsed pino object (exported for tests and direct use). */
export function ingestLogObject(obj: Record<string, unknown>): void {
  const line = normalizeLogObject(obj);
  ring.push(line);
  if (ring.length > LOG_STORE_RING_MAX) ring.splice(0, ring.length - LOG_STORE_RING_MAX);
  emitter.emit('line', line);

  if (line.level < MIN_PERSIST_LEVEL) return;
  const cap = getDbRef ? PENDING_MAX_ATTACHED : PENDING_MAX_BOOT;
  if (pending.length >= cap) {
    droppedLines += 1;
    return;
  }
  pending.push(line);
  if (pending.length >= FLUSH_MAX_ROWS) {
    flushLogStore();
  } else {
    scheduleFlush();
  }
}

/** pino-compatible writable: one JSON object per line. */
export function createLogCaptureStream(): Writable {
  let carry = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      const text = carry + chunk.toString();
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') ingestLogObject(parsed as Record<string, unknown>);
        } catch {
          // Non-JSON line (pretty printer or stray console output) — ignore.
        }
      }
      callback();
    },
  });
}

export function attachLogStoreDb(getDb: () => MinimalDb): void {
  getDbRef = getDb;
  flushLogStore();
  if (!pruneTimer) {
    pruneTimer = setInterval(() => {
      try {
        pruneRuntimeLogs(getDb());
      } catch {
        // Prune is best-effort; the next tick retries.
      }
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }
}

export function flushLogStore(): number {
  if (!getDbRef || pending.length === 0) return 0;
  const batch = pending;
  pending = [];
  try {
    const db = getDbRef();
    const insert = db.prepare(
      'INSERT INTO runtime_logs (ts, level, src, req_id, user_id, msg, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const run = db.transaction((rows: RuntimeLogLine[]) => {
      for (const row of rows) {
        insert.run(row.ts, row.level, row.src, row.reqId, row.userId, row.msg, row.data);
      }
    });
    run(batch);
    flushedRows += batch.length;
    return batch.length;
  } catch {
    // Table missing (migration pending) or DB busy: count as dropped, never throw
    // from inside a log write.
    droppedLines += batch.length;
    return 0;
  }
}

export function pruneRuntimeLogs(
  db: MinimalDb,
  options: { maxAgeHours?: number; maxRows?: number } = {},
): { byAge: number; byCount: number } {
  const maxAgeHours = options.maxAgeHours ?? PRUNE_MAX_AGE_HOURS;
  const maxRows = options.maxRows ?? PRUNE_MAX_ROWS;
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const byAge = (db.prepare('DELETE FROM runtime_logs WHERE ts < ?').run(cutoff) as { changes?: number })?.changes ?? 0;
  const byCount = (db.prepare(
    'DELETE FROM runtime_logs WHERE id <= (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT 1 OFFSET ?)',
  ).run(maxRows) as { changes?: number })?.changes ?? 0;
  return { byAge, byCount };
}

function buildWhere(filter: RuntimeLogFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.level != null) { clauses.push('level >= ?'); params.push(filter.level); }
  if (filter.src) { clauses.push('src = ?'); params.push(filter.src); }
  if (filter.reqId) { clauses.push('req_id = ?'); params.push(filter.reqId); }
  if (filter.userId != null) { clauses.push('user_id = ?'); params.push(filter.userId); }
  if (filter.q) { clauses.push('msg LIKE ?'); params.push(`%${filter.q.replace(/[%_]/g, (c) => `\\${c}`)}%`); }
  if (filter.since) { clauses.push('ts >= ?'); params.push(filter.since); }
  if (filter.until) { clauses.push('ts <= ?'); params.push(filter.until); }
  if (filter.beforeId != null) { clauses.push('id < ?'); params.push(filter.beforeId); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function queryRuntimeLogs(db: MinimalDb, filter: RuntimeLogFilter = {}): RuntimeLogLine[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 200)));
  const { where, params } = buildWhere(filter);
  const escape = filter.q ? " ESCAPE '\\'" : '';
  const sql = `SELECT id, ts, level, src, req_id, user_id, msg, data FROM runtime_logs ${where.replace('msg LIKE ?', `msg LIKE ?${escape}`)} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    level: Number(row.level),
    src: (row.src as string | null) ?? null,
    reqId: (row.req_id as string | null) ?? null,
    userId: row.user_id == null ? null : Number(row.user_id),
    msg: String(row.msg),
    data: (row.data as string | null) ?? null,
  }));
}

export function lineMatchesFilter(line: RuntimeLogLine, filter: Pick<RuntimeLogFilter, 'level' | 'src' | 'reqId' | 'userId' | 'q'>): boolean {
  if (filter.level != null && line.level < filter.level) return false;
  if (filter.src && line.src !== filter.src) return false;
  if (filter.reqId && line.reqId !== filter.reqId) return false;
  if (filter.userId != null && line.userId !== filter.userId) return false;
  if (filter.q && !line.msg.toLowerCase().includes(filter.q.toLowerCase())) return false;
  return true;
}

export function getRecentRingLines(limit = 200, filter: RuntimeLogFilter = {}): RuntimeLogLine[] {
  const out: RuntimeLogLine[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (lineMatchesFilter(ring[i], filter)) out.push(ring[i]);
  }
  return out.reverse();
}

export function subscribeLogLines(listener: (line: RuntimeLogLine) => void): () => void {
  emitter.on('line', listener);
  return () => { emitter.off('line', listener); };
}

export function getLogStoreStatus(): LogStoreStatus {
  let rowCount: number | null = null;
  let oldestTs: string | null = null;
  if (getDbRef) {
    try {
      const db = getDbRef();
      const row = db.prepare('SELECT COUNT(*) AS c, MIN(ts) AS oldest FROM runtime_logs').get() as { c?: number; oldest?: string | null } | undefined;
      rowCount = Number(row?.c ?? 0);
      oldestTs = row?.oldest ?? null;
    } catch {
      rowCount = null;
    }
  }
  return {
    enabled: isLogStoreEnabled(),
    dbAttached: Boolean(getDbRef),
    ringSize: ring.length,
    pendingRows: pending.length,
    droppedLines,
    flushedRows,
    rowCount,
    oldestTs,
  };
}

export function _resetLogStoreForTests(): void {
  ring.length = 0;
  pending = [];
  getDbRef = null;
  droppedLines = 0;
  flushedRows = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  emitter.removeAllListeners('line');
}
