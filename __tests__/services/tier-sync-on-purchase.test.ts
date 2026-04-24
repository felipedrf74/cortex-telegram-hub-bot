// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-WELCOME-201d (2026-04-24) — welcome email on Stripe + Apple
 * purchase paths.
 *
 * Pins the new wiring from subscriptions → users.tier → welcome-email
 * hook. Before this commit, ONLY Telegram-flow tier grants and the
 * iOS invite-code flow fired the welcome email; real purchases from
 * App Store / nexushub.me never did because they only wrote to the
 * subscriptions table, leaving users.tier at 'free'.
 *
 * This file covers:
 *   - syncUserTierFromSubscription() helper (unit-level semantics):
 *       free → pro writes + fires welcome; same-tier short-circuits;
 *       owner is sticky; invalid inputs reject.
 *   - handleCheckoutCompleted / handleSubscriptionUpdated (Stripe):
 *       first purchase fires welcome once; renewal does NOT.
 *   - handleAppleTransaction (Apple IAP verify):
 *       first purchase fires welcome once; re-verify does NOT.
 *   - handleAppleNotification (Apple server-to-server):
 *       SUBSCRIBED fires once; DID_RENEW does NOT; no-sub-row warns
 *       rather than crashing.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

// Capture welcome-email hook invocations — this is how we assert
// "did the welcome fire on this purchase?" without actually sending
// email. The hook is lazy-required from user-service, so we mock
// the module-level export that require() resolves.
const welcomeCalls: number[] = [];
const fireWelcomeEmailInBackgroundMock = vi.fn((userId: number) => {
  welcomeCalls.push(userId);
});

afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/services/welcome-email-service');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/welcome-email-service', () => ({
  fireWelcomeEmailInBackground: (userId: number) => fireWelcomeEmailInBackgroundMock(userId),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // Skip incompatible migrations in the isolated harness.
    }
  }
}

function seedUser(email: string, tier: string = 'free', telegramId: number | null = null): number {
  const info = testDb.prepare(
    `INSERT INTO users (telegram_id, email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(telegramId, email, tier);
  return Number(info.lastInsertRowid);
}

function seedSubscription(
  userId: number,
  plan: 'pro' | 'max',
  status: 'active' | 'trialing' | 'canceled' | 'past_due' | 'expired',
  provider: 'stripe' | 'apple' = 'stripe',
  providerSubId: string = `sub_${userId}`,
): void {
  testDb.prepare(
    `INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, updated_at)
     VALUES (?, ?, 'monthly', ?, ?, ?, datetime('now'))`,
  ).run(userId, plan, status, provider, providerSubId);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
  welcomeCalls.length = 0;
  fireWelcomeEmailInBackgroundMock.mockClear();
});

afterEach(() => {
  testDb.close();
});

// ─── syncUserTierFromSubscription ─────────────────────────────────

describe('syncUserTierFromSubscription (OI-WELCOME-201d)', () => {
  it('active+pro subscription on a free user → writes tier=pro + fires welcome', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('free@example.com', 'free');
    seedSubscription(userId, 'pro', 'active');

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('pro');
    const row = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(row.tier).toBe('pro');
    expect(welcomeCalls).toEqual([userId]);
  });

  it('trialing+max → writes tier=max + fires welcome (trialing counts as active)', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('trial@example.com', 'free');
    seedSubscription(userId, 'max', 'trialing');

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('max');
    expect(welcomeCalls).toEqual([userId]);
  });

  it('same-tier short-circuit: user already at pro → no UPDATE, no welcome fire', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('already@example.com', 'pro');
    seedSubscription(userId, 'pro', 'active');

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('pro');
    expect(welcomeCalls).toEqual([]); // critical: this is how renewal is silent
  });

  it('canceled subscription → demotes tier to free, does NOT fire welcome', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('canceled@example.com', 'pro');
    seedSubscription(userId, 'pro', 'canceled');

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('free');
    const row = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(row.tier).toBe('free');
    expect(welcomeCalls).toEqual([]); // welcome is a pro/max concept
  });

  it('no subscription row + free user → no-op (returns free)', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('brand-new@example.com', 'free');
    // No subscription row.

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('free');
    expect(welcomeCalls).toEqual([]);
  });

  it('owner tier is sticky: a Pro subscription does NOT demote an owner', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    const userId = seedUser('owner@example.com', 'owner');
    seedSubscription(userId, 'pro', 'active');  // owner bought a Pro plan (test scenario)

    const result = syncUserTierFromSubscription(userId);

    expect(result).toBe('owner');
    const row = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(row.tier).toBe('owner');
    expect(welcomeCalls).toEqual([]);
  });

  it('invalid userId (0 / negative / NaN) returns null without crashing', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    expect(syncUserTierFromSubscription(0)).toBeNull();
    expect(syncUserTierFromSubscription(-1)).toBeNull();
    expect(syncUserTierFromSubscription(NaN)).toBeNull();
    expect(welcomeCalls).toEqual([]);
  });

  it('non-existent userId returns null (user not found)', async () => {
    const { syncUserTierFromSubscription } = await import('../../src/services/user-service');
    expect(syncUserTierFromSubscription(999999)).toBeNull();
  });
});

// ─── Stripe: handleCheckoutCompleted + handleSubscriptionUpdated ─

describe('handleCheckoutCompleted — welcome email on Stripe purchase', () => {
  it('first-time purchase fires the welcome email exactly once', async () => {
    const { handleCheckoutCompleted } = await import('../../src/services/stripe-service');
    const userId = seedUser('buyer@example.com', 'free');

    handleCheckoutCompleted({
      id: 'cs_test_123',
      metadata: { userId: String(userId) },
      subscription: 'sub_test_abc',
      customer: 'cus_test_xyz',
    });

    // subscriptions row written
    const sub = testDb.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(userId) as any;
    expect(sub?.status).toBe('active');
    // users.tier synced
    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(user.tier).toBe('pro');
    // welcome fired once
    expect(welcomeCalls).toEqual([userId]);
  });

  it('duplicate webhook (idempotent retry) does NOT fire welcome twice', async () => {
    const { handleCheckoutCompleted } = await import('../../src/services/stripe-service');
    const userId = seedUser('dup@example.com', 'free');
    const session = {
      id: 'cs_test_123',
      metadata: { userId: String(userId) },
      subscription: 'sub_test_abc',
      customer: 'cus_test_xyz',
    };
    handleCheckoutCompleted(session);
    handleCheckoutCompleted(session);   // Stripe occasionally re-delivers

    expect(welcomeCalls).toEqual([userId]); // exactly one
  });
});

describe('handleSubscriptionUpdated — renewal does NOT fire welcome', () => {
  it('first activation (free → active pro) fires welcome', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = seedUser('new@example.com', 'free');

    handleSubscriptionUpdated({
      id: 'sub_test_abc',
      metadata: { userId: String(userId) },
      status: 'active',
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 2592000,
      cancel_at_period_end: false,
    });

    expect(welcomeCalls).toEqual([userId]);
  });

  it('renewal (already pro, same active sub) does NOT fire welcome', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = seedUser('renewer@example.com', 'pro');
    seedSubscription(userId, 'pro', 'active');

    handleSubscriptionUpdated({
      id: 'sub_test_abc',
      metadata: { userId: String(userId) },
      status: 'active',    // still active
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 2592000,
      cancel_at_period_end: false,
    });

    expect(welcomeCalls).toEqual([]); // the critical assertion
  });

  it('cancel (active pro → canceled) demotes to free, no welcome', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = seedUser('canceler@example.com', 'pro');
    seedSubscription(userId, 'pro', 'active');

    handleSubscriptionUpdated({
      id: 'sub_test_abc',
      metadata: { userId: String(userId) },
      status: 'canceled',
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: true,
    });

    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(user.tier).toBe('free');
    expect(welcomeCalls).toEqual([]);
  });
});

// ─── Apple: handleAppleTransaction + handleAppleNotification ─────

describe('handleAppleTransaction — welcome email on App Store purchase', () => {
  it('first-time IAP verify fires welcome exactly once', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = seedUser('iap@example.com', 'free');

    handleAppleTransaction(userId, '1000000000000000', 'com.nexus.pro.monthly', null);

    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(user.tier).toBe('pro');
    expect(welcomeCalls).toEqual([userId]);
  });

  it('re-verify with the same transaction (retry on app relaunch) does NOT double-fire', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = seedUser('reverify@example.com', 'free');

    handleAppleTransaction(userId, '1000000000000000', 'com.nexus.pro.monthly', null);
    handleAppleTransaction(userId, '1000000000000000', 'com.nexus.pro.monthly', null);

    expect(welcomeCalls).toEqual([userId]);
  });

  it('Max-plan product upgrades tier=max and fires welcome', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = seedUser('max-iap@example.com', 'free');

    handleAppleTransaction(userId, '1000000000000001', 'com.nexus.max.yearly', null);

    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(user.tier).toBe('max');
    expect(welcomeCalls).toEqual([userId]);
  });
});

describe('handleAppleNotification — server lifecycle events', () => {
  function buildSignedJws(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`; // signature ignored by our decoder
  }

  it('SUBSCRIBED fires welcome when user_id can be resolved from provider_subscription_id', async () => {
    const { handleAppleNotification } = await import('../../src/services/stripe-service');
    const userId = seedUser('subscribed@example.com', 'free');
    // Pre-seed the subscription row keyed on the originalTransactionId
    // that the notification will carry — mirrors production where
    // handleAppleTransaction landed first.
    seedSubscription(userId, 'pro', 'active', 'apple', '2000000000000000');

    const jws = buildSignedJws({
      originalTransactionId: '2000000000000000',
      expiresDate: Date.now() + 2592000000,
    });
    const processed = handleAppleNotification('SUBSCRIBED', jws);

    expect(processed).toBe(true);
    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    // handleAppleNotification itself only writes status='active' — the
    // plan is what was written by the earlier seedSubscription (pro).
    expect(user.tier).toBe('pro');
    expect(welcomeCalls).toEqual([userId]);
  });

  it('DID_RENEW on a user already at pro does NOT fire welcome again', async () => {
    const { handleAppleNotification } = await import('../../src/services/stripe-service');
    const userId = seedUser('renewer-apple@example.com', 'pro');
    seedSubscription(userId, 'pro', 'active', 'apple', '2000000000000001');

    const jws = buildSignedJws({
      originalTransactionId: '2000000000000001',
      expiresDate: Date.now() + 2592000000,
    });
    handleAppleNotification('DID_RENEW', jws);

    expect(welcomeCalls).toEqual([]);
  });

  it('EXPIRED demotes tier=free, does NOT fire welcome', async () => {
    const { handleAppleNotification } = await import('../../src/services/stripe-service');
    const userId = seedUser('expired@example.com', 'pro');
    seedSubscription(userId, 'pro', 'active', 'apple', '2000000000000002');

    const jws = buildSignedJws({
      originalTransactionId: '2000000000000002',
      expiresDate: Date.now() - 1000,
    });
    handleAppleNotification('EXPIRED', jws);

    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string };
    expect(user.tier).toBe('free');
    expect(welcomeCalls).toEqual([]);
  });

  it('no matching subscription row → warns + no crash (sync skipped until converge)', async () => {
    const { handleAppleNotification } = await import('../../src/services/stripe-service');
    // No seed — the notification arrives before the initial verify
    // wrote a subscriptions row. This is a legitimate race.

    const jws = buildSignedJws({
      originalTransactionId: '9999999999999999',
      expiresDate: Date.now() + 2592000000,
    });
    const processed = handleAppleNotification('SUBSCRIBED', jws);

    expect(processed).toBe(true);   // the notification itself processed fine
    expect(welcomeCalls).toEqual([]); // welcome doesn't fire without a resolvable user
  });
});
