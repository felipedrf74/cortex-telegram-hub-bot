import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvalidateDashboardHomeCaches = vi.fn();
const mockInvalidateDashboardRootCaches = vi.fn();
const mockInvalidatePlanningCaches = vi.fn();

vi.mock('../../src/services/dashboard-cache-invalidator', () => ({
  invalidateDashboardHomeCaches: (...args: unknown[]) => mockInvalidateDashboardHomeCaches(...args),
  invalidateDashboardRootCaches: (...args: unknown[]) => mockInvalidateDashboardRootCaches(...args),
}));

vi.mock('../../src/services/plan-cache-invalidator', () => ({
  invalidatePlanningCaches: (...args: unknown[]) => mockInvalidatePlanningCaches(...args),
}));

describe('coordination-cache-invalidator', () => {
  beforeEach(() => {
    mockInvalidateDashboardHomeCaches.mockReset();
    mockInvalidateDashboardRootCaches.mockReset();
    mockInvalidatePlanningCaches.mockReset();
  });

  it('invalidates executive brief caches through Home + plan surfaces', async () => {
    const { invalidateExecutiveBriefCaches } = await import('../../src/services/coordination-cache-invalidator');

    invalidateExecutiveBriefCaches(42);

    expect(mockInvalidateDashboardHomeCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(42);
    expect(mockInvalidateDashboardRootCaches).not.toHaveBeenCalled();
  });

  it('invalidates dashboard coordination caches through root + Home + plan surfaces', async () => {
    const { invalidateDashboardCoordinationCaches } = await import('../../src/services/coordination-cache-invalidator');

    invalidateDashboardCoordinationCaches(7);

    expect(mockInvalidateDashboardRootCaches).toHaveBeenCalledWith(7);
    expect(mockInvalidateDashboardHomeCaches).toHaveBeenCalledWith(7);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(7);
  });
});
