import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMealPlan = vi.fn();
const mockGetShoppingList = vi.fn();
const mockGetUnreadNotifications = vi.fn();
const mockGetFilmingRecommendation = vi.fn();
const mockGetTopics = vi.fn();
const mockGetUpcomingTopicCount = vi.fn();
const mockGetActiveContentPillars = vi.fn();
const mockGetContentDeskItems = vi.fn();
const mockGetNextContentExecutionHint = vi.fn();
const mockGetContentCalendar = vi.fn();
const mockGetRankedContentSignals = vi.fn();
const mockGetKnowledgeStats = vi.fn();
const mockGetVoiceDna = vi.fn();
const mockGetMonthlySummary = vi.fn();
const mockGetTaxEvents = vi.fn();
const mockGetAnnualTaxSummary = vi.fn();
const mockGetLatestByType = vi.fn();
const mockGetSubscriptionStatus = vi.fn();
const mockGetTasksDueToday = vi.fn();
const mockGetTasksDueThisWeek = vi.fn();
const mockGetOverdueTasks = vi.fn();
const mockGetPendingTasks = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();
const mockReadTrainingContextAll = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockGetLatestCompletionForPlan = vi.fn();
const mockGetEvents = vi.fn();
const mockHasWritableCalendarForUser = vi.fn();
const mockGetUserTimezoneById = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    app: {
      timezone: 'Europe/Lisbon',
    },
    garmin: {
      tokenPath: '/tmp',
    },
  },
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

vi.mock('../../src/services/cooking-chef', () => ({
  getMealPlan: (...args: unknown[]) => mockGetMealPlan(...args),
  getShoppingList: (...args: unknown[]) => mockGetShoppingList(...args),
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

vi.mock('../../src/services/content-workspace-scheduling', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-workspace-scheduling')>(
    '../../src/services/content-workspace-scheduling',
  )),
  getContentCalendar: (...args: unknown[]) => mockGetContentCalendar(...args),
}));

vi.mock('../../src/services/content-intelligence', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/content-intelligence')>(
    '../../src/services/content-intelligence',
  );
  return {
    ...actual,
    getActiveContentPillars: (...args: unknown[]) => mockGetActiveContentPillars(...args),
    getContentDeskItems: (...args: unknown[]) => mockGetContentDeskItems(...args),
    getNextContentExecutionHint: (...args: unknown[]) => mockGetNextContentExecutionHint(...args),
    getRankedContentSignals: (...args: unknown[]) => mockGetRankedContentSignals(...args),
  };
});

vi.mock('../../src/services/finance-tracker', () => ({
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getTaxEvents: (...args: unknown[]) => mockGetTaxEvents(...args),
  getAnnualTaxSummary: (...args: unknown[]) => mockGetAnnualTaxSummary(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
}));

vi.mock('../../src/services/stripe-service', () => ({
  getSubscriptionStatus: (...args: unknown[]) => mockGetSubscriptionStatus(...args),
}));

vi.mock('../../src/services/task-store/unified-task-store', () => ({
  getTasksDueToday: (...args: unknown[]) => mockGetTasksDueToday(...args),
  getTasksDueThisWeek: (...args: unknown[]) => mockGetTasksDueThisWeek(...args),
  getOverdueTasks: (...args: unknown[]) => mockGetOverdueTasks(...args),
  getPendingTasks: (...args: unknown[]) => mockGetPendingTasks(...args),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

vi.mock('../../src/services/training-signals', () => ({
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  getLatestCompletionForPlan: (...args: unknown[]) => mockGetLatestCompletionForPlan(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezoneById(...args),
}));

import {
  readContentMeshContext,
  readCookingMeshContext,
  readFinanceMeshContext,
  readSecretaryMeshContext,
  readTrainingMeshContext,
} from '../../src/services/cross-agent-learning';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

describe('mesh context scope hardening', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    [
      mockGetMealPlan,
      mockGetShoppingList,
      mockGetUnreadNotifications,
      mockGetFilmingRecommendation,
      mockGetTopics,
      mockGetUpcomingTopicCount,
      mockGetActiveContentPillars,
      mockGetContentDeskItems,
      mockGetNextContentExecutionHint,
      mockGetContentCalendar,
      mockGetRankedContentSignals,
      mockGetKnowledgeStats,
      mockGetVoiceDna,
      mockGetMonthlySummary,
      mockGetTaxEvents,
      mockGetAnnualTaxSummary,
      mockGetLatestByType,
      mockGetSubscriptionStatus,
      mockGetTasksDueToday,
      mockGetTasksDueThisWeek,
      mockGetOverdueTasks,
      mockGetPendingTasks,
      mockGetFocusBlockRecommendation,
      mockReadTrainingContextAll,
      mockGetActivePlans,
      mockGetWeeksForPlan,
      mockGetSessionsForWeek,
      mockGetWeeklyAdherence,
      mockGetLatestCompletionForPlan,
      mockGetEvents,
      mockHasWritableCalendarForUser,
      mockGetUserTimezoneById,
    ].forEach((mock) => mock.mockReset());

    mockGetUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mockGetContentCalendar.mockReturnValue({
      entries: [],
      hasMore: false,
      scheduleAuthority: {
        authority: 'secretary',
        status: 'current',
        unavailableEntryCount: 0,
      },
    });
  });

  it('keeps valid content reads on the explicit tenant and returns the exact owned mesh values', async () => {
    const unreadNotifications = [{ id: 11 }, { id: 12 }];
    const deskItems = [{ id: 21, title: 'Ready draft' }];
    const monitoredPillars = [{ id: 31, name: 'Product' }];
    const recentSignals = [{ id: 41, type: 'trend', title: 'Signal' }];

    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockReturnValue(unreadNotifications);
    mockGetContentDeskItems.mockReturnValue(deskItems);
    mockGetActiveContentPillars.mockReturnValue(monitoredPillars);
    mockGetRankedContentSignals.mockReturnValue(recentSignals);
    mockGetUpcomingTopicCount.mockReturnValue(3);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context).toMatchObject({
      userId: 42,
      availability: 'available',
      unavailableSections: [],
      upcomingTopicCount: 3,
      unreadNotifications,
      deskItems,
      monitoredPillars,
      recentSignals,
      deadlines: [],
      workSchedule: {
        authority: 'secretary',
        authorityStatus: 'current',
        planStatus: 'unplanned',
        confirmedBlocks: [],
        attentionCount: 0,
      },
    });
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith(42, 10, 91);
    expect(mockGetContentDeskItems).toHaveBeenCalledWith(42, 4, 91);
    expect(mockGetActiveContentPillars).toHaveBeenCalledWith(42, 91);
    expect(mockGetUpcomingTopicCount).toHaveBeenCalledWith(42, 14, 91);
  });

  it('uses the request clock and timezone for Content local-week expiry', async () => {
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(1);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      timezone: 'America/Los_Angeles',
      referenceNow: '2026-04-13T06:30:00.000Z',
    });

    expect(context.weekStart).toBe('2026-04-06');
    expect(context.weekEnd).toBe('2026-04-12');
    expect(context.derivedSignals).toEqual([]);
    expect(context.deadlines).toEqual([]);
  });

  it('marks the Content work schedule partial when the bounded calendar projection truncates', async () => {
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(0);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    mockGetContentCalendar.mockReturnValue({
      entries: [],
      hasMore: true,
      scheduleAuthority: {
        authority: 'secretary',
        status: 'current',
        unavailableEntryCount: 0,
      },
    });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context.workSchedule).toMatchObject({
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
      confirmedBlocks: [],
      confirmedBlocksComplete: false,
    });
  });

  it('uses exact empty content fallbacks when tenant-owned readers throw', async () => {
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockImplementation(() => {
      throw new Error('notification read failed');
    });
    mockGetContentDeskItems.mockImplementation(() => {
      throw new Error('desk read failed');
    });
    mockGetActiveContentPillars.mockImplementation(() => {
      throw new Error('pillar read failed');
    });
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockImplementation(() => {
      throw new Error('topic count failed');
    });
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    mockGetContentCalendar.mockImplementation(() => {
      throw new Error('calendar projection failed');
    });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context.unreadNotifications).toEqual([]);
    expect(context.deskItems).toEqual([]);
    expect(context.monitoredPillars).toEqual([]);
    expect(context.upcomingTopicCount).toBe(0);
    expect(context.availability).toBe('partial');
    expect(context.unavailableSections).toEqual(expect.arrayContaining([
      'notifications',
      'content_desk',
      'pillars',
      'topic_count',
      'calendar',
      'next_execution',
    ]));
    expect(mockGetNextContentExecutionHint).not.toHaveBeenCalled();
    expect(context.workSchedule).toMatchObject({
      authority: 'secretary',
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
      confirmedBlocks: [],
    });
  });

  it('keeps an unavailable Secretary calendar projection unavailable even when a recommendation exists', async () => {
    mockGetFilmingRecommendation.mockResolvedValue({
      date: '2026-04-15',
      localizedReason: 'A possible window exists.',
      localizedConfidenceLabel: 'Medium confidence',
    });
    mockGetUnreadNotifications.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(0);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    mockGetContentCalendar.mockImplementation(() => {
      throw new Error('calendar projection unavailable');
    });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context.workSchedule).toMatchObject({
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
      confirmedBlocks: [],
    });
  });

  it('maps offset timestamps, ignores terminal blocks, and keeps cancellation attention unplanned', async () => {
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(1);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    mockGetContentCalendar.mockReturnValue({
      entries: [
        {
          kind: 'deadline',
          meaning: 'target_date_not_publication',
          startsAt: '2026-04-12T23:30:00.000Z',
          endsAt: null,
          item: { id: 110, title: 'Monday local target', status: 'active' },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-13T09:00:00.000+01:00',
          endsAt: '2026-04-13T10:00:00.000+01:00',
          workKind: 'edit',
          item: { id: 111, title: 'Completed edit', status: 'active' },
          schedule: {
            state: 'completed',
            authority: 'secretary',
            authorityStatus: 'current',
            recoverable: false,
            contentChangedSinceScheduling: false,
          },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-15T09:00:00.000+01:00',
          endsAt: '2026-04-15T10:00:00.000+01:00',
          workKind: 'record',
          item: { id: 113, title: 'Cancellation needs attention', status: 'active' },
          schedule: {
            state: 'cancel_failed',
            authority: 'secretary',
            authorityStatus: 'current',
            recoverable: true,
            contentChangedSinceScheduling: false,
          },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-14T09:00:00.000+01:00',
          endsAt: '2026-04-14T10:00:00.000+01:00',
          workKind: 'review',
          item: { id: 112, title: 'Cancelled review', status: 'active' },
          schedule: {
            state: 'cancelled',
            authority: 'secretary',
            authorityStatus: 'current',
            recoverable: false,
            contentChangedSinceScheduling: false,
          },
        },
      ],
      scheduleAuthority: {
        authority: 'secretary',
        status: 'current',
        unavailableEntryCount: 0,
      },
    });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context.deadlines).toEqual([
      expect.objectContaining({ itemId: 110, date: '2026-04-13' }),
    ]);
    expect(context.workSchedule).toEqual({
      authority: 'secretary',
      authorityStatus: 'current',
      planStatus: 'unplanned',
      semantics: 'private_work_session',
      confirmedBlocks: [],
      confirmedBlocksComplete: true,
      attentionCount: 1,
    });
  });

  it('keeps deadlines advisory and only projects current Secretary-confirmed private work blocks', async () => {
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUnreadNotifications.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(2);
    mockGetTopics.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetVoiceDna.mockReturnValue([]);
    mockGetKnowledgeStats.mockReturnValue({ categories: [], referenceChannels: 0 });
    mockGetContentCalendar.mockReturnValue({
      entries: [
        {
          kind: 'deadline',
          meaning: 'target_date_not_publication',
          startsAt: '2026-04-15T17:00:00.000Z',
          endsAt: null,
          item: { id: 101, title: 'Advisory target', status: 'approved' },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-16T09:00:00.000Z',
          endsAt: '2026-04-16T10:30:00.000Z',
          workKind: 'record',
          item: {
            id: 102,
            title: 'Record the piece',
            status: 'scripted',
            nextAction: {
              action: 'submit_for_review',
              label: 'Submit the script for review',
              reason: 'Approval is required before the next stage.',
            },
          },
          schedule: {
            state: 'provider_synced',
            authority: 'secretary',
            authorityStatus: 'current',
            visibleTitle: 'Record the piece',
            contentChangedSinceScheduling: false,
          },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-18T09:00:00.000Z',
          endsAt: '2026-04-18T10:00:00.000Z',
          workKind: 'record',
          item: {
            id: 104,
            title: 'Locally confirmed provider failure',
            status: 'approved',
            nextAction: {
              action: 'prepare_scheduled_work',
              label: 'Prepare the confirmed recording block',
              reason: 'The item is approved and the local block remains current.',
            },
          },
          schedule: {
            state: 'sync_failed',
            authority: 'secretary',
            authorityStatus: 'current',
            visibleTitle: 'Prepare the confirmed recording block',
            recoverable: true,
            contentChangedSinceScheduling: false,
          },
        },
        {
          kind: 'work_block',
          meaning: 'private_work_time_not_publication',
          startsAt: '2026-04-17T09:00:00.000Z',
          endsAt: '2026-04-17T10:00:00.000Z',
          workKind: 'edit',
          item: { id: 103, title: 'Unavailable edit block', status: 'editing' },
          schedule: {
            state: 'sync_failed',
            authority: 'secretary',
            authorityStatus: 'unavailable',
            recoverable: true,
            contentChangedSinceScheduling: false,
          },
        },
      ],
      scheduleAuthority: {
        authority: 'secretary',
        status: 'partially_unavailable',
        unavailableEntryCount: 1,
      },
    });

    const context = await readContentMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(context.deadlines).toEqual([
      expect.objectContaining({
        itemId: 101,
        date: '2026-04-15',
        semantics: 'target_date_not_publication',
      }),
    ]);
    expect(context.workSchedule).toMatchObject({
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
      confirmedBlocksComplete: true,
      attentionCount: 2,
      confirmedBlocks: [
        expect.objectContaining({
          itemId: 102,
          state: 'provider_synced',
          authorityStatus: 'current',
          semantics: 'private_work_session',
          itemStatus: 'scripted',
          outcome: 'Planned outcome: complete a recording session for "Record the piece".',
          estimatedEffortMinutes: 90,
          dependency: null,
          approvalState: 'not_required',
        }),
        expect.objectContaining({
          itemId: 104,
          state: 'sync_failed',
          authorityStatus: 'current',
          semantics: 'private_work_session',
          itemStatus: 'approved',
          outcome: 'Planned outcome: complete a recording session for "Locally confirmed provider failure".',
          estimatedEffortMinutes: 60,
          dependency: null,
          approvalState: 'approved',
        }),
      ],
    });
    expect(context.derivedSignals).toEqual([]);
  });

  it('fails closed for a valid user when the Content tenant scope is missing', async () => {
    const context = await readContentMeshContext({
      userId: 42,
      weekStart: '2026-04-13',
    });

    expect(context).toMatchObject({
      userId: 42,
      availability: 'unavailable',
      upcomingTopicCount: 0,
      deadlines: [],
      workSchedule: {
        authorityStatus: 'unavailable',
        planStatus: 'unavailable',
        confirmedBlocks: [],
      },
    });
    expect(mockGetUnreadNotifications).not.toHaveBeenCalled();
    expect(mockGetContentCalendar).not.toHaveBeenCalled();
    expect(mockGetNextContentExecutionHint).not.toHaveBeenCalled();
  });

  it('fails closed for invalid user scope across all mesh readers and records anomalies', async () => {
    const [training, cooking, content, secretary, finance] = await Promise.all([
      readTrainingMeshContext({ userId: 0, weekStart: '2026-04-13' }),
      readCookingMeshContext({ userId: 0, weekStart: '2026-04-13' }),
      readContentMeshContext({ userId: 0, weekStart: '2026-04-13' }),
      readSecretaryMeshContext({ userId: 0, weekStart: '2026-04-13' }),
      readFinanceMeshContext({ userId: 0, weekStart: '2026-04-13' }),
    ]);

    expect(training).toMatchObject({
      userId: 0,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      activePlan: null,
      activeWeek: null,
      sessions: [],
      coachBriefing: null,
      adherence: null,
      derivedSignals: [],
    });
    expect(training.trainingContext.flags).toMatchObject({
      lowSleep: false,
      lowHrv: false,
      lowReadiness: false,
      highLegLoad: false,
      highShoulderLoad: false,
      raceThisWeek: false,
      lowAdherence: false,
      highAdherence: false,
      planDrift: false,
      otherSportRpeToday: 0,
    });

    expect(cooking).toMatchObject({
      userId: 0,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      meals: [],
      shoppingList: null,
      derivedSignals: [],
    });
    expect(content).toMatchObject({
      userId: 0,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      upcomingTopicCount: 0,
      deadlines: [],
      workSchedule: {
        authority: 'secretary',
        authorityStatus: 'unavailable',
        planStatus: 'unavailable',
        confirmedBlocks: [],
      },
      filmingRecommendation: null,
      unreadNotifications: [],
      voiceDnaEntries: [],
      knowledgeStats: { categories: [], referenceChannels: 0 },
      derivedSignals: [],
    });
    expect(secretary).toMatchObject({
      userId: 0,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      events: [],
      focusBlock: null,
      dueToday: [],
      dueThisWeek: [],
      overdue: [],
      pending: [],
      writableCalendar: false,
      derivedSignals: [],
    });
    expect(finance).toMatchObject({
      userId: 0,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      month: '2026-04',
      taxEvents: [],
      derivedSignals: [],
    });
    expect(finance.subscription).toMatchObject({
      plan: 'free',
      status: 'inactive',
      provider: 'none',
      isActive: false,
      isPro: false,
    });

    expect(mockReadTrainingContextAll).not.toHaveBeenCalled();
    expect(mockGetActivePlans).not.toHaveBeenCalled();
    expect(mockGetMealPlan).not.toHaveBeenCalled();
    expect(mockGetUnreadNotifications).not.toHaveBeenCalled();
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(mockGetMonthlySummary).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'mesh_context', operation: 'read_training_mesh_context', userId: 0 }),
        expect.objectContaining({ layer: 'mesh_context', operation: 'read_cooking_mesh_context', userId: 0 }),
        expect.objectContaining({ layer: 'mesh_context', operation: 'read_content_mesh_context', userId: 0 }),
        expect.objectContaining({ layer: 'mesh_context', operation: 'read_secretary_mesh_context', userId: 0 }),
        expect.objectContaining({ layer: 'mesh_context', operation: 'read_finance_mesh_context', userId: 0 }),
      ]),
    );
  });
});
