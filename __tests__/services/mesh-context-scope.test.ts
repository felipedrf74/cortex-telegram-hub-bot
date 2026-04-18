import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMealPlan = vi.fn();
const mockGetShoppingList = vi.fn();
const mockGetUnreadNotifications = vi.fn();
const mockGetFilmingRecommendation = vi.fn();
const mockGetTopics = vi.fn();
const mockGetUpcomingTopicCount = vi.fn();
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
const mockGetEvents = vi.fn();
const mockHasWritableCalendarForUser = vi.fn();

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
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
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
      mockGetEvents,
      mockHasWritableCalendarForUser,
    ].forEach((mock) => mock.mockReset());
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
      scheduledTopics: [],
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
