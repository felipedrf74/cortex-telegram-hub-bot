/**
 * M5 single-write-path acceptance (NEX-08 / NEX-09 / NEX-10).
 *
 * End-to-end against a REAL migrated database: chat writes (tool-executor
 * ms_todo_* tools and the chat-core-v2 unified complete) land in the
 * offline-first ledger — a task_mutations row exists, the task is instantly
 * readable through the offline read model (what the Tasks tab paints), and NO
 * provider write mock is called. The provider push belongs to the mutation
 * worker alone.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

const providerWriteSpies = {
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteTask: vi.fn(),
  createList: vi.fn(),
  deleteList: vi.fn(),
  moveTask: vi.fn(),
  addChecklistItem: vi.fn(),
};

vi.mock('../../../src/services/database', () => ({
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

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/services/user-service', () => ({
  resolveCanonicalUserId: vi.fn((userRef: unknown) => (typeof userRef === 'number' && userRef > 0 ? userRef : null)),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getOwnerBootstrapUser: vi.fn(() => null),
}));

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => false),
}));

// The provider surface: every write here would violate the single write path.
vi.mock('../../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: vi.fn(() => providerWriteSpies),
}));

vi.mock('../../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => false),
  getLists: vi.fn(),
  createList: vi.fn(),
  deleteList: vi.fn(),
  getTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteTask: vi.fn(),
  searchTasks: vi.fn(),
  getTasksDueInRange: vi.fn(),
  moveTask: vi.fn(),
  getChecklistItems: vi.fn(),
  addChecklistItem: vi.fn(),
}));

vi.mock('../../../src/services/cache-coherence-registry', () => ({
  invalidateTaskCaches: vi.fn(),
  invalidateCalendarCaches: vi.fn(),
  invalidateCookingDerivedCaches: vi.fn(),
  invalidateFinanceDerivedCaches: vi.fn(),
  invalidateOnboardingDerivedCaches: vi.fn(),
}));

vi.mock('../../../src/services/chat-core-v2/command-events', () => ({
  recordChatV2CommandEvent: vi.fn(),
}));

import {
  executeToolCall,
} from '../../../src/services/tool-executor';
import { runWithChatToolAuthorization } from '../../../src/services/chat-tool-authorization';
import { executeChatCoreV2Command } from '../../../src/services/chat-core-v2/command-executor';
import {
  getOfflineTaskById,
  getOfflineTaskLists,
  getOfflineTaskSnapshot,
} from '../../../src/services/task-store/offline-first-task-service';
import { getTaskForUser } from '../../../src/services/task-store/task-service';
import { computeContentHash } from '../../../src/services/task-store/unified-task-store';
import type { AICommandEnvelope } from '../../../src/services/chat-core-v2/types';

const USER_ID = 42;
const NOW = new Date('2026-07-17T10:00:00.000Z');

const runTool = (tool: string, input: Record<string, any>) => runWithChatToolAuthorization({
  userId: USER_ID,
  tenantId: USER_ID,
  confirmedDestructiveAction: true,
  confirmationSource: 'explicit_current_turn',
}, () => executeToolCall(tool, input, USER_ID, USER_ID));

function taskMutations(operation: string): Array<{ mutation_id: string; task_id: string | null; status: string; patch_json: string }> {
  return testDb.prepare(
    `SELECT mutation_id, task_id, status, patch_json
     FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
     ORDER BY created_at ASC`,
  ).all(USER_ID, USER_ID, operation) as Array<{ mutation_id: string; task_id: string | null; status: string; patch_json: string }>;
}

function expectNoProviderWrites(): void {
  for (const [name, spy] of Object.entries(providerWriteSpies)) {
    expect(spy, `provider.${name} must not be called on the single write path`).not.toHaveBeenCalled();
  }
}

function unifiedCompleteCommand(taskRowId: number, title: string, entityVersion: string): AICommandEnvelope<Record<string, unknown>> {
  return {
    commandId: `cmd_unified_${taskRowId}`,
    commandSchemaVersion: 'tasks.complete@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(USER_ID),
    userId: String(USER_ID),
    domain: 'tasks',
    commandType: 'tasks.complete',
    origin: 'chat',
    payload: {
      operation: 'complete',
      taskId: taskRowId,
      title,
      currentStatus: 'pending',
      targetStatus: 'completed',
    },
    basedOn: {
      entityIds: [`task:${taskRowId}`],
      entityVersions: { [`task:${taskRowId}`]: entityVersion },
      contextHash: 'ctx-unified',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: { [`task:${taskRowId}`]: entityVersion },
      requiredPermissionsVersion: `chat-v2-permissions:${USER_ID}:${USER_ID}:tasks:v1`,
      invariants: [{
        type: 'task_status',
        description: 'Task must still be pending when the preview is confirmed.',
        check: 'task_is_pending',
      }],
    },
    authorization: {
      actorUserId: String(USER_ID),
      tenantId: String(USER_ID),
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${USER_ID}:${USER_ID}:tasks:v1`,
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: `chat-v2:${USER_ID}:${USER_ID}:tasks.complete:${taskRowId}:cmd_unified_${taskRowId}`,
  };
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('M5 single write path acceptance', () => {
  it('NEX-08: a chat-created task is journaled, instantly visible in the Tasks-tab read model, and touches no provider', async () => {
    const result = await runTool('ms_todo_create_task', {
      title: 'Ledger milk run',
      body: 'From chat',
      importance: 'high',
      list_name: 'Inbox',
    });

    expect(result).toMatchObject({ success: true, title: 'Ledger milk run' });
    expect(String(result.id)).toMatch(/^task_/);

    // Ledger truth: a task.create mutation row exists (local-mode users
    // short-circuit to synced; connected providers queue for the worker).
    const creates = taskMutations('task.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].task_id).toBe(result.id);

    // Instant visibility through the offline read model (the Tasks tab).
    const readBack = getOfflineTaskById(USER_ID, USER_ID, result.id);
    expect(readBack).toMatchObject({ title: 'Ledger milk run', importance: 'high', status: 'notStarted' });
    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    expect(snapshot.tasks.map((task: any) => task.id)).toContain(result.id);

    expectNoProviderWrites();
  });

  it('NEX-09: a chat completion is journaled against the ledger so the next pull cannot revert it', async () => {
    const created = await runTool('ms_todo_create_task', { title: 'Complete me', list_name: 'Inbox' });
    const completed = await runTool('ms_todo_complete_task', { task_id: created.id, list_id: 'whatever' });

    expect(completed).toEqual({ success: true, title: 'Complete me' });
    expect(taskMutations('task.complete')).toHaveLength(1);
    expect(getOfflineTaskById(USER_ID, USER_ID, created.id)?.status).toBe('completed');
    expectNoProviderWrites();
  });

  it('NEX-08 (chat-core-v2): the unified complete command journals task.complete and verifies from the local store', async () => {
    const created = await runTool('ms_todo_create_task', { title: 'Unified complete target', list_name: 'Inbox' });
    const rowId = (testDb.prepare(
      'SELECT id FROM unified_tasks WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?',
    ).get(USER_ID, USER_ID, created.id) as { id: number }).id;
    const current = getTaskForUser(USER_ID, rowId);
    expect(current?.status).toBe('pending');
    const entityVersion = computeContentHash(current!);

    const result = await executeChatCoreV2Command({
      command: unifiedCompleteCommand(rowId, 'Unified complete target', entityVersion),
      capabilityId: 'tasks.complete',
      userId: USER_ID,
      tenantId: USER_ID,
      locale: 'en-US',
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, status: 'verified', completedTaskId: rowId });
    expect(taskMutations('task.complete')).toHaveLength(1);
    expect(getOfflineTaskById(USER_ID, USER_ID, created.id)?.status).toBe('completed');
    expectNoProviderWrites();
  });

  it('NEX-10: chat list create/delete run through the ledger and update GET /lists truth instantly', async () => {
    const createdList = await runTool('ms_todo_create_list', { name: 'Chat List' });
    expect(createdList).toEqual({ success: true, data: { id: expect.any(String), displayName: 'Chat List' } });
    expect(getOfflineTaskLists(USER_ID, USER_ID).lists).toContainEqual(
      expect.objectContaining({ id: createdList.data.id, name: 'Chat List' }),
    );
    expect(taskMutations('list.create')).toHaveLength(1);

    const deleted = await runTool('ms_todo_delete_list', { list_id: createdList.data.id });
    expect(deleted).toEqual({ success: true, data: undefined });
    expect(getOfflineTaskLists(USER_ID, USER_ID).lists.map((list: any) => list.name)).not.toContain('Chat List');
    expect(taskMutations('list.delete')).toHaveLength(1);

    expectNoProviderWrites();
  });

  it('flag off restores the legacy direct-provider path end to end', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    providerWriteSpies.createList.mockResolvedValue({ success: true, data: { id: 'provider-list-1', displayName: 'Legacy List' } });

    const result = await runTool('ms_todo_create_list', { name: 'Legacy List' });

    expect(result).toEqual({ success: true, data: { id: 'provider-list-1', displayName: 'Legacy List' } });
    expect(providerWriteSpies.createList).toHaveBeenCalledWith('Legacy List');
    expect(taskMutations('list.create')).toHaveLength(0);
  });
});
