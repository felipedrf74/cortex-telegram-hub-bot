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
const mockGetUserTimezone = vi.fn(() => 'Europe/Lisbon');

function expectCachePrefixesCleared(...prefixes: string[]) {
  const cleared = mockClearCacheByPrefix.mock.calls.flatMap(([prefix]) => (
    Array.isArray(prefix) ? prefix : [prefix]
  ));
  for (const prefix of prefixes) {
    expect(cleared).toContain(prefix);
  }
}

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

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: tasks route uses the strict by-id helper post-audit.
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

import { dateKeyInAppTimezone, taskDueDateKey, taskRoutes } from '../../src/api/routes/tasks';

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
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; onDone?.(); return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { onDone?.(); return r; },
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
    deleteList: vi.fn(),
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
    mockGetUserTimezone.mockReturnValue('Europe/Lisbon');
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
    providerApi.deleteList.mockResolvedValue({
      success: true,
      data: undefined,
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

  it('does not leak raw provider errors when listing task lists fails', async () => {
    providerApi.getLists.mockRejectedValueOnce(new Error('graph token exploded with tenant internals'));

    const res = await dispatch('GET', '/lists');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to fetch lists');
    expect(JSON.stringify(res.body)).not.toContain('graph token exploded');
    expect(mockLoggerError).toHaveBeenCalled();
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
    expectCachePrefixesCleared('dashboard-home:12:', 'plan:week:u:12:', 'plan:today:u:12:');
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

  it('does not silently fall back when an explicit task list name is missing', async () => {
    const res = await dispatch('POST', '/', {
      body: {
        title: 'pay via verde',
        listName: 'European Commission',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('LIST_NOT_FOUND');
    expect(providerApi.createTask).not.toHaveBeenCalled();
  });

  it('returns a conflict when an explicit task list name is ambiguous', async () => {
    providerApi.getLists.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'list-1', displayName: 'Work' },
        { id: 'list-2', displayName: 'work ' },
      ],
    });

    const res = await dispatch('POST', '/', {
      body: {
        title: 'weekly review',
        listName: 'Work',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('TASK_LIST_AMBIGUOUS');
    expect(providerApi.createTask).not.toHaveBeenCalled();
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

  it('returns a bounded active working set without completed history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));

    const completedHistory = Array.from({ length: 2500 }, (_, index) => ({
      id: `completed-${index}`,
      title: `Daily recurrence ${index}`,
      status: 'completed',
      listId: 'list-1',
    }));
    providerApi.getTasks.mockImplementation(async (listId: string) => ({
      success: true,
      data: listId === 'list-1'
        ? [
          { id: 'active-1', title: 'Creatine', status: 'notStarted', listId: 'list-1', listName: 'Tasks', dueDateTime: '2026-05-08T09:00:00Z' },
          { id: 'active-2', title: 'K2', status: 'inProgress', listId: 'list-1', listName: 'Tasks', dueDateTime: '2026-05-07T09:00:00Z' },
          ...completedHistory,
        ].filter((task) => task.status !== 'completed')
        : [],
    }));

    try {
      const res = await dispatch('GET', '/working-set', {
        query: { pageSize: '2' },
      });

      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.policyVersion).toBe('task-working-set-v1');
      expect(res.body.data.activeCountsByList).toEqual({ 'list-1': 2, 'list-2': 0 });
      expect(res.body.data.smartCounts).toEqual({ dueToday: 1, overdue: 1 });
      expect(res.body.data.activePage.tasks).toHaveLength(2);
      expect(JSON.stringify(res.body.data.activePage.tasks)).not.toContain('completed-');
      expect(providerApi.getAllPendingTasks).not.toHaveBeenCalled();
      expect(providerApi.getLists).toHaveBeenCalledTimes(1);
      expect(providerApi.getTasks).toHaveBeenCalledTimes(2);
      expect(providerApi.getTasks).toHaveBeenCalledWith('list-1', 'Tasks', { status: 'active' });
      expect(providerApi.getTasks).toHaveBeenCalledWith('list-2', 'Work', { status: 'active' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports explicit active and completed scopes on list reads', async () => {
    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'active-1', title: 'Active', status: 'notStarted', listId: 'list-1', listName: 'Tasks' },
      ],
    });

    const activeRes = await dispatch('GET', '/list/list-1', {
      params: { listId: 'list-1' },
      query: { scope: 'active', pageSize: '25', listName: 'Tasks' },
    });

    expect(activeRes.statusCode).toBe(200);
    expect(providerApi.getTasks).toHaveBeenLastCalledWith('list-1', 'Tasks', {
      status: 'active',
      top: 25,
      completedAfter: undefined,
    });
    expect(activeRes.body.data.scope).toBe('active');

    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'done-1', title: 'Done', status: 'completed', listId: 'list-1', listName: 'Tasks' },
      ],
    });

    const completedRes = await dispatch('GET', '/list/list-1', {
      params: { listId: 'list-1' },
      query: { scope: 'completed', pageSize: '10', completedAfter: '2026-05-01T00:00:00Z', listName: 'Tasks' },
    });

    expect(completedRes.statusCode).toBe(200);
    expect(providerApi.getTasks).toHaveBeenLastCalledWith('list-1', 'Tasks', {
      status: 'completed',
      top: 10,
      completedAfter: '2026-05-01T00:00:00Z',
    });
    expect(completedRes.body.data.scope).toBe('completed');
  });

  it('bypasses stale empty list-detail cache when list metadata reports pending tasks', async () => {
    mockGetCachedSWR.mockImplementation((key: string) => {
      if (key === 'u:12:tasks:list-1:all:all:75:') {
        return { value: { listName: 'Entrada', tasks: [] }, fresh: true };
      }
      if (key === 'u:12:task-lists') {
        return { value: { lists: [{ id: 'list-1', name: 'Entrada', taskCount: 9 }] }, fresh: true };
      }
      return null;
    });
    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 'task-entrada-1',
          title: 'Family inbox item',
          status: 'notStarted',
          listId: 'list-1',
          listName: 'Entrada',
        },
      ],
    });

    const res = await dispatch('GET', '/list/list-1', {
      params: { listId: 'list-1' },
      query: { listName: 'Entrada' },
    });

    expect(res.statusCode).toBe(200);
    expect(providerApi.getTasks).toHaveBeenCalledWith('list-1', 'Entrada', { top: 75, completedAfter: undefined });
    expect(res.body.data.tasks).toEqual([
      expect.objectContaining({ id: 'task-entrada-1', title: 'Family inbox item' }),
    ]);
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'u:12:tasks:list-1:all:all:75:',
      expect.objectContaining({
        listName: 'Entrada',
        tasks: [expect.objectContaining({ id: 'task-entrada-1' })],
      }),
      expect.any(Number),
      expect.any(Number),
    );
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
    expectCachePrefixesCleared('u:12:tasks:list-1:');
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

  it('treats completing an already-completed task as an idempotent success', async () => {
    providerApi.getTask.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'task-1',
        title: 'Inbox cleanup',
        status: 'completed',
        listId: 'list-1',
        listName: 'Tasks',
      },
    });

    const res = await dispatch('POST', '/list-1/task-1/complete', {
      params: { listId: 'list-1', taskId: 'task-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(providerApi.completeTask).not.toHaveBeenCalled();
    expect(res.body.data.alreadyCompleted).toBe(true);
    expect(res.body.data.task.status).toBe('completed');
  });

  it('coalesces concurrent complete requests for the same task', async () => {
    let releaseComplete: (() => void) | undefined;
    providerApi.completeTask.mockImplementationOnce(() => new Promise((resolve) => {
      releaseComplete = () => resolve({ success: true, data: { id: 'task-1', status: 'completed' } });
    }));
    providerApi.getTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-1',
          title: 'Inbox cleanup',
          status: 'completed',
          listId: 'list-1',
          listName: 'Tasks',
        },
      ],
    });

    const first = dispatch('POST', '/list-1/task-1/complete', {
      params: { listId: 'list-1', taskId: 'task-1' },
    });
    const second = dispatch('POST', '/list-1/task-1/complete', {
      params: { listId: 'list-1', taskId: 'task-1' },
    });

    await vi.waitFor(() => expect(providerApi.completeTask).toHaveBeenCalledTimes(1));
    releaseComplete?.();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(providerApi.completeTask).toHaveBeenCalledTimes(1);
  });

  it('reconciles task creation when the provider accepted the write but returned an error', async () => {
    providerApi.createTask.mockResolvedValueOnce({
      success: false,
      data: null,
      error: 'upstream timeout after write',
    });
    providerApi.getTasks.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 'task-99',
          title: 'Board prep',
          status: 'notStarted',
          listId: 'list-1',
          listName: 'Tasks',
        },
      ],
    });

    const res = await dispatch('POST', '/', {
      body: {
        title: 'Board prep',
        importance: 'high',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.reconciled).toBe(true);
    expect(res.body.data.task.id).toBe('task-99');
  });

  it('deletes supported task lists through the active provider', async () => {
    const res = await dispatch('DELETE', '/lists/list-2', {
      params: { listId: 'list-2' },
    });

    expect(res.statusCode).toBe(200);
    expect(providerApi.deleteList).toHaveBeenCalledWith('list-2');
    expectCachePrefixesCleared('u:12:tasks:list-2:');
  });

  it('derives task due-date keys across the Lisbon DST boundary using configured timezone', () => {
    const timezone = 'Europe/Lisbon';

    expect(dateKeyInAppTimezone(new Date('2026-03-29T22:30:00.000Z'), timezone)).toBe('2026-03-29');
    expect(taskDueDateKey({ dueDateTime: '2026-03-29T20:30:00.000Z' }, timezone)).toBe('2026-03-29');
    expect(taskDueDateKey({ dueDateTime: '2026-03-29T23:30:00.000Z' }, timezone)).toBe('2026-03-30');
  });

  it('filters due-today tasks using the signed-in user timezone', async () => {
    mockGetUserTimezone.mockReturnValue('America/New_York');
    const todayInNewYork = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const startOfTodayNewYorkUtc = new Date(`${todayInNewYork}T04:30:00.000Z`).toISOString();
    providerApi.getAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-ny',
          title: 'New York midnight task',
          status: 'notStarted',
          dueDateTime: startOfTodayNewYorkUtc,
          listId: 'list-1',
          listName: 'Tasks',
        },
      ],
    });

    const res = await dispatch('GET', '/filtered', { query: { filter: 'dueToday' } });

    expect(res.statusCode).toBe(200);
    expect(mockGetUserTimezone).toHaveBeenCalledWith(12);
    expect(res.body.data.tasks).toEqual([
      expect.objectContaining({ id: 'task-ny' }),
    ]);
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

  // ── Latency fix 2026-04-21: resolveTaskListName SWR cache ─────
  //
  // Prior to this pass, every PATCH / complete / checklist mutation
  // made a fresh `getLists()` MS Graph call just to look up a list's
  // display name, costing ~150-400ms per mutation. The fix teaches
  // `resolveTaskListName` to read from the user-scoped SWR cache
  // `u:${userId}:task-lists` first. These tests pin that behavior.
  describe('resolveTaskListName latency fix', () => {
    it('PATCH does NOT call provider.getLists when the SWR cache has the list', async () => {
      // Warm the SWR cache with the list the PATCH will look up.
      mockGetCachedSWR.mockImplementation((key: string) => {
        if (key === 'u:12:task-lists') {
          return {
            value: {
              lists: [
                { id: 'list-1', name: 'Tasks', displayName: 'Tasks' },
                { id: 'list-2', name: 'Work', displayName: 'Work' },
              ],
            },
            fresh: true,
          };
        }
        return null;
      });

      const res = await dispatch('PATCH', '/list-1/task-1', {
        params: { listId: 'list-1', taskId: 'task-1' },
        body: { dueDateTime: '2026-04-22T09:00:00Z' },
      });

      expect(res.statusCode).toBe(200);
      // The key assertion: getLists was NEVER invoked on the mutation path.
      // (resolveMutatedTask's fallback getTasks is a separate concern.)
      expect(providerApi.getLists).not.toHaveBeenCalled();
      // Provider updateTask WAS called with the cached list name, not 'Tasks' fallback.
      expect(providerApi.updateTask).toHaveBeenCalledWith(
        'list-1', 'task-1', expect.objectContaining({ dueDateTime: '2026-04-22T09:00:00Z' }), 'Tasks',
      );
    });

    it('POST /complete does NOT call provider.getLists when the SWR cache has the list', async () => {
      mockGetCachedSWR.mockImplementation((key: string) => {
        if (key === 'u:12:task-lists') {
          return {
            value: { lists: [{ id: 'list-1', name: 'Familia', displayName: 'Familia' }] },
            fresh: true,
          };
        }
        return null;
      });

      const res = await dispatch('POST', '/list-1/task-1/complete', {
        params: { listId: 'list-1', taskId: 'task-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(providerApi.getLists).not.toHaveBeenCalled();
      expect(providerApi.completeTask).toHaveBeenCalledWith('list-1', 'task-1', 'Familia');
    });

    it('PATCH falls back to provider.getLists on SWR cache miss', async () => {
      mockGetCachedSWR.mockReturnValue(null); // cold cache

      const res = await dispatch('PATCH', '/list-1/task-1', {
        params: { listId: 'list-1', taskId: 'task-1' },
        body: { status: 'completed' },
      });

      expect(res.statusCode).toBe(200);
      // Fallback WAS needed — getLists called exactly once.
      expect(providerApi.getLists).toHaveBeenCalledTimes(1);
    });

    it('PATCH uses the SWR cache scoped per user — other user\'s cache is ignored', async () => {
      // User 12's request should NOT see user 99's cached lists.
      mockGetCachedSWR.mockImplementation((key: string) => {
        if (key === 'u:99:task-lists') {
          return { value: { lists: [{ id: 'list-1', name: 'WrongUser' }] }, fresh: true };
        }
        return null; // user 12 has no cache → fallback
      });

      await dispatch('PATCH', '/list-1/task-1', {
        userId: 12,
        params: { listId: 'list-1', taskId: 'task-1' },
        body: { status: 'completed' },
      });

      // Since user 12's cache is empty, we should have fallen back to
      // the live getLists() call (not served user 99's cache).
      expect(providerApi.getLists).toHaveBeenCalledTimes(1);
    });
  });
});
