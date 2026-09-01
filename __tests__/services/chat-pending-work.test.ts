/**
 * Mirror test for cancelAllPendingChatWork (milestone 1 safety hardening).
 * "Cancel that" must clear EVERY pending-work store — typed pending actions,
 * action runs, the free-form confirmation, staged ChatCoreV2 commands, and
 * timeout continuations —
 * and one failing store must never stop the others from being cleared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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

import { cancelAllPendingChatWork } from '../../src/services/chat-pending-work';
import {
  resetChatActionStateForTests,
  upsertPendingChatAction,
} from '../../src/services/chat-action-state';
import {
  buildNormalizedActionHash,
  claimChatActionRun,
  getChatActionRun,
} from '../../src/services/chat-action-run-store';
import {
  getPendingChatConfirmation,
  resetPendingChatConfirmationsForTests,
  trackPendingChatConfirmation,
} from '../../src/services/chat-pending-confirmations';
import {
  getPendingChatCoreV2Command,
  resetPendingChatCoreV2CommandsForTests,
  trackPendingChatCoreV2Command,
} from '../../src/services/chat-core-v2/pending-commands';
import {
  enqueueChatLegacyTimeoutContinuation,
} from '../../src/services/chat-legacy-timeout-continuation';

const USER_ID = 4242;
const TENANT_A = 4242;
const TENANT_B = 8888;
const CONVERSATION = 'conv-1';

function seedPendingAction(tenantId: number, conversationId = CONVERSATION) {
  return upsertPendingChatAction({
    userId: USER_ID,
    tenantId,
    conversationId,
    skill: 'tasks',
    action: 'create_task',
    collectedSlots: { title: null },
    missingSlots: ['title'],
    riskClass: 'R1',
    locale: 'en',
    timezone: 'UTC',
    originatingSurface: 'ios_chat',
  });
}

function seedActionRun(tenantId: number, messageId = 'msg-1') {
  const claim = claimChatActionRun({
    userId: USER_ID,
    tenantId,
    conversationId: CONVERSATION,
    messageId,
    normalizedActionHash: buildNormalizedActionHash({ messageId, tenantId }),
    actionType: 'tasks.create_task',
    risk: 'safe_write',
    request: { title: 'buy milk' },
  });
  expect(claim.acquired).toBe(true);
  return claim.row;
}

function seedConfirmation(tenantId: number) {
  return trackPendingChatConfirmation({
    userId: USER_ID,
    tenantId,
    actionSummary: 'Delete the 3pm event',
    involvedSkills: ['secretary'],
    reasonCodes: ['destructive_action'],
  });
}

function seedV2Command(tenantId: number, commandId: string) {
  return trackPendingChatCoreV2Command({
    userId: USER_ID,
    tenantId,
    capabilityId: 'tasks.create_task',
    command: {
      commandId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as any,
  });
}

function seedTimeoutContinuation(tenantId: number, runId: string) {
  return enqueueChatLegacyTimeoutContinuation({
    tenantId,
    userId: USER_ID,
    sourceRunId: runId,
    sourceMessageId: `msg-${runId}`,
    sourceText: 'plan my day',
    domain: 'secretary',
    completedTools: ['get_calendar_events'],
  });
}

function pendingActionRow(id: string): { status: string; cancellation_state: string } | undefined {
  return testDb.prepare(
    'SELECT status, cancellation_state FROM chat_pending_actions WHERE id = ?',
  ).get(id) as { status: string; cancellation_state: string } | undefined;
}

describe('cancelAllPendingChatWork', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    resetChatActionStateForTests();
    resetPendingChatConfirmationsForTests();
    resetPendingChatCoreV2CommandsForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('clears every pending-work store in one call', async () => {
    const action = seedPendingAction(TENANT_A);
    const run = seedActionRun(TENANT_A);
    seedConfirmation(TENANT_A);
    seedV2Command(TENANT_A, 'cmd-1');
    seedTimeoutContinuation(TENANT_A, 'timeout-1');

    const result = await cancelAllPendingChatWork({
      userId: USER_ID,
      tenantId: TENANT_A,
      conversationId: CONVERSATION,
    });

    expect(result.chatPendingActions).toBe(1);
    expect(result.chatActionRuns).toBe(1);
    expect(result.chatPendingConfirmation).toBe(true);
    expect(result.chatCoreV2Commands).toBe(1);
    expect(result.chatBackgroundContinuations).toBe(1);
    expect(result.errors).toBeUndefined();

    expect(pendingActionRow(action.id)?.status).not.toBe('needs_input');
    expect(getChatActionRun(run.id)?.status).toBe('cancelled');
    expect(getPendingChatConfirmation(USER_ID, TENANT_A)).toBeNull();
    expect(getPendingChatCoreV2Command('cmd-1', USER_ID, TENANT_A)).toBeNull();
  });

  it('one failing store is reported in errors[] and never stops the other stores', async () => {
    seedPendingAction(TENANT_A);
    seedConfirmation(TENANT_A);
    seedV2Command(TENANT_A, 'cmd-2');
    // Force a real store failure: the action-run store's table is gone.
    testDb.exec('DROP TABLE chat_action_runs');

    const result = await cancelAllPendingChatWork({
      userId: USER_ID,
      tenantId: TENANT_A,
      conversationId: CONVERSATION,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors!.map((e) => e.store)).toContain('chat_action_runs.cancel');
    // Every other store still cleared.
    expect(result.chatPendingActions).toBe(1);
    expect(result.chatPendingConfirmation).toBe(true);
    expect(result.chatCoreV2Commands).toBe(1);
    expect(getPendingChatConfirmation(USER_ID, TENANT_A)).toBeNull();
    expect(getPendingChatCoreV2Command('cmd-2', USER_ID, TENANT_A)).toBeNull();
  });

  it('never clears another tenant\'s pending work for the same user', async () => {
    const actionB = seedPendingAction(TENANT_B);
    const runB = seedActionRun(TENANT_B, 'msg-b');
    seedConfirmation(TENANT_B);
    seedV2Command(TENANT_B, 'cmd-b');
    seedPendingAction(TENANT_A);
    seedConfirmation(TENANT_A);

    const result = await cancelAllPendingChatWork({
      userId: USER_ID,
      tenantId: TENANT_A,
      conversationId: CONVERSATION,
    });

    expect(result.chatPendingActions).toBe(1);
    // Tenant B state is untouched (tenant_leak guard).
    expect(pendingActionRow(actionB.id)?.status).toBe('needs_input');
    expect(getChatActionRun(runB.id)?.status).not.toBe('cancelled');
    expect(getPendingChatConfirmation(USER_ID, TENANT_B)).not.toBeNull();
    expect(getPendingChatCoreV2Command('cmd-b', USER_ID, TENANT_B)).not.toBeNull();
  });

  it('is a stable no-op when there is nothing pending', async () => {
    const result = await cancelAllPendingChatWork({
      userId: USER_ID,
      tenantId: TENANT_A,
      conversationId: CONVERSATION,
    });

    expect(result).toMatchObject({
      chatPendingActions: 0,
      chatActionRuns: 0,
      chatPendingConfirmation: false,
      chatCoreV2Commands: 0,
      chatBackgroundContinuations: 0,
      decisionDismissed: false,
    });
    expect(result.errors).toBeUndefined();
  });
});
