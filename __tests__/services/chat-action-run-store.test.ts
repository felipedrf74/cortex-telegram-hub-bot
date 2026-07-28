/**
 * Mirror test for chat-action-run-store (M6 reliability backfill).
 * Pins the claim/replay/update lifecycle, cancelPendingChatActionRuns,
 * reapZombieChatActionRuns, and pruneCompletedChatActionRuns.
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

import {
  buildNormalizedActionHash,
  cancelPendingChatActionRuns,
  claimChatActionRun,
  claimChatActionRunForExecution,
  getChatActionRun,
  listLegacyToolLoopCheckpoints,
  listPendingChatActionRuns,
  pruneCompletedChatActionRuns,
  reapZombieChatActionRuns,
  recordLegacyToolLoopCheckpoint,
  updateChatActionRun,
} from '../../src/services/chat-action-run-store';

const USER_ID = 4242;
const TENANT_A = 4242;
const TENANT_B = 8888;
const CONVERSATION = 'conv-1';
const NOW_ISO = '2026-07-20T12:00:00.000Z';

function claim(overrides: Partial<Parameters<typeof claimChatActionRun>[0]> = {}) {
  const messageId = overrides.messageId ?? 'msg-1';
  return claimChatActionRun({
    userId: USER_ID,
    tenantId: TENANT_A,
    conversationId: CONVERSATION,
    messageId,
    normalizedActionHash: buildNormalizedActionHash({ messageId, action: 'create_task' }),
    actionType: 'tasks.create_task',
    risk: 'safe_write',
    request: { title: 'buy milk' },
    nowIso: NOW_ISO,
    ...overrides,
  });
}

describe('chat-action-run-store', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('buildNormalizedActionHash', () => {
    it('is stable under object key ordering and distinguishes values', () => {
      const a = buildNormalizedActionHash({ title: 'x', when: 'tomorrow' });
      const b = buildNormalizedActionHash({ when: 'tomorrow', title: 'x' });
      const c = buildNormalizedActionHash({ title: 'y', when: 'tomorrow' });

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hashes nested arrays/objects deterministically', () => {
      const a = buildNormalizedActionHash({ steps: [{ b: 2, a: 1 }], nul: null });
      const b = buildNormalizedActionHash({ nul: null, steps: [{ a: 1, b: 2 }] });
      expect(a).toBe(b);
    });
  });

  describe('claim / replay', () => {
    it('first claim acquires a planned row; duplicate claim replays it', () => {
      const first = claim();
      expect(first.acquired).toBe(true);
      expect(first.row.status).toBe('planned');
      expect(first.row.request_json).toBe(JSON.stringify({ title: 'buy milk' }));

      const replay = claim();
      expect(replay.acquired).toBe(false);
      expect(replay.row.id).toBe(first.row.id);
    });

    it('scopes the idempotency key by tenant and message', () => {
      const first = claim();
      const otherTenant = claim({ tenantId: TENANT_B });
      const otherMessage = claim({ messageId: 'msg-2' });

      expect(otherTenant.acquired).toBe(true);
      expect(otherMessage.acquired).toBe(true);
      expect(new Set([first.row.id, otherTenant.row.id, otherMessage.row.id]).size).toBe(3);
    });

    it('claimChatActionRunForExecution moves a fresh claim straight to executing', () => {
      const claimed = claimChatActionRunForExecution({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        messageId: 'msg-exec',
        normalizedActionHash: buildNormalizedActionHash({ messageId: 'msg-exec' }),
        actionType: 'tasks.create_task',
        risk: 'safe_write',
        request: {},
        nowIso: NOW_ISO,
      });

      expect(claimed.acquired).toBe(true);
      expect(claimed.row.status).toBe('executing');
    });

    it('claimChatActionRunForExecution re-acquires only from needs_confirmation', () => {
      const first = claim();
      updateChatActionRun(first.row.id, 'needs_confirmation', { nowIso: NOW_ISO });

      const confirmed = claim();
      expect(confirmed.acquired).toBe(false);
      const executed = claimChatActionRunForExecution({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        messageId: 'msg-1',
        normalizedActionHash: first.row.normalized_action_hash,
        actionType: 'tasks.create_task',
        risk: 'safe_write',
        request: { title: 'buy milk' },
        nowIso: NOW_ISO,
      });
      expect(executed.acquired).toBe(true);
      expect(executed.row.status).toBe('executing');

      // A second execution claim does not double-acquire.
      const duplicate = claimChatActionRunForExecution({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        messageId: 'msg-1',
        normalizedActionHash: first.row.normalized_action_hash,
        actionType: 'tasks.create_task',
        risk: 'safe_write',
        request: { title: 'buy milk' },
        nowIso: NOW_ISO,
      });
      expect(duplicate.acquired).toBe(false);
      expect(duplicate.row.status).toBe('executing');
    });
  });

  describe('updateChatActionRun lifecycle', () => {
    it('stamps completed_at only for terminal statuses', () => {
      const run = claim().row;

      const executing = updateChatActionRun(run.id, 'executing', { nowIso: NOW_ISO });
      expect(executing?.completed_at).toBeNull();

      const done = updateChatActionRun(run.id, 'verified_success', { nowIso: '2026-07-20T12:01:00.000Z' });
      expect(done?.status).toBe('verified_success');
      expect(done?.completed_at).toBe('2026-07-20T12:01:00.000Z');
    });

    it('rejects late writes after a terminal failed/cancelled status', () => {
      const run = claim().row;
      updateChatActionRun(run.id, 'failed', { error: { message: 'boom' }, nowIso: NOW_ISO });

      const late = updateChatActionRun(run.id, 'verified_success', { nowIso: '2026-07-20T12:02:00.000Z' });

      expect(late).toBeNull();
      expect(getChatActionRun(run.id)?.status).toBe('failed');
    });

    it('sanitizes stored results to replay-safe scalars', () => {
      const run = claim().row;

      const updated = updateChatActionRun(run.id, 'verified_success', {
        result: {
          task: { id: 'task-99', listId: 'list-7', title: 'SECRET raw payload' },
          listId: 'list-7',
          provider: 'mstodo',
          verified: true,
        },
        nowIso: NOW_ISO,
      });

      expect(JSON.parse(updated?.result_json ?? '{}')).toEqual({
        status: 'verified_success',
        verified: true,
        providerObjectId: 'task-99',
        listId: 'list-7',
        source: 'mstodo',
        resultType: 'task',
        replaySafe: true,
      });
      expect(updated?.result_json).not.toContain('SECRET raw payload');
    });

    it('infers calendar result shape and keeps explicit provider ids', () => {
      const run = claim({ messageId: 'msg-cal' }).row;

      const updated = updateChatActionRun(run.id, 'verified_success', {
        result: { event: { id: 'evt-1', source: 'google' } },
        providerObjectId: 'evt-explicit',
        nowIso: NOW_ISO,
      });

      expect(JSON.parse(updated?.result_json ?? '{}')).toMatchObject({
        providerObjectId: 'evt-explicit',
        resultType: 'calendar_event',
        source: 'google',
        listId: null,
      });
      expect(updated?.provider_object_id).toBe('evt-explicit');
    });
  });

  describe('listPendingChatActionRuns', () => {
    it('lists only non-terminal runs for the scope in creation order', () => {
      const first = claim({ messageId: 'msg-1', nowIso: '2026-07-20T12:00:00.000Z' }).row;
      const second = claim({ messageId: 'msg-2', nowIso: '2026-07-20T12:00:01.000Z' }).row;
      const terminal = claim({ messageId: 'msg-3', nowIso: '2026-07-20T12:00:02.000Z' }).row;
      updateChatActionRun(terminal.id, 'failed', { nowIso: NOW_ISO });
      claim({ tenantId: TENANT_B, messageId: 'msg-b' });

      const pending = listPendingChatActionRuns({ userId: USER_ID, tenantId: TENANT_A });

      expect(pending.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(listPendingChatActionRuns({
        userId: USER_ID,
        tenantId: TENANT_A,
        messageId: 'msg-2',
      }).map((row) => row.id)).toEqual([second.id]);
    });
  });

  describe('cancelPendingChatActionRuns', () => {
    it('cancels pending runs with a user-cancelled marker and completed_at', () => {
      const run = claim().row;

      const changed = cancelPendingChatActionRuns({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        nowIso: '2026-07-20T12:05:00.000Z',
      });

      expect(changed).toBe(1);
      const cancelled = getChatActionRun(run.id);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.completed_at).toBe('2026-07-20T12:05:00.000Z');
      expect(JSON.parse(cancelled?.error_json ?? '{}')).toEqual({ reason: 'user_cancelled_pending_chat_work' });
    });

    it('never cancels other tenants or terminal runs', () => {
      const otherTenant = claim({ tenantId: TENANT_B, messageId: 'msg-b' }).row;
      const terminal = claim({ messageId: 'msg-done' }).row;
      updateChatActionRun(terminal.id, 'verified_success', { nowIso: NOW_ISO });

      const changed = cancelPendingChatActionRuns({ userId: USER_ID, tenantId: TENANT_A, nowIso: NOW_ISO });

      expect(changed).toBe(0);
      expect(getChatActionRun(otherTenant.id)?.status).toBe('planned');
      expect(getChatActionRun(terminal.id)?.status).toBe('verified_success');
    });
  });

  describe('reapZombieChatActionRuns', () => {
    it('fails only executing runs older than the cutoff (default 5 minutes)', () => {
      const zombie = claim({ messageId: 'msg-zombie' }).row;
      updateChatActionRun(zombie.id, 'executing', { nowIso: '2026-07-20T11:54:00.000Z' });
      const fresh = claim({ messageId: 'msg-fresh' }).row;
      updateChatActionRun(fresh.id, 'executing', { nowIso: '2026-07-20T11:58:00.000Z' });
      const planned = claim({ messageId: 'msg-planned' }).row;

      const reaped = reapZombieChatActionRuns({ nowIso: NOW_ISO });

      expect(reaped).toBe(1);
      const failed = getChatActionRun(zombie.id);
      expect(failed?.status).toBe('failed');
      expect(JSON.parse(failed?.error_json ?? '{}')).toEqual({ reason: 'orphaned_executing' });
      expect(failed?.completed_at).toBe(NOW_ISO);
      expect(getChatActionRun(fresh.id)?.status).toBe('executing');
      expect(getChatActionRun(planned.id)?.status).toBe('planned');
    });
  });

  describe('pruneCompletedChatActionRuns', () => {
    it('deletes only old terminal runs (default horizon 90 days)', () => {
      const old = claim({ messageId: 'msg-old' }).row;
      updateChatActionRun(old.id, 'verified_success', { nowIso: '2026-04-01T12:00:00.000Z' });
      const recent = claim({ messageId: 'msg-recent' }).row;
      updateChatActionRun(recent.id, 'failed', { nowIso: '2026-07-19T12:00:00.000Z' });
      const active = claim({ messageId: 'msg-active' }).row;

      const pruned = pruneCompletedChatActionRuns({ nowIso: NOW_ISO });

      expect(pruned).toBe(1);
      expect(getChatActionRun(old.id)).toBeNull();
      expect(getChatActionRun(recent.id)?.status).toBe('failed');
      expect(getChatActionRun(active.id)?.status).toBe('planned');
    });
  });

  // ─── M18: legacy tool-loop checkpoints ────────────────────────────
  describe('legacy tool-loop checkpoints (M18)', () => {
    const RUN_ID = 'req-m18-run-1';

    function checkpoint(sequence: number, toolName: string, overrides: Partial<Parameters<typeof recordLegacyToolLoopCheckpoint>[0]> = {}) {
      return recordLegacyToolLoopCheckpoint({
        runId: RUN_ID,
        userId: USER_ID,
        tenantId: TENANT_A,
        domain: 'secretary',
        toolName,
        toolInput: { q: toolName },
        resultSummary: `{"ok":true,"tool":"${toolName}"}`,
        sequence,
        nowIso: NOW_ISO,
        ...overrides,
      });
    }

    it('records completed tool calls as terminal rows and lists them in sequence order', () => {
      expect(checkpoint(1, 'ms_todo_get_tasks')).toBe(true);
      expect(checkpoint(2, 'get_calendar_events')).toBe(true);

      const listed = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_A });
      expect(listed.map((c) => c.toolName)).toEqual(['ms_todo_get_tasks', 'get_calendar_events']);
      expect(listed.map((c) => c.sequence)).toEqual([1, 2]);
      expect(listed.every((c) => c.completedAt === NOW_ISO)).toBe(true);
    });

    it('is idempotent per (run, sequence, tool) — a re-recorded checkpoint is ignored', () => {
      expect(checkpoint(1, 'ms_todo_get_tasks')).toBe(true);
      expect(checkpoint(1, 'ms_todo_get_tasks')).toBe(false);
      expect(listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_A })).toHaveLength(1);
    });

    it('orders sequences numerically past single digits', () => {
      for (let seq = 1; seq <= 11; seq++) checkpoint(seq, `tool_${seq}`);
      const listed = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_A });
      expect(listed.map((c) => c.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('scopes checkpoints by tenant and run id', () => {
      checkpoint(1, 'ms_todo_get_tasks');
      checkpoint(1, 'finance_get_transactions', { tenantId: TENANT_B });
      checkpoint(1, 'search_notes', { runId: 'req-other' });

      expect(listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_A }).map((c) => c.toolName)).toEqual(['ms_todo_get_tasks']);
      expect(listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_B }).map((c) => c.toolName)).toEqual(['finance_get_transactions']);
      expect(listLegacyToolLoopCheckpoints({ runId: 'req-other', userId: USER_ID, tenantId: TENANT_A }).map((c) => c.toolName)).toEqual(['search_notes']);
    });

    it('keeps checkpoint evidence terminal; continuation lifecycle lives in the dedicated background queue', () => {
      // The checkpoint rows are immutable evidence, never executable work.
      // cancelAllPendingChatWork cancels the dedicated background job through
      // its own scoped store without rewriting these historical rows.
      checkpoint(1, 'ms_todo_get_tasks');
      checkpoint(2, 'get_calendar_events');

      expect(listPendingChatActionRuns({ userId: USER_ID, tenantId: TENANT_A })).toHaveLength(0);
      expect(cancelPendingChatActionRuns({ userId: USER_ID, tenantId: TENANT_A, nowIso: NOW_ISO })).toBe(0);
      // The historical evidence rows survive cancellation untouched.
      const listed = listLegacyToolLoopCheckpoints({ runId: RUN_ID, userId: USER_ID, tenantId: TENANT_A });
      expect(listed).toHaveLength(2);
    });
  });
});
