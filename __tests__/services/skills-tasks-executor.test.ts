/**
 * M5 chat planner task executors — direct unit contract (ledger path).
 *
 * Exercises executeTaskCreateStep / executeTaskWithSubtasksStep /
 * executeAddSubtasksToTaskStep / executeTaskMutationStep against a REAL
 * migrated database: ledger rows and chat_action_runs rows are asserted
 * directly, target resolution runs on the local read model, and the
 * failure/partial/reconciliation contracts are pinned. The offline-first
 * service is wrapped (not replaced) so individual writes can be failed or
 * read-backs degraded while everything else stays real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const ledgerControl = vi.hoisted(() => ({
  beforeWrite: null as null | (() => void),
  failCreate: null as null | (() => never),
  failChecklistFor: null as null | string,
  failSnapshot: null as null | (() => never),
  transformGetById: null as null | ((dto: any) => any),
}));

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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/user-service', () => ({
  resolveCanonicalUserId: vi.fn((userRef: unknown) => (typeof userRef === 'number' && userRef > 0 ? userRef : null)),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getOwnerBootstrapUser: vi.fn(() => null),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => false),
}));

const mockLegacyProvider: Record<string, unknown> = {};
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: vi.fn(() => mockLegacyProvider),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateTaskCaches: vi.fn(),
  invalidateCalendarCaches: vi.fn(),
  invalidateCookingDerivedCaches: vi.fn(),
  invalidateFinanceDerivedCaches: vi.fn(),
  invalidateOnboardingDerivedCaches: vi.fn(),
}));

// Wrap (do not replace) the offline-first ledger: default behavior is the
// real service against the migrated DB; controls inject targeted failures.
vi.mock('../../src/services/task-store/offline-first-task-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/task-store/offline-first-task-service')>();
  return {
    ...actual,
    createOfflineFirstTask: (tenantId: number, userId: number, input: any) => {
      ledgerControl.beforeWrite?.();
      if (ledgerControl.failCreate) ledgerControl.failCreate();
      return actual.createOfflineFirstTask(tenantId, userId, input);
    },
    updateOfflineFirstTask: (tenantId: number, userId: number, input: any) => {
      ledgerControl.beforeWrite?.();
      return actual.updateOfflineFirstTask(tenantId, userId, input);
    },
    recordLocalTaskMutation: (tenantId: number, userId: number, input: any) => {
      ledgerControl.beforeWrite?.();
      return actual.recordLocalTaskMutation(tenantId, userId, input);
    },
    addOfflineTaskChecklistItem: (tenantId: number, userId: number, input: any) => {
      ledgerControl.beforeWrite?.();
      if (ledgerControl.failChecklistFor && input?.displayName === ledgerControl.failChecklistFor) {
        throw new Error('checklist_write_failed');
      }
      return actual.addOfflineTaskChecklistItem(tenantId, userId, input);
    },
    getOfflineTaskSnapshot: (tenantId: number, userId: number, options?: any) => {
      if (ledgerControl.failSnapshot) ledgerControl.failSnapshot();
      return actual.getOfflineTaskSnapshot(tenantId, userId, options);
    },
    getOfflineTaskById: (tenantId: number, userId: number, taskId: string) => {
      const dto = actual.getOfflineTaskById(tenantId, userId, taskId);
      return ledgerControl.transformGetById ? ledgerControl.transformGetById(dto) : dto;
    },
  };
});

import {
  executeAddSubtasksToTaskStep,
  executeTaskCreateStep,
  executeTaskMutationStep,
  executeTaskWithSubtasksStep,
} from '../../src/services/skills/tasks/executor';
import {
  createOfflineFirstTask,
  getOfflineTaskById,
} from '../../src/services/task-store/offline-first-task-service';
import { getTaskProviderForUser } from '../../src/services/task-store/task-router';
import { resetChatActionStateForTests, resolveRecentChatEntity } from '../../src/services/chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../src/services/chat/types';

const USER_ID = 42;
const NOW_ISO = '2026-07-17T10:00:00.000Z';
let stepCounter = 0;

function buildStep(overrides: Partial<ChatPlanStep> = {}): ChatPlanStep {
  stepCounter += 1;
  return {
    stepId: `step-${stepCounter}`,
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: 'safe_write',
    args: {},
    requiredArgsPresent: true,
    idempotencyKey: `idem-${stepCounter}`,
    verification: { required: true, method: 'local_read_back', expectedFields: {} },
    ...overrides,
  };
}

function buildPlan(): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: String(USER_ID),
    tenantId: String(USER_ID),
    conversationId: 'conv-1',
    messageId: `msg-${stepCounter}`,
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    channel: 'ios',
    createdAt: NOW_ISO,
    planner: 'deterministic',
    steps: [],
    requiresConfirmation: false,
    confidence: 0.95,
  };
}

function buildInput(): ChatPlannerInput {
  return {
    text: 'planner input',
    userId: USER_ID,
    tenantId: USER_ID,
    conversationId: 'conv-1',
    messageId: `msg-${stepCounter}`,
    channel: 'ios',
    timezone: 'Europe/Lisbon',
  };
}

function seedLedgerTask(title: string): { id: string; listId: string } {
  const created = createOfflineFirstTask(USER_ID, USER_ID, { title, listName: 'Inbox' });
  return { id: created.task.id, listId: created.task.listId != null ? String(created.task.listId) : '' };
}

function actionRunRow(idempotencyKey: string): { status: string; error_json: string | null } | undefined {
  return testDb.prepare(
    'SELECT status, error_json FROM chat_action_runs WHERE normalized_action_hash = ?',
  ).get(idempotencyKey) as { status: string; error_json: string | null } | undefined;
}

/** Flip every claimed run into a terminal state mid-write (late-update guard). */
function cancelRunsMidWrite(): void {
  ledgerControl.beforeWrite = () => {
    testDb.prepare("UPDATE chat_action_runs SET status = 'cancelled' WHERE status IN ('executing', 'verifying')").run();
    ledgerControl.beforeWrite = null;
  };
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetChatActionStateForTests();
  for (const key of Object.keys(mockLegacyProvider)) delete mockLegacyProvider[key];
  ledgerControl.beforeWrite = null;
  ledgerControl.failCreate = null;
  ledgerControl.failChecklistFor = null;
  ledgerControl.failSnapshot = null;
  ledgerControl.transformGetById = null;
});

describe('executeTaskCreateStep (ledger)', () => {
  it('creates the task with notes, due date, and list, and records a verified run', async () => {
    const step = buildStep({
      args: {
        title: 'Pack for Lisbon',
        notes: 'Bring the charger',
        dueDateTime: '2026-07-20T09:00:00.000Z',
        list: 'Inbox',
      },
    });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    const payload = result.result as any;
    expect(payload.verified).toBe(true);
    expect(payload.task).toMatchObject({ title: 'Pack for Lisbon', body: 'Bring the charger' });
    expect(getOfflineTaskById(USER_ID, USER_ID, payload.task.id)).toMatchObject({
      title: 'Pack for Lisbon',
      dueDateTime: expect.stringContaining('2026-07-20'),
    });
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'verified_success' });
    // A verified create is remembered for follow-up chat actions.
    const recall = resolveRecentChatEntity({
      userId: USER_ID, tenantId: USER_ID, conversationId: 'conv-1', entityType: 'task', action: 'complete_task',
    });
    expect(recall.status).toBe('single');
    expect(recall.candidates[0]).toMatchObject({ entityId: payload.task.id, userVisibleLabel: 'Pack for Lisbon' });
  });

  it('reports partial success when the local read-back title does not match', async () => {
    ledgerControl.transformGetById = (dto) => (dto ? { ...dto, title: '' } : dto);
    const step = buildStep({ args: { title: 'Mismatch me' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result.status).toBe('partial_success');
    expect((result.result as any).verified).toBe(false);
    const recall = resolveRecentChatEntity({
      userId: USER_ID, tenantId: USER_ID, conversationId: 'conv-1', entityType: 'task', action: 'complete_task',
    });
    expect(recall.status).toBe('none');
  });

  it('verifies from the created row when the read-back is unavailable', async () => {
    ledgerControl.transformGetById = () => null;
    const step = buildStep({ args: { title: 'No read-back' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result.status).toBe('verified_success');
    expect((result.result as any).task.title).toBe('No read-back');
  });

  it('defaults the remembered list metadata when the local row carries no list identity', async () => {
    ledgerControl.transformGetById = (dto) => (dto ? { ...dto, listId: null, listName: null } : dto);
    const step = buildStep({ args: { title: 'Listless task' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result.status).toBe('verified_success');
    expect((result.result as any).task).toMatchObject({ listId: '', listName: '' });
    const recall = resolveRecentChatEntity({
      userId: USER_ID, tenantId: USER_ID, conversationId: 'conv-1', entityType: 'task', action: 'complete_task',
    });
    expect(recall.candidates[0]?.metadata).toEqual({ listId: '', listName: 'Tasks' });
  });

  it('returns a reconciliation-pending result when the run reached a terminal state mid-write', async () => {
    cancelRunsMidWrite();
    const step = buildStep({ args: { title: 'Raced create' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({
      status: 'verified_pending',
      error: 'action_run_reconciliation_pending',
      runUpdateAccepted: false,
    });
  });

  it('fails the persisted run when the ledger rejects the create', async () => {
    const step = buildStep({ args: { title: '' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_create_failed' });
    const run = actionRunRow(step.idempotencyKey);
    expect(run?.status).toBe('failed');
    expect(run?.error_json).toContain('title is required');
  });

  it('records non-Error ledger throws as failure messages on the run', async () => {
    ledgerControl.failCreate = () => { throw 'ledger_down'; };
    const step = buildStep({ args: { title: 'Doomed create' } });

    const result = await executeTaskCreateStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_create_failed' });
    expect(actionRunRow(step.idempotencyKey)?.error_json).toContain('ledger_down');
  });
});

describe('executeTaskWithSubtasksStep (ledger)', () => {
  const subtaskStep = (overrides: Partial<ChatPlanStep> = {}) => buildStep({
    action: 'create_task_with_subtasks',
    type: 'create_task_with_subtasks',
    args: { title: 'Trip prep', subtasks: ['Pack bags', 'Book taxi'], notes: 'Weekend', priority: 'high', list: 'Inbox' },
    ...overrides,
  });

  it('creates the task with all checklist items and records a verified run', async () => {
    const step = subtaskStep();

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    const payload = result.result as any;
    expect(payload.type).toBe('task_created');
    expect(payload.verified).toBe(true);
    expect(payload.subtasks.map((item: any) => item.title)).toEqual(['Pack bags', 'Book taxi']);
    expect(getOfflineTaskById(USER_ID, USER_ID, payload.taskId)?.checklistItems).toHaveLength(2);
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'verified_success' });
  });

  it('blocks when the normalized args are missing subtasks', async () => {
    const step = subtaskStep({ args: { title: 'Only title', subtasks: [] } });

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'task_with_subtasks_missing_fields' });
  });

  it('replays the stored result for a duplicate idempotent request', async () => {
    const step = subtaskStep();
    const first = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);
    expect(first.status).toBe('verified_success');

    const replay = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(replay.status).toBe('verified_success');
    expect((replay.result as any).replayed).toBe(true);
    // Idempotent replay must not have created a second task.
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM unified_tasks WHERE user_id = ? AND title = 'Trip prep' AND is_deleted = 0",
    ).get(USER_ID)).toMatchObject({ count: 1 });
  });

  it('degrades to partial success when one checklist write fails', async () => {
    ledgerControl.failChecklistFor = 'Book taxi';
    const step = subtaskStep();

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'partial_success', error: 'task_subtasks_partial_verification' });
    const payload = result.result as any;
    expect(payload.failedSubtasks).toEqual(['Book taxi']);
    expect(payload.verificationStatus).toBe('partial_failure');
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'partial_success' });
  });

  it('degrades to partial success when the read-back has no checklist to verify', async () => {
    ledgerControl.transformGetById = (dto) => (dto ? { ...dto, checklistItems: undefined } : dto);
    const step = subtaskStep();

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result).toMatchObject({ status: 'partial_success', error: 'task_subtasks_partial_verification' });
    expect((result.result as any).verificationStatus).toBe('partial_failure');
  });

  it('returns a reconciliation-pending result when the run reached a terminal state mid-write', async () => {
    cancelRunsMidWrite();
    const step = subtaskStep();

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({
      status: 'verified_pending',
      error: 'action_run_reconciliation_pending',
      runUpdateAccepted: false,
    });
  });

  it('fails the persisted run when the ledger create throws', async () => {
    ledgerControl.failCreate = () => { throw new Error('ledger unavailable'); };
    const step = subtaskStep();

    const result = await executeTaskWithSubtasksStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_with_subtasks_failed' });
    const run = actionRunRow(step.idempotencyKey);
    expect(run?.status).toBe('failed');
    expect(run?.error_json).toContain('ledger unavailable');
  });
});

describe('executeAddSubtasksToTaskStep (ledger)', () => {
  const addStep = (overrides: Partial<ChatPlanStep> = {}) => buildStep({
    action: 'add_subtasks_to_task',
    type: 'add_subtasks_to_task',
    args: { title: 'Trip prep', subtasks: ['Check passport', 'Buy adapter'] },
    ...overrides,
  });

  it('adds checklist items to the task matched by title from the local read model', async () => {
    const seeded = seedLedgerTask('Trip prep');
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    const payload = result.result as any;
    expect(payload.type).toBe('task_subtasks_added');
    expect(payload.taskId).toBe(seeded.id);
    expect(getOfflineTaskById(USER_ID, USER_ID, seeded.id)?.checklistItems?.map((item: any) => item.displayName))
      .toEqual(['Check passport', 'Buy adapter']);
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'verified_success' });
  });

  it('blocks with no_task_match and records the blocked run when no local task matches', async () => {
    const step = addStep({ args: { title: 'Ghost task', subtasks: ['A'] } });

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'no_task_match' });
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'blocked' });
  });

  it('blocks with multiple_task_matches when the title is ambiguous locally', async () => {
    seedLedgerTask('Duplicate me');
    seedLedgerTask('Duplicate me');
    const step = addStep({ args: { title: 'Duplicate me', subtasks: ['A'] } });

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'multiple_task_matches' });
  });

  it('blocks when the normalized args are missing fields', async () => {
    const step = addStep({ args: {} });

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'task_with_subtasks_missing_fields' });
  });

  it('replays the stored result for a duplicate idempotent request', async () => {
    seedLedgerTask('Trip prep');
    const step = addStep();
    await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    const replay = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(replay.status).toBe('verified_success');
    expect((replay.result as any).replayed).toBe(true);
  });

  it('degrades to partial success when a checklist write fails', async () => {
    seedLedgerTask('Trip prep');
    ledgerControl.failChecklistFor = 'Buy adapter';
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'partial_success', error: 'task_subtasks_partial_verification' });
    expect((result.result as any).failedSubtasks).toEqual(['Buy adapter']);
  });

  it('falls back to the target identity when the read-back is unavailable', async () => {
    const seeded = seedLedgerTask('Trip prep');
    ledgerControl.transformGetById = () => null;
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result).toMatchObject({ status: 'partial_success', error: 'task_subtasks_partial_verification' });
    const payload = result.result as any;
    expect(payload.task).toMatchObject({ id: seeded.id, title: 'Trip prep', listId: '', listName: '' });
  });

  it('returns a reconciliation-pending result when the run reached a terminal state mid-write', async () => {
    seedLedgerTask('Trip prep');
    cancelRunsMidWrite();
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({
      status: 'verified_pending',
      error: 'action_run_reconciliation_pending',
      runUpdateAccepted: false,
    });
  });

  it('fails the persisted run when target resolution throws', async () => {
    ledgerControl.failSnapshot = () => { throw new Error('snapshot unavailable'); };
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_subtasks_add_failed' });
    expect(actionRunRow(step.idempotencyKey)?.error_json).toContain('snapshot unavailable');
  });

  it('records non-Error throws as failure messages on the run', async () => {
    ledgerControl.failSnapshot = () => { throw 'read_model_down'; };
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_subtasks_add_failed' });
    expect(actionRunRow(step.idempotencyKey)?.error_json).toContain('read_model_down');
  });

  it('legacy flag-off dispatch blocks when the provider lacks search or checklist support', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    const step = addStep();

    const result = await executeAddSubtasksToTaskStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'task_provider_missing_search_or_checklist' });
  });
});

describe('executeTaskMutationStep (ledger)', () => {
  it('create_checklist creates the task and adds only the well-formed string items', async () => {
    const step = buildStep({
      action: 'create_checklist',
      type: 'create_checklist',
      args: { title: 'Groceries checklist', notes: 'weekly run', list: 'Inbox', items: ['Milk', '', 42, 'Eggs'] },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    const payload = result.result as any;
    expect(payload.verified).toBe(true);
    expect(payload.checklistItems.map((item: any) => item.displayName)).toEqual(['Milk', 'Eggs']);
    expect(getOfflineTaskById(USER_ID, USER_ID, payload.task.id)).toMatchObject({ body: 'weekly run' });
    expect(actionRunRow(step.idempotencyKey)).toMatchObject({ status: 'verified_success' });
  });

  it('create_checklist verifies an itemless checklist without any checklist writes', async () => {
    const step = buildStep({
      action: 'create_checklist',
      type: 'create_checklist',
      args: { title: 'Empty checklist' },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, false);

    expect(result.status).toBe('verified_success');
    expect((result.result as any).checklistItems).toEqual([]);
  });

  it('delete_task journals the delete and verifies the row is gone locally', async () => {
    const seeded = seedLedgerTask('Delete me');
    const step = buildStep({
      action: 'delete_task',
      type: 'delete_task',
      args: { taskId: seeded.id },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    expect(result.result).toMatchObject({ taskId: seeded.id, verified: true, task: null });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM task_mutations WHERE user_id = ? AND operation = 'task.delete'",
    ).get(USER_ID)).toMatchObject({ count: 1 });
  });

  it('update_task applies direct title, notes, and reminder fields to the local row', async () => {
    const seeded = seedLedgerTask('Original title');
    const step = buildStep({
      action: 'update_task',
      type: 'update_task',
      args: { taskId: seeded.id, title: 'Fresh title', notes: 'Fresh notes', reminderAt: '2026-07-22T10:00:00.000Z' },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    expect(getOfflineTaskById(USER_ID, USER_ID, seeded.id)).toMatchObject({
      title: 'Fresh title',
      body: 'Fresh notes',
      dueDateTime: expect.stringContaining('2026-07-22'),
    });
  });

  it('update_task applies changedFields fallbacks including importance and status', async () => {
    const seeded = seedLedgerTask('Change me');
    const step = buildStep({
      action: 'update_task',
      type: 'update_task',
      args: {
        taskId: seeded.id,
        changedFields: {
          title: 'Changed title',
          body: 'Changed body',
          dueDateTime: '2026-07-23T10:00:00.000Z',
          importance: 'high',
          status: 'completed',
        },
      },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    expect(getOfflineTaskById(USER_ID, USER_ID, seeded.id)).toMatchObject({
      title: 'Changed title',
      body: 'Changed body',
      importance: 'high',
      status: 'completed',
    });
  });

  it('update_task prefers an explicit dueDateTime argument when no reminder is present', async () => {
    const seeded = seedLedgerTask('Due date direct');
    const step = buildStep({
      action: 'update_task',
      type: 'update_task',
      args: { taskId: seeded.id, dueDateTime: '2026-07-24T10:00:00.000Z' },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    expect(getOfflineTaskById(USER_ID, USER_ID, seeded.id)?.dueDateTime).toContain('2026-07-24');
  });

  it('complete_task resolves by title when the explicit task id is unknown', async () => {
    const seeded = seedLedgerTask('Fallback target');
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: { taskId: 'task_missing_id', title: 'Fallback target' },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result.status).toBe('verified_success');
    expect(getOfflineTaskById(USER_ID, USER_ID, seeded.id)?.status).toBe('completed');
  });

  it('blocks when neither task id nor title resolves a target', async () => {
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: {},
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'blocked', error: 'task_target_not_found_or_ambiguous' });
  });

  it('reports a local read-back mismatch when the row disappears after the write', async () => {
    const seeded = seedLedgerTask('Vanishing target');
    ledgerControl.transformGetById = () => null;
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: { taskId: seeded.id },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'partial_success', error: 'local_read_back_mismatch' });
    expect(result.result).toMatchObject({ taskId: seeded.id, listId: '', verified: false, task: null });
  });

  it('returns a reconciliation-pending result when the run reached a terminal state mid-write', async () => {
    const seeded = seedLedgerTask('Raced complete');
    cancelRunsMidWrite();
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: { taskId: seeded.id },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({
      status: 'verified_pending',
      error: 'action_run_reconciliation_pending',
      runUpdateAccepted: false,
    });
  });

  it('fails the persisted run when the ledger write throws', async () => {
    const seeded = seedLedgerTask('Journal locked');
    ledgerControl.beforeWrite = () => { throw new Error('journal locked'); };
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: { taskId: seeded.id },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_mutation_failed' });
    expect(actionRunRow(step.idempotencyKey)?.error_json).toContain('journal locked');
  });

  it('records non-Error ledger throws as failure messages on the run', async () => {
    const seeded = seedLedgerTask('String throw');
    ledgerControl.beforeWrite = () => { throw 'mutation_bus_down'; };
    const step = buildStep({
      action: 'complete_task',
      type: 'complete_task',
      args: { taskId: seeded.id },
    });

    const result = await executeTaskMutationStep(step, buildPlan(), buildInput(), getTaskProviderForUser, true);

    expect(result).toMatchObject({ status: 'failed', error: 'task_mutation_failed' });
    expect(actionRunRow(step.idempotencyKey)?.error_json).toContain('mutation_bus_down');
  });
});
