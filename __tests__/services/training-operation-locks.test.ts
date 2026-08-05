import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDb: Database.Database;
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  _resetTrainingOperationLocksForTests,
  acquireTrainingCalendarOperationLock,
  trainingCalendarOperationLockKey,
  withTrainingCalendarOperationLock,
} from '../../src/services/training-operation-locks';

describe('training operation SQLite advisory locks', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    _resetTrainingOperationLocksForTests();
    testDb?.close();
  });

  it('stores a DB-backed same-user calendar lock row while held and queues later acquisitions', async () => {
    const releaseFirst = await acquireTrainingCalendarOperationLock({
      userId: 42,
      tenantId: 84,
      operation: 'calendar_sync',
    });
    const lockKey = trainingCalendarOperationLockKey({ userId: 42, tenantId: 84 });
    const held = testDb.prepare('SELECT lock_key, operation FROM training_operation_locks WHERE lock_key = ?')
      .get(lockKey) as { lock_key: string; operation: string } | undefined;
    expect(held).toEqual({ lock_key: lockKey, operation: 'calendar_sync' });

    let secondAcquired = false;
    const second = acquireTrainingCalendarOperationLock({
      userId: 42,
      tenantId: 84,
      operation: 'calendar_cancel',
    }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    const afterRelease = testDb.prepare('SELECT COUNT(*) AS count FROM training_operation_locks')
      .get() as { count: number };
    expect(afterRelease.count).toBe(0);
  });

  it('requires tenant scope for operation locks', async () => {
    await expect(acquireTrainingCalendarOperationLock({
      userId: 42,
      tenantId: undefined as unknown as number,
      operation: 'calendar_sync',
    })).rejects.toMatchObject({ code: 'TENANT_SCOPE_REQUIRED' });
  });

  it('types lock-store unavailability as a retryable 503 without exposing scope', async () => {
    const runtimeEnv = {
      nodeEnv: process.env.NODE_ENV,
      vitest: process.env.VITEST,
      workerId: process.env.VITEST_WORKER_ID,
    };
    testDb.close();
    testDb = undefined as unknown as Database.Database;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;

    try {
      const error = await acquireTrainingCalendarOperationLock({
        userId: 42,
        tenantId: 84,
        operation: 'calendar_sync',
      }).then(
        () => null,
        (caught: unknown) => caught as Error & Record<string, unknown>,
      );

      expect(error).toMatchObject({
        code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
        status: 503,
        operation: 'calendar_sync',
        retryAfterSeconds: 5,
      });
      // Pin the complete public metadata surface; merely checking for one
      // known key would miss a future raw user, tenant, or owner field.
      expect(Object.fromEntries(
        Object.entries(error ?? {}).filter(([key]) => key !== 'name'),
      )).toEqual({
        code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
        status: 503,
        operation: 'calendar_sync',
        retryAfterSeconds: 5,
      });
      expect(error?.message).not.toMatch(/user:|tenant:|owner|42|84/);
    } finally {
      if (runtimeEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = runtimeEnv.nodeEnv;
      if (runtimeEnv.vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = runtimeEnv.vitest;
      if (runtimeEnv.workerId === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = runtimeEnv.workerId;
    }
  });

  it('maps a lock-store write failure after getDb to the typed unavailable contract', async () => {
    // The connection exists, but the lock table cannot be created/written.
    // This is the realistic SQLITE_READONLY/SQLITE_BUSY class that used to
    // escape the acquisition helper as a generic route-level 500.
    testDb.pragma('query_only = ON');
    try {
      const error = await acquireTrainingCalendarOperationLock({
        userId: 42,
        tenantId: 84,
        operation: 'calendar_sync',
      }).then(
        () => null,
        (caught: unknown) => caught as Error & Record<string, unknown>,
      );

      expect(error).toMatchObject({
        code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
        status: 503,
        operation: 'calendar_sync',
        retryAfterSeconds: 5,
      });
      expect(error?.message).not.toMatch(/readonly|database|user:|tenant:|42|84/i);
    } finally {
      testDb.pragma('query_only = OFF');
    }
  });

  it('does not queue same-user locks across different tenants', async () => {
    const releaseFirst = await acquireTrainingCalendarOperationLock({
      userId: 42,
      tenantId: 84,
      operation: 'calendar_sync',
    });

    let secondAcquired = false;
    const releaseSecond = await acquireTrainingCalendarOperationLock({
      userId: 42,
      tenantId: 85,
      operation: 'calendar_cancel',
    }).then((release) => {
      secondAcquired = true;
      return release;
    });

    expect(secondAcquired).toBe(true);
    releaseSecond();
    releaseFirst();
  });

  it('uses operation-aware TTLs so long provider writes are not stolen too early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));
    try {
      const generateRelease = await acquireTrainingCalendarOperationLock({
        userId: 43,
        tenantId: 84,
        operation: 'calendar_generate',
      });
      const generateRow = testDb.prepare(`
        SELECT acquired_at_ms, expires_at_ms
          FROM training_operation_locks
         WHERE lock_key = ?
      `).get(trainingCalendarOperationLockKey({ userId: 43, tenantId: 84 })) as {
        acquired_at_ms: number;
        expires_at_ms: number;
      };
      expect(generateRow.expires_at_ms - generateRow.acquired_at_ms).toBe(20 * 60_000);
      generateRelease();

      const reflowRelease = await acquireTrainingCalendarOperationLock({
        userId: 43,
        tenantId: 84,
        operation: 'calendar_reflow',
      });
      const reflowRow = testDb.prepare(`
        SELECT acquired_at_ms, expires_at_ms
          FROM training_operation_locks
         WHERE lock_key = ?
      `).get(trainingCalendarOperationLockKey({ userId: 43, tenantId: 84 })) as {
        acquired_at_ms: number;
        expires_at_ms: number;
      };
      expect(reflowRow.expires_at_ms - reflowRow.acquired_at_ms).toBe(10 * 60_000);
      reflowRelease();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews the SQLite lease while a long operation is still held', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));
    try {
      const release = await acquireTrainingCalendarOperationLock({
        userId: 45,
        tenantId: 84,
        operation: 'calendar_generate',
      });
      const lockKey = trainingCalendarOperationLockKey({ userId: 45, tenantId: 84 });
      const initial = testDb.prepare(`
        SELECT expires_at_ms FROM training_operation_locks WHERE lock_key = ?
      `).get(lockKey) as { expires_at_ms: number };

      await vi.advanceTimersByTimeAsync(7 * 60_000);

      const renewed = testDb.prepare(`
        SELECT expires_at_ms FROM training_operation_locks WHERE lock_key = ?
      `).get(lockKey) as { expires_at_ms: number };
      expect(renewed.expires_at_ms).toBeGreaterThan(initial.expires_at_ms);
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never resurrects an expired SQLite lease during heartbeat renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-lock-expiry-'));
    const dbPath = path.join(tempDir, 'locks.sqlite');
    testDb.close();
    testDb = new Database(dbPath);
    const secondConnection = new Database(dbPath);
    try {
      const lease = await acquireTrainingCalendarOperationLock({
        userId: 46,
        tenantId: 84,
        operation: 'calendar_sync',
      });
      const lockKey = trainingCalendarOperationLockKey({ userId: 46, tenantId: 84 });
      secondConnection.prepare(`
        UPDATE training_operation_locks
           SET expires_at_ms = ?
         WHERE lock_key = ?
      `).run(Date.now() - 1, lockKey);

      await vi.advanceTimersByTimeAsync(5 * 60_000);

      const row = secondConnection.prepare(`
        SELECT expires_at_ms FROM training_operation_locks WHERE lock_key = ?
      `).get(lockKey) as { expires_at_ms: number };
      expect(row.expires_at_ms).toBeLessThanOrEqual(Date.now());
      expect(() => lease.assertActive()).toThrowError(
        expect.objectContaining({ code: 'TRAINING_OPERATION_LOCKED' }),
      );
      lease();
    } finally {
      secondConnection.close();
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a stale owner through a second connection before it can continue', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-lock-owner-'));
    const dbPath = path.join(tempDir, 'locks.sqlite');
    testDb.close();
    testDb = new Database(dbPath);
    const secondConnection = new Database(dbPath);
    try {
      await expect(withTrainingCalendarOperationLock({
        userId: 47,
        tenantId: 84,
        operation: 'calendar_generate',
      }, async (lease) => {
        const lockKey = trainingCalendarOperationLockKey({ userId: 47, tenantId: 84 });
        secondConnection.prepare(`
          UPDATE training_operation_locks
             SET owner_token = 'replacement-owner',
                 expires_at_ms = ?
           WHERE lock_key = ?
        `).run(Date.now() + 20 * 60_000, lockKey);
        lease.assertActive();
      })).rejects.toMatchObject({
        code: 'TRAINING_OPERATION_LOCKED',
        status: 409,
        operation: 'calendar_generate',
      });

      expect(secondConnection.prepare(`
        SELECT owner_token FROM training_operation_locks
      `).get()).toEqual({ owner_token: 'replacement-owner' });
    } finally {
      secondConnection.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ships tenant-scoped advisory locks in migrations, not only runtime bootstrap', () => {
    testDb.exec(fs.readFileSync(
      path.join(MIGRATIONS_DIR, '127_training_plan_generation_idempotency.sql'),
      'utf8',
    ));
    testDb.exec(fs.readFileSync(
      path.join(MIGRATIONS_DIR, '154_training_operation_locks.sql'),
      'utf8',
    ));
    testDb.exec(fs.readFileSync(
      path.join(MIGRATIONS_DIR, '207_training_tenant_scoped_idempotency_and_locks.sql'),
      'utf8',
    ));

    const table = testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_operation_locks'
    `).get() as { name: string } | undefined;
    expect(table?.name).toBe('training_operation_locks');
    const scopedIdempotency = testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_plan_generation_idempotency_scoped'
    `).get() as { name: string } | undefined;
    expect(scopedIdempotency?.name).toBe('training_plan_generation_idempotency_scoped');

    const columns = testDb.prepare('PRAGMA table_info(training_operation_locks)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'lock_key',
      'owner_token',
      'operation',
      'user_id',
      'tenant_id',
      'plan_id',
      'acquired_at_ms',
      'expires_at_ms',
    ]);
    expect(columns.find((column) => column.name === 'tenant_id')).toBeTruthy();
  });
});

// F35 (Phase 1A-5) — the operation/resource conflict matrix and the typed
// contention error. These are pure and need no database, so they live outside
// the DB-backed describe above.
describe('training operation conflict matrix (F35)', () => {
  it('treats every currently-shipped operation pair as conflicting', async () => {
    const { TRAINING_OPERATION_RESOURCES, trainingOperationsConflict } =
      await import('../../src/services/training-operation-locks');
    const operations = Object.keys(TRAINING_OPERATION_RESOURCES) as Array<
      keyof typeof TRAINING_OPERATION_RESOURCES
    >;

    // The matrix is total today because every operation writes `plan`,
    // `calendar`, or both, and the two are coupled. This pins that claim: if
    // a future change makes a pair genuinely independent, this test fails and
    // forces the key-splitting decision to be explicit rather than inferred.
    for (const left of operations) {
      for (const right of operations) {
        expect(trainingOperationsConflict(left, right), `${left} vs ${right}`).toBe(true);
      }
    }
  });

  it('declares the resources each operation writes', async () => {
    const { TRAINING_OPERATION_RESOURCES } =
      await import('../../src/services/training-operation-locks');
    expect(TRAINING_OPERATION_RESOURCES.calendar_sync).toEqual(['calendar']);
    expect(TRAINING_OPERATION_RESOURCES.plan_activate).toEqual(['plan', 'calendar']);
  });

  it('carries a typed 409 with a wait-derived Retry-After and no lock key', async () => {
    const { TrainingOperationLockError, isTrainingOperationLockError } =
      await import('../../src/services/training-operation-locks');
    const error = new TrainingOperationLockError('calendar_generate', 30);

    expect(isTrainingOperationLockError(error)).toBe(true);
    expect(error.code).toBe('TRAINING_OPERATION_LOCKED');
    expect(error.status).toBe(409);
    // Derived from the caller's 30s wait budget, NOT the 20-minute
    // calendar_generate TTL — advertising the TTL would tell a client to wait
    // 20 minutes for a lock that is usually free in seconds.
    expect(error.retryAfterSeconds).toBe(30);
    // The lock key embeds user and tenant ids and must never reach a client.
    expect(error.message).not.toMatch(/user:|tenant:/);
  });
});
