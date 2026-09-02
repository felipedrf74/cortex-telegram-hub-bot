import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetFilmingRecommendation = vi.fn();
const mockGetTopics = vi.fn();
const mockGetUpcomingTopicCount = vi.fn();
const mockGetUnreadNotifications = vi.fn();
const mockGetKnowledgeStats = vi.fn();
const mockGetVoiceDna = vi.fn();
const mockGetActiveContentPillars = vi.fn();
const mockGetContentDeskItems = vi.fn();
const mockGetNextContentExecutionHint = vi.fn();
const mockGetRankedContentSignals = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
  },
}));

vi.mock('../../src/services/tenant-scope-observability', () => ({
  isValidTenantUserId: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  recordTenantScopeAnomaly: vi.fn(),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  getUnreadNotifications: (...args: unknown[]) => mockGetUnreadNotifications(...args),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getFilmingRecommendation: (...args: unknown[]) => mockGetFilmingRecommendation(...args),
  getTopics: (...args: unknown[]) => mockGetTopics(...args),
  getUpcomingTopicCount: (...args: unknown[]) => mockGetUpcomingTopicCount(...args),
}));

vi.mock('../../src/services/content-dashboard-service', () => ({
  getKnowledgeStats: (...args: unknown[]) => mockGetKnowledgeStats(...args),
  getVoiceDna: (...args: unknown[]) => mockGetVoiceDna(...args),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: (...args: unknown[]) => mockGetActiveContentPillars(...args),
  getContentDeskItems: (...args: unknown[]) => mockGetContentDeskItems(...args),
  getNextContentExecutionHint: (...args: unknown[]) => mockGetNextContentExecutionHint(...args),
  getRankedContentSignals: (...args: unknown[]) => mockGetRankedContentSignals(...args),
}));

import { readContentMeshContext } from '../../src/services/cross-agent-learning/content-mesh-context';

describe('readContentMeshContext source health', () => {
  beforeEach(() => {
    for (const mock of [
      mockGetFilmingRecommendation,
      mockGetTopics,
      mockGetUpcomingTopicCount,
      mockGetUnreadNotifications,
      mockGetKnowledgeStats,
      mockGetVoiceDna,
      mockGetActiveContentPillars,
      mockGetContentDeskItems,
      mockGetNextContentExecutionHint,
      mockGetRankedContentSignals,
    ]) {
      mock.mockReset();
    }
  });

  it('does not label all-empty fallback projections ready when every Content read fails', async () => {
    mockGetFilmingRecommendation.mockRejectedValueOnce(new Error('filming failed'));
    mockGetTopics.mockImplementationOnce(() => { throw new Error('topics failed'); });
    mockGetUpcomingTopicCount.mockImplementationOnce(() => { throw new Error('upcoming failed'); });
    mockGetUnreadNotifications.mockImplementationOnce(() => { throw new Error('notifications failed'); });
    mockGetKnowledgeStats.mockImplementationOnce(() => { throw new Error('knowledge failed'); });
    mockGetVoiceDna.mockImplementationOnce(() => { throw new Error('voice failed'); });
    mockGetActiveContentPillars.mockImplementationOnce(() => { throw new Error('pillars failed'); });
    mockGetContentDeskItems.mockImplementationOnce(() => { throw new Error('desk failed'); });
    mockGetNextContentExecutionHint.mockRejectedValueOnce(new Error('execution failed'));
    mockGetRankedContentSignals.mockImplementationOnce(() => { throw new Error('signals failed'); });

    const context = await readContentMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(context.scheduledTopics).toEqual([]);
    expect(context.sourceHealth).toEqual(expect.objectContaining({
      status: 'unavailable',
      warningCodes: ['CONTENT_STATE_UNAVAILABLE'],
    }));
  });
});
