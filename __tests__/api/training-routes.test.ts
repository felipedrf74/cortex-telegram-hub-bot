import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGenerateCoachBriefing = vi.fn();
const mockApplyCoachRecommendations = vi.fn();
const mockGetLatestByType = vi.fn();
const mockDeleteReportsByType = vi.fn();
const mockGetEvents = vi.fn();
const mockCreateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockGetActivePlan = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetCurrentWeek = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeksForPlan = vi.fn();
// Hardening 2026-04-21: /training/complete + /skip now verify session
// ownership via getSessionById + getPlanById before mutating. Tests
// that exercise those routes need these mocks in place.
const mockGetSessionById = vi.fn();
const mockGetPlanById = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockCreatePlan = vi.fn();
const mockCreateWeek = vi.fn();
const mockCreateSession = vi.fn();
const mockLinkSessionToCalendar = vi.fn();
const mockMarkSessionSkipped = vi.fn();
const mockUpdateSession = vi.fn();
const mockUpdatePlanStatus = vi.fn();
const mockDeletePlanHard = vi.fn();
const mockGetProfile = vi.fn();
const mockGetMissingProfileFields = vi.fn();
const mockGetQuestionnaire = vi.fn();
const mockBuildCoachKernelTrainingPlan = vi.fn();
const mockCalculateReadiness = vi.fn();
const mockBuildSharedDecisionContext = vi.fn();
const mockInvalidateSharedDecisionContextCache = vi.fn();
const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();
const mockSetLastCoachState = vi.fn();
const mockClearLastCoachState = vi.fn();
const mockClearStoredPlansForAthlete = vi.fn();
const mockGetStoredPlanCoveringDate = vi.fn();
const mockLoggerError = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockInvalidateCalendarCaches = vi.fn();
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
  deleteReportsByType: (...args: unknown[]) => mockDeleteReportsByType(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
}));

vi.mock('../../src/services/calendar-cache-invalidator', () => ({
  invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getCurrentWeek: (...args: unknown[]) => mockGetCurrentWeek(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  getPlanById: (...args: unknown[]) => mockGetPlanById(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  createWeek: (...args: unknown[]) => mockCreateWeek(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
  markSessionSkipped: (...args: unknown[]) => mockMarkSessionSkipped(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  updatePlanStatus: (...args: unknown[]) => mockUpdatePlanStatus(...args),
  deletePlanHard: (...args: unknown[]) => mockDeletePlanHard(...args),
}));

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/training-coach-kernel-plan-generator', () => ({
  buildCoachKernelTrainingPlan: (...args: unknown[]) => mockBuildCoachKernelTrainingPlan(...args),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: (...args: unknown[]) => mockBuildSharedDecisionContext(...args),
  invalidateSharedDecisionContextCache: (...args: unknown[]) => mockInvalidateSharedDecisionContextCache(...args),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  setLastCoachState: (...args: unknown[]) => mockSetLastCoachState(...args),
  clearLastCoachState: (...args: unknown[]) => mockClearLastCoachState(...args),
}));

vi.mock('../../src/services/coach-plan-registry', () => ({
  clearStoredPlansForAthlete: (...args: unknown[]) => mockClearStoredPlansForAthlete(...args),
  getStoredPlanCoveringDate: (...args: unknown[]) => mockGetStoredPlanCoveringDate(...args),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: (...args: unknown[]) => mockBuildActiveSignalsResponse(...args),
}));

// The route's resolveTrainingLanguage calls getUserLanguage when no
// x-language header is present. Mocking here keeps the test from
// hitting the real database resolver (which is unmocked in this file).
vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { looksLikeTrainingCalendarEvent, trainingRoutes } from '../../src/api/routes/training';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { return r; },
  };
  return r;
}

function makeKernelPlan(weeks?: Array<Record<string, any>>) {
  return {
    planName: 'Coach Kernel Plan',
    sport: 'running',
    periodization: 'block',
    weeks: weeks ?? [
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Tuesday',
            sessionType: 'run',
            title: 'Easy Run',
            durationMinutes: 45,
            description: 'Easy aerobic run.',
            exercises: [],
          },
        ],
      },
    ],
  };
}

function mockReq(
  method: string,
  path: string,
  query: Record<string, any> = {},
  body?: any,
  userId = 12,
  headers: Record<string, string> = {},
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    body,
    userId,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  query: Record<string, any> = {},
  body?: any,
  userId = 12,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = trainingRoutes();
  const req = mockReq(method, path, query, body, userId, headers);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Training API routes', () => {
  beforeEach(async () => {
    // Hardening audit 2026-04-20: reset the new calendar-lookup
    // coalescing cache between tests so a prior test's mocked
    // `getEvents` response doesn't leak into the next (the cache has
    // a 2s TTL — fast enough to bleed across vitest's sequential
    // tests).
    const trainingMod: any = await import('../../src/api/routes/training');
    if (typeof trainingMod._resetCalendarLookupCoalesceForTests === 'function') {
      trainingMod._resetCalendarLookupCoalesceForTests();
    }

    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGenerateCoachBriefing.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockGetLatestByType.mockReset();
    mockDeleteReportsByType.mockReset();
    mockGetEvents.mockReset();
    mockCreateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockGetActivePlan.mockReset();
    mockGetActivePlans.mockReset();
    mockGetCurrentWeek.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionById.mockReset();
    mockGetPlanById.mockReset();
    mockGetWeeklyAdherence.mockReset();
    mockCreatePlan.mockReset();
    mockCreateWeek.mockReset();
    mockCreateSession.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockMarkSessionSkipped.mockReset();
    mockUpdateSession.mockReset();
    mockUpdatePlanStatus.mockReset();
    mockDeletePlanHard.mockReset();
    mockDeletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 0,
      removedSessions: 0,
      removedCompletions: 0,
    });
    mockGetProfile.mockReset();
    mockGetMissingProfileFields.mockReset();
    mockGetQuestionnaire.mockReset();
    mockBuildCoachKernelTrainingPlan.mockReset();
    mockCalculateReadiness.mockReset();
    mockBuildSharedDecisionContext.mockReset();
    mockInvalidateSharedDecisionContextCache.mockReset();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
    mockClearLastCoachState.mockReset();
    mockClearStoredPlansForAthlete.mockReset();
    mockGetStoredPlanCoveringDate.mockReset();
    mockLoggerError.mockReset();
    mockBuildActiveSignalsResponse.mockReset();
    mockInvalidateCalendarCaches.mockReset();
    mockIsUserOverDailyCap.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue(null);
    mockDeleteReportsByType.mockReturnValue(0);
    mockClearStoredPlansForAthlete.mockReturnValue(0);
    mockGetStoredPlanCoveringDate.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([]);
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
    mockDeleteEvent.mockResolvedValue(undefined);
    mockGetActivePlan.mockReturnValue(null);
    mockGetActivePlans.mockReturnValue([]);
    mockGetCurrentWeek.mockReturnValue(null);
    mockGetSessionsForWeek.mockReturnValue([]);
    mockGetWeeksForPlan.mockReturnValue([]);
    mockGetWeeklyAdherence.mockReturnValue({ adherenceRate: 0 });
    mockCreatePlan.mockReturnValue({ id: 901 });
    mockCreateWeek.mockImplementation(({ week_number }: any) => ({ id: 1000 + Number(week_number || 1) }));
    let sessionCounter = 0;
    mockCreateSession.mockImplementation(() => ({ id: 2000 + (++sessionCounter) }));
    mockLinkSessionToCalendar.mockReturnValue(undefined);
    mockMarkSessionSkipped.mockReturnValue(true);
    mockUpdateSession.mockReturnValue(true);
    mockUpdatePlanStatus.mockReturnValue(true);
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([]);
    mockGetQuestionnaire.mockImplementation((id: string) => ({
      id,
      title: id,
      description: '',
      steps: [],
    }));
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan());
    mockCalculateReadiness.mockResolvedValue({
      score: 74,
      factors: {
        hrv: { trend: 'stable' },
        sleep: { score: 76, qualityScore: 76 },
        bodyBattery: { current: 68 },
        trainingLoad: { acwr: 0.92 },
      },
      recommendation: 'reduce_10pct',
      reasoning: 'Metrics look acceptable but not peak — moderate effort recommended.',
    });
    mockBuildSharedDecisionContext.mockResolvedValue('<shared_decision_context domain="triathlon">training spend mode is selective</shared_decision_context>');
    mockReadTrainingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadCookingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadContentMeshContext.mockResolvedValue({ filmingRecommendation: null, derivedSignals: [] });
    mockReadSecretaryMeshContext.mockResolvedValue({ focusBlock: null, derivedSignals: [] });
    mockSetLastCoachState.mockReset();
    mockBuildActiveSignalsResponse.mockReturnValue({
      userId: 12,
      timestamp: '2026-04-19T00:00:00.000Z',
      counts: { total: 0, urgent: 0 },
      flags: {
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
      },
      signals: [],
    });
    clearTenantScopeAnomaliesForTests();
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGenerateCoachBriefing.mockResolvedValue({
      message: 'Coach ready.',
      recommendations: [],
      garminData: null,
    });
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 1,
      appliedRecommendations: [{ id: 'rec-1', applied: true }],
    });
  });

  it('returns a cache-only miss without triggering a new coach generation', async () => {
    const res = await dispatch('GET', '/coach', { cacheOnly: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.cachedOnlyMiss).toBe(true);
    expect(res.body.data.briefing).toBe('');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('returns render-ready training home state without triggering a fresh coach generation', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 44,
      name: 'Maratona',
      start_date: '2026-04-13',
      periodization: 'build',
    });
    mockGetCurrentWeek.mockReturnValue({ id: 78, week_number: 1, focus: 'build' });
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 321,
        day_of_week: 'Sunday',
        session_type: 'run',
        title: 'Long Run',
        duration_minutes: 90,
        status: 'planned',
      },
      {
        id: 322,
        day_of_week: 'Monday',
        session_type: 'recovery',
        title: 'Recovery',
        duration_minutes: 35,
        status: 'planned',
      },
    ]);
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'coach-briefing:12') {
        return {
          briefing: 'Cached coach briefing',
          recommendations: [],
          degraded: false,
          cachedOnlyMiss: false,
        };
      }
      return null;
    });
    mockBuildActiveSignalsResponse.mockReturnValue({
      userId: 12,
      timestamp: '2026-04-19T00:00:00.000Z',
      counts: { total: 1, urgent: 1 },
      flags: {
        lowSleep: true,
        lowHrv: false,
        lowReadiness: false,
        highLegLoad: false,
        highShoulderLoad: false,
        raceThisWeek: false,
        lowAdherence: false,
        highAdherence: false,
        planDrift: false,
        otherSportRpeToday: 0,
      },
      signals: [
        {
          id: 99,
          type: 'low_sleep',
          title: 'Low sleep',
          summary: 'score 55 — coach will downgrade today',
          priority: 'urgent',
          source: 'garmin.sync',
          createdAt: '2026-04-18T22:00:00.000Z',
          expiresAt: '2026-04-19T22:00:00.000Z',
          payload: { score: 55, total_hours: 5.8 },
        },
      ],
    });

    const res = await dispatch('GET', '/home');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.hero.state).toBe('recovery');
    expect(res.body.data.hero.primaryAction.target).toBe('completeSession');
    expect(res.body.data.reasoning.signals[0].title).toBeTruthy();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('returns an empty week when there is no active plan even if calendar still has training-looking events', async () => {
    mockGetActivePlan.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-training',
        subject: '🏃 Easy Run — 30 min Zone 2',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
    ]);

    const res = await dispatch('GET', '/week');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.plan).toBeNull();
    expect(res.body.data.sessions).toEqual([]);
    expect(res.body.data.totalCount).toBe(0);
  });

  it('classifies training home as no-plan when only a standalone calendar workout exists', async () => {
    mockGetActivePlan.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-training',
        subject: '🧘 Rest Day — Mobility + Recovery (NO TRAINING)',
        start: '2026-04-19T08:00:00.000Z',
        end: '2026-04-19T08:30:00.000Z',
      },
    ]);

    const res = await dispatch('GET', '/home');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.hero.state).toBe('noPlan');
    expect(res.body.data.hero.primaryAction.target).toBe('createPlan');
    expect(res.body.data.weekJourney).toBeNull();
    expect(res.body.data.weekProtection).toBeNull();
    expect(res.body.data.emptyState?.action.target).toBe('createPlan');
  });

  it('surfaces wearable integration gaps honestly in the training home contract', async () => {
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'readiness:12') {
        return {
          score: 60,
          factors: {
            sleepScore: 60,
            hrvStatus: 'stable',
            bodyBattery: 0,
          },
          recommendation: 'Decent recovery. Train at moderate intensity.',
          reasonCode: 'WEARABLE_INTEGRATION_MISSING',
        };
      }
      return null;
    });

    const res = await dispatch('GET', '/home');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.meta.isPartial).toBe(true);
    expect(res.body.data.meta.reasonCodes).toContain('WEARABLE_INTEGRATION_MISSING');
  });

  it('localizes the cardio progression validation error for Portuguese requests', async () => {
    const res = await dispatch(
      'GET',
      '/progression/cardio',
      { sport: 'swimming' },
      undefined,
      12,
      { 'x-language': 'pt-BR' },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('o parâmetro sport deve ser "running" ou "cycling"');
  });

  it('restores the cached coach briefing from the latest coach report document', async () => {
    mockGetLatestByType.mockReturnValue({
      createdAt: new Date().toISOString(),
      summary: 'Automatic coach update ready.',
      documentJson: {
        message: 'Automatic coach update ready.',
        recommendations: [
          {
            action: 'MODIFY',
            eventId: 'evt-1',
            source: 'outlook',
            originalTitle: 'Track workout',
            newTitle: 'Easy run 30min',
            newStart: '2026-04-16T17:30:00Z',
            newEnd: '2026-04-16T18:00:00Z',
            summary: 'Move the quality work to tomorrow evening.',
          },
        ],
        readiness: {
          factors: {
            sleep: { score: 74 },
            bodyBattery: { score: 61 },
          },
        },
        errors: ['Garmin sync was unavailable.'],
      },
    });

    const res = await dispatch('GET', '/coach', { cacheOnly: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.briefing).toBe('Automatic coach update ready.');
    expect(res.body.data.restoredFromReport).toBe(true);
    expect(res.body.data.garminData).toEqual({
      sleepScore: 74,
      bodyBattery: 61,
      steps: null,
      activeMinutes: null,
    });
    expect(res.body.data.recommendations).toHaveLength(1);
    expect(res.body.data.recommendations[0].reason).toBe('Move the quality work to tomorrow evening.');
    expect(res.body.data.warnings).toEqual(['Garmin sync was unavailable.']);
    expect(res.body.data.cachedOnlyMiss).toBeUndefined();
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetLastCoachState).toHaveBeenCalledWith(
      12,
      [
        expect.objectContaining({
          action: 'MODIFY',
          eventId: 'evt-1',
          reason: 'Move the quality work to tomorrow evening.',
        }),
      ],
      'Automatic coach update ready.',
    );
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('fails closed on invalid tenant scope before restoring a cached coach report', async () => {
    mockGetLatestByType.mockReturnValue({
      createdAt: new Date().toISOString(),
      summary: 'Should not be used.',
      documentJson: {
        message: 'Should not be used.',
        recommendations: [],
      },
    });

    const res = await dispatch('GET', '/coach', { cacheOnly: 'true' }, undefined, 0);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.cachedOnlyMiss).toBe(true);
    expect(mockGetLatestByType).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'restore_coach_briefing_from_report',
          reason: 'invalid_user_scope',
          userId: 0,
          details: { reportType: 'coach_briefing' },
        }),
      ]),
    );
  });

  // Regression test — /coach/apply must clear the same coach briefing
  // and readiness caches that /complete already clears. Without this,
  // applying a recommendation only invalidates planning caches, so
  // the next GET /coach read serves the pre-apply briefing and users
  // see the same recommendation they just accepted.
  it('clears coach + training + readiness caches after applying recommendations', async () => {
    const res = await dispatch(
      'POST',
      '/coach/apply',
      {},
      { recommendationIds: ['rec-1'] },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.applied).toBe(1);
    expect(mockApplyCoachRecommendations).toHaveBeenCalledWith(12, ['rec-1']);

    const clearedKeys = mockClearCache.mock.calls.map((call) => call[0]);
    expect(clearedKeys).toEqual(
      expect.arrayContaining([
        'coach-briefing:12',
        'training-summary:12',
        'readiness:12',
        'dashboard-readiness:12',
      ]),
    );
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:12:');
  });

  it('sanitizes degraded coach warnings when briefing generation fails', async () => {
    mockGenerateCoachBriefing.mockRejectedValueOnce(new Error('upstream garmin timeout: tenant=12'));

    const res = await dispatch('GET', '/coach');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.degraded).toBe(true);
    expect(res.body.data.warnings).toEqual(['Coach briefing unavailable.']);
    expect(JSON.stringify(res.body)).not.toContain('upstream garmin timeout');
  });

  it('falls back to deterministic coach copy when AI coach generation fails but a plan exists', async () => {
    mockGenerateCoachBriefing.mockRejectedValueOnce(new Error('upstream garmin timeout: tenant=12'));
    mockGetActivePlan.mockReturnValue({
      id: 44,
      name: 'Hybrid build',
      start_date: '2026-04-20',
      periodization: 'build',
    });
    mockGetCurrentWeek.mockReturnValue({ id: 78, week_number: 1, focus: 'base' });
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 101,
        day_of_week: 'Monday',
        title: 'Easy Run',
        session_type: 'recovery_run',
        duration_minutes: 36,
        status: 'planned',
        description: 'Easy aerobic run',
      },
    ]);

    const res = await dispatch('GET', '/coach', {}, undefined, 12, { 'x-language': 'pt-BR' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.degraded).toBe(false);
    expect(res.body.data.deterministicFallback).toBe(true);
    expect(res.body.data.briefing).toContain('Leitura rápida do coach');
    expect(JSON.stringify(res.body)).not.toContain('upstream garmin timeout');
  });

  it('keeps coach/apply failures generic for the client while preserving the route code', async () => {
    mockApplyCoachRecommendations.mockRejectedValueOnce(new Error('calendar mutation failed for user 12'));

    const res = await dispatch(
      'POST',
      '/coach/apply',
      {},
      { recommendationIds: ['rec-1'] },
    );

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('COACH_APPLY_FAILED');
    expect(res.body.error.message).toBe('Failed to apply coach recommendations');
    expect(JSON.stringify(res.body)).not.toContain('calendar mutation failed');
  });

  it('treats training completion without an active session as a soft success', async () => {
    mockGetActivePlan.mockReturnValue(null);

    const res = await dispatch('POST', '/complete', {}, { sessionId: 'today' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      completed: true,
      weeklyAdherence: null,
      noActiveSession: true,
    });
  });

  it('returns 402 on plan generation when the user is over quota', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
    });

    expect(res.statusCode).toBe(402);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('requires the running questionnaire before generating a marathon plan', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate' };
      return null;
    });
    mockGetQuestionnaire.mockImplementation((id: string) => {
      if (id === 'triathlon-running') {
        return {
          id,
          title: 'Running Profile',
          description: 'Running onboarding',
          steps: [],
        };
      }
      return {
        id,
        title: id,
        description: '',
        steps: [],
      };
    });
    mockGetMissingProfileFields.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'triathlon-running') {
        return [
          { key: 'target_race', prompt: 'What is your next target race?' },
          { key: 'target_race_date', prompt: 'Target race date' },
        ];
      }
      return [];
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Porto Marathon November 2026',
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.needsProfile).toBe(true);
    expect(res.body.data.requiredQuestionnaireId).toBe('triathlon-running');
    expect(res.body.data.requiredQuestionnaireTitle).toContain('Running');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('schedules same-day run and gym sessions at separate preferred times', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      if (profile === 'triathlon-running') return { target_race: 'Marathon' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan([
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Monday',
            sessionType: 'run',
            title: 'Base Run',
            durationMinutes: 50,
            description: 'Morning aerobic run.',
            exercises: [],
          },
          {
            dayOfWeek: 'Monday',
            sessionType: 'gym',
            title: 'Runner Strength',
            durationMinutes: 40,
            description: 'Lunch strength session.',
            exercises: [],
          },
        ],
      },
    ]));

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Marathon build',
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 2,
    });

    expect(res.statusCode).toBe(201);
    const createdEvents = mockCreateEvent.mock.calls.map((call) => call[0]);
    const runEvent = createdEvents.find((event) => String(event.title).includes('Base Run'));
    const gymEvent = createdEvents.find((event) => String(event.title).includes('Runner Strength'));

    expect(runEvent).toBeTruthy();
    expect(gymEvent).toBeTruthy();

    const runStart = new Date(String(runEvent.start));
    const gymStart = new Date(String(gymEvent.start));
    expect(runStart.toDateString()).toBe(gymStart.toDateString());
    expect(runStart.getTime()).toBeLessThan(gymStart.getTime());
    expect((gymStart.getTime() - runStart.getTime()) / 60000).toBeGreaterThanOrEqual(300);
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(12);
  });

  it('marks a session as skipped and returns updated weekly adherence', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12 });
    mockGetCurrentWeek.mockReturnValue({ id: 78 });
    mockGetSessionsForWeek.mockReturnValue([
      { id: 321, day_of_week: new Date().toLocaleDateString('en-US', { weekday: 'long' }), status: 'pending', plan_id: 44 },
    ]);
    // Hardening 2026-04-21: ownership gate reads these.
    mockGetSessionById.mockReturnValue({ id: 321, plan_id: 44 });
    mockGetPlanById.mockReturnValue({ id: 44, user_id: 12 });
    mockGetWeeklyAdherence.mockReturnValue({ adherenceRate: 40 });

    const res = await dispatch('POST', '/skip', {}, { sessionId: 'today' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.skipped).toBe(true);
    expect(res.body.data.weeklyAdherence).toBe(0.4);
    expect(mockMarkSessionSkipped).toHaveBeenCalledWith(321);
  });

  it('rejects /skip with 403 when the session id belongs to a different user', async () => {
    // Hardening 2026-04-21: Alice (userId=12) must not be able to
    // skip Bob's session by POSTing Bob's session id. Previously
    // the route called markSessionSkipped(rowId) without any plan
    // ownership check — this test pins the new enforcement.
    mockGetSessionById.mockReturnValue({ id: 999, plan_id: 88 });
    mockGetPlanById.mockReturnValue({ id: 88, user_id: 77 }); // Bob owns plan 88

    const res = await dispatch('POST', '/skip', {}, { sessionId: '999' });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
  });

  it('rejects /complete with 403 when the session id belongs to a different user', async () => {
    mockGetSessionById.mockReturnValue({ id: 999, plan_id: 88 });
    mockGetPlanById.mockReturnValue({ id: 88, user_id: 77 });

    const res = await dispatch('POST', '/complete', {}, { sessionId: '999' });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('applies cross-skill coaching coordination before training sessions are stored', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') {
        return { experienceLevel: 'Beginner (< 1 year)', available_equipment: 'Full gym', injuries: 'left knee irritation' };
      }
      if (profile === 'triathlon-running') {
        return { recentRace: '10k', preferredRunsPerWeek: 4, injury_history: 'achilles flare-up' };
      }
      return null;
    });
    mockReadTrainingMeshContext.mockResolvedValue({
      derivedSignals: [
        {
          signalType: 'recovery_state',
          payload: { state: 'strained' },
        },
      ],
    });
    mockReadCookingMeshContext.mockResolvedValue({
      derivedSignals: [
        {
          signalType: 'fueling_support_status',
          payload: { status: 'at_risk' },
        },
      ],
    });
    mockReadFinanceMeshContext.mockResolvedValue({
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: { budgetMode: 'controlled', supplementMode: 'pause_new' },
        },
      ],
    });
    mockReadContentMeshContext.mockResolvedValue({
      filmingRecommendation: {
        date: '2026-04-18',
      },
      derivedSignals: [],
    });
    mockReadSecretaryMeshContext.mockResolvedValue({
      focusBlock: {
        date: '2026-04-17',
      },
      derivedSignals: [
        { signalType: 'travel_window', payload: { dates: ['2026-04-19'] } },
        { signalType: 'inbox_pressure', payload: { overdueCount: 3, dueTodayCount: 1, dueThisWeekCount: 4, pendingCount: 11 } },
      ],
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan([
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Friday',
            sessionType: 'run',
            title: 'Threshold Run',
            durationMinutes: 50,
            description: 'Threshold work.',
            exercises: [],
          },
          {
            dayOfWeek: 'Saturday',
            sessionType: 'run',
            title: 'Long Run',
            durationMinutes: 90,
            description: 'Long aerobic session.',
            exercises: [],
          },
        ],
      },
    ]));

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(201);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledTimes(1);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon October 2026',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
    }));
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12);

    const storedSessions = mockCreateSession.mock.calls.map((call) => ({
      day: String(call[0]?.day_of_week || '').toLowerCase(),
      type: call[0]?.session_type,
      title: call[0]?.title,
    }));
    expect(storedSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        day: 'friday',
        type: 'run',
        title: 'Aerobic Support / Recovery',
      }),
      expect.objectContaining({
        day: 'sunday',
        type: 'run',
        title: 'Long Run',
      }),
    ]));
  });

  it('adapts gym exercises to the available equipment before sessions are stored', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') {
        return { experienceLevel: 'intermediate', available_equipment: 'Home gym (basic)' };
      }
      if (profile === 'triathlon-gym') {
        return { equipment_access: 'Home gym (basic)' };
      }
      return null;
    });
    mockReadTrainingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadCookingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadContentMeshContext.mockResolvedValue({ filmingRecommendation: null, derivedSignals: [] });
    mockReadSecretaryMeshContext.mockResolvedValue({ focusBlock: null, derivedSignals: [] });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Gym Plan',
      sport: 'gym',
      periodization: 'block',
      weeks: [
        {
          weekNumber: 1,
          focus: 'strength',
          intensityPct: 70,
          sessions: [
            {
              dayOfWeek: 'Monday',
              sessionType: 'gym',
              title: 'Strength Session',
              durationMinutes: 55,
              description: 'Strength work.',
              exercises: [
                { name: 'Bench Press', sets: 4, reps: 8, rpe: '7-8', restSec: 90 },
                { name: 'Leg Press', sets: 3, reps: 10, rpe: '7', restSec: 90 },
              ],
            },
          ],
        },
      ],
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Build strength at home',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(201);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledTimes(1);

    const gymCreateInput = mockCreateSession.mock.calls.find((call) => call[0]?.session_type === 'gym')?.[0];
    expect(gymCreateInput).toBeTruthy();
    expect(JSON.parse(gymCreateInput.exercises_json)).toEqual([
      expect.objectContaining({ name: 'DB Floor Press' }),
      expect.objectContaining({ name: 'Goblet Squat' }),
    ]);
  });

  it('falls back to the deterministic template when the coach kernel generation fails', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockImplementation(() => {
      throw new Error('kernel unavailable');
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General running consistency block',
      preferredTime: '07:00',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.fallbackTemplateUsed).toBe(true);
    expect(res.body.data.message).toContain('reliable fallback template');
    expect(mockCreatePlan).toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it('cancels an owned plan, removes linked calendar events, and hard-deletes the plan + cascades', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12 });
    mockGetWeeksForPlan.mockReturnValue([{ id: 7001 }]);
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 321,
        status: 'completed',
        calendar_event_id: 'evt-completed',
        calendar_source: 'outlook',
      },
      {
        id: 322,
        status: 'planned',
        calendar_event_id: 'evt-planned',
        calendar_source: 'google',
      },
    ]);
    mockDeletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 2,
      removedCompletions: 1,
    });

    const res = await dispatch('POST', '/plan/cancel', {}, {});

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      cancelled: true,
      planId: 44,
      removedEvents: 2,
      removedSessions: 2,
      removedWeeks: 1,
      removedCompletions: 1,
      removedPlans: 1,
      totalSessions: 2,
    });
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-completed', 'outlook', 12);
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-planned', 'google', 12);
    expect(mockDeletePlanHard).toHaveBeenCalledWith(44, 12);
    // Hard delete replaces the soft-update path; no per-session
    // status mutations or plan status mutation should fire anymore.
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockUpdatePlanStatus).not.toHaveBeenCalled();
  });

  it('ignores generic routine walk events when resolving today training from calendar', async () => {
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-routine',
        summary: 'Wake up / Prepare for walk',
        start: '2026-04-15T05:00:00.000Z',
        end: '2026-04-15T05:30:00.000Z',
      },
    ]);

    const todayRes = await dispatch('GET', '/today');
    expect(todayRes.statusCode).toBe(200);
    expect(todayRes.body.ok).toBe(true);
    expect(todayRes.body.data.session).toBeNull();
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12);

    const weekRes = await dispatch('GET', '/week');
    expect(weekRes.statusCode).toBe(200);
    expect(weekRes.body.ok).toBe(true);
    expect(weekRes.body.data.sessions).toEqual([]);
    expect(weekRes.body.data.totalCount).toBe(0);
  });


  it('recognizes explicit training events while excluding routine walk labels', () => {
    expect(looksLikeTrainingCalendarEvent('Tempo Run')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Strength Session')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Wake up / Prepare for walk')).toBe(false);
  });
});
