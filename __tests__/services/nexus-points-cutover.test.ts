// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
let pointsCutoverActive = false;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return {
    ...actual,
    getDb: () => db,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
  };
});

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      get hybridCredits() {
        return { enabled: false, pointsCutover: pointsCutoverActive };
      },
    },
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  NEXUS_POINTS_NONEXPIRING_AT,
  getNexusPointBalance,
  grantNexusPoints,
  runNexusPointsCutover,
} from '../../src/services/nexus-points';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const PAST = '2026-07-01T00:00:00.000Z';

function seedCredit(overrides: Partial<Record<string, unknown>> = {}): number {
  const values = {
    user_id: 40,
    source: 'purchase',
    provider: 'stripe',
    product_id: 'me.nexushub.points.small',
    provider_transaction_id: `txn-${Math.abs(Math.min(seedCredit.counter += 1, 1e9))}`,
    points_granted: 300,
    points_remaining: 300,
    usd_allowance_granted: 0.3,
    usd_allowance_remaining: 0.3,
    purchased_at: PAST,
    expires_at: '2026-09-15T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
  const result = db.prepare(`
    INSERT INTO nexus_point_credits (
      user_id, source, provider, product_id, provider_transaction_id,
      points_granted, points_remaining, usd_allowance_granted,
      usd_allowance_remaining, purchased_at, expires_at, status
    ) VALUES (@user_id, @source, @provider, @product_id, @provider_transaction_id,
              @points_granted, @points_remaining, @usd_allowance_granted,
              @usd_allowance_remaining, @purchased_at, @expires_at, @status)
  `).run(values);
  return Number(result.lastInsertRowid);
}
seedCredit.counter = 0;

function expiryOf(id: number): { expires_at: string; status: string } {
  return db.prepare('SELECT expires_at, status FROM nexus_point_credits WHERE id = ?').get(id) as {
    expires_at: string;
    status: string;
  };
}

describe('nexus points cutover (NH-0029)', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    pointsCutoverActive = false;
    seedCredit.counter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('keeps the 30-day expiry before the cutover and mints nonexpiring lots after', () => {
    const before = grantNexusPoints({
      userId: 40,
      productId: 'me.nexushub.points.small',
      provider: 'stripe',
      providerTransactionId: 'pre-cutover',
      purchasedAt: NOW,
    });
    expect(expiryOf(before.creditId as number).expires_at).toBe('2026-09-17T12:00:00.000Z');

    pointsCutoverActive = true;
    const after = grantNexusPoints({
      userId: 40,
      productId: 'me.nexushub.points.small',
      provider: 'stripe',
      providerTransactionId: 'post-cutover',
      purchasedAt: NOW,
    });
    expect(expiryOf(after.creditId as number).expires_at).toBe(NEXUS_POINTS_NONEXPIRING_AT);
  });

  it('refuses to run while the cutover flag is off', () => {
    seedCredit();
    expect(() => runNexusPointsCutover(NOW)).toThrow(/NEXUS_POINTS_CUTOVER_INACTIVE/);
  });

  it('migrates unexpired purchased lots and restores only unspent expired Apple lots', () => {
    pointsCutoverActive = true;
    const activeUnexpired = seedCredit();
    const expiredAppleUnspent = seedCredit({ provider: 'apple', expires_at: PAST, status: 'expired' });
    const expiredAppleSpent = seedCredit({ provider: 'apple', expires_at: PAST, status: 'expired', points_remaining: 0, usd_allowance_remaining: 0 });
    const expiredStripeUnspent = seedCredit({ provider: 'stripe', expires_at: PAST, status: 'expired' });
    const revokedApple = seedCredit({ provider: 'apple', expires_at: PAST, status: 'revoked' });
    const adminGrant = seedCredit({ source: 'admin', expires_at: '2026-09-15T00:00:00.000Z' });

    const result = runNexusPointsCutover(NOW);
    expect(result).toEqual({ unexpiredMigrated: 1, appleRestored: 1 });

    expect(expiryOf(activeUnexpired)).toEqual({ expires_at: NEXUS_POINTS_NONEXPIRING_AT, status: 'active' });
    expect(expiryOf(expiredAppleUnspent)).toEqual({ expires_at: NEXUS_POINTS_NONEXPIRING_AT, status: 'active' });
    expect(expiryOf(expiredAppleSpent).expires_at).toBe(PAST);
    expect(expiryOf(expiredStripeUnspent).expires_at).toBe(PAST);
    expect(expiryOf(revokedApple)).toEqual({ expires_at: PAST, status: 'revoked' });
    expect(expiryOf(adminGrant).expires_at).toBe('2026-09-15T00:00:00.000Z');

    // Idempotent: a second run matches nothing.
    expect(runNexusPointsCutover(NOW)).toEqual({ unexpiredMigrated: 0, appleRestored: 0 });
  });

  it('bounds the Apple restore window: lots expired before the window stay expired (NH-0041)', () => {
    pointsCutoverActive = true;
    const withinWindow = seedCredit({ provider: 'apple', expires_at: PAST, status: 'expired' });
    // Expired far beyond the restore window (default 1095 days).
    const ancient = seedCredit({ provider: 'apple', expires_at: '2020-01-01T00:00:00.000Z', status: 'expired' });

    const result = runNexusPointsCutover(NOW);
    expect(result.appleRestored).toBe(1);
    expect(expiryOf(withinWindow).status).toBe('active');
    expect(expiryOf(ancient)).toMatchObject({ expires_at: '2020-01-01T00:00:00.000Z', status: 'expired' });
  });

  it('honors a configured restore window override and rejects invalid values', () => {
    pointsCutoverActive = true;
    const recentPast = seedCredit({ provider: 'apple', expires_at: PAST, status: 'expired' });
    process.env.NEXUS_POINTS_APPLE_RESTORE_WINDOW_DAYS = '7';
    try {
      // PAST is ~49 days before NOW: outside a 7-day window.
      expect(runNexusPointsCutover(NOW).appleRestored).toBe(0);
      expect(expiryOf(recentPast).status).toBe('expired');

      process.env.NEXUS_POINTS_APPLE_RESTORE_WINDOW_DAYS = 'not-a-number';
      expect(runNexusPointsCutover(NOW).appleRestored).toBe(1);
      expect(expiryOf(recentPast).status).toBe('active');
    } finally {
      delete process.env.NEXUS_POINTS_APPLE_RESTORE_WINDOW_DAYS;
    }
  });

  it('keeps nonexpiring lots visible in the balance without a phantom expiry date', () => {
    seedCredit({ expires_at: NEXUS_POINTS_NONEXPIRING_AT });
    const balance = getNexusPointBalance(40, NOW);
    expect(balance.pointsBalance).toBe(300);
    expect(balance.nextCreditExpiryAt).toBeNull();
    expect(balance.pointsExpiringSoon).toBe(0);
  });
});
