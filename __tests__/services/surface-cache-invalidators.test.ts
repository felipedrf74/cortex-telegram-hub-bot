import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockInvalidateDashboardCaches = vi.fn();
const mockInvalidatePlanningCaches = vi.fn();
const mockInvalidateDashboardCoordinationCaches = vi.fn();
const mockInvalidateExecutiveBriefCaches = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/dashboard-cache-invalidator', () => ({
  invalidateDashboardCaches: (...args: unknown[]) => mockInvalidateDashboardCaches(...args),
}));

vi.mock('../../src/services/plan-cache-invalidator', () => ({
  invalidatePlanningCaches: (...args: unknown[]) => mockInvalidatePlanningCaches(...args),
}));

vi.mock('../../src/services/coordination-cache-invalidator', () => ({
  invalidateDashboardCoordinationCaches: (...args: unknown[]) => mockInvalidateDashboardCoordinationCaches(...args),
  invalidateExecutiveBriefCaches: (...args: unknown[]) => mockInvalidateExecutiveBriefCaches(...args),
}));

describe('surface cache invalidators', () => {
  beforeEach(() => {
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockInvalidateDashboardCaches.mockReset();
    mockInvalidatePlanningCaches.mockReset();
    mockInvalidateDashboardCoordinationCaches.mockReset();
    mockInvalidateExecutiveBriefCaches.mockReset();
  });

  it('invalidates the full training-derived cache family together', async () => {
    const { invalidateTrainingDerivedCaches } = await import('../../src/services/training-cache-invalidator');

    invalidateTrainingDerivedCaches(42);

    expect(mockClearCache).toHaveBeenCalledWith('coach-briefing:42');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:42');
    expect(mockClearCache).toHaveBeenCalledWith('readiness:42');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('training-home:42:');
    expect(mockInvalidateDashboardCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(42);
  });

  it('invalidates calendar caches and downstream coordination surfaces together', async () => {
    const { invalidateCalendarCaches } = await import('../../src/services/calendar-cache-invalidator');

    invalidateCalendarCaches(42);

    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('u:42:calendar:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('calendar:');
    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
  });

  it('invalidates task caches with legacy compatibility keys and derived surfaces', async () => {
    const { invalidateTaskCaches } = await import('../../src/services/task-cache-invalidator');

    invalidateTaskCaches({ userId: 42, listIds: ['abc'], includeDerivedSurfaces: true });

    expect(mockClearCache).toHaveBeenCalledWith('u:42:task-lists');
    expect(mockClearCache).toHaveBeenCalledWith('task-lists');
    expect(mockClearCache).toHaveBeenCalledWith('u:42:tasks:abc:all');
    expect(mockClearCache).toHaveBeenCalledWith('tasks:abc:all');
    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
  });

  it('can invalidate task list caches without touching derived dashboard surfaces', async () => {
    const { invalidateTaskCaches } = await import('../../src/services/task-cache-invalidator');

    invalidateTaskCaches({ userId: 7, includeDerivedSurfaces: false });

    expect(mockClearCache).toHaveBeenCalledWith('u:7:task-lists');
    expect(mockInvalidateDashboardCoordinationCaches).not.toHaveBeenCalled();
  });

  it('routes training onboarding profile writes through training-derived invalidation', async () => {
    const { invalidateOnboardingDerivedCaches } = await import('../../src/services/onboarding-cache-invalidator');

    invalidateOnboardingDerivedCaches(42, 'triathlon-running');

    expect(mockClearCache).toHaveBeenCalledWith('coach-briefing:42');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('training-home:42:');
    expect(mockInvalidateDashboardCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(42);
  });

  it('routes diet onboarding profile writes through cooking-derived invalidation', async () => {
    const { invalidateOnboardingDerivedCaches } = await import('../../src/services/onboarding-cache-invalidator');

    invalidateOnboardingDerivedCaches(42, 'diet');

    expect(mockInvalidateExecutiveBriefCaches).toHaveBeenCalledWith(42);
  });

  it('routes unknown onboarding writes through executive brief invalidation', async () => {
    const { invalidateOnboardingDerivedCaches } = await import('../../src/services/onboarding-cache-invalidator');

    invalidateOnboardingDerivedCaches(42, 'homeschool');

    expect(mockInvalidateExecutiveBriefCaches).toHaveBeenCalledWith(42);
  });

  it('routes Google connection changes through calendar and finance surfaces', async () => {
    const { invalidateIntegrationDerivedCaches } = await import('../../src/services/integration-cache-invalidator');

    invalidateIntegrationDerivedCaches(42, 'google');

    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('u:42:calendar:');
    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidateExecutiveBriefCaches).toHaveBeenCalledWith(42);
  });

  it('routes Outlook connection changes through calendar, finance, and task surfaces', async () => {
    const { invalidateIntegrationDerivedCaches } = await import('../../src/services/integration-cache-invalidator');

    invalidateIntegrationDerivedCaches(42, 'outlook');

    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('u:42:calendar:');
    expect(mockClearCache).toHaveBeenCalledWith('u:42:task-lists');
    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidateExecutiveBriefCaches).toHaveBeenCalledWith(42);
  });

  it('routes task-provider connection changes through task surfaces', async () => {
    const { invalidateIntegrationDerivedCaches } = await import('../../src/services/integration-cache-invalidator');

    invalidateIntegrationDerivedCaches(42, 'todoist');

    expect(mockClearCache).toHaveBeenCalledWith('u:42:task-lists');
    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
  });

  it('routes wearable connection changes through training surfaces', async () => {
    const { invalidateIntegrationDerivedCaches } = await import('../../src/services/integration-cache-invalidator');

    invalidateIntegrationDerivedCaches(42, 'strava');

    expect(mockClearCache).toHaveBeenCalledWith('coach-briefing:42');
    expect(mockInvalidateDashboardCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(42);
  });

  it('falls back unknown provider connection changes to executive brief invalidation', async () => {
    const { invalidateIntegrationDerivedCaches } = await import('../../src/services/integration-cache-invalidator');

    invalidateIntegrationDerivedCaches(42, 'custom-provider');

    expect(mockInvalidateExecutiveBriefCaches).toHaveBeenCalledWith(42);
  });

  it('routes content writes through dashboard coordination surfaces', async () => {
    const { invalidateContentDerivedCaches } = await import('../../src/services/content-cache-invalidator');

    invalidateContentDerivedCaches(42);

    expect(mockInvalidateDashboardCoordinationCaches).toHaveBeenCalledWith(42);
  });
});
