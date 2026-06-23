import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  getOfflineTaskLists,
  getOfflineTaskChanges,
  recordLocalTaskMutation,
  retryOfflineTaskSync,
  toggleOfflineTaskChecklistItem,
} from '../../../src/services/task-store/offline-first-task-service';

const USER_ID = 42;

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(42, 42);
  vi.clearAllMocks();
  mockResolveTaskProvider.mockReturnValue('nexus');
});

describe('offline-first task service', () => {
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
});
