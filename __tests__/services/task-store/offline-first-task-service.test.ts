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
  createOfflineFirstTask,
  getOfflineTaskById,
  getOfflineFilteredTasks,
  getOfflineTaskLists,
  getOfflineTaskChanges,
  getOfflineTaskSnapshot,
  getOfflineTasksForList,
  recordLocalTaskMutation,
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
});
