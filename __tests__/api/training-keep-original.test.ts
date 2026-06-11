// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training redesign Phase 0 — keep-original adaptation opt-out.
 *
 * POST /api/v1/training/today/keep-original persists a per-(userId, local
 * date) flag in the cache store; BOTH adaptation read paths must then
 * return the unadapted prescription for the rest of that local day:
 *   (a) training-read-models.getTodaySession — `adaptation` stays null
 *   (b) training-home-payload.resolveKernelTodayContext — adapted ===
 *       original prescription, fatigue readjustment skipped
 *
 * The mock preamble mirrors training-routes.test.ts (the proven set for
 * mounting trainingRoutes()), with two deltas: the cache-store mock is
 * Map-backed so the flag actually persists across the route write and the
 * read-model reads, and coach-kernel/planner-engine is mocked so the
 * fatigue re-run can be asserted on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const cache = new Map<string, any>();
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
const mockGetSessionById = vi.fn();
const mockGetPlanById = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockGetProfile = vi.fn();
const mockGetMissingProfileFields = vi.fn();
const mockGetQuestionnaire = vi.fn();
const mockBuildCoachKernelTrainingPlan = vi.fn();
const mockCalculateReadiness = vi.fn();
const mockGetStoredPlanCoveringDate = vi.fn();
const mockAdjustForFatigue = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockInvalidateCalendarCaches = vi.fn();
const mockInvalidateTrainingDerivedCaches = vi.fn();
const mockIsConnected = vi.fn();
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-06-12T00:00:00.000Z',
}));

// Map-backed cache store: the route's setCache write must be visible to
// the read paths' getCached in the same test (TTL semantics are owned by
// the real cache-store and pinned in its own test file).
vi.mock('../../src/services/cache-store', () => ({
  getCached: (key: string) => (cache.has(key) ? cache.get(key) : null),
  setCache: (key: string, value: unknown) => { cache.set(key, value); },
  clearCache: (key: string) => { cache.delete(key); },
  clearCacheByPrefix: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
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
  getEventsForSources: (...args: unknown[]) => mockGetEvents(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
}));

vi.mock('../../src/services/secretary-live-calendar-busy', () => ({
  loadLiveCalendarBusyWindowsForSecretaryIntent: vi.fn(),
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
  createPlan: vi.fn(),
  createWeek: vi.fn(),
  createSession: vi.fn(),
  linkSessionToCalendar: vi.fn(),
  markSessionSkipped: vi.fn(),
  updateSession: vi.fn(),
  updatePlanStatus: vi.fn(),
  deletePlanHard: vi.fn(),
}));

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/training-coach-kernel-plan-generator', () => ({
  buildCoachKernelTrainingPlan: (...args: unknown[]) => mockBuildCoachKernelTrainingPlan(...args),
  normalizeTrainingPlanDurationWeeks: (raw: unknown, fallback = 4) => {
    const resolved = Number(raw);
    const candidate = Number.isFinite(resolved) && resolved > 0 ? Math.round(resolved) : fallback;
    return Math.max(1, Math.min(52, candidate));
  },
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: vi.fn(),
  invalidateSharedDecisionContextCache: vi.fn(),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: vi.fn(),
  readCookingMeshContext: vi.fn(),
  readFinanceMeshContext: vi.fn(),
  readContentMeshContext: vi.fn(),
  readSecretaryMeshContext: vi.fn(),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  setLastCoachState: vi.fn(),
  clearLastCoachState: vi.fn(),
}));

vi.mock('../../src/services/coach-plan-registry', () => ({
  clearStoredPlansForAthlete: vi.fn(),
  getStoredPlanCoveringDate: (...args: unknown[]) => mockGetStoredPlanCoveringDate(...args),
}));

vi.mock('../../src/services/coach-kernel/planner-engine', () => ({
  adjustForFatigue: (...args: unknown[]) => mockAdjustForFatigue(...args),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: (...args: unknown[]) => mockBuildActiveSignalsResponse(...args),
}));

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
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

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
  reconcileOrphanedTrainingAgendaEvents: vi.fn(),
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  submitSecretarySchedulingIntent: vi.fn(),
}));

import { trainingRoutes } from '../../src/api/routes/training';
import { getTodaySession } from '../../src/api/routes/training-read-models';
import { buildTrainingHomePayload } from '../../src/api/routes/training-home-payload';
import {
  isKeepOriginalSet,
  isKeepOriginalSetForToday,
  resolveKeepOriginalToday,
} from '../../src/services/training-keep-original';
import { resolveTrainingDay } from '../../src/services/training-date-utils';
import type { Session } from '../../src/services/coach-kernel/types';

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

/** Active plan + today session + red readiness, so adaptation WOULD fire
 *  (easy_run → recovery_run, reason 'red_readiness') unless the
 *  keep-original flag suppresses it. */
function arrangeAdaptableTodaySession(): void {
  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  mockGetActivePlan.mockReturnValue({
    id: 10,
    name: 'Marathon Build',
    periodization: 'build',
    start_date: '2026-04-20T00:00:00.000Z',
  });
  mockGetCurrentWeek.mockReturnValue({ id: 20, week_number: 1, focus: 'base' });
  mockGetSessionsForWeek.mockReturnValue([{
    id: 30,
    plan_id: 10,
    day_of_week: todayName,
    title: 'Tempo Run',
    session_type: 'run',
    duration_minutes: 55,
    status: 'planned',
    description: 'Controlled threshold effort.',
    exercises_json: JSON.stringify([]),
  }]);
  // score 30 → red level → the adaptation engine swaps run → recovery_run.
  mockCalculateReadiness.mockResolvedValue({
    score: 30,
    factors: {
      hrv: { trend: 'down' },
      bodyBattery: { current: 18 },
    },
    recommendation: 'rest',
  });
}

function currentUtcDayOfWeek(): Session['dayOfWeek'] {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const mapping: Record<number, Session['dayOfWeek']> = {
    0: 'sunday',
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
  };
  return mapping[dow] ?? 'monday';
}

/** Stored kernel plan + orange live readiness, so the home payload WOULD
 *  re-run adjustForFatigue and swap the prescription unless the
 *  keep-original flag suppresses it. */
function arrangeStoredKernelPlan(): void {
  const todayDow = currentUtcDayOfWeek();
  mockGetStoredPlanCoveringDate.mockReturnValue({
    athleteState: {
      profile: { athleteId: 12 },
      readiness: {
        capturedAt: '2026-06-10T07:00:00.000Z',
        score: 72,
        level: 'yellow',
        energyReserve: 70,
      },
    },
    plan: {
      sessions: [
        {
          dayOfWeek: todayDow,
          sessionType: 'threshold_run',
          title: 'Tempo Run',
          durationMinutes: 50,
          intensityZone: 'zone 4',
        },
      ],
      guardrailResults: [
        {
          ruleId: 'fatigue_gate',
          status: 'pass',
          message: 'original plan',
          adjusted: false,
        },
      ],
    },
  });
  mockAdjustForFatigue.mockReturnValue({
    sessions: [
      {
        dayOfWeek: todayDow,
        sessionType: 'recovery_run',
        title: 'Recovery Run',
        durationMinutes: 35,
        intensityZone: 'zone 2',
      },
    ],
    guardrailResults: [
      {
        ruleId: 'fatigue_gate',
        status: 'warn',
        message: 'threshold_run → recovery_run because readiness is low',
        adjusted: true,
      },
    ],
  });
}

function homePayloadDeps() {
  return {
    getTodaySession: async () => ({
      session: { type: 'run', sessionType: 'run', status: 'planned' } as any,
      plan: { id: 1 },
    }),
    getWeekPlan: async () => ({
      plan: { id: 1 },
      sessions: [],
      adherence: 0.8,
    }),
    getReadiness: async () => ({
      score: 45,
      factors: { bodyBattery: 32, hrvStatus: 'low' },
      recommendation: 'Reduce load today.',
    }),
    buildActiveSignalsResponse: async () => ({ signals: [] }),
    getCoachBriefingSnapshot: () => null,
  };
}

describe('training keep-original opt-out', () => {
  afterEach(() => {
    testDb.close();
  });

  beforeEach(async () => {
    testDb = new Database(':memory:');
    cache.clear();

    const trainingMod: any = await import('../../src/api/routes/training');
    if (typeof trainingMod._resetCalendarLookupCoalesceForTests === 'function') {
      trainingMod._resetCalendarLookupCoalesceForTests();
    }

    mockGetEvents.mockReset();
    mockGetEvents.mockResolvedValue([]);
    mockIsConnected.mockReset();
    mockIsConnected.mockReturnValue(false);
    mockGetActivePlan.mockReset();
    mockGetCurrentWeek.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetSessionById.mockReset();
    mockGetPlanById.mockReset();
    mockGetWeeklyAdherence.mockReset();
    mockCalculateReadiness.mockReset();
    mockGetStoredPlanCoveringDate.mockReset();
    mockAdjustForFatigue.mockReset();
    mockBuildActiveSignalsResponse.mockReset();
    mockBuildActiveSignalsResponse.mockResolvedValue({ signals: [] });
    mockInvalidateCalendarCaches.mockReset();
    mockInvalidateTrainingDerivedCaches.mockReset();
  });

  it('POST /today/keep-original persists the local-day flag, invalidates screen caches, and is idempotent', async () => {
    const first = await dispatch('POST', '/today/keep-original', {}, {}, 12);

    expect(first.statusCode).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data).toEqual({ kept: true });
    // Pin the documented key format — iOS support tooling greps for it.
    expect(cache.has(`training:keep-original:12:${resolveKeepOriginalToday()}`)).toBe(true);
    expect(isKeepOriginalSetForToday(12)).toBe(true);
    expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(12);

    // Second call on the same local day: still success, flag still set.
    const second = await dispatch('POST', '/today/keep-original', {}, {}, 12);
    expect(second.statusCode).toBe(200);
    expect(second.body.data).toEqual({ kept: true });
    expect(isKeepOriginalSetForToday(12)).toBe(true);
  });

  it('getTodaySession skips readiness adaptation once the flag is set for today', async () => {
    arrangeAdaptableTodaySession();

    // Sanity: without the flag, red readiness adapts the session.
    const before = await getTodaySession(12, 12);
    expect(before.session?.adaptation).toMatchObject({ reason: 'red_readiness' });

    await dispatch('POST', '/today/keep-original', {}, {}, 12);

    // With the flag, the session renders exactly as written.
    const after = await getTodaySession(12, 12);
    expect(after.session).toMatchObject({
      type: 'Tempo Run',
      sessionType: 'run',
      duration: 55,
    });
    expect(after.session?.adaptation).toBeNull();
  });

  it('home payload pins adapted === original and skips the fatigue re-run once the flag is set', async () => {
    arrangeStoredKernelPlan();

    // Sanity: without the flag, orange live readiness swaps the prescription.
    const before = await buildTrainingHomePayload(12, 12, 'en-US', homePayloadDeps());
    expect(mockAdjustForFatigue).toHaveBeenCalledTimes(1);
    expect(before.hero.adaptedPrescription?.title).toBe('Recovery Run');

    mockAdjustForFatigue.mockClear();
    await dispatch('POST', '/today/keep-original', {}, {}, 12);

    const after = await buildTrainingHomePayload(12, 12, 'en-US', homePayloadDeps());
    expect(mockAdjustForFatigue).not.toHaveBeenCalled();
    expect(after.hero.originalPrescription).toEqual({
      title: 'Tempo Run',
      detail: '50 min · zone 4',
      durationMinutes: 50,
      sessionType: 'threshold_run',
    });
    // adapted === original → the iOS swap banner clears.
    expect(after.hero.adaptedPrescription).toEqual(after.hero.originalPrescription);
  });

  it('a flag set for yesterday does not affect today', async () => {
    arrangeAdaptableTodaySession();

    // Yesterday in the same Training-timezone calendar the helper uses,
    // so this test cannot flake across UTC/local midnight boundaries.
    const yesterday = resolveTrainingDay({ offsetDays: -1 }).date;
    cache.set(`training:keep-original:12:${yesterday}`, { kept: true });

    expect(isKeepOriginalSet(12, yesterday)).toBe(true);
    expect(isKeepOriginalSetForToday(12)).toBe(false);

    const result = await getTodaySession(12, 12);
    expect(result.session?.adaptation).toMatchObject({ reason: 'red_readiness' });
  });

  it('the flag is isolated per user', async () => {
    arrangeAdaptableTodaySession();

    await dispatch('POST', '/today/keep-original', {}, {}, 12);
    expect(isKeepOriginalSetForToday(12)).toBe(true);
    expect(isKeepOriginalSetForToday(13)).toBe(false);

    // User 13 still gets the adapted session; user 12 does not.
    const other = await getTodaySession(13, 13);
    expect(other.session?.adaptation).toMatchObject({ reason: 'red_readiness' });

    const kept = await getTodaySession(12, 12);
    expect(kept.session?.adaptation).toBeNull();
  });
});
