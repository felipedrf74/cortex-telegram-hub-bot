// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => db, initDatabase: vi.fn(), closeDatabase: vi.fn() };
});

const jwsFixtures = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../src/services/apple-jws-verifier', () => ({
  verifyAppleJws: (jws: string) => {
    const payload = jwsFixtures.get(jws);
    if (!payload) throw new Error(`unverifiable JWS: ${jws}`);
    return { header: { alg: 'ES256', x5c: ['stub'] }, payload };
  },
  decodeAppleJwsPayload: (jws: string) => jwsFixtures.get(jws) ?? {},
}));

const resolveTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/stripe-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stripe-service')>();
  return { ...actual, resolveUserIdFromAppleAppAccountToken: resolveTokenMock };
});

const packActiveMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/services/hybrid-runtime-kill-switches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/hybrid-runtime-kill-switches')>();
  return { ...actual, isApplePackFulfillmentActive: packActiveMock };
});

const catalogItemMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/billing-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/billing-catalog')>();
  return { ...actual, resolveBillingCatalogItemByAppleProductId: catalogItemMock };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { restoreApplePackTransactions } from '../../src/services/apple-pack-restoration';
import { getAiCreditWallet, listAiCreditLots } from '../../src/services/ai-credit-ledger';

const PACK = { id: 'pack_100', kind: 'credit_pack', credits: 100 } as never;

function fixture(jws: string, payload: Record<string, unknown>): string {
  jwsFixtures.set(jws, payload);
  return jws;
}

beforeEach(() => {
  db = createMigratedTestDatabase();
  jwsFixtures.clear();
  packActiveMock.mockReturnValue(true);
  resolveTokenMock.mockReturnValue(40);
  catalogItemMock.mockImplementation((productId: string) => (productId === 'me.nexushub.pack100' ? PACK : null));
});

afterEach(() => {
  db.close();
});

describe('apple pack restoration (NH-0041)', () => {
  const validTransaction = (overrides: Record<string, unknown> = {}) => fixture(`jws-${JSON.stringify(overrides)}`, {
    bundleId: 'me.nexushub.app',
    productId: 'me.nexushub.pack100',
    environment: 'Production',
    appAccountToken: 'token-40',
    transactionId: 'tx-restore-1',
    quantity: 1,
    ...overrides,
  });

  it('credits a settled pack the inbox lost, idempotently per transaction', () => {
    const jws = validTransaction();
    const first = restoreApplePackTransactions({ userId: 40, signedTransactions: [jws] });
    expect(first).toEqual({
      kind: 'processed',
      results: [{ outcome: 'credited', catalogItemId: 'pack_100', transactionId: 'tx-restore-1' }],
    });
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(100);

    const replay = restoreApplePackTransactions({ userId: 40, signedTransactions: [jws] });
    expect(replay).toEqual({
      kind: 'processed',
      results: [{ outcome: 'already_credited', catalogItemId: 'pack_100', transactionId: 'tx-restore-1' }],
    });
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(100);
    expect(listAiCreditLots(40).filter((lot) => lot.sourceRef.includes('tx-restore-1'))).toHaveLength(1);
  });

  it('refuses a transaction bound to another account without leaking its existence', () => {
    resolveTokenMock.mockReturnValue(99);
    const result = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [validTransaction({ transactionId: 'tx-foreign' })],
    });
    expect(result).toEqual({
      kind: 'processed',
      results: [{ outcome: 'wrong_account', catalogItemId: 'pack_100' }],
    });
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(0);
    expect(getAiCreditWallet(99, 'pro').purchasedRemaining).toBe(0);
  });

  it('refuses sandbox transactions, unknown products, forged JWS, and bad quantities', () => {
    const results = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [
        validTransaction({ environment: 'Sandbox', transactionId: 'tx-sandbox' }),
        fixture('jws-unknown-product', { bundleId: 'me.nexushub.app', productId: 'me.nexushub.points.small', environment: 'Production' }),
        'jws-never-signed',
        validTransaction({ quantity: 0, transactionId: 'tx-qty' }),
      ],
    });
    expect(results.kind).toBe('processed');
    if (results.kind !== 'processed') throw new Error('unreachable');
    expect(results.results.map((r) => r.outcome)).toEqual([
      'environment_refused',
      'not_a_pack',
      'invalid_transaction',
      'invalid_transaction',
    ]);
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(0);
  });

  it('refuses foreign-app and revoked transactions without minting credit (QA4 P2-4/P2-5)', () => {
    const results = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [
        // Apple-signed but for another developer's app: signature validity
        // alone must never bind a transaction to Nexus Hub.
        validTransaction({ bundleId: 'com.attacker.someotherapp', transactionId: 'tx-foreign-bundle' }),
        validTransaction({ bundleId: undefined, transactionId: 'tx-missing-bundle' }),
        // Refunded purchase whose revoking notification was also lost.
        validTransaction({ revocationDate: 1766000000000, transactionId: 'tx-revoked' }),
        // Reason code 0 (Apple: refunded for app issue) must still refuse.
        validTransaction({ revocationReason: 0, transactionId: 'tx-revoked-reason' }),
      ],
    });
    expect(results.kind).toBe('processed');
    if (results.kind !== 'processed') throw new Error('unreachable');
    expect(results.results.map((r) => r.outcome)).toEqual([
      'wrong_bundle',
      'wrong_bundle',
      'revoked',
      'revoked',
    ]);
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(0);
    expect(listAiCreditLots(40)).toHaveLength(0);
  });

  it('refuses a transaction the durable inbox already recorded as refunded (QA5 P2)', () => {
    // The exposed window: the refund notification failed processing (so no lot
    // was ever revoked) and the client replays the JWS it cached BEFORE the
    // refund, which therefore carries no revocationDate.
    fixture('inner-refund-record', { transactionId: 'tx-refunded' });
    fixture('outer-refund-record', { data: { signedTransactionInfo: 'inner-refund-record' } });
    db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
      VALUES ('uuid-refund', 'REFUND', 'outer-refund-record', 'failed', 5, '2026-08-18T00:00:00.000Z')`)
      .run();

    const result = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [validTransaction({ transactionId: 'tx-refunded' })],
    });
    expect(result).toEqual({
      kind: 'processed',
      results: [{ outcome: 'revoked', catalogItemId: 'pack_100', transactionId: 'tx-refunded' }],
    });
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(0);
    expect(listAiCreditLots(40)).toHaveLength(0);
  });

  it('ignores unrelated and undecodable reversal rows when checking for a refund', () => {
    // A REFUND for a DIFFERENT transaction, and a row whose payload cannot be
    // decoded, must neither block this restore nor throw.
    fixture('inner-other-refund', { transactionId: 'tx-someone-else' });
    fixture('outer-other-refund', { data: { signedTransactionInfo: 'inner-other-refund' } });
    db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
      VALUES ('uuid-other', 'REFUND', 'outer-other-refund', 'processed', 1, '2026-08-18T00:00:00.000Z'),
             ('uuid-broken', 'REVOKE', 'not-a-registered-fixture', 'failed', 5, '2026-08-18T00:00:00.000Z')`)
      .run();

    const result = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [validTransaction({ transactionId: 'tx-clean' })],
    });
    expect(result).toEqual({
      kind: 'processed',
      results: [{ outcome: 'credited', catalogItemId: 'pack_100', transactionId: 'tx-clean' }],
    });
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(100);
  });

  it('matches a reversal recorded against the original transaction id', () => {
    fixture('inner-orig-refund', { originalTransactionId: 'tx-original' });
    fixture('outer-orig-refund', { data: { signedTransactionInfo: 'inner-orig-refund' } });
    db.prepare(`INSERT INTO apple_notification_inbox
      (notification_uuid, notification_type, signed_payload, state, attempts, received_at)
      VALUES ('uuid-orig', 'REVOKE', 'outer-orig-refund', 'pending', 0, '2026-08-18T00:00:00.000Z')`)
      .run();

    const result = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [validTransaction({ transactionId: 'tx-original' })],
    });
    expect(result).toEqual({
      kind: 'processed',
      results: [{ outcome: 'revoked', catalogItemId: 'pack_100', transactionId: 'tx-original' }],
    });
    expect(listAiCreditLots(40)).toHaveLength(0);
  });

  it('multiplies credits by the Apple quantity like the inbox path', () => {
    const result = restoreApplePackTransactions({
      userId: 40,
      signedTransactions: [validTransaction({ quantity: 3, transactionId: 'tx-q3' })],
    });
    expect(result.kind).toBe('processed');
    expect(getAiCreditWallet(40, 'pro').purchasedRemaining).toBe(300);
  });

  it('fails closed when fulfillment is disabled and rejects unbounded requests', () => {
    packActiveMock.mockReturnValue(false);
    expect(restoreApplePackTransactions({ userId: 40, signedTransactions: [validTransaction()] }))
      .toEqual({ kind: 'fulfillment_disabled' });

    packActiveMock.mockReturnValue(true);
    expect(restoreApplePackTransactions({ userId: 40, signedTransactions: [] }).kind).toBe('invalid_request');
    expect(restoreApplePackTransactions({ userId: 40, signedTransactions: 'not-an-array' }).kind).toBe('invalid_request');
    expect(restoreApplePackTransactions({
      userId: 40,
      signedTransactions: Array.from({ length: 9 }, (_, i) => `jws-${i}`),
    }).kind).toBe('invalid_request');
  });
});
