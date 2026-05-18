import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [] },
    app: { timezone: 'Europe/Lisbon' },
    billing: { paywallEnabled: true },
    aiSafety: { globalDailyLimitUsd: 10.0, alertThresholdPercent: 0.8 },
  },
}));

vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: () => false,
}));

import {
  acquireCostLock,
  _resetUserCostLocksForTests,
} from '../../src/services/cost-guardrail';

describe('cost guardrail SQLite advisory lock', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    _resetUserCostLocksForTests();
    testDb?.close();
  });

  it('stores a DB-backed lock row while held and queues same-user acquisitions across processes', async () => {
    const releaseFirst = await acquireCostLock(42);
    const held = testDb.prepare('SELECT lock_key FROM cost_guardrail_locks WHERE lock_key = ?')
      .get('user:42') as { lock_key: string } | undefined;
    expect(held?.lock_key).toBe('user:42');

    let secondAcquired = false;
    const second = acquireCostLock(42).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    const afterRelease = testDb.prepare('SELECT COUNT(*) AS count FROM cost_guardrail_locks')
      .get() as { count: number };
    expect(afterRelease.count).toBe(0);
  });

  it('ships the advisory lock table in a migration, not only runtime bootstrap', () => {
    const migrationSql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '147_cost_guardrail_sqlite_locks.sql'),
      'utf8',
    );
    testDb.exec(migrationSql);

    const table = testDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cost_guardrail_locks'
    `).get() as { name: string } | undefined;
    expect(table?.name).toBe('cost_guardrail_locks');

    const columns = testDb.prepare('PRAGMA table_info(cost_guardrail_locks)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'lock_key',
      'owner_token',
      'acquired_at_ms',
      'expires_at_ms',
    ]);
  });

  it('fails closed instead of falling back to a process-local mutex when SQLite is unavailable', async () => {
    testDb.close();
    testDb = undefined as unknown as Database.Database;

    await expect(acquireCostLock(42)).rejects.toThrow(/COST_GUARDRAIL_LOCK_UNAVAILABLE/);
  });
});
