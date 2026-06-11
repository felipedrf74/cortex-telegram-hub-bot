import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockInvalidateContextCache = vi.fn();
const mockInvalidateSharedDecisionContextCache = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/context-engine', () => ({
  invalidateContextCache: (...args: unknown[]) => mockInvalidateContextCache(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  invalidateSharedDecisionContextCache: (...args: unknown[]) => mockInvalidateSharedDecisionContextCache(...args),
}));

vi.mock('../../src/services/tenant-scope-observability', () => ({
  isValidTenantUserId: (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0,
}));

import {
  _resetDashboardCacheInvalidationStatsForTests,
  getDashboardCacheInvalidationStats,
  invalidateCalendarCaches,
  invalidateContentDerivedCaches,
  invalidateCookingDerivedCaches,
  invalidateDashboardCaches,
  invalidateDashboardCoordinationCaches,
  invalidateExecutiveBriefCaches,
  invalidateFinanceDerivedCaches,
  invalidateIntegrationDerivedCaches,
  invalidateOnboardingDerivedCaches,
  invalidatePlanningCaches,
  invalidateTaskCaches,
  invalidateTrainingDerivedCaches,
} from '../../src/services/cache-coherence-registry';

function clearKeys(): string[] {
  return mockClearCache.mock.calls.map(([key]) => String(key));
}

function prefixKeys(): string[] {
  return mockClearCacheByPrefix.mock.calls.flatMap(([key]) => (
    Array.isArray(key) ? key.map(String) : [String(key)]
  ));
}

function prefixCalls(): unknown[] {
  return mockClearCacheByPrefix.mock.calls.map(([key]) => key);
}

describe('cache-coherence-registry', () => {
  beforeEach(() => {
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockInvalidateContextCache.mockReset();
    mockInvalidateSharedDecisionContextCache.mockReset();
    _resetDashboardCacheInvalidationStatsForTests();
  });

  it('invalidates planning, shared decision, and daily context caches together', () => {
    invalidatePlanningCaches(42);

    expect(prefixCalls()).toEqual([[
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]]);
    expect(prefixKeys()).toEqual([
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
    expect(mockInvalidateSharedDecisionContextCache).toHaveBeenCalledWith(42);
    expect(mockInvalidateContextCache).toHaveBeenCalledWith(42);
  });

  it('preserves global planning invalidation when no user scope exists', () => {
    invalidatePlanningCaches();

    expect(prefixKeys()).toEqual([
      'plan:week:u:',
      'plan:today:u:',
    ]);
    expect(mockInvalidateSharedDecisionContextCache).toHaveBeenCalledWith();
    expect(mockInvalidateContextCache).toHaveBeenCalledWith();
  });

  it('invalidates dashboard families with legacy stats semantics', () => {
    invalidateDashboardCaches(42);

    expect(clearKeys()).toEqual(['dashboard-readiness:42']);
    expect(prefixKeys()).toEqual(['dashboard:42:', 'dashboard-home:42:']);
    expect(getDashboardCacheInvalidationStats()).toMatchObject({
      requestCount: 1,
      userScopedRequestCount: 1,
      globalRequestCount: 0,
      clearCountRequested: 1,
      clearByPrefixCountRequested: 2,
      lastUserId: 42,
    });
  });

  it('maps executive brief writes to dashboard-home plus planning caches', () => {
    invalidateExecutiveBriefCaches(42);

    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
    expect(mockInvalidateSharedDecisionContextCache).toHaveBeenCalledWith(42);
    expect(mockInvalidateContextCache).toHaveBeenCalledWith(42);
  });

  it('maps dashboard coordination writes to dashboard root, home, and planning caches', () => {
    invalidateDashboardCoordinationCaches(42);

    expect(prefixKeys()).toEqual([
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('maps calendar writes to raw calendar plus downstream coordination surfaces', () => {
    invalidateCalendarCaches(42);

    expect(prefixKeys()).toEqual([
      'u:42:calendar:',
      'calendar:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('maps content writes to dashboard coordination surfaces', () => {
    invalidateContentDerivedCaches(42);

    expect(prefixKeys()).toEqual([
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('maps finance writes to executive brief surfaces only', () => {
    invalidateFinanceDerivedCaches(42);

    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('maps cooking writes to executive brief unless calendar surfaces are requested', () => {
    invalidateCookingDerivedCaches(42);

    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);

    mockClearCacheByPrefix.mockReset();
    invalidateCookingDerivedCaches(42, { includeCalendarSurfaces: true });

    expect(prefixKeys()).toEqual([
      'u:42:calendar:',
      'calendar:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('maps task writes to legacy user and global task keys plus derived surfaces', () => {
    invalidateTaskCaches({ userId: 42, listIds: ['abc'], includeDerivedSurfaces: true });

    expect(clearKeys()).toEqual([
      'u:42:task-lists',
      'u:42:tasks-working-set',
      'u:42:fastpath:pending-tasks',
      'u:42:tasks-filtered:all',
      'u:42:tasks-filtered:overdue',
      'u:42:tasks-filtered:dueToday',
      'task-lists',
      'tasks-working-set',
      'fastpath:pending-tasks',
      'tasks-filtered:all',
      'tasks-filtered:overdue',
      'tasks-filtered:dueToday',
    ]);
    expect(prefixKeys()).toEqual([
      'u:42:tasks:abc:',
      'tasks:abc:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
    expect(prefixCalls()[0]).toEqual([
      'u:42:tasks:abc:',
      'tasks:abc:',
    ]);
  });

  it('can clear task list caches without derived dashboard surfaces', () => {
    invalidateTaskCaches({ userId: 7, includeDerivedSurfaces: false });

    expect(clearKeys()).toContain('u:7:task-lists');
    expect(prefixKeys()).toEqual([]);
  });

  it('maps training writes to training, dashboard, and planning surfaces', () => {
    invalidateTrainingDerivedCaches(42);

    expect(clearKeys()).toEqual([
      'coach-briefing:42',
      'training-summary:42',
      'readiness:42',
      'dashboard-readiness:42',
    ]);
    expect(prefixKeys()).toEqual([
      'training-home:42:',
      // training-history / training-load-snapshot keys are tenant-first,
      // so the whole family is cleared rather than a user-scoped prefix
      // (60s / 300s TTLs, rare event).
      'training-history:',
      'training-load-snapshot:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('routes onboarding profiles through their legacy domain invalidation graph', () => {
    invalidateOnboardingDerivedCaches(42, 'triathlon-running');
    expect(clearKeys()).toContain('coach-briefing:42');
    expect(prefixKeys()).toContain('training-home:42:');

    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    invalidateOnboardingDerivedCaches(42, 'diet');
    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);

    mockClearCacheByPrefix.mockReset();
    invalidateOnboardingDerivedCaches(42, 'homeschool');
    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('routes integration provider changes through provider-specific invalidation graphs', () => {
    invalidateIntegrationDerivedCaches(42, 'outlook');

    expect(clearKeys()).toEqual([
      'u:42:task-lists',
      'u:42:tasks-working-set',
      'u:42:fastpath:pending-tasks',
      'u:42:tasks-filtered:all',
      'u:42:tasks-filtered:overdue',
      'u:42:tasks-filtered:dueToday',
      'task-lists',
      'tasks-working-set',
      'fastpath:pending-tasks',
      'tasks-filtered:all',
      'tasks-filtered:overdue',
      'tasks-filtered:dueToday',
    ]);
    expect(prefixKeys()).toEqual([
      'u:42:calendar:',
      'calendar:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
      'dashboard:42:',
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);

    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    invalidateIntegrationDerivedCaches(42, 'garmin');
    expect(clearKeys()).toContain('coach-briefing:42');
    expect(prefixKeys()).toContain('training-home:42:');

    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    invalidateIntegrationDerivedCaches(42, 'custom-provider');
    expect(prefixKeys()).toEqual([
      'dashboard-home:42:',
      'plan:week:u:42:',
      'plan:today:u:42:',
    ]);
  });

  it('does not invalidate shared or synthetic scopes for invalid integration users', () => {
    invalidateIntegrationDerivedCaches(0, 'google');
    invalidateIntegrationDerivedCaches(Number.NaN, 'outlook');

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockClearCacheByPrefix).not.toHaveBeenCalled();
    expect(mockInvalidateSharedDecisionContextCache).not.toHaveBeenCalled();
    expect(mockInvalidateContextCache).not.toHaveBeenCalled();
  });
});
