import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClearCacheByPrefix = vi.fn();
const mockInvalidateContextCache = vi.fn();
const mockInvalidateSharedDecisionContextCache = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/context-engine', () => ({
  invalidateContextCache: (...args: unknown[]) => mockInvalidateContextCache(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  invalidateSharedDecisionContextCache: (...args: unknown[]) => mockInvalidateSharedDecisionContextCache(...args),
}));

import { invalidatePlanningCaches } from '../../src/services/plan-cache-invalidator';

describe('plan-cache-invalidator', () => {
  beforeEach(() => {
    mockClearCacheByPrefix.mockReset();
    mockInvalidateContextCache.mockReset();
    mockInvalidateSharedDecisionContextCache.mockReset();
  });

  it('invalidates the requested user planning, daily context, and shared-decision caches when userId is provided', () => {
    invalidatePlanningCaches(42);

    expect(mockClearCacheByPrefix).toHaveBeenCalledTimes(2);
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:42:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:42:');
    expect(mockInvalidateSharedDecisionContextCache).toHaveBeenCalledWith(42);
    expect(mockInvalidateContextCache).toHaveBeenCalledWith(42);
  });

  it('falls back to global invalidation when no userId is provided', () => {
    invalidatePlanningCaches();

    expect(mockClearCacheByPrefix).toHaveBeenCalledTimes(2);
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:');
    expect(mockInvalidateSharedDecisionContextCache).toHaveBeenCalledWith();
    expect(mockInvalidateContextCache).toHaveBeenCalledWith();
  });
});
