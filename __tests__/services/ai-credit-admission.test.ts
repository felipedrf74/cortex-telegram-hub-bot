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

vi.mock('../../src/services/plan-quotas', () => ({
  resolveBillingPlanForUser: vi.fn(() => resolvedPlan),
}));

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
import { getAiCreditWallet, grantMonthlyAiCredits } from '../../src/services/ai-credit-ledger';
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
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
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
    resolvedPlan = 'free';
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

  it('continues an in-flight replay under the same reservation and settles once', async () => {
    const result = await withAiCreditAdmission(admissionInput('retry'), async () =>
      withAiCreditAdmission(admissionInput('retry'), async () => 'inner'),
    );
    expect(result).toBe('inner');
    expect(reservationCount()).toBe(1);
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.dailyUsedCredits).toBe(1);
    expect(wallet.availableCredits).toBe(499);
  });

  it('exposes typed denial classes for callers', async () => {
    resolvedPlan = 'free';
    try {
      await withAiCreditAdmission(admissionInput('typed', { userId: 51, tenantScope: 'tenant-51' }), async () => 'x');
      throw new Error('expected denial');
    } catch (error) {
      expect(error).toBeInstanceOf(AiCreditAdmissionDeniedError);
    }
  });
});
