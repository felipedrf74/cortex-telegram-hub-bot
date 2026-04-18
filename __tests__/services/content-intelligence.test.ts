import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAll = vi.fn();
const mockGetUnreadNotifications = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockAll(...args),
    }),
  }),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  getUnreadNotifications: (...args: unknown[]) => mockGetUnreadNotifications(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';
import { getActiveContentPillars, getContentDeskItems } from '../../src/services/content-intelligence';

describe('content-intelligence', () => {
  beforeEach(() => {
    mockAll.mockReset();
    mockGetUnreadNotifications.mockReset();
    clearTenantScopeAnomaliesForTests();
  });

  it('fails closed on invalid tenant scope for active pillars', () => {
    expect(getActiveContentPillars(0)).toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'get_active_content_pillars',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  it('fails closed on invalid tenant scope for content desk items', () => {
    expect(getContentDeskItems(0, 3)).toEqual([]);
    expect(mockGetUnreadNotifications).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'get_content_desk_items',
          reason: 'invalid_user_scope',
          userId: 0,
          details: { limit: 3 },
        }),
      ]),
    );
  });
});
