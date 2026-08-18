// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
let hybridCreditsEnabled = true;

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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { applyMigrationFileForTest, runMigrationsForTest } from '../../src/services/database';
import { getAiCreditWallet, grantMonthlyAiCredits, grantPromotionalAiCredits } from '../../src/services/ai-credit-ledger';
import {
  reserveContentScriptJobCredits,
  settleContentScriptJobCredits,
} from '../../src/services/content-script-job-credits';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');
const JOB = 'script_job_test-1';

function reserve(overrides: Record<string, unknown> = {}) {
  return reserveContentScriptJobCredits({
    tenantId: 40,
    userId: 40,
    jobId: JOB,
    plan: 'pro',
    longForm: true,
    now: NOW,
    ...overrides,
  } as Parameters<typeof reserveContentScriptJobCredits>[0]);
}

function settle(outcome: 'captured' | 'released', overrides: Record<string, unknown> = {}) {
  return settleContentScriptJobCredits({
    tenantId: 40,
    userId: 40,
    jobId: JOB,
    outcome,
    now: NOW,
    ...overrides,
  } as Parameters<typeof settleContentScriptJobCredits>[0]);
}

describe('content-script-job-credits', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrationsForTest(db);
    applyMigrationFileForTest(db, '285_ai_credit_ledger_foundation.sql');
    hybridCreditsEnabled = true;
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
  });

  afterEach(() => {
    db.close();
  });

  it('is inert while credits admission is disabled', () => {
    hybridCreditsEnabled = false;
    expect(reserve()).toEqual({ kind: 'disabled' });
    expect(settle('captured')).toEqual({ kind: 'no_reservation' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get()).toEqual({ count: 0 });
  });

  it('charges a long-form job the script class and a short job a standard operation', () => {
    const longForm = reserve();
    expect(longForm).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'standard_script', credits: 10 } });
    const short = reserve({ jobId: 'script_job_short', longForm: false });
    expect(short).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'standard', credits: 1 } });
  });

  it('captures once on completion; repeated settlement is idempotent', () => {
    reserve();
    expect(settle('captured')).toEqual({ kind: 'captured' });
    expect(settle('captured')).toEqual({ kind: 'already_settled' });
    expect(settle('released')).toEqual({ kind: 'already_settled' });
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(490);
    expect(wallet.reservedCredits).toBe(0);
    expect(wallet.dailyUsedCredits).toBe(10);
  });

  it('releases on failure and restores the balance', () => {
    reserve();
    expect(settle('released')).toEqual({ kind: 'released' });
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(500);
    expect(wallet.dailyUsedCredits).toBe(0);
  });

  it('re-entering admission for an in-flight job continues under the open reservation', () => {
    const first = reserve();
    const again = reserve();
    if (first.kind !== 'reserved' || again.kind !== 'reserved') throw new Error('unreachable');
    expect(again.reservation.id).toBe(first.reservation.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get()).toEqual({ count: 1 });
  });

  it('a retry after release reserves a fresh attempt under the same job identity', () => {
    reserve();
    settle('released');
    const retried = reserve();
    expect(retried).toMatchObject({ kind: 'reserved' });
    if (retried.kind !== 'reserved') throw new Error('unreachable');
    expect(retried.reservation.clientOperationId).toBe(`${JOB}#a2`);
    expect(settle('captured')).toEqual({ kind: 'captured' });
    // One capture across two attempts: the user paid for exactly one script.
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(10);
  });

  it('denies with exact amounts and does not admit', () => {
    const denied = reserveContentScriptJobCredits({
      tenantId: 50, userId: 50, jobId: 'script_job_poor', plan: 'pro', longForm: true, now: NOW,
    });
    expect(denied).toMatchObject({ kind: 'denied', code: 'INSUFFICIENT_AI_CREDITS', statusCode: 402 });
    if (denied.kind !== 'denied') throw new Error('unreachable');
    expect(denied.message).toContain('10 AI credits');
    expect(denied.message).toContain('0 are available');

    grantPromotionalAiCredits({ userId: 51, promotionId: 'small', credits: 100, expiryDays: 30, now: NOW });
    db.prepare("UPDATE plan_configs SET daily_ai_credit_cap = 5 WHERE plan_id = 'pro'").run();
    const capped = reserveContentScriptJobCredits({
      tenantId: 51, userId: 51, jobId: 'script_job_capped', plan: 'pro', longForm: true, now: NOW,
    });
    expect(capped).toMatchObject({ kind: 'denied', code: 'AI_CREDIT_DAILY_CAP', statusCode: 429 });
  });

  it('never breaks the job transition when settlement faults', () => {
    reserve();
    const broken = settleContentScriptJobCredits({
      tenantId: NaN as unknown as number, userId: NaN as unknown as number, jobId: JOB, outcome: 'captured', now: NOW,
    });
    expect(['no_reservation', 'error']).toContain(broken.kind);
  });
});
