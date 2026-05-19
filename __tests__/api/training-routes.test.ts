import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

let testDb: Database.Database;

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
const mockInvalidateTrainingDerivedCaches = vi.fn();
const mockReconcileOrphanedTrainingAgendaEvents = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();
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

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
  invalidateTrainingDerivedCaches: (...args: unknown[]) => mockInvalidateTrainingDerivedCaches(...args),
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
  getUserLanguageById: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/integration-status', () => ({
  isGarminActivelyIntegrated: vi.fn(() => false),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  enforceCostGuardrails: (userId: number) => {
    const quota = mockIsUserOverDailyCap(userId);
    const global = { totalUsd: 0, limitUsd: 100, exceeded: false };
    if (!quota.over) return { block: false, status: 200, reason: 'ok', quota, global };
    return {
      block: true,
      status: 429,
      reason: 'daily_limit_exceeded',
      message: `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`,
      quota,
      global,
      details: {
        plan: quota.plan,
        resetAt: quota.resetAt,
      },
    };
  },
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
  LOGGER_REDACTION_PATHS: [],
}));

// Slice 4.D — lifecycle audit module touches the real DB. Stubbed here
// for the integration-style training routes test. The lifecycle module
// itself is exercised by training-plan-lifecycle.test.ts.
vi.mock('../../src/services/training-plan-lifecycle', () => ({
  getPlanVersion: vi.fn(() => 1),
  findExistingOwnership: vi.fn(() => null),
  recordCalendarOwnership: vi.fn(() => ({ ok: true, created: true, ownershipId: 1 })),
  markCalendarOwnershipDeleted: vi.fn(() => ({ ok: true, rowsAffected: 1 })),
  findOwnershipsForPlan: vi.fn(() => []),
  findOrphanedOwnerships: vi.fn(() => []),
}));

vi.mock('../../src/services/training-calendar-scope', () => ({
  isTrainingCalendarEventUnclaimed: vi.fn(() => true),
  getTrainingCalendarEventOwners: vi.fn(() => []),
  filterCalendarEventsForTrainingScope: (events: unknown[]) => events,
}));

vi.mock('../../src/services/training-agenda-reconciliation', () => ({
  reconcileOrphanedTrainingAgendaEvents: (...args: unknown[]) => (
    mockReconcileOrphanedTrainingAgendaEvents(...args)
  ),
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
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
  tenantId = userId,
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
    // Mirror iosAuthMiddleware setting tenantId alongside userId. Tests can
    // override tenantId to cover active-tenant behavior.
    tenantId,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  query: Record<string, any> = {},
  body?: any,
  userId = 12,
  headers: Record<string, string> = {},
  tenantId = userId,
): Promise<MockRes> {
  const router = trainingRoutes();
  const req = mockReq(method, path, query, body, userId, headers, tenantId);
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

function resetTrainingOperationalEnvForTests(): void {
  delete process.env.TRAINING_ENGINE_ENABLED;
  delete process.env.TRAINING_ENGINE_DISABLED;
  delete process.env.TRAINING_PLAN_GENERATION_ENABLED;
  delete process.env.TRAINING_PLAN_GENERATION_DISABLED;
  delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
  delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
  delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
  delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
}

describe('Training API routes', () => {
  afterEach(() => {
    vi.useRealTimers();
    testDb.close();
  });

  beforeEach(async () => {
    testDb = new Database(':memory:');
    resetTrainingOperationalEnvForTests();

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
    mockInvalidateTrainingDerivedCaches.mockReset();
    mockReconcileOrphanedTrainingAgendaEvents.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockIsUserOverDailyCap.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue(null);
    mockDeleteReportsByType.mockReturnValue(0);
    mockClearStoredPlansForAthlete.mockReturnValue(0);
    mockGetStoredPlanCoveringDate.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([]);
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
    mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: intent.preferredWindows[0].start,
        scheduledEnd: intent.preferredWindows[0].end,
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));
    mockDeleteEvent.mockResolvedValue(undefined);
    mockReconcileOrphanedTrainingAgendaEvents.mockResolvedValue({
      attempted: 0,
      deleted: 0,
      failed: 0,
    });
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

  it('returns a structured sanitized coach report without raw debug fragments', async () => {
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'coach-briefing:12') {
        return {
          briefing: [
            'Keep today controlled.',
            'COACH_RECS_START',
            'eventId: "_60q30c1g60o30e1i60o4ac1g60rj8gpl88rj2c1h84s34h9g60s30c1g60o30c1g6srj2h216sqjgha184s48gpg64o30c1g60o30c1g60o32c1g60o30c1g6os32"',
            'Analysis: 12.4s',
          ].join('\n'),
          recommendations: [{ summary: 'Keep effort easy and protect tomorrow.' }],
          garminData: { sleepScore: 68, bodyBattery: 55 },
        };
      }
      return null;
    });

    const res = await dispatch('POST', '/coach/report');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.report.structured).toBe(true);
    expect(res.body.data.report.sections.map((section: any) => section.key)).toEqual([
      'coach_summary',
      'recommendation',
      'signals_used',
      'confidence_uncertainty',
      'sources_details',
    ]);
    const serialized = JSON.stringify(res.body.data);
    expect(serialized).not.toMatch(/COACH_RECS_START|_60q30c1g60o30e1i60o4ac1g60rj8gpl88rj2c1h84s34h9g60s30c1g60o30c1g6srj2h216sqjgha184s48gpg64o30c1g60o30c1g60o32c1g60o30c1g6os32|Analysis: 12\.4s/);
    expect(serialized).toContain('Keep effort easy');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('generates coach reports against the active tenant while billing the authenticated actor', async () => {
    const res = await dispatch('POST', '/coach/report', {}, { refresh: true }, 12, {}, 34);

    expect(res.statusCode).toBe(200);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(34, {
      tenantId: 34,
      meteringUserId: 12,
    });
    expect(mockSetCache).toHaveBeenCalledWith(
      'coach-briefing:34',
      expect.any(Object),
      expect.any(Number),
    );
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

  it('surfaces rich training lifecycle states in the week payload without counting inactive sessions as active load', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 44,
      name: 'Travel build',
      start_date: '2026-04-20',
      periodization: 'build',
      plan_version: 3,
    });
    mockGetCurrentWeek.mockReturnValue({ id: 78, week_number: 1, focus: 'travel' });
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 301,
        plan_id: 44,
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Reflowed Run',
        duration_minutes: 30,
        status: 'reflowed',
        session_identity_key: 'plan:44|week:1|day:monday|type:run|slot:1',
        session_shape_hash: 'shape-reflowed-run',
        description: 'Moved because of a meeting.',
      },
      {
        id: 302,
        plan_id: 44,
        day_of_week: 'Wednesday',
        session_type: 'gym',
        title: 'Compressed Lift',
        duration_minutes: 25,
        status: 'compressed',
        session_identity_key: 'plan:44|week:1|day:wednesday|type:gym|slot:1',
        session_shape_hash: 'shape-compressed-lift',
        description: 'Compressed to match the short hotel-gym window.',
      },
      {
        id: 303,
        plan_id: 44,
        day_of_week: 'Friday',
        session_type: 'run',
        title: 'No Slot Run',
        duration_minutes: 45,
        status: 'unscheduled',
        session_identity_key: 'plan:44|week:1|day:friday|type:run|slot:1',
        session_shape_hash: 'shape-unscheduled-run',
        description: 'No valid slot remained.',
      },
      {
        id: 304,
        plan_id: 44,
        day_of_week: 'Saturday',
        session_type: 'gym',
        title: 'Old Lift',
        duration_minutes: 40,
        status: 'superseded',
        session_identity_key: 'plan:44|week:1|day:saturday|type:gym|slot:1',
        session_shape_hash: 'shape-old-lift',
        description: 'Superseded by regenerated plan.',
      },
    ]);

    const res = await dispatch('GET', '/week');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.plan).toEqual(expect.objectContaining({
      id: 44,
      planVersion: 3,
      lifecycleState: 'active',
    }));
    expect(res.body.data.totalCount).toBe(2);
    expect(res.body.data.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '301',
        lifecycleState: 'reflowed',
        status: 'planned',
        sessionShapeHash: 'shape-reflowed-run',
      }),
      expect.objectContaining({
        id: '302',
        lifecycleState: 'compressed',
        status: 'planned',
        sessionShapeHash: 'shape-compressed-lift',
      }),
      expect.objectContaining({
        id: '303',
        lifecycleState: 'unscheduled',
        status: 'unscheduled',
      }),
      expect.objectContaining({
        id: '304',
        lifecycleState: 'superseded',
        status: 'superseded',
      }),
    ]));
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

    expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(12);
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

  it('returns 429 on plan generation when the user is over quota', async () => {
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

    expect(res.statusCode).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('daily_limit_exceeded');
    expect(res.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('blocks plan generation when the Training generation kill switch is disabled', async () => {
    process.env.TRAINING_PLAN_GENERATION_ENABLED = 'false';

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TRAINING_GENERATION_DISABLED');
    expect(res.body.error.details).toEqual({ operation: 'plan_generation' });
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('blocks calendar sync when the Training calendar kill switch is disabled', async () => {
    process.env.TRAINING_CALENDAR_SYNC_DISABLED = '1';

    const res = await dispatch('POST', '/plan/sync-calendar', {}, {});

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TRAINING_CALENDAR_SYNC_DISABLED');
    expect(res.body.error.details).toEqual({ operation: 'calendar_writes' });
    expect(mockGetActivePlan).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
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

  it('blocks race-specific generated plans before writes when the race date is missing', async () => {
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
            dayOfWeek: 'Wednesday',
            sessionType: 'run',
            title: 'Base Run',
            durationMinutes: 50,
            description: 'Easy aerobic run.',
            exercises: [],
          },
        ],
      },
    ]));

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon',
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('plan_quality_blocked');
    expect(res.body.data.planLint.status).toBe('fail');
    expect(res.body.data.planLint.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'race_specific_plan_requires_race_date' }),
      ]),
    );
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('schedules same-day run and gym sessions at separate preferred times', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T06:00:00.000Z'));

    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      if (profile === 'triathlon-running') return { target_race: 'Marathon', target_race_date: '2026-10-18' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan([
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Wednesday',
            sessionType: 'run',
            title: 'Base Run',
            durationMinutes: 50,
            description: 'Morning aerobic run.',
            exercises: [],
          },
          {
            dayOfWeek: 'Wednesday',
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

  it('replays confirmed plan creation by idempotency key instead of creating a duplicate plan', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T06:00:00.000Z'));

    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan([
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Wednesday',
            sessionType: 'gym',
            title: 'Strength + Core Support',
            durationMinutes: 40,
            description: 'Controlled strength work.',
            exercises: [],
          },
        ],
      },
    ]));

    const body = {
      objective: 'General fitness',
      preferredTime: '12:00',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 3,
      idempotencyKey: 'plan-create-abc',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    const createSessionCountAfterFirst = mockCreateSession.mock.calls.length;
    const createEventCountAfterFirst = mockCreateEvent.mock.calls.length;
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(createPlanCountAfterFirst).toBeGreaterThan(0);
    expect(createSessionCountAfterFirst).toBeGreaterThan(0);
    expect(createEventCountAfterFirst).toBeGreaterThan(0);
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(mockCreateSession).toHaveBeenCalledTimes(createSessionCountAfterFirst);
    expect(mockCreateEvent).toHaveBeenCalledTimes(createEventCountAfterFirst);
  });

  it('rejects reused plan creation idempotency keys with different inputs', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan());

    const first = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General fitness',
      sessionsPerWeek: 3,
      idempotencyKey: 'plan-create-conflict',
    });
    const second = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General fitness with extra cycling',
      sessionsPerWeek: 4,
      idempotencyKey: 'plan-create-conflict',
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(mockCreatePlan).toHaveBeenCalledTimes(1);
  });

  it('returns profile quality and decision reasons from the generated plan payload', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      if (profile === 'triathlon-running') return { target_race: 'Half marathon', target_race_date: '2026-10-18' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      ...makeKernelPlan(),
      profileQuality: {
        completenessScore: 0.66,
        confidenceScore: 0.61,
        missingCriticalFields: ['available_duration'],
        followUpPrompts: [
          {
            id: 'training.followup.available_duration',
            field: 'available_duration',
            prompt: 'How long can your weekday sessions realistically be?',
            reason: 'Duration is needed to avoid overfilling your week.',
            priority: 'high',
          },
        ],
      },
      decisionReasons: [
        {
          code: 'schedule_compressed',
          message: 'Compressed because only one valid training window was available.',
          severity: 'info',
          source: 'capacity_reconciliation',
          affectedEntity: { type: 'week', id: 'week-1' },
          evidence: { beforeMinutes: 45, afterMinutes: 25 },
        },
      ],
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Half marathon with limited weekday time',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.profileQuality).toEqual(expect.objectContaining({
      completenessScore: 0.66,
      confidenceScore: 0.61,
      missingCriticalFields: ['available_duration'],
    }));
    expect(res.body.data.profileQuality.followUpPrompts).toEqual([
      expect.objectContaining({
        id: 'training.followup.available_duration',
        field: 'available_duration',
      }),
    ]);
    expect(res.body.data.decisionReasons).toEqual([
      expect.objectContaining({
        code: 'schedule_compressed',
        source: 'capacity_reconciliation',
      }),
    ]);
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-13T12:00:00.000Z'));

    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') {
        return { experienceLevel: 'Beginner (< 1 year)', available_equipment: 'Full gym', injuries: 'left knee irritation' };
      }
      if (profile === 'triathlon-running') {
        return {
          recentRace: '10k',
          preferredRunsPerWeek: 4,
          injury_history: 'achilles flare-up',
          target_race_date: '2026-10-18',
        };
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
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });

    expect(res.statusCode).toBe(201);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledTimes(1);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon October 2026',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
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
      if (profile === 'triathlon-running') return { currentMileage: 24 };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockImplementation(() => {
      throw new Error('kernel unavailable');
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General consistency block',
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
    // Bug fix 2026-04-28 (no-plan create-CTA): the calendar fallback in
    // getTodaySession is now gated on an active plan existing — without
    // a plan, the fallback no longer fires and we never query the
    // calendar for routine-walk events. To still exercise the routine-
    // walk filter (the test's actual intent), give the user an active
    // plan but no session scheduled for today, so the calendar
    // fallback DOES fire and we can verify it correctly filters out
    // the non-training event.
    mockGetActivePlan.mockReturnValue({
      id: 90,
      name: 'Marathon Build',
      periodization: 'base',
      start_date: '2026-04-13T00:00:00.000Z',
      plan_version: 1,
      status: 'active',
    });
    mockGetCurrentWeek.mockReturnValue({ id: 901, week_number: 1, focus: 'base' });
    mockGetSessionsForWeek.mockReturnValue([]); // no plan-scheduled session for today
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

  it('returns every active plan week for the iOS progression timeline without regenerating or syncing', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 77,
      name: 'Marathon Build',
      start_date: '2026-05-04',
      end_date: '2026-06-01',
      periodization: 'block',
      duration_weeks: 4,
      plan_version: 3,
      status: 'active',
    });
    mockGetWeeksForPlan.mockReturnValue([
      { id: 771, week_number: 1, focus: 'base', intensity_pct: 64, adjustment_reason: null },
      { id: 772, week_number: 2, focus: 'build', intensity_pct: 70, adjustment_reason: 'progression' },
    ]);
    mockGetSessionsForWeek.mockImplementation((weekId: number) => (
      weekId === 771
        ? [
            {
              id: 1,
              plan_id: 77,
              day_of_week: 'Monday',
              session_type: 'run',
              title: 'Easy Run',
              duration_minutes: 45,
              status: 'planned',
              calendar_event_id: null,
              exercises_json: null,
              description_json: null,
            },
          ]
        : [
            {
              id: 2,
              plan_id: 77,
              day_of_week: 'Saturday',
              session_type: 'run',
              title: 'Long Run',
              duration_minutes: 90,
              status: 'planned',
              calendar_event_id: null,
              exercises_json: null,
              description_json: null,
            },
          ]
    ));

    const res = await dispatch('GET', '/plan/weeks');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.plan).toMatchObject({
      id: 77,
      name: 'Marathon Build',
      planVersion: 3,
      durationWeeks: 4,
    });
    expect(res.body.data.weeks).toHaveLength(2);
    expect(res.body.data.weeks[0]).toMatchObject({
      weekNumber: 1,
      phase: 'base',
      activeSessionCount: 1,
      syncedSessionCount: 0,
      missingSessionCount: 1,
      weekSyncStatus: 'unsynced',
    });
    expect(res.body.data.weeks[1].sessions[0]).toMatchObject({
      title: 'Long Run',
      calendarSyncState: 'missing',
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('recognizes explicit training events while excluding routine walk labels', () => {
    expect(looksLikeTrainingCalendarEvent('Tempo Run')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Strength Session')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Wake up / Prepare for walk')).toBe(false);
  });
});
