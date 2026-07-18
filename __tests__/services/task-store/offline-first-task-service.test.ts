import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../helpers/apply-migrations';

const mockResolveTaskProvider = vi.fn(() => 'nexus');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

let testDb: Database.Database;

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: (...args: unknown[]) => mockResolveTaskProvider(...args),
}));

import {
  addOfflineTaskChecklistItem,
  assignOfflineTaskProvider,
  countOfflineRecentlyDeletedTasks,
  countPendingMutations,
  createOfflineFirstTask,
  getOfflineRecentlyDeletedTasks,
  createOfflineFirstTaskList,
  deleteOfflineFirstTaskList,
  resolveOfflineCaptureListName,
  resolveOfflineTaskListRef,
  getOfflineTaskById,
  getOfflineFilteredTasks,
  getOfflineTaskLists,
  getOfflineTaskChanges,
  getOfflineTaskSnapshot,
  getOfflineTasksForList,
  recordLocalTaskMutation,
  restoreOfflineFirstTask,
  retryOfflineTaskSync,
  toggleOfflineTaskChecklistItem,
  updateOfflineFirstTask,
} from '../../../src/services/task-store/offline-first-task-service';
import { recordTaskSyncIssue } from '../../../src/services/task-store/task-sync-issues';

const USER_ID = 42;

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(42, 42);
  vi.clearAllMocks();
  mockResolveTaskProvider.mockReturnValue('nexus');
});

describe('offline-first task service', () => {
  it('backfills legacy native task rows into the offline-first read model', () => {
    const listId = Number(testDb.prepare(
      `INSERT INTO native_task_lists (user_id, name, is_default)
       VALUES (?, 'Inbox', 1)`,
    ).run(USER_ID).lastInsertRowid);
    const activeTaskId = Number(testDb.prepare(
      `INSERT INTO native_tasks (
         user_id, list_id, title, body, importance, status, due_date_time, created_at, updated_at
       ) VALUES (?, ?, 'Legacy active task', 'Bring this forward', 'high', 'notStarted',
         '2026-06-24T09:00:00Z', '2026-06-23 08:00:00', '2026-06-23 08:00:00')`,
    ).run(USER_ID, listId).lastInsertRowid);
    const completedTaskId = Number(testDb.prepare(
      `INSERT INTO native_tasks (
         user_id, list_id, title, importance, status, completed_at, created_at, updated_at
       ) VALUES (?, ?, 'Legacy done task', 'normal', 'completed',
         '2026-06-23T10:00:00Z', '2026-06-23 07:00:00', '2026-06-23 10:00:00')`,
    ).run(USER_ID, listId).lastInsertRowid);
    testDb.prepare(
      `INSERT INTO native_task_checklist_items (user_id, task_id, display_name, is_checked, position)
       VALUES (?, ?, 'Checklist carry-over', 0, 1)`,
    ).run(USER_ID, activeTaskId);

    const lists = getOfflineTaskLists(USER_ID, USER_ID);
    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    const activeTask = snapshot.tasks.find((task: any) => task.id === `task_native_${activeTaskId}`);
    const completedTask = snapshot.tasks.find((task: any) => task.id === `task_native_${completedTaskId}`);
    const completedHistory = getOfflineTasksForList(USER_ID, USER_ID, String(listId), { status: 'completed' });
    const completedHistoryTask = completedHistory.tasks.find((task: any) => task.id === `task_native_${completedTaskId}`);
    const unifiedCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM unified_tasks
       WHERE user_id = ? AND external_id LIKE 'native_task_%'`,
    ).get(USER_ID) as { count: number };

    expect(lists.lists).toEqual([
      expect.objectContaining({ name: 'Inbox', taskCount: 1 }),
    ]);
    expect(activeTask).toEqual(expect.objectContaining({
      id: `task_native_${activeTaskId}`,
      title: 'Legacy active task',
      status: 'notStarted',
      listName: 'Inbox',
      importance: 'high',
      dueDateTime: '2026-06-24T09:00:00Z',
      syncProvider: 'nexus',
      syncState: 'local_only',
    }));
    expect(activeTask?.checklistItems).toEqual([
      { id: '1', displayName: 'Checklist carry-over', isChecked: false },
    ]);
    expect(completedTask).toBeUndefined();
    expect(completedHistoryTask).toEqual(expect.objectContaining({
      id: `task_native_${completedTaskId}`,
      title: 'Legacy done task',
      status: 'completed',
    }));
    expect(unifiedCount.count).toBe(2);

    getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    const repeatCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM unified_tasks
       WHERE user_id = ? AND external_id LIKE 'native_task_%'`,
    ).get(USER_ID) as { count: number };
    expect(repeatCount.count).toBe(2);
  });

  it('keeps completed provider-missing tasks out of active snapshots without surfacing stale provider warnings', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Completed provider missing should stay in history',
      listName: 'Tasks',
      dueDateTime: '2026-06-01T09:00:00Z',
      clientMutationId: 'ios-completed-provider-missing',
      idempotencyKey: 'idem-ios-completed-provider-missing',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET provider = 'ms_todo',
           status = 'completed',
           completed_at = '2026-06-02T09:00:00Z',
           sync_state = 'provider_missing',
           updated_at = '2026-06-02T09:00:00Z'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(USER_ID, USER_ID, created.task.id);
    recordTaskSyncIssue({
      tenantId: USER_ID,
      userId: USER_ID,
      taskId: created.task.id,
      provider: 'ms_todo',
      code: 'provider_task_missing',
      message: 'Microsoft To Do no longer has this task.',
    });

    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    const activeTask = snapshot.tasks.find((task: any) => task.id === created.task.id);
    const completedHistory = getOfflineTasksForList(USER_ID, USER_ID, String(created.task.listId), { status: 'completed' });
    const completedTask = completedHistory.tasks.find((task: any) => task.id === created.task.id);

    expect(activeTask).toBeUndefined();
    expect(snapshot.activePage.tasks.find((task: any) => task.id === created.task.id)).toBeUndefined();
    expect(snapshot.smartCounts.overdue).toBe(0);
    expect(completedTask).toEqual(expect.objectContaining({
      id: created.task.id,
      status: 'completed',
      syncState: 'provider_missing',
    }));
    expect(completedTask?.syncWarnings.map((warning: any) => warning.code)).not.toContain('provider_task_missing');
  });

  it('completes provider-missing tasks locally even when the provider list mapping is absent', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Provider orphan should still complete',
      listName: 'Rotina Matinal',
      dueDateTime: '2026-06-01T09:00:00Z',
      clientMutationId: 'ios-provider-orphan-create',
      idempotencyKey: 'idem-ios-provider-orphan-create',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET provider = 'ms_todo',
           project_id = NULL,
           project_name = 'Rotina Matinal',
           sync_state = 'provider_missing',
           updated_at = '2026-06-02T09:00:00Z'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(USER_ID, USER_ID, created.task.id);
    recordTaskSyncIssue({
      tenantId: USER_ID,
      userId: USER_ID,
      taskId: created.task.id,
      provider: 'ms_todo',
      code: 'provider_task_missing',
      message: 'Microsoft To Do no longer has this task.',
    });

    const before = getOfflineFilteredTasks(USER_ID, USER_ID, 'overdue');
    const staleActive = before.tasks.find((task: any) => task.id === created.task.id);
    expect(staleActive).toEqual(expect.objectContaining({
      id: created.task.id,
      listId: null,
      listName: 'Rotina Matinal',
      syncState: 'provider_missing',
    }));
    expect(staleActive?.syncWarnings.map((warning: any) => warning.code)).toContain('provider_task_missing');

    const completed = recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.complete',
      clientMutationId: 'ios-complete-provider-orphan',
      idempotencyKey: 'idem-ios-complete-provider-orphan',
    });

    const after = getOfflineFilteredTasks(USER_ID, USER_ID, 'overdue');
    const completedRead = getOfflineTaskById(USER_ID, USER_ID, created.task.id);
    const mutation = testDb.prepare(
      `SELECT status, task_id
       FROM task_mutations
       WHERE operation = 'task.complete'`,
    ).get() as { status: string; task_id: string };

    expect(completed.task).toEqual(expect.objectContaining({
      id: created.task.id,
      status: 'completed',
      listId: null,
      syncState: 'queued',
    }));
    expect(completed.task.syncWarnings.map((warning: any) => warning.code)).not.toContain('provider_task_missing');
    expect(after.tasks.find((task: any) => task.id === created.task.id)).toBeUndefined();
    expect(completedRead).toEqual(expect.objectContaining({
      id: created.task.id,
      status: 'completed',
      listId: null,
    }));
    expect(mutation).toEqual({ status: 'queued', task_id: created.task.id });
  });

  it('filters completed-like list rows before counting and before applying page limits', () => {
    const active = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Active after completed rows',
      listName: 'Limit Harness',
      dueDateTime: '2026-12-31T10:00:00Z',
      importance: 'low',
      clientMutationId: 'ios-list-limit-active',
      idempotencyKey: 'idem-ios-list-limit-active',
    });
    const completed = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Completed should not fill active page',
      listName: 'Limit Harness',
      dueDateTime: '2026-01-01T10:00:00Z',
      importance: 'high',
      clientMutationId: 'ios-list-limit-completed',
      idempotencyKey: 'idem-ios-list-limit-completed',
    });
    const done = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Done should not count active',
      listName: 'Limit Harness',
      dueDateTime: '2026-01-02T10:00:00Z',
      importance: 'high',
      clientMutationId: 'ios-list-limit-done',
      idempotencyKey: 'idem-ios-list-limit-done',
    });
    const cancelled = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Cancelled should not count active',
      listName: 'Limit Harness',
      dueDateTime: '2026-01-03T10:00:00Z',
      importance: 'high',
      clientMutationId: 'ios-list-limit-cancelled',
      idempotencyKey: 'idem-ios-list-limit-cancelled',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET status = ?, completed_at = '2026-01-04T10:00:00Z', priority = 3, updated_at = '2026-01-04 10:00:00'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run('completed', USER_ID, USER_ID, completed.task.id);
    testDb.prepare(
      `UPDATE unified_tasks
       SET status = ?, completed_at = '2026-01-04T10:00:00Z', priority = 3, updated_at = '2026-01-04 10:01:00'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run('done', USER_ID, USER_ID, done.task.id);
    testDb.prepare(
      `UPDATE unified_tasks
       SET status = ?, completed_at = '2026-01-04T10:00:00Z', priority = 3, updated_at = '2026-01-04 10:02:00'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run('cancelled', USER_ID, USER_ID, cancelled.task.id);

    const lists = getOfflineTaskLists(USER_ID, USER_ID);
    const list = lists.lists.find((item) => item.id === active.task.listId);
    const activePage = getOfflineTasksForList(USER_ID, USER_ID, active.task.listId!, {
      status: 'active',
      pageSize: 1,
    });
    const completedPage = getOfflineTasksForList(USER_ID, USER_ID, active.task.listId!, {
      status: 'completed',
      pageSize: 5,
    });
    const allPage = getOfflineTasksForList(USER_ID, USER_ID, active.task.listId!, { pageSize: 5 });

    expect(list).toEqual(expect.objectContaining({ name: 'Limit Harness', taskCount: 1 }));
    expect(activePage.scope).toBe('active');
    expect(activePage.tasks.map((task) => task.title)).toEqual(['Active after completed rows']);
    expect(completedPage.scope).toBe('completed');
    expect(completedPage.tasks.map((task) => task.id).sort()).toEqual([
      completed.task.id,
      done.task.id,
      cancelled.task.id,
    ].sort());
    expect(completedPage.tasks.map((task) => task.status).sort()).toEqual(['cancelled', 'completed', 'completed']);
    expect(allPage.scope).toBe('all');
    expect(allPage.tasks.map((task) => task.id).sort()).toEqual([
      active.task.id,
      completed.task.id,
      done.task.id,
      cancelled.task.id,
    ].sort());
  });

  it('does not let legacy native backfill overwrite app-side task edits', () => {
    const listId = Number(testDb.prepare(
      `INSERT INTO native_task_lists (user_id, name, is_default)
       VALUES (?, 'Inbox', 1)`,
    ).run(USER_ID).lastInsertRowid);
    const nativeTaskId = Number(testDb.prepare(
      `INSERT INTO native_tasks (user_id, list_id, title, importance, status, created_at, updated_at)
       VALUES (?, ?, 'Native before edit', 'normal', 'notStarted',
         '2026-06-23 08:00:00', '2026-06-23 08:00:00')`,
    ).run(USER_ID, listId).lastInsertRowid);

    getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: `task_native_${nativeTaskId}`,
      title: 'Edited in app',
      clientMutationId: 'ios-edit-native-bridge',
      idempotencyKey: 'idem-ios-edit-native-bridge',
    });
    testDb.prepare(
      `UPDATE native_tasks
       SET title = 'Native stale echo', updated_at = '2026-06-23 09:00:00'
       WHERE id = ? AND user_id = ?`,
    ).run(nativeTaskId, USER_ID);

    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    const task = snapshot.tasks.find((item: any) => item.id === `task_native_${nativeTaskId}`);

    expect(task?.title).toBe('Edited in app');
  });

  it('accepts repeated create mutations idempotently', () => {
    const first = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Write offline plan',
      listName: 'Tasks',
      clientMutationId: 'ios-create-1',
      idempotencyKey: 'idem-create-1',
    });
    const second = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Write offline plan',
      listName: 'Tasks',
      clientMutationId: 'ios-create-1',
      idempotencyKey: 'idem-create-1',
    });

    const taskCount = testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks').get() as { count: number };
    const mutationCount = testDb.prepare('SELECT COUNT(*) AS count FROM task_mutations').get() as { count: number };
    const duplicatePreventionHits = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM task_sync_observability_events
       WHERE event_type = 'duplicate_prevention_hit'
         AND operation = 'task.create'`,
    ).get() as { count: number };

    expect(second.idempotentReplay).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(taskCount.count).toBe(1);
    expect(mutationCount.count).toBe(1);
    expect(duplicatePreventionHits.count).toBe(1);
  });

  it('does not queue provider sync for local-only completion mutations', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Local only task',
      listName: 'Tasks',
      clientMutationId: 'ios-create-local',
      idempotencyKey: 'idem-create-local',
    });

    const completed = recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.complete',
      clientMutationId: 'ios-complete-local',
      idempotencyKey: 'idem-complete-local',
    });
    const mutation = testDb.prepare(
      `SELECT status
       FROM task_mutations
       WHERE operation = 'task.complete'`,
    ).get() as { status: string };

    expect(completed.task.syncState).toBe('local_only');
    expect(mutation.status).toBe('synced');
  });

  it('saves locally and records a typed warning when provider container mapping is missing', () => {
    mockResolveTaskProvider.mockReturnValue('ms_todo');

    const result = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Provider target missing',
      listName: 'Work',
      clientMutationId: 'ios-create-provider-missing',
      idempotencyKey: 'idem-create-provider-missing',
    });
    const task = getOfflineTaskById(USER_ID, USER_ID, result.task.id);
    const issue = testDb.prepare(
      `SELECT code, provider, state
       FROM task_sync_issues
       WHERE tenant_id = ? AND user_id = ? AND task_id = ?`,
    ).get(USER_ID, USER_ID, result.task.id) as { code: string; provider: string; state: string };

    expect(task?.syncState).toBe('failed_permanent');
    expect(issue).toEqual({ code: 'provider_list_missing', provider: 'ms_todo', state: 'open' });
    expect(task?.syncWarnings.map((warning) => warning.code)).toContain('provider_list_missing');
  });

  it('hides legacy Nexus mirror lists when a mapped Microsoft To Do provider list exists', () => {
    const providerListId = Number(testDb.prepare(
      `INSERT INTO unified_projects (
         user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
       ) VALUES (?, ?, 'ms_todo', 'ms-list-tarefas', 'Tarefas', 1, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID).lastInsertRowid);
    const mirrorListId = Number(testDb.prepare(
      `INSERT INTO unified_projects (
         user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
       ) VALUES (?, ?, 'nexus', 'nexus-list-tarefas', 'Tarefas', 1, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID).lastInsertRowid);
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
         provider_container_id, sync_direction
       ) VALUES ('mapping-legacy-ms-tarefas', ?, ?, ?, 'ms_todo', 'todo_list', 'ms-list-tarefas', 'bidirectional')`,
    ).run(USER_ID, USER_ID, String(mirrorListId));
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_id, project_name,
         title, status, priority, tags, provider_data, synced_at
       ) VALUES (?, ?, 'ms_todo', 'ms-task-1', ?, 'Tarefas',
         'Provider task', 'pending', 0, '[]', '{}', datetime('now'))`,
    ).run(USER_ID, USER_ID, providerListId);
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_id, project_name,
         title, status, priority, tags, provider_data, synced_at
       ) VALUES (?, ?, 'ms_todo', 'ms-task-orphan', NULL, 'Tarefas',
         'Orphan provider task', 'pending', 0, '[]', '{}', datetime('now'))`,
    ).run(USER_ID, USER_ID);
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_id, project_name,
         title, status, priority, tags, provider_data, synced_at
       ) VALUES (?, ?, 'ms_todo', 'ms-task-stale-project', 999999, 'Tarefas',
         'Stale project task', 'pending', 0, '[]', '{}', datetime('now'))`,
    ).run(USER_ID, USER_ID);

    const lists = getOfflineTaskLists(USER_ID, USER_ID).lists.filter((list) => list.name === 'Tarefas');
    const providerListTasks = getOfflineTasksForList(USER_ID, USER_ID, String(providerListId), {
      status: 'active',
      listName: 'Tarefas',
    });
    const staleMirrorListTasks = getOfflineTasksForList(USER_ID, USER_ID, String(mirrorListId), {
      status: 'active',
      listName: 'Tarefas',
    });

    expect(lists).toEqual([
      expect.objectContaining({ id: String(providerListId), name: 'Tarefas', taskCount: 3 }),
    ]);
    expect(providerListTasks.tasks.map((task) => task.title).sort()).toEqual([
      'Orphan provider task',
      'Provider task',
      'Stale project task',
    ]);
    expect(staleMirrorListTasks.tasks.map((task) => task.title).sort()).toEqual([
      'Orphan provider task',
      'Provider task',
      'Stale project task',
    ]);
  });

  it('records assign-provider mutations without inventing missing provider containers', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Assign provider later',
      listName: 'Work',
      clientMutationId: 'ios-create-assign-provider',
      idempotencyKey: 'idem-create-assign-provider',
    });

    const first = assignOfflineTaskProvider(USER_ID, USER_ID, {
      taskId: created.task.id,
      provider: 'ms_todo',
      clientMutationId: 'ios-assign-provider-1',
      idempotencyKey: 'idem-assign-provider-1',
    });
    const replay = assignOfflineTaskProvider(USER_ID, USER_ID, {
      taskId: created.task.id,
      provider: 'ms_todo',
      clientMutationId: 'ios-assign-provider-1',
      idempotencyKey: 'idem-assign-provider-1',
    });
    const mutation = testDb.prepare(
      `SELECT operation, status
       FROM task_mutations
       WHERE client_mutation_id = ?`,
    ).get('ios-assign-provider-1') as { operation: string; status: string };
    const link = testDb.prepare(
      `SELECT provider, provider_task_id, provider_list_id, link_state
       FROM task_provider_links
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).get(created.task.id) as { provider: string; provider_task_id: string | null; provider_list_id: string | null; link_state: string };
    const issue = testDb.prepare(
      `SELECT code, provider
       FROM task_sync_issues
       WHERE task_id = ? AND state = 'open'`,
    ).get(created.task.id) as { code: string; provider: string };

    expect(first.task.syncState).toBe('failed_permanent');
    expect(first.task.syncWarnings.map((warning) => warning.code)).toContain('provider_list_missing');
    expect(replay.idempotentReplay).toBe(true);
    expect(mutation).toEqual({ operation: 'task.assign_provider', status: 'failed' });
    expect(link).toEqual({
      provider: 'ms_todo',
      provider_task_id: null,
      provider_list_id: null,
      link_state: 'stale',
    });
    expect(issue).toEqual({ code: 'provider_list_missing', provider: 'ms_todo' });
  });

  it('retries failed provider sync against the existing provider link', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Retry provider sync',
      listName: 'Work',
      clientMutationId: 'ios-create-retry-sync',
      idempotencyKey: 'idem-create-retry-sync',
    });
    expect(created.task.listId).toBeTruthy();
    const listId = created.task.listId!;
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
         provider_container_id, sync_direction
       ) VALUES ('mapping-ms-work', ?, ?, ?, 'ms_todo', 'todo_list', 'ms-list-work', 'bidirectional')`,
    ).run(USER_ID, USER_ID, listId);
    assignOfflineTaskProvider(USER_ID, USER_ID, {
      taskId: created.task.id,
      provider: 'ms_todo',
      clientMutationId: 'ios-assign-provider-retry',
      idempotencyKey: 'idem-assign-provider-retry',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET sync_state = 'failed_retryable'
       WHERE nexus_task_id = ?`,
    ).run(created.task.id);
    testDb.prepare(
      `UPDATE task_provider_links
       SET link_state = 'stale'
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).run(created.task.id);

    const retry = retryOfflineTaskSync(USER_ID, USER_ID, {
      taskId: created.task.id,
      clientMutationId: 'ios-retry-sync-1',
      idempotencyKey: 'idem-retry-sync-1',
    });
    const mutation = testDb.prepare(
      `SELECT operation, status
       FROM task_mutations
       WHERE client_mutation_id = ?`,
    ).get('ios-retry-sync-1') as { operation: string; status: string };
    const link = testDb.prepare(
      `SELECT link_state
       FROM task_provider_links
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).get(created.task.id) as { link_state: string };

    expect(retry.task.syncState).toBe('queued');
    expect(mutation).toEqual({ operation: 'task.retry_sync', status: 'queued' });
    expect(link.link_state).toBe('pending_create');
  });

  it('returns deltas when SQLite-style timestamps are newer than ISO cursors', () => {
    const result = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Mixed timestamp delta',
      listName: 'Tasks',
      clientMutationId: 'ios-create-mixed-timestamp',
      idempotencyKey: 'idem-create-mixed-timestamp',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET updated_at = '2026-06-23 02:00:00'
       WHERE nexus_task_id = ?`,
    ).run(result.task.id);

    const changes = getOfflineTaskChanges(USER_ID, USER_ID, '2026-06-23T01:59:00.000Z|');

    expect(changes.upserts).toEqual([
      expect.objectContaining({ id: result.task.id, title: 'Mixed timestamp delta' }),
    ]);
    expect(changes.cursor).toBe(`2026-06-23T02:00:00.000Z|${result.task.id}`);
  });

  it('uses a composite cursor so same-second delta pages do not lose overflow rows', () => {
    const timestamp = '2026-06-23 02:00:00';
    const insert = testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_id, project_name,
         title, description, status, priority, provider_data, created_at, updated_at,
         nexus_task_id, sync_state, source_of_truth
       ) VALUES (?, ?, 'nexus', ?, NULL, 'Tasks', ?, '', 'pending', 0, '{}', ?, ?, ?, 'synced', 'nexus')`,
    );
    for (let i = 0; i < 600; i += 1) {
      const id = `task-bulk-${String(i).padStart(4, '0')}`;
      insert.run(USER_ID, USER_ID, id, `Bulk ${i}`, timestamp, timestamp, id);
    }

    const first = getOfflineTaskChanges(USER_ID, USER_ID, '2026-06-23T01:59:59.000Z|');
    const second = getOfflineTaskChanges(USER_ID, USER_ID, first.cursor);
    const allIds = [...first.upserts, ...second.upserts].map((task) => task.id);

    expect(first.upserts).toHaveLength(500);
    expect(first.cursor).toBe('2026-06-23T02:00:00.000Z|task-bulk-0499');
    expect(second.upserts).toHaveLength(100);
    expect(new Set(allIds).size).toBe(600);
    expect(allIds).toContain('task-bulk-0000');
    expect(allIds).toContain('task-bulk-0599');
  });

  it('uses the change_seq index for task changes pagination', () => {
    const plan = testDb.prepare(
      `EXPLAIN QUERY PLAN
       SELECT *
       FROM unified_tasks
       WHERE tenant_id = ? AND user_id = ?
         AND (? = '' OR change_seq > ? OR (change_seq = ? AND nexus_task_id > ?))
       ORDER BY change_seq ASC, nexus_task_id ASC
       LIMIT 500`,
    ).all(USER_ID, USER_ID, '2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.000Z', '') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    expect(detail).toContain('idx_unified_tasks_changes_seq');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('persists checklist items as local Nexus metadata and replays duplicate mutations', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Checklist parent',
      listName: 'Tasks',
      clientMutationId: 'ios-create-checklist-parent',
      idempotencyKey: 'idem-create-checklist-parent',
    });
    const first = addOfflineTaskChecklistItem(USER_ID, USER_ID, {
      taskId: created.task.id,
      displayName: 'Pack cable',
      itemId: 'checklist-local-1',
      clientMutationId: 'ios-checklist-add-1',
      idempotencyKey: 'idem-checklist-add-1',
    });
    const second = addOfflineTaskChecklistItem(USER_ID, USER_ID, {
      taskId: created.task.id,
      displayName: 'Pack cable',
      itemId: 'checklist-local-1',
      clientMutationId: 'ios-checklist-add-1',
      idempotencyKey: 'idem-checklist-add-1',
    });
    const toggled = toggleOfflineTaskChecklistItem(USER_ID, USER_ID, {
      taskId: created.task.id,
      itemId: 'checklist-local-1',
      isChecked: true,
      clientMutationId: 'ios-checklist-toggle-1',
      idempotencyKey: 'idem-checklist-toggle-1',
    });

    const mutationCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM task_mutations
       WHERE operation IN ('task.checklist.add', 'task.checklist.update')`,
    ).get() as { count: number };
    const task = getOfflineTaskById(USER_ID, USER_ID, created.task.id);

    expect(first.item.id).toBe('checklist-local-1');
    expect(second.idempotentReplay).toBe(true);
    expect(toggled.item.isChecked).toBe(true);
    expect(task?.checklistItems).toEqual([
      { id: 'checklist-local-1', displayName: 'Pack cable', isChecked: true },
    ]);
    expect(mutationCount.count).toBe(2);
  });

  it('keeps local task lists and tasks isolated when tenantId differs from userId', () => {
    const tenantA = 420;
    const tenantB = 421;
    const first = createOfflineFirstTask(tenantA, USER_ID, {
      title: 'Tenant A local task',
      listName: 'Shared List Name',
      clientMutationId: 'tenant-a-create-1',
      idempotencyKey: 'tenant-a-idem-1',
    });
    const second = createOfflineFirstTask(tenantB, USER_ID, {
      title: 'Tenant B local task',
      listName: 'Shared List Name',
      clientMutationId: 'tenant-b-create-1',
      idempotencyKey: 'tenant-b-idem-1',
    });

    const tenantALists = getOfflineTaskLists(tenantA, USER_ID);
    const tenantBLists = getOfflineTaskLists(tenantB, USER_ID);

    expect(first.task.id).not.toBe(second.task.id);
    expect(getOfflineTaskById(tenantA, USER_ID, first.task.id)?.title).toBe('Tenant A local task');
    expect(getOfflineTaskById(tenantA, USER_ID, second.task.id)).toBeNull();
    expect(getOfflineTaskById(tenantB, USER_ID, first.task.id)).toBeNull();
    expect(tenantALists.lists).toEqual([
      expect.objectContaining({ id: first.task.listId, name: 'Shared List Name', taskCount: 1 }),
    ]);
    expect(tenantBLists.lists).toEqual([
      expect.objectContaining({ id: second.task.listId, name: 'Shared List Name', taskCount: 1 }),
    ]);
  });

  it('marks the old provider link pending_delete and queues cleanup when reassigning providers', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Switch providers',
      listName: 'Work',
      clientMutationId: 'ios-create-provider-switch',
      idempotencyKey: 'idem-create-provider-switch',
    });
    const listId = created.task.listId!;
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
         provider_container_id, sync_direction
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bidirectional')`,
    ).run('mapping-provider-switch-ms', USER_ID, USER_ID, listId, 'ms_todo', 'todo_list', 'ms-list-work');
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
         provider_container_id, sync_direction
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bidirectional')`,
    ).run('mapping-provider-switch-todoist', USER_ID, USER_ID, listId, 'todoist', 'project', 'todoist-project-work');

    assignOfflineTaskProvider(USER_ID, USER_ID, {
      taskId: created.task.id,
      provider: 'ms_todo',
      clientMutationId: 'ios-assign-ms-before-switch',
      idempotencyKey: 'idem-assign-ms-before-switch',
    });
    testDb.prepare(
      `UPDATE task_provider_links
       SET link_state = 'linked', provider_task_id = 'ms-task-1'
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).run(created.task.id);

    assignOfflineTaskProvider(USER_ID, USER_ID, {
      taskId: created.task.id,
      provider: 'todoist',
      clientMutationId: 'ios-assign-todoist-after-ms',
      idempotencyKey: 'idem-assign-todoist-after-ms',
    });

    const oldLink = testDb.prepare(
      `SELECT link_state
       FROM task_provider_links
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).get(created.task.id) as { link_state: string };
    const cleanupMutation = testDb.prepare(
      `SELECT operation, status, patch_json
       FROM task_mutations
       WHERE task_id = ? AND operation = 'task.delete'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(created.task.id) as { operation: string; status: string; patch_json: string };

    expect(oldLink.link_state).toBe('pending_delete');
    expect(cleanupMutation.operation).toBe('task.delete');
    expect(cleanupMutation.status).toBe('queued');
    expect(JSON.parse(cleanupMutation.patch_json)).toEqual(expect.objectContaining({
      reason: 'provider_reassignment_cleanup',
      providerLinkProvider: 'ms_todo',
      providerTaskId: 'ms-task-1',
    }));
  });

  describe('resolveCreateTargetProject via createOfflineFirstTask', () => {
    function seedProviderProjectRow(
      provider: 'ms_todo' | 'todoist',
      externalId: string,
      name: string,
      isDefault = 0,
    ): number {
      return Number(testDb.prepare(
        `INSERT INTO unified_projects (
           user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      ).run(USER_ID, USER_ID, provider, externalId, name, isDefault).lastInsertRowid);
    }

    /**
     * Mirrors how ensureTaskContainerMappingForProviderProject
     * (unified-task-store.ts) writes container mappings post-de22b1a2: keyed
     * by the PROVIDER unified_projects row id, not the nexus mirror row id.
     */
    function seedProviderKeyedMapping(providerRowId: number, containerId: string): void {
      testDb.prepare(
        `INSERT INTO task_container_mappings (
           id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
           provider_container_id, sync_direction
         ) VALUES (?, ?, ?, ?, 'ms_todo', 'todo_list', ?, 'bidirectional')`,
      ).run(`mapping-provider-row-${providerRowId}`, USER_ID, USER_ID, String(providerRowId), containerId);
    }

    it('creates into the visible provider list so a mapped create queues instead of parking (NEX-05 fixed)', () => {
      const providerRowId = seedProviderProjectRow('ms_todo', 'AAMk-groceries', 'Groceries', 1);
      seedProviderKeyedMapping(providerRowId, 'AAMk-groceries');
      mockResolveTaskProvider.mockReturnValue('ms_todo');

      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Buy milk',
        listName: 'Groceries',
        clientMutationId: 'ios-create-nex05-fixed',
        idempotencyKey: 'idem-create-nex05-fixed',
      });
      const link = testDb.prepare(
        `SELECT provider, provider_list_id, link_state
         FROM task_provider_links
         WHERE task_id = ? AND provider = 'ms_todo'`,
      ).get(created.task.id) as { provider: string; provider_list_id: string | null; link_state: string };
      const mutation = testDb.prepare(
        `SELECT status FROM task_mutations WHERE client_mutation_id = ?`,
      ).get('ios-create-nex05-fixed') as { status: string };
      const issueCount = testDb.prepare(
        `SELECT COUNT(*) AS count FROM task_sync_issues WHERE task_id = ?`,
      ).get(created.task.id) as { count: number };

      expect(created.task.listId).toBe(String(providerRowId));
      expect(created.task.listName).toBe('Groceries');
      expect(created.task.syncState).toBe('queued');
      expect(link).toEqual({
        provider: 'ms_todo',
        provider_list_id: 'AAMk-groceries',
        link_state: 'pending_create',
      });
      expect(mutation.status).toBe('queued');
      expect(issueCount.count).toBe(0);
    });

    it('matches the provider list name case-insensitively without minting a nexus mirror', () => {
      const providerRowId = seedProviderProjectRow('ms_todo', 'AAMk-groceries', 'Groceries');
      mockResolveTaskProvider.mockReturnValue('ms_todo');

      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Buy oat milk',
        listName: 'gROCERIES',
        clientMutationId: 'ios-create-case-insensitive',
        idempotencyKey: 'idem-create-case-insensitive',
      });
      const nexusMirrorCount = testDb.prepare(
        `SELECT COUNT(*) AS count FROM unified_projects WHERE user_id = ? AND provider = 'nexus'`,
      ).get(USER_ID) as { count: number };

      expect(created.task.listId).toBe(String(providerRowId));
      expect(created.task.listName).toBe('Groceries');
      expect(created.task.syncState).toBe('queued');
      expect(nexusMirrorCount.count).toBe(0);
    });

    it('falls back to a nexus list and parks exactly as before when no provider list matches the name', () => {
      seedProviderProjectRow('ms_todo', 'AAMk-groceries', 'Groceries');
      mockResolveTaskProvider.mockReturnValue('ms_todo');

      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Unmatched list falls back',
        listName: 'Personal',
        clientMutationId: 'ios-create-unmatched-name',
        idempotencyKey: 'idem-create-unmatched-name',
      });
      const nexusRow = testDb.prepare(
        `SELECT id FROM unified_projects WHERE user_id = ? AND provider = 'nexus' AND name = 'Personal'`,
      ).get(USER_ID) as { id: number };
      const mutation = testDb.prepare(
        `SELECT status FROM task_mutations WHERE client_mutation_id = ?`,
      ).get('ios-create-unmatched-name') as { status: string };
      const issue = testDb.prepare(
        `SELECT code, provider, state FROM task_sync_issues WHERE task_id = ?`,
      ).get(created.task.id) as { code: string; provider: string; state: string };

      expect(created.task.listId).toBe(String(nexusRow.id));
      expect(created.task.syncState).toBe('failed_permanent');
      expect(created.task.syncWarnings.map((warning) => warning.code)).toContain('provider_list_missing');
      expect(mutation.status).toBe('failed');
      expect(issue).toEqual({ code: 'provider_list_missing', provider: 'ms_todo', state: 'open' });
    });

    it('ignores provider rows for local-only users and stays local_only in a nexus list', () => {
      const providerRowId = seedProviderProjectRow('ms_todo', 'AAMk-groceries', 'Groceries', 1);
      // Default mockResolveTaskProvider return value is 'nexus' (local-only).

      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Local-only stays local',
        listName: 'Groceries',
        clientMutationId: 'ios-create-local-only-name-clash',
        idempotencyKey: 'idem-create-local-only-name-clash',
      });
      const project = testDb.prepare(
        `SELECT provider FROM unified_projects WHERE id = ?`,
      ).get(Number(created.task.listId)) as { provider: string };
      const mutation = testDb.prepare(
        `SELECT status FROM task_mutations WHERE client_mutation_id = ?`,
      ).get('ios-create-local-only-name-clash') as { status: string };
      const link = testDb.prepare(
        `SELECT provider FROM task_provider_links WHERE task_id = ?`,
      ).get(created.task.id) as { provider: string };

      expect(created.task.listId).not.toBe(String(providerRowId));
      expect(project.provider).toBe('nexus');
      expect(created.task.syncState).toBe('local_only');
      expect(mutation.status).toBe('synced');
      expect(link.provider).toBe('nexus_local');
    });
  });

  describe('canonical link syncProvider (M4)', () => {
    it('reports the active provider link target as syncProvider for a nexus-origin task', () => {
      const providerRowId = Number(testDb.prepare(
        `INSERT INTO unified_projects (
           user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
         ) VALUES (?, ?, 'ms_todo', 'AAMk-groceries', 'Groceries', 1, 0, datetime('now'))`,
      ).run(USER_ID, USER_ID).lastInsertRowid);
      testDb.prepare(
        `INSERT INTO task_container_mappings (
           id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
           provider_container_id, sync_direction
         ) VALUES ('mapping-sync-provider-m4', ?, ?, ?, 'ms_todo', 'todo_list', 'AAMk-groceries', 'bidirectional')`,
      ).run(USER_ID, USER_ID, String(providerRowId));
      mockResolveTaskProvider.mockReturnValue('ms_todo');

      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Buy milk',
        listName: 'Groceries',
        clientMutationId: 'ios-create-sync-provider-link',
        idempotencyKey: 'idem-create-sync-provider-link',
      });
      const fetched = getOfflineTaskById(USER_ID, USER_ID, created.task.id);
      const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
      const snapshotTask = snapshot.tasks.find((task: any) => task.id === created.task.id);
      const row = testDb.prepare(
        `SELECT provider FROM unified_tasks WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).get(USER_ID, USER_ID, created.task.id) as { provider: string };
      const link = testDb.prepare(
        `SELECT provider, provider_task_id FROM task_provider_links WHERE task_id = ?`,
      ).get(created.task.id) as { provider: string; provider_task_id: string | null };

      // The row keeps its nexus origin identity; the DTO reports the sync
      // TARGET from the active link even before the push assigns a provider
      // task id.
      expect(row.provider).toBe('nexus');
      expect(link).toEqual({ provider: 'ms_todo', provider_task_id: null });
      expect(created.task.syncProvider).toBe('ms_todo');
      expect(fetched?.syncProvider).toBe('ms_todo');
      expect(snapshotTask?.syncProvider).toBe('ms_todo');
    });

    it('keeps syncProvider nexus for local-only tasks without provider links (regression)', () => {
      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Local only sync provider',
        listName: 'Tasks',
        clientMutationId: 'ios-create-sync-provider-local',
        idempotencyKey: 'idem-create-sync-provider-local',
      });
      const fetched = getOfflineTaskById(USER_ID, USER_ID, created.task.id);
      const link = testDb.prepare(
        `SELECT provider FROM task_provider_links WHERE task_id = ?`,
      ).get(created.task.id) as { provider: string };

      expect(link.provider).toBe('nexus_local');
      expect(created.task.syncProvider).toBe('nexus');
      expect(fetched?.syncProvider).toBe('nexus');
    });
  });

  describe('freshness.providerStates connectivity truth', () => {
    // `providerStates()` checks OAuth connectivity through a lazy CJS
    // `require('../oauth-store')`. Under Vitest that call is a NATIVE require
    // (vite-node's wrapper), so `vi.mock` cannot intercept it — patching
    // `Module._load` is the only deterministic seam. The patch is scoped to
    // this describe block and restored after every test.
    const mockOAuthIsConnected = vi.fn((_userId: number, _provider: string) => true);
    const originalModuleLoad = (Module as any)._load;

    beforeEach(() => {
      mockOAuthIsConnected.mockImplementation(() => true);
      (Module as any)._load = function patchedLoad(request: string, ...rest: unknown[]) {
        if (typeof request === 'string' && /(^|\/)oauth-store$/.test(request)) {
          return {
            isConnected: (userId: number, provider: string) => mockOAuthIsConnected(userId, provider),
          };
        }
        return originalModuleLoad.call(this, request, ...rest);
      };
    });

    afterEach(() => {
      (Module as any)._load = originalModuleLoad;
    });

    function seedSyncState(provider: string, status: string, errorMessage: string | null = null): void {
      testDb.prepare(
        `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status, error_message)
         VALUES (?, ?, '2026-07-01T10:00:00Z', ?, ?)`,
      ).run(USER_ID, provider, status, errorMessage);
    }

    function readProviderState(provider: string) {
      const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 10 });
      return snapshot.freshness.providerStates.find((state: any) => state.provider === provider);
    }

    it('reports disconnected when OAuth is gone even if a stale idle sync-state row survives', () => {
      seedSyncState('ms_todo', 'idle');
      mockOAuthIsConnected.mockImplementation((_userId, provider) => provider !== 'outlook');

      const msTodo = readProviderState('ms_todo');

      expect(mockOAuthIsConnected).toHaveBeenCalledWith(USER_ID, 'outlook');
      expect(mockOAuthIsConnected).toHaveBeenCalledWith(USER_ID, 'todoist');
      expect(msTodo).toEqual({
        provider: 'ms_todo',
        state: 'disconnected',
        lastSyncedAt: '2026-07-01T10:00:00Z',
        lastErrorCode: undefined,
      });
    });

    it('keeps the mapped auth error code on the disconnected state when an error row remains', () => {
      seedSyncState('ms_todo', 'error', 'Microsoft Graph rejected the request: 401 unauthorized');
      mockOAuthIsConnected.mockImplementation(() => false);

      expect(readProviderState('ms_todo')).toEqual(expect.objectContaining({
        provider: 'ms_todo',
        state: 'disconnected',
        lastErrorCode: 'provider_auth_expired',
      }));
    });

    it('maps auth-flavored sync errors to provider_auth_expired while OAuth is still connected', () => {
      seedSyncState('ms_todo', 'error', 'Token refresh failed: invalid_grant (AADSTS700082 token expired)');

      expect(readProviderState('ms_todo')).toEqual(expect.objectContaining({
        provider: 'ms_todo',
        state: 'failed',
        lastSyncedAt: '2026-07-01T10:00:00Z',
        lastErrorCode: 'provider_auth_expired',
      }));
    });

    it('keeps generic sync errors on provider_sync_error', () => {
      seedSyncState('todoist', 'error', 'graph timeout after 30000ms');

      expect(readProviderState('todoist')).toEqual(expect.objectContaining({
        provider: 'todoist',
        state: 'failed',
        lastErrorCode: 'provider_sync_error',
      }));
    });

    it('still reports connected for an idle row when OAuth is connected (regression)', () => {
      seedSyncState('ms_todo', 'idle');

      expect(readProviderState('ms_todo')).toEqual({
        provider: 'ms_todo',
        state: 'connected',
        lastSyncedAt: '2026-07-01T10:00:00Z',
      });
      expect(readProviderState('todoist')).toEqual({ provider: 'todoist', state: 'disconnected' });
    });
  });

  describe('superseded mutation status (M2B, internal-only)', () => {
    it('countPendingMutations never counts superseded rows — they are retired history', () => {
      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Superseded rows are not pending',
        listName: 'Tasks',
        clientMutationId: 'ios-superseded-count',
        idempotencyKey: 'idem-ios-superseded-count',
      });
      const insertMutation = testDb.prepare(
        `INSERT INTO task_mutations (
           mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
           task_id, operation, patch_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'task.update', '{}', ?)`,
      );
      insertMutation.run('m-superseded-1', 'c-superseded-1', 'i-superseded-1', USER_ID, USER_ID, created.task.id, 'superseded');
      insertMutation.run('m-conflict-1', 'c-conflict-1', 'i-conflict-1', USER_ID, USER_ID, created.task.id, 'conflict');

      // The local-only create short-circuits to 'synced', so exactly the
      // conflict row is pending: superseded contributes nothing.
      expect(countPendingMutations(USER_ID, USER_ID)).toBe(1);
      expect(getOfflineTaskLists(USER_ID, USER_ID).pendingMutationCount).toBe(1);
    });
  });

  describe('recordLocalTaskMutation guards', () => {
    it('throws NOT_FOUND for a task id the store has never seen', () => {
      expect(() => recordLocalTaskMutation(USER_ID, USER_ID, {
        taskId: 'task-ghost-mutation-target',
        operation: 'task.complete',
        patch: { status: 'completed' },
      })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    });
  });
});

describe('M5B list operations through the ledger', () => {
  const listMutations = (operation: string) => testDb.prepare(
    `SELECT * FROM task_mutations WHERE tenant_id = ? AND user_id = ? AND operation = ? ORDER BY created_at ASC`,
  ).all(USER_ID, USER_ID, operation) as Array<{ mutation_id: string; task_id: string | null; status: string; patch_json: string }>;

  it('creates a local list that is instantly visible and journals a synced list.create for local-mode users (NEX-10)', () => {
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, {
      name: 'Groceries',
      clientMutationId: 'c-list-create-1',
      idempotencyKey: 'i-list-create-1',
    });

    const lists = getOfflineTaskLists(USER_ID, USER_ID);
    expect(lists.lists).toContainEqual(expect.objectContaining({ id: created.list.id, name: 'Groceries', taskCount: 0 }));

    const mutations = listMutations('list.create');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].task_id).toBeNull();
    expect(mutations[0].status).toBe('synced');
    expect(JSON.parse(mutations[0].patch_json)).toEqual(expect.objectContaining({
      listId: created.list.id,
      name: 'Groceries',
      provider: 'nexus_local',
    }));
  });

  it('queues the provider push for ms_todo users while the local row is already visible', () => {
    mockResolveTaskProvider.mockReturnValue('ms_todo');
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, {
      name: 'Errands',
      clientMutationId: 'c-list-create-ms',
    });

    expect(getOfflineTaskLists(USER_ID, USER_ID).lists).toContainEqual(
      expect.objectContaining({ id: created.list.id, name: 'Errands' }),
    );
    const mutations = listMutations('list.create');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].status).toBe('queued');
    expect(JSON.parse(mutations[0].patch_json)).toEqual(expect.objectContaining({ provider: 'ms_todo' }));
  });

  it('replays list.create idempotently and reuses same-name visible lists without journaling duplicates', () => {
    const first = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Projects', idempotencyKey: 'i-list-idem' });
    const replay = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Projects', idempotencyKey: 'i-list-idem' });
    const sameName = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'projects', idempotencyKey: 'i-list-other' });

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.list).toEqual(first.list);
    expect(sameName.idempotentReplay).toBe(true);
    expect(sameName.list.id).toBe(first.list.id);
    expect(listMutations('list.create')).toHaveLength(1);
  });

  it('rejects empty list names with BAD_REQUEST', () => {
    expect(() => createOfflineFirstTaskList(USER_ID, USER_ID, { name: '   ' }))
      .toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('deletes a local list instantly, soft-deletes its tasks, and journals a synced list.delete for local rows', () => {
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Doomed' });
    const task = createOfflineFirstTask(USER_ID, USER_ID, { title: 'Doomed task', listName: 'Doomed' });

    const result = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: created.list.id });

    expect(result.deleted).toBe(true);
    expect(getOfflineTaskLists(USER_ID, USER_ID).lists.map((list: any) => list.name)).not.toContain('Doomed');
    const taskRow = testDb.prepare(
      `SELECT is_deleted, deleted_at FROM unified_tasks WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).get(USER_ID, USER_ID, task.task.id) as { is_deleted: number; deleted_at: string | null };
    expect(taskRow.is_deleted).toBe(1);
    expect(taskRow.deleted_at).toBeTruthy();

    const mutations = listMutations('list.delete');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].task_id).toBeNull();
    expect(mutations[0].status).toBe('synced');
    expect(JSON.parse(mutations[0].patch_json)).toEqual(expect.objectContaining({
      listId: created.list.id,
      provider: 'nexus_local',
      providerContainerId: null,
    }));
  });

  it('journals the PROVIDER container id — never the local numeric row id — for ms_todo-backed lists (NEX-10 delete bug pin)', () => {
    testDb.prepare(
      `INSERT INTO unified_projects (user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at)
       VALUES (?, ?, 'ms_todo', 'AAMk-provider-list-9', 'Work', 0, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID);
    const providerRowId = String((testDb.prepare(
      `SELECT id FROM unified_projects WHERE user_id = ? AND external_id = 'AAMk-provider-list-9'`,
    ).get(USER_ID) as { id: number }).id);

    const result = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: providerRowId });

    expect(result.deleted).toBe(true);
    const mutations = listMutations('list.delete');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].status).toBe('queued');
    const patch = JSON.parse(mutations[0].patch_json);
    expect(patch.providerContainerId).toBe('AAMk-provider-list-9');
    expect(patch.providerContainerId).not.toBe(providerRowId);
    expect(patch.provider).toBe('ms_todo');
  });

  it('hard-deletes the legacy native mirror of a deleted nexus list so the backfill cannot resurrect it', () => {
    const nativeListId = Number(testDb.prepare(
      `INSERT INTO native_task_lists (user_id, name, is_default) VALUES (?, 'Mercado', 0)`,
    ).run(USER_ID).lastInsertRowid);
    testDb.prepare(
      `INSERT INTO native_tasks (user_id, list_id, title, status) VALUES (?, ?, 'Comprar pão', 'notStarted')`,
    ).run(USER_ID, nativeListId);
    // Backfill materializes the unified mirror of the native list.
    const before = getOfflineTaskLists(USER_ID, USER_ID);
    const mirror = before.lists.find((list: any) => list.name === 'Mercado');
    expect(mirror).toBeTruthy();

    deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: mirror!.id });

    expect(getOfflineTaskLists(USER_ID, USER_ID).lists.map((list: any) => list.name)).not.toContain('Mercado');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_task_lists WHERE user_id = ?').get(USER_ID)).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(USER_ID)).toEqual({ count: 0 });
  });

  it('refuses to delete missing or default lists', () => {
    expect(() => deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: '999999' }))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    const inbox = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Inbox' });
    expect(() => deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: inbox.list.id }))
      .toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('resolves capture list names and list refs against the local read model', () => {
    const inbox = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Inbox' });
    createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Groceries' });

    expect(resolveOfflineCaptureListName(USER_ID, USER_ID, null)).toBe('Inbox');
    expect(resolveOfflineCaptureListName(USER_ID, USER_ID, 'groceries')).toBe('Groceries');
    // Unknown explicit names keep offline-first capture semantics (the ledger
    // creates the local list) instead of the legacy LIST_NOT_FOUND failure.
    expect(resolveOfflineCaptureListName(USER_ID, USER_ID, 'Brand New List')).toBe('Brand New List');

    expect(resolveOfflineTaskListRef(USER_ID, USER_ID, inbox.list.id)).toEqual({ id: inbox.list.id, name: 'Inbox' });
    expect(resolveOfflineTaskListRef(USER_ID, USER_ID, null, 'groceries')?.name).toBe('Groceries');
    expect(resolveOfflineTaskListRef(USER_ID, USER_ID, 'nope', 'missing')).toBeNull();
  });

  it('resolveOfflineTaskListRef falls back to name matching on the ref and to null without any reference', () => {
    createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Groceries' });

    // A ref that is neither a row id nor an external id still resolves as a name.
    expect(resolveOfflineTaskListRef(USER_ID, USER_ID, 'groceries')?.name).toBe('Groceries');
    // No usable reference at all resolves to null instead of guessing.
    expect(resolveOfflineTaskListRef(USER_ID, USER_ID, null, null)).toBeNull();
  });

  it('resolveOfflineCaptureListName falls back to the default list when no capture alias exists', () => {
    createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Personal' });
    createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Work' });
    testDb.prepare(
      `UPDATE unified_projects SET is_default = 1 WHERE user_id = ? AND name = 'Work'`,
    ).run(USER_ID);

    expect(resolveOfflineCaptureListName(USER_ID, USER_ID, null)).toBe('Work');
  });

  it('rejects a list delete without a usable list reference', () => {
    expect(() => deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: '' }))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('rejects a list create without a name payload', () => {
    expect(() => createOfflineFirstTaskList(USER_ID, USER_ID, {} as any))
      .toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('replays list.delete idempotently without journaling a second mutation', () => {
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Delete twice' });

    const first = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: created.list.id, idempotencyKey: 'i-list-del-idem' });
    const replay = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: created.list.id, idempotencyKey: 'i-list-del-idem' });

    expect(first.idempotentReplay).toBe(false);
    expect(replay).toMatchObject({
      deleted: true,
      idempotentReplay: true,
      mutationId: first.mutationId,
      idempotencyKey: 'i-list-del-idem',
    });
    expect(listMutations('list.delete')).toHaveLength(1);
  });

  it('replays a list.create whose journaled patch lost its identity with empty-string fallbacks', () => {
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES ('m-legacy-create', 'c-legacy-create', 'i-legacy-create', ?, ?, NULL, 'list.create', '{}', datetime('now'), 'synced')`,
    ).run(USER_ID, USER_ID);

    const replay = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Recovered', idempotencyKey: 'i-legacy-create' });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.list).toEqual({ id: '', name: 'Recovered' });
  });

  it('cascades an ms_todo list delete onto its hidden nexus mirror via the container mapping', () => {
    testDb.prepare(
      `INSERT INTO unified_projects (user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at)
       VALUES (?, ?, 'ms_todo', 'AAMk-mirrored-list', 'Mirrored', 0, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID);
    const providerRowId = String((testDb.prepare(
      `SELECT id FROM unified_projects WHERE user_id = ? AND external_id = 'AAMk-mirrored-list'`,
    ).get(USER_ID) as { id: number }).id);
    testDb.prepare(
      `INSERT INTO unified_projects (user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at)
       VALUES (?, ?, 'nexus', 'nexus_list_mirrored', 'Mirrored', 0, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID);
    const mirrorRowId = String((testDb.prepare(
      `SELECT id FROM unified_projects WHERE user_id = ? AND external_id = 'nexus_list_mirrored'`,
    ).get(USER_ID) as { id: number }).id);
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider,
         provider_container_type, provider_container_id, sync_direction
       ) VALUES ('map-mirror-1', ?, ?, ?, 'ms_todo', 'todo_list', 'AAMk-mirrored-list', 'bidirectional')`,
    ).run(USER_ID, USER_ID, mirrorRowId);
    // A stale mapping onto a row that no longer exists must not break the delete.
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider,
         provider_container_type, provider_container_id, sync_direction
       ) VALUES ('map-mirror-2', ?, ?, '987654', 'ms_todo', 'todo_list', 'AAMk-mirrored-list', 'bidirectional')`,
    ).run(USER_ID, USER_ID);

    const result = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: providerRowId });

    expect(result.deleted).toBe(true);
    const remaining = testDb.prepare(
      `SELECT id FROM unified_projects WHERE user_id = ? AND id IN (?, ?)`,
    ).all(USER_ID, Number(providerRowId), Number(mirrorRowId));
    expect(remaining).toEqual([]);
    const patch = JSON.parse(listMutations('list.delete')[0].patch_json);
    expect(patch.providerContainerId).toBe('AAMk-mirrored-list');
  });

  it('deletes a nexus list through its ms_todo mapping and removes the mapped provider row', () => {
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Mapped local' });
    testDb.prepare(
      `INSERT INTO unified_projects (user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at)
       VALUES (?, ?, 'ms_todo', 'AAMk-mapped-7', 'Mapped local', 0, 0, datetime('now'))`,
    ).run(USER_ID, USER_ID);
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider,
         provider_container_type, provider_container_id, sync_direction
       ) VALUES ('map-local-1', ?, ?, ?, 'ms_todo', 'todo_list', 'AAMk-mapped-7', 'bidirectional')`,
    ).run(USER_ID, USER_ID, created.list.id);

    const result = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: created.list.id });

    expect(result.deleted).toBe(true);
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM unified_projects WHERE user_id = ? AND external_id = 'AAMk-mapped-7'`,
    ).get(USER_ID)).toEqual({ count: 0 });
    const patch = JSON.parse(listMutations('list.delete')[0].patch_json);
    expect(patch).toMatchObject({ provider: 'ms_todo', providerContainerId: 'AAMk-mapped-7' });
  });

  it('deletes a nexus list whose ms_todo mapping has no surviving provider row', () => {
    const created = createOfflineFirstTaskList(USER_ID, USER_ID, { name: 'Orphan mapped' });
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider,
         provider_container_type, provider_container_id, sync_direction
       ) VALUES ('map-orphan-1', ?, ?, ?, 'ms_todo', 'todo_list', 'AAMk-orphan-9', 'bidirectional')`,
    ).run(USER_ID, USER_ID, created.list.id);

    const result = deleteOfflineFirstTaskList(USER_ID, USER_ID, { listId: created.list.id });

    expect(result.deleted).toBe(true);
    const patch = JSON.parse(listMutations('list.delete')[0].patch_json);
    expect(patch).toMatchObject({ provider: 'ms_todo', providerContainerId: 'AAMk-orphan-9' });
  });
});

// ── M6: push-kick wiring + task.delete availability holdback ─────────

import {
  registerTaskMutationKick,
  _resetTaskMutationKickRegistryForTests,
} from '../../../src/services/task-store/task-mutation-kick';

describe('M6 push-kick wiring and delete holdback', () => {
  const kick = vi.fn(() => true);

  beforeEach(() => {
    kick.mockClear();
    registerTaskMutationKick(kick);
  });

  afterEach(() => {
    _resetTaskMutationKickRegistryForTests();
  });

  it('kicks provider-bound writes, never local-only writes, never deletes', () => {
    // Local-only create (nexus target) journals status 'synced' → no kick.
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Kick wiring task',
      listName: 'Tasks',
      clientMutationId: 'ios-kick-create',
      idempotencyKey: 'idem-kick-create',
    });
    expect(kick).not.toHaveBeenCalled();

    // Simulate a provider-linked row: subsequent writes journal 'queued'.
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'synced'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(USER_ID, USER_ID, created.task.id);

    updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      title: 'Kick wiring task (edited)',
      clientMutationId: 'ios-kick-update',
      idempotencyKey: 'idem-kick-update',
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(USER_ID, USER_ID);

    recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.complete',
      clientMutationId: 'ios-kick-complete',
      idempotencyKey: 'idem-kick-complete',
      patch: { status: 'completed' },
    });
    expect(kick).toHaveBeenCalledTimes(2);

    // task.delete journals WITHOUT a kick — the undo holdback owns delivery.
    const before = Date.now();
    const deleted = recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.delete',
      clientMutationId: 'ios-kick-delete',
      idempotencyKey: 'idem-kick-delete',
      patch: { deleted: true },
    });
    expect(kick).toHaveBeenCalledTimes(2);

    const mutation = testDb.prepare(
      `SELECT status, available_at FROM task_mutations WHERE mutation_id = ?`,
    ).get(deleted.mutationId) as { status: string; available_at: string | null };
    expect(mutation.status).toBe('queued');
    // 10s undo holdback (± scheduling slack).
    const availableAtMs = Date.parse(String(mutation.available_at));
    expect(availableAtMs).toBeGreaterThanOrEqual(before + 9_000);
    expect(availableAtMs).toBeLessThanOrEqual(Date.now() + 11_000);
    const row = testDb.prepare(
      `SELECT sync_state, is_deleted FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(created.task.id) as { sync_state: string; is_deleted: number };
    expect(row).toEqual({ sync_state: 'deleted_pending_sync', is_deleted: 1 });
  });

  it('leaves local-only deletes immediately available (no holdback, no kick)', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Local-only delete',
      listName: 'Tasks',
      clientMutationId: 'ios-local-delete-create',
      idempotencyKey: 'idem-local-delete-create',
    });
    const deleted = recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.delete',
      clientMutationId: 'ios-local-delete',
      idempotencyKey: 'idem-local-delete',
      patch: { deleted: true },
    });

    const mutation = testDb.prepare(
      `SELECT status, available_at FROM task_mutations WHERE mutation_id = ?`,
    ).get(deleted.mutationId) as { status: string; available_at: string | null };
    // local_only short-circuit: nothing to push, nothing to hold back.
    expect(mutation).toEqual({ status: 'synced', available_at: null });
    expect(kick).not.toHaveBeenCalled();
  });

  it('kicks provider-bound list creates through the ledger', () => {
    mockResolveTaskProvider.mockReturnValue('ms_todo');

    const result = createOfflineFirstTaskList(USER_ID, USER_ID, {
      name: 'Kicked list',
      clientMutationId: 'ios-kick-list-create',
      idempotencyKey: 'idem-kick-list-create',
    });

    expect(result.mutationId).not.toBeNull();
    expect(kick).toHaveBeenCalledTimes(1);
    const mutation = testDb.prepare(
      `SELECT status FROM task_mutations WHERE mutation_id = ?`,
    ).get(result.mutationId) as { status: string };
    expect(mutation.status).toBe('queued');
  });
});

// ── M9: task restore (undo delete) ───────────────────────────────────

describe('M9 restoreOfflineFirstTask', () => {
  const kick = vi.fn(() => true);

  beforeEach(() => {
    kick.mockClear();
    registerTaskMutationKick(kick);
  });

  afterEach(() => {
    _resetTaskMutationKickRegistryForTests();
  });

  /** Create a task and hand it a linked ms_todo provider identity. */
  function createProviderLinkedTask(suffix: string): { taskId: string; linkId: string } {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: `Restore harness ${suffix}`,
      listName: 'Tasks',
      clientMutationId: `ios-restore-create-${suffix}`,
      idempotencyKey: `idem-restore-create-${suffix}`,
    });
    testDb.prepare(
      `UPDATE task_provider_links
       SET provider = 'ms_todo',
           provider_account_id = 'ms_todo:42',
           provider_task_id = ?,
           provider_list_id = 'ms-list-1',
           provider_version = 'etag-1',
           ownership = 'nexus_created',
           link_state = 'linked'
       WHERE tenant_id = ? AND user_id = ? AND task_id = ?`,
    ).run(`ms-task-${suffix}`, USER_ID, USER_ID, created.task.id);
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'synced'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(USER_ID, USER_ID, created.task.id);
    const link = testDb.prepare(
      `SELECT id FROM task_provider_links WHERE task_id = ?`,
    ).get(created.task.id) as { id: string };
    return { taskId: created.task.id, linkId: link.id };
  }

  function deleteTask(taskId: string, suffix: string) {
    return recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId,
      operation: 'task.delete',
      clientMutationId: `ios-restore-delete-${suffix}`,
      idempotencyKey: `idem-restore-delete-${suffix}`,
      patch: { deleted: true },
    });
  }

  it('path (a): supersedes a held delete inside the holdback — tombstone cleared, link untouched, no re-push journaled', () => {
    const { taskId } = createProviderLinkedTask('held');
    const deleted = deleteTask(taskId, 'held');
    kick.mockClear();

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId });

    expect(result).toEqual(expect.objectContaining({
      restored: true,
      path: 'superseded_delete',
      idempotentReplay: false,
    }));
    expect(result.task).toEqual(expect.objectContaining({
      id: taskId,
      status: 'notStarted',
      syncState: 'synced',
      deletedAt: null,
    }));
    const deleteMutation = testDb.prepare(
      `SELECT status, last_error_code FROM task_mutations WHERE mutation_id = ?`,
    ).get(deleted.mutationId) as { status: string; last_error_code: string | null };
    expect(deleteMutation).toEqual({ status: 'superseded', last_error_code: 'restore_superseded_delete' });
    const row = testDb.prepare(
      `SELECT is_deleted, deleted_at, status, sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { is_deleted: number; deleted_at: string | null; status: string; sync_state: string };
    expect(row).toEqual({ is_deleted: 0, deleted_at: null, status: 'pending', sync_state: 'synced' });
    // The held delete never touched the link, so restore must not either.
    const link = testDb.prepare(
      `SELECT provider_task_id, link_state FROM task_provider_links WHERE task_id = ?`,
    ).get(taskId) as { provider_task_id: string; link_state: string };
    expect(link).toEqual({ provider_task_id: 'ms-task-held', link_state: 'linked' });
    // No re-push journaled and nothing pending — path (a) is provider-silent.
    const updates = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE task_id = ? AND operation = 'task.update'`,
    ).get(taskId) as { count: number };
    expect(updates.count).toBe(0);
    expect(countPendingMutations(USER_ID, USER_ID)).toBe(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it('path (a): leaves reassignment-cleanup deletes pending and re-queues the row behind them', () => {
    const { taskId } = createProviderLinkedTask('cleanup');
    deleteTask(taskId, 'cleanup');
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES ('mutation-cleanup-delete', 'client-cleanup-delete', 'idem-cleanup-delete', ?, ?, ?, 'task.delete', ?, ?, 'queued')`,
    ).run(USER_ID, USER_ID, taskId, JSON.stringify({
      reason: 'provider_reassignment_cleanup',
      providerLinkProvider: 'todoist',
    }), new Date().toISOString());

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId });

    expect(result.path).toBe('superseded_delete');
    // The cleanup delete targets an old provider copy of the (now live)
    // task — it must keep pushing, and it keeps the row 'queued'.
    const cleanup = testDb.prepare(
      `SELECT status FROM task_mutations WHERE mutation_id = 'mutation-cleanup-delete'`,
    ).get() as { status: string };
    expect(cleanup.status).toBe('queued');
    const row = testDb.prepare(
      `SELECT is_deleted, sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { is_deleted: number; sync_state: string };
    expect(row).toEqual({ is_deleted: 0, sync_state: 'queued' });
  });

  it('path (a): resolves the sync issue a FAILED delete attempt recorded', () => {
    const { taskId } = createProviderLinkedTask('failed-delete');
    const deleted = deleteTask(taskId, 'failed-delete');
    testDb.prepare(
      `UPDATE task_mutations SET status = 'failed', last_error_code = 'provider_timeout'
       WHERE mutation_id = ?`,
    ).run(deleted.mutationId);
    recordTaskSyncIssue({
      tenantId: USER_ID,
      userId: USER_ID,
      taskId,
      provider: 'ms_todo',
      code: 'provider_timeout',
    });

    restoreOfflineFirstTask(USER_ID, USER_ID, { taskId });

    const issue = testDb.prepare(
      `SELECT state FROM task_sync_issues WHERE task_id = ? AND code = 'provider_timeout'`,
    ).get(taskId) as { state: string };
    expect(issue.state).toBe('resolved');
  });

  it('path (a): a held delete with no provider link restores to local_only', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Restore local held delete',
      listName: 'Tasks',
      clientMutationId: 'ios-restore-local-held-create',
      idempotencyKey: 'idem-restore-local-held-create',
    });
    // Hand-craft the deleted_pending_sync tombstone + held delete (defensive
    // shape: a provider-bound delete whose link was never provisioned).
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, status = 'cancelled', sync_state = 'deleted_pending_sync'
       WHERE nexus_task_id = ?`,
    ).run(new Date().toISOString(), created.task.id);
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES ('mutation-local-held-delete', 'client-local-held-delete', 'idem-local-held-delete', ?, ?, ?, 'task.delete', '{}', ?, 'queued')`,
    ).run(USER_ID, USER_ID, created.task.id, new Date().toISOString());

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: created.task.id });

    expect(result.path).toBe('superseded_delete');
    const row = testDb.prepare(
      `SELECT is_deleted, sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(created.task.id) as { is_deleted: number; sync_state: string };
    expect(row).toEqual({ is_deleted: 0, sync_state: 'local_only' });
  });

  it('path (b): after a pushed delete, revives the orphaned link as pending_create and journals ONE queued full-content re-push', () => {
    const { taskId, linkId } = createProviderLinkedTask('pushed');
    const deleted = deleteTask(taskId, 'pushed');
    // Simulate the worker having pushed the delete: mutation delivered, link
    // orphaned with its provider id surrendered (M4 invariant), row synced.
    testDb.prepare(`UPDATE task_mutations SET status = 'synced', available_at = NULL WHERE mutation_id = ?`).run(deleted.mutationId);
    testDb.prepare(
      `UPDATE task_provider_links SET provider_task_id = NULL, link_state = 'orphaned' WHERE id = ?`,
    ).run(linkId);
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'synced' WHERE nexus_task_id = ?`,
    ).run(taskId);
    recordTaskSyncIssue({
      tenantId: USER_ID,
      userId: USER_ID,
      taskId,
      provider: 'ms_todo',
      code: 'provider_task_missing',
    });
    kick.mockClear();

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, {
      taskId,
      clientMutationId: 'ios-restore-pushed',
      idempotencyKey: 'idem-restore-pushed',
    });

    expect(result).toEqual(expect.objectContaining({ restored: true, path: 'undeleted', idempotentReplay: false }));
    expect(result.task).toEqual(expect.objectContaining({ id: taskId, syncState: 'queued', deletedAt: null }));
    const link = testDb.prepare(
      `SELECT provider_task_id, provider_version, link_state, provider_list_id FROM task_provider_links WHERE id = ?`,
    ).get(linkId) as { provider_task_id: string | null; provider_version: string | null; link_state: string; provider_list_id: string };
    // Canonical-links re-push: NULL provider id in pending_create re-arms the
    // worker's create-recovery; the container identity is kept.
    expect(link).toEqual({
      provider_task_id: null,
      provider_version: null,
      link_state: 'pending_create',
      provider_list_id: 'ms-list-1',
    });
    const repush = testDb.prepare(
      `SELECT status, patch_json FROM task_mutations WHERE task_id = ? AND operation = 'task.update'`,
    ).all(taskId) as Array<{ status: string; patch_json: string }>;
    expect(repush).toHaveLength(1);
    expect(repush[0].status).toBe('queued');
    expect(JSON.parse(repush[0].patch_json)).toEqual(expect.objectContaining({
      resolution: 'restore_undelete',
      providerLinkProvider: 'ms_todo',
      title: 'Restore harness pushed',
      status: 'pending',
    }));
    const issue = testDb.prepare(
      `SELECT state FROM task_sync_issues WHERE task_id = ? AND code = 'provider_task_missing'`,
    ).get(taskId) as { state: string };
    expect(issue.state).toBe('resolved');
    // Restores are not deletes: the re-push rides the standard kick.
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(USER_ID, USER_ID);
  });

  it('path (b): restores a completed task as completed', () => {
    const { taskId, linkId } = createProviderLinkedTask('completed');
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, status = 'cancelled',
           completed_at = '2026-07-01T10:00:00Z', sync_state = 'synced'
       WHERE nexus_task_id = ?`,
    ).run(new Date().toISOString(), taskId);
    testDb.prepare(
      `UPDATE task_provider_links SET provider_task_id = NULL, link_state = 'orphaned' WHERE id = ?`,
    ).run(linkId);

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId });

    expect(result.path).toBe('undeleted');
    expect(result.task.status).toBe('completed');
  });

  it('path (b): local-only tombstones restore with no mutation and no kick', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Restore local-only',
      listName: 'Tasks',
      clientMutationId: 'ios-restore-local-create',
      idempotencyKey: 'idem-restore-local-create',
    });
    deleteTask(created.task.id, 'local');
    kick.mockClear();

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: created.task.id });

    expect(result.path).toBe('undeleted');
    expect(result.task).toEqual(expect.objectContaining({
      id: created.task.id,
      status: 'notStarted',
      syncState: 'local_only',
      deletedAt: null,
    }));
    const repush = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE task_id = ? AND operation = 'task.update'`,
    ).get(created.task.id) as { count: number };
    expect(repush.count).toBe(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it('path (b): a link already parked in pending_create is reused as-is', () => {
    const { taskId, linkId } = createProviderLinkedTask('pending-create');
    testDb.prepare(
      `UPDATE task_provider_links SET provider_task_id = NULL, provider_version = NULL, link_state = 'pending_create' WHERE id = ?`,
    ).run(linkId);
    testDb.prepare(
      `UPDATE unified_tasks SET is_deleted = 1, deleted_at = ?, status = 'cancelled' WHERE nexus_task_id = ?`,
    ).run(new Date().toISOString(), taskId);

    const result = restoreOfflineFirstTask(USER_ID, USER_ID, { taskId });

    expect(result.path).toBe('undeleted');
    const links = testDb.prepare(
      `SELECT link_state FROM task_provider_links WHERE task_id = ?`,
    ).all(taskId) as Array<{ link_state: string }>;
    expect(links).toEqual([{ link_state: 'pending_create' }]);
  });

  it('refuses unknown ids (NOT_FOUND) and live tasks (NOT_DELETED)', () => {
    expect(() => restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: 'task_does_not_exist' }))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Live task restore refusal',
      listName: 'Tasks',
      clientMutationId: 'ios-restore-live-create',
      idempotencyKey: 'idem-restore-live-create',
    });
    expect(() => restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: created.task.id }))
      .toThrowError(expect.objectContaining({ code: 'NOT_DELETED' }));
  });

  it('refuses merged twin-repair tombstones (NOT_RESTORABLE)', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Merged tombstone',
      listName: 'Tasks',
      clientMutationId: 'ios-restore-merged-create',
      idempotencyKey: 'idem-restore-merged-create',
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, provider_data = ?
       WHERE nexus_task_id = ?`,
    ).run(new Date().toISOString(), JSON.stringify({ merged_into: 'task_survivor_1' }), created.task.id);

    expect(() => restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: created.task.id }))
      .toThrowError(expect.objectContaining({ code: 'NOT_RESTORABLE' }));
  });

  it('replays idempotently with the recorded path, and refuses a keyless second restore', () => {
    // Path (a) replay ('superseded_delete').
    const held = createProviderLinkedTask('replay-held');
    deleteTask(held.taskId, 'replay-held');
    const first = restoreOfflineFirstTask(USER_ID, USER_ID, {
      taskId: held.taskId,
      clientMutationId: 'ios-restore-replay-held',
      idempotencyKey: 'idem-restore-replay-held',
    });
    const replayHeld = restoreOfflineFirstTask(USER_ID, USER_ID, {
      taskId: held.taskId,
      clientMutationId: 'ios-restore-replay-held',
      idempotencyKey: 'idem-restore-replay-held',
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replayHeld).toEqual(expect.objectContaining({
      restored: true,
      path: 'superseded_delete',
      idempotentReplay: true,
      mutationId: first.mutationId,
    }));

    // Path (b) replay ('undeleted') must not journal a second re-push.
    const pushed = createProviderLinkedTask('replay-pushed');
    deleteTask(pushed.taskId, 'replay-pushed');
    testDb.prepare(
      `UPDATE task_mutations SET status = 'synced' WHERE task_id = ? AND operation = 'task.delete'`,
    ).run(pushed.taskId);
    testDb.prepare(
      `UPDATE task_provider_links SET provider_task_id = NULL, link_state = 'orphaned' WHERE id = ?`,
    ).run(pushed.linkId);
    restoreOfflineFirstTask(USER_ID, USER_ID, {
      taskId: pushed.taskId,
      clientMutationId: 'ios-restore-replay-pushed',
      idempotencyKey: 'idem-restore-replay-pushed',
    });
    const replayPushed = restoreOfflineFirstTask(USER_ID, USER_ID, {
      taskId: pushed.taskId,
      clientMutationId: 'ios-restore-replay-pushed',
      idempotencyKey: 'idem-restore-replay-pushed',
    });
    expect(replayPushed).toEqual(expect.objectContaining({ path: 'undeleted', idempotentReplay: true }));
    const repushCount = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE task_id = ? AND operation = 'task.update'`,
    ).get(pushed.taskId) as { count: number };
    expect(repushCount.count).toBe(1);

    // A NEW restore attempt (fresh keys) against the now-live task is a 409.
    expect(() => restoreOfflineFirstTask(USER_ID, USER_ID, { taskId: pushed.taskId }))
      .toThrowError(expect.objectContaining({ code: 'NOT_DELETED' }));
  });
});

// ─── M10 priority-to-server contract (NEX-17) ────────────────────────────────

describe('M10 REST priority contract', () => {
  it('stores and echoes an explicit priority on create (DTO carries priority + coarse importance)', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Priority create',
      priority: 2,
      clientMutationId: 'ios-priority-create-1',
    });

    expect(created.task.priority).toBe(2);
    expect(created.task.importance).toBe('high');
    const fetched = getOfflineTaskById(USER_ID, USER_ID, created.task.id);
    expect(fetched?.priority).toBe(2);
  });

  it('prefers explicit priority over the legacy importance string on create', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Priority beats importance',
      priority: 4,
      importance: 'high',
      clientMutationId: 'ios-priority-create-2',
    });

    expect(created.task.priority).toBe(4);
    expect(created.task.importance).toBe('low');
  });

  it('rejects out-of-range or non-integer priorities on create with BAD_REQUEST', () => {
    for (const priority of [5, -1, 1.5, Number.NaN]) {
      expect(() => createOfflineFirstTask(USER_ID, USER_ID, {
        title: 'Invalid priority',
        priority,
        clientMutationId: `ios-priority-invalid-${priority}`,
      })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
  });

  it('pins the client importance→priority inbound table on create (urgent→1, high→2, normal/medium→3, low→4, absent→0)', () => {
    const table: Array<[string | undefined, number]> = [
      ['urgent', 1],
      ['high', 2],
      ['normal', 3],
      ['medium', 3],
      ['low', 4],
      [undefined, 0],
    ];
    for (const [importance, expected] of table) {
      const created = createOfflineFirstTask(USER_ID, USER_ID, {
        title: `Importance ${importance ?? 'absent'}`,
        importance,
        clientMutationId: `ios-importance-${importance ?? 'absent'}`,
      });
      expect(created.task.priority, `importance ${importance}`).toBe(expected);
    }
  });

  it('updates and clears priority through task.update (0 = none)', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Priority update target',
      priority: 2,
      clientMutationId: 'ios-priority-update-target',
    });

    const bumped = updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      priority: 1,
      clientMutationId: 'ios-priority-update-1',
    });
    expect(bumped.task.priority).toBe(1);
    expect(bumped.task.importance).toBe('high');

    const cleared = updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      priority: 0,
      clientMutationId: 'ios-priority-update-2',
    });
    expect(cleared.task.priority).toBe(0);
    expect(cleared.task.importance).toBe('normal');
  });

  it('rejects invalid priorities on update with BAD_REQUEST', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Priority update validation',
      clientMutationId: 'ios-priority-update-validation',
    });

    expect(() => updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      priority: 9,
      clientMutationId: 'ios-priority-update-invalid',
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('preserves fine-grained priority when an importance-only update lands in the same bucket', () => {
    // Deployed pre-M-D iOS builds and chat only speak coarse importance: an
    // edit that sends importance 'high' back at a P1 task must not demote it
    // to P2 (mirror of the pull echo-stability rule).
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'P1 with coarse client',
      priority: 1,
      clientMutationId: 'ios-priority-coarse-preserve',
    });

    const patched = updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      title: 'P1 with coarse client (edited)',
      importance: 'high',
      clientMutationId: 'ios-priority-coarse-preserve-edit',
    });

    expect(patched.task.title).toBe('P1 with coarse client (edited)');
    expect(patched.task.priority).toBe(1);
  });

  it('re-maps priority when an importance-only update changes bucket', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'P1 demoted by coarse client',
      priority: 1,
      clientMutationId: 'ios-priority-coarse-demote',
    });

    const patched = updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      importance: 'low',
      clientMutationId: 'ios-priority-coarse-demote-edit',
    });

    expect(patched.task.priority).toBe(4);
    expect(patched.task.importance).toBe('low');
  });

  it('keeps the stored priority when neither priority nor importance is provided', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Title-only patch',
      priority: 3,
      clientMutationId: 'ios-priority-title-only',
    });

    // The PATCH route always defines these keys (possibly undefined) — the
    // service must treat undefined as "not provided", never as a reset.
    const patched = updateOfflineFirstTask(USER_ID, USER_ID, {
      taskId: created.task.id,
      title: 'Title-only patch (edited)',
      importance: undefined,
      priority: undefined,
      clientMutationId: 'ios-priority-title-only-edit',
    });

    expect(patched.task.priority).toBe(3);
  });

  it('keeps priority across complete/reopen local mutations (they never carry priority)', () => {
    const created = createOfflineFirstTask(USER_ID, USER_ID, {
      title: 'Complete keeps priority',
      priority: 2,
      clientMutationId: 'ios-priority-complete',
    });

    recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.complete',
      clientMutationId: 'ios-priority-complete-op',
    });
    recordLocalTaskMutation(USER_ID, USER_ID, {
      taskId: created.task.id,
      operation: 'task.reopen',
      clientMutationId: 'ios-priority-reopen-op',
    });

    expect(getOfflineTaskById(USER_ID, USER_ID, created.task.id)?.priority).toBe(2);
  });

  it('advertises the priority capability on the working-set snapshot payload', () => {
    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    expect(snapshot.capabilities.priority).toBe(true);
  });

  it('sorts the read model by priority (1 best, none last), then due date, then title', () => {
    const seed = (title: string, priority: number, dueDateTime?: string) => createOfflineFirstTask(USER_ID, USER_ID, {
      title,
      priority,
      dueDateTime,
      listName: 'Inbox',
      clientMutationId: `ios-sort-${title}`,
    }).task.id;

    const noneTask = seed('A unprioritized', 0);
    const p3Task = seed('B p3', 3);
    const p1NoDue = seed('C p1 undated', 1);
    const p1Later = seed('A p1 later', 1, '2026-07-20T09:00:00Z');
    const p1Sooner = seed('Z p1 sooner', 1, '2026-07-19T09:00:00Z');

    const snapshot = getOfflineTaskSnapshot(USER_ID, USER_ID, { pageSize: 75 });
    const orderedIds = snapshot.tasks.map((task: any) => task.id);

    expect(orderedIds).toEqual([
      // P1 first: due dates ascending, undated last.
      p1Sooner,
      p1Later,
      p1NoDue,
      // Then P3, then unprioritized (0) last.
      p3Task,
      noneTask,
    ]);
  });
});

// ─── M11 Recently Deleted read model ─────────────────────────────────────────

describe('M11 getOfflineRecentlyDeletedTasks', () => {
  function createTask(suffix: string, listName = 'Tasks') {
    return createOfflineFirstTask(USER_ID, USER_ID, {
      title: `Recently deleted ${suffix}`,
      listName,
      clientMutationId: `ios-m11-create-${suffix}`,
      idempotencyKey: `idem-m11-create-${suffix}`,
    }).task;
  }

  function tombstone(taskId: string, deletedAt: string | null): void {
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, status = 'cancelled'
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(deletedAt, USER_ID, USER_ID, taskId);
  }

  it('returns tombstones newest-first with the pinned wire shape and excludes live tasks', () => {
    const live = createTask('live');
    const older = createTask('older');
    const newer = createTask('newer');
    tombstone(older.id, '2026-07-10T09:00:00.000Z');
    tombstone(newer.id, '2026-07-16T09:00:00.000Z');

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.count).toBe(2);
    expect(result.tasks.map((task) => task.id)).toEqual([newer.id, older.id]);
    expect(result.tasks[0]).toEqual({
      id: newer.id,
      title: 'Recently deleted newer',
      listId: newer.listId,
      listName: 'Tasks',
      deletedAt: '2026-07-16T09:00:00.000Z',
      syncProvider: 'nexus',
      restorable: true,
    });
    expect(result.tasks.some((task) => task.id === live.id)).toBe(false);
  });

  it('returns an empty page and zero count when nothing is tombstoned', () => {
    createTask('only-live');

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result).toEqual({ tasks: [], count: 0 });
    expect(countOfflineRecentlyDeletedTasks(USER_ID, USER_ID)).toBe(0);
  });

  it('hides tombstones older than the 90-day window and falls back to updated_at when deleted_at is NULL', () => {
    const inWindow = createTask('in-window');
    const beyondWindow = createTask('beyond-window');
    const legacy = createTask('legacy-null-deleted-at');
    tombstone(inWindow.id, new Date().toISOString());
    tombstone(beyondWindow.id, '2026-04-01T09:00:00.000Z'); // > 90 days before 2026-07
    // Legacy provider soft-delete shape: is_deleted = 1 with no deleted_at.
    tombstone(legacy.id, null);
    const legacyUpdatedAt = (testDb.prepare(
      `SELECT updated_at FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(legacy.id) as { updated_at: string }).updated_at;

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks.map((task) => task.id).sort()).toEqual([inWindow.id, legacy.id].sort());
    expect(result.count).toBe(2);
    const legacyDto = result.tasks.find((task) => task.id === legacy.id);
    expect(legacyDto?.deletedAt).toBe(legacyUpdatedAt);
  });

  it('marks merged twin-repair tombstones restorable: false (the M9 NOT_RESTORABLE rule)', () => {
    const merged = createTask('merged');
    const plain = createTask('plain');
    tombstone(plain.id, '2026-07-15T09:00:00.000Z');
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = '2026-07-16T09:00:00.000Z', provider_data = ?
       WHERE nexus_task_id = ?`,
    ).run(JSON.stringify({ merged_into: 'task_m11_survivor' }), merged.id);

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks.find((task) => task.id === merged.id)?.restorable).toBe(false);
    expect(result.tasks.find((task) => task.id === plain.id)?.restorable).toBe(true);
  });

  it('reports the sync-target provider from the link — including the orphan a pushed delete leaves behind', () => {
    const pushed = createTask('pushed-delete');
    tombstone(pushed.id, '2026-07-16T10:00:00.000Z');
    // A pushed delete surrenders the provider id and orphans the link (M4);
    // the orphan is still the provider a restore would re-push to.
    testDb.prepare(
      `UPDATE task_provider_links
       SET provider = 'ms_todo', provider_account_id = 'ms_todo:42',
           provider_task_id = NULL, link_state = 'orphaned'
       WHERE tenant_id = ? AND user_id = ? AND task_id = ?`,
    ).run(USER_ID, USER_ID, pushed.id);

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks[0]?.syncProvider).toBe('ms_todo');
  });

  it('clamps the limit (min 1, default 50, max 100) while count stays the total', () => {
    const first = createTask('clamp-1');
    const second = createTask('clamp-2');
    const third = createTask('clamp-3');
    tombstone(first.id, '2026-07-14T09:00:00.000Z');
    tombstone(second.id, '2026-07-15T09:00:00.000Z');
    tombstone(third.id, '2026-07-16T09:00:00.000Z');

    const pageOfOne = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID, { limit: 1 });
    const clampedLow = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID, { limit: 0 });
    const clampedHigh = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID, { limit: 5000 });
    const defaulted = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID, { limit: Number.NaN });

    expect(pageOfOne.tasks.map((task) => task.id)).toEqual([third.id]);
    expect(pageOfOne.count).toBe(3);
    expect(clampedLow.tasks).toHaveLength(1);
    expect(clampedHigh.tasks).toHaveLength(3);
    expect(defaulted.tasks).toHaveLength(3);
  });

  it('scopes tombstones to the requesting tenant/user', () => {
    testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(7, 7);
    const mine = createTask('scope-mine');
    tombstone(mine.id, '2026-07-16T09:00:00.000Z');
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, status,
         is_deleted, deleted_at, nexus_task_id
       ) VALUES (7, 7, 'nexus', 'ext-m11-other', 'Other user tombstone', 'cancelled',
         1, '2026-07-16T09:30:00.000Z', 'task_m11_other')`,
    ).run();

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks.map((task) => task.id)).toEqual([mine.id]);
    expect(result.count).toBe(1);
    expect(countOfflineRecentlyDeletedTasks(7, 7)).toBe(1);
  });

  it('renders a defensively-shaped legacy tombstone instead of dropping the row', () => {
    // Worst-case legacy row that can still pass the window predicate: no
    // title, no project binding, no origin provider, no deleted_at. The page
    // must render it — a row the user cannot see is a row they cannot restore.
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, project_id, project_name,
         status, is_deleted, deleted_at, updated_at, nexus_task_id
       ) VALUES (?, ?, '', 'ext-m11-bare', '', NULL, NULL, 'cancelled',
         1, NULL, ?, 'task_m11_bare')`,
    ).run(USER_ID, USER_ID, new Date().toISOString());

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toEqual({
      id: 'task_m11_bare',
      title: '(Untitled)',
      listId: null,
      listName: null,
      // deleted_at is NULL → updated_at is the effective deletion time,
      // exactly as the window predicate's COALESCE computed it.
      deletedAt: expect.any(String),
      // No active link and no origin provider → the local store is the
      // honest answer for where this tombstone lives.
      syncProvider: 'nexus',
      restorable: true,
    });
  });

  it('resolves listName through the project map when the row carries only project_id', () => {
    const anchor = createTask('project-map', 'Errands');
    const projectId = Number(anchor.listId);
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, project_id, project_name,
         status, is_deleted, deleted_at, nexus_task_id
       ) VALUES (?, ?, 'nexus', 'ext-m11-namemap', 'Denormalized name missing', ?, NULL,
         'cancelled', 1, ?, 'task_m11_namemap')`,
    ).run(USER_ID, USER_ID, projectId, new Date().toISOString());

    const result = getOfflineRecentlyDeletedTasks(USER_ID, USER_ID);

    expect(result.tasks[0]).toMatchObject({
      id: 'task_m11_namemap',
      listId: String(projectId),
      listName: 'Errands',
    });
  });
});
