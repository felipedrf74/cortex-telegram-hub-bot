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

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { getAiCreditWallet, grantMonthlyAiCredits, grantPromotionalAiCredits } from '../../src/services/ai-credit-ledger';
import {
  captureContentScriptJobCreditsForCompletion,
  ContentScriptJobCreditSettlementError,
  releaseContentScriptJobCreditsForTerminal,
  reserveContentScriptJobCredits,
} from '../../src/services/content-script-job-credits';
import { cancelContentScriptJobsForAccountDeletion } from '../../src/services/content-script-job-account-lifecycle';

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

describe('content-script-job-credits', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    hybridCreditsEnabled = true;
    grantMonthlyAiCredits({ userId: 40, plan: 'pro', periodKey: '2026-08', periodEnd: PERIOD_END, now: NOW });
  });

  afterEach(() => {
    db.close();
  });

  it('is inert while credits admission is disabled', () => {
    hybridCreditsEnabled = false;
    expect(reserve()).toEqual({ kind: 'disabled' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get()).toEqual({ count: 0 });
  });

  it('charges a long-form job the script class and a short job a standard operation', () => {
    const longForm = reserve();
    expect(longForm).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'standard_script', credits: 10 } });
    const short = reserve({ jobId: 'script_job_short', longForm: false });
    expect(short).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'standard', credits: 1 } });
  });

  it('keeps admission reads and reservation writes on the caller database', () => {
    const isolated = createMigratedTestDatabase();
    try {
      isolated.prepare(`INSERT INTO ai_credit_lots (
        user_id, lot_type, credits_granted, granted_at, expires_at,
        source_kind, source_ref, status
      ) VALUES (?, 'monthly', 500, ?, ?, 'subscription_period', ?, 'active')`)
        .run(91, NOW.toISOString(), PERIOD_END.toISOString(), '2026-08-isolated');

      const result = reserveContentScriptJobCredits({
        tenantId: 91,
        userId: 91,
        jobId: 'script_job_isolated',
        plan: 'pro',
        longForm: true,
        now: NOW,
      }, isolated);

      expect(result).toMatchObject({
        kind: 'reserved',
        reservation: { userId: 91, operationClass: 'standard_script', credits: 10 },
      });
      expect(isolated.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations').get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_reservations WHERE user_id = 91').get())
        .toEqual({ count: 0 });
    } finally {
      isolated.close();
    }
  });

  it('prices delivery modes per plan §2: scheduled 10, priority 12', () => {
    const scheduled = reserve({ jobId: 'script_job_sched', deliveryMode: 'scheduled' });
    expect(scheduled).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'scheduled_script', credits: 10 } });
    const priority = reserve({ jobId: 'script_job_prio', deliveryMode: 'priority' });
    expect(priority).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'priority_script', credits: 12 } });
    // QA P1-7: a short job that BUYS priority pays for priority. Otherwise a
    // 1-credit job would sort ahead of every long-form standard job.
    const short = reserve({ jobId: 'script_job_short_prio', longForm: false, deliveryMode: 'priority' });
    expect(short).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'priority_script', credits: 12 } });
    // Only plain standard short jobs remain standard operations.
    const plainShort = reserve({ jobId: 'script_job_short_std', longForm: false });
    expect(plainShort).toMatchObject({ kind: 'reserved', reservation: { operationClass: 'standard', credits: 1 } });
  });

  it('captures once on completion; repeated settlement is idempotent', () => {
    reserve();
    expect(captureContentScriptJobCreditsForCompletion({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('captured');
    expect(captureContentScriptJobCreditsForCompletion({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('already_captured');
    expect(releaseContentScriptJobCreditsForTerminal({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('already_settled');
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(490);
    expect(wallet.reservedCredits).toBe(0);
    expect(wallet.dailyUsedCredits).toBe(10);
  });

  it('strict completion capture rejects a reservation that can no longer settle', () => {
    reserve();
    db.prepare(`
      UPDATE ai_credit_reservations
         SET state = 'expired', settled_at = ?
       WHERE state = 'reserved'
    `).run(NOW.toISOString());

    expect(() => captureContentScriptJobCreditsForCompletion({
      tenantId: 40,
      userId: 40,
      jobId: JOB,
      now: NOW,
    })).toThrowError(expect.objectContaining<Partial<ContentScriptJobCreditSettlementError>>({
      code: 'CONTENT_SCRIPT_CREDIT_SETTLEMENT_FAILED',
      settlementState: 'expired',
    }));
  });

  it('releases on failure and restores the balance', () => {
    reserve();
    expect(releaseContentScriptJobCreditsForTerminal({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('released');
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.availableCredits).toBe(500);
    expect(wallet.dailyUsedCredits).toBe(0);
  });

  it('rolls a terminal job transition back when its credit release cannot commit', () => {
    reserve();
    db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
      operation_id, request_json, target_duration_seconds, status, stage,
      progress_percent, model_digest
    ) VALUES (?, 40, 40, 'pro', 'idem-release-failure', ?,
              'op-release-failure', '{}', 900, 'queued', 'queued', 0, ?)`)
      .run(JOB, 'a'.repeat(64), `sha256:${'b'.repeat(64)}`);
    db.exec(`CREATE TRIGGER reject_test_script_credit_release
      BEFORE UPDATE OF state ON ai_credit_reservations
      WHEN OLD.state = 'reserved' AND NEW.state = 'released'
      BEGIN
        SELECT RAISE(ABORT, 'simulated script credit release failure');
      END`);

    expect(() => cancelContentScriptJobsForAccountDeletion(40))
      .toThrowError(expect.objectContaining<Partial<ContentScriptJobCreditSettlementError>>({
        code: 'CONTENT_SCRIPT_CREDIT_SETTLEMENT_FAILED',
        settlementState: 'release_error',
      }));
    expect(db.prepare('SELECT status FROM content_script_jobs WHERE job_id = ?').get(JOB))
      .toEqual({ status: 'queued' });
    expect(db.prepare('SELECT state FROM ai_credit_reservations').get())
      .toEqual({ state: 'reserved' });
  });

  it('strict terminal release is idempotent after the reservation settles', () => {
    reserve();
    expect(releaseContentScriptJobCreditsForTerminal({
      tenantId: 40,
      userId: 40,
      jobId: JOB,
      now: NOW,
    }, db)).toBe('released');
    expect(releaseContentScriptJobCreditsForTerminal({
      tenantId: 40,
      userId: 40,
      jobId: JOB,
      now: NOW,
    }, db)).toBe('already_settled');
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
    expect(releaseContentScriptJobCreditsForTerminal({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('released');
    const retried = reserve();
    expect(retried).toMatchObject({ kind: 'reserved' });
    if (retried.kind !== 'reserved') throw new Error('unreachable');
    expect(retried.reservation.clientOperationId).toBe(`${JOB}#a2`);
    expect(captureContentScriptJobCreditsForCompletion({
      tenantId: 40, userId: 40, jobId: JOB, now: NOW,
    }, db)).toBe('captured');
    // One capture across two attempts: the user paid for exactly one script.
    expect(getAiCreditWallet(40, 'pro', NOW).dailyUsedCredits).toBe(10);
  });

  it('denies script classes outright on the free plan (§2 availability)', () => {
    const denied = reserve({ userId: 60, plan: 'free', jobId: 'script_job_free' });
    expect(denied).toEqual({
      kind: 'denied',
      code: 'AI_OPERATION_NOT_AVAILABLE',
      message: 'Script generation is not available on the free plan.',
      statusCode: 403,
    });
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

  it('account-deletion cancellation releases held job reservations', () => {
    reserve();
    db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
      operation_id, request_json, target_duration_seconds, status, stage,
      progress_percent, model_digest
    ) VALUES (?, 40, 40, 'pro', 'idem-lifecycle', ?,
              'op-lifecycle', '{}', 900, 'queued', 'queued', 0, ?)`)
      .run(JOB, 'a'.repeat(64), `sha256:${'b'.repeat(64)}`);

    expect(cancelContentScriptJobsForAccountDeletion(40)).toBe(1);

    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.reservedCredits).toBe(0);
    expect(wallet.availableCredits).toBe(500);
    expect(db.prepare("SELECT state FROM ai_credit_reservations").get()).toEqual({ state: 'released' });
  });

});
