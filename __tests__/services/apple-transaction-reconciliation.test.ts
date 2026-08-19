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
}));

const packActiveMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/services/hybrid-runtime-kill-switches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/hybrid-runtime-kill-switches')>();
  return { ...actual, isApplePackFulfillmentActive: packActiveMock };
});

const recordOperatorAlertMock = vi.hoisted(() => vi.fn(() => ({ ok: true, action: 'created' })));
vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: recordOperatorAlertMock,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  getAppleReconciliationReadiness,
  runAppleTransactionReconciliation,
  type AppleTransactionInfoClient,
} from '../../src/services/apple-transaction-reconciliation';
import { grantPurchasedAiCredits, listAiCreditLots } from '../../src/services/ai-credit-ledger';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function fakeClient(map: Record<string, { revoked?: boolean } | 'not_found' | 'error'>): AppleTransactionInfoClient {
  return {
    async getTransactionInfo(transactionId: string) {
      const entry = map[transactionId];
      if (entry === undefined || entry === 'not_found') return { kind: 'not_found' };
      if (entry === 'error') throw new Error('api down');
      const jws = `jws-${transactionId}`;
      jwsFixtures.set(jws, {
        transactionId,
        ...(entry.revoked ? { revocationDate: NOW.getTime() - 1000 } : {}),
      });
      return { kind: 'found', signedTransactionInfo: jws };
    },
  };
}

beforeEach(() => {
  db = createMigratedTestDatabase();
  jwsFixtures.clear();
  packActiveMock.mockReturnValue(true);
  recordOperatorAlertMock.mockClear();
  delete process.env.APP_STORE_SERVER_API_ISSUER_ID;
  delete process.env.APP_STORE_SERVER_API_KEY_ID;
  delete process.env.APP_STORE_SERVER_API_PRIVATE_KEY_PATH;
});

afterEach(() => {
  db.close();
});

describe('apple transaction reconciliation (NH-0041)', () => {
  it('revokes only the lot whose transaction Apple reports revoked', async () => {
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-keep', credits: 100, now: NOW });
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-revoked', credits: 250, now: NOW });
    grantPurchasedAiCredits({ userId: 41, provider: 'stripe', providerTransactionId: 'pi_untouched', credits: 600, now: NOW });

    const result = await runAppleTransactionReconciliation({
      client: fakeClient({ 'tx-keep': {}, 'tx-revoked': { revoked: true } }),
      now: NOW,
    });
    expect(result).toEqual({ kind: 'completed', checked: 2, revoked: 1, missingTransactions: 0, errors: 0 });

    const lots = listAiCreditLots(40, NOW);
    expect(lots.find((lot) => lot.sourceRef.includes('tx-keep'))?.status).toBe('active');
    expect(lots.find((lot) => lot.sourceRef.includes('tx-revoked'))?.status).toBe('revoked');
    expect(listAiCreditLots(41, NOW).find((lot) => lot.sourceRef.includes('pi_untouched'))?.status).toBe('active');
    expect(recordOperatorAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'apple-transaction-reconciliation',
      severity: 'warning',
    }));
  });

  it('reports unknown transactions and API errors without guessing at revocation', async () => {
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-missing', credits: 100, now: NOW });
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-flaky', credits: 100, now: NOW });
    const result = await runAppleTransactionReconciliation({
      client: fakeClient({ 'tx-missing': 'not_found', 'tx-flaky': 'error' }),
      now: NOW,
    });
    expect(result).toEqual({ kind: 'completed', checked: 2, revoked: 0, missingTransactions: 1, errors: 1 });
    expect(listAiCreditLots(40, NOW).every((lot) => lot.status === 'active')).toBe(true);
  });

  it('stays inert without credentials and while fulfillment is disabled', async () => {
    const readiness = getAppleReconciliationReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(expect.arrayContaining([
      'APP_STORE_SERVER_API_ISSUER_ID',
      'APP_STORE_SERVER_API_KEY_ID',
      'APP_STORE_SERVER_API_PRIVATE_KEY_PATH',
    ]));

    const skipped = await runAppleTransactionReconciliation({ now: NOW });
    expect(skipped.kind).toBe('skipped_missing_credentials');

    packActiveMock.mockReturnValue(false);
    const disabled = await runAppleTransactionReconciliation({
      client: fakeClient({}),
      now: NOW,
    });
    expect(disabled).toEqual({ kind: 'skipped_fulfillment_disabled' });
  });

  it('scans only recent active apple lots inside the window', async () => {
    const old = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-old', credits: 100, now: old });
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'tx-new', credits: 100, now: NOW });
    const result = await runAppleTransactionReconciliation({
      client: fakeClient({ 'tx-new': {} }),
      windowDays: 30,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'completed', checked: 1, revoked: 0, missingTransactions: 0, errors: 0 });
  });
});
