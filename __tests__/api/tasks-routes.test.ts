import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockResolveTaskProvider = vi.fn();
const mockGetTaskProviderForUser = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
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
    userId: 12,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  options: {
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
    getAllPendingTasks: vi.fn(),
    findListByName: vi.fn(),
    getDefaultList: vi.fn(),
    createTask: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTaskProvider.mockReturnValue('ms_todo');
    mockGetTaskProviderForUser.mockReturnValue(providerApi);
    mockGetCachedSWR.mockReturnValue(null);
    mockSetCacheSWR.mockReturnValue(undefined);
    mockSetCache.mockReturnValue(undefined);
    mockClearCache.mockReturnValue(undefined);
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
  });
});
