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
    createList: vi.fn(),
    deleteList: vi.fn(),
  },
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
      last_synced_snapshot TEXT,
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
      available_at TEXT,
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
  vi.unstubAllEnvs();
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

  it('maps auth-flavored provider sync errors to provider_auth_expired in freshness', async () => {
    testDb.prepare(
      `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status, error_message)
       VALUES (?, 'ms_todo', ?, 'error', ?)`,
    ).run(12, '2026-06-23T08:30:00Z', 'Microsoft Graph rejected the token: 401 unauthorized');

    const res = await dispatch('GET', '/working-set');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.freshness.providerStates).toContainEqual(
      expect.objectContaining({
        provider: 'ms_todo',
        state: 'failed',
        lastErrorCode: 'provider_auth_expired',
      }),
    );
    expectNoProviderReads();
  });

  it('scopes sync/status metrics to the requesting user and tenant (NEX-26)', async () => {
    const insertMutation = testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id, task_id, operation, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'task.update', 'queued')`,
    );
    // Requesting user (tenant 12, user 12): 2 pending mutations.
    insertMutation.run('m-u12-1', 'c-u12-1', 'i-u12-1', 12, 12, 'task-a');
    insertMutation.run('m-u12-2', 'c-u12-2', 'i-u12-2', 12, 12, 'task-b');
    // Other user in the SAME tenant: 3 pending mutations that must be excluded.
    insertMutation.run('m-u99-1', 'c-u99-1', 'i-u99-1', 12, 99, 'task-c');
    insertMutation.run('m-u99-2', 'c-u99-2', 'i-u99-2', 12, 99, 'task-d');
    insertMutation.run('m-u99-3', 'c-u99-3', 'i-u99-3', 12, 99, 'task-e');
    // Same user in ANOTHER tenant: proves tenantId is still applied alongside userId.
    insertMutation.run('m-t999-1', 'c-t999-1', 'i-t999-1', 999, 12, 'task-f');
    const insertTask = testDb.prepare(
      `INSERT INTO unified_tasks (user_id, tenant_id, provider, external_id, title, sync_state, nexus_task_id)
       VALUES (?, ?, 'nexus', ?, ?, 'local_only', ?)`,
    );
    insertTask.run(12, 12, 'ext-mine', 'Requesting user local-only task', 'nexus-mine');
    insertTask.run(99, 12, 'ext-other', 'Other tenant member local-only task', 'nexus-other');
    testDb.prepare(
      `INSERT INTO task_sync_observability_events (id, tenant_id, user_id, event_type, operation)
       VALUES ('evt-u99-dup', 12, 99, 'duplicate_prevention_hit', 'task.create')`,
    ).run();

    const res = await dispatch('GET', '/sync/status', { userId: 12, tenantId: 12 });

    expect(res.statusCode).toBe(200);
    const queuedBacklog = res.body.data.mutationBacklog.filter((row: any) => row.status === 'queued');
    expect(queuedBacklog).toEqual([
      expect.objectContaining({ status: 'queued', count: 2 }),
    ]);
    expect(res.body.data.taskCounts.localOnly).toBe(1);
    expect(res.body.data.taskSyncStates).toEqual([
      { syncState: 'local_only', count: 1 },
    ]);
    expect(res.body.data.duplicatePreventionHits).toBe(0);
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

// ── Conflict resolution routes (M2B) ─────────────────────────────────

function seedConflictTask(input: {
  taskId?: string;
  syncState?: string;
  linkState?: string;
  providerVersion?: string | null;
} = {}) {
  const taskId = input.taskId || 'task-conflicted-1';
  testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_id, project_name,
       title, status, priority, due_date, due_is_datetime, notes,
       nexus_task_id, local_version, sync_state, source_of_truth
     ) VALUES (12, 12, 'nexus', ?, NULL, 'Work', 'Local conflicted title', 'pending', 2,
       '2026-07-18T10:00:00Z', 1, 'local note', ?, 3, ?, 'nexus')`,
  ).run(taskId, taskId, input.syncState || 'conflict');
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_version, ownership, link_state
     ) VALUES (?, ?, 12, 12, 'ms_todo', 'ms_todo:12', 'ms-task-1', 'ms-list-1', ?, 'nexus_created', ?)`,
  ).run(`link-${taskId}`, taskId, input.providerVersion === undefined ? 'etag-v1' : input.providerVersion, input.linkState || 'conflict');
  testDb.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, patch_json, status, last_error_code
     ) VALUES (?, ?, ?, 12, 12, ?, 'task.update', '{}', 'conflict', 'provider_conflict')`,
  ).run(`mutation-${taskId}`, `client-${taskId}`, `idem-${taskId}`, taskId);
  testDb.prepare(
    `INSERT INTO task_sync_issues (
       id, task_id, tenant_id, user_id, provider, code, state
     ) VALUES (?, ?, 12, 12, 'ms_todo', 'provider_conflict', 'open')`,
  ).run(`issue-${taskId}`, taskId);
  return { taskId };
}

const freshProviderCopy = {
  success: true,
  data: {
    id: 'ms-task-1',
    title: 'Provider edited title',
    status: 'completed',
    importance: 'high',
    body: { content: 'provider body', contentType: 'text' },
    dueDateTime: { dateTime: '2026-07-21T09:00:00Z', timeZone: 'UTC' },
    '@odata.etag': 'etag-v2',
  },
};

describe('task sync conflict routes (M2B)', () => {
  it('previews a conflict with a LIVE provider re-fetch: mine, theirs, fresh version', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(freshProviderCopy);

    const res = await dispatch('GET', `/list-1/${taskId}/sync/conflict`, {
      params: { listId: 'list-1', taskId },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(providerApi.getTask).toHaveBeenCalledWith('ms-list-1', 'ms-task-1', 'Work');
    expect(res.body.data).toMatchObject({
      conflictId: `conflict_${taskId}_etag-v1`,
      providerVersion: 'etag-v2',
      providerMissing: false,
      mine: expect.objectContaining({
        id: taskId,
        title: 'Local conflicted title',
        syncState: 'conflict',
        localVersion: 3,
      }),
      theirs: {
        title: 'Provider edited title',
        status: 'completed',
        dueDateTime: '2026-07-21T09:00:00Z',
        importance: 'high',
        body: 'provider body',
      },
    });
    expect(typeof res.body.data.fetchedAt).toBe('string');
  });

  it('returns 404 CONFLICT_NOT_FOUND for a task without an unresolved conflict', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Healthy task',
        listName: 'Tasks',
        clientMutationId: 'ios-conflict-healthy',
        idempotencyKey: 'idem-conflict-healthy',
      },
    });
    const taskId = created.body.data.task.id;

    const res = await dispatch('GET', `/list-1/${taskId}/sync/conflict`, {
      params: { listId: 'list-1', taskId },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('CONFLICT_NOT_FOUND');
    expectNoProviderReads();
  });

  it('returns 503 PROVIDER_UNAVAILABLE when the live provider read fails', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockRejectedValue(new Error('graph unreachable'));

    const res = await dispatch('GET', `/list-1/${taskId}/sync/conflict`, {
      params: { listId: 'list-1', taskId },
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('previews providerMissing with theirs:null when the provider says the task is gone', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue({ success: false, error: 'Not Found', statusCode: 404 });

    const res = await dispatch('GET', `/list-1/${taskId}/sync/conflict`, {
      params: { listId: 'list-1', taskId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      theirs: null,
      providerMissing: true,
      providerVersion: null,
    });
  });

  it('keep_local: supersedes conflicted mutations, requeues one full re-push with the fresh etag', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(freshProviderCopy);

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: {
        strategy: 'keep_local',
        expectedProviderVersion: 'etag-v2',
        clientMutationId: 'ios-resolve-keep-local-1',
        idempotencyKey: 'idem-resolve-keep-local-1',
      },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ resolved: true, strategy: 'keep_local' });
    expect(res.body.data.task.syncState).toBe('queued');

    const superseded = testDb.prepare(
      `SELECT status, last_error_code, locked_at, next_retry_at
       FROM task_mutations WHERE mutation_id = ?`,
    ).get(`mutation-${taskId}`) as Record<string, unknown>;
    expect(superseded).toEqual({
      status: 'superseded',
      last_error_code: 'conflict_resolved_keep_local',
      locked_at: null,
      next_retry_at: null,
    });

    const requeued = testDb.prepare(
      `SELECT operation, status, patch_json
       FROM task_mutations
       WHERE task_id = ? AND client_mutation_id = 'ios-resolve-keep-local-1'`,
    ).get(taskId) as { operation: string; status: string; patch_json: string };
    expect(requeued.operation).toBe('task.update');
    expect(requeued.status).toBe('queued');
    expect(JSON.parse(requeued.patch_json)).toMatchObject({
      resolution: 'keep_local',
      providerLinkProvider: 'ms_todo',
      title: 'Local conflicted title',
    });

    const link = testDb.prepare(
      `SELECT provider_version, link_state, provider_task_id FROM task_provider_links WHERE id = ?`,
    ).get(`link-${taskId}`) as Record<string, unknown>;
    expect(link).toEqual({
      provider_version: 'etag-v2',
      link_state: 'pending_update',
      provider_task_id: 'ms-task-1',
    });

    const task = testDb.prepare(
      `SELECT sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    expect(task.sync_state).toBe('queued');

    const issue = testDb.prepare(
      `SELECT state FROM task_sync_issues WHERE id = ?`,
    ).get(`issue-${taskId}`) as { state: string };
    expect(issue.state).toBe('resolved');
  });

  it('keep_provider: applies provider content, recomputes the hash, and retires pending mutations', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(freshProviderCopy);

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_provider', expectedProviderVersion: 'etag-v2' },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ resolved: true, strategy: 'keep_provider' });
    expect(res.body.data.task).toMatchObject({ title: 'Provider edited title', status: 'completed', syncState: 'synced' });

    const row = testDb.prepare(
      `SELECT title, status, priority, due_date, notes, sync_state, content_hash, local_version, provider, external_id
       FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as Record<string, unknown>;
    expect(row).toMatchObject({
      title: 'Provider edited title',
      status: 'completed',
      // M10 (NEX-17): provider importance 'high' shares the 'high' bucket
      // with the stored priority (2), so the stored fine-grained P2 is kept.
      priority: 2,
      due_date: '2026-07-21T09:00:00Z',
      notes: 'provider body',
      sync_state: 'synced',
      local_version: 4,
      // Canonical-links rule: origin identity untouched.
      provider: 'nexus',
      external_id: taskId,
    });
    expect(row.content_hash).toEqual(expect.any(String));

    const superseded = testDb.prepare(
      `SELECT status, last_error_code FROM task_mutations WHERE mutation_id = ?`,
    ).get(`mutation-${taskId}`) as Record<string, unknown>;
    expect(superseded).toEqual({ status: 'superseded', last_error_code: 'conflict_resolved_keep_provider' });

    const link = testDb.prepare(
      `SELECT provider_version, link_state, last_synced_snapshot FROM task_provider_links WHERE id = ?`,
    ).get(`link-${taskId}`) as { provider_version: string; link_state: string; last_synced_snapshot: string };
    expect(link.provider_version).toBe('etag-v2');
    expect(link.link_state).toBe('linked');
    expect(JSON.parse(link.last_synced_snapshot)).toMatchObject({
      title: 'Provider edited title',
      status: 'completed',
      // M10: same-bucket echo preserves the stored fine-grained P2.
      priority: 2,
      notes: 'provider body',
    });
  });

  it('rejects a stale expectedProviderVersion with 409 CONFLICT_STALE and a refreshed preview', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(freshProviderCopy);

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_local', expectedProviderVersion: 'etag-v1' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_STALE');
    expect(res.body.error.details.preview).toMatchObject({
      providerVersion: 'etag-v2',
      providerMissing: false,
      theirs: expect.objectContaining({ title: 'Provider edited title' }),
    });
    // Nothing changed: the conflict is still unresolved.
    const mutation = testDb.prepare(
      `SELECT status FROM task_mutations WHERE mutation_id = ?`,
    ).get(`mutation-${taskId}`) as { status: string };
    const task = testDb.prepare(
      `SELECT sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    expect(mutation.status).toBe('conflict');
    expect(task.sync_state).toBe('conflict');
  });

  it('keep_provider with the provider copy gone tombstones the row (accepted remote deletion)', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue({ success: false, error: 'Not Found', statusCode: 404 });

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_provider' },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.task.status).toBe('cancelled');
    const row = testDb.prepare(
      `SELECT is_deleted, deleted_at, sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { is_deleted: number; deleted_at: string | null; sync_state: string };
    expect(row.is_deleted).toBe(1);
    expect(row.deleted_at).toEqual(expect.any(String));
    expect(row.sync_state).toBe('synced');

    const link = testDb.prepare(
      `SELECT link_state, provider_task_id FROM task_provider_links WHERE id = ?`,
    ).get(`link-${taskId}`) as { link_state: string; provider_task_id: string | null };
    expect(link).toEqual({ link_state: 'orphaned', provider_task_id: null });

    const superseded = testDb.prepare(
      `SELECT status, last_error_code FROM task_mutations WHERE mutation_id = ?`,
    ).get(`mutation-${taskId}`) as Record<string, unknown>;
    expect(superseded).toEqual({ status: 'superseded', last_error_code: 'conflict_resolved_keep_provider' });
  });

  it('keep_local with the provider copy gone re-arms the create-recovery push', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue({ success: false, error: 'Not Found', statusCode: 404 });

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_local' },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.task.syncState).toBe('queued');
    const link = testDb.prepare(
      `SELECT link_state, provider_task_id, provider_version FROM task_provider_links WHERE id = ?`,
    ).get(`link-${taskId}`) as Record<string, unknown>;
    // provider_task_id cleared → the worker's existing create-recovery branch
    // (search by Nexus marker, then createTask) re-creates the provider copy.
    expect(link).toEqual({ link_state: 'pending_create', provider_task_id: null, provider_version: null });
  });

  it('validates the strategy before any provider read', async () => {
    const { taskId } = seedConflictTask();

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'merge_magically' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expectNoProviderReads();
  });
});

// ── Optional client OCC (NEX-24) ─────────────────────────────────────

describe('optional client OCC on task mutations (NEX-24)', () => {
  async function createBaseTask(suffix: string) {
    const created = await dispatch('POST', '/', {
      body: {
        title: `OCC base task ${suffix}`,
        listName: 'Tasks',
        clientMutationId: `ios-occ-create-${suffix}`,
        idempotencyKey: `idem-occ-create-${suffix}`,
      },
    });
    return created.body.data.task as { id: string; listId: string; localVersion: number };
  }

  it('PATCH without baseLocalVersion keeps the exact pre-OCC behavior', async () => {
    const task = await createBaseTask('absent');

    const res = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'Updated without OCC',
        clientMutationId: 'ios-occ-absent-1',
        idempotencyKey: 'idem-occ-absent-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task.title).toBe('Updated without OCC');
    expect(res.body.data.task.localVersion).toBe(2);
  });

  it('PATCH with a stale baseLocalVersion returns 409 VERSION_CONFLICT carrying the current task', async () => {
    const task = await createBaseTask('stale-patch');
    await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'Bumps version to 2',
        clientMutationId: 'ios-occ-bump-1',
        idempotencyKey: 'idem-occ-bump-1',
      },
    });

    const stale = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'From a stale client',
        baseLocalVersion: 1,
        clientMutationId: 'ios-occ-stale-1',
        idempotencyKey: 'idem-occ-stale-1',
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentTask).toMatchObject({
      id: task.id,
      title: 'Bumps version to 2',
      localVersion: 2,
    });
    const row = testDb.prepare(
      `SELECT title, local_version FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(task.id) as { title: string; local_version: number };
    expect(row).toEqual({ title: 'Bumps version to 2', local_version: 2 });
    const staleMutation = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE client_mutation_id = 'ios-occ-stale-1'`,
    ).get() as { count: number };
    expect(staleMutation.count).toBe(0);
  });

  it('PATCH with the current baseLocalVersion is applied', async () => {
    const task = await createBaseTask('current-patch');

    const res = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'Applied with matching base',
        baseLocalVersion: 1,
        clientMutationId: 'ios-occ-current-1',
        idempotencyKey: 'idem-occ-current-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task.title).toBe('Applied with matching base');
    expect(res.body.data.task.localVersion).toBe(2);
  });

  it('complete route: absent base unchanged, stale base 409, current base applied', async () => {
    const task = await createBaseTask('complete');
    // Bump to version 2 first.
    await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'Complete OCC bump',
        clientMutationId: 'ios-occ-complete-bump',
        idempotencyKey: 'idem-occ-complete-bump',
      },
    });

    const stale = await dispatch('POST', `/${task.listId}/${task.id}/complete`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        baseLocalVersion: 1,
        clientMutationId: 'ios-occ-complete-stale',
        idempotencyKey: 'idem-occ-complete-stale',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentTask).toMatchObject({ id: task.id, localVersion: 2 });

    const current = await dispatch('POST', `/${task.listId}/${task.id}/complete`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        baseLocalVersion: 2,
        clientMutationId: 'ios-occ-complete-current',
        idempotencyKey: 'idem-occ-complete-current',
      },
    });
    expect(current.statusCode).toBe(200);
    expect(current.body.data.task.status).toBe('completed');

    const absent = await dispatch('POST', `/${task.listId}/${task.id}/complete`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-occ-complete-absent',
        idempotencyKey: 'idem-occ-complete-absent',
      },
    });
    expect(absent.statusCode).toBe(200);
  });

  it('move and delete routes thread baseLocalVersion and 409 on stale bases', async () => {
    const task = await createBaseTask('move-delete');
    await dispatch('POST', '/', {
      body: {
        title: 'OCC move target list seed',
        listName: 'Work',
        clientMutationId: 'ios-occ-move-target',
        idempotencyKey: 'idem-occ-move-target',
      },
    });
    const targetList = testDb.prepare(
      `SELECT id FROM unified_projects WHERE tenant_id = 12 AND user_id = 12 AND name = 'Work' LIMIT 1`,
    ).get() as { id: number };

    const staleMove = await dispatch('POST', `/${task.listId}/${task.id}/move`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        targetListId: String(targetList.id),
        baseLocalVersion: 0,
        clientMutationId: 'ios-occ-move-stale',
        idempotencyKey: 'idem-occ-move-stale',
      },
    });
    expect(staleMove.statusCode).toBe(409);
    expect(staleMove.body.error.code).toBe('VERSION_CONFLICT');

    const staleDelete = await dispatch('DELETE', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        baseLocalVersion: 0,
        clientMutationId: 'ios-occ-delete-stale',
        idempotencyKey: 'idem-occ-delete-stale',
      },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.body.error.code).toBe('VERSION_CONFLICT');

    const row = testDb.prepare(
      `SELECT is_deleted, project_id FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(task.id) as { is_deleted: number; project_id: number | null };
    expect(row.is_deleted).toBe(0);
    expect(row.project_id).not.toBe(targetList.id);
  });

  it('accepts a non-numeric baseLocalVersion as absent instead of erroring', async () => {
    const task = await createBaseTask('non-numeric');

    const res = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        title: 'Non-numeric base is ignored',
        baseLocalVersion: 'not-a-version',
        clientMutationId: 'ios-occ-nonnumeric-1',
        idempotencyKey: 'idem-occ-nonnumeric-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task.title).toBe('Non-numeric base is ignored');
  });

  it('treats a falsy stored local_version as version 1 for the OCC comparison', async () => {
    const task = await createBaseTask('null-version');
    // local_version is NOT NULL — 0 is the falsy value the || 1 fallback
    // defends against.
    testDb.prepare(
      `UPDATE unified_tasks SET local_version = 0 WHERE nexus_task_id = ?`,
    ).run(task.id);

    const res = await dispatch('POST', `/${task.listId}/${task.id}/complete`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        baseLocalVersion: 1,
        clientMutationId: 'ios-occ-nullver-1',
        idempotencyKey: 'idem-occ-nullver-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task.status).toBe('completed');
  });

  it('maps non-OCC errors on the move route to a 500, not a 409', async () => {
    const task = await createBaseTask('move-bad-target');

    const res = await dispatch('POST', `/${task.listId}/${task.id}/move`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        targetListId: '999999',
        clientMutationId: 'ios-occ-move-badtarget',
        idempotencyKey: 'idem-occ-move-badtarget',
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).not.toBe('VERSION_CONFLICT');
  });
});

describe('conflict route error mapping (M2B)', () => {
  it('preview 404s NOT_FOUND for an unknown task id', async () => {
    const res = await dispatch('GET', '/list-1/task-does-not-exist/sync/conflict', {
      params: { listId: 'list-1', taskId: 'task-does-not-exist' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('resolve 404s NOT_FOUND for an unknown task id', async () => {
    const res = await dispatch('POST', '/list-1/task-does-not-exist/sync/resolve', {
      params: { listId: 'list-1', taskId: 'task-does-not-exist' },
      body: { strategy: 'keep_local' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('resolve 404s CONFLICT_NOT_FOUND for a healthy task', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Healthy resolve target',
        listName: 'Tasks',
        clientMutationId: 'ios-resolve-healthy',
        idempotencyKey: 'idem-resolve-healthy',
      },
    });
    const taskId = created.body.data.task.id;

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_provider' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('CONFLICT_NOT_FOUND');
  });

  it('resolve 503s PROVIDER_UNAVAILABLE when the live provider re-fetch fails', async () => {
    const { taskId } = seedConflictTask({ taskId: 'task-resolve-provider-down' });
    providerApi.getTask.mockRejectedValue(new Error('graph unreachable'));

    const res = await dispatch('POST', `/list-1/${taskId}/sync/resolve`, {
      params: { listId: 'list-1', taskId },
      body: { strategy: 'keep_local', expectedProviderVersion: 'etag-v1' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    const mutation = testDb.prepare(
      `SELECT status FROM task_mutations WHERE mutation_id = ?`,
    ).get('mutation-task-resolve-provider-down') as { status: string };
    expect(mutation.status).toBe('conflict');
  });
});

describe('M5B ledger list routes (single write path)', () => {
  it('POST /lists creates the list in the ledger and pins the deployed-iOS 201 contract', async () => {
    const res = await dispatch('POST', '/lists', { body: { name: 'Compras' } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    // CONTRACT PIN: deployed iOS decodes `id` and `displayName` as
    // NON-OPTIONAL strings and uses `id` for subsequent reads.
    expect(typeof res.body.data.id).toBe('string');
    expect(res.body.data.id.length).toBeGreaterThan(0);
    expect(res.body.data.displayName).toBe('Compras');

    // The returned id must be exactly what GET /lists serves.
    const lists = await dispatch('GET', '/lists');
    expect(lists.body.data.lists).toContainEqual(
      expect.objectContaining({ id: res.body.data.id, name: 'Compras' }),
    );

    // Ledger truth: a list.create mutation row with task_id NULL.
    const mutation = testDb.prepare(
      `SELECT task_id, status, patch_json FROM task_mutations WHERE operation = 'list.create'`,
    ).get() as { task_id: string | null; status: string; patch_json: string };
    expect(mutation.task_id).toBeNull();
    expect(JSON.parse(mutation.patch_json)).toMatchObject({ listId: res.body.data.id, name: 'Compras' });

    // No provider write on the single write path (NEX-10 fix).
    expect(providerApi.createList).not.toHaveBeenCalled();
  });

  it('POST /lists validates the name', async () => {
    const res = await dispatch('POST', '/lists', { body: { name: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('DELETE /lists/:listId removes the list from local truth and journals the provider push', async () => {
    const created = await dispatch('POST', '/lists', { body: { name: 'Temporária' } });
    const listId = created.body.data.id;

    const res = await dispatch('DELETE', `/lists/${listId}`, { params: { listId } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
    const lists = await dispatch('GET', '/lists');
    expect(lists.body.data.lists.map((list: any) => list.name)).not.toContain('Temporária');
    const mutation = testDb.prepare(
      `SELECT task_id, status FROM task_mutations WHERE operation = 'list.delete'`,
    ).get() as { task_id: string | null; status: string };
    expect(mutation.task_id).toBeNull();
    expect(providerApi.deleteList).not.toHaveBeenCalled();
  });

  it('DELETE /lists/:listId returns 404 for unknown lists', async () => {
    const res = await dispatch('DELETE', '/lists/987654', { params: { listId: '987654' } });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('legacy flag-off POST /lists delegates to the provider createList', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    providerApi.createList.mockResolvedValue({ success: true, data: { id: 'provider-list-7', displayName: 'Legacy' } });

    const res = await dispatch('POST', '/lists', { body: { name: 'Legacy' } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toEqual({ id: 'provider-list-7', displayName: 'Legacy' });
    expect(providerApi.createList).toHaveBeenCalledWith('Legacy');
    const mutationCount = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE operation = 'list.create'`,
    ).get() as { count: number };
    expect(mutationCount.count).toBe(0);
  });

  it('legacy flag-off DELETE /lists/:listId delegates to the provider deleteList', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    providerApi.deleteList.mockResolvedValue({ success: true, data: undefined });

    const res = await dispatch('DELETE', '/lists/provider-list-7', { params: { listId: 'provider-list-7' } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(providerApi.deleteList).toHaveBeenCalledWith('provider-list-7');
  });

  it('DELETE /lists/:listId refuses to delete the default list with a 400 validation error', async () => {
    // Create a list, promote it to default, then try to delete it.
    const created = await dispatch('POST', '/lists', { body: { name: 'Principal' } });
    const listId = created.body.data.id;
    testDb.prepare('UPDATE unified_projects SET is_default = 1 WHERE id = ?').run(Number(listId));

    const res = await dispatch('DELETE', `/lists/${listId}`, { params: { listId } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.message).toBe('Cannot delete the default list');
    // The refused delete journals nothing.
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE operation = 'list.delete'`,
    ).get()).toEqual({ count: 0 });
  });

  it('POST /lists surfaces a tenant-scope failure as an internal error, not a silent write', async () => {
    const res = await dispatch('POST', '/lists', {
      body: { name: 'Escopo inválido' },
      userId: 12,
      tenantId: -1,
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(500);
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_mutations WHERE operation = 'list.create'`,
    ).get()).toEqual({ count: 0 });
  });
});

// ── M6: POST /sync/now (bounded-wait force-sync through the coordinator) ──

const mockRequestTaskSync = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/task-store/task-sync-coordinator', () => ({
  requestTaskSync: (...args: unknown[]) => mockRequestTaskSync(...args),
}));

import { _resetTaskSyncNowRateLimiterForTests } from '../../src/api/routes/tasks';

const SYNC_SUMMARY = {
  syncRequestId: 'run-1',
  reasons: ['force_sync'],
  startedAt: '2026-07-18T10:00:00.000Z',
  finishedAt: '2026-07-18T10:00:02.000Z',
  push: { processed: 1, synced: 1, failedRetryable: 0, failedPermanent: 0, providerDisconnected: 0, conflicts: 0, deadLettered: 0 },
  pull: [{ provider: 'ms_todo', tasksUpserted: 3, tasksDeleted: 0, projectsUpserted: 0, durationMs: 20, errors: [] }],
  reconciledLinks: 0,
  errors: [],
};

describe('M6 force-sync route (POST /sync/now)', () => {
  beforeEach(() => {
    _resetTaskSyncNowRateLimiterForTests();
    vi.stubEnv('TASK_SYNC_NOW_WAIT_MS', '25');
    mockRequestTaskSync.mockReturnValue({
      status: 'started',
      syncRequestId: 'run-1',
      completion: Promise.resolve(SYNC_SUMMARY),
    });
  });

  it('runs push + forced pull through the coordinator and answers 200 with a sync-status-shaped summary', async () => {
    const res = await dispatch('POST', '/sync/now');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(mockRequestTaskSync).toHaveBeenCalledWith(
      { tenantId: 12, userId: 12 },
      'force_sync',
      { push: true, pull: 'all', pullForce: true },
    );
    expect(res.body.data).toMatchObject({
      syncRequestId: 'run-1',
      status: 'completed',
      sync: {
        startedAt: SYNC_SUMMARY.startedAt,
        finishedAt: SYNC_SUMMARY.finishedAt,
        push: expect.objectContaining({ processed: 1, synced: 1 }),
        pull: [expect.objectContaining({ provider: 'ms_todo', tasksUpserted: 3 })],
        errors: [],
      },
    });
    // Fresh /sync/status-shaped payload rides along.
    expect(res.body.data.mutationBacklog).toBeDefined();
    expect(res.body.data.taskCounts).toBeDefined();
  });

  it('answers 202 queued when the request coalesced into an active run', async () => {
    mockRequestTaskSync.mockReturnValue({
      status: 'coalesced',
      syncRequestId: 'run-2',
      completion: new Promise(() => undefined),
    });

    const res = await dispatch('POST', '/sync/now');

    expect(res.statusCode).toBe(202);
    expect(res.body.data).toEqual({ syncRequestId: 'run-2', status: 'queued' });
  });

  it('answers 202 queued when the wait budget elapses before the run finishes', async () => {
    // Restore the real setTimeout so the bounded wait can actually elapse.
    (global.setTimeout as any).mockRestore();
    mockRequestTaskSync.mockReturnValue({
      status: 'started',
      syncRequestId: 'run-3',
      completion: new Promise(() => undefined),
    });

    const res = await dispatch('POST', '/sync/now');

    expect(res.statusCode).toBe(202);
    expect(res.body.data).toEqual({ syncRequestId: 'run-3', status: 'queued' });
  });

  it('answers 202 queued while an initial provider import is still in flight', async () => {
    testDb.prepare(
      `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status, error_message)
       VALUES (12, 'ms_todo', NULL, 'syncing', NULL)`,
    ).run();

    const res = await dispatch('POST', '/sync/now');

    expect(res.statusCode).toBe(202);
    expect(res.body.data).toEqual({ syncRequestId: 'run-1', status: 'queued' });
  });

  it('rate-limits per user with 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 6; i += 1) {
      const ok = await dispatch('POST', '/sync/now');
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    }

    const limited = await dispatch('POST', '/sync/now');
    expect(limited.statusCode).toBe(429);
    expect(limited.body.ok).toBe(false);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // The limit is per user — another user still gets through.
    const otherUser = await dispatch('POST', '/sync/now', { userId: 99 });
    expect(otherUser.statusCode).toBe(200);
  });
});

// ── M9: task restore route (undo delete) ─────────────────────────────

describe('M9 task restore route (POST /:listId/:taskId/restore)', () => {
  async function createTask(suffix: string) {
    const created = await dispatch('POST', '/', {
      body: {
        title: `Restore route task ${suffix}`,
        listName: 'Tasks',
        clientMutationId: `ios-restore-route-create-${suffix}`,
        idempotencyKey: `idem-restore-route-create-${suffix}`,
      },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    return created.body.data.task as { id: string; listId: string };
  }

  /** Rewrite the create's nexus_local link into a linked ms_todo identity. */
  function linkToProvider(taskId: string, suffix: string): void {
    testDb.prepare(
      `UPDATE task_provider_links
       SET provider = 'ms_todo',
           provider_account_id = 'ms_todo:12',
           provider_task_id = ?,
           provider_list_id = 'ms-list-1',
           link_state = 'linked'
       WHERE task_id = ?`,
    ).run(`ms-task-route-${suffix}`, taskId);
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'synced' WHERE nexus_task_id = ?`,
    ).run(taskId);
  }

  it('404s NOT_FOUND for an unknown task id', async () => {
    const res = await dispatch('POST', '/list-1/task-route-unknown/restore', {
      params: { listId: 'list-1', taskId: 'task-route-unknown' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('409s NOT_DELETED for a live task', async () => {
    const task = await createTask('live');

    const res = await dispatch('POST', `/${task.listId}/${task.id}/restore`, {
      params: { listId: task.listId, taskId: task.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('NOT_DELETED');
  });

  it('restores a deleted local-only task (path undeleted) and invalidates task caches', async () => {
    const task = await createTask('local');
    const deleted = await dispatch('DELETE', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-restore-route-delete-local',
        idempotencyKey: 'idem-restore-route-delete-local',
      },
    });
    expect(deleted.statusCode).toBe(200);
    mockInvalidateTaskCaches.mockClear();

    const res = await dispatch('POST', `/${task.listId}/${task.id}/restore`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-restore-route-local',
        idempotencyKey: 'idem-restore-route-local',
      },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      restored: true,
      path: 'undeleted',
      idempotentReplay: false,
    }));
    expect(res.body.data.task).toEqual(expect.objectContaining({
      id: task.id,
      status: 'notStarted',
      syncState: 'local_only',
      deletedAt: null,
    }));
    expect(mockInvalidateTaskCaches).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      listIds: [task.listId],
    }));
    // The restored task is readable again through the token-zero detail read.
    const detail = await dispatch('GET', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.task.status).toBe('notStarted');
  });

  it('supersedes a held provider delete (path superseded_delete) without any provider call', async () => {
    const task = await createTask('held');
    linkToProvider(task.id, 'held');
    const deleted = await dispatch('DELETE', `/${task.listId}/${task.id}`, {
      params: { listId: task.listId, taskId: task.id },
      body: {
        clientMutationId: 'ios-restore-route-delete-held',
        idempotencyKey: 'idem-restore-route-delete-held',
      },
    });
    expect(deleted.statusCode).toBe(200);

    const res = await dispatch('POST', `/${task.listId}/${task.id}/restore`, {
      params: { listId: task.listId, taskId: task.id },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.path).toBe('superseded_delete');
    expect(res.body.data.task.deletedAt).toBeNull();
    const heldDelete = testDb.prepare(
      `SELECT status FROM task_mutations WHERE task_id = ? AND operation = 'task.delete'`,
    ).get(task.id) as { status: string };
    expect(heldDelete.status).toBe('superseded');
    expect(providerApi.deleteTask).not.toHaveBeenCalled();
    expect(providerApi.createTask).not.toHaveBeenCalled();
  });

  it('409s NOT_RESTORABLE for a merged twin-repair tombstone', async () => {
    const task = await createTask('merged');
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = datetime('now'), provider_data = ?
       WHERE nexus_task_id = ?`,
    ).run(JSON.stringify({ merged_into: 'task_route_survivor' }), task.id);

    const res = await dispatch('POST', `/${task.listId}/${task.id}/restore`, {
      params: { listId: task.listId, taskId: task.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('NOT_RESTORABLE');
  });
});

// ─── M10 priority-to-server contract (NEX-17) ────────────────────────────────

describe('M10 priority REST contract', () => {
  it('creates a task with a wire priority and echoes it in the DTO', async () => {
    const res = await dispatch('POST', '/', {
      body: {
        title: 'Wire priority create',
        listName: 'Tasks',
        priority: 2,
        clientMutationId: 'ios-m10-create-1',
        idempotencyKey: 'idem-m10-create-1',
      },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.task.priority).toBe(2);
    expect(res.body.data.task.importance).toBe('high');
  });

  it('rejects invalid create priorities with 400 VALIDATION and journals nothing', async () => {
    for (const priority of [5, -1, 2.5, '2', 'high']) {
      const res = await dispatch('POST', '/', {
        body: {
          title: 'Invalid wire priority',
          priority,
          clientMutationId: `ios-m10-invalid-${String(priority)}`,
        },
      });
      expect(res.statusCode, `priority ${JSON.stringify(priority)}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
    const taskCount = testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks').get() as { count: number };
    const mutationCount = testDb.prepare('SELECT COUNT(*) AS count FROM task_mutations').get() as { count: number };
    expect(taskCount.count).toBe(0);
    expect(mutationCount.count).toBe(0);
  });

  it('updates priority through PATCH and validates the range', async () => {
    const created = await dispatch('POST', '/', {
      body: {
        title: 'Wire priority patch target',
        listName: 'Tasks',
        priority: 3,
        clientMutationId: 'ios-m10-patch-target',
      },
    });
    const task = created.body.data.task;

    const patched = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: String(task.listId), taskId: task.id },
      body: { priority: 1, clientMutationId: 'ios-m10-patch-1' },
    });
    expect(patched.statusCode, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.data.task.priority).toBe(1);
    expect(patched.body.data.task.importance).toBe('high');

    const invalid = await dispatch('PATCH', `/${task.listId}/${task.id}`, {
      params: { listId: String(task.listId), taskId: task.id },
      body: { priority: 7, clientMutationId: 'ios-m10-patch-invalid' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');
  });

  it('advertises capabilities.priority on /working-set (the iOS M-D migration gate)', async () => {
    await dispatch('POST', '/', {
      body: {
        title: 'Working set carries priority',
        listName: 'Tasks',
        priority: 4,
        clientMutationId: 'ios-m10-working-set',
      },
    });

    const res = await dispatch('GET', '/working-set');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.capabilities).toMatchObject({ priority: true });
    const task = res.body.data.tasks.find((entry: any) => entry.title === 'Working set carries priority');
    expect(task?.priority).toBe(4);
    expect(task?.importance).toBe('low');
  });
});

// ─── M11 minimal Sync Center + Recently Deleted ──────────────────────────────

describe('M11 Recently Deleted route (GET /deleted) + Sync Center status fields', () => {
  async function createTask(suffix: string) {
    const created = await dispatch('POST', '/', {
      body: {
        title: `Sync center task ${suffix}`,
        listName: 'Tasks',
        clientMutationId: `ios-m11-route-create-${suffix}`,
        idempotencyKey: `idem-m11-route-create-${suffix}`,
      },
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    return created.body.data.task as { id: string; listId: string };
  }

  function tombstone(taskId: string, deletedAt: string): void {
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, status = 'cancelled'
       WHERE nexus_task_id = ?`,
    ).run(deletedAt, taskId);
  }

  it('returns an empty Recently Deleted page without touching providers', async () => {
    await createTask('empty-live');

    const res = await dispatch('GET', '/deleted');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ tasks: [], count: 0 });
    expectNoProviderReads();
  });

  it('lists tombstones newest-first with the pinned wire shape and 90-day window', async () => {
    const older = await createTask('older');
    const newer = await createTask('newer');
    const ancient = await createTask('ancient');
    const live = await createTask('live');
    tombstone(older.id, '2026-07-10T09:00:00.000Z');
    tombstone(newer.id, '2026-07-16T09:00:00.000Z');
    tombstone(ancient.id, '2026-03-01T09:00:00.000Z'); // beyond the 90-day window

    const res = await dispatch('GET', '/deleted');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.tasks.map((task: any) => task.id)).toEqual([newer.id, older.id]);
    // Exact pinned contract keys — the iOS section decodes exactly these.
    expect(res.body.data.tasks[0]).toEqual({
      id: newer.id,
      title: 'Sync center task newer',
      listId: newer.listId,
      listName: 'Tasks',
      deletedAt: '2026-07-16T09:00:00.000Z',
      syncProvider: 'nexus',
      restorable: true,
    });
    expect(res.body.data.tasks.some((task: any) => task.id === live.id)).toBe(false);
    expect(res.body.data.tasks.some((task: any) => task.id === ancient.id)).toBe(false);
    expectNoProviderReads();
  });

  it('marks merged twin-repair tombstones restorable: false and honors the limit clamp', async () => {
    const merged = await createTask('merged');
    const plain = await createTask('plain');
    testDb.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = '2026-07-16T10:00:00.000Z', provider_data = ?
       WHERE nexus_task_id = ?`,
    ).run(JSON.stringify({ merged_into: 'task_m11_route_survivor' }), merged.id);
    tombstone(plain.id, '2026-07-15T10:00:00.000Z');

    const res = await dispatch('GET', '/deleted');
    const limited = await dispatch('GET', '/deleted', { query: { limit: '1' } });
    const defaulted = await dispatch('GET', '/deleted', { query: { limit: 'not-a-number' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.find((task: any) => task.id === merged.id)?.restorable).toBe(false);
    expect(res.body.data.tasks.find((task: any) => task.id === plain.id)?.restorable).toBe(true);
    // A merged tombstone still 409s on restore — the read model pre-announced it.
    const restore = await dispatch('POST', `/list-1/${merged.id}/restore`, {
      params: { listId: 'list-1', taskId: merged.id },
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.body.error.code).toBe('NOT_RESTORABLE');
    // limit clamps the page while count stays the total in-window number.
    expect(limited.body.data.tasks).toHaveLength(1);
    expect(limited.body.data.tasks[0].id).toBe(merged.id);
    expect(limited.body.data.count).toBe(2);
    expect(defaulted.body.data.tasks).toHaveLength(2);
    expectNoProviderReads();
  });

  it('scopes Recently Deleted to the requesting tenant/user', async () => {
    const mine = await createTask('scope-mine');
    tombstone(mine.id, '2026-07-16T09:00:00.000Z');
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, status,
         is_deleted, deleted_at, nexus_task_id
       ) VALUES (99, 99, 'nexus', 'ext-m11-route-other', 'Other user tombstone', 'cancelled',
         1, '2026-07-16T09:30:00.000Z', 'task_m11_route_other')`,
    ).run();

    const res = await dispatch('GET', '/deleted', { userId: 12, tenantId: 12 });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.map((task: any) => task.id)).toEqual([mine.id]);
    expect(res.body.data.count).toBe(1);
  });

  it('sync/status carries the M11 additive fields and deletedRecentCount matches /deleted', async () => {
    const gone = await createTask('status-badge');
    tombstone(gone.id, '2026-07-16T11:00:00.000Z');
    const insertMutation = testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, status
       ) VALUES (?, ?, ?, 12, 12, ?, 'task.update', '{}', ?)`,
    );
    insertMutation.run('m11-pending', 'c-m11-pending', 'i-m11-pending', 'task-m11-pending', 'queued');
    insertMutation.run('m11-dead', 'c-m11-dead', 'i-m11-dead', 'task-m11-dead', 'dead_letter');
    testDb.prepare(
      `INSERT INTO task_sync_state (user_id, provider, last_sync_at, status, error_message)
       VALUES (12, 'ms_todo', '2026-07-16T08:00:00.000Z', 'error', 'Graph rejected the token: 401 unauthorized')`,
    ).run();

    const status = await dispatch('GET', '/sync/status');
    const deleted = await dispatch('GET', '/deleted');

    expect(status.statusCode, JSON.stringify(status.body)).toBe(200);
    // Exactly the seeded queued mutation is pending (the nexus-local create
    // above journaled 'synced'); the dead-letter row is counted discretely,
    // never as pending.
    expect(status.body.data.pendingMutationCount).toBe(1);
    expect(status.body.data.deadLetterCount).toBe(1);
    expect(status.body.data.deletedRecentCount).toBe(1);
    expect(status.body.data.deletedRecentCount).toBe(deleted.body.data.count);
    expect(status.body.data.providerStates).toContainEqual(
      expect.objectContaining({
        provider: 'ms_todo',
        lastErrorCode: 'provider_auth_expired',
      }),
    );
    expect(status.body.data.providerStates).toContainEqual(
      expect.objectContaining({ provider: 'todoist' }),
    );
    expectNoProviderReads();
  });
});
