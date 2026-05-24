import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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
  enqueueChatActionFixerReview,
  processChatActionFixerJobs,
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
    testDb = new Database(':memory:');
    process.env.NODE_ENV = 'test';
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureBackgroundJobTables(testDb);
    ensureNotificationTables();
    ensureDecisionCenterTables();
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
});
