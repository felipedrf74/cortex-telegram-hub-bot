// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return {
    ...actual,
    getDb: () => db,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
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

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  captureAiCreditReservation,
  expireStaleAiCreditReservations,
  getAiCreditWallet,
  getPlanCreditPolicy,
  grantMonthlyAiCredits,
  grantPromotionalAiCredits,
  grantPurchasedAiCredits,
  listAiCreditLots,
  releaseAiCreditReservation,
  reserveAiCredits,
  revokeAiCreditLot,
} from '../../src/services/ai-credit-ledger';
import type { AiCreditReplayScope } from '../../src/services/ai-credit-ledger';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');

function scope(id: string, userId = 40): AiCreditReplayScope {
  return {
    tenantScope: `tenant-${userId}`,
    workload: 'chat',
    requestHash: `hash-${id}`,
    clientOperationId: `op-${id}`,
  };
}

describe('ai-credit-ledger', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('reads seeded plan credit policy and fails closed on missing rows', () => {
    expect(getPlanCreditPolicy('free')).toEqual({ monthlyCredits: 60, dailyCapCredits: 5 });
    expect(getPlanCreditPolicy('pro')).toEqual({ monthlyCredits: 500, dailyCapCredits: 50 });
    expect(getPlanCreditPolicy('max')).toEqual({ monthlyCredits: 1200, dailyCapCredits: 100 });
    db.prepare("DELETE FROM plan_configs WHERE plan_id = 'beta'").run();
    expect(getPlanCreditPolicy('beta')).toEqual({ monthlyCredits: 0, dailyCapCredits: 0 });
  });

  it('grants monthly credits exactly once per billing period', () => {
    const first = grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    expect(first.kind).toBe('granted');
    const replay = grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    expect(replay.kind).toBe('already_granted');
    if (first.kind !== 'granted' || replay.kind !== 'already_granted') throw new Error('unreachable');
    expect(replay.lot.id).toBe(first.lot.id);
    expect(first.lot.creditsGranted).toBe(500);
    expect(first.lot.expiresAt).toBe(PERIOD_END.toISOString());

    db.prepare("UPDATE plan_configs SET monthly_ai_credits = 0 WHERE plan_id = 'beta'").run();
    const rejected = grantMonthlyAiCredits({ userId: 41, plan: 'beta', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    expect(rejected.kind).toBe('rejected');
  });

  it('validates promotional expiry against the 30/60/90-day policy', () => {
    expect(
      grantPromotionalAiCredits({ userId: 40, promotionId: 'launch', credits: 10, expiryDays: 45, now: NOW }).kind,
    ).toBe('rejected');
    const granted = grantPromotionalAiCredits({ userId: 40, promotionId: 'launch', credits: 10, expiryDays: 30, now: NOW });
    expect(granted.kind).toBe('granted');
    const replay = grantPromotionalAiCredits({ userId: 40, promotionId: 'launch', credits: 10, expiryDays: 30, now: NOW });
    expect(replay.kind).toBe('already_granted');
  });

  it('binds purchased lots to unique provider transactions and never expires them', () => {
    const first = grantPurchasedAiCredits({ userId: 40, provider: 'stripe', providerTransactionId: 'pi_1', credits: 100, now: NOW });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') throw new Error('unreachable');
    expect(first.lot.expiresAt).toBeNull();
    const replay = grantPurchasedAiCredits({ userId: 40, provider: 'stripe', providerTransactionId: 'pi_1', credits: 100, now: NOW });
    expect(replay.kind).toBe('already_granted');
    if (replay.kind !== 'already_granted') throw new Error('unreachable');
    expect(replay.lot.id).toBe(first.lot.id);
  });

  it('reserves atomically and reports the wallet with reserved credits subtracted', () => {
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    const result = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'deep', replayScope: scope('a'), now: NOW });
    expect(result.kind).toBe('reserved');
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.includedRemaining).toBe(500);
    expect(wallet.reservedCredits).toBe(3);
    expect(wallet.availableCredits).toBe(497);
    expect(wallet.dailyUsedCredits).toBe(3);
    expect(wallet.dailyRemainingCredits).toBe(47);
  });

  it('denies with the exact required and available amounts and a pack CTA only for paid plans', () => {
    const freeDenied = reserveAiCredits({ userId: 50, plan: 'free', operationClass: 'standard', replayScope: scope('f', 50), now: NOW });
    expect(freeDenied).toEqual({
      kind: 'insufficient_credits',
      requiredCredits: 1,
      availableCredits: 0,
      packCtaEligible: false,
    });
    const proDenied = reserveAiCredits({ userId: 51, plan: 'pro', operationClass: 'deep', replayScope: scope('p', 51), now: NOW });
    expect(proDenied).toEqual({
      kind: 'insufficient_credits',
      requiredCredits: 3,
      availableCredits: 0,
      packCtaEligible: true,
    });
  });

  it('refuses restricted operation classes on free and beta plans regardless of balance', () => {
    // A funded free wallet still cannot buy deep reasoning or scripts (§2
    // availability): the class gate outranks the balance check.
    grantMonthlyAiCredits({ userId: 52, plan: 'free', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    for (const operationClass of ['deep', 'standard_script', 'scheduled_script', 'priority_script'] as const) {
      const denied = reserveAiCredits({
        userId: 52,
        plan: 'free',
        operationClass,
        replayScope: scope(`na-${operationClass}`, 52),
        now: NOW,
      });
      expect(denied).toEqual({ kind: 'operation_not_available', operationClass, plan: 'free' });
    }
    const beta = reserveAiCredits({ userId: 53, plan: 'beta', operationClass: 'deep', replayScope: scope('nb', 53), now: NOW });
    expect(beta).toEqual({ kind: 'operation_not_available', operationClass: 'deep', plan: 'beta' });
    // Standard stays available on free, and paid plans keep every class.
    const freeStandard = reserveAiCredits({ userId: 52, plan: 'free', operationClass: 'standard', replayScope: scope('ns', 52), now: NOW });
    expect(freeStandard.kind).toBe('reserved');
  });

  it('serializes competing reserves so the last credit is spent exactly once', () => {
    grantPromotionalAiCredits({ userId: 40, promotionId: 'one-credit', credits: 1, expiryDays: 30, now: NOW });
    const first = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('r1'), now: NOW });
    const second = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('r2'), now: NOW });
    expect(first.kind).toBe('reserved');
    expect(second).toMatchObject({ kind: 'insufficient_credits', requiredCredits: 1, availableCredits: 0 });
  });

  it('enforces the daily cap and frees it on release', () => {
    grantMonthlyAiCredits({ userId: 40, plan: 'free', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    const reservations = [];
    for (let i = 0; i < 5; i += 1) {
      const result = reserveAiCredits({ userId: 40, plan: 'free', operationClass: 'standard', replayScope: scope(`d${i}`), now: NOW });
      expect(result.kind).toBe('reserved');
      if (result.kind === 'reserved') reservations.push(result.reservation);
    }
    const denied = reserveAiCredits({ userId: 40, plan: 'free', operationClass: 'standard', replayScope: scope('d5'), now: NOW });
    expect(denied).toEqual({
      kind: 'daily_cap_exceeded',
      requiredCredits: 1,
      dailyCapCredits: 5,
      dailyRemainingCredits: 0,
    });

    expect(releaseAiCreditReservation({ reservationId: reservations[0].id, now: NOW }).kind).toBe('released');
    const afterRelease = reserveAiCredits({ userId: 40, plan: 'free', operationClass: 'standard', replayScope: scope('d6'), now: NOW });
    expect(afterRelease.kind).toBe('reserved');
  });

  it('returns the existing reservation for a replayed admission, even after settlement', () => {
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    const first = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('x'), now: NOW });
    expect(first.kind).toBe('reserved');
    if (first.kind !== 'reserved') throw new Error('unreachable');

    const replayReserved = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('x'), now: NOW });
    expect(replayReserved.kind).toBe('replay');
    if (replayReserved.kind !== 'replay') throw new Error('unreachable');
    expect(replayReserved.reservation.id).toBe(first.reservation.id);

    expect(captureAiCreditReservation({ reservationId: first.reservation.id, now: NOW }).kind).toBe('captured');
    const replayCaptured = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('x'), now: NOW });
    expect(replayCaptured.kind).toBe('replay');
    if (replayCaptured.kind !== 'replay') throw new Error('unreachable');
    expect(replayCaptured.reservation.state).toBe('captured');
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get()).toEqual({ count: 1 });
  });

  it('captures in debit order: monthly, nearest-expiry promotional, then purchased FIFO', () => {
    grantPromotionalAiCredits({ userId: 40, promotionId: 'promo-far', credits: 2, expiryDays: 60, now: NOW });
    grantPromotionalAiCredits({ userId: 40, promotionId: 'promo-near', credits: 2, expiryDays: 30, now: NOW });
    grantPurchasedAiCredits({ userId: 40, provider: 'stripe', providerTransactionId: 'pi_first', credits: 1, now: new Date('2026-08-18T09:00:00.000Z') });
    grantPurchasedAiCredits({ userId: 40, provider: 'apple', providerTransactionId: 'txn_second', credits: 4, now: new Date('2026-08-18T10:00:00.000Z') });

    const lots = listAiCreditLots(40);
    const byRef = new Map(lots.map((lot) => [lot.sourceRef, lot.id]));

    const first = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'deep', replayScope: scope('c1'), now: NOW });
    if (first.kind !== 'reserved') throw new Error(`expected reserved, got ${first.kind}`);
    const firstCapture = captureAiCreditReservation({ reservationId: first.reservation.id, now: NOW });
    expect(firstCapture.kind).toBe('captured');
    const firstRows = db
      .prepare('SELECT lot_id, credits FROM ai_credit_captures WHERE reservation_id = ? ORDER BY id')
      .all(first.reservation.id);
    expect(firstRows).toEqual([
      { lot_id: byRef.get('promo-near'), credits: 2 },
      { lot_id: byRef.get('promo-far'), credits: 1 },
    ]);

    const second = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'deep', replayScope: scope('c2'), now: NOW });
    if (second.kind !== 'reserved') throw new Error(`expected reserved, got ${second.kind}`);
    const secondCapture = captureAiCreditReservation({ reservationId: second.reservation.id, now: NOW });
    expect(secondCapture.kind).toBe('captured');
    const secondRows = db
      .prepare('SELECT lot_id, credits FROM ai_credit_captures WHERE reservation_id = ? ORDER BY id')
      .all(second.reservation.id);
    expect(secondRows).toEqual([
      { lot_id: byRef.get('promo-far'), credits: 1 },
      { lot_id: byRef.get('stripe:pi_first'), credits: 1 },
      { lot_id: byRef.get('apple:txn_second'), credits: 1 },
    ]);
  });

  it('settles a reservation exactly once', () => {
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    const result = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('s'), now: NOW });
    if (result.kind !== 'reserved') throw new Error('unreachable');
    expect(captureAiCreditReservation({ reservationId: result.reservation.id, now: NOW }).kind).toBe('captured');
    expect(captureAiCreditReservation({ reservationId: result.reservation.id, now: NOW })).toMatchObject({
      kind: 'invalid_state',
      state: 'captured',
    });
    expect(releaseAiCreditReservation({ reservationId: result.reservation.id, now: NOW })).toMatchObject({
      kind: 'invalid_state',
      state: 'captured',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_captures').get()).toEqual({ count: 1 });
  });

  it('records a capture shortfall instead of corrupting other lots when lots shrink mid-operation', () => {
    const granted = grantPromotionalAiCredits({ userId: 40, promotionId: 'volatile', credits: 3, expiryDays: 30, now: NOW });
    if (granted.kind !== 'granted') throw new Error('unreachable');
    const result = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'deep', replayScope: scope('v'), now: NOW });
    if (result.kind !== 'reserved') throw new Error('unreachable');
    expect(revokeAiCreditLot({ lotId: granted.lot.id, reason: 'dispute', now: NOW }).kind).toBe('revoked');

    const capture = captureAiCreditReservation({ reservationId: result.reservation.id, now: NOW });
    expect(capture).toMatchObject({ kind: 'captured', captureShortfall: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_captures').get()).toEqual({ count: 0 });
  });

  it('revokes only the originating lot and keeps historical captures', () => {
    const revocable = grantPurchasedAiCredits({ userId: 40, provider: 'stripe', providerTransactionId: 'pi_revoke', credits: 5, now: NOW });
    grantPurchasedAiCredits({ userId: 40, provider: 'stripe', providerTransactionId: 'pi_keep', credits: 7, now: NOW });
    if (revocable.kind !== 'granted') throw new Error('unreachable');

    const result = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('k'), now: NOW });
    if (result.kind !== 'reserved') throw new Error('unreachable');
    expect(captureAiCreditReservation({ reservationId: result.reservation.id, now: NOW }).kind).toBe('captured');

    expect(revokeAiCreditLot({ lotId: revocable.lot.id, reason: 'refund', now: NOW }).kind).toBe('revoked');
    expect(revokeAiCreditLot({ lotId: revocable.lot.id, reason: 'refund', now: NOW }).kind).toBe('already_revoked');

    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.purchasedRemaining).toBe(7);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_captures').get()).toEqual({ count: 1 });
  });

  it('excludes expired promotional lots from the wallet and from capture', () => {
    grantPromotionalAiCredits({ userId: 40, promotionId: 'short', credits: 10, expiryDays: 30, now: NOW });
    const later = new Date('2026-09-20T12:00:00.000Z');
    const wallet = getAiCreditWallet(40, 'pro', later);
    expect(wallet.promotionalRemaining).toBe(0);
    expect(wallet.availableCredits).toBe(0);
  });

  it('expires stale reservations through the sweeper and refuses to capture them', () => {
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
    const result = reserveAiCredits({ userId: 40, plan: 'pro', operationClass: 'standard', replayScope: scope('e'), now: NOW });
    if (result.kind !== 'reserved') throw new Error('unreachable');

    const cutoffBefore = new Date('2026-08-18T11:00:00.000Z');
    expect(expireStaleAiCreditReservations({ olderThan: cutoffBefore, now: NOW })).toBe(0);
    const cutoffAfter = new Date('2026-08-18T13:00:00.000Z');
    expect(expireStaleAiCreditReservations({ olderThan: cutoffAfter, now: new Date('2026-08-18T14:00:00.000Z') })).toBe(1);

    expect(captureAiCreditReservation({ reservationId: result.reservation.id, now: NOW })).toMatchObject({
      kind: 'invalid_state',
      state: 'expired',
    });
    expect(getAiCreditWallet(40, 'pro', NOW).reservedCredits).toBe(0);
  });
});
