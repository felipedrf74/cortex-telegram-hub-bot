import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLogStoreForTests,
  attachLogStoreDb,
  createLogCaptureStream,
  flushLogStore,
  getLogStoreStatus,
  getRecentRingLines,
  ingestLogObject,
  LOG_STORE_RING_MAX,
  normalizeLogObject,
  pruneRuntimeLogs,
  queryRuntimeLogs,
  subscribeLogLines,
} from '../../src/utils/log-store';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let db: Database.Database;

beforeEach(() => {
  _resetLogStoreForTests();
  db = createMigratedTestDatabase();
});

afterEach(() => {
  _resetLogStoreForTests();
  db.close();
});

function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { level: 30, time: Date.parse('2026-09-04T10:00:00.000Z'), msg: 'hello', pid: 1, hostname: 'h', ...overrides };
}

describe('runtime log store', () => {
  it('normalises pino objects, redacts text and drops process noise from data', () => {
    const normalized = normalizeLogObject(line({ reqId: 'req-1', src: 'http', userId: 7, path: '/x', token: 'Bearer abcdefghijklmnop' }));
    expect(normalized).toMatchObject({ ts: '2026-09-04T10:00:00.000Z', level: 30, reqId: 'req-1', src: 'http', userId: 7, msg: 'hello' });
    expect(normalized.data).toContain('"path":"/x"');
    expect(normalized.data).not.toContain('pid');
    expect(normalized.data).not.toContain('abcdefghijklmnop');
  });

  it('parses newline-delimited JSON from the capture stream, including split chunks', async () => {
    const stream = createLogCaptureStream();
    const first = JSON.stringify(line({ msg: 'one' }));
    const second = JSON.stringify(line({ msg: 'two', level: 50 }));
    await new Promise<void>((resolve) => stream.write(`${first}\n${second.slice(0, 10)}`, () => resolve()));
    await new Promise<void>((resolve) => stream.write(`${second.slice(10)}\nnot json\n`, () => resolve()));
    const ring = getRecentRingLines(10);
    expect(ring.map((l) => l.msg)).toEqual(['one', 'two']);
  });

  it('buffers before the DB is attached and flushes once attached', () => {
    ingestLogObject(line({ msg: 'boot' }));
    ingestLogObject(line({ msg: 'debug-only', level: 20 }));
    expect(getLogStoreStatus()).toMatchObject({ dbAttached: false, pendingRows: 1, ringSize: 2 });

    attachLogStoreDb(() => db);
    expect(getLogStoreStatus()).toMatchObject({ dbAttached: true, pendingRows: 0, flushedRows: 1, rowCount: 1 });
    expect(queryRuntimeLogs(db)).toHaveLength(1);
    expect(queryRuntimeLogs(db)[0].msg).toBe('boot');
  });

  it('filters queries by level, source, request id, text and pagination', () => {
    attachLogStoreDb(() => db);
    ingestLogObject(line({ msg: 'alpha info', src: 'http', reqId: 'r1' }));
    ingestLogObject(line({ msg: 'beta warn', src: 'cron:x', reqId: 'r2', level: 40 }));
    ingestLogObject(line({ msg: 'gamma error', src: 'http', reqId: 'r1', level: 50, userId: 3 }));
    flushLogStore();

    expect(queryRuntimeLogs(db, { level: 40 }).map((l) => l.msg)).toEqual(['gamma error', 'beta warn']);
    expect(queryRuntimeLogs(db, { reqId: 'r1' })).toHaveLength(2);
    expect(queryRuntimeLogs(db, { src: 'cron:x' })[0].msg).toBe('beta warn');
    expect(queryRuntimeLogs(db, { q: 'gamma' })[0].userId).toBe(3);
    expect(queryRuntimeLogs(db, { q: '100%' })).toHaveLength(0);
    const page = queryRuntimeLogs(db, { limit: 1 });
    expect(queryRuntimeLogs(db, { beforeId: page[0].id, limit: 1 })[0].msg).toBe('beta warn');
  });

  it('bounds the ring and counts dropped rows when the pending buffer overflows', () => {
    for (let i = 0; i < LOG_STORE_RING_MAX + 100; i += 1) ingestLogObject(line({ msg: `m${i}`, level: 20 }));
    expect(getLogStoreStatus().ringSize).toBe(LOG_STORE_RING_MAX);
    for (let i = 0; i < 5200; i += 1) ingestLogObject(line({ msg: `p${i}` }));
    const status = getLogStoreStatus();
    expect(status.pendingRows).toBe(5000);
    expect(status.droppedLines).toBe(200);
  });

  it('counts a failed flush as dropped instead of throwing', () => {
    const broken = new Database(':memory:');
    attachLogStoreDb(() => broken);
    ingestLogObject(line({ msg: 'no table' }));
    expect(flushLogStore()).toBe(0);
    expect(getLogStoreStatus().droppedLines).toBe(1);
    broken.close();
  });

  it('prunes by age and by row cap', () => {
    attachLogStoreDb(() => db);
    for (let i = 0; i < 10; i += 1) {
      ingestLogObject(line({ msg: `old${i}`, time: Date.now() - 100 * 3_600_000 }));
    }
    for (let i = 0; i < 10; i += 1) ingestLogObject(line({ msg: `new${i}`, time: Date.now() }));
    flushLogStore();
    const result = pruneRuntimeLogs(db, { maxAgeHours: 72, maxRows: 4 });
    expect(result.byAge).toBe(10);
    expect(result.byCount).toBe(6);
    expect(queryRuntimeLogs(db)).toHaveLength(4);
  });

  it('notifies live subscribers for every line and supports unsubscribe', () => {
    const seen: string[] = [];
    const stop = subscribeLogLines((l) => seen.push(l.msg));
    ingestLogObject(line({ msg: 'live', level: 10 }));
    stop();
    ingestLogObject(line({ msg: 'after' }));
    expect(seen).toEqual(['live']);
  });
});
