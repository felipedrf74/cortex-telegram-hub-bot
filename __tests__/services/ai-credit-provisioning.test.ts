// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA6 P1 regression suite: included-credit provisioning across period-anchor
 * TRANSITIONS. The prior tests asserted anchor *selection* in isolation, which
 * is why three double-grant paths survived review — every one of them lives in
 * the move from one anchor to another.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => db, initDatabase: vi.fn(), closeDatabase: vi.fn() };
});

const subscriptionStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/stripe-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stripe-service')>();
  return { ...actual, getSubscriptionStatus: subscriptionStatusMock };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  ensureMonthlyAiCreditsForUser,
  resolveMonthlyProvisioningPeriod,
} from '../../src/services/ai-credit-provisioning';
import { getAiCreditWallet, listAiCreditLots } from '../../src/services/ai-credit-ledger';

const USER = 77;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    plan: 'pro',
    period: 'monthly',
    status: 'active',
    provider: 'stripe',
    currentPeriodStart: '2026-08-01T00:00:00.000Z',
    currentPeriodEnd: '2026-08-31T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    isActive: true,
    isPro: true,
    ...overrides,
  };
}

/** Live = counted by the wallet: active status AND not past its expiry. */
function liveLots(userId: number, at: Date) {
  return listAiCreditLots(userId).filter((lot) => (
    lot.status === 'active'
    && (!lot.expiresAt || Date.parse(lot.expiresAt) > at.getTime())
  ));
}

beforeEach(() => {
  db = createMigratedTestDatabase();
  subscriptionStatusMock.mockReset();
  subscriptionStatusMock.mockReturnValue(subscription());
});

afterEach(() => {
  db.close();
});

describe('included credit provisioning — anchor transitions (QA6 P1)', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');

  it('path A: a transient subscription read failure grants nothing instead of re-anchoring', () => {
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({ kind: 'granted' });
    expect(getAiCreditWallet(USER, 'pro', now).availableCredits).toBe(500);

    // The read that fails must not mint a second lot under the calendar anchor.
    subscriptionStatusMock.mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({
      kind: 'failed',
      reason: 'subscription_period_unavailable',
    });

    expect(getAiCreditWallet(USER, 'pro', now).availableCredits).toBe(500);
    expect(liveLots(USER, now)).toHaveLength(1);
  });

  it('path B: a late renewal supersedes the calendar stopgap instead of stacking on it', () => {
    // Period lapsed and the renewal webhook has not landed: calendar stopgap.
    subscriptionStatusMock.mockReturnValue(subscription({
      currentPeriodStart: '2026-07-01T00:00:00.000Z',
      currentPeriodEnd: '2026-08-05T00:00:00.000Z',
    }));
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({ kind: 'granted' });
    expect(listAiCreditLots(USER)[0].sourceRef).toBe('cal:2026-08');

    // Renewal webhook lands: the real period must REPLACE the stopgap.
    subscriptionStatusMock.mockReturnValue(subscription({
      currentPeriodStart: '2026-08-05T00:00:00.000Z',
      currentPeriodEnd: '2026-09-05T00:00:00.000Z',
    }));
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({ kind: 'granted' });

    expect(getAiCreditWallet(USER, 'pro', now).availableCredits).toBe(500);
    const live = liveLots(USER, now);
    expect(live).toHaveLength(1);
    expect(live[0].sourceRef).toBe('sub:2026-08-05T00:00:00.000Z');
    const superseded = listAiCreditLots(USER).find((lot) => lot.sourceRef === 'cal:2026-08');
    expect(superseded?.status).toBe('revoked');
  });

  it('path C: a mid-period upgrade that moves the period end mints nothing extra', () => {
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({ kind: 'granted' });

    // Upgrade re-prices the subscription and moves the END; the START is the
    // stable identity, so this is the same paid period.
    subscriptionStatusMock.mockReturnValue(subscription({
      plan: 'max',
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-10T00:00:00.000Z',
    }));
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'max', now })).toEqual({ kind: 'already_granted' });

    expect(liveLots(USER, now)).toHaveLength(1);
    expect(getAiCreditWallet(USER, 'max', now).availableCredits).toBe(500);
  });

  it('plan cycling cannot mint: repeated upgrade/downgrade stays at one allowance', () => {
    for (const plan of ['pro', 'max', 'pro', 'max'] as const) {
      subscriptionStatusMock.mockReturnValue(subscription({ plan }));
      ensureMonthlyAiCreditsForUser({ userId: USER, plan, now });
    }
    expect(liveLots(USER, now)).toHaveLength(1);
    expect(getAiCreditWallet(USER, 'max', now).availableCredits).toBe(500);
  });

  it('a genuinely new billing period grants a fresh full allowance', () => {
    ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now });
    subscriptionStatusMock.mockReturnValue(subscription({
      currentPeriodStart: '2026-09-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-30T00:00:00.000Z',
    }));
    const later = new Date('2026-09-02T12:00:00.000Z');
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now: later })).toEqual({ kind: 'granted' });

    // The August lot expired on its own before this grant, so supersession had
    // nothing live to revoke — exactly one lot is spendable at `later`.
    expect(liveLots(USER, later)).toHaveLength(1);
    expect(getAiCreditWallet(USER, 'pro', later).availableCredits).toBe(500);
  });

  it('repeated calls inside one period are idempotent', () => {
    ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now });
    for (let i = 0; i < 5; i += 1) {
      expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'pro', now })).toEqual({ kind: 'already_granted' });
    }
    expect(liveLots(USER, now)).toHaveLength(1);
    expect(getAiCreditWallet(USER, 'pro', now).availableCredits).toBe(500);
  });

  it('free plans provision their own §2 allowance, once', () => {
    // Free is 60 credits / 5 per day (plan §2, migration 285) — a real
    // allowance, not zero, and it obeys the same one-lot-per-period rule.
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'free', now })).toEqual({ kind: 'granted' });
    expect(ensureMonthlyAiCreditsForUser({ userId: USER, plan: 'free', now })).toEqual({ kind: 'already_granted' });
    expect(liveLots(USER, now)).toHaveLength(1);
    expect(getAiCreditWallet(USER, 'free', now).availableCredits).toBe(60);
  });
});

describe('period resolution (QA6 P1)', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');

  it('anchors on the period start when one is recorded', () => {
    const resolution = resolveMonthlyProvisioningPeriod(USER, now);
    expect(resolution).toEqual({
      kind: 'resolved',
      period: { periodKey: 'sub:2026-08-01T00:00:00.000Z', periodEnd: new Date('2026-08-31T00:00:00.000Z') },
    });
  });

  it('falls back to the period end for records written before the start was captured', () => {
    subscriptionStatusMock.mockReturnValue(subscription({ currentPeriodStart: null }));
    const resolution = resolveMonthlyProvisioningPeriod(USER, now);
    expect(resolution).toEqual({
      kind: 'resolved',
      period: { periodKey: 'sub:2026-08-31T00:00:00.000Z', periodEnd: new Date('2026-08-31T00:00:00.000Z') },
    });
  });

  it('uses the calendar month when no live billing period exists', () => {
    subscriptionStatusMock.mockReturnValue(subscription({
      currentPeriodStart: null,
      currentPeriodEnd: null,
    }));
    const resolution = resolveMonthlyProvisioningPeriod(USER, now);
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') throw new Error('unreachable');
    expect(resolution.period.periodKey).toBe('cal:2026-08');
  });

  it('reports unavailable — never a different anchor — when the read throws', () => {
    subscriptionStatusMock.mockImplementation(() => { throw new Error('db down'); });
    expect(resolveMonthlyProvisioningPeriod(USER, now)).toEqual({ kind: 'unavailable' });
  });
});
