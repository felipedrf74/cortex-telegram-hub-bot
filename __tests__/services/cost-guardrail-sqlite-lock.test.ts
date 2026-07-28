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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
  acquireAiBudgetReservation,
  _resetUserCostLocksForTests,
} from '../../src/services/cost-guardrail';
import { resolveApiUsageAttribution } from '../../src/services/api-usage-attribution';
import { runWithContext } from '../../src/utils/request-context';

function acquire(userId: number) {
  return acquireAiBudgetReservation({
    userId,
    requestSource: 'interactive',
    baseCategory: 'chat_secretary',
  });
}

describe('cost guardrail SQLite advisory lock', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE subscriptions (
        user_id INTEGER UNIQUE, plan TEXT, status TEXT, provider TEXT,
        current_period_start TEXT, current_period_end TEXT
      );
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        category TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'test',
        user_id INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        request_source TEXT NOT NULL DEFAULT 'interactive',
        base_category TEXT,
        run_id TEXT
      );
      CREATE TABLE user_ai_budget_overrides (
        user_id INTEGER UNIQUE, daily_cost_usd REAL NOT NULL,
        monthly_cost_usd REAL, reason TEXT, expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE nexus_point_credits (
        user_id INTEGER, points_remaining REAL, usd_allowance_remaining REAL,
        expires_at TEXT, status TEXT
      );
      CREATE TABLE nexus_point_debits (
        user_id INTEGER, api_usage_id INTEGER, usd_cost_debited REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE ai_budget_deferrals (
        user_id INTEGER, request_source TEXT, job_name TEXT,
        base_category TEXT, run_id TEXT, code TEXT, budget_window TEXT,
        reset_at TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    _resetUserCostLocksForTests();
    testDb?.close();
  });

  it('stores a DB-backed lock row while held and queues same-user acquisitions across processes', async () => {
    const releaseFirst = await acquire(42);
    const held = testDb.prepare('SELECT lock_key FROM cost_guardrail_locks WHERE lock_key = ?')
      .get('user:42') as { lock_key: string } | undefined;
    expect(held?.lock_key).toBe('user:42');

    let secondAcquired = false;
    const second = acquire(42).then((release) => {
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

  it('keeps lazy reservation attribution visible after await until explicit release', async () => {
    await runWithContext({
      requestId: 'req-live-eval-attribution',
      source: 'http',
      userId: 42,
      tenantId: 42,
    }, async () => {
      const previousAttribution = resolveApiUsageAttribution('chat_secretary', 42);
      const release = await acquireAiBudgetReservation({
        userId: 42,
        requestSource: 'interactive',
        baseCategory: 'chat_live_eval_local',
        jobName: 'chat_live_eval:morning_planning',
        runId: 'chat-eval-attribution-test',
        estimatedCostUsd: 0,
        exactHardCostEstimate: true,
        hardRunCostLimitUsd: 0.000001,
      });
      try {
        expect(resolveApiUsageAttribution('chat_secretary', 42)).toEqual({
          requestSource: 'interactive',
          jobName: 'chat_live_eval:morning_planning',
          baseCategory: 'chat_live_eval_local',
          runId: 'chat-eval-attribution-test',
        });
      } finally {
        release();
      }

      expect(resolveApiUsageAttribution('chat_secretary', 42)).toEqual(previousAttribution);
    });
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

    await expect(acquire(42)).rejects.toMatchObject({
      name: 'AiBudgetError',
      decision: { code: 'SERVICE_DEGRADED', internalReason: 'lock_unavailable' },
    });
  });
});
