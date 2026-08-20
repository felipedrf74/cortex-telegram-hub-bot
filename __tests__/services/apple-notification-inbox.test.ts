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
  decodeAppleJwsPayload: (jws: string) => {
    const payload = jwsFixtures.get(jws);
    if (!payload) throw new Error(`undecodable JWS: ${jws}`);
    return payload;
  },
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
  backfillAppleReversalIndex,
  ingestVerifiedAppleNotification,
  lookupAppleReversalForTransaction,
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
  quantity?: unknown;
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
    ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
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

function lookupWithOneBackfillPass(transactionId: string) {
  return lookupAppleReversalForTransaction(transactionId, {
    backfillBudget: { remainingPasses: 1 },
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

  it('multiplies pack credits by the transaction quantity within the bound (QA P2-11)', () => {
    seedPackNotification({ outerKey: 'outer-q3', innerKey: 'inner-q3', transactionId: 'apple-txn-q3', quantity: 3 });
    const stored = ingest('outer-q3');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    expect(processStoredAppleNotification(stored.row.id, NOW)).toMatchObject({ kind: 'processed', handled: true });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(300);
  });

  it('treats out-of-bound quantities as non-retryable: immediate exhaustion plus a critical alert (QA3 P3-14)', () => {
    for (const [key, quantity] of [['q0', 0], ['qbig', 250], ['qfrac', 1.5]] as const) {
      seedPackNotification({
        outerKey: `outer-${key}`,
        innerKey: `inner-${key}`,
        transactionId: `apple-txn-${key}`,
        quantity,
      });
      const stored = ingest(`outer-${key}`);
      if (stored.kind !== 'stored') throw new Error('unreachable');
      const result = processStoredAppleNotification(stored.row.id, NOW);
      expect(result).toMatchObject({ kind: 'failed' });
      // Retries cannot fix a quantity: the row is exhausted at once.
      expect(db.prepare('SELECT attempts FROM apple_notification_inbox WHERE id = ?').get(stored.row.id))
        .toEqual({ attempts: 5 });
    }
    const alerts = db.prepare(
      "SELECT COUNT(*) AS count FROM operator_alerts WHERE dedupe_key LIKE 'apple_inbox_nonretryable:%'",
    ).get() as { count: number };
    expect(alerts.count).toBe(3);
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(0);
  });

  it('refuses sandbox pack notifications by default and allows them only via the explicit flag (QA3 P2-9)', () => {
    const sandboxIngest = (uuid: string, outerKey: string) => {
      const stored = ingestVerifiedAppleNotification({
        notificationUuid: uuid,
        notificationType: 'ONE_TIME_CHARGE',
        subtype: null,
        environment: 'Sandbox',
        signedPayload: outerKey,
        now: NOW,
      });
      if (stored.kind !== 'stored') throw new Error('unreachable');
      return stored.row.id;
    };
    // Default: refused everywhere — NODE_ENV plays no part. The VERIFIED
    // outer payload carries the Sandbox claim.
    seedPackNotification({ outerKey: 'outer-sbx', innerKey: 'inner-sbx', transactionId: 'apple-txn-sbx' });
    jwsFixtures.set('outer-sbx', {
      notificationType: 'ONE_TIME_CHARGE',
      notificationUUID: 'uuid-outer-sbx',
      data: { signedTransactionInfo: 'inner-sbx', environment: 'Sandbox' },
    });
    expect(processStoredAppleNotification(sandboxIngest('uuid-outer-sbx', 'outer-sbx'), NOW))
      .toMatchObject({ kind: 'failed' });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(0);

    // Staging opts in deliberately with the flag.
    seedPackNotification({ outerKey: 'outer-sbx2', innerKey: 'inner-sbx2', transactionId: 'apple-txn-sbx2' });
    jwsFixtures.set('outer-sbx2', {
      notificationType: 'ONE_TIME_CHARGE',
      notificationUUID: 'uuid-outer-sbx2',
      data: { signedTransactionInfo: 'inner-sbx2', environment: 'Sandbox' },
    });
    vi.stubEnv('APPLE_ALLOW_SANDBOX_GRANTS', 'true');
    try {
      expect(processStoredAppleNotification(sandboxIngest('uuid-outer-sbx2', 'outer-sbx2'), NOW))
        .toMatchObject({ kind: 'processed', handled: true });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('hard-fails a paid charge whose product resolves to nothing, with an operator alert (QA3 P1-3)', () => {
    // Fulfillment ON, but the product id matches neither a catalog pack nor a
    // legacy product the delegate handler recognizes.
    mockHandleAppleNotification.mockReturnValue(false);
    seedPackNotification({
      outerKey: 'outer-unres',
      innerKey: 'inner-unres',
      transactionId: 'apple-txn-unres',
      productId: 'nx.unknown.product',
    });
    const stored = ingest('outer-unres');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    const result = processStoredAppleNotification(stored.row.id, NOW);
    expect(result).toMatchObject({ kind: 'failed' });
    // Retryable — pasting the product ids later lands the grant.
    expect(db.prepare('SELECT state, attempts FROM apple_notification_inbox WHERE id = ?').get(stored.row.id))
      .toEqual({ state: 'failed', attempts: 1 });
    const alerts = db.prepare(
      "SELECT COUNT(*) AS count FROM operator_alerts WHERE dedupe_key LIKE 'apple_inbox_unresolvable_charge:%'",
    ).get() as { count: number };
    expect(alerts.count).toBe(1);
    mockHandleAppleNotification.mockReturnValue(true);
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
    expect(failed).toEqual({ processed: 0, failed: 1, exhausted: 0, deferred: 0, stuckExhausted: 0 });
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
    expect(recovered).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('parks only STORED pack product ids behind the kill switch — a legacy points charge stays retryable (QA3 P2-11)', () => {
    packFulfillmentEnabled = false;
    // A pending, never-attempted legacy points ONE_TIME_CHARGE (product id is
    // NOT a configured pack) must be selected and delegated, not excluded.
    seedPackNotification({
      outerKey: 'outer-legacy-pts',
      innerKey: 'inner-legacy-pts',
      transactionId: 'apple-txn-legacy',
      productId: 'me.nexushub.points.small',
    });
    const points = ingest('outer-legacy-pts');
    if (points.kind !== 'stored') throw new Error('unreachable');
    // A pack row with the SAME shape defers and is excluded from the sweep.
    seedPackNotification({ outerKey: 'outer-pack-park', innerKey: 'inner-pack-park', transactionId: 'apple-txn-park' });
    const pack = ingest('outer-pack-park');
    if (pack.kind !== 'stored') throw new Error('unreachable');

    const pass = processPendingAppleNotifications({ now: NOW });
    // The legacy charge processed via the delegate; the pack stayed parked.
    expect(pass).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 });
    expect(db.prepare('SELECT state, attempts, product_id FROM apple_notification_inbox WHERE id = ?').get(pack.row.id))
      .toEqual({ state: 'pending', attempts: 0, product_id: 'nx.pack.100.v1' });
    expect(db.prepare('SELECT state FROM apple_notification_inbox WHERE id = ?').get(points.row.id))
      .toEqual({ state: 'processed' });
    packFulfillmentEnabled = true;
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
    // QA P1-4: deferred pack rows are excluded from the retry selection while
    // fulfillment is off, so they cannot park at the head of every pass and
    // starve retryable subscription notifications behind them.
    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 0, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 });
    const row = db.prepare('SELECT state, attempts FROM apple_notification_inbox WHERE id = ?').get(stored.row.id) as any;
    expect(row).toEqual({ state: 'pending', attempts: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 0 });

    packFulfillmentEnabled = true;
    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('does not let deferred pack rows starve other retryable notifications', () => {
    packFulfillmentEnabled = false;
    for (let i = 0; i < 30; i += 1) {
      seedPackNotification({ outerKey: `outer-defer-${i}`, innerKey: `inner-defer-${i}`, transactionId: `txn-defer-${i}` });
      ingest(`outer-defer-${i}`);
    }
    jwsFixtures.set('outer-sub-behind', {
      notificationType: 'DID_RENEW',
      data: { signedTransactionInfo: 'inner-sub-behind', environment: 'Production' },
    });
    jwsFixtures.set('inner-sub-behind', { bundleId: 'me.nexushub.app', productId: 'me.nexushub.pro.monthly', transactionId: 'sub-1' });
    ingest('outer-sub-behind', 'DID_RENEW');

    const pass = processPendingAppleNotifications({ now: NOW });
    expect(pass.processed).toBe(1);
    expect(mockHandleAppleNotification).toHaveBeenCalledTimes(1);
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

    expect(processPendingAppleNotifications({ now: NOW })).toEqual({ processed: 1, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(0);
  });

  it('alerts on retry-exhausted rows the scheduled pass can never select (QA5 P2)', () => {
    // The pending selector requires attempts < MAX, so an exhausted row was
    // never passed to processStoredAppleNotification and its alert was
    // unreachable: money Apple collected sat ungrantable with zero signal.
    seedPackNotification({ outerKey: 'outer-exhausted', innerKey: 'inner-exhausted', transactionId: 'txn-exhausted' });
    const stored = ingest('outer-exhausted');
    if (stored.kind !== 'stored') throw new Error('unreachable');
    db.prepare("UPDATE apple_notification_inbox SET attempts = 5, state = 'failed' WHERE id = ?").run(stored.row.id);

    const pass = processPendingAppleNotifications({ now: NOW });
    // The selector can never pick an already-exhausted row, so this pass
    // exhausted nothing new; the stuck row surfaces on the gauge instead
    // (QA5 P2 keeps the alert, QA6 P3 stops the counter inflating).
    expect(pass.exhausted).toBe(0);
    expect(pass.stuckExhausted).toBe(1);
    expect(processPendingAppleNotifications({ now: NOW }).stuckExhausted).toBe(1);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM operator_alerts WHERE dedupe_key LIKE 'apple_inbox_exhausted:%'",
    ).get()).toEqual({ count: 1 });

    // Repeated passes dedupe to one open alert rather than piling up.
    processPendingAppleNotifications({ now: NOW });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM operator_alerts WHERE dedupe_key LIKE 'apple_inbox_exhausted:%'",
    ).get()).toEqual({ count: 1 });
  });

  it('excludes deferred pack rows that already reached failed (QA5 P2 starvation)', () => {
    // The old exclusion required state='pending' AND attempts=0, so a pack row
    // that had already failed kept its place at the head of every pass.
    packFulfillmentEnabled = false;
    for (let i = 0; i < 30; i += 1) {
      seedPackNotification({ outerKey: `outer-failed-${i}`, innerKey: `inner-failed-${i}`, transactionId: `txn-failed-${i}` });
      const row = ingest(`outer-failed-${i}`);
      if (row.kind !== 'stored') throw new Error('unreachable');
      db.prepare("UPDATE apple_notification_inbox SET attempts = 1, state = 'failed' WHERE id = ?").run(row.row.id);
    }
    jwsFixtures.set('outer-sub-starved', {
      notificationType: 'DID_RENEW',
      data: { signedTransactionInfo: 'inner-sub-starved', environment: 'Production' },
    });
    jwsFixtures.set('inner-sub-starved', { bundleId: 'me.nexushub.app', productId: 'me.nexushub.pro.monthly', transactionId: 'sub-starved' });
    ingest('outer-sub-starved', 'DID_RENEW');

    const pass = processPendingAppleNotifications({ now: NOW });
    expect(pass.processed).toBe(1);
    expect(mockHandleAppleNotification).toHaveBeenCalledTimes(1);
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

describe('reversal transaction index (QA6 P2)', () => {
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

  /**
   * The lookup used to scan `ORDER BY id DESC LIMIT 2000` and decode each
   * stored JWS, so once more than 2,000 reversals accumulated — and migration
   * 286 forbids deleting them — every older refund silently returned CLEAN and
   * became replayable through restore-packs.
   */
  it('finds a refund buried far beyond the old 2,000-row scan window', () => {
    seedPackNotification({
      outerKey: 'outer-victim-refund',
      innerKey: 'inner-victim-refund',
      notificationType: 'REFUND',
      transactionId: 'txn-victim',
    });
    ingest('outer-victim-refund', 'REFUND');

    // Bury it under far more reversals than the retired cap allowed.
    for (let index = 0; index < 2_500; index += 1) {
      seedPackNotification({
        outerKey: `outer-noise-${index}`,
        innerKey: `inner-noise-${index}`,
        notificationType: 'REFUND',
        transactionId: `txn-noise-${index}`,
      });
      ingest(`outer-noise-${index}`, 'REFUND');
    }

    expect(lookupWithOneBackfillPass('txn-victim')).toEqual({ kind: 'recorded' });
    expect(lookupWithOneBackfillPass('txn-never-refunded')).toEqual({ kind: 'clear' });
  });

  it('re-probes a match indexed by the bounded pass before reporting the remaining backlog', () => {
    seedPackNotification({
      outerKey: 'outer-first-batch-match',
      innerKey: 'inner-first-batch-match',
      notificationType: 'REFUND',
      transactionId: 'txn-first-batch-match',
    });
    ingest('outer-first-batch-match', 'REFUND');
    for (let index = 0; index < 500; index += 1) {
      seedPackNotification({
        outerKey: `outer-legacy-backlog-${index}`,
        innerKey: `inner-legacy-backlog-${index}`,
        notificationType: 'REFUND',
        transactionId: `txn-legacy-backlog-${index}`,
      });
      ingest(`outer-legacy-backlog-${index}`, 'REFUND');
    }
    db.prepare(
      `UPDATE apple_notification_inbox
          SET reversal_transaction_id = NULL,
              reversal_original_transaction_id = NULL,
              reversal_indexed_at = NULL`,
    ).run();

    expect(lookupWithOneBackfillPass('txn-first-batch-match')).toEqual({ kind: 'recorded' });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM apple_notification_inbox
        WHERE reversal_indexed_at IS NULL`,
    ).get()).toEqual({ n: 1 });
  });

  it('matches on the original transaction id as well as the transaction id', () => {
    jwsFixtures.set('outer-original', {
      notificationType: 'REVOKE',
      notificationUUID: 'uuid-outer-original',
      data: { signedTransactionInfo: 'inner-original', environment: 'Production' },
    });
    jwsFixtures.set('inner-original', {
      bundleId: 'me.nexushub.app',
      productId: 'nx.pack.100.v1',
      transactionId: 'txn-child',
      originalTransactionId: 'txn-parent',
    });
    ingest('outer-original', 'REVOKE');

    expect(lookupWithOneBackfillPass('txn-parent')).toEqual({ kind: 'recorded' });
    expect(lookupWithOneBackfillPass('txn-child')).toEqual({ kind: 'recorded' });
  });

  it('does not treat a non-reversal notification as a reversal', () => {
    seedPackNotification({
      outerKey: 'outer-charge',
      innerKey: 'inner-charge',
      notificationType: 'ONE_TIME_CHARGE',
      transactionId: 'txn-charge',
    });
    ingest('outer-charge', 'ONE_TIME_CHARGE');
    expect(lookupWithOneBackfillPass('txn-charge')).toEqual({ kind: 'clear' });
  });

  it('fails CLOSED while a legacy row still has no extracted identity', () => {
    seedPackNotification({
      outerKey: 'outer-legacy',
      innerKey: 'inner-legacy',
      notificationType: 'REFUND',
      transactionId: 'txn-legacy',
    });
    ingest('outer-legacy', 'REFUND');
    // Simulate a row ingested before migration 292 added the columns.
    db.prepare(
      `UPDATE apple_notification_inbox
          SET reversal_transaction_id = NULL,
              reversal_original_transaction_id = NULL,
              reversal_indexed_at = NULL`,
    ).run();

    // The lookup backfills what it can; here the payload IS decodable, so the
    // backlog clears and the answer is the true one.
    expect(lookupWithOneBackfillPass('txn-legacy')).toEqual({ kind: 'recorded' });
    expect(lookupWithOneBackfillPass('txn-other')).toEqual({ kind: 'clear' });

    const pending = db
      .prepare('SELECT COUNT(*) AS n FROM apple_notification_inbox WHERE reversal_indexed_at IS NULL')
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it('keeps an undecodable legacy reversal unresolved and fails restoration closed', () => {
    seedPackNotification({
      outerKey: 'outer-broken',
      innerKey: 'inner-broken',
      notificationType: 'REFUND',
      transactionId: 'txn-broken',
    });
    ingest('outer-broken', 'REFUND');
    db.prepare(
      `UPDATE apple_notification_inbox
          SET signed_payload = signed_payload, reversal_indexed_at = NULL`,
    ).run();
    jwsFixtures.delete('outer-broken');

    const result = backfillAppleReversalIndex();
    expect(result.hasRemaining).toBe(true);
    // A durable REFUND/REVOKE row whose transaction identity cannot be read
    // may be the transaction under restoration. It must block every clean
    // verdict until an operator repairs or reindexes the evidence.
    expect(lookupWithOneBackfillPass('txn-unrelated')).toEqual({
      kind: 'unavailable',
      reason: 'index_incomplete',
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM operator_alerts
        WHERE dedupe_key = 'apple_reversal_index_incomplete'`,
    ).get()).toEqual({ n: 1 });
  });

  it('leaves a newly ingested reversal unresolved when identity extraction fails', () => {
    jwsFixtures.set('outer-ingest-broken', {
      notificationType: 'REFUND',
      notificationUUID: 'uuid-outer-ingest-broken',
      data: { signedTransactionInfo: 'inner-ingest-broken', environment: 'Production' },
    });
    // The durable inbox must still store the already-verified outer payload,
    // but a missing inner decode cannot be represented as a clean NULL index.
    const stored = ingest('outer-ingest-broken', 'REFUND');
    if (stored.kind !== 'stored') throw new Error('unreachable');

    expect(db.prepare(
      `SELECT reversal_transaction_id AS transactionId,
              reversal_original_transaction_id AS originalTransactionId,
              reversal_indexed_at AS indexedAt
         FROM apple_notification_inbox WHERE id = ?`,
    ).get(stored.row.id)).toEqual({ transactionId: null, originalTransactionId: null, indexedAt: null });
    expect(lookupWithOneBackfillPass('txn-unrelated')).toEqual({
      kind: 'unavailable',
      reason: 'index_incomplete',
    });
  });

  it('does not spend the bounded window on legacy non-reversal rows', () => {
    const insert = db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
      VALUES (?, 'ONE_TIME_CHARGE', ?, 'processed', 1, '2026-08-18T00:00:00.000Z')`);
    db.transaction(() => {
      for (let index = 0; index < 600; index += 1) {
        insert.run(`uuid-legacy-charge-${index}`, `legacy-charge-${index}`);
      }
    })();
    seedPackNotification({
      outerKey: 'outer-refund-after-charges',
      innerKey: 'inner-refund-after-charges',
      notificationType: 'REFUND',
      transactionId: 'txn-refund-after-charges',
    });
    const target = ingest('outer-refund-after-charges', 'REFUND');
    if (target.kind !== 'stored') throw new Error('unreachable');
    db.prepare(`UPDATE apple_notification_inbox
      SET reversal_transaction_id = NULL,
          reversal_original_transaction_id = NULL,
          reversal_indexed_at = NULL
      WHERE id = ?`).run(target.row.id);

    expect(lookupWithOneBackfillPass('txn-refund-after-charges')).toEqual({ kind: 'recorded' });
  });

  it('advances past a permanently undecodable head batch on the next pass', () => {
    const insert = db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
      VALUES (?, 'REFUND', ?, 'failed', 5, '2026-08-18T00:00:00.000Z')`);
    db.transaction(() => {
      for (let index = 0; index < 500; index += 1) {
        insert.run(`uuid-corrupt-head-${index}`, `corrupt-head-${index}`);
      }
    })();
    seedPackNotification({
      outerKey: 'outer-refund-after-corrupt-head',
      innerKey: 'inner-refund-after-corrupt-head',
      notificationType: 'REFUND',
      transactionId: 'txn-refund-after-corrupt-head',
    });
    const target = ingest('outer-refund-after-corrupt-head', 'REFUND');
    if (target.kind !== 'stored') throw new Error('unreachable');
    db.prepare(`UPDATE apple_notification_inbox
      SET reversal_transaction_id = NULL,
          reversal_original_transaction_id = NULL,
          reversal_indexed_at = NULL
      WHERE id = ?`).run(target.row.id);

    expect(lookupWithOneBackfillPass('txn-refund-after-corrupt-head')).toEqual({
      kind: 'unavailable',
      reason: 'index_incomplete',
    });
    expect(lookupWithOneBackfillPass('txn-refund-after-corrupt-head')).toEqual({ kind: 'recorded' });
  });

  it('repairs a readable predecessor-stamped reversal with both identities null', () => {
    seedPackNotification({
      outerKey: 'outer-predecessor-stamped-null',
      innerKey: 'inner-predecessor-stamped-null',
      notificationType: 'REFUND',
      transactionId: 'txn-predecessor-stamped-null',
    });
    db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at,
       reversal_transaction_id, reversal_original_transaction_id, reversal_indexed_at)
      VALUES ('uuid-predecessor-stamped-null', 'REFUND', 'outer-predecessor-stamped-null',
              'processed', 1, '2026-08-18T00:00:00.000Z', NULL, NULL,
              '2026-08-18T00:01:00.000Z')`)
      .run();

    expect(lookupWithOneBackfillPass('txn-predecessor-stamped-null')).toEqual({ kind: 'recorded' });
  });

  it('fails closed without auto-retrying a manually nulled progress counter', () => {
    db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at,
       reversal_index_attempts)
      VALUES ('uuid-null-progress', 'REVOKE', 'corrupt-null-progress', 'failed', 5,
              '2026-08-18T00:00:00.000Z', NULL)`)
      .run();

    expect(lookupWithOneBackfillPass('txn-null-progress')).toEqual({
      kind: 'unavailable',
      reason: 'index_incomplete',
    });
    expect(db.prepare(`SELECT reversal_index_attempts AS attempts
                         FROM apple_notification_inbox
                        WHERE notification_uuid = 'uuid-null-progress'`).get())
      .toEqual({ attempts: null });
  });

  it('drains readable reversal-index backlog from scheduled inbox maintenance', () => {
    seedPackNotification({
      outerKey: 'outer-scheduled-backfill',
      innerKey: 'inner-scheduled-backfill',
      notificationType: 'REFUND',
      transactionId: 'txn-scheduled-backfill',
    });
    const target = ingest('outer-scheduled-backfill', 'REFUND');
    if (target.kind !== 'stored') throw new Error('unreachable');
    db.prepare(`UPDATE apple_notification_inbox
      SET state = 'processed',
          reversal_transaction_id = NULL,
          reversal_original_transaction_id = NULL,
          reversal_indexed_at = NULL
      WHERE id = ?`).run(target.row.id);

    processPendingAppleNotifications({ now: NOW });

    expect(db.prepare(`SELECT reversal_transaction_id AS transactionId,
                              reversal_indexed_at AS indexedAt
                         FROM apple_notification_inbox WHERE id = ?`).get(target.row.id))
      .toEqual({ transactionId: 'txn-scheduled-backfill', indexedAt: NOW.toISOString() });
  });
});
