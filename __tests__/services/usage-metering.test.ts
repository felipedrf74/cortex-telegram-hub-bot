/**
 * Usage metering service contracts.
 *
 * This is the primary suite for the usage_metering and usage_quotas schema.
 * Cross-module provider attribution belongs to each provider's behavior suite;
 * this file verifies the durable database and service behavior once.
 */

import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';

import type { PortalSnapshotResponse } from '../../src/portal/snapshot-builder';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let db: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => db,
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

import {
  checkQuota,
  getDailyUsage,
  getGlobalDailyUsage,
  getQuota,
  getUsageRange,
  recordUsage,
  setQuota,
} from '../../src/services/usage-metering';

beforeAll(() => {
  db = createMigratedTestDatabase();
});

beforeEach(() => {
  db.exec('SAVEPOINT usage_metering_case');
});

afterEach(() => {
  db.exec('ROLLBACK TO usage_metering_case');
  db.exec('RELEASE usage_metering_case');
});

afterAll(() => {
  db.close();
});

describe('Usage metering schema', () => {
  it('exposes the required aggregate columns, types, defaults, and lookup indexes', () => {
    const meteringColumns = db.prepare("PRAGMA table_info('usage_metering')").all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
    }>;
    const quotaColumns = db.prepare("PRAGMA table_info('usage_quotas')").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_metering'",
    ).all() as Array<{ name: string }>;

    expect(meteringColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'id',
      'user_id',
      'date',
      'message_count',
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'api_calls',
      'cost_usd',
      'created_at',
      'updated_at',
    ]));
    expect(meteringColumns.find(({ name }) => name === 'cost_usd')?.type).toBe('REAL');
    for (const name of ['message_count', 'input_tokens', 'output_tokens', 'total_tokens', 'api_calls', 'cost_usd']) {
      expect(meteringColumns.find((column) => column.name === name)?.dflt_value).toBe('0');
    }
    expect(quotaColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'user_id',
      'daily_message_limit',
      'daily_token_limit',
      'daily_cost_limit_usd',
    ]));
    for (const name of ['daily_message_limit', 'daily_token_limit', 'daily_cost_limit_usd']) {
      expect(quotaColumns.find((column) => column.name === name)?.dflt_value).toBeNull();
    }
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_usage_metering_date',
      'idx_usage_metering_user_date',
    ]));
  });

  it('enforces one daily aggregate and one quota row per user while allowing different dates', () => {
    const insertUsage = db.prepare(
      'INSERT INTO usage_metering (user_id, date) VALUES (?, ?)',
    );
    insertUsage.run(123, '2026-04-01');
    expect(() => insertUsage.run(123, '2026-04-01')).toThrow();
    insertUsage.run(123, '2026-04-02');
    expect(db.prepare('SELECT id FROM usage_metering WHERE user_id = 123').all()).toHaveLength(2);

    const insertQuota = db.prepare(
      'INSERT INTO usage_quotas (user_id, daily_message_limit) VALUES (?, ?)',
    );
    insertQuota.run(123, 100);
    expect(() => insertQuota.run(123, 200)).toThrow();
  });
});

describe('Usage metering service', () => {
  it('atomically accumulates calls, messages, tokens, and cost', () => {
    recordUsage(101, 500, 200, 0.005, true);
    recordUsage(101, 300, 100, 0.003, false);

    expect(getDailyUsage(101)).toMatchObject({
      userId: 101,
      messageCount: 1,
      inputTokens: 800,
      outputTokens: 300,
      totalTokens: 1100,
      apiCalls: 2,
      costUsd: 0.008,
    });
  });

  it('accepts zero and large token counts without losing precision', () => {
    recordUsage(102, 0, 0, 0, true);
    recordUsage(103, 100_000, 50_000, 1.5, true);

    expect(getDailyUsage(102)).toMatchObject({ messageCount: 1, totalTokens: 0, apiCalls: 1 });
    expect(getDailyUsage(103)).toMatchObject({
      inputTokens: 100_000,
      outputTokens: 50_000,
      totalTokens: 150_000,
      costUsd: 1.5,
    });
  });

  it('isolates user and system-owned aggregates', () => {
    recordUsage(0, 1_000, 500, 0.01, false);
    recordUsage(104, 100, 50, 0.001, true);
    recordUsage(105, 200, 100, 0.002, true);

    expect(getDailyUsage(0)).toMatchObject({ userId: 0, messageCount: 0, apiCalls: 1 });
    expect(getDailyUsage(104)).toMatchObject({ inputTokens: 100, apiCalls: 1 });
    expect(getDailyUsage(105)).toMatchObject({ inputTokens: 200, apiCalls: 1 });
  });

  it('returns a complete zero record for a user with no usage', () => {
    expect(getDailyUsage(999_999, '2026-01-01')).toEqual({
      userId: 999_999,
      date: '2026-01-01',
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      apiCalls: 0,
      costUsd: 0,
    });
  });

  it('returns only the requested user and inclusive date range in date order', () => {
    const insert = db.prepare(
      'INSERT INTO usage_metering (user_id, date, api_calls) VALUES (?, ?, ?)',
    );
    insert.run(106, '2026-03-01', 1);
    insert.run(106, '2026-03-15', 5);
    insert.run(106, '2026-03-31', 1);
    insert.run(107, '2026-03-15', 9);

    const range = getUsageRange(106, '2026-03-10', '2026-03-20');
    expect(range).toEqual([
      expect.objectContaining({ userId: 106, date: '2026-03-15', apiCalls: 5 }),
    ]);
    expect(getUsageRange(106, '2026-01-01', '2026-01-31')).toEqual([]);
  });

  it('aggregates the requested day across users and returns zeros for an empty day', () => {
    const insert = db.prepare(`
      INSERT INTO usage_metering
        (user_id, date, message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(108, '2026-03-15', 1, 100, 50, 150, 1, 0.001);
    insert.run(109, '2026-03-15', 2, 200, 100, 300, 2, 0.002);

    expect(getGlobalDailyUsage('2026-03-15')).toEqual({
      date: '2026-03-15',
      messageCount: 3,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      apiCalls: 3,
      costUsd: 0.003,
    });
    expect(getGlobalDailyUsage('2026-01-01')).toMatchObject({
      messageCount: 0,
      totalTokens: 0,
      apiCalls: 0,
      costUsd: 0,
    });
  });
});

describe('Usage quota behavior', () => {
  it('creates and updates quota limits without changing omitted limits', () => {
    expect(getQuota(201)).toBeNull();

    setQuota(201, {
      dailyMessageLimit: 100,
      dailyTokenLimit: 500_000,
      dailyCostLimitUsd: 5,
    });
    setQuota(201, { dailyMessageLimit: 200 });

    expect(getQuota(201)).toEqual({
      userId: 201,
      dailyMessageLimit: 200,
      dailyTokenLimit: 500_000,
      dailyCostLimitUsd: 5,
    });
  });

  it('treats missing and all-null quota limits as unlimited', () => {
    recordUsage(202, 100, 50, 0.001, true);
    expect(checkQuota(202)).toMatchObject({ allowed: true, quota: null, exceeded: [] });

    setQuota(203, {});
    recordUsage(203, 999_999, 999_999, 999, true);
    expect(checkQuota(203)).toMatchObject({ allowed: true, exceeded: [] });
  });

  it.each([
    {
      name: 'message',
      userId: 204,
      limits: { dailyMessageLimit: 2 },
      calls: [[100, 50, 0.001, true], [100, 50, 0.001, true]] as const,
      exceeded: ['messages'],
    },
    {
      name: 'token',
      userId: 205,
      limits: { dailyTokenLimit: 500 },
      calls: [[300, 250, 0.005, true]] as const,
      exceeded: ['tokens'],
    },
    {
      name: 'cost',
      userId: 206,
      limits: { dailyCostLimitUsd: 0.01 },
      calls: [[500, 200, 0.008, true], [500, 200, 0.005, false]] as const,
      exceeded: ['cost'],
    },
    {
      name: 'multiple',
      userId: 207,
      limits: { dailyMessageLimit: 1, dailyCostLimitUsd: 0.001 },
      calls: [[500, 200, 0.005, true]] as const,
      exceeded: ['messages', 'cost'],
    },
  ])('denies usage exactly at the $name limit', ({ userId, limits, calls, exceeded }) => {
    setQuota(userId, limits);
    for (const [inputTokens, outputTokens, costUsd, isUserMessage] of calls) {
      recordUsage(userId, inputTokens, outputTokens, costUsd, isUserMessage);
    }

    const status = checkQuota(userId);
    expect(status.allowed).toBe(false);
    expect(status.exceeded).toEqual(exceeded);
    expect(status.usage.userId).toBe(userId);
  });

  it('keeps quotas isolated and allows usage one below a configured limit', () => {
    setQuota(208, { dailyMessageLimit: 2 });
    setQuota(209, { dailyMessageLimit: 10 });
    recordUsage(208, 100, 50, 0.001, true);
    recordUsage(209, 100, 50, 0.001, true);

    expect(checkQuota(208)).toMatchObject({ allowed: true, exceeded: [] });
    expect(checkQuota(209)).toMatchObject({ allowed: true, exceeded: [] });
  });
});

describe('Portal usage contract', () => {
  it('keeps usage metering in the typed portal snapshot response', () => {
    expectTypeOf<PortalSnapshotResponse['usageMetering']>().toMatchTypeOf<{
      today: {
        messageCount: number;
        totalTokens: number;
        apiCalls: number;
        costUsd: number;
      };
      byUser: Array<{
        userId: number;
        displayName: string;
        messageCount: number;
        totalTokens: number;
        apiCalls: number;
        costUsd: number;
      }>;
    }>();
  });
});
