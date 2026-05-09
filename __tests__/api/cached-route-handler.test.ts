import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCachedSWR = vi.hoisted(() => vi.fn());
const mockSetCacheSWR = vi.hoisted(() => vi.fn());
const mockRecordSuccess = vi.hoisted(() => vi.fn());
const mockRecordFailure = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/cache-store', () => ({
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
}));

vi.mock('../../src/services/swr-refresh-observability', () => ({
  recordSWRRefreshSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
  recordSWRRefreshFailure: (...args: unknown[]) => mockRecordFailure(...args),
}));

import {
  _resetCachedRouteHandlerForTests,
  ensureCachedRouteTenantScope,
  handleCachedRoute,
  routeCacheKey,
} from '../../src/api/route-helpers/cached-route-handler';
import { classifyProviderRouteError } from '../../src/api/route-helpers/provider-error-classifier';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('cached route handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTenantScopeAnomaliesForTests();
    _resetCachedRouteHandlerForTests();
    mockGetCachedSWR.mockReturnValue(null);
  });

  it('fetches and writes on a cold cache miss through the public handler interface', async () => {
    const send = vi.fn();
    const fetchFresh = vi.fn(async () => ({ answer: 42 }));

    const result = await handleCachedRoute({
      cacheKey: 'route:key',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'test_route', operation: 'test_swr_refresh', userId: 12 },
      fetchFresh,
      send,
    });

    expect(result).toEqual({ source: 'fresh' });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(mockSetCacheSWR).toHaveBeenCalledWith('route:key', { answer: 42 }, 60, 300);
    expect(send).toHaveBeenCalledWith({ answer: 42 }, { cached: false, fresh: true });
  });

  it('serves fresh cache without touching the upstream fetcher', async () => {
    const send = vi.fn();
    const fetchFresh = vi.fn(async () => ({ answer: 99 }));
    mockGetCachedSWR.mockReturnValue({ fresh: true, value: { answer: 42 } });

    const result = await handleCachedRoute({
      cacheKey: 'route:key',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'test_route', operation: 'test_swr_refresh' },
      fetchFresh,
      send,
    });

    expect(result).toEqual({ source: 'cache' });
    expect(fetchFresh).not.toHaveBeenCalled();
    expect(mockSetCacheSWR).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ answer: 42 }, { cached: true, fresh: true });
  });

  it('serves stale cache immediately and refreshes once in the background per cache key', async () => {
    const send = vi.fn();
    const firstRefresh = deferred<{ answer: number }>();
    const fetchFresh = vi.fn(() => firstRefresh.promise);
    mockGetCachedSWR.mockReturnValue({ fresh: false, value: { answer: 42 } });

    await handleCachedRoute({
      cacheKey: 'route:key',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'test_route', operation: 'test_swr_refresh', userId: 12 },
      fetchFresh,
      send,
    });
    await handleCachedRoute({
      cacheKey: 'route:key',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'test_route', operation: 'test_swr_refresh', userId: 12 },
      fetchFresh,
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(fetchFresh).toHaveBeenCalledTimes(1);

    firstRefresh.resolve({ answer: 43 });
    await flushPromises();

    expect(mockSetCacheSWR).toHaveBeenCalledWith('route:key', { answer: 43 }, 60, 300);
    expect(mockRecordSuccess).toHaveBeenCalledWith('route:key');
  });

  it('records stale refresh failures with the route context', async () => {
    const send = vi.fn();
    const err = new Error('provider timeout');
    const fetchFresh = vi.fn(async () => { throw err; });
    mockGetCachedSWR.mockReturnValue({ fresh: false, value: { answer: 42 } });

    await handleCachedRoute({
      cacheKey: 'route:key',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'test_route', operation: 'test_swr_refresh', userId: 12 },
      fetchFresh,
      send,
    });
    await flushPromises();

    expect(send).toHaveBeenCalledWith({ answer: 42 }, { cached: true, fresh: false });
    expect(mockRecordFailure).toHaveBeenCalledWith('route:key', err, {
      source: 'test_route',
      operation: 'test_swr_refresh',
      userId: 12,
    });
  });

  it('can bypass an unsafe cached value and fetch fresh instead', async () => {
    const send = vi.fn();
    const onCachedBypass = vi.fn();
    const fetchFresh = vi.fn(async () => ({ tasks: [{ id: 'fresh' }] }));
    mockGetCachedSWR.mockReturnValue({ fresh: true, value: { tasks: [] } });

    await handleCachedRoute({
      cacheKey: 'tasks:list',
      ttlSeconds: 60,
      staleSeconds: 300,
      refreshContext: { source: 'tasks_route', operation: 'task_swr_refresh' },
      fetchFresh,
      shouldServeCached: ({ value }) => value.tasks.length > 0,
      onCachedBypass,
      send,
    });

    expect(onCachedBypass).toHaveBeenCalled();
    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ tasks: [{ id: 'fresh' }] }, { cached: false, fresh: true });
  });

  it('centralizes route cache key construction without dropping empty trailing parts', () => {
    expect(routeCacheKey('u', 12, 'tasks', 'list-1', 'active', 'all', 75, '')).toBe(
      'u:12:tasks:list-1:active:all:75:',
    );
  });

  it('uses the tenant route scope guard for cached routes', () => {
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) { res.statusCode = code; return res; },
      json(body: unknown) { res.body = body; return res; },
    };

    expect(ensureCachedRouteTenantScope(res, undefined, 'cached_route_test')).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies()).toHaveLength(1);
  });
});

describe('provider error classifier', () => {
  it.each([
    [{ status: 401, message: 'invalid_grant' }, 401, 'PROVIDER_AUTH_REQUIRED'],
    [{ status: 403, message: 'forbidden' }, 401, 'PROVIDER_AUTH_REQUIRED'],
    [{ status: 429, message: 'quota exceeded' }, 429, 'PROVIDER_RATE_LIMITED'],
    [{ status: 503, message: 'network unavailable' }, 503, 'PROVIDER_TEMPORARY_UNAVAILABLE'],
    [new Error('socket timeout'), 503, 'PROVIDER_TEMPORARY_UNAVAILABLE'],
    [new Error('unexpected shape'), 500, 'PROVIDER_FAILED'],
  ])('maps provider error class %# to a stable iOS code', (err, status, code) => {
    expect(classifyProviderRouteError(err, 'read')).toMatchObject({ status, code });
  });
});
