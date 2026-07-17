import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { computeTaskContentFingerprint } from '../../../src/services/task-store/todoist-correlation';

let testDb: Database.Database;

const providerApi = {
  getTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteTask: vi.fn(),
  createList: vi.fn(),
  deleteList: vi.fn(),
  getChecklistItems: vi.fn(),
  addChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
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

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => true),
}));

vi.mock('../../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(() => providerApi),
  resolveTaskProvider: vi.fn(() => 'nexus'),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

import {
  getTaskSyncOperationalMetrics,
  requeueAuthParkedMutations,
  runTaskMutationSyncBatch,
} from '../../../src/services/task-store/task-mutation-sync-worker';
import { getOfflineTaskLists } from '../../../src/services/task-store/offline-first-task-service';
import { isConnected } from '../../../src/services/oauth-store';

const USER_ID = 42;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE unified_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      project_id INTEGER,
      project_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      due_date TEXT,
      due_is_datetime INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      notes TEXT,
      completed_at TEXT,
      assignee TEXT,
      url TEXT,
      provider_data TEXT DEFAULT '{}',
      content_hash TEXT,
      is_deleted INTEGER DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      nexus_task_id TEXT NOT NULL,
      local_version INTEGER NOT NULL DEFAULT 1,
      sync_state TEXT NOT NULL DEFAULT 'queued',
      source_of_truth TEXT NOT NULL DEFAULT 'nexus',
      deleted_at TEXT
    );

    CREATE TABLE task_provider_links (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      provider_task_id TEXT,
      provider_list_id TEXT,
      provider_project_id TEXT,
      provider_version TEXT,
      provider_updated_at TEXT,
      last_synced_at TEXT,
      last_verified_at TEXT,
      ownership TEXT NOT NULL,
      link_state TEXT NOT NULL,
      last_synced_snapshot TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_mutations (
      mutation_id TEXT PRIMARY KEY,
      client_mutation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      operation TEXT NOT NULL,
      base_local_version INTEGER,
      patch_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      locked_at TEXT,
      worker_id TEXT,
      provider_idempotency_key TEXT,
      last_error_code TEXT,
      last_error_message TEXT
    );

    CREATE TABLE unified_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      is_default INTEGER DEFAULT 0,
      task_count INTEGER DEFAULT 0,
      synced_at TEXT,
      UNIQUE(user_id, provider, external_id)
    );

    CREATE TABLE task_container_mappings (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      nexus_list_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_container_type TEXT NOT NULL,
      provider_container_id TEXT NOT NULL,
      sync_direction TEXT NOT NULL DEFAULT 'bidirectional',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, nexus_list_id, provider)
    );

    CREATE TABLE task_sync_state (
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      last_sync_at TEXT,
      status TEXT,
      error_message TEXT,
      PRIMARY KEY (user_id, provider)
    );

    CREATE TABLE task_sync_issues (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT,
      code TEXT NOT NULL,
      message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `);
  return db;
}

function seedLinkedMutation(input: {
  taskId?: string;
  provider?: 'ms_todo' | 'todoist';
  providerTaskId?: string | null;
  providerVersion?: string | null;
  providerUpdatedAt?: string | null;
  linkState?: string;
  mutationId?: string;
  operation?: string;
  mutationStatus?: string;
  lockedAt?: string | null;
  providerData?: Record<string, unknown>;
} = {}) {
  const taskId = input.taskId || 'task-worker-1';
  const provider = input.provider || 'ms_todo';
  const mutationId = input.mutationId || 'mutation-worker-1';
  const operation = input.operation || 'task.create';
  const containerId = provider === 'ms_todo' ? 'ms-list-1' : 'todoist-project-1';
  testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_id, project_name,
       title, description, status, priority, provider_data, created_at, updated_at,
       nexus_task_id, local_version, sync_state, source_of_truth
     ) VALUES (?, ?, 'nexus', ?, 1, 'Work', 'Worker Task', '', 'pending', 2, ?, '2026-06-23 02:00:00', '2026-06-23 02:00:00', ?, 1, 'queued', 'nexus')`,
  ).run(USER_ID, USER_ID, taskId, JSON.stringify(input.providerData || {}), taskId);
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id, provider_version,
       provider_updated_at, ownership, link_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nexus_created', ?)`,
  ).run(
    `link-${taskId}-${provider}`,
    taskId,
    USER_ID,
    USER_ID,
    provider,
    `${provider}:${USER_ID}`,
    input.providerTaskId ?? null,
    provider === 'ms_todo' ? containerId : null,
    provider === 'todoist' ? containerId : null,
    input.providerVersion ?? null,
    input.providerUpdatedAt ?? null,
    input.linkState || (input.providerTaskId ? 'pending_update' : 'pending_create'),
  );
  testDb.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, base_local_version, patch_json, status, retry_count,
       locked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)`,
  ).run(
    mutationId,
    `client-${mutationId}`,
    `idem-${mutationId}`,
    USER_ID,
    USER_ID,
    taskId,
    operation,
    JSON.stringify({ providerLinkProvider: provider }),
    input.mutationStatus || 'queued',
    input.lockedAt ?? null,
  );
  return { taskId, mutationId, provider, containerId };
}

beforeEach(() => {
  testDb = createTestDb();
  vi.clearAllMocks();
  vi.mocked(isConnected).mockReturnValue(true);
  providerApi.getTasks.mockResolvedValue({ success: true, data: [] });
  providerApi.createTask.mockResolvedValue({ success: true, data: { id: 'provider-created-1', providerVersion: 'etag-created' } });
  providerApi.updateTask.mockResolvedValue({ success: true, data: { id: 'provider-updated-1', providerVersion: 'etag-updated' } });
  providerApi.completeTask.mockResolvedValue({ success: true, data: { id: 'provider-completed-1', providerVersion: 'etag-completed' } });
  providerApi.uncompleteTask.mockResolvedValue({ success: true, data: { id: 'provider-reopened-1', providerVersion: 'etag-reopened' } });
  providerApi.deleteTask.mockResolvedValue({ success: true, data: undefined });
  providerApi.getTask.mockResolvedValue({ success: true, data: { id: 'provider-task-1', providerData: { sync_id: 'v1' } } });
  providerApi.getChecklistItems.mockResolvedValue({ success: true, data: [] });
  providerApi.addChecklistItem.mockResolvedValue({ success: true, data: { id: 'provider-check-1', displayName: 'Pack cable', isChecked: false } });
});

describe('task mutation sync worker write-back safety', () => {
  it('passes provider idempotency keys into provider creates', async () => {
    const { taskId } = seedLinkedMutation({ taskId: 'task-idempotent-create' });
    providerApi.createTask.mockImplementationOnce(async () => {
      const { getCurrentContext } = await import('../../../src/utils/request-context');
      expect(getCurrentContext()).toMatchObject({
        source: 'cron:task_mutation_sync',
        userId: USER_ID,
        tenantId: USER_ID,
      });
      return { success: true, data: { id: 'provider-created-1', providerVersion: 'etag-created' } };
    });

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(providerApi.createTask).toHaveBeenCalledTimes(1);
    expect(providerApi.createTask.mock.calls[0][3]).toEqual(expect.objectContaining({
      idempotencyKey: expect.stringContaining(`:${taskId}:task.create:`),
      nexusTaskId: taskId,
    }));
    const link = testDb.prepare(
      `SELECT provider_task_id, provider_version
       FROM task_provider_links
       WHERE task_id = ?`,
    ).get(taskId) as { provider_task_id: string; provider_version: string };
    expect(link).toEqual({ provider_task_id: 'provider-created-1', provider_version: 'etag-created' });
  });

  it('reclaims stale syncing creates and recovers provider task by Nexus linked resource without a duplicate create', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-stale-syncing',
      mutationStatus: 'syncing',
      lockedAt: '2026-06-23 01:00:00',
    });
    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'ms-existing-1',
        listId: 'ms-list-1',
        title: 'Different title is okay',
        linkedResources: [{ applicationName: 'NexusHub', externalId: taskId }],
      }],
    });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.processed).toBe(1);
    expect(result.synced).toBe(1);
    expect(providerApi.createTask).not.toHaveBeenCalled();
    const link = testDb.prepare(
      `SELECT provider_task_id, link_state
       FROM task_provider_links
       WHERE task_id = ?`,
    ).get(taskId) as { provider_task_id: string; link_state: string };
    expect(link).toEqual({ provider_task_id: 'ms-existing-1', link_state: 'linked' });
  });

  it('marks Todoist writes as conflicts when provider version diverged before write', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-todoist-fingerprint-conflict',
      provider: 'todoist',
    });
    providerApi.createTask.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'todoist-task-1',
        title: 'Worker Task',
        body: '',
        importance: 'normal',
        status: 'notStarted',
        providerData: { id: 'todoist-task-1', content: 'Worker Task', description: '', priority: 2, checked: 0 },
      },
    });

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    const stored = testDb.prepare(
      `SELECT provider_task_id, provider_version
       FROM task_provider_links
       WHERE task_id = ?`,
    ).get(taskId) as { provider_task_id: string; provider_version: string };
    expect(stored.provider_task_id).toBe('todoist-task-1');
    expect(stored.provider_version).toMatch(/^fp:/);

    testDb.prepare(
      `UPDATE unified_tasks
       SET title = 'Local queued edit', local_version = local_version + 1
       WHERE nexus_task_id = ?`,
    ).run(taskId);
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, status
       ) VALUES ('mutation-todoist-fp-update', 'client-todoist-fp-update', 'idem-todoist-fp-update', ?, ?, ?, 'task.update', 1, ?, 'queued')`,
    ).run(USER_ID, USER_ID, taskId, JSON.stringify({ providerLinkProvider: 'todoist' }));
    providerApi.getTask.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'todoist-task-1',
        title: 'Provider-side edit',
        body: '',
        importance: 'normal',
        status: 'notStarted',
        providerData: { id: 'todoist-task-1', content: 'Provider-side edit', description: '', priority: 2, checked: 0 },
      },
    });
    providerApi.updateTask.mockClear();

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.conflicts).toBe(1);
    expect(providerApi.updateTask).not.toHaveBeenCalled();
    const task = testDb.prepare(
      `SELECT sync_state
       FROM unified_tasks
       WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    const issue = testDb.prepare(
      `SELECT code, state
       FROM task_sync_issues
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(taskId) as { code: string; state: string };
    expect(task.sync_state).toBe('conflict');
    expect(issue).toEqual({ code: 'provider_conflict', state: 'open' });
  });

  it('recovers Todoist creates by Nexus marker without relying on X-Request-Id replay', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-todoist-marker-recovery',
      provider: 'todoist',
      mutationStatus: 'syncing',
      lockedAt: '2026-06-23 01:00:00',
    });
    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'todoist-existing-1',
        projectId: 'todoist-project-1',
        title: 'Worker Task',
        body: 'Visible note',
        importance: 'normal',
        status: 'notStarted',
        providerData: {
          id: 'todoist-existing-1',
          content: 'Worker Task',
          description: 'Visible note\n\n<!-- nexus-task-id:task-todoist-marker-recovery -->',
          priority: 2,
          checked: 0,
          project_id: 'todoist-project-1',
          nexus_task_id: taskId,
        },
      }],
    });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(providerApi.createTask).not.toHaveBeenCalled();
    const link = testDb.prepare(
      `SELECT provider_task_id, provider_version
       FROM task_provider_links
       WHERE task_id = ?`,
    ).get(taskId) as { provider_task_id: string; provider_version: string };
    expect(link.provider_task_id).toBe('todoist-existing-1');
    expect(link.provider_version).toBe(computeTaskContentFingerprint({
      title: 'Worker Task',
      description: 'Visible note',
      priority: 2,
      status: 'pending',
      providerData: { labels: [] },
    }));
  });

  it('marks Microsoft 412 precondition failures as conflicts through the worker', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-ms-412-conflict',
      provider: 'ms_todo',
      providerTaskId: 'ms-task-412',
      providerVersion: 'etag-v1',
      operation: 'task.update',
    });
    providerApi.updateTask.mockResolvedValueOnce({
      success: false,
      error: 'Precondition Failed',
      statusCode: 412,
    });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.conflicts).toBe(1);
    const task = testDb.prepare(
      `SELECT sync_state
       FROM unified_tasks
       WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    const mutation = testDb.prepare(
      `SELECT status, last_error_code
       FROM task_mutations
       WHERE task_id = ?`,
    ).get(taskId) as { status: string; last_error_code: string };
    expect(task.sync_state).toBe('conflict');
    expect(mutation).toEqual({ status: 'conflict', last_error_code: 'provider_conflict' });
  });

  it('keeps Microsoft 503 create failures retryable instead of dead-lettering', async () => {
    const { taskId } = seedLinkedMutation({ taskId: 'task-ms-503-create' });
    providerApi.createTask.mockResolvedValueOnce({
      success: false,
      error: 'Service unavailable',
      statusCode: 503,
    });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.failedRetryable).toBe(1);
    const mutation = testDb.prepare(
      `SELECT status, retry_count, last_error_code
       FROM task_mutations
       WHERE task_id = ?`,
    ).get(taskId) as { status: string; retry_count: number; last_error_code: string };
    expect(mutation.status).toBe('failed');
    expect(mutation.retry_count).toBe(1);
    expect(mutation.last_error_code).toBe('provider_timeout');
  });

  it('syncs Microsoft checklist items and keeps task fully synced when subtasks are supported', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-ms-checklist',
      providerData: {
        checklistItems: [{ id: 'local-check-1', displayName: 'Pack cable', isChecked: false }],
      },
    });

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(providerApi.addChecklistItem).toHaveBeenCalledWith('ms-list-1', 'provider-created-1', 'Pack cable');
    const task = testDb.prepare(
      `SELECT sync_state
       FROM unified_tasks
       WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    const issueCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM task_sync_issues
       WHERE task_id = ? AND code = 'unsupported_field_local_only' AND state = 'open'`,
    ).get(taskId) as { count: number };
    expect(task.sync_state).toBe('synced');
    expect(issueCount.count).toBe(0);
  });

  it('captures the pushed local content as the link last_synced_snapshot on markSynced (M2B)', async () => {
    const { taskId } = seedLinkedMutation({ taskId: 'task-snapshot-capture' });

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    const link = testDb.prepare(
      `SELECT last_synced_snapshot
       FROM task_provider_links
       WHERE task_id = ?`,
    ).get(taskId) as { last_synced_snapshot: string | null };
    expect(link.last_synced_snapshot).not.toBeNull();
    expect(JSON.parse(link.last_synced_snapshot as string)).toEqual({
      title: 'Worker Task',
      status: 'pending',
      priority: 2,
      dueDate: null,
      dueIsDatetime: false,
      notes: null,
    });
  });

  it('keeps the prior snapshot when a task.delete lands — the link is being orphaned (M2B)', async () => {
    const { taskId } = seedLinkedMutation({
      taskId: 'task-snapshot-delete-keeps',
      providerTaskId: 'ms-task-delete-1',
      operation: 'task.delete',
    });
    testDb.prepare(
      `UPDATE task_provider_links SET last_synced_snapshot = ? WHERE task_id = ?`,
    ).run('{"title":"Agreed base before delete"}', taskId);

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(providerApi.deleteTask).toHaveBeenCalledWith('ms-list-1', 'ms-task-delete-1');
    const link = testDb.prepare(
      `SELECT last_synced_snapshot, provider_task_id
       FROM task_provider_links WHERE task_id = ?`,
    ).get(taskId) as { last_synced_snapshot: string | null; provider_task_id: string | null };
    // Snapshot untouched; the delete surrendered the provider id (M4 rule).
    expect(link.last_synced_snapshot).toBe('{"title":"Agreed base before delete"}');
    expect(link.provider_task_id).toBeNull();
  });

  it('never selects superseded mutations and never dead-letters them past the retry cap (M2B)', async () => {
    // A superseded row shaped like a former conflict AND one past the
    // dead-letter retry cap: the batch must ignore both entirely.
    seedLinkedMutation({
      taskId: 'task-superseded-ignored',
      providerTaskId: 'ms-task-superseded',
      operation: 'task.update',
      mutationStatus: 'superseded',
    });
    testDb.prepare(
      `UPDATE task_mutations
       SET retry_count = 9, last_error_code = 'conflict_resolved_keep_local'
       WHERE task_id = 'task-superseded-ignored'`,
    ).run();

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.processed).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(providerApi.updateTask).not.toHaveBeenCalled();
    const row = testDb.prepare(
      `SELECT status, retry_count FROM task_mutations WHERE task_id = 'task-superseded-ignored'`,
    ).get() as { status: string; retry_count: number };
    expect(row).toEqual({ status: 'superseded', retry_count: 9 });
  });

  it('reconciles Microsoft checklist add, update, and delete branches', async () => {
    seedLinkedMutation({
      taskId: 'task-ms-checklist-reconcile',
      provider: 'ms_todo',
      providerTaskId: 'provider-existing-checklist',
      operation: 'task.update',
      providerData: {
        checklistItems: [
          { id: 'local-check-pack', displayName: 'Pack cable', isChecked: true },
          { id: 'local-check-watch', displayName: 'Charge watch', isChecked: false },
        ],
      },
    });
    providerApi.getChecklistItems.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'provider-pack', displayName: 'Pack cable', isChecked: false },
        { id: 'provider-extra', displayName: 'Remove me', isChecked: false },
      ],
    });

    await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(providerApi.addChecklistItem).toHaveBeenCalledWith('ms-list-1', 'provider-existing-checklist', 'Charge watch');
    expect(providerApi.updateChecklistItem).toHaveBeenCalledWith('ms-list-1', 'provider-existing-checklist', 'provider-pack', true);
    expect(providerApi.deleteChecklistItem).toHaveBeenCalledWith('ms-list-1', 'provider-existing-checklist', 'provider-extra');
  });
});

// Seeds the exact shape markFailure leaves behind after a 401/403: mutation
// status 'failed' with next_retry_at NULL (parked), task 'provider_disconnected',
// link 'disconnected'.
function seedAuthParkedMutation(input: {
  taskId: string;
  mutationId?: string;
  userId?: number;
  tenantId?: number;
  provider?: 'ms_todo' | 'todoist';
  lastErrorCode?: string | null;
  createdAt?: string;
  operation?: string;
}) {
  const userId = input.userId ?? USER_ID;
  const tenantId = input.tenantId ?? userId;
  const provider = input.provider || 'ms_todo';
  const taskId = input.taskId;
  const mutationId = input.mutationId || `mutation-${taskId}`;
  const operation = input.operation || 'task.create';
  const containerId = provider === 'ms_todo' ? 'ms-list-1' : 'todoist-project-1';
  const createdAt = input.createdAt || new Date().toISOString();
  const lastErrorCode = input.lastErrorCode === undefined ? 'provider_auth_expired' : input.lastErrorCode;
  testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_id, project_name,
       title, description, status, priority, provider_data, created_at, updated_at,
       nexus_task_id, local_version, sync_state, source_of_truth
     ) VALUES (?, ?, 'nexus', ?, 1, 'Work', 'Parked Task', '', 'pending', 2, '{}', ?, ?, ?, 2, 'provider_disconnected', 'nexus')`,
  ).run(userId, tenantId, taskId, createdAt, createdAt, taskId);
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id,
       ownership, link_state
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'nexus_created', 'disconnected')`,
  ).run(
    `link-${taskId}-${provider}`,
    taskId,
    tenantId,
    userId,
    provider,
    `${provider}:${userId}`,
    provider === 'ms_todo' ? containerId : null,
    provider === 'todoist' ? containerId : null,
  );
  testDb.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, base_local_version, patch_json, created_at, status,
       retry_count, next_retry_at, last_error_code, last_error_message
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'failed', 1, NULL, ?, 'ms_todo_not_connected')`,
  ).run(
    mutationId,
    `client-${mutationId}`,
    `idem-${mutationId}`,
    tenantId,
    userId,
    taskId,
    operation,
    JSON.stringify({ providerLinkProvider: provider }),
    createdAt,
    lastErrorCode,
  );
  return { taskId, mutationId, userId, tenantId };
}

function getMutationRow(mutationId: string): { status: string; next_retry_at: string | null; last_error_code: string | null } {
  return testDb.prepare(
    `SELECT status, next_retry_at, last_error_code
     FROM task_mutations
     WHERE mutation_id = ?`,
  ).get(mutationId) as { status: string; next_retry_at: string | null; last_error_code: string | null };
}

describe('requeueAuthParkedMutations', () => {
  it('re-arms an auth-parked mutation once its provider is connected again', () => {
    const { mutationId } = seedAuthParkedMutation({ taskId: 'task-auth-requeue' });

    const result = requeueAuthParkedMutations({ tenantId: USER_ID, userId: USER_ID });

    expect(result).toEqual({ requeued: 1, deadLettered: 0 });
    const row = getMutationRow(mutationId);
    expect(row.status).toBe('failed');
    expect(row.next_retry_at).not.toBeNull();
  });

  it('processes a re-armed auth-parked mutation in the same runTaskMutationSyncBatch call', async () => {
    const { mutationId, taskId } = seedAuthParkedMutation({ taskId: 'task-auth-same-batch' });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.processed).toBe(1);
    expect(result.synced).toBe(1);
    expect(providerApi.createTask).toHaveBeenCalledTimes(1);
    expect(getMutationRow(mutationId).status).toBe('synced');
    const task = testDb.prepare(
      `SELECT sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    expect(task.sync_state).toBe('synced');
  });

  it('keeps auth-parked mutations parked while the provider stays disconnected', async () => {
    vi.mocked(isConnected).mockReturnValue(false);
    const { mutationId } = seedAuthParkedMutation({ taskId: 'task-auth-still-disconnected' });

    const direct = requeueAuthParkedMutations({ tenantId: USER_ID, userId: USER_ID });
    const batch = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(direct).toEqual({ requeued: 0, deadLettered: 0 });
    expect(batch.processed).toBe(0);
    expect(providerApi.createTask).not.toHaveBeenCalled();
    const row = getMutationRow(mutationId);
    expect(row.status).toBe('failed');
    expect(row.next_retry_at).toBeNull();
  });

  it('dead-letters auth-parked mutations older than the 30-day requeue window instead of retrying', async () => {
    const { mutationId, taskId } = seedAuthParkedMutation({
      taskId: 'task-auth-expired-window',
      createdAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });

    const result = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(result.processed).toBe(0);
    expect(providerApi.createTask).not.toHaveBeenCalled();
    const row = getMutationRow(mutationId);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error_code).toBe('provider_auth_expired');
    expect(row.next_retry_at).toBeNull();
    const issue = testDb.prepare(
      `SELECT code, state, details_json
       FROM task_sync_issues
       WHERE task_id = ? AND code = 'provider_auth_expired'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(taskId) as { code: string; state: string; details_json: string };
    expect(issue.state).toBe('open');
    expect(JSON.parse(issue.details_json)).toMatchObject({ reason: 'dead_letter' });
  });

  it('never re-arms failed mutations without an auth-expired error code', async () => {
    seedAuthParkedMutation({ taskId: 'task-park-null-code', lastErrorCode: null });
    seedAuthParkedMutation({ taskId: 'task-park-list-missing', lastErrorCode: 'provider_list_missing' });
    seedAuthParkedMutation({ taskId: 'task-park-manual', lastErrorCode: 'manual_resolution_required' });

    const direct = requeueAuthParkedMutations({ tenantId: USER_ID, userId: USER_ID });
    const batch = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });

    expect(direct).toEqual({ requeued: 0, deadLettered: 0 });
    expect(batch.processed).toBe(0);
    const rows = testDb.prepare(
      `SELECT status, next_retry_at FROM task_mutations ORDER BY mutation_id`,
    ).all() as Array<{ status: string; next_retry_at: string | null }>;
    expect(rows).toEqual([
      { status: 'failed', next_retry_at: null },
      { status: 'failed', next_retry_at: null },
      { status: 'failed', next_retry_at: null },
    ]);
  });

  it('restricts the sweep to the requested user and tenant scope', () => {
    const { mutationId: mineId } = seedAuthParkedMutation({ taskId: 'task-scope-mine' });
    const { mutationId: otherId } = seedAuthParkedMutation({ taskId: 'task-scope-other', userId: 7, tenantId: 7 });

    const scopedToUser = requeueAuthParkedMutations({ userId: USER_ID });

    expect(scopedToUser).toEqual({ requeued: 1, deadLettered: 0 });
    expect(getMutationRow(mineId).next_retry_at).not.toBeNull();
    expect(getMutationRow(otherId).next_retry_at).toBeNull();

    const scopedToTenant = requeueAuthParkedMutations({ tenantId: 7 });

    expect(scopedToTenant).toEqual({ requeued: 1, deadLettered: 0 });
    expect(getMutationRow(otherId).next_retry_at).not.toBeNull();
  });

  it('is idempotent — a second sweep re-arms nothing new', () => {
    const { mutationId } = seedAuthParkedMutation({ taskId: 'task-idem-requeue' });

    const first = requeueAuthParkedMutations({ tenantId: USER_ID, userId: USER_ID });
    const armedAt = getMutationRow(mutationId).next_retry_at;
    const second = requeueAuthParkedMutations({ tenantId: USER_ID, userId: USER_ID });

    expect(first).toEqual({ requeued: 1, deadLettered: 0 });
    expect(second).toEqual({ requeued: 0, deadLettered: 0 });
    expect(armedAt).not.toBeNull();
    expect(getMutationRow(mutationId).next_retry_at).toBe(armedAt);
  });
});

describe('getTaskSyncOperationalMetrics user scoping', () => {
  it('filters mutation backlog and task counts to the requesting user (NEX-26)', () => {
    seedAuthParkedMutation({ taskId: 'task-metrics-mine' });
    seedAuthParkedMutation({ taskId: 'task-metrics-teammate', userId: 7, tenantId: USER_ID });

    const scoped = getTaskSyncOperationalMetrics(USER_ID, USER_ID);
    const tenantWide = getTaskSyncOperationalMetrics(USER_ID);

    const backlogTotal = (metrics: { mutationBacklog: Array<{ count: number }> }) =>
      metrics.mutationBacklog.reduce((sum, row) => sum + row.count, 0);
    expect(backlogTotal(scoped)).toBe(1);
    expect(backlogTotal(tenantWide)).toBe(2);
    expect(scoped.taskCounts.providerDisconnected).toBe(1);
    expect(tenantWide.taskCounts.providerDisconnected).toBe(2);
  });
});

describe('M5B list.* mutation dispatch', () => {
  function seedListMutation(input: {
    mutationId?: string;
    operation: 'list.create' | 'list.delete';
    patch: Record<string, unknown>;
    status?: string;
  }): string {
    const mutationId = input.mutationId || `mutation-${input.operation}-${Math.random().toString(16).slice(2)}`;
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, status, retry_count
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)`,
    ).run(
      mutationId,
      `client-${mutationId}`,
      `idem-${mutationId}`,
      USER_ID,
      USER_ID,
      input.operation,
      JSON.stringify(input.patch),
      input.status || 'queued',
    );
    return mutationId;
  }

  function mutationStatus(mutationId: string): string {
    return (testDb.prepare('SELECT status FROM task_mutations WHERE mutation_id = ?').get(mutationId) as { status: string }).status;
  }

  function seedLocalNexusList(name: string): string {
    const result = testDb.prepare(
      `INSERT INTO unified_projects (user_id, tenant_id, provider, external_id, name, is_default, task_count)
       VALUES (?, ?, 'nexus', ?, ?, 0, 0)`,
    ).run(USER_ID, USER_ID, `nexus_list_${name.toLowerCase()}`, name);
    return String(result.lastInsertRowid);
  }

  it('pushes list.create, records the provider row + mapping, and the created list appears EXACTLY ONCE', async () => {
    const localListId = seedLocalNexusList('Groceries');
    providerApi.createList.mockResolvedValue({ success: true, data: { id: 'ms-list-groceries', displayName: 'Groceries' } });
    const mutationId = seedListMutation({
      operation: 'list.create',
      patch: { listId: localListId, name: 'Groceries', provider: 'ms_todo' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(providerApi.createList).toHaveBeenCalledWith('Groceries');
    expect(mutationStatus(mutationId)).toBe('synced');

    const providerRow = testDb.prepare(
      `SELECT id FROM unified_projects WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'ms-list-groceries'`,
    ).get(USER_ID) as { id: number } | undefined;
    expect(providerRow).toBeTruthy();

    const mirrorMapping = testDb.prepare(
      `SELECT provider_container_id FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ? AND provider = 'ms_todo'`,
    ).get(USER_ID, USER_ID, localListId) as { provider_container_id: string } | undefined;
    expect(mirrorMapping?.provider_container_id).toBe('ms-list-groceries');

    // Exactly-once regression: the provider row is the visible list; the
    // local nexus mirror is hidden behind the mapping.
    const lists = getOfflineTaskLists(USER_ID, USER_ID).lists.filter((list: any) => list.name === 'Groceries');
    expect(lists).toHaveLength(1);
    expect(lists[0].id).toBe(String(providerRow!.id));
  });

  it('short-circuits nexus_local list mutations to synced without any provider call', async () => {
    const mutationId = seedListMutation({
      operation: 'list.create',
      patch: { listId: '12', name: 'Local Only', provider: 'nexus_local' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(mutationStatus(mutationId)).toBe('synced');
    expect(providerApi.createList).not.toHaveBeenCalled();
    expect(providerApi.deleteList).not.toHaveBeenCalled();
  });

  it('pushes list.delete with the PROVIDER container id from the patch — never the local numeric row id (NEX-10 pin)', async () => {
    providerApi.deleteList.mockResolvedValue({ success: true, data: undefined });
    const mutationId = seedListMutation({
      operation: 'list.delete',
      patch: { listId: '55', name: 'Groceries', provider: 'ms_todo', providerContainerId: 'ms-list-groceries' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(mutationStatus(mutationId)).toBe('synced');
    expect(providerApi.deleteList).toHaveBeenCalledTimes(1);
    expect(providerApi.deleteList).toHaveBeenCalledWith('ms-list-groceries');
    expect(providerApi.deleteList).not.toHaveBeenCalledWith('55');
  });

  it('treats a provider 404 on list.delete as converged', async () => {
    providerApi.deleteList.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const mutationId = seedListMutation({
      operation: 'list.delete',
      patch: { listId: '55', name: 'Gone', provider: 'ms_todo', providerContainerId: 'ms-list-gone' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(mutationStatus(mutationId)).toBe('synced');
  });

  it('marks list.delete synced without a provider call when no provider container id was captured', async () => {
    const mutationId = seedListMutation({
      operation: 'list.delete',
      patch: { listId: '55', name: 'Local only', provider: 'ms_todo', providerContainerId: null },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.synced).toBe(1);
    expect(mutationStatus(mutationId)).toBe('synced');
    expect(providerApi.deleteList).not.toHaveBeenCalled();
  });

  it('dead-letters list.create mutations that carry no list name', async () => {
    const mutationId = seedListMutation({
      operation: 'list.create',
      patch: { listId: '55', name: '', provider: 'ms_todo' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.deadLettered).toBe(1);
    expect(mutationStatus(mutationId)).toBe('dead_letter');
    expect(providerApi.createList).not.toHaveBeenCalled();
  });

  it('retries list mutations when the provider is disconnected (same taxonomy as task mutations)', async () => {
    vi.mocked(isConnected).mockReturnValue(false);
    const mutationId = seedListMutation({
      operation: 'list.create',
      patch: { listId: '77', name: 'Waiting', provider: 'ms_todo' },
    });

    const result = await runTaskMutationSyncBatch({ userId: USER_ID });

    expect(result.failedRetryable).toBe(1);
    expect(mutationStatus(mutationId)).toBe('failed');
    const row = testDb.prepare('SELECT next_retry_at FROM task_mutations WHERE mutation_id = ?').get(mutationId) as { next_retry_at: string | null };
    expect(row.next_retry_at).toBeTruthy();
    expect(providerApi.createList).not.toHaveBeenCalled();
  });

  it('parks list mutations on provider 401 and re-arms them on reconnect', async () => {
    providerApi.createList.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    const mutationId = seedListMutation({
      operation: 'list.create',
      patch: { listId: '78', name: 'Parked', provider: 'ms_todo' },
    });

    const parked = await runTaskMutationSyncBatch({ userId: USER_ID });
    expect(parked.providerDisconnected).toBe(1);
    expect(mutationStatus(mutationId)).toBe('failed');
    const parkedRow = testDb.prepare('SELECT next_retry_at, last_error_code FROM task_mutations WHERE mutation_id = ?').get(mutationId) as { next_retry_at: string | null; last_error_code: string };
    expect(parkedRow.next_retry_at).toBeNull();
    expect(parkedRow.last_error_code).toBe('provider_auth_expired');

    const requeue = requeueAuthParkedMutations({ userId: USER_ID });
    expect(requeue.requeued).toBe(1);
    const rearmed = testDb.prepare('SELECT next_retry_at FROM task_mutations WHERE mutation_id = ?').get(mutationId) as { next_retry_at: string | null };
    expect(rearmed.next_retry_at).toBeTruthy();
  });
});
