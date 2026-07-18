// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M12 — GET /api/v1/tasks/sync/import-preview + POST /api/v1/tasks/sync/connect.
 *
 * Runs the real task router against a migrated in-memory database with a mock
 * provider adapter registered in the sync engine, so the preview probe and the
 * selection persistence are exercised end-to-end. The sync coordinator is
 * mocked so `connect` records selection without kicking a real sync run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const mockRequestTaskSync = vi.fn(() => ({
  status: 'started' as const,
  syncRequestId: 'sync_req_1',
  completion: Promise.resolve(null),
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
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: vi.fn(),
}));

vi.mock('../../src/services/microsoft-todo', () => ({}));
vi.mock('../../src/services/microsoft-auth', () => ({ getGraphClient: vi.fn() }));
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
  invalidateTaskCaches: vi.fn(),
}));
vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapUser: vi.fn(() => null),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));
vi.mock('../../src/services/task-store/task-sync-coordinator', () => ({
  requestTaskSync: (...args: unknown[]) => mockRequestTaskSync(...(args as [])),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { taskRoutes } from '../../src/api/routes/tasks';
import {
  registerAdapter,
  _resetAdaptersForTests,
} from '../../src/services/task-store/sync-engine';
import type { TaskProviderAdapter } from '../../src/services/task-store/adapter-interface';
import type { NormalizedProject, NormalizedTask } from '../../src/services/task-store/types';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(onDone?: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; onDone?.(); return res; },
    setHeader(name, value) { res.headers[name] = value; return res; },
    end() { onDone?.(); return res; },
  };
  return res;
}

function mockReq(method: string, path: string, options: {
  userId?: number; tenantId?: number; query?: Record<string, any>; body?: Record<string, any>;
} = {}): Request {
  return {
    method, url: path, originalUrl: path, baseUrl: '', path,
    query: options.query || {},
    params: {},
    body: options.body || {},
    headers: {},
    userId: options.userId ?? 12,
    tenantId: options.tenantId ?? options.userId ?? 12,
  } as any;
}

async function dispatch(method: string, path: string, options: {
  userId?: number; tenantId?: number; query?: Record<string, any>; body?: Record<string, any>;
} = {}): Promise<MockRes> {
  const router = taskRoutes();
  const req = mockReq(method, path, options);
  let res!: MockRes;
  await new Promise<void>((resolve, reject) => {
    res = mockRes(resolve);
    (router as any).handle(req, res, (err: any) => {
      if (err) { reject(err); return; }
      resolve();
    });
  });
  return res;
}

interface MockAdapterOptions {
  provider?: 'ms_todo' | 'todoist';
  connected?: boolean;
  projects?: NormalizedProject[];
  tasks?: NormalizedTask[];
  incomplete?: boolean;
  throwOnProbe?: boolean;
}

function makeMockAdapter(opts: MockAdapterOptions = {}): TaskProviderAdapter {
  const provider = opts.provider ?? 'ms_todo';
  return {
    provider,
    capabilities: {
      canCreate: true, canComplete: true, canDelete: true, canUpdate: true,
      canAssignDue: true, hasWebhooks: false, hasIncrementalSync: false,
    },
    isConnected: () => opts.connected ?? true,
    getProjects: async () => {
      if (opts.throwOnProbe) throw new Error('provider unreachable');
      return opts.projects ?? [];
    },
    getTasks: async () => {
      if (opts.throwOnProbe) throw new Error('provider unreachable');
      return { tasks: opts.tasks ?? [], incomplete: opts.incomplete };
    },
    createTask: async (_userId, task) => ({ ...task, provider, externalId: 'x' } as NormalizedTask),
    completeTask: async () => undefined,
    deleteTask: async () => undefined,
  } as TaskProviderAdapter;
}

function seedLocalTask(userId: number, externalId: string): void {
  testDb.prepare(
    `INSERT INTO unified_tasks (user_id, tenant_id, provider, external_id, title, status, priority, nexus_task_id, sync_state, source_of_truth)
     VALUES (?, ?, 'nexus', ?, ?, 'pending', 0, ?, 'local_only', 'nexus')`,
  ).run(userId, userId, externalId, `Local ${externalId}`, `task_${externalId}`);
}

const USER = 12;

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  const seedUser = testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let i = 1; i <= 100; i++) seedUser.run(i, i);
  _resetAdaptersForTests();
  mockRequestTaskSync.mockClear();
});

afterEach(() => {
  testDb.close();
});

describe('GET /tasks/sync/import-preview (M12)', () => {
  it('returns per-list counts and totals from a live probe', async () => {
    registerAdapter(makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'Work' },
        { provider: 'ms_todo', externalId: 'listB', name: 'Home' },
      ],
      tasks: [
        { provider: 'ms_todo', externalId: 't1', title: 'A1', status: 'pending', priority: 0, providerData: { listId: 'listA' } },
        { provider: 'ms_todo', externalId: 't2', title: 'A2', status: 'pending', priority: 0, providerData: { listId: 'listA' } },
        { provider: 'ms_todo', externalId: 't3', title: 'B1', status: 'pending', priority: 0, providerData: { listId: 'listB' } },
      ],
    }));
    seedLocalTask(USER, 'loc1');
    seedLocalTask(USER, 'loc2');

    const res = await dispatch('GET', '/sync/import-preview', { query: { provider: 'ms_todo' } });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.provider).toBe('ms_todo');
    expect(res.body.data.lists).toEqual([
      { providerListId: 'listA', name: 'Work', taskCount: 2 },
      { providerListId: 'listB', name: 'Home', taskCount: 1 },
    ]);
    expect(res.body.data.wouldImportTaskCount).toBe(3);
    expect(res.body.data.localTaskCount).toBe(2);
    expect(res.body.data.incomplete).toBe(false);
  });

  it('400s on an unsupported provider', async () => {
    const res = await dispatch('GET', '/sync/import-preview', { query: { provider: 'garmin' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('409s when the provider is not connected', async () => {
    registerAdapter(makeMockAdapter({ provider: 'ms_todo', connected: false }));
    const res = await dispatch('GET', '/sync/import-preview', { query: { provider: 'ms_todo' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONNECTED');
  });

  it('503s when the live probe cannot reach the provider', async () => {
    registerAdapter(makeMockAdapter({ provider: 'ms_todo', throwOnProbe: true }));
    const res = await dispatch('GET', '/sync/import-preview', { query: { provider: 'ms_todo' } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('POST /tasks/sync/connect (M12)', () => {
  function selectionRows(): Array<{ provider_list_id: string; sync_enabled: number }> {
    return testDb.prepare(
      `SELECT provider_list_id, sync_enabled FROM task_list_sync_selection
       WHERE tenant_id = ? AND user_id = ? AND provider = 'ms_todo'
       ORDER BY provider_list_id`,
    ).all(USER, USER) as Array<{ provider_list_id: string; sync_enabled: number }>;
  }

  it('persists enabled selection and disables the complement, then kicks connect sync', async () => {
    registerAdapter(makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'Work' },
        { provider: 'ms_todo', externalId: 'listB', name: 'Home' },
        { provider: 'ms_todo', externalId: 'listC', name: 'Errands' },
      ],
    }));

    const res = await dispatch('POST', '/sync/connect', {
      body: { provider: 'ms_todo', selectedListIds: ['listA', 'listC'] },
    });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.provider).toBe('ms_todo');
    expect(res.body.data.selectedListIds.sort()).toEqual(['listA', 'listC']);
    expect(res.body.data.enabledCount).toBe(2);
    expect(res.body.data.disabledCount).toBe(1);
    expect(res.body.data.syncStarted).toBe(true);

    expect(selectionRows()).toEqual([
      { provider_list_id: 'listA', sync_enabled: 1 },
      { provider_list_id: 'listB', sync_enabled: 0 },
      { provider_list_id: 'listC', sync_enabled: 1 },
    ]);

    expect(mockRequestTaskSync).toHaveBeenCalledWith(
      { tenantId: USER, userId: USER },
      'connect',
      expect.objectContaining({ push: true, pull: ['ms_todo'] }),
    );
  });

  it('400s when selectedListIds is not a string array', async () => {
    const res = await dispatch('POST', '/sync/connect', {
      body: { provider: 'ms_todo', selectedListIds: [1, 2] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockRequestTaskSync).not.toHaveBeenCalled();
  });

  it('400s on an unsupported provider', async () => {
    const res = await dispatch('POST', '/sync/connect', {
      body: { provider: 'garmin', selectedListIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
