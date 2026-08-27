// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Apple subscription lifecycle — renewal-state and identity invariants.
 *
 * These cover the three ways the Apple upsert can corrupt a paying account's
 * billing row: latching `cancel_at_period_end` on forever, clobbering a Stripe
 * customer id with the appAccountToken, and deriving an appAccountToken from a
 * source-literal key that anyone reading the repo could forge.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

const hoisted = vi.hoisted(() => ({
  iosJwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long' as string,
  appleAppAccountTokenHmacSecret: 'test-apple-account-token-secret-at-least-32-bytes' as string,
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
      priceProYearly: '',
      priceMaxYearly: '',
      priceProMonthlyBrl: 'price_pro_brl',
      priceProYearlyBrl: '',
      priceMaxMonthlyBrl: 'price_max_brl',
      priceMaxYearlyBrl: '',
    },
    ios: {
      // A getter so a single test can run with the secret unset without
      // needing a second module registry.
      get jwtSecret() { return hoisted.iosJwtSecret; },
      get appAccountTokenHmacSecret() { return hoisted.appleAppAccountTokenHmacSecret; },
    },
  },
}));

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database');
  return {
    ...actual,
    getDb: () => testDb,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
    assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
    withDatabaseForTestAsync: vi.fn(),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/email-sender', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/email-sender')>('../../src/services/email-sender');
  return {
    ...actual,
    sendPaymentReceipt: vi.fn(async () => true),
    sendPaymentFailed: vi.fn(async () => true),
    sendCancellationConfirmation: vi.fn(async () => true),
  };
});

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      first_name TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'free'
    );

    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      period TEXT NOT NULL DEFAULT 'monthly',
      status TEXT NOT NULL DEFAULT 'inactive',
      provider TEXT NOT NULL DEFAULT 'none',
      provider_subscription_id TEXT,
      provider_customer_id TEXT,
      current_period_start TEXT,
      current_period_end TEXT,
      environment TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE apple_webhook_events (
      notification_uuid TEXT PRIMARY KEY,
      notification_type TEXT NOT NULL,
      subtype TEXT,
      environment TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Inner `signedTransactionInfo` payload; only the payload segment is read. */
function appleTransactionJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ bundleId: 'me.nexushub.app', ...payload })).toString('base64url');
  const sig = Buffer.from('stub-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function createUser(email: string): number {
  return Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run(email).lastInsertRowid);
}

function subscriptionRow(userId: number): any {
  return testDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
}

function appleGrantContext(userId: number, environment = 'Production') {
  const body = Buffer.alloc(5);
  body.writeUInt8(0x01, 0);
  body.writeUInt32BE(userId, 1);
  const tag = crypto.createHmac('sha256', hoisted.appleAppAccountTokenHmacSecret)
    .update(body).digest().subarray(0, 11);
  const hex = Buffer.concat([body, tag]).toString('hex');
  return {
    tenantId: userId,
    environment,
    appAccountToken: [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
    ].join('-'),
  };
}

const DAY_MS = 86400000;

describe('Apple subscription renewal state', () => {
  beforeEach(() => {
    hoisted.iosJwtSecret = 'test-ios-jwt-secret-at-least-32-bytes-long';
    hoisted.appleAppAccountTokenHmacSecret = 'test-apple-account-token-secret-at-least-32-bytes';
    testDb = new Database(':memory:');
    createSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('clears a latched cancellation only when the granted period is genuinely new', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = createUser('apple-relatch@example.com');
    const firstPeriodEnd = new Date(Date.now() + 30 * DAY_MS).toISOString();

    handleAppleTransaction(userId, '2000000200000001', 'me.nexushub.pro.monthly', firstPeriodEnd, null, appleGrantContext(userId));
    // The user turns auto-renew off: DID_CHANGE_RENEWAL_STATUS is the only
    // authority for setting this, and a plain restore must not undo it.
    testDb.prepare('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE user_id = ?').run(userId);

    handleAppleTransaction(userId, '2000000200000001', 'me.nexushub.pro.monthly', firstPeriodEnd, null, appleGrantContext(userId));
    expect(subscriptionRow(userId).cancel_at_period_end).toBe(1);

    // A strictly newer period end can only exist because the subscription
    // actually renewed or was resubscribed, so the flag is stale.
    const secondPeriodEnd = new Date(Date.now() + 60 * DAY_MS).toISOString();
    handleAppleTransaction(userId, '2000000200000001', 'me.nexushub.pro.monthly', secondPeriodEnd, null, appleGrantContext(userId));
    expect(subscriptionRow(userId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: 0,
      current_period_end: secondPeriodEnd,
    });
  });

  it('clears a latched cancellation on a resubscribe notification but not on a same-period change', async () => {
    const { handleAppleNotification, handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = createUser('apple-resubscribe@example.com');
    const firstPeriodEnd = new Date(Date.now() + 5 * DAY_MS).toISOString();
    handleAppleTransaction(userId, '2000000200000002', 'me.nexushub.pro.monthly', firstPeriodEnd, null, appleGrantContext(userId));

    // Auto-renew off, then the period lapses.
    testDb.prepare(
      "UPDATE subscriptions SET cancel_at_period_end = 1, status = 'expired' WHERE user_id = ?",
    ).run(userId);

    // Apple sends SUBSCRIBED/RESUBSCRIBE without pairing it to an
    // AUTO_RENEW_ENABLED notification.
    const resubscribedUntil = Date.now() + 35 * DAY_MS;
    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000200000002',
      productId: 'me.nexushub.pro.monthly',
      expiresDate: resubscribedUntil,
      ...appleGrantContext(userId),
    }), { notificationUUID: 'eeee0001-0000-0000-0000-000000000000', subtype: 'RESUBSCRIBE' })).toBe(true);

    expect(subscriptionRow(userId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: 0,
      current_period_end: new Date(resubscribedUntil).toISOString(),
    });

    // A plan-preference change inside the SAME period is not a renewal, so a
    // pending cancellation must survive it.
    testDb.prepare('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE user_id = ?').run(userId);
    expect(handleAppleNotification('DID_CHANGE_RENEWAL_PREF', appleTransactionJws({
      originalTransactionId: '2000000200000002',
      productId: 'me.nexushub.pro.monthly',
      expiresDate: resubscribedUntil,
      ...appleGrantContext(userId),
    }), { notificationUUID: 'eeee0002-0000-0000-0000-000000000000' })).toBe(true);
    expect(subscriptionRow(userId).cancel_at_period_end).toBe(1);
  });

  it('refuses an active notification whose signed account token belongs to another user', async () => {
    const { handleAppleNotification, handleAppleTransaction } = await import('../../src/services/stripe-service');
    const owner = createUser('apple-notification-owner@example.com');
    const otherUser = createUser('apple-notification-other@example.com');
    const firstPeriodEnd = new Date(Date.now() + 5 * DAY_MS).toISOString();
    handleAppleTransaction(
      owner,
      '2000000200000099',
      'me.nexushub.pro.monthly',
      firstPeriodEnd,
      null,
      appleGrantContext(owner),
    );
    testDb.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ?").run(owner);

    expect(handleAppleNotification('DID_RENEW', appleTransactionJws({
      originalTransactionId: '2000000200000099',
      productId: 'me.nexushub.pro.monthly',
      expiresDate: Date.now() + 35 * DAY_MS,
      ...appleGrantContext(otherUser),
    }), { notificationUUID: 'eeee0099-0000-0000-0000-000000000000' })).toBe(false);
    expect(subscriptionRow(owner)).toMatchObject({
      status: 'expired',
      current_period_end: firstPeriodEnd,
    });
    expect(subscriptionRow(otherUser)).toBeUndefined();
  });

  it('does not leave a released terminal donor flagged as cancelling after they repurchase', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const donor = createUser('apple-donor@example.com');
    const claimant = createUser('apple-claimant@example.com');
    const periodEnd = new Date(Date.now() + 30 * DAY_MS).toISOString();

    handleAppleTransaction(donor, '2000000200000003', 'me.nexushub.pro.monthly', periodEnd, null, appleGrantContext(donor));
    testDb.prepare(
      "UPDATE subscriptions SET status = 'expired', current_period_end = ? WHERE user_id = ?",
    ).run(new Date(Date.now() - DAY_MS).toISOString(), donor);
    handleAppleTransaction(claimant, '2000000200000003', 'me.nexushub.pro.monthly', periodEnd, null, appleGrantContext(claimant));
    // The release marks the donor row inactive + cancelling.
    expect(subscriptionRow(donor)).toMatchObject({ status: 'inactive', cancel_at_period_end: 1 });

    // The donor then buys their own subscription. They are a fresh paying
    // subscriber; the UI must not tell them their plan is ending.
    const ownPeriodEnd = new Date(Date.now() + 40 * DAY_MS).toISOString();
    handleAppleTransaction(donor, '2000000200000004', 'me.nexushub.max.monthly', ownPeriodEnd, null, appleGrantContext(donor));
    expect(subscriptionRow(donor)).toMatchObject({
      plan: 'max',
      status: 'active',
      cancel_at_period_end: 0,
      provider_subscription_id: '2000000200000004',
    });
  });
});

describe('Apple subscription provider identity', () => {
  beforeEach(() => {
    hoisted.iosJwtSecret = 'test-ios-jwt-secret-at-least-32-bytes-long';
    hoisted.appleAppAccountTokenHmacSecret = 'test-apple-account-token-secret-at-least-32-bytes';
    testDb = new Database(':memory:');
    createSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('never overwrites a stored Stripe customer id with the Apple appAccountToken', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = createUser('stripe-then-apple@example.com');
    testDb.prepare(`
      INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id)
      VALUES (?, 'pro', 'monthly', 'active', 'stripe', 'sub_live', 'cus_live')
    `).run(userId);

    handleAppleTransaction(
      userId,
      '2000000200000005',
      'me.nexushub.max.monthly',
      new Date(Date.now() + 30 * DAY_MS).toISOString(),
      null,
      appleGrantContext(userId),
    );

    expect(subscriptionRow(userId)).toMatchObject({
      provider: 'apple',
      plan: 'max',
      // The Stripe customer id is the only handle back to that customer.
      provider_customer_id: 'cus_live',
    });
  });

  it('retains the valid appAccountToken on a row that is already Apple', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = createUser('apple-token-refresh@example.com');
    const periodEnd = new Date(Date.now() + 30 * DAY_MS).toISOString();

    const context = appleGrantContext(userId);
    handleAppleTransaction(userId, '2000000200000006', 'me.nexushub.pro.monthly', periodEnd, null, context);
    handleAppleTransaction(userId, '2000000200000006', 'me.nexushub.pro.monthly', periodEnd, null, context);

    expect(subscriptionRow(userId).provider_customer_id).toBe(context.appAccountToken);
  });
});

describe('Apple appAccountToken derivation key', () => {
  /** The token the deleted source-literal fallback key would have produced. */
  function tokenFromDeletedFallbackKey(userId: number): string {
    const body = Buffer.alloc(5);
    body.writeUInt8(0x01, 0);
    body.writeUInt32BE(userId, 1);
    const tag = crypto.createHmac('sha256', 'nexus-apple-app-account-token')
      .update(body).digest().subarray(0, 11);
    const hex = Buffer.concat([body, tag]).toString('hex');
    return [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
    ].join('-');
  }

  beforeEach(() => {
    hoisted.iosJwtSecret = 'test-ios-jwt-secret-at-least-32-bytes-long';
    hoisted.appleAppAccountTokenHmacSecret = 'test-apple-account-token-secret-at-least-32-bytes';
    testDb = new Database(':memory:');
    createSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('keeps tokens stable when IOS_API_JWT_SECRET rotates', async () => {
    const {
      deriveAppleAppAccountToken,
      resolveUserIdFromAppleAppAccountToken,
    } = await import('../../src/services/stripe-service');

    const token = deriveAppleAppAccountToken(4242);
    expect(token).not.toBeNull();
    expect(resolveUserIdFromAppleAppAccountToken(token)).toBe(4242);

    hoisted.iosJwtSecret = 'rotated-ios-jwt-secret-at-least-32-bytes-long';
    expect(deriveAppleAppAccountToken(4242)).toBe(token);
    expect(resolveUserIdFromAppleAppAccountToken(token)).toBe(4242);

    hoisted.appleAppAccountTokenHmacSecret = '';
    expect(deriveAppleAppAccountToken(4242)).toBeNull();
    expect(resolveUserIdFromAppleAppAccountToken(token)).toBeNull();
  });

  it('rejects a token minted with the removed source-literal fallback key', async () => {
    const { resolveUserIdFromAppleAppAccountToken } = await import('../../src/services/stripe-service');

    expect(resolveUserIdFromAppleAppAccountToken(tokenFromDeletedFallbackKey(7))).toBeNull();
    hoisted.appleAppAccountTokenHmacSecret = '';
    expect(resolveUserIdFromAppleAppAccountToken(tokenFromDeletedFallbackKey(7))).toBeNull();
  });

  it('refuses notification-based recovery when the derivation key is unavailable', async () => {
    const {
      deriveAppleAppAccountToken,
      handleAppleNotification,
    } = await import('../../src/services/stripe-service');
    const userId = createUser('apple-no-secret@example.com');
    const forgeable = deriveAppleAppAccountToken(userId);
    expect(forgeable).not.toBeNull();

    hoisted.appleAppAccountTokenHmacSecret = '';
    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000200000007',
      productId: 'me.nexushub.pro.monthly',
      appAccountToken: forgeable,
      environment: 'Production',
      expiresDate: Date.now() + 30 * DAY_MS,
    }), { notificationUUID: 'ffff0001-0000-0000-0000-000000000000' })).toBe(false);

    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);
  });
});
