/**
 * Mirror test for chat-action-state (M6 reliability backfill).
 * Pins the typed pending-action lifecycle: upsert/status transitions
 * (including cancellation_state), TTL expiry via
 * expireStalePendingChatActionsForJob, and the in-memory recent-entity
 * graph (remember/resolve).
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
  cancelPendingChatActions,
  cancelPendingChatActionsForAccountSwitch,
  clearRecentChatEntitiesForUser,
  expireStalePendingChatActionsForJob,
  getActivePendingChatAction,
  getPendingChatActionById,
  listChatActionTelemetryForScope,
  markPendingChatActionNeedsUserFollowup,
  recordChatActionTelemetry,
  rememberRecentChatEntity,
  resetChatActionStateForTests,
  resolveRecentChatEntity,
  upsertPendingChatAction,
  type RecentEntityGraphNode,
} from '../../src/services/chat-action-state';

const USER_ID = 4242;
const TENANT_A = 4242;
const TENANT_B = 8888;
const CONVERSATION = 'conv-1';
const NOW_ISO = '2026-07-20T12:00:00.000Z';

function seedAction(overrides: Partial<Parameters<typeof upsertPendingChatAction>[0]> = {}) {
  return upsertPendingChatAction({
    userId: USER_ID,
    tenantId: TENANT_A,
    conversationId: CONVERSATION,
    skill: 'tasks',
    action: 'create_task',
    collectedSlots: { title: 'buy milk' },
    missingSlots: [],
    riskClass: 'R1',
    locale: 'en',
    timezone: 'UTC',
    originatingSurface: 'ios_chat',
    nowIso: NOW_ISO,
    ...overrides,
  });
}

function rawRow(id: string): Record<string, unknown> | undefined {
  return testDb.prepare('SELECT * FROM chat_pending_actions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

function makeNode(overrides: Partial<RecentEntityGraphNode> = {}): RecentEntityGraphNode {
  return {
    entityId: 'task-1',
    entityType: 'task',
    provider: 'mstodo',
    surface: 'chat',
    userVisibleLabel: 'Buy milk',
    createdOrViewedAt: NOW_ISO,
    lastVerifiedAt: NOW_ISO,
    allowedFollowupActions: ['complete_task', 'delete_task'],
    confidence: 0.9,
    // Far future: rememberRecentChatEntity prunes stored nodes against the
    // REAL clock (see the explicit 'CURRENT LIMITATION' pin below), so
    // per-test expiry scenarios pass explicit expiresAt.
    expiresAt: '2100-01-01T00:00:00.000Z',
    sourceTurnId: 'turn-1',
    ...overrides,
  };
}

describe('chat-action-state', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    resetChatActionStateForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('upsertPendingChatAction', () => {
    it('creates an executable, active row when no slots are missing', () => {
      const action = seedAction();

      expect(action.status).toBe('executable');
      expect(action.validationState).toBe('valid');
      expect(action.confirmationState).toBe('not_required');
      expect(action.cancellationState).toBe('active');
      expect(action.collectedSlots).toEqual({ title: 'buy milk' });
      expect(action.missingSlots).toEqual([]);
      // R1 TTL is 60 minutes from nowIso.
      expect(action.expiresAt).toBe('2026-07-20T13:00:00.000Z');
    });

    it('creates a needs_input row when slots are missing', () => {
      const action = seedAction({ collectedSlots: { title: null }, missingSlots: ['title'] });

      expect(action.status).toBe('needs_input');
      expect(action.validationState).toBe('needs_input');
      expect(action.missingSlots).toEqual(['title']);
    });

    it('marks R2/R3 actions as confirmation required and shortens their TTL', () => {
      const r2 = seedAction({ action: 'update_task', riskClass: 'R2' });
      expect(r2.confirmationState).toBe('required');
      expect(r2.expiresAt).toBe('2026-07-20T12:20:00.000Z');

      const r3 = seedAction({ action: 'delete_task', riskClass: 'R3' });
      expect(r3.confirmationState).toBe('required');
      expect(r3.expiresAt).toBe('2026-07-20T12:10:00.000Z');
    });

    it('updates the existing active row in place for the same conversation+skill+action', () => {
      const first = seedAction({ collectedSlots: { title: null }, missingSlots: ['title'] });
      const second = seedAction({ collectedSlots: { title: 'buy milk' }, missingSlots: [] });

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('executable');
      const count = testDb.prepare(
        'SELECT COUNT(*) AS n FROM chat_pending_actions WHERE user_id = ?',
      ).get(USER_ID) as { n: number };
      expect(count.n).toBe(1);
    });

    it('re-activates a previously cancelled draft as a fresh active row state', () => {
      const first = seedAction();
      cancelPendingChatActions({ userId: USER_ID, tenantId: TENANT_A, conversationId: CONVERSATION, nowIso: NOW_ISO });
      expect(rawRow(first.id)?.cancellation_state).toBe('cancelled');

      // The cancelled row no longer matches the partial-index guard, so a
      // new INSERT lands alongside it and becomes the active draft.
      const second = seedAction();
      expect(second.id).not.toBe(first.id);
      expect(second.cancellationState).toBe('active');
      expect(rawRow(first.id)?.cancellation_state).toBe('cancelled');
    });
  });

  describe('getActivePendingChatAction / getPendingChatActionById', () => {
    it('returns the newest active row for the scope and honors the skill filter', () => {
      seedAction({ skill: 'tasks', nowIso: '2026-07-20T12:00:00.000Z' });
      const cooking = seedAction({
        skill: 'cooking',
        action: 'plan_meal',
        nowIso: '2026-07-20T12:05:00.000Z',
      });

      const newest = getActivePendingChatAction({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        nowIso: '2026-07-20T12:06:00.000Z',
      });
      expect(newest?.id).toBe(cooking.id);

      const tasksOnly = getActivePendingChatAction({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        skill: 'tasks',
        nowIso: '2026-07-20T12:06:00.000Z',
      });
      expect(tasksOnly?.skill).toBe('tasks');
    });

    it('never returns another tenant\'s pending action by id', () => {
      const action = seedAction();

      expect(getPendingChatActionById({
        userId: USER_ID,
        tenantId: TENANT_B,
        pendingActionId: action.id,
        nowIso: NOW_ISO,
      })).toBeNull();
      expect(getPendingChatActionById({
        userId: USER_ID,
        tenantId: TENANT_A,
        pendingActionId: action.id,
        nowIso: NOW_ISO,
      })?.id).toBe(action.id);
    });

    it('still exposes needs_user_followup rows by id but not via the active-scope read', () => {
      const action = seedAction();
      markPendingChatActionNeedsUserFollowup({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        skill: 'tasks',
        action: 'create_task',
        nowIso: NOW_ISO,
      });

      expect(getActivePendingChatAction({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        nowIso: NOW_ISO,
      })).toBeNull();
      const byId = getPendingChatActionById({
        userId: USER_ID,
        tenantId: TENANT_A,
        pendingActionId: action.id,
        nowIso: NOW_ISO,
      });
      expect(byId?.status).toBe('needs_user_followup');
      expect(byId?.validationState).toBe('invalid');
    });
  });

  describe('cancellation transitions', () => {
    it('cancelPendingChatActions moves active rows to cancelled/cancelled', () => {
      const action = seedAction();
      const changed = cancelPendingChatActions({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        nowIso: NOW_ISO,
      });

      expect(changed).toBe(1);
      const row = rawRow(action.id);
      expect(row?.status).toBe('cancelled');
      expect(row?.cancellation_state).toBe('cancelled');
    });

    it('cancelPendingChatActions is tenant-scoped and idempotent', () => {
      seedAction({ tenantId: TENANT_B });
      const changedOtherTenant = cancelPendingChatActions({
        userId: USER_ID,
        tenantId: TENANT_A,
        nowIso: NOW_ISO,
      });
      expect(changedOtherTenant).toBe(0);

      const changed = cancelPendingChatActions({ userId: USER_ID, tenantId: TENANT_B, nowIso: NOW_ISO });
      expect(changed).toBe(1);
      expect(cancelPendingChatActions({ userId: USER_ID, tenantId: TENANT_B, nowIso: NOW_ISO })).toBe(0);
    });

    it('cancelPendingChatActionsForAccountSwitch cancels across conversations and clears recent entities', () => {
      seedAction({ conversationId: 'conv-1' });
      seedAction({ conversationId: 'conv-2', action: 'update_task' });
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode(),
      });

      const changed = cancelPendingChatActionsForAccountSwitch({
        userId: USER_ID,
        tenantId: TENANT_A,
        nowIso: NOW_ISO,
      });

      expect(changed).toBe(2);
      expect(resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      })).toEqual({ status: 'none', candidates: [] });
    });
  });

  describe('TTL expiry (expireStalePendingChatActionsForJob)', () => {
    it('expires stale active rows with cancellation_state=expired', () => {
      const stale = seedAction({ expiresAt: '2026-07-20T12:30:00.000Z' });
      const fresh = seedAction({
        conversationId: 'conv-2',
        expiresAt: '2026-07-20T14:00:00.000Z',
      });

      const expired = expireStalePendingChatActionsForJob('2026-07-20T12:31:00.000Z');

      expect(expired).toBe(1);
      const staleRow = rawRow(stale.id);
      expect(staleRow?.status).toBe('cancelled');
      expect(staleRow?.cancellation_state).toBe('expired');
      expect(rawRow(fresh.id)?.cancellation_state).toBe('active');
    });

    it('active-scope reads run expiry first so stale rows never surface', () => {
      seedAction({ expiresAt: '2026-07-20T12:30:00.000Z' });

      const read = getActivePendingChatAction({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        nowIso: '2026-07-20T12:31:00.000Z',
      });

      expect(read).toBeNull();
    });

    it('does not touch already-cancelled rows', () => {
      const action = seedAction({ expiresAt: '2026-07-20T12:30:00.000Z' });
      cancelPendingChatActions({ userId: USER_ID, tenantId: TENANT_A, nowIso: NOW_ISO });

      expect(expireStalePendingChatActionsForJob('2026-07-20T12:31:00.000Z')).toBe(0);
      expect(rawRow(action.id)?.cancellation_state).toBe('cancelled');
    });
  });

  describe('recent-entity graph', () => {
    it('resolves a single fresh candidate matching type and follow-up action', () => {
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode(),
      });

      const resolved = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      });

      expect(resolved.status).toBe('single');
      expect(resolved.candidates[0]?.entityId).toBe('task-1');
    });

    it('filters by follow-up action, entity type, and expiry', () => {
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'task-expired', expiresAt: '2026-07-20T11:00:00.000Z' }),
      });
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'event-1', entityType: 'calendar_event', allowedFollowupActions: ['delete_event'] }),
      });
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'task-no-followup', allowedFollowupActions: ['delete_task'] }),
      });

      const resolved = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      });

      expect(resolved).toEqual({ status: 'none', candidates: [] });
    });

    it('is ambiguous for close candidates but auto-picks a dominant fresh one', () => {
      const seed = (entityId: string, confidence: number, lastVerifiedAt = NOW_ISO) =>
        rememberRecentChatEntity({
          userId: USER_ID,
          tenantId: TENANT_A,
          conversationId: CONVERSATION,
          node: makeNode({ entityId, confidence, lastVerifiedAt }),
        });

      seed('task-a', 0.8, '2026-07-20T12:00:00.000Z');
      seed('task-b', 0.78, '2026-07-20T11:59:00.000Z');
      const close = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      });
      expect(close.status).toBe('ambiguous');
      expect(close.candidates.map((node) => node.entityId)).toEqual(['task-a', 'task-b']);

      resetChatActionStateForTests();
      seed('task-strong', 0.95, '2026-07-20T12:00:00.000Z');
      seed('task-weak', 0.5, '2026-07-20T11:59:00.000Z');
      const dominant = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      });
      expect(dominant.status).toBe('single');
      expect(dominant.candidates[0]?.entityId).toBe('task-strong');
    });

    it('deduplicates by entity identity keeping the newest node', () => {
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ userVisibleLabel: 'old label' }),
      });
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ userVisibleLabel: 'new label' }),
      });

      const resolved = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      });

      expect(resolved.status).toBe('single');
      expect(resolved.candidates[0]?.userVisibleLabel).toBe('new label');
    });

    it('CURRENT LIMITATION (pre-existing bug, owner M13): rememberRecentChatEntity prunes with the REAL clock while resolveRecentChatEntity honors nowIso', () => {
      // rememberRecentChatEntity filters stored nodes with Date.now(), but
      // resolveRecentChatEntity uses the caller-supplied nowIso. A node whose
      // expiresAt is in the real-clock past is therefore dropped at REMEMBER
      // time even when the logical test clock (nowIso) is still before its
      // expiry — the resolve below should be 'single' under a consistent
      // logical clock, but is 'none' today. M13 (durable conversation
      // continuity) owns threading nowIso through rememberRecentChatEntity.
      const logicalNow = '2020-01-01T00:00:00.000Z'; // before the node expiry
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({
          entityId: 'task-real-clock-pruned',
          // Expired relative to the REAL clock, valid relative to logicalNow.
          expiresAt: '2020-06-01T00:00:00.000Z',
        }),
      });
      // Insert a second node so the pruning filter re-runs over stored nodes.
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'task-other', entityType: 'calendar_event', allowedFollowupActions: ['delete_event'] }),
      });

      const resolved = resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: logicalNow,
      });

      // Desired behavior (post-M13): status 'single' with task-real-clock-pruned.
      expect(resolved).toEqual({ status: 'none', candidates: [] });
    });

    it('clearRecentChatEntitiesForUser scopes by tenant prefix', () => {
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'tenant-a-task' }),
      });
      rememberRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_B,
        conversationId: CONVERSATION,
        node: makeNode({ entityId: 'tenant-b-task' }),
      });

      clearRecentChatEntitiesForUser(USER_ID, TENANT_A);

      expect(resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      }).status).toBe('none');
      expect(resolveRecentChatEntity({
        userId: USER_ID,
        tenantId: TENANT_B,
        conversationId: CONVERSATION,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW_ISO,
      }).status).toBe('single');
    });
  });

  describe('telemetry', () => {
    it('records and lists telemetry scoped by tenant and message', () => {
      recordChatActionTelemetry({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        messageId: 'msg-1',
        planner: 'deterministic',
        status: 'executed',
        skill: 'tasks',
        action: 'create_task',
        telemetry: {
          routeTier: 'tier1_classifier',
          candidates: [{ skill: 'tasks', action: 'create_task', score: 0.91 }],
          calibratedScore: 0.91,
          threshold: 0.72,
          verifierStatus: 'verified',
        },
        nowIso: NOW_ISO,
      });
      recordChatActionTelemetry({
        userId: USER_ID,
        tenantId: TENANT_B,
        conversationId: CONVERSATION,
        messageId: 'msg-2',
        planner: 'deterministic',
        status: 'executed',
        nowIso: NOW_ISO,
      });

      const scoped = listChatActionTelemetryForScope({
        userId: USER_ID,
        tenantId: TENANT_A,
        conversationId: CONVERSATION,
        messageId: 'msg-1',
      });

      expect(scoped).toHaveLength(1);
      expect(scoped[0]).toMatchObject({
        routeTier: 'tier1_classifier',
        skill: 'tasks',
        action: 'create_task',
        calibratedScore: 0.91,
        threshold: 0.72,
        verifierStatus: 'verified',
      });
      expect(listChatActionTelemetryForScope({ userId: USER_ID, tenantId: TENANT_B })).toHaveLength(1);
    });
  });
});
