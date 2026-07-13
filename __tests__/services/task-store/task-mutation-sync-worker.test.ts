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

import { runTaskMutationSyncBatch } from '../../../src/services/task-store/task-mutation-sync-worker';

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
