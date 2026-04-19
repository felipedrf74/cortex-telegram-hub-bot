import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockResolveTaskProvider = vi.fn();
const mockGetTaskProviderForUser = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/api/routes/../../services/task-store/task-router', () => ({
  resolveTaskProvider: (...args: unknown[]) => mockResolveTaskProvider(...args),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/api/routes/../../services/microsoft-todo', () => ({
  getAllPendingTasks: (...args: unknown[]) => {
    const provider = mockGetTaskProviderForUser(...args);
    return provider.getAllPendingTasks(...args);
  },
  findListByName: (...args: unknown[]) => {
    const provider = mockGetTaskProviderForUser(...args);
    return provider.findListByName(...args);
  },
  getDefaultList: (...args: unknown[]) => {
    const provider = mockGetTaskProviderForUser(...args);
    return provider.getDefaultList(...args);
  },
  createTask: (...args: unknown[]) => {
    const provider = mockGetTaskProviderForUser(...args);
    return provider.createTask(...args);
  },
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
  userCacheKey: (userId: number, key: string) => `u:${userId}:${key}`,
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

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { return r; },
  };
  return r;
}

function mockReq(
  method: string,
  path: string,
  options: {
    userId?: number;
    query?: Record<string, any>;
    params?: Record<string, string>;
    body?: Record<string, any>;
  } = {}
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
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  options: {
    userId?: number;
    query?: Record<string, any>;
    params?: Record<string, string>;
    body?: Record<string, any>;
  } = {}
): Promise<MockRes> {
  const router = taskRoutes();
  const req = mockReq(method, path, options);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Task routes sync provider metadata', () => {
  const providerApi = {
    getLists: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getAllPendingTasks: vi.fn(),
    findListByName: vi.fn(),
    getDefaultList: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    addChecklistItem: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearTenantScopeAnomaliesForTests();
    mockResolveTaskProvider.mockReturnValue('ms_todo');
    mockGetTaskProviderForUser.mockReturnValue(providerApi);
    mockGetCachedSWR.mockReturnValue(null);
    mockSetCacheSWR.mockReturnValue(undefined);
    mockSetCache.mockReturnValue(undefined);
    mockClearCache.mockReturnValue(undefined);
    mockClearCacheByPrefix.mockReturnValue(undefined);
    providerApi.getLists.mockResolvedValue({
      success: true,
      data: [
        { id: 'list-1', displayName: 'Tasks' },
        { id: 'list-2', displayName: 'Work' },
      ],
    });
    providerApi.getTasks.mockResolvedValue({ success: true, data: [] });
    providerApi.getTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-1',
        title: 'Inbox cleanup',
        body: 'Sort the onboarding notes',
        importance: 'normal',
        status: 'notStarted',
        listId: 'list-1',
        listName: 'Tasks',
        checklistItems: [
          { id: 'step-1', displayName: 'Open notes', isChecked: false },
        ],
        createdDateTime: '2026-04-17T08:00:00Z',
      },
    });
    providerApi.getAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    providerApi.findListByName.mockResolvedValue({ id: 'list-1', displayName: 'Tasks' });
    providerApi.getDefaultList.mockResolvedValue({ id: 'list-1', displayName: 'Tasks' });
    providerApi.createTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-1',
        title: 'Board prep',
        body: 'Slides by lunch',
        importance: 'high',
        status: 'notStarted',
      },
    });
    providerApi.updateTask.mockResolvedValue({
      success: true,
      data: { id: 'task-1' },
    });
    providerApi.completeTask.mockResolvedValue({
      success: true,
      data: { id: 'task-1', status: 'completed' },
    });
    providerApi.addChecklistItem.mockResolvedValue({
      success: true,
      data: { id: 'step-2', displayName: 'Archive receipts', isChecked: false },
    });
  });

  it('includes syncProvider on filtered task responses', async () => {
    providerApi.getAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-1',
          title: 'Board prep',
          body: 'Slides by lunch',
          importance: 'high',
          status: 'notStarted',
          listId: 'list-1',
          listName: 'Tasks',
        },
      ],
    });

    const res = await dispatch('GET', '/filtered', { query: { filter: 'all' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        title: 'Board prep',
        syncProvider: 'ms_todo',
      }),
    ]);
  });

  it('fails closed on invalid tenant scope before loading task lists', async () => {
    const res = await dispatch('GET', '/lists', { userId: 0 });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
    expect(mockGetCachedSWR).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'tasks_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('includes nexus syncProvider on filtered task responses when using native storage', async () => {
    mockResolveTaskProvider.mockReturnValue('nexus');
    providerApi.getAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-9',
          title: 'Inbox cleanup',
          body: 'Sort the onboarding notes',
          importance: 'normal',
          status: 'notStarted',
          listId: 'inbox',
          listName: 'Inbox',
        },
      ],
    });

    const res = await dispatch('GET', '/filtered', { query: { filter: 'all' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.tasks).toEqual([
      expect.objectContaining({
        id: 'task-9',
        title: 'Inbox cleanup',
        syncProvider: 'nexus',
      }),
    ]);
  });

  it('includes syncProvider on created tasks', async () => {
    const res = await dispatch('POST', '/', {
      body: {
        title: 'Board prep',
        importance: 'high',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        id: 'task-1',
        listId: 'list-1',
        listName: 'Tasks',
        syncProvider: 'ms_todo',
      }),
    );
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:12:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:12:');
  });

  it('routes generic inbox task creation to the capture list before provider-default fallbacks', async () => {
    providerApi.getLists.mockResolvedValue({
      success: true,
      data: [
        { id: 'list-1', displayName: 'Tasks', wellknownListName: 'defaultList' },
        { id: 'list-2', displayName: 'European Commision' },
      ],
    });
    providerApi.findListByName.mockImplementation(async (name: string) => {
      if (name === 'Inbox') return null;
      if (name === 'Tasks') return { id: 'list-1', displayName: 'Tasks' };
      return null;
    });
    providerApi.getDefaultList.mockResolvedValue({ id: 'list-2', displayName: 'European Commision' });

    const res = await dispatch('POST', '/', {
      body: {
        title: 'pay via verde',
        listName: 'Inbox',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(providerApi.createTask).toHaveBeenCalledWith(
      'list-1',
      'Tasks',
      expect.objectContaining({ title: 'pay via verde' }),
    );
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        listId: 'list-1',
        listName: 'Tasks',
      }),
    );
  });

  it('returns real list task counts instead of placeholder sentinel values', async () => {
    providerApi.getAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 'task-1', listId: 'list-1' },
        { id: 'task-2', listId: 'list-1' },
        { id: 'task-3', listId: 'list-2' },
      ],
    });

    const res = await dispatch('GET', '/lists');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.lists).toEqual([
      { id: 'list-1', name: 'Tasks', taskCount: 2 },
      { id: 'list-2', name: 'Work', taskCount: 1 },
    ]);
  });

  it('returns full task detail with checklist items for the task drill-down flow', async () => {
    const res = await dispatch('GET', '/list-1/task-1', {
      params: { listId: 'list-1', taskId: 'task-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(providerApi.getTask).toHaveBeenCalledWith('list-1', 'task-1', 'Tasks');
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        id: 'task-1',
        title: 'Inbox cleanup',
        listId: 'list-1',
        listName: 'Tasks',
        syncProvider: 'ms_todo',
        checklistItems: [
          expect.objectContaining({
            id: 'step-1',
            displayName: 'Open notes',
            isChecked: false,
          }),
        ],
      }),
    );
  });

  it('creates a checklist item and returns refreshed task detail', async () => {
    providerApi.getTask.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'task-1',
        title: 'Inbox cleanup',
        body: 'Sort the onboarding notes',
        importance: 'normal',
        status: 'notStarted',
        listId: 'list-1',
        listName: 'Tasks',
        checklistItems: [
          { id: 'step-1', displayName: 'Open notes', isChecked: false },
          { id: 'step-2', displayName: 'Archive receipts', isChecked: false },
        ],
        createdDateTime: '2026-04-17T08:00:00Z',
      },
    });

    const res = await dispatch('POST', '/list-1/task-1/checklist', {
      params: { listId: 'list-1', taskId: 'task-1' },
      body: { displayName: 'Archive receipts' },
    });

    expect(res.statusCode).toBe(201);
    expect(providerApi.addChecklistItem).toHaveBeenCalledWith('list-1', 'task-1', 'Archive receipts');
    expect(res.body.data.item).toEqual(
      expect.objectContaining({
        id: 'step-2',
        displayName: 'Archive receipts',
        isChecked: false,
      }),
    );
    expect(res.body.data.task.checklistItems).toEqual([
      expect.objectContaining({ id: 'step-1' }),
      expect.objectContaining({ id: 'step-2' }),
    ]);
    expect(mockClearCache).toHaveBeenCalledWith('u:12:tasks:list-1:all');
  });

  it('normalizes update responses when the provider only returns a partial task payload', async () => {
    providerApi.getTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-1',
          title: 'Inbox cleanup',
          body: 'Sort the onboarding notes',
          importance: 'normal',
          status: 'notStarted',
          listId: 'list-1',
          listName: 'Tasks',
          createdDateTime: '2026-04-17T08:00:00Z',
        },
      ],
    });

    const res = await dispatch('PATCH', '/list-1/task-1', {
      params: { listId: 'list-1', taskId: 'task-1' },
      body: { title: 'Inbox cleanup' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        id: 'task-1',
        title: 'Inbox cleanup',
        listId: 'list-1',
        listName: 'Tasks',
        syncProvider: 'ms_todo',
      }),
    );
  });

  it('normalizes complete responses when the provider only returns completion metadata', async () => {
    providerApi.getTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-1',
          title: 'Inbox cleanup',
          body: null,
          importance: 'normal',
          status: 'completed',
          listId: 'list-1',
          listName: 'Tasks',
          createdDateTime: '2026-04-17T08:00:00Z',
        },
      ],
    });

    const res = await dispatch('POST', '/list-1/task-1/complete', {
      params: { listId: 'list-1', taskId: 'task-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        id: 'task-1',
        title: 'Inbox cleanup',
        status: 'completed',
        listId: 'list-1',
        listName: 'Tasks',
      }),
    );
    expect(res.body.data.message).toContain('Inbox cleanup');
  });

  it('includes nexus syncProvider on created tasks when using native storage', async () => {
    mockResolveTaskProvider.mockReturnValue('nexus');

    const res = await dispatch('POST', '/', {
      body: {
        title: 'Inbox cleanup',
        importance: 'normal',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.task).toEqual(
      expect.objectContaining({
        id: 'task-1',
        listId: 'list-1',
        listName: 'Tasks',
        syncProvider: 'nexus',
      }),
    );
  });
});
