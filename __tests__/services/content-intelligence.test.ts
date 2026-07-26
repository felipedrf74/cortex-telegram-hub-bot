import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAll = vi.fn();
const mockGetUnreadNotifications = vi.fn();
const mockReadRankedSignals = vi.fn();
const mockGetFilmingRecommendation = vi.fn();
const mockGetTopics = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockAll(...args),
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  getUnreadNotifications: (...args: unknown[]) => mockGetUnreadNotifications(...args),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readRankedSignals: (...args: unknown[]) => mockReadRankedSignals(...args),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getFilmingRecommendation: (...args: unknown[]) => mockGetFilmingRecommendation(...args),
  getTopics: (...args: unknown[]) => mockGetTopics(...args),
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
  LOGGER_REDACTION_PATHS: [],
}));

import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';
import {
  getActiveContentPillars,
  getContentDeskItems,
  getNextContentExecutionHint,
  getRankedContentSignals,
  localizeFilmingRecommendation,
} from '../../src/services/content-intelligence';

describe('content-intelligence', () => {
  beforeEach(() => {
    mockAll.mockReset().mockReturnValue([]);
    mockGetUnreadNotifications.mockReset().mockReturnValue([]);
    mockReadRankedSignals.mockReset().mockReturnValue([]);
    mockGetFilmingRecommendation.mockReset().mockResolvedValue(null);
    mockGetTopics.mockReset().mockReturnValue([]);
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
          details: { tenantId: 0 },
        }),
      ]),
    );
  });

  it('rejects an invalid explicit tenant even when the pillar user is valid', () => {
    expect(getActiveContentPillars(7001, 0)).toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual([
      expect.objectContaining({
        operation: 'get_active_content_pillars',
        userId: 7001,
        details: { tenantId: 0 },
      }),
    ]);
  });

  it('reads and deduplicates active pillars for a valid explicit tenant', () => {
    mockAll.mockReturnValue([
      { name: 'Endurance', keywords: '["fueling","recovery"]', user_id: 7001, weight: 3 },
      { name: 'Endurance', keywords: '["duplicate"]', user_id: 7001, weight: 2 },
      { name: 'Strength', keywords: 'not-json', user_id: 7001, weight: 1 },
    ]);

    expect(getActiveContentPillars(7001, 9001)).toEqual([
      { name: 'Endurance', keywordCount: 2 },
      { name: 'Strength', keywordCount: 0 },
    ]);
    expect(mockAll).toHaveBeenCalledOnce();
    expect(mockAll).toHaveBeenCalledWith(9001, 7001);
    expect(getTenantScopeAnomalies()).toEqual([]);
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
          details: { limit: 3, tenantId: 0 },
        }),
      ]),
    );
  });

  it('rejects an invalid explicit tenant even when the desk user is valid', () => {
    expect(getContentDeskItems(7001, 3, 0)).toEqual([]);
    expect(mockGetUnreadNotifications).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual([
      expect.objectContaining({
        operation: 'get_content_desk_items',
        userId: 7001,
        details: { limit: 3, tenantId: 0 },
      }),
    ]);
  });

  it('requests a bounded notification window and returns only eligible desk items', () => {
    mockGetUnreadNotifications.mockReturnValue([
      {
        id: 1,
        type: 'delivery_receipt',
        title: 'Ignored',
        body: 'Not a content desk item.',
        createdAt: '2026-07-25T08:00:00.000Z',
      },
      {
        id: 2,
        type: 'topic_candidates_ready',
        title: 'Topic candidates',
        body: 'Three candidates are ready.',
        createdAt: '2026-07-25T09:00:00.000Z',
      },
      {
        id: 3,
        type: 'script_ready',
        title: 'Script ready',
        body: 'The script is ready to record.',
        createdAt: '2026-07-25T10:00:00.000Z',
      },
      {
        id: 4,
        type: 'weekly_package_ready',
        title: 'Weekly package',
        body: 'The weekly package is ready.',
        createdAt: '2026-07-25T11:00:00.000Z',
      },
    ]);

    expect(getContentDeskItems(7001, 2, 9001)).toEqual([
      {
        id: 2,
        type: 'topic_candidates_ready',
        title: 'Topic candidates',
        body: 'Three candidates are ready.',
        createdAt: '2026-07-25T09:00:00.000Z',
      },
      {
        id: 3,
        type: 'script_ready',
        title: 'Script ready',
        body: 'The script is ready to record.',
        createdAt: '2026-07-25T10:00:00.000Z',
      },
    ]);
    expect(mockGetUnreadNotifications).toHaveBeenCalledOnce();
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith(7001, 6, 9001);
  });

  it('localizes filming recommendation copy to pt-BR instead of pt-PT wording', () => {
    const localized = localizeFilmingRecommendation(
      {
        reason: 'Only light training is planned, so it should be easier to film well.',
        reasons: [
          'Only light training is planned, so it should be easier to film well.',
          'The calendar looks light, which is good for a focused filming block.',
        ],
        calendarReservationMessage: 'Connect Google Calendar or Outlook in Settings to reserve this filming block.',
      },
      'pt-BR',
    );

    expect(localized?.reason).toBe('Só há treino leve planejado, por isso deve ser mais fácil filmar bem.');
    expect(localized?.reasons).toContain('O calendário parece leve, o que é bom para um bloco de filmagem focado.');
    expect(localized?.calendarReservationMessage).toBe('Conecte o Google Calendar ou o Outlook nas Configurações para reservar este bloco de filmagem.');
  });

  it('fails closed on invalid tenant scope for ranked content signals', () => {
    expect(getRankedContentSignals(0)).toEqual([]);
    expect(mockReadRankedSignals).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'get_ranked_content_signals',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  it('reads creator digests only through the explicit tenant scope', () => {
    mockReadRankedSignals.mockReturnValue([]);

    expect(getRankedContentSignals(7001, 6, 9001)).toEqual([]);
    expect(mockReadRankedSignals).toHaveBeenCalledWith(
      'content-intelligence',
      expect.arrayContaining(['learning_digest', 'creator_learning_digest']),
      expect.objectContaining({ userId: 7001, tenantId: 9001, limit: 6 }),
    );
  });

  it('prefers a ready scheduled topic for the next execution hint', async () => {
    const hint = await getNextContentExecutionHint(7001, {
      topics: [
        {
          id: 21,
          user_id: 7001,
          title: 'Race-week fueling mistakes',
          notes: null,
          scheduled_date: '2026-04-25',
          status: 'ready',
          created_at: '2026-04-20T10:00:00.000Z',
          updated_at: '2026-04-20T10:00:00.000Z',
        },
      ],
      deskItems: [],
      rankedSignals: [],
      filmingRecommendation: null,
      pillars: [],
    });

    expect(hint).toMatchObject({
      mode: 'publish_ready',
      title: 'Race-week fueling mistakes',
      scheduledDate: '2026-04-25',
      confidence: 'high',
      sourceType: 'topic_ready',
    });
  });

  it('loads every execution-hint dependency with secure defaults when options are omitted', async () => {
    mockGetTopics.mockReturnValue([
      {
        id: 22,
        user_id: 7001,
        title: 'Default-loaded ready topic',
        notes: null,
        scheduled_date: '2026-07-28',
        status: 'ready',
        created_at: '2026-07-25T10:00:00.000Z',
        updated_at: '2026-07-25T10:00:00.000Z',
      },
    ]);

    await expect(getNextContentExecutionHint(7001)).resolves.toMatchObject({
      mode: 'publish_ready',
      title: 'Default-loaded ready topic',
    });
    expect(mockGetTopics).toHaveBeenCalledOnce();
    expect(mockGetTopics).toHaveBeenCalledWith(7001, {
      includeTerminal: false,
      limit: 100,
      tenantId: undefined,
    });
    expect(mockGetUnreadNotifications).toHaveBeenCalledOnce();
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith(7001, 12, 7001);
    expect(mockReadRankedSignals).toHaveBeenCalledOnce();
    expect(mockReadRankedSignals).toHaveBeenCalledWith(
      'content-intelligence',
      expect.arrayContaining(['reaction_opportunity', 'pipeline_bottleneck']),
      {
        userId: 7001,
        tenantId: undefined,
        limit: 4,
        minConfidence: 0.2,
      },
    );
    expect(mockGetFilmingRecommendation).toHaveBeenCalledOnce();
    expect(mockGetFilmingRecommendation).toHaveBeenCalledWith(
      7001,
      expect.arrayContaining([expect.objectContaining({ id: 22 })]),
      undefined,
    );
    expect(mockAll).toHaveBeenCalledOnce();
    expect(mockAll).toHaveBeenCalledWith(7001, 7001);
  });

  it('propagates an explicit tenant through every default execution-hint dependency', async () => {
    await expect(getNextContentExecutionHint(7001, { tenantId: 9001 })).resolves.toBeNull();

    expect(mockGetTopics).toHaveBeenCalledWith(7001, {
      includeTerminal: false,
      limit: 100,
      tenantId: 9001,
    });
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith(7001, 12, 9001);
    expect(mockReadRankedSignals).toHaveBeenCalledWith(
      'content-intelligence',
      expect.any(Array),
      expect.objectContaining({ userId: 7001, tenantId: 9001, limit: 4 }),
    );
    expect(mockGetFilmingRecommendation).toHaveBeenCalledWith(7001, [], 9001);
    expect(mockAll).toHaveBeenCalledWith(9001, 7001);
  });

  it('honors provided execution-hint collections without loading replacements', async () => {
    await expect(getNextContentExecutionHint(7001, {
      topics: [],
      deskItems: [],
      rankedSignals: [],
      filmingRecommendation: {
        date: '2026-07-29',
        score: 82,
        confidence: 'high',
        reason: 'The calendar has a protected filming block.',
        reasons: ['The calendar has a protected filming block.'],
        calendarReservationMessage: null,
      },
      pillars: [],
    })).resolves.toMatchObject({
      mode: 'film_window',
      scheduledDate: '2026-07-29',
    });

    expect(mockGetTopics).not.toHaveBeenCalled();
    expect(mockGetUnreadNotifications).not.toHaveBeenCalled();
    expect(mockReadRankedSignals).not.toHaveBeenCalled();
    expect(mockGetFilmingRecommendation).not.toHaveBeenCalled();
    expect(mockAll).not.toHaveBeenCalled();
  });

  it('falls back to a reaction window when nothing is publish-ready', async () => {
    const hint = await getNextContentExecutionHint(7001, {
      topics: [],
      deskItems: [],
      rankedSignals: [
        {
          type: 'reaction_opportunity',
          title: 'Creators are debating carb myths again',
          summary: 'This angle is gaining speed and still has room for a fast response.',
          priority: 'urgent',
          relevanceScore: 0.94,
          confidence: 0.82,
        },
      ],
      filmingRecommendation: null,
      pillars: [],
    });

    expect(hint).toMatchObject({
      mode: 'reaction_window',
      title: 'Creators are debating carb myths again',
      confidence: 'high',
      sourceType: 'reaction_opportunity',
    });
  });
});
