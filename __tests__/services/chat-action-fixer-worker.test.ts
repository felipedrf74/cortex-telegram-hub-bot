import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const aiMocks = vi.hoisted(() => ({
  eligibility: {
    allowed: true,
    reason: 'eligible',
    entitlement: { source: 'stripe' },
  } as any,
  recordSkip: vi.fn(),
  trackedCreate: vi.fn(),
  withAiBudgetReservation: vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/services/ai-automation-policy', () => ({
  resolveAiAutomationEligibility: vi.fn(() => aiMocks.eligibility),
  recordAiAutomationEligibilitySkip: (...args: unknown[]) => aiMocks.recordSkip(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {},
  withAiBudgetReservation: (...args: unknown[]) => aiMocks.withAiBudgetReservation(...args),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => aiMocks.trackedCreate(...args),
}));

vi.mock('../../src/services/anthropic-lazy-client', () => ({
  createLazyAnthropicClient: vi.fn(() => ({ get: () => ({}) })),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
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

import { ensureBackgroundJobTables } from '../../src/services/background-job-queue';
import {
  CHAT_ACTION_FIXER_JOB_TYPE,
  callAnthropicChatActionFixer,
  enqueueChatActionFixerReview,
  processChatActionFixerJobs,
  runScheduledChatActionFixerJobs,
} from '../../src/services/chat-action-fixer-worker';
import {
  classifyChatActionRetry,
  runChatActionWithBoundedRetry,
} from '../../src/services/chat-action-retry-policy';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';
import { ensureDecisionCenterTables, getDecisionItem, getDecisionOverview, performDecisionAction } from '../../src/services/decision-center';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep, ChatStepExecutionResult } from '../../src/services/chat/types';

const step: ChatPlanStep = {
  stepId: 'step_1',
  skill: 'secretary',
  type: 'schedule_event',
  action: 'schedule_event',
  risk: 'safe_write',
  riskClass: 'R1',
  provider: 'google_calendar',
  args: {
    title: 'Client review',
    startDateTime: '2026-05-24T15:00:00.000+01:00',
    endDateTime: '2026-05-24T15:30:00.000+01:00',
  },
  requiredArgsPresent: true,
  idempotencyKey: 'schedule-event-client-review',
  verification: { required: true, method: 'provider_read_back', expectedFields: { title: 'Client review' } },
};

const input: ChatPlannerInput = {
  userId: 9050,
  tenantId: 850,
  conversationId: 'conv-fixer',
  messageId: 'msg-fixer',
  text: 'Schedule Client review tomorrow at 15:00 with felipe@example.com and token sk-test-secret-secret.',
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
  channel: 'ios',
  nowIso: '2026-05-23T10:00:00.000Z',
  persistRuns: true,
};

const plan: ChatActionPlan = {
  schemaVersion: 1,
  userId: '9050',
  tenantId: '850',
  conversationId: 'conv-fixer',
  messageId: 'msg-fixer',
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
  channel: 'ios',
  createdAt: '2026-05-23T10:00:00.000Z',
  planner: 'deterministic',
  steps: [step],
  requiresConfirmation: false,
  confidence: 0.93,
  effectiveConfidence: 0.93,
};

describe('chat action retry policy and fixer worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T10:00:00.000Z'));
    testDb = createMigratedTestDatabase();
    testDb.prepare(
      "INSERT INTO users (id, telegram_id, tier, status) VALUES (?, ?, 'pro', 'active')",
    ).run(input.userId, 9_009_050);
    process.env.NODE_ENV = 'test';
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureBackgroundJobTables(testDb);
    ensureNotificationTables();
    ensureDecisionCenterTables();
    aiMocks.eligibility = {
      allowed: true,
      reason: 'eligible',
      entitlement: { source: 'stripe' },
    };
    aiMocks.recordSkip.mockReset();
    aiMocks.trackedCreate.mockReset();
    aiMocks.trackedCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ proposed_step: null, reasoning: 'No safe correction.' }),
      }],
    });
    aiMocks.withAiBudgetReservation.mockReset();
    aiMocks.withAiBudgetReservation.mockImplementation(async (_request: unknown, fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('retries one bounded attempt for transient executor failures only', async () => {
    let transientAttempts = 0;
    const success = await runChatActionWithBoundedRetry(async (): Promise<ChatStepExecutionResult> => {
      transientAttempts += 1;
      if (transientAttempts === 1) return { step, status: 'failed', error: 'SQLITE_BUSY' };
      return { step, status: 'verified_success', result: { retried: true } };
    }, { retryDelayMs: 0 });

    expect(transientAttempts).toBe(2);
    expect(success.status).toBe('verified_success');
    expect(classifyChatActionRetry('upstream 503').retryable).toBe(true);
    expect(classifyChatActionRetry('provider_read_back_failed').retryable).toBe(true);

    let authAttempts = 0;
    const authFailure = await runChatActionWithBoundedRetry(async (): Promise<ChatStepExecutionResult> => {
      authAttempts += 1;
      return { step, status: 'failed', error: 'auth_token_expired' };
    }, { retryDelayMs: 0 });

    expect(authAttempts).toBe(1);
    expect(authFailure.status).toBe('failed');
    expect(classifyChatActionRetry('HTTP 404').retryable).toBe(false);
  });

  it('enqueues sanitized fixer review jobs for verifier mismatches', () => {
    const job = enqueueChatActionFixerReview({
      input,
      plan,
      step,
      result: { step, status: 'partial_success', error: 'verifier_mismatch', result: { providerReadBack: { title: 'Wrong event' } } },
    }, testDb);

    expect(job.jobType).toBe(CHAT_ACTION_FIXER_JOB_TYPE);
    expect(job.payload.redactedText).toContain('[email]');
    expect(String(job.payload.redactedText)).not.toContain('felipe@example.com');
    expect(String(job.payload.redactedText)).not.toContain('sk-test-secret-secret');
    expect(job.payload.originalStep).toMatchObject({ skill: 'secretary', action: 'schedule_event' });
  });

  it('creates a Decision Center correction that never executes provider writes automatically', async () => {
    enqueueChatActionFixerReview({
      input,
      plan,
      step,
      result: { step, status: 'partial_success', error: 'unexpected_provider_response', result: { providerReadBack: { title: 'Client review', start: '2026-05-24T16:00:00.000+01:00' } } },
    }, testDb);

    const processed = await processChatActionFixerJobs({
      db: testDb,
      proposeCorrection: () => ({
        proposed_step: {
          ...step,
          args: {
            ...step.args,
            startDateTime: '2026-05-24T16:00:00.000+01:00',
            endDateTime: '2026-05-24T16:30:00.000+01:00',
          },
        },
        reasoning: 'Provider read-back showed the event at 16:00, so the safer correction updates the proposed time.',
      }),
    });

    expect(processed.completed).toBe(1);
    const overview = getDecisionOverview(9050, 850);
    const fixerItem = overview.items.find((item) => item.relatedEntities.some((entity) => entity.type === CHAT_ACTION_FIXER_JOB_TYPE));
    expect(fixerItem).toBeTruthy();
    expect(fixerItem?.actions.some((action) => action.id === 'accept_chat_action_fix')).toBe(true);
    expect(fixerItem?.deeplink).toMatch(/^nexus:\/\/decision-center\//);
    expect(fixerItem?.explanation?.userAction).toMatch(/Review|Accept|correction/i);

    const actionResult = await performDecisionAction(fixerItem!.itemId, 'accept_chat_action_fix', 9050, 850, {
      idempotencyKey: 'accept-fixer-correction',
    });
    expect(actionResult.status).toBe('succeeded');

    const after = getDecisionItem(fixerItem!.itemId, 9050, 850);
    expect(after?.status).toBe('actioned');
    const row = testDb.prepare('SELECT action_result_json FROM notification_center_items WHERE item_id = ?').get(fixerItem!.itemId) as { action_result_json: string };
    expect(JSON.parse(row.action_result_json)).toMatchObject({
      providerActionExecuted: false,
      freshConfirmationRequired: true,
    });
  });

  it('makes zero additional model calls when an unchanged completed fixer input is enqueued again', async () => {
    const review = {
      input,
      plan,
      step,
      result: {
        step,
        status: 'partial_success' as const,
        error: 'verifier_mismatch',
        result: { providerReadBack: { title: 'Wrong event' } },
      },
    };
    const first = enqueueChatActionFixerReview(review, testDb);
    const proposeCorrection = vi.fn(() => ({
      proposed_step: null,
      reasoning: 'No safe correction is available.',
    }));

    expect(await processChatActionFixerJobs({ db: testDb, proposeCorrection })).toMatchObject({ completed: 1 });
    const replay = enqueueChatActionFixerReview(review, testDb);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.status).toBe('completed');
    expect(await processChatActionFixerJobs({ db: testDb, proposeCorrection })).toMatchObject({ completed: 0 });
    expect(proposeCorrection).toHaveBeenCalledTimes(1);
  });

  it('binds a scheduled durable queue attempt to one tenant/user run and never replays completed input', async () => {
    const review = {
      input,
      plan,
      step,
      result: {
        step,
        status: 'partial_success' as const,
        error: 'scheduled_verifier_mismatch',
        result: { providerReadBack: { title: 'Wrong event' } },
      },
    };
    enqueueChatActionFixerReview(review, testDb);
    aiMocks.withAiBudgetReservation.mockImplementation(async (request: any, fn: () => Promise<unknown>) => {
      const result = await fn();
      testDb.prepare(`
        INSERT INTO api_usage (
          category, model, tenant_id, user_id, cost_usd, provider,
          request_source, job_name, base_category, run_id
        ) VALUES ('chat_action_fixer', 'test-model', ?, ?, 0.01, 'anthropic',
                  'automation', 'chat_action_fixer', 'chat_action_fixer', ?)
      `).run(input.tenantId, input.userId, request.runId);
      return result;
    });

    const first = await runScheduledChatActionFixerJobs({ db: testDb, limit: 5 });
    const second = await runScheduledChatActionFixerJobs({ db: testDb, limit: 5 });

    expect(first).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
    expect(second).toMatchObject({ completed: 0, failed: 0, deadLetter: 0 });
    expect(aiMocks.trackedCreate).toHaveBeenCalledTimes(1);
    expect(aiMocks.withAiBudgetReservation).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.any(String) }),
      expect.any(Function),
    );
    expect(testDb.prepare(`
      SELECT status, tenant_id, user_id, provider_calls, cost_usd
        FROM agent_job_runs
       WHERE job_id = 'chat_action_fixer_worker'
    `).all()).toEqual([{
      status: 'success',
      tenant_id: input.tenantId,
      user_id: input.userId,
      provider_calls: 1,
      cost_usd: 0.01,
    }]);
  });

  it('keeps durable queue retry semantics while auditing a scheduled provider failure', async () => {
    enqueueChatActionFixerReview({
      input: { ...input, messageId: 'msg-scheduled-provider-failure' },
      plan: { ...plan, messageId: 'msg-scheduled-provider-failure' },
      step,
      result: { step, status: 'failed', error: 'scheduled_provider_failure' },
    }, testDb);
    aiMocks.trackedCreate.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await runScheduledChatActionFixerJobs({ db: testDb, limit: 1 });

    expect(result).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
    expect(testDb.prepare(`
      SELECT status, provider_calls, error_code
        FROM agent_job_runs
       WHERE job_id = 'chat_action_fixer_worker'
    `).get()).toEqual({
      status: 'failed',
      provider_calls: 0,
      error_code: 'ChatActionFixerQueueFailure',
    });
    expect(testDb.prepare(`
      SELECT status, attempts FROM background_jobs
       WHERE job_type = ?
    `).get(CHAT_ACTION_FIXER_JOB_TYPE)).toEqual({ status: 'failed', attempts: 1 });
  });

  it('refuses high-risk fixer proposals instead of creating executable Decision Center actions', async () => {
    enqueueChatActionFixerReview({
      input,
      plan,
      step: { ...step, risk: 'destructive', riskClass: 'R3' },
      result: { step: { ...step, risk: 'destructive', riskClass: 'R3' }, status: 'failed', error: 'verifier_mismatch' },
    }, testDb);

    const processed = await processChatActionFixerJobs({
      db: testDb,
      proposeCorrection: () => ({
        proposed_step: { ...step, risk: 'destructive', riskClass: 'R3' },
        reasoning: 'Would retry a destructive write.',
      }),
    });

    expect(processed.completed).toBe(1);
    expect(getDecisionOverview(9050, 850).items).toHaveLength(0);
  });

  it('skips ineligible background fixer work before prompt/provider use', async () => {
    aiMocks.eligibility = {
      allowed: false,
      reason: 'automation_entitlement_required',
      entitlement: { source: 'free' },
    };

    const result = await callAnthropicChatActionFixer({
      ...buildPayloadForDirectCall(),
      sourceSkill: 'secretary',
    });

    expect(result.proposed_step).toBeNull();
    expect(aiMocks.recordSkip).toHaveBeenCalled();
    expect(aiMocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(aiMocks.trackedCreate).not.toHaveBeenCalled();
  });

  it('attributes eligible background fixer work to the automation budget without Points', async () => {
    await callAnthropicChatActionFixer(buildPayloadForDirectCall());

    expect(aiMocks.withAiBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9050,
      requestSource: 'automation',
      baseCategory: 'chat_action_fixer',
      jobName: 'chat_action_fixer',
      automationPriority: 'other',
    }), expect.any(Function));
    expect(aiMocks.trackedCreate).toHaveBeenCalledTimes(1);
  });
});

function buildPayloadForDirectCall() {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    planner: plan.planner,
    redactedText: 'Schedule a client review.',
    originalStep: step as unknown as Record<string, unknown>,
    errorReason: 'verifier_mismatch',
    providerReadBack: { title: 'Client review' },
    riskClass: 'R1',
    sourceSkill: 'secretary',
    action: 'schedule_event',
  };
}
