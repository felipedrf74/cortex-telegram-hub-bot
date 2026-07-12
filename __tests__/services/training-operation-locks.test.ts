import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
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
