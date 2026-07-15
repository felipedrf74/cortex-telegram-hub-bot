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
    mockAll.mockReset();
    mockGetUnreadNotifications.mockReset();
    mockReadRankedSignals.mockReset();
    mockGetFilmingRecommendation.mockReset();
    mockGetTopics.mockReset();
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
