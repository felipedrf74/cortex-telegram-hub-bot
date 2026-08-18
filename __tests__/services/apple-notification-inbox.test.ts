// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
let packFulfillmentEnabled = true;
const jwsFixtures = new Map<string, Record<string, unknown>>();
const mockHandleAppleNotification = vi.fn(() => true);

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
      get hybridCommerce() {
        return {
          stripePriceIds: { planProMonthly: '', planMaxMonthly: '', pack100: '', pack250: '', pack600: '' },
          appleProductIds: { pack100: 'nx.pack.100.v1', pack250: 'nx.pack.250.v1', pack600: '' },
          applePackFulfillmentEnabled: packFulfillmentEnabled,
          anonymousCheckoutEnabled: true,
        };
      },
    },
  };
});

vi.mock('../../src/services/apple-jws-verifier', () => ({
  verifyAppleJws: (jws: string) => {
    const payload = jwsFixtures.get(jws);
    if (!payload) throw new Error(`unverifiable JWS: ${jws}`);
    return { header: { alg: 'ES256', x5c: ['stub'] }, payload };
  },
  decodeAppleJwsPayload: (jws: string) => jwsFixtures.get(jws) ?? {},
}));

vi.mock('../../src/services/stripe-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stripe-service')>();
  return {
    ...actual,
    handleAppleNotification: (...args: unknown[]) => mockHandleAppleNotification(...(args as [])),
    resolveUserIdFromAppleAppAccountToken: (token: unknown) => (token === 'token-40' ? 40 : null),
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
import { getAiCreditWallet } from '../../src/services/ai-credit-ledger';
import {
  ingestVerifiedAppleNotification,
  processPendingAppleNotifications,
  processStoredAppleNotification,
} from '../../src/services/apple-notification-inbox';

const NOW = new Date('2026-08-18T12:00:00.000Z');

function seedPackNotification(input: {
  outerKey: string;
  innerKey: string;
  notificationType?: string;
  productId?: string;
  transactionId?: string;
  appAccountToken?: string;
}): void {
  jwsFixtures.set(input.outerKey, {
    notificationType: input.notificationType ?? 'ONE_TIME_CHARGE',
    notificationUUID: `uuid-${input.outerKey}`,
    data: { signedTransactionInfo: input.innerKey, environment: 'Production' },
  });
  jwsFixtures.set(input.innerKey, {
    bundleId: 'me.nexushub.app',
    productId: input.productId ?? 'nx.pack.100.v1',
    transactionId: input.transactionId ?? 'apple-txn-1',
    originalTransactionId: input.transactionId ?? 'apple-txn-1',
    appAccountToken: input.appAccountToken ?? 'token-40',
  });
}

function ingest(outerKey: string, notificationType = 'ONE_TIME_CHARGE') {
  return ingestVerifiedAppleNotification({
    notificationUuid: `uuid-${outerKey}`,
    notificationType,
    subtype: null,
    environment: 'Production',
    signedPayload: outerKey,
    now: NOW,
  });
}

describe('apple-notification-inbox', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    jwsFixtures.clear();
    packFulfillmentEnabled = true;
    mockHandleAppleNotification.mockClear();
    mockHandleAppleNotification.mockReturnValue(true);
  });

  afterEach(() => {
    db.close();
  });

  it('stores verified notifications durably and deduplicates by notificationUUID', () => {
    seedPackNotification({ outerKey: 'outer-1', innerKey: 'inner-1' });
    const first = ingest('outer-1');
    expect(first.kind).toBe('stored');
    const replay = ingest('outer-1');
    expect(replay.kind).toBe('duplicate');
    if (first.kind !== 'stored' || replay.kind !== 'duplicate') throw new Error('unreachable');
    expect(replay.row.id).toBe(first.row.id);
    expect(first.row.state).toBe('pending');
  });

  it('settles a pack consumable purchase into the credit ledger exactly once', () => {
    seedPackNotification({ outerKey: 'outer-1', innerKey: 'inner-1' });
    const stored = ingest('outer-1');
    if (stored.kind !== 'stored') throw new Error('unreachable');

    const outcome = processStoredAppleNotification(stored.row.id, NOW);
    expect(outcome).toMatchObject({ kind: 'processed', handled: true });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);

    // A second notification for the same Apple transaction replays the grant.
    seedPackNotification({ outerKey: 'outer-2', innerKey: 'inner-2', transactionId: 'apple-txn-1' });
    const second = ingest('outer-2');
    if (second.kind !== 'stored') throw new Error('unreachable');
    expect(processStoredAppleNotification(second.row.id, NOW)).toMatchObject({ kind: 'processed', handled: true });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 1 });
  });

  it('revokes only the originating lot on a pack refund', () => {
    seedPackNotification({ outerKey: 'outer-1', innerKey: 'inner-1', transactionId: 'apple-txn-1' });
    seedPackNotification({ outerKey: 'outer-keep', innerKey: 'inner-keep', transactionId: 'apple-txn-keep', productId: 'nx.pack.250.v1' });
    for (const key of ['outer-1', 'outer-keep']) {
      const stored = ingest(key);
      if (stored.kind !== 'stored') throw new Error('unreachable');
      processStoredAppleNotification(stored.row.id, NOW);
    }
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(350);

    seedPackNotification({ outerKey: 'outer-refund', innerKey: 'inner-refund', notificationType: 'REFUND', transactionId: 'apple-txn-1' });
    const refund = ingest('outer-refund', 'REFUND');
    if (refund.kind !== 'stored') throw new Error('unreachable');
    expect(processStoredAppleNotification(refund.row.id, NOW)).toMatchObject({ kind: 'processed', handled: true });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(250);
  });

  it('delegates non-pack notifications to the existing Apple handler', () => {
    jwsFixtures.set('outer-sub', {
      notificationType: 'DID_RENEW',
      data: { signedTransactionInfo: 'inner-sub', environment: 'Production' },
    });
    jwsFixtures.set('inner-sub', {
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.pro.monthly',
      transactionId: 'sub-txn-1',
    });
    const stored = ingest('outer-sub', 'DID_RENEW');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    const outcome = processStoredAppleNotification(stored.row.id, NOW);
    expect(outcome).toMatchObject({ kind: 'processed', handled: true });
    expect(mockHandleAppleNotification).toHaveBeenCalledWith('DID_RENEW', 'inner-sub', {
      notificationUUID: 'uuid-outer-sub',
      subtype: null,
      environment: 'Production',
    });
  });

  it('keeps failed notifications for retry and recovers through the sweeper', () => {
    // Ingest with a payload the verifier cannot resolve yet.
    ingestVerifiedAppleNotification({
      notificationUuid: 'uuid-late',
      notificationType: 'ONE_TIME_CHARGE',
      signedPayload: 'outer-late',
      now: NOW,
    });
    const failed = processPendingAppleNotifications({ now: NOW });
    expect(failed).toEqual({ processed: 0, failed: 1, exhausted: 0, deferred: 0 });
    const row = db.prepare("SELECT state, attempts, last_error FROM apple_notification_inbox WHERE notification_uuid = 'uuid-late'").get() as any;
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('unverifiable');

    seedPackNotification({ outerKey: 'outer-late', innerKey: 'inner-late', transactionId: 'apple-txn-late' });
    jwsFixtures.set('outer-late', {
      notificationType: 'ONE_TIME_CHARGE',
      data: { signedTransactionInfo: 'inner-late', environment: 'Production' },
    });
    const recovered = processPendingAppleNotifications({ now: NOW });
    expect(recovered).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('fails a pack purchase without a resolvable appAccountToken instead of guessing ownership', () => {
    seedPackNotification({ outerKey: 'outer-anon', innerKey: 'inner-anon', appAccountToken: 'forged-token' });
    const stored = ingest('outer-anon');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    const outcome = processStoredAppleNotification(stored.row.id, NOW);
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 0 });
  });

  it('defers pack work without burning attempts while the kill switch is off, then fulfills', () => {
    packFulfillmentEnabled = false;
    seedPackNotification({ outerKey: 'outer-1', innerKey: 'inner-1' });
    const stored = ingest('outer-1');
    if (stored.kind !== 'stored') throw new Error('unreachable');

    expect(processStoredAppleNotification(stored.row.id, NOW)).toMatchObject({ kind: 'deferred' });
    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 0, failed: 0, exhausted: 0, deferred: 1 });
    const row = db.prepare('SELECT state, attempts FROM apple_notification_inbox WHERE id = ?').get(stored.row.id) as any;
    expect(row).toEqual({ state: 'pending', attempts: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 0 });

    packFulfillmentEnabled = true;
    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('keeps an unmatched pack reversal retryable until its purchase lands', () => {
    // REFUND arrives before its purchase was ever processed.
    seedPackNotification({ outerKey: 'outer-refund-first', innerKey: 'inner-refund-first', notificationType: 'REFUND', transactionId: 'apple-txn-race' });
    const refund = ingest('outer-refund-first', 'REFUND');
    if (refund.kind !== 'stored') throw new Error('unreachable');
    const refunded = processStoredAppleNotification(refund.row.id, NOW);
    expect(refunded.kind).toBe('failed');
    if (refunded.kind !== 'failed') throw new Error('unreachable');
    expect(refunded.error).toContain('reconciliation');

    // The purchase lands later; the retried reversal then revokes it.
    seedPackNotification({ outerKey: 'outer-late-purchase', innerKey: 'inner-late-purchase', transactionId: 'apple-txn-race' });
    const purchase = ingest('outer-late-purchase');
    if (purchase.kind !== 'stored') throw new Error('unreachable');
    expect(processStoredAppleNotification(purchase.row.id, NOW).kind).toBe('processed');
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);

    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(0);
  });

  it('stops retrying after the attempt budget and enforces inbox immutability', () => {
    seedPackNotification({ outerKey: 'outer-1', innerKey: 'inner-1' });
    const stored = ingest('outer-1');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    db.prepare('UPDATE apple_notification_inbox SET attempts = 5 WHERE id = ?').run(stored.row.id);
    expect(processStoredAppleNotification(stored.row.id, NOW).kind).toBe('exhausted');

    expect(() => db.prepare('DELETE FROM apple_notification_inbox').run()).toThrow(/append-only/);
    expect(() =>
      db.prepare("UPDATE apple_notification_inbox SET signed_payload = 'tampered' WHERE id = ?").run(stored.row.id),
    ).toThrow(/processing-state updates/);
  });
});
