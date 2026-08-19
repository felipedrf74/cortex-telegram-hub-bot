// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
let hybridCreditsEnabled = false;
let resolvedPlan = 'free';

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
        return { enabled: hybridCreditsEnabled };
      },
    },
  };
});

vi.mock('../../src/services/plan-quotas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/plan-quotas')>();
  return {
    ...actual,
    resolveBillingPlanForUser: vi.fn(() => resolvedPlan),
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
import { getAiCreditWallet, grantMonthlyAiCredits, listAiCreditLots } from '../../src/services/ai-credit-ledger';
import { resolveMonthlyProvisioningPeriod } from '../../src/services/ai-credit-provisioning';
import {
  AiCreditAdmissionDeniedError,
  AiCreditReplaySettledError,
  withAiCreditAdmission,
} from '../../src/services/ai-credit-admission';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');

function admissionInput(id: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: 40,
    tenantScope: 'tenant-40',
    operationClass: 'standard' as const,
    workload: 'ios_websocket_chat',
    clientOperationId: `op-${id}`,
    now: NOW,
    ...overrides,
  };
}

function reservationCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get() as { count: number }).count;
}

describe('ai-credit-admission', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    hybridCreditsEnabled = true;
    resolvedPlan = 'pro';
    // Admission provisions the period's included lot itself (QA5 P1-2), so the
    // manual grant here uses the SAME period key it would derive — otherwise
    // the two lots stack and every balance assertion doubles.
    grantMonthlyAiCredits({
      userId: 40,
      plan: 'pro',
      periodKey: resolveMonthlyProvisioningPeriod(40, NOW).periodKey,
      periodEnd: PERIOD_END,
      now: NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('passes through with no ledger activity while disabled', async () => {
    hybridCreditsEnabled = false;
    const run = vi.fn(async () => 'done');
    await expect(withAiCreditAdmission(admissionInput('off'), run)).resolves.toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
    expect(reservationCount()).toBe(0);
  });

  it('denies before dispatch with the exact amounts when credits are missing', async () => {
    // Plan §2 gives free 60 included credits, so "no credits" means a plan
    // whose allowance is zero — not merely an unprovisioned account.
    resolvedPlan = 'free';
    db.prepare("UPDATE plan_configs SET monthly_ai_credits = 0 WHERE plan_id = 'free'").run();
    const run = vi.fn(async () => 'never');
    await expect(
      withAiCreditAdmission(admissionInput('denied', { userId: 50, tenantScope: 'tenant-50' }), run),
    ).rejects.toMatchObject({
      code: 'AI_CREDITS_DENIED',
      denial: {
        kind: 'insufficient_credits',
        requiredCredits: 1,
        availableCredits: 0,
        packCtaEligible: false,
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(reservationCount()).toBe(0);
  });

  it('reserves, runs, and captures exactly once on success', async () => {
    const result = await withAiCreditAdmission(admissionInput('ok', { operationClass: 'deep' }), async () => 42);
    expect(result).toBe(42);
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(497);
    expect(wallet.reservedCredits).toBe(0);
    expect(wallet.dailyUsedCredits).toBe(3);
    expect(db.prepare("SELECT state FROM ai_credit_reservations").get()).toEqual({ state: 'captured' });
  });

  it('releases the reservation and restores balance when the operation fails', async () => {
    await expect(
      withAiCreditAdmission(admissionInput('boom'), async () => {
        throw new Error('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(500);
    expect(wallet.dailyUsedCredits).toBe(0);
    expect(db.prepare("SELECT state FROM ai_credit_reservations").get()).toEqual({ state: 'released' });
  });

  it('refuses to dispatch a settled replay again', async () => {
    await withAiCreditAdmission(admissionInput('once'), async () => 'first');
    const run = vi.fn(async () => 'second');
    await expect(withAiCreditAdmission(admissionInput('once'), run)).rejects.toBeInstanceOf(
      AiCreditReplaySettledError,
    );
    expect(run).not.toHaveBeenCalled();
    expect(reservationCount()).toBe(1);
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(1);
  });

  it('refuses a concurrent in-flight replay instead of billing one reservation for two runs', async () => {
    // QA P0-1: re-entering run() under an existing reserved reservation let a
    // client reuse one operation id for N provider calls on 1 credit.
    const inner = vi.fn(async () => 'inner');
    await expect(
      withAiCreditAdmission(admissionInput('dup'), async () =>
        withAiCreditAdmission(admissionInput('dup'), inner),
      ),
    ).rejects.toMatchObject({ code: 'AI_CREDIT_OPERATION_IN_FLIGHT' });
    expect(inner).not.toHaveBeenCalled();
    expect(reservationCount()).toBe(1);
    // The outer operation failed, so its reservation released.
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(0);
  });

  it('lets durable jobs continue their own in-flight reservation when they opt in', async () => {
    const result = await withAiCreditAdmission(
      { ...admissionInput('job'), allowInFlightReplay: true },
      async () => withAiCreditAdmission(
        { ...admissionInput('job'), allowInFlightReplay: true },
        async () => 'inner',
      ),
    );
    expect(result).toBe('inner');
    expect(reservationCount()).toBe(1);
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.dailyUsedCredits).toBe(1);
    expect(wallet.availableCredits).toBe(499);
  });

  it('separates two different messages that reuse one client operation id', async () => {
    // The caller supplies a server-computed content hash; distinct content
    // must never collapse into one charge.
    const first = await withAiCreditAdmission(
      { ...admissionInput('shared'), requestHash: 'hash-message-a' },
      async () => 'a',
    );
    const second = await withAiCreditAdmission(
      { ...admissionInput('shared'), requestHash: 'hash-message-b' },
      async () => 'b',
    );
    expect([first, second]).toEqual(['a', 'b']);
    expect(reservationCount()).toBe(2);
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(2);
  });

  it('provisions the included monthly lot on first admission (QA5 P1-2)', async () => {
    // A paid user with no pre-existing lot must be admitted, not denied:
    // nothing else in the runtime mints included credits.
    resolvedPlan = 'max';
    expect(listAiCreditLots(60)).toHaveLength(0);
    await expect(
      withAiCreditAdmission(admissionInput('provision', { userId: 60, tenantScope: 'tenant-60' }), async () => 'ran'),
    ).resolves.toBe('ran');
    const lots = listAiCreditLots(60);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ lotType: 'monthly', creditsGranted: 1200 });
    expect(getAiCreditWallet(60, 'max', NOW).availableCredits).toBe(1199);

    // Idempotent: a second operation reuses the same lot, never mints another.
    await withAiCreditAdmission(admissionInput('provision-2', { userId: 60, tenantScope: 'tenant-60' }), async () => 'again');
    expect(listAiCreditLots(60)).toHaveLength(1);
    expect(getAiCreditWallet(60, 'max', NOW).availableCredits).toBe(1198);
  });

  it('exposes typed denial classes for callers', async () => {
    resolvedPlan = 'free';
    db.prepare("UPDATE plan_configs SET monthly_ai_credits = 0 WHERE plan_id = 'free'").run();
    try {
      await withAiCreditAdmission(admissionInput('typed', { userId: 51, tenantScope: 'tenant-51' }), async () => 'x');
      throw new Error('expected denial');
    } catch (error) {
      expect(error).toBeInstanceOf(AiCreditAdmissionDeniedError);
    }
  });

  it('renders a distinct denial message for every denial kind', () => {
    expect(new AiCreditAdmissionDeniedError({
      kind: 'insufficient_credits', requiredCredits: 3, availableCredits: 1, packCtaEligible: true,
    }).message).toBe('Insufficient AI credits: required 3, available 1');
    expect(new AiCreditAdmissionDeniedError({
      kind: 'daily_cap_exceeded', requiredCredits: 1, dailyCapCredits: 5, dailyRemainingCredits: 0,
    }).message).toBe('Daily AI credit cap reached: required 1, remaining 0');
    expect(new AiCreditAdmissionDeniedError({
      kind: 'operation_not_available', operationClass: 'deep', plan: 'free',
    }).message).toBe('Operation class deep is not available on the free plan');
  });
});
