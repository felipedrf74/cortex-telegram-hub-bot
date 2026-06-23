import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockResolveTaskProvider = vi.fn(() => 'nexus');
const mockGetTaskProviderForUser = vi.fn();
const mockInvalidateTaskCaches = vi.fn();
const mockLoggerError = vi.fn();
const mockGetUserTimezone = vi.fn(() => 'Europe/Lisbon');

let testDb: Database.Database;

const { providerApi } = vi.hoisted(() => ({
  providerApi: {
    getLists: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getAllPendingTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    deleteTask: vi.fn(),
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: (...args: unknown[]) => mockResolveTaskProvider(...args),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/microsoft-todo', () => providerApi);

vi.mock('../../src/services/microsoft-auth', () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    })),
  })),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(),
  setCache: vi.fn(),
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
  getCachedSWR: vi.fn(() => null),
  setCacheSWR: vi.fn(),
  userCacheKey: (userId: number, key: string) => `u:${userId}:${key}`,
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateTaskCaches: (...args: unknown[]) => mockInvalidateTaskCaches(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapUser: vi.fn(() => null),
  getUserTimezone: (...args: unknown[]) => mockGetUserTimezone(...args),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezone(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { taskRoutes } from '../../src/api/routes/tasks';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER
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
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, provider, external_id)
    );

    CREATE TABLE unified_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
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
      nexus_task_id TEXT,
      local_version INTEGER NOT NULL DEFAULT 1,
      sync_state TEXT NOT NULL DEFAULT 'synced',
      source_of_truth TEXT NOT NULL DEFAULT 'nexus',
      deleted_at TEXT,
      UNIQUE(user_id, provider, external_id)
    );
    CREATE UNIQUE INDEX idx_unified_tasks_nexus_identity
      ON unified_tasks(tenant_id, user_id, nexus_task_id)
      WHERE nexus_task_id IS NOT NULL;

    CREATE TABLE task_sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      last_sync_at TEXT,
      sync_cursor TEXT,
      status TEXT DEFAULT 'idle',
      error_message TEXT,
      tasks_synced INTEGER DEFAULT 0,
      sync_duration_ms INTEGER,
      UNIQUE(user_id, provider)
    );

    CREATE TABLE user_task_preferences (
      user_id INTEGER PRIMARY KEY,
      default_provider TEXT NOT NULL DEFAULT 'nexus',
      primary_provider TEXT,
      sync_enabled INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, provider, provider_account_id, provider_task_id)
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
      last_error_message TEXT,
      UNIQUE(tenant_id, user_id, client_mutation_id, operation),
      UNIQUE(tenant_id, user_id, idempotency_key, operation)
    );

    CREATE TABLE task_container_mappings (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      nexus_list_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_container_type TEXT NOT NULL,
      provider_container_id TEXT NOT NULL,
      sync_direction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, nexus_list_id, provider)
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

    CREATE TABLE task_sync_observability_events (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      provider TEXT,
      event_type TEXT NOT NULL,
      operation TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO users (id, telegram_id) VALUES (?, ?)').run(12, 12);
  db.prepare('INSERT INTO users (id, telegram_id) VALUES (?, ?)').run(99, 99);
  return db;
}

function mockRes(onDone?: () => void): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: any) {
      response.body = body;
      onDone?.();
      return response;
    },
    setHeader(name: string, value: string) {
      response.headers[name] = value;
      return response;
    },
    end() {
      onDone?.();
      return response;
    },
  };
  return response;
}

function mockReq(
  method: string,
  path: string,
  options: {
    userId?: number;
    tenantId?: number;
    query?: Record<string, any>;
    params?: Record<string, string>;
    body?: Record<string, any>;
  } = {},
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: options.query || {},
    params: options.params || {},
    body: options.body || {},
    headers: {},
    userId: options.userId ?? 12,
    tenantId: options.tenantId ?? options.userId ?? 12,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  options: {
    userId?: number;
    tenantId?: number;
    query?: Record<string, any>;
    params?: Record<string, string>;
    body?: Record<string, any>;
  } = {},
): Promise<MockRes> {
  const router = taskRoutes();
  const req = mockReq(method, path, options);
  let res!: MockRes;

  await new Promise<void>((resolve, reject) => {
    res = mockRes(resolve);
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  return res;
}

function rejectProviderReads(): void {
  providerApi.getLists.mockRejectedValue(new Error('provider must not be called'));
  providerApi.getTasks.mockRejectedValue(new Error('provider must not be called'));
  providerApi.getTask.mockRejectedValue(new Error('provider must not be called'));
  providerApi.getAllPendingTasks.mockRejectedValue(new Error('provider must not be called'));
}

function expectNoProviderReads(): void {
  expect(providerApi.getLists).not.toHaveBeenCalled();
  expect(providerApi.getTasks).not.toHaveBeenCalled();
  expect(providerApi.getTask).not.toHaveBeenCalled();
  expect(providerApi.getAllPendingTasks).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantScopeAnomaliesForTests();
  vi.spyOn(global, 'setTimeout').mockImplementation((() => 0) as any);
  testDb = createTestDb();
  mockResolveTaskProvider.mockReturnValue('nexus');
  mockGetTaskProviderForUser.mockReturnValue(providerApi);
  rejectProviderReads();
});

afterEach(() => {
  testDb?.close();
  vi.restoreAllMocks();
});

describe('offline-first task routes', () => {
  it('fails closed on invalid tenant scope before loading tasks', async () => {
    const res = await dispatch('GET', '/lists', { userId: 0 });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'tasks_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('creates Nexus-local tasks idempotently and records one mutation ledger row', async () => {
    const first = await dispatch('POST', '/', {
      body: {
        title: 'Draft offline-first task plan',
        listName: 'Tasks',
        clientMutationId: 'ios-route-create-1',
        idempotencyKey: 'route-idem-create-1',
      },
    });
    const second = await dispatch('POST', '/', {
      body: {
        title: 'Draft offline-first task plan',
        listName: 'Tasks',
        clientMutationId: 'ios-route-create-1',
        idempotencyKey: 'route-idem-create-1',
      },
    });

    const taskCount = testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks').get() as { count: number };
    const mutationCount = testDb.prepare('SELECT COUNT(*) AS count FROM task_mutations').get() as { count: number };
    const syncStatus = await dispatch('GET', '/sync/status');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.body.data.task.id).toBe(second.body.data.task.id);
    expect(second.body.data.idempotentReplay).toBe(true);
    expect(first.body.data.task.syncState).toBe('local_only');
    expect(first.body.data.task.syncProvider).toBe('nexus');
    expect(taskCount.count).toBe(1);
    expect(mutationCount.count).toBe(1);
    expect(syncStatus.body.data.duplicatePreventionHits).toBe(1);
    expect(syncStatus.body.data.taskCounts.localOnly).toBe(1);
    expectNoProviderReads();
  });

  it('renders list, snapshot, changes, filtered, list-detail, and task-detail reads from local state only', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Read from Nexus local truth',
        listName: 'Inbox',
        dueDateTime: '2026-06-23T09:00:00Z',
        clientMutationId: 'ios-route-create-reads',
        idempotencyKey: 'route-idem-create-reads',
      },
    });
    const task = created.body.data.task;

    const lists = await dispatch('GET', '/lists');
    const snapshot = await dispatch('GET', '/snapshot');
    const workingSet = await dispatch('GET', '/working-set');
    const changes = await dispatch('GET', '/changes');
    const filtered = await dispatch('GET', '/filtered', { query: { filter: 'all' } });
    const listDetail = await dispatch('GET', `/list/${task.listId}`, {
      params: { listId: task.listId },
      query: { scope: 'active' },
    });
    const taskDetail = await dispatch('GET', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
    });

    expect(lists.statusCode).toBe(200);
    expect(lists.body.data.lists).toEqual([
      expect.objectContaining({ id: task.listId, name: 'Inbox', taskCount: 1 }),
    ]);
    expect(lists.body.data.freshness.reasonCodes).toContain('local_read_model');

    expect(snapshot.body.data.tasks).toEqual([
      expect.objectContaining({ id: task.id, title: 'Read from Nexus local truth' }),
    ]);
    expect(snapshot.body.data.pendingMutationCount).toBe(0);
    expect(workingSet.body.data.policyVersion).toBe('offline_first_tasks_v1');
    expect(workingSet.body.data.activePage.tasks).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(changes.body.data.upserts).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(filtered.body.data.tasks).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(listDetail.body.data.tasks).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(taskDetail.body.data.task).toEqual(expect.objectContaining({ id: task.id }));
    expectNoProviderReads();
  });

  it('degrades freshness instead of failing read paths when provider sync state has an error', async () => {
    await dispatch('POST', '/', {
      body: {
        title: 'Provider down but panel still paints',
        listName: 'Tasks',
        clientMutationId: 'ios-route-create-degraded',
        idempotencyKey: 'route-idem-create-degraded',
      },
    });
    testDb.prepare(
      `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status, error_message)
       VALUES (?, 'ms_todo', ?, 'error', ?)`,
    ).run(12, '2026-06-23T08:30:00Z', 'graph timeout');

    const res = await dispatch('GET', '/working-set');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks).toEqual([
      expect.objectContaining({ title: 'Provider down but panel still paints' }),
    ]);
    expect(res.body.data.freshness.providerStates).toContainEqual(
      expect.objectContaining({
        provider: 'ms_todo',
        state: 'failed',
        lastErrorCode: 'provider_sync_error',
      }),
    );
    expectNoProviderReads();
  });

  it('saves provider-targeted creates locally with typed warnings when container mapping is missing', async () => {
    mockResolveTaskProvider.mockReturnValue('ms_todo');

    const res = await dispatch('POST', '/', {
      body: {
        title: 'Save while Microsoft mapping is missing',
        listName: 'Work',
        clientMutationId: 'ios-route-create-ms-missing-list',
        idempotencyKey: 'route-idem-create-ms-missing-list',
      },
    });
    const mutation = testDb.prepare(
      `SELECT status FROM task_mutations WHERE client_mutation_id = ?`,
    ).get('ios-route-create-ms-missing-list') as { status: string };

    expect(res.statusCode).toBe(201);
    expect(res.body.data.task.syncState).toBe('failed_permanent');
    expect(res.body.data.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_list_missing', provider: 'ms_todo' }),
    ]));
    expect(mutation.status).toBe('failed');
    expect(providerApi.createTask).not.toHaveBeenCalled();
    expectNoProviderReads();
  });

  it('assigns a provider and retries provider sync through local ledger endpoints', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Assign and retry without live provider calls',
        listName: 'Work',
        clientMutationId: 'ios-route-create-assign-retry',
        idempotencyKey: 'route-idem-create-assign-retry',
      },
    });
    const task = created.body.data.task;
    testDb.prepare(
      `INSERT INTO task_container_mappings (
         id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
         provider_container_id, sync_direction
       ) VALUES ('route-ms-work', ?, ?, ?, 'ms_todo', 'todo_list', 'route-ms-list', 'bidirectional')`,
    ).run(12, 12, task.listId);

    const assigned = await dispatch('POST', `/${task.listId}/${task.id}/sync/assign-provider`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        provider: 'microsoft_todo',
        clientMutationId: 'ios-route-assign-provider-1',
        idempotencyKey: 'route-idem-assign-provider-1',
      },
    });
    testDb.prepare(
      `UPDATE unified_tasks
       SET sync_state = 'failed_retryable'
       WHERE nexus_task_id = ?`,
    ).run(task.id);
    testDb.prepare(
      `UPDATE task_provider_links
       SET link_state = 'stale'
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).run(task.id);
    const retried = await dispatch('POST', `/${task.listId}/${task.id}/sync/retry`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-route-retry-sync-1',
        idempotencyKey: 'route-idem-retry-sync-1',
      },
    });

    const operations = testDb.prepare(
      `SELECT operation, status
       FROM task_mutations
       WHERE task_id = ? AND operation IN ('task.assign_provider', 'task.retry_sync')
       ORDER BY operation`,
    ).all(task.id) as Array<{ operation: string; status: string }>;
    const link = testDb.prepare(
      `SELECT provider, provider_task_id, provider_list_id, link_state
       FROM task_provider_links
       WHERE task_id = ? AND provider = 'ms_todo'`,
    ).get(task.id) as { provider: string; provider_task_id: string | null; provider_list_id: string | null; link_state: string };

    expect(assigned.statusCode).toBe(200);
    expect(assigned.body.data.task.syncState).toBe('queued');
    expect(retried.statusCode).toBe(200);
    expect(retried.body.data.task.syncState).toBe('queued');
    expect(operations).toEqual([
      { operation: 'task.assign_provider', status: 'queued' },
      { operation: 'task.retry_sync', status: 'queued' },
    ]);
    expect(link).toEqual({
      provider: 'ms_todo',
      provider_task_id: null,
      provider_list_id: 'route-ms-list',
      link_state: 'pending_create',
    });
    expect(providerApi.createTask).not.toHaveBeenCalled();
    expect(providerApi.updateTask).not.toHaveBeenCalled();
    expectNoProviderReads();
  });

  it('records complete, reopen, move, and delete as local mutations with stable Nexus identity', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Move through local ledger',
        listName: 'Tasks',
        clientMutationId: 'ios-route-create-mutations',
        idempotencyKey: 'route-idem-create-mutations',
      },
    });
    await dispatch('POST', '/', {
      body: {
        title: 'Target list seed',
        listName: 'Work',
        clientMutationId: 'ios-route-create-target-list',
        idempotencyKey: 'route-idem-create-target-list',
      },
    });
    const task = created.body.data.task;
    const targetList = testDb.prepare(
      `SELECT id FROM unified_projects WHERE tenant_id = ? AND user_id = ? AND name = 'Work' LIMIT 1`,
    ).get(12, 12) as { id: number };

    const complete = await dispatch('POST', `/${task.listId}/${task.id}/complete`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-route-complete-1',
        idempotencyKey: 'route-idem-complete-1',
      },
    });
    const reopen = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        status: 'notStarted',
        clientMutationId: 'ios-route-reopen-1',
        idempotencyKey: 'route-idem-reopen-1',
      },
    });
    const move = await dispatch('POST', `/${task.listId}/${task.id}/move`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        targetListId: String(targetList.id),
        clientMutationId: 'ios-route-move-1',
        idempotencyKey: 'route-idem-move-1',
      },
    });
    const del = await dispatch('DELETE', `/${targetList.id}/${task.id}`, {
      params: { listId: String(targetList.id), taskId: task.id },
      query: {
        clientMutationId: 'ios-route-delete-1',
        idempotencyKey: 'route-idem-delete-1',
      },
    });

    const operations = testDb.prepare(
      `SELECT operation, status
       FROM task_mutations
       WHERE task_id = ?
       ORDER BY created_at, operation`,
    ).all(task.id) as Array<{ operation: string; status: string }>;
    const finalTask = testDb.prepare(
      `SELECT nexus_task_id, project_id, is_deleted, sync_state
       FROM unified_tasks
       WHERE nexus_task_id = ?`,
    ).get(task.id) as { nexus_task_id: string; project_id: number; is_deleted: number; sync_state: string };

    expect(complete.statusCode).toBe(200);
    expect(reopen.statusCode).toBe(200);
    expect(move.statusCode).toBe(200);
    expect(del.statusCode).toBe(200);
    expect(finalTask.nexus_task_id).toBe(task.id);
    expect(finalTask.project_id).toBe(targetList.id);
    expect(finalTask.is_deleted).toBe(1);
    expect(finalTask.sync_state).toBe('local_only');
    expect(operations.map((row) => row.operation).sort()).toEqual([
      'task.complete',
      'task.create',
      'task.move',
      'task.reopen',
      'task.delete',
    ].sort());
    expect(new Set(operations.map((row) => row.status))).toEqual(new Set(['synced']));
    expectNoProviderReads();
  });

  it('adds and toggles checklist items through the local ledger without provider calls', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Checklist local route',
        listName: 'Tasks',
        clientMutationId: 'ios-route-create-checklist',
        idempotencyKey: 'route-idem-create-checklist',
      },
    });
    const task = created.body.data.task;

    const added = await dispatch('POST', `/${task.listId}/${task.id}/checklist`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        displayName: 'Confirm venue',
        itemId: 'checklist-route-1',
        clientMutationId: 'ios-route-checklist-add-1',
        idempotencyKey: 'route-idem-checklist-add-1',
      },
    });
    const toggled = await dispatch('PATCH', `/${task.listId}/${task.id}/checklist/checklist-route-1`, {
      params: { listId: task.listId, taskId: task.id, itemId: 'checklist-route-1' },
      body: {
        isChecked: true,
        clientMutationId: 'ios-route-checklist-toggle-1',
        idempotencyKey: 'route-idem-checklist-toggle-1',
      },
    });

    const mutations = testDb.prepare(
      `SELECT operation, status
       FROM task_mutations
       WHERE task_id = ? AND operation LIKE 'task.checklist.%'
       ORDER BY operation`,
    ).all(task.id) as Array<{ operation: string; status: string }>;

    expect(added.statusCode).toBe(201);
    expect(added.body.data.item).toEqual({ id: 'checklist-route-1', displayName: 'Confirm venue', isChecked: false });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.body.data.task.checklistItems).toEqual([
      { id: 'checklist-route-1', displayName: 'Confirm venue', isChecked: true },
    ]);
    expect(mutations).toEqual([
      { operation: 'task.checklist.add', status: 'synced' },
      { operation: 'task.checklist.update', status: 'synced' },
    ]);
    expect(providerApi.createTask).not.toHaveBeenCalled();
    expect(providerApi.updateTask).not.toHaveBeenCalled();
    expect(providerApi.completeTask).not.toHaveBeenCalled();
    expect(providerApi.deleteTask).not.toHaveBeenCalled();
    expectNoProviderReads();
  });

  it('does not expose tasks across tenant/user local read scopes', async () => {
    const tenantA = await dispatch('POST', '/', {
      userId: 12,
      tenantId: 12,
      body: {
        title: 'Tenant A task',
        listName: 'Tasks',
        clientMutationId: 'ios-route-tenant-a',
        idempotencyKey: 'route-idem-tenant-a',
      },
    });
    await dispatch('POST', '/', {
      userId: 99,
      tenantId: 99,
      body: {
        title: 'Tenant B task',
        listName: 'Tasks',
        clientMutationId: 'ios-route-tenant-b',
        idempotencyKey: 'route-idem-tenant-b',
      },
    });

    const tenantARead = await dispatch('GET', '/working-set', { userId: 12, tenantId: 12 });
    const tenantBRead = await dispatch('GET', '/working-set', { userId: 99, tenantId: 99 });
    const crossTenantDetail = await dispatch('GET', `/1/${tenantA.body.data.task.id}`, {
      userId: 99,
      tenantId: 99,
      params: { listId: '1', taskId: tenantA.body.data.task.id },
    });

    expect(tenantARead.body.data.tasks.map((task: any) => task.title)).toEqual(['Tenant A task']);
    expect(tenantBRead.body.data.tasks.map((task: any) => task.title)).toEqual(['Tenant B task']);
    expect(crossTenantDetail.statusCode).toBe(404);
    expect(crossTenantDetail.body.error.code).toBe('NOT_FOUND');
    expectNoProviderReads();
  });

  it('does not fall back to live providers when local mutation targets are missing', async () => {
    const update = await dispatch('PATCH', '/list-1/provider-task-1', {
      params: { listId: 'list-1', taskId: 'provider-task-1' },
      body: {
        title: 'Should not hit provider',
        clientMutationId: 'missing-update',
        idempotencyKey: 'missing-update-idem',
      },
    });
    const complete = await dispatch('POST', '/list-1/provider-task-1/complete', {
      params: { listId: 'list-1', taskId: 'provider-task-1' },
      body: {
        clientMutationId: 'missing-complete',
        idempotencyKey: 'missing-complete-idem',
      },
    });
    const move = await dispatch('POST', '/list-1/provider-task-1/move', {
      params: { listId: 'list-1', taskId: 'provider-task-1' },
      body: {
        targetListId: 'list-2',
        clientMutationId: 'missing-move',
        idempotencyKey: 'missing-move-idem',
      },
    });
    const del = await dispatch('DELETE', '/list-1/provider-task-1', {
      params: { listId: 'list-1', taskId: 'provider-task-1' },
      query: {
        clientMutationId: 'missing-delete',
        idempotencyKey: 'missing-delete-idem',
      },
    });

    expect(update.statusCode).toBe(404);
    expect(complete.statusCode).toBe(404);
    expect(move.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    expect(providerApi.updateTask).not.toHaveBeenCalled();
    expect(providerApi.completeTask).not.toHaveBeenCalled();
    expect(providerApi.deleteTask).not.toHaveBeenCalled();
    expect(providerApi.createTask).not.toHaveBeenCalled();
    expectNoProviderReads();
  });
});
