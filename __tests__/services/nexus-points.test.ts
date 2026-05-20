import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/config', () => ({
  config: {
    billing: { paywallEnabled: true },
  },
}));

vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: vi.fn(() => false),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  debitNexusPoints,
  getNexusPointBalance,
  grantNexusPoints,
  NEXUS_POINT_PACKAGES,
  revokeNexusPointsCredit,
  settleNexusPointOverageForUser,
} from '../../src/services/nexus-points';

function createSchema(): void {
  testDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER,
      tier TEXT
    );
    CREATE TABLE subscriptions (
      user_id INTEGER UNIQUE,
      plan TEXT,
      status TEXT
    );
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      category TEXT NOT NULL,
      model TEXT NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_ai_budget_overrides (
      user_id INTEGER PRIMARY KEY,
      daily_cost_usd REAL NOT NULL,
      reason TEXT,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE nexus_point_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'purchase',
      provider TEXT NOT NULL,
      product_id TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL,
      points_granted REAL NOT NULL,
      points_remaining REAL NOT NULL,
      usd_allowance_granted REAL NOT NULL,
      usd_allowance_remaining REAL NOT NULL,
      purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_transaction_id)
    );
    CREATE TABLE nexus_point_debits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      points_debited REAL NOT NULL,
      usd_cost_debited REAL NOT NULL,
      api_usage_id INTEGER,
      category TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_nexus_point_debits_api_usage_id_unique
      ON nexus_point_debits(api_usage_id);
  `);
}

function createProUser(userId: number): void {
  testDb.prepare('INSERT INTO users (id, telegram_id, tier) VALUES (?, ?, ?)').run(userId, userId, 'pro');
  testDb.prepare('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, ?)').run(userId, 'pro', 'active');
}

function insertUsage(userId: number, costUsd: number, ts = '2026-05-20T12:00:00.000Z'): number {
  const result = testDb.prepare(`
    INSERT INTO api_usage (ts, category, model, user_id, input_tokens, output_tokens, cost_usd, duration_ms)
    VALUES (?, 'domain_content', 'gpt-5.4-nano', ?, 1000, 500, ?, 100)
  `).run(ts, userId, costUsd);
  return Number(result.lastInsertRowid);
}

describe('Nexus Points ledger', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    testDb.close();
  });

  it('grants the $5/$10/$20 packages with the configured Nexus Point economics', () => {
    expect(NEXUS_POINT_PACKAGES['me.nexushub.points.small']).toMatchObject({ priceUsd: 5, points: 300, usdAllowance: 0.30, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 });
    expect(NEXUS_POINT_PACKAGES['me.nexushub.points.medium']).toMatchObject({ priceUsd: 10, points: 600, usdAllowance: 0.60 });
    expect(NEXUS_POINT_PACKAGES['me.nexushub.points.large']).toMatchObject({ priceUsd: 20, points: 1200, usdAllowance: 1.20 });
  });

  it('grants credits for 30 days and ignores duplicate provider transactions', () => {
    const purchasedAt = new Date('2026-05-20T12:00:00.000Z');
    const first = grantNexusPoints({
      userId: 10,
      provider: 'apple',
      providerTransactionId: '2000000123456789',
      productId: 'me.nexushub.points.small',
      purchasedAt,
    });
    const duplicate = grantNexusPoints({
      userId: 10,
      provider: 'apple',
      providerTransactionId: '2000000123456789',
      productId: 'me.nexushub.points.small',
      purchasedAt,
    });

    expect(first.granted).toBe(true);
    expect(duplicate.granted).toBe(false);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM nexus_point_credits').get()).toEqual({ count: 1 });
    const row = testDb.prepare('SELECT points_granted, usd_allowance_granted, expires_at FROM nexus_point_credits').get() as any;
    expect(row.points_granted).toBe(300);
    expect(row.usd_allowance_granted).toBe(0.30);
    expect(row.expires_at).toBe('2026-06-19T12:00:00.000Z');
  });

  it('persists purchase metadata for provider-specific reconciliation', () => {
    grantNexusPoints({
      userId: 10,
      provider: 'stripe',
      providerTransactionId: 'pi_points_metadata',
      productId: 'me.nexushub.points.small',
      metadata: {
        sessionId: 'cs_points_metadata',
        paymentIntentId: 'pi_points_metadata',
        chargeId: 'ch_points_metadata',
        source: 'web',
      },
    });

    const row = testDb.prepare('SELECT metadata_json FROM nexus_point_credits WHERE provider_transaction_id = ?').get('pi_points_metadata') as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      sessionId: 'cs_points_metadata',
      paymentIntentId: 'pi_points_metadata',
      chargeId: 'ch_points_metadata',
      source: 'web',
    });
  });

  it('debits credits FIFO by earliest expiry', () => {
    grantNexusPoints({
      userId: 11,
      provider: 'apple',
      providerTransactionId: 'tx-late',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-05-20T12:00:00.000Z'),
    });
    grantNexusPoints({
      userId: 11,
      provider: 'apple',
      providerTransactionId: 'tx-early',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-05-19T12:00:00.000Z'),
    });

    const result = debitNexusPoints(11, 0.35, { category: 'daily_ai_overage' });

    expect(result).toEqual({ usdDebited: 0.35, pointsDebited: 350 });
    const rows = testDb.prepare(`
      SELECT provider_transaction_id, usd_allowance_remaining
      FROM nexus_point_credits
      ORDER BY expires_at ASC
    `).all() as Array<{ provider_transaction_id: string; usd_allowance_remaining: number }>;
    expect(rows[0]).toMatchObject({ provider_transaction_id: 'tx-early', usd_allowance_remaining: 0 });
    expect(rows[1].usd_allowance_remaining).toBeCloseTo(0.25, 8);
  });

  it('ignores expired credits in active balance', () => {
    grantNexusPoints({
      userId: 12,
      provider: 'apple',
      providerTransactionId: 'expired',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    const balance = getNexusPointBalance(12, new Date('2026-05-20T00:00:00.000Z'));

    expect(balance.pointsBalance).toBe(0);
    expect(balance.usdBalance).toBe(0);
    expect(testDb.prepare('SELECT status FROM nexus_point_credits WHERE provider_transaction_id = ?').get('expired')).toEqual({ status: 'expired' });
  });

  it('revokes/refunds remaining Nexus Points by provider transaction id', () => {
    grantNexusPoints({
      userId: 16,
      provider: 'apple',
      providerTransactionId: '2000000123456799',
      productId: 'me.nexushub.points.medium',
      purchasedAt: new Date('2026-05-20T12:00:00.000Z'),
    });

    const result = revokeNexusPointsCredit({
      provider: 'apple',
      providerTransactionId: '2000000123456799',
      status: 'refunded',
    });

    expect(result).toMatchObject({ revoked: true, previousStatus: 'active' });
    const row = testDb.prepare(`
      SELECT status, points_remaining, usd_allowance_remaining
      FROM nexus_point_credits
      WHERE provider_transaction_id = '2000000123456799'
    `).get() as { status: string; points_remaining: number; usd_allowance_remaining: number };
    expect(row.status).toBe('refunded');
    expect(row.points_remaining).toBe(0);
    expect(row.usd_allowance_remaining).toBe(0);
  });

  it('settles only the cap-crossing overage into Nexus Points', async () => {
    createProUser(13);
    grantNexusPoints({
      userId: 13,
      provider: 'apple',
      providerTransactionId: 'tx-overage',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-05-20T12:00:00.000Z'),
    });
    const apiUsageId = insertUsage(13, 0.045);

    await settleNexusPointOverageForUser(13, apiUsageId);

    const debit = testDb.prepare(`
      SELECT points_debited, usd_cost_debited, api_usage_id
      FROM nexus_point_debits
    `).get() as { points_debited: number; usd_cost_debited: number; api_usage_id: number };
    expect(debit.api_usage_id).toBe(apiUsageId);
    expect(debit.usd_cost_debited).toBeCloseTo(0.005, 8);
    expect(debit.points_debited).toBeCloseTo(5, 8);
    const balance = getNexusPointBalance(13, new Date('2026-05-20T12:01:00.000Z'));
    expect(balance.usdBalance).toBeCloseTo(0.295, 8);
  });

  it('settlement is idempotent for concurrent calls on the same api_usage row', async () => {
    createProUser(14);
    grantNexusPoints({
      userId: 14,
      provider: 'apple',
      providerTransactionId: 'tx-concurrent',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-05-20T12:00:00.000Z'),
    });
    const apiUsageId = insertUsage(14, 0.05);

    await Promise.all([
      settleNexusPointOverageForUser(14, apiUsageId),
      settleNexusPointOverageForUser(14, apiUsageId),
    ]);

    const rows = testDb.prepare('SELECT usd_cost_debited FROM nexus_point_debits WHERE api_usage_id = ?').all(apiUsageId) as Array<{ usd_cost_debited: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].usd_cost_debited).toBeCloseTo(0.01, 8);
  });

  it('settles overage against the api_usage row day across UTC midnight rollover', async () => {
    createProUser(15);
    grantNexusPoints({
      userId: 15,
      provider: 'apple',
      providerTransactionId: 'tx-midnight',
      productId: 'me.nexushub.points.small',
      purchasedAt: new Date('2026-05-20T12:00:00.000Z'),
    });
    const apiUsageId = insertUsage(15, 0.045, '2026-05-20T23:59:58.000Z');

    await settleNexusPointOverageForUser(15, apiUsageId);

    const row = testDb.prepare('SELECT usd_cost_debited FROM nexus_point_debits WHERE api_usage_id = ?').get(apiUsageId) as { usd_cost_debited: number };
    expect(row.usd_cost_debited).toBeCloseTo(0.005, 8);
  });
});
