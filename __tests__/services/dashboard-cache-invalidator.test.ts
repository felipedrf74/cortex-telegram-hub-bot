import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

describe('dashboard-cache-invalidator', () => {
  beforeEach(() => {
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
  });

  it('invalidates all user-scoped dashboard cache families together', async () => {
    const {
      invalidateDashboardCaches,
      getDashboardCacheInvalidationStats,
      _resetDashboardCacheInvalidationStatsForTests,
    } = await import('../../src/services/dashboard-cache-invalidator');
    _resetDashboardCacheInvalidationStatsForTests();

    invalidateDashboardCaches(42);

    expect(mockClearCache).toHaveBeenCalledWith('dashboard-readiness:42');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:42:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:42:');
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      userScopedRequestCount: 1,
      globalRequestCount: 0,
      clearCountRequested: 1,
      clearByPrefixCountRequested: 2,
      lastUserId: 42,
    });
  });

  it('can invalidate all dashboard cache families globally', async () => {
    const {
      invalidateDashboardCaches,
      getDashboardCacheInvalidationStats,
      _resetDashboardCacheInvalidationStatsForTests,
    } = await import('../../src/services/dashboard-cache-invalidator');
    _resetDashboardCacheInvalidationStatsForTests();

    invalidateDashboardCaches();

    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-readiness:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:');
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      userScopedRequestCount: 0,
      globalRequestCount: 1,
      clearCountRequested: 0,
      clearByPrefixCountRequested: 3,
      lastUserId: null,
    });
  });

  it('can invalidate only the dashboard home cache family', async () => {
    const {
      invalidateDashboardHomeCaches,
      getDashboardCacheInvalidationStats,
      _resetDashboardCacheInvalidationStatsForTests,
    } = await import('../../src/services/dashboard-cache-invalidator');
    _resetDashboardCacheInvalidationStatsForTests();

    invalidateDashboardHomeCaches(42);

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:42:');
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      userScopedRequestCount: 1,
      clearCountRequested: 0,
      clearByPrefixCountRequested: 1,
      lastUserId: 42,
    });
  });

  it('can invalidate only the dashboard root cache family', async () => {
    const {
      invalidateDashboardRootCaches,
      getDashboardCacheInvalidationStats,
      _resetDashboardCacheInvalidationStatsForTests,
    } = await import('../../src/services/dashboard-cache-invalidator');
    _resetDashboardCacheInvalidationStatsForTests();

    invalidateDashboardRootCaches(42);

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:42:');
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      userScopedRequestCount: 1,
      clearCountRequested: 0,
      clearByPrefixCountRequested: 1,
      lastUserId: 42,
    });
  });

  it('can invalidate only readiness cache family globally', async () => {
    const {
      invalidateDashboardReadinessCaches,
      getDashboardCacheInvalidationStats,
      _resetDashboardCacheInvalidationStatsForTests,
    } = await import('../../src/services/dashboard-cache-invalidator');
    _resetDashboardCacheInvalidationStatsForTests();

    invalidateDashboardReadinessCaches();

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-readiness:');
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      globalRequestCount: 1,
      clearCountRequested: 0,
      clearByPrefixCountRequested: 1,
      lastUserId: null,
    });
  });
});
