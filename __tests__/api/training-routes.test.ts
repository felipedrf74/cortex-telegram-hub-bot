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
const mockGetEvents = vi.fn();
const mockCreateEvent = vi.fn();
const mockGetActivePlan = vi.fn();
const mockGetCurrentWeek = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockCreatePlan = vi.fn();
const mockCreateWeek = vi.fn();
const mockCreateSession = vi.fn();
const mockLinkSessionToCalendar = vi.fn();
const mockGetProfile = vi.fn();
const mockGetMissingProfileFields = vi.fn();
const mockCompleteOneShotWithFallback = vi.fn();
const mockBuildSharedDecisionContext = vi.fn();
const mockInvalidateSharedDecisionContextCache = vi.fn();
const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();
const mockSetLastCoachState = vi.fn();
const mockLoggerError = vi.fn();
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
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  getCurrentWeek: (...args: unknown[]) => mockGetCurrentWeek(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  createWeek: (...args: unknown[]) => mockCreateWeek(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
}));

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
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
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
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
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGenerateCoachBriefing.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockGetLatestByType.mockReset();
    mockGetEvents.mockReset();
    mockCreateEvent.mockReset();
    mockGetActivePlan.mockReset();
    mockGetCurrentWeek.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetWeeklyAdherence.mockReset();
    mockCreatePlan.mockReset();
    mockCreateWeek.mockReset();
    mockCreateSession.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockGetProfile.mockReset();
    mockGetMissingProfileFields.mockReset();
    mockCompleteOneShotWithFallback.mockReset();
    mockBuildSharedDecisionContext.mockReset();
    mockInvalidateSharedDecisionContextCache.mockReset();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
    mockLoggerError.mockReset();
    mockIsUserOverDailyCap.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([]);
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
    mockGetActivePlan.mockReturnValue(null);
    mockGetCurrentWeek.mockReturnValue(null);
    mockGetSessionsForWeek.mockReturnValue([]);
    mockGetWeeklyAdherence.mockReturnValue({ adherenceRate: 0 });
    mockCreatePlan.mockReturnValue({ id: 901 });
    mockCreateWeek.mockImplementation(({ week_number }: any) => ({ id: 1000 + Number(week_number || 1) }));
    let sessionCounter = 0;
    mockCreateSession.mockImplementation(() => ({ id: 2000 + (++sessionCounter) }));
    mockLinkSessionToCalendar.mockReturnValue(undefined);
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([]);
    mockCompleteOneShotWithFallback.mockResolvedValue({ text: '{}' });
    mockBuildSharedDecisionContext.mockResolvedValue('<shared_decision_context domain="triathlon">training spend mode is selective</shared_decision_context>');
    mockReadTrainingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadCookingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadContentMeshContext.mockResolvedValue({ filmingRecommendation: null, derivedSignals: [] });
    mockReadSecretaryMeshContext.mockResolvedValue({ focusBlock: null, derivedSignals: [] });
    mockSetLastCoachState.mockReset();
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

  it('injects cross-skill coaching coordination into the training-plan prompt', async () => {
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
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify({
        planName: 'Lisbon Marathon Plan',
        sport: 'running',
        periodization: 'undulating',
        weeks: [
          {
            weekNumber: 1,
            focus: 'base',
            intensityPct: 70,
            sessions: [
              {
                dayOfWeek: 'tuesday',
                sessionType: 'run',
                title: 'Tempo Run',
                durationMinutes: 50,
                description: 'Threshold work.',
                exercises: [],
              },
              {
                dayOfWeek: 'saturday',
                sessionType: 'run',
                title: 'Long Run',
                durationMinutes: 90,
                description: 'Long aerobic session.',
                exercises: [],
              },
            ],
          },
        ],
      }),
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(201);
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledTimes(1);
    const planPrompt = mockCompleteOneShotWithFallback.mock.calls[0][1];
    expect(planPrompt).toContain('CROSS-SKILL SHARED CONTEXT');
    expect(planPrompt).toContain('COACHING COORDINATION RULES');
    expect(planPrompt).toContain('EQUIPMENT AND SUBSTITUTION RULES');
    expect(planPrompt).toContain('Start week 1 conservatively');
    expect(planPrompt).toContain('Cap truly hard sessions at 1 per week');
    expect(planPrompt).toContain('Treat the athlete like a beginner');
    expect(planPrompt).toContain('Keep week-to-week intensity jumps within 4 points');
    expect(planPrompt).toContain('Anchor the longest session on Sunday');
    expect(planPrompt).toContain('Keep Saturday lower-fatigue');
    expect(planPrompt).toContain('Avoid recommending new paid equipment');
    expect(planPrompt).toContain('Avoid back-to-back impact-heavy run days');
    expect(planPrompt).toContain('Keep lower-body strength at least one easier day away');
    expect(planPrompt).toContain('Travel is currently flagged on Sunday');
    expect(planPrompt).toContain('Bias toward modular sub-60-minute sessions');
    expect(planPrompt).toContain('Keep Friday lighter when possible');
    expect(planPrompt).toContain('Full gym access is available');
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12);
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
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: JSON.stringify({
        planName: 'Gym Plan',
        sport: 'gym',
        periodization: 'undulating',
        weeks: [
          {
            weekNumber: 1,
            focus: 'strength',
            intensityPct: 70,
            sessions: [
              {
                dayOfWeek: 'monday',
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
      }),
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Build strength at home',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(201);
    const planPrompt = mockCompleteOneShotWithFallback.mock.calls[0][1];
    expect(planPrompt).toContain('EQUIPMENT AND SUBSTITUTION RULES');
    expect(planPrompt).toContain('dumbbells, bench, kettlebells, and simple accessories only');

    const gymCreateInput = mockCreateSession.mock.calls.find((call) => call[0]?.session_type === 'gym')?.[0];
    expect(gymCreateInput).toBeTruthy();
    expect(JSON.parse(gymCreateInput.exercises_json)).toEqual([
      expect.objectContaining({ name: 'DB Floor Press' }),
      expect.objectContaining({ name: 'Goblet Squat' }),
    ]);
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
