import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';
import { config } from '../../src/config';
import { resolveTrainingDay } from '../../src/services/training-date-utils';

let testDb: Database.Database;
let databaseReadFailure: Error | null = null;

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGenerateCoachBriefing = vi.fn();
const mockRunWithCoachBriefingAccountAdmissions = vi.fn();
const mockRunWithCoachBriefingAccountLifecycle = vi.fn();
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
const mockLogCompletion = vi.fn();
const mockMarkSessionCompleted = vi.fn();
const mockEmitDomainEvent = vi.fn();
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
const mockBuildTrainingEquipmentAdaptation = vi.fn();
const mockSetLastCoachState = vi.fn();
const mockClearLastCoachState = vi.fn();
const mockClearStoredPlansForAthlete = vi.fn();
const mockGetStoredPlanCoveringDate = vi.fn();
const mockLoggerError = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockRecordTrainingSummaryDeprecationHit = vi.fn();
const mockInvalidateCalendarCaches = vi.fn();
const mockInvalidateTrainingDerivedCaches = vi.fn();
const mockReconcileOrphanedTrainingAgendaEvents = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockLoadLiveCalendarBusyWindows = vi.fn();
const mockIsConnected = vi.fn();
const mockWithTrainingCalendarOperationLock = vi.hoisted(() => vi.fn());
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
  getDb: () => {
    if (databaseReadFailure) throw databaseReadFailure;
    return testDb;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/training-route-deprecation-telemetry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-route-deprecation-telemetry')>(
    '../../src/services/training-route-deprecation-telemetry'
  )),
  recordTrainingSummaryDeprecationHit: (...args: unknown[]) => (
    mockRecordTrainingSummaryDeprecationHit(...args)
  ),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
  runWithCoachBriefingAccountAdmissions: (...args: unknown[]) => (
    mockRunWithCoachBriefingAccountAdmissions(...args)
  ),
  runWithCoachBriefingAccountLifecycle: (...args: unknown[]) => (
    mockRunWithCoachBriefingAccountLifecycle(...args)
  ),
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

vi.mock('../../src/services/secretary-live-calendar-busy', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-live-calendar-busy')>(
    '../../src/services/secretary-live-calendar-busy'
  )),
  loadLiveCalendarBusyWindowsForSecretaryIntent: (...args: unknown[]) => mockLoadLiveCalendarBusyWindows(...args),
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
  TrainingPlanReplacementConflictError: class TrainingPlanReplacementConflictError extends Error {
    readonly code = 'TRAINING_PLAN_REPLACEMENT_CONFLICT';
  },
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getCurrentWeek: (...args: unknown[]) => mockGetCurrentWeek(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  getPlanById: (...args: unknown[]) => mockGetPlanById(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  // F6: the real adapter performs predecessor CAS + supersede + activation
  // inside persistence's transaction. This route unit suite mocks row
  // writers; the real two-connection transition is integration-tested.
  activateCompatibilityPlanReplacement: (input: any) => ({
    supersededPlanIds: input.expectedActivePlanIds ?? [],
  }),
  activatePendingPlan: () => true,
  createWeek: (...args: unknown[]) => mockCreateWeek(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
  markSessionSkipped: (...args: unknown[]) => mockMarkSessionSkipped(...args),
  logCompletion: (...args: unknown[]) => mockLogCompletion(...args),
  markSessionCompleted: (...args: unknown[]) => mockMarkSessionCompleted(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  updatePlanStatus: (...args: unknown[]) => mockUpdatePlanStatus(...args),
  updatePlanPreferences: () => true,
  deletePlanHard: (...args: unknown[]) => mockDeletePlanHard(...args),
}));

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

// The completion write path wraps logCompletion + emitDomainEvent in an
// outbox transaction against the real DB. Tests assert against the
// captured emit instead of standing up the outbox tables.
vi.mock('../../src/services/event-outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/event-outbox')>()),
  runOutboxTransaction: (operation: (emit: any) => unknown) => operation(mockEmitDomainEvent),
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

vi.mock('../../src/services/training-plan-equipment-adaptation', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-plan-equipment-adaptation')>(
    '../../src/services/training-plan-equipment-adaptation',
  );
  return {
    ...actual,
    buildTrainingEquipmentAdaptation: (...args: unknown[]) => {
      const implementation = mockBuildTrainingEquipmentAdaptation.getMockImplementation();
      return implementation ? mockBuildTrainingEquipmentAdaptation(...args) : actual.buildTrainingEquipmentAdaptation(...(args as [any]));
    },
  };
});

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
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/services/integration-status', () => ({
  isGarminActivelyIntegrated: vi.fn(() => false),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.decision = decision; }
  },
  buildQuotaExceededPayload: vi.fn((quota: any) => ({
    plan: quota.plan,
    resetAt: quota.resetAt,
  })),
  withAiBudgetReservation: vi.fn(async (request: any, fn: () => Promise<unknown>) => {
    const quota = mockIsUserOverDailyCap(request.userId);
    if (quota.over) {
      const { AiBudgetError } = await import('../../src/services/cost-guardrail');
      throw new AiBudgetError({
        code: 'AI_DAILY_LIMIT_REACHED',
        message: `Daily AI quota reached for the ${quota.plan} plan.`,
        status: 429,
        window: 'daily',
        unblocksAt: quota.resetAt,
        retryAfterSeconds: 60,
        quota,
      });
    }
    return fn();
  }),
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
  isTrainingCalendarEventClaimedOutsideTenant: vi.fn(() => false),
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

vi.mock('../../src/services/training-operation-locks', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-operation-locks')>(
    '../../src/services/training-operation-locks'
  )),
  withTrainingCalendarOperationLock: (...args: unknown[]) => (
    mockWithTrainingCalendarOperationLock(...args)
  ),
}));

import { looksLikeTrainingCalendarEvent, trainingRoutes } from '../../src/api/routes/training';
import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
} from '../../src/services/training-plan-generation-idempotency';
import * as trainingOperationLocksModule from '../../src/services/training-operation-locks';

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
    entitlement: { plan: 'pro', source: 'stripe' },
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
  delete process.env.TRAINING_PLAN_REVISION_V1_MODE;
  delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_12;
  delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
}

function poisonedTrainingOperationLockError(
  operation: trainingOperationLocksModule.TrainingOperationName,
): trainingOperationLocksModule.TrainingOperationLockError {
  const error = new trainingOperationLocksModule.TrainingOperationLockError(operation, 30);
  error.message = 'SQLite lock training-calendar:user:12:tenant:34 belongs to must-not-reach-http';
  return Object.assign(error, {
    lockKey: 'training-calendar:user:12:tenant:34',
    ownerToken: 'must-not-reach-http',
    userId: 12,
    tenantId: 34,
  });
}

function poisonedTrainingOperationLockUnavailableError(
  operation: trainingOperationLocksModule.TrainingOperationName,
): Error {
  const unavailableErrorType = (
    trainingOperationLocksModule as unknown as Record<string, unknown>
  ).TrainingOperationLockUnavailableError as (
    new (operation: trainingOperationLocksModule.TrainingOperationName, retryAfterSeconds?: number) => Error
  ) | undefined;
  const error = unavailableErrorType
    ? new unavailableErrorType(operation, 5)
    : Object.assign(new Error('TRAINING_OPERATION_LOCK_UNAVAILABLE'), {
        code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
        status: 503,
        operation,
        retryAfterSeconds: 5,
      });
  error.message = 'DB unavailable for training-calendar:user:12:tenant:34 owner must-not-reach-http';
  return Object.assign(error, {
    lockKey: 'training-calendar:user:12:tenant:34',
    ownerToken: 'must-not-reach-http',
    userId: 12,
    tenantId: 34,
  });
}

function expectSafeTrainingOperationError(
  res: MockRes,
  expected: {
    status: 409 | 503;
    code: 'TRAINING_OPERATION_LOCKED' | 'TRAINING_OPERATION_LOCK_UNAVAILABLE';
    message: string;
    operation: trainingOperationLocksModule.TrainingOperationName;
    retryAfterSeconds: number;
  },
): void {
  expect(res.statusCode).toBe(expected.status);
  expect(res.headers['Retry-After']).toBe(String(expected.retryAfterSeconds));
  expect(res.body).toMatchObject({
    ok: false,
    error: { code: expected.code, message: expected.message },
  });
  // Stronger guarantee than checking one known secret-shaped string: pinning
  // the complete allowlist makes any future user/tenant/key/owner field fail.
  expect(res.body.error.details).toEqual({
    operation: expected.operation,
    retryAfterSeconds: expected.retryAfterSeconds,
  });
}

function trainingGenerationIdempotencyRow(idempotencyKey: string): { status: string } | undefined {
  return testDb.prepare(`
    SELECT status
      FROM training_plan_generation_idempotency_scoped
     WHERE user_id = 12
       AND tenant_id = 12
       AND idempotency_key = ?
  `).get(idempotencyKey) as { status: string } | undefined;
}

describe('Training API routes', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetTrainingOperationalEnvForTests();
    testDb.close();
  });

  beforeEach(async () => {
    testDb = new Database(':memory:');
    databaseReadFailure = null;
    resetTrainingOperationalEnvForTests();
    config.coaching.coachKernelEquipmentAuthorityEnabled = false;

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
    mockRunWithCoachBriefingAccountAdmissions.mockReset();
    mockRunWithCoachBriefingAccountAdmissions.mockImplementation(async (
      _userId: number,
      _options: Record<string, unknown>,
      operation: (abortSignal: AbortSignal) => unknown,
    ) => operation(new AbortController().signal));
    mockRunWithCoachBriefingAccountLifecycle.mockReset();
    mockRunWithCoachBriefingAccountLifecycle.mockImplementation(async (
      userId: number,
      options: Record<string, unknown>,
      consume: (briefing: unknown, abortSignal: AbortSignal) => unknown,
    ) => consume(
      await mockGenerateCoachBriefing(userId, options),
      new AbortController().signal,
    ));
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
    mockLogCompletion.mockReset();
    mockMarkSessionCompleted.mockReset();
    mockEmitDomainEvent.mockReset();
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
    mockBuildTrainingEquipmentAdaptation.mockReset();
    mockClearLastCoachState.mockReset();
    mockClearStoredPlansForAthlete.mockReset();
    mockGetStoredPlanCoveringDate.mockReset();
    mockLoggerError.mockReset();
    mockBuildActiveSignalsResponse.mockReset();
    mockRecordTrainingSummaryDeprecationHit.mockReset();
    mockInvalidateCalendarCaches.mockReset();
    mockInvalidateTrainingDerivedCaches.mockReset();
    mockReconcileOrphanedTrainingAgendaEvents.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockLoadLiveCalendarBusyWindows.mockReset();
    mockIsConnected.mockReset();
    mockWithTrainingCalendarOperationLock.mockReset();
    mockIsUserOverDailyCap.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue(null);
    mockDeleteReportsByType.mockReturnValue(0);
    mockClearStoredPlansForAthlete.mockReturnValue(0);
    mockGetStoredPlanCoveringDate.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([]);
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
    mockIsConnected.mockImplementation((_userId: number, provider: string) => provider === 'google' || provider === 'outlook');
    mockWithTrainingCalendarOperationLock.mockImplementation(
      async (_input: unknown, operation: (lease: unknown) => Promise<unknown>) => {
        // Stronger guarantee: route callbacks now receive an explicit lease
        // fence and revalidate it at provider/local mutation boundaries.
        const signal = new AbortController().signal;
        return operation(Object.assign(() => {}, { signal, assertActive: vi.fn() }));
      },
    );
    mockLoadLiveCalendarBusyWindows.mockResolvedValue({
      windows: [],
      degraded: false,
      providerConfigured: true,
      warningCodes: [],
      warnings: [],
    });
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

  it('keeps GET /coach cache misses token-zero and rejects refresh without any model-provider path', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
    const miss = await dispatch('GET', '/coach');
    const refresh = await dispatch('GET', '/coach', { refresh: 'true' });

    expect(miss.statusCode).toBe(200);
    expect(miss.body.ok).toBe(true);
    expect(miss.body.data).toEqual({
      briefing: '',
      recommendations: [],
      garminData: null,
      cachedOnlyMiss: true,
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.body).toMatchObject({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: expect.stringContaining('POST /api/v1/training/coach/report'),
      },
    });
    expect(mockRunWithCoachBriefingAccountLifecycle).not.toHaveBeenCalled();
    expect(mockRunWithCoachBriefingAccountAdmissions).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();

    const routeSource = readFileSync('src/api/routes/training.ts', 'utf8');
    const getCoachStart = routeSource.indexOf("router.get('/coach'");
    const postCoachReportStart = routeSource.indexOf("router.post('/coach/report'", getCoachStart);
    expect(getCoachStart).toBeGreaterThan(-1);
    expect(postCoachReportStart).toBeGreaterThan(getCoachStart);
    expect(routeSource.slice(getCoachStart, postCoachReportStart)).not.toMatch(
      /runWithCoachBriefingAccountLifecycle|generateCoachBriefingAdmitted|completeOneShotWithFallback/,
    );

    const openApiSource = readFileSync('docs/contracts/openapi-v1.yaml', 'utf8');
    const getCoachContractStart = openApiSource.indexOf('"/api/v1/training/coach":');
    const coachApplyContractStart = openApiSource.indexOf('"/api/v1/training/coach/apply":', getCoachContractStart);
    const getCoachContract = openApiSource.slice(getCoachContractStart, coachApplyContractStart);
    expect(getCoachContract).toContain('x-nexus-kind: "deterministic"');
    expect(getCoachContract).not.toMatch(/x-nexus-kind: "model-backed"|allowSensitiveCloudRouting/);
  });

  it('returns a structured sanitized coach report without raw debug fragments', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
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
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 34, status: 'active' });
    const res = await dispatch('POST', '/coach/report', {}, {
      refresh: true,
      allowSensitiveCloudRouting: true,
    }, 12, {}, 34);

    expect(res.statusCode).toBe(200);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(34, {
      tenantId: 34,
      meteringUserId: 12,
      budgetRequestSource: 'interactive',
      budgetJobName: 'coach_report',
      allowSensitiveCloudRouting: true,
    });
    expect(mockSetCache).toHaveBeenCalledWith(
      'coach-briefing:34',
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('rejects unknown or non-boolean coach report fields at the closed request boundary', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });

    const unknown = await dispatch('POST', '/coach/report', {}, {
      refresh: true,
      prompt: 'must not be accepted',
    });
    const mistyped = await dispatch('POST', '/coach/report', {}, {
      allowSensitiveCloudRouting: 'true',
    });

    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_REQUEST_BODY');
    expect(mistyped.statusCode).toBe(400);
    expect(mistyped.body.error.code).toBe('INVALID_REQUEST_BODY');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('does not replace POST coach report account-erasure cancellation with a deterministic fallback', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
    mockGenerateCoachBriefing.mockRejectedValueOnce(Object.assign(
      new Error('account deletion in progress'),
      { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    ));

    const res = await dispatch('POST', '/coach/report', {}, { refresh: true });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('serves cached Coach reads before the model-backed quota gate after current eligibility is revalidated', async () => {
    // Stronger guarantee: cache hits may avoid model quota, but must never
    // bypass the current active-plan/entitlement eligibility check.
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGetCached.mockReturnValue({ briefing: 'Latest valid report', recommendations: [], garminData: null });

    const res = await dispatch('GET', '/coach');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.briefing).toBe('Latest valid report');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('returns the stable daily AI limit instead of masking it with Coach fallback copy', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGenerateCoachBriefing.mockImplementationOnce(async () => {
      const { AiBudgetError } = await import('../../src/services/cost-guardrail');
      throw new AiBudgetError({
        allowed: false,
        code: 'AI_DAILY_LIMIT_REACHED',
        message: 'Daily AI quota reached for the pro plan.',
        status: 429,
        window: 'daily',
        unblocksAt: '2026-04-15T00:00:00.000Z',
        retryAfterSeconds: 60,
        quota: mockIsUserOverDailyCap(12),
      } as any);
    });

    const res = await dispatch('POST', '/coach/report', {}, { refresh: true });

    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(res.body.error.details.window).toBe('daily');
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
  });

  it('keeps Training summary available while exposing its deprecation window and aggregate hit', async () => {
    const cachedSummary = {
      today: null,
      week: { sessions: [], adherence: 0, weekNumber: 0 },
      readiness: { score: 0, factors: {}, recommendation: null },
    };
    mockGetCached.mockReturnValue(cachedSummary);

    const res = await dispatch('GET', '/summary');

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(cachedSummary);
    expect(res.headers.Deprecation).toBe('true');
    expect(res.headers.Sunset).toBe('Fri, 02 Oct 2026 00:00:00 GMT');
    expect(res.headers.Link).toBe('</api/v1/training/home>; rel="successor-version"');
    expect(mockRecordTrainingSummaryDeprecationHit).toHaveBeenCalledOnce();
    expect(mockRecordTrainingSummaryDeprecationHit).toHaveBeenCalledWith(testDb);
  });

  it('does not make the deprecated Training summary unavailable when aggregate telemetry fails', async () => {
    mockGetCached.mockReturnValue({ today: null, week: null, readiness: null });
    mockRecordTrainingSummaryDeprecationHit.mockImplementationOnce(() => {
      throw new Error('metrics store unavailable');
    });

    const res = await dispatch('GET', '/summary');

    expect(res.statusCode).toBe(200);
    expect(res.headers.Deprecation).toBe('true');
    expect(res.body.data).toEqual({ today: null, week: null, readiness: null });
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

  it('surfaces rich training lifecycle states in the week payload without counting superseded sessions as active load', async () => {
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
    expect(res.body.data.totalCount).toBe(3);
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
    expect(res.body.data.revisionCapabilities).toBeUndefined();
  });

  it('adds the scoped revision capability contract to Training home only for an active enrolled account', async () => {
    process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_12 = 'active';
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
    mockGetActivePlan.mockReturnValue(null);
    mockGetEvents.mockResolvedValue([]);

    const res = await dispatch('GET', '/home');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.revisionCapabilities).toMatchObject({
      schemaVersion: 'training_plan_revision_api.v1',
      mode: 'active',
      registryVersion: 'training-workout-capabilities.v1',
      milestone1GenerationSessionTypes: [
        'strength_hypertrophy', 'strength_maintenance', 'mobility', 'rest',
      ],
      unknownFallback: { preservesRawIdentifier: true, newlyPrescribable: false },
    });
    expect(res.body.data.revisionCapabilities.canonicalSessionTypes).toHaveLength(21);
  });

  it('surfaces wearable integration gaps honestly in the training home contract', async () => {
    mockGetCached.mockImplementation((key: string) => {
      if (key === 'readiness:12:12') {
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
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12, status: 'active' });
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

    const res = await dispatch('GET', '/coach');

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

    const res = await dispatch('GET', '/coach', {}, undefined, 0);

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TENANT_SCOPE_REQUIRED');
    expect(mockGetLatestByType).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'service',
          operation: 'training.coach',
          reason: 'missing_tenant_scope',
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
    expect(mockWithTrainingCalendarOperationLock).toHaveBeenCalledWith(
      { userId: 12, tenantId: 12, operation: 'coach_apply' },
      expect.any(Function),
    );
    expect(mockApplyCoachRecommendations).toHaveBeenCalledWith(
      12,
      12,
      ['rec-1'],
      { lease: expect.objectContaining({ signal: expect.anything(), assertActive: expect.any(Function) }) },
    );

    expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(12);
  });

  it('locks and applies coach recommendations against the delegated data owner, not the actor', async () => {
    const res = await dispatch(
      'POST',
      '/coach/apply',
      {},
      { recommendationIds: ['rec-1'] },
      42,
      {},
      77,
    );

    expect(res.statusCode).toBe(200);
    expect(mockWithTrainingCalendarOperationLock).toHaveBeenCalledWith(
      { userId: 77, tenantId: 77, operation: 'coach_apply' },
      expect.any(Function),
    );
    expect(mockApplyCoachRecommendations).toHaveBeenCalledWith(
      42,
      77,
      ['rec-1'],
      { lease: expect.objectContaining({ signal: expect.anything(), assertActive: expect.any(Function) }) },
    );
    expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(77);
    expect(mockInvalidateTrainingDerivedCaches).not.toHaveBeenCalledWith(42);
  });

  it('sanitizes degraded coach report warnings when briefing generation fails', async () => {
    mockGetActivePlan
      .mockReturnValueOnce({ id: 44, user_id: 12, tenant_id: 12, status: 'active' })
      .mockReturnValue(null);
    mockGenerateCoachBriefing.mockRejectedValueOnce(new Error('upstream garmin timeout: tenant=12'));

    const res = await dispatch('POST', '/coach/report', {}, { refresh: true });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.degraded).toBe(true);
    expect(res.body.data.warnings).toEqual(['Coach report unavailable.']);
    expect(JSON.stringify(res.body)).not.toContain('upstream garmin timeout');
  });

  it('falls back to a deterministic coach report when AI generation fails but a plan exists', async () => {
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

    const res = await dispatch('POST', '/coach/report', {}, { refresh: true }, 12, { 'x-language': 'pt-BR' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.degraded).toBe(false);
    expect(res.body.data.deterministicFallback).toBe(true);
    expect(res.body.data.warnings).toEqual([]);
    expect(res.body.data.briefing).toContain('Leitura rápida do coach');
    expect(JSON.stringify(res.body)).not.toContain('upstream garmin timeout');
    expect(mockRunWithCoachBriefingAccountAdmissions).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        tenantId: 12,
        meteringUserId: 12,
        budgetJobName: 'coach_report_fallback',
      }),
      expect.any(Function),
    );
    expect(mockSetCache).not.toHaveBeenCalledWith(
      'coach-briefing:12',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not publish a deterministic POST coach report fallback when fallback admission is fenced', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 44,
      user_id: 12,
      tenant_id: 12,
      status: 'active',
    });
    mockGenerateCoachBriefing.mockRejectedValueOnce(new Error('provider unavailable'));
    mockRunWithCoachBriefingAccountAdmissions.mockRejectedValueOnce(Object.assign(
      new Error('account deletion in progress'),
      { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    ));

    const res = await dispatch('POST', '/coach/report', {}, { refresh: true });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('returns uncached readiness unavailable state when readiness scoring fails', async () => {
    mockCalculateReadiness.mockRejectedValueOnce(new Error('wearable store unavailable'));

    const res = await dispatch('GET', '/readiness');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      score: 0,
      factors: {},
      recommendation: null,
      reasonCode: 'READINESS_UNAVAILABLE',
      unavailable: true,
    });
    expect(mockSetCache).not.toHaveBeenCalledWith(
      'readiness:12',
      expect.anything(),
      expect.anything(),
    );
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

  it('reports a safe non-retryable partial-failure contract after a provider-side coach update', async () => {
    mockApplyCoachRecommendations.mockRejectedValueOnce(Object.assign(
      new Error('provider event evt-private changed; sqlite path /private/db failed'),
      {
        code: 'COACH_APPLY_PARTIAL_FAILURE',
        status: 409,
        providerMutationApplied: true,
        localSyncConfirmed: false,
        retryable: false,
      },
    ));

    const res = await dispatch(
      'POST',
      '/coach/apply',
      {},
      { recommendationIds: ['rec-1'] },
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toEqual({
      code: 'COACH_APPLY_PARTIAL_FAILURE',
      message: 'Calendar changed, but Training could not confirm the matching update. Refresh before retrying.',
      details: {
        providerMutationApplied: true,
        localSyncConfirmed: false,
        retryable: false,
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/evt-private|\/private\/db/);
  });

  it('maps a stale scoped coach recommendation without calling it a provider outage', async () => {
    mockApplyCoachRecommendations.mockRejectedValueOnce(Object.assign(new Error('foreign event private-id'), {
      code: 'COACH_RECOMMENDATION_STALE',
      status: 409,
      retryable: false,
    }));

    const res = await dispatch(
      'POST',
      '/coach/apply',
      {},
      { recommendationIds: ['rec-1'] },
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toEqual({
      code: 'COACH_RECOMMENDATION_STALE',
      message: 'This coach recommendation is stale. Refresh the coach briefing before retrying.',
      details: { retryable: false },
    });
    expect(JSON.stringify(res.body)).not.toContain('private-id');
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

  it('keeps deterministic plan generation token-zero when model quota is exhausted', async () => {
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

    expect(res.statusCode).not.toBe(429);
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
  });

  it('marks token-zero plan generation idempotency rows succeeded without checking model quota', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      return null;
    });

    const body = {
      objective: 'General fitness',
      preferredTime: '12:00',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
      idempotencyKey: 'quota-retry-key',
    };

    const response = await dispatch('POST', '/plan/generate', {}, body);

    expect(response.statusCode).toBe(201);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalled();
    expect(trainingGenerationIdempotencyRow('quota-retry-key')?.status).toBe('succeeded');
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
  });

  it('reads generation-attempt status without exposing or mutating ownership internals', async () => {
    process.env.TRAINING_PLAN_GENERATION_ENABLED = 'false';
    const key = 'ios:create:route-reconciliation';
    claimTrainingPlanGenerationIdempotency(12, 12, key, 'must-not-reach-http-request-hash');
    const before = testDb.prepare(`
      SELECT status, attempt_count, lease_owner, fencing_token
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(key);

    const res = await dispatch('POST', '/plan/generation-attempt/status', {}, {
      idempotencyKey: key,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'in_progress',
      recovery: 'retry_same_attempt',
      canStartNew: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('must-not-reach-http');
    expect(testDb.prepare(`
      SELECT status, attempt_count, lease_owner, fencing_token
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(key)).toEqual(before);
  });

  it('keeps generation-attempt status isolated to the authenticated tenant', async () => {
    const key = 'ios:create:route-tenant-isolation';
    const claim = claimTrainingPlanGenerationIdempotency(12, 34, key, 'tenant-34-hash');
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('expected owned generation claim');
    completeTrainingPlanGenerationIdempotency(
      12,
      34,
      claim,
      { status: 'created', planId: 734 },
      201,
    );
    mockGetPlanById.mockReturnValue({ id: 734, user_id: 12, tenant_id: 34, status: 'active' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 1734, plan_id: 734, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([{ id: 2734, plan_id: 734, week_id: 1734 }]);

    const otherTenant = await dispatch(
      'POST',
      '/plan/generation-attempt/status',
      {},
      { idempotencyKey: key },
      12,
      {},
      56,
    );
    expect(otherTenant.body.data).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'not_found',
      // Stronger guarantee: absence in this tenant is not evidence that a
      // create did not commit elsewhere, so the client only polls status.
      recovery: 'check_status_again',
      canStartNew: false,
    });
    expect(mockGetPlanById).not.toHaveBeenCalled();

    const ownerTenant = await dispatch(
      'POST',
      '/plan/generation-attempt/status',
      {},
      { idempotencyKey: key },
      12,
      {},
      34,
    );
    expect(ownerTenant.body.data).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'created',
      recovery: 'use_created_plan',
      canStartNew: false,
      planId: 734,
    });
  });

  it.each([
    { label: 'missing', body: {} },
    { label: 'blank', body: { idempotencyKey: '   ' } },
    { label: 'overlong', body: { idempotencyKey: 'x'.repeat(161) } },
    { label: 'non-string', body: { idempotencyKey: 42 } },
  ])('rejects $label generation-attempt keys before the service read', async ({ body }) => {
    const res = await dispatch('POST', '/plan/generation-attempt/status', {}, body);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field: 'idempotencyKey' },
    });
  });

  it.each([
    { label: 'blank body key', bodyKey: '   ', headers: {} },
    { label: 'non-string body key', bodyKey: 42, headers: {} },
    { label: 'overlong body key', bodyKey: 'x'.repeat(161), headers: {} },
    { label: 'overlong header key', bodyKey: undefined, headers: { 'idempotency-key': 'x'.repeat(161) } },
  ])('rejects an explicit $label instead of truncating or silently auto-keying generation', async ({ bodyKey, headers }) => {
    const body: Record<string, unknown> = {
      objective: 'Strict idempotency boundary',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
    };
    if (bodyKey !== undefined) body.idempotencyKey = bodyKey;

    const res = await dispatch('POST', '/plan/generate', {}, body, 12, headers);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field: 'idempotencyKey' },
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'training_plan_generation_idempotency_scoped'
    `).get()).toBeUndefined();
  });

  it('returns a safe 503 when authoritative attempt-status DB acquisition fails', async () => {
    databaseReadFailure = new Error('private database path and token must not escape');

    const res = await dispatch('POST', '/plan/generation-attempt/status', {}, {
      idempotencyKey: 'ios:create:status-db-unavailable',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toEqual({
      code: 'TRAINING_PLAN_GENERATION_STATUS_UNAVAILABLE',
      message: 'Plan creation status is temporarily unavailable. Retry the same attempt.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/private database path|token/);
  });

  it('returns a safe 503 when the durable attempt-status query fails', async () => {
    const key = 'ios:create:status-query-unavailable';
    claimTrainingPlanGenerationIdempotency(12, 12, key, 'private-request-hash');
    testDb.exec('DROP TABLE training_plan_generation_idempotency_scoped');

    const res = await dispatch('POST', '/plan/generation-attempt/status', {}, {
      idempotencyKey: key,
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('TRAINING_PLAN_GENERATION_STATUS_UNAVAILABLE');
  });

  it('rejects a signed preview after profile context drift before claiming idempotency', async () => {
    let experienceLevel = 'Intermediate';
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel, available_equipment: 'Full gym' }
        : null
    ));
    const request = {
      objective: 'Build consistent running fitness',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
    };
    const preview = await dispatch('POST', '/plan/preview', {}, request);
    expect(preview.statusCode).toBe(200);
    expect(preview.body.data.previewToken).toEqual(expect.any(String));

    // Experience level is intentionally outside the narrow clarification
    // hash. The full profile-context pin must still invalidate acceptance.
    experienceLevel = 'Advanced';
    mockBuildCoachKernelTrainingPlan.mockClear();
    const idempotencyKey = 'ios:create:profile-context-drift';
    const create = await dispatch('POST', '/plan/generate', {}, {
      ...request,
      idempotencyKey,
      previewToken: preview.body.data.previewToken,
    });

    expect(create.statusCode).toBe(409);
    expect(create.body.error).toMatchObject({
      code: 'TRAINING_PLAN_PREVIEW_STALE',
      details: { requiresPreview: true, reason: 'context_changed' },
    });
    expect(testDb.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'training_plan_generation_idempotency_scoped'
    `).get()).toBeUndefined();
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects candidate drift before persistence and records proven no-creation recovery', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Intermediate', available_equipment: 'Full gym' }
        : null
    ));
    const request = {
      objective: 'Build consistent running fitness',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
    };
    const preview = await dispatch('POST', '/plan/preview', {}, request);
    expect(preview.statusCode).toBe(200);
    expect(preview.body.data.previewToken).toEqual(expect.any(String));

    mockBuildCoachKernelTrainingPlan.mockReturnValue(makeKernelPlan([
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Tuesday',
            sessionType: 'run',
            title: 'Changed Candidate Run',
            durationMinutes: 60,
            description: 'A materially different candidate.',
            exercises: [],
          },
        ],
      },
    ]));
    mockCreatePlan.mockClear();
    const idempotencyKey = 'ios:create:candidate-drift';
    const create = await dispatch('POST', '/plan/generate', {}, {
      ...request,
      idempotencyKey,
      previewToken: preview.body.data.previewToken,
    });

    expect(create.statusCode).toBe(409);
    expect(create.body.error).toMatchObject({
      code: 'TRAINING_PLAN_PREVIEW_STALE',
      details: { requiresPreview: true, reason: 'candidate_changed' },
    });
    expect(mockCreatePlan).not.toHaveBeenCalled();

    const status = await dispatch('POST', '/plan/generation-attempt/status', {}, {
      idempotencyKey,
    });
    expect(status.body.data).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'known_no_creation',
      recovery: 'start_new_allowed',
      canStartNew: true,
    });
    expect(JSON.stringify(status.body)).not.toContain('TRAINING_PLAN_PREVIEW_STALE');
  });

  it('CAS-reclaims an expired fenced attempt with the same key after a valid fresh re-preview changes context', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Advanced', available_equipment: 'Full gym' }
        : null
    ));
    const request = {
      objective: 'Fresh reviewed context',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
    };
    const preview = await dispatch('POST', '/plan/preview', {}, request);
    expect(preview.statusCode).toBe(200);
    const idempotencyKey = 'ios:create:expired-context-repreview';
    const oldClaim = claimTrainingPlanGenerationIdempotency(
      12,
      12,
      idempotencyKey,
      '0'.repeat(64),
    );
    expect(oldClaim.kind).toBe('claimed');
    testDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(idempotencyKey);
    const before = testDb.prepare(`
      SELECT request_hash, lease_owner, fencing_token, attempt_count
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(idempotencyKey) as Record<string, unknown>;

    const create = await dispatch('POST', '/plan/generate', {}, {
      ...request,
      idempotencyKey,
      previewToken: preview.body.data.previewToken,
    });

    expect(create.statusCode).toBe(201);
    const after = testDb.prepare(`
      SELECT request_hash, lease_owner, fencing_token, attempt_count, status
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(idempotencyKey) as Record<string, unknown>;
    expect(after).toMatchObject({ attempt_count: 2, status: 'succeeded' });
    expect(after.request_hash).not.toBe(before.request_hash);
    expect(after.lease_owner).not.toBe(before.lease_owner);
    expect(after.fencing_token).not.toBe(before.fencing_token);
    expect(mockCreatePlan).toHaveBeenCalledOnce();
  });

  it('does not mutate an expired fenced attempt when the fresh preview token is tampered', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Intermediate', available_equipment: 'Full gym' }
        : null
    ));
    const request = {
      objective: 'Tamper-safe re-preview',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
    };
    const preview = await dispatch('POST', '/plan/preview', {}, request);
    const idempotencyKey = 'ios:create:expired-tampered-repreview';
    claimTrainingPlanGenerationIdempotency(12, 12, idempotencyKey, '1'.repeat(64));
    testDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(idempotencyKey);
    const before = testDb.prepare(`
      SELECT request_hash, lease_owner, fencing_token, attempt_count, status
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(idempotencyKey);
    const token = String(preview.body.data.previewToken);

    const create = await dispatch('POST', '/plan/generate', {}, {
      ...request,
      idempotencyKey,
      previewToken: `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
    });

    expect(create.statusCode).toBe(409);
    expect(create.body.error.code).toBe('TRAINING_PLAN_PREVIEW_STALE');
    expect(testDb.prepare(`
      SELECT request_hash, lease_owner, fencing_token, attempt_count, status
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(idempotencyKey)).toEqual(before);
    expect(mockCreatePlan).not.toHaveBeenCalled();
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

  it.each([
    {
      label: 'generation',
      operation: 'calendar_generate' as const,
      path: '/plan/generate',
      body: {
        objective: 'General fitness',
        preferredTime: '12:00',
        sessionsPerWeek: 3,
        strengthSessionsPerWeek: 2,
        idempotencyKey: 'f35-generation-lock-contention',
      },
    },
    {
      label: 'calendar sync',
      operation: 'calendar_sync' as const,
      path: '/plan/sync-calendar',
      body: {},
    },
    {
      label: 'calendar reflow',
      operation: 'calendar_reflow' as const,
      path: '/sessions/201/reflow-confirm',
      body: {},
    },
    {
      label: 'plan cancellation',
      operation: 'calendar_cancel' as const,
      path: '/plan/cancel',
      body: {},
    },
    {
      label: 'coach apply',
      operation: 'coach_apply' as const,
      path: '/coach/apply',
      body: { recommendationIds: ['rec-1'] },
    },
  ])('maps $label lock contention to the same retryable, scope-safe HTTP contract', async ({ operation, path, body }) => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Intermediate', available_equipment: 'Full gym' }
        : null
    ));
    mockWithTrainingCalendarOperationLock.mockRejectedValueOnce(
      poisonedTrainingOperationLockError(operation),
    );

    const res = await dispatch('POST', path, {}, body);

    expectSafeTrainingOperationError(res, {
      status: 409,
      code: 'TRAINING_OPERATION_LOCKED',
      message: 'Another training operation is in progress. Please try again shortly.',
      operation,
      retryAfterSeconds: 30,
    });
    expect(mockWithTrainingCalendarOperationLock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12, tenantId: 12, operation }),
      expect.any(Function),
    );
  });

  it('maps operation-lock infrastructure unavailability deliberately instead of collapsing it into INTERNAL', async () => {
    mockWithTrainingCalendarOperationLock.mockRejectedValueOnce(
      poisonedTrainingOperationLockUnavailableError('calendar_sync'),
    );

    const res = await dispatch('POST', '/plan/sync-calendar', {}, {});

    expectSafeTrainingOperationError(res, {
      status: 503,
      code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
      message: 'Training operations are temporarily unavailable. Please try again shortly.',
      operation: 'calendar_sync',
      retryAfterSeconds: 5,
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
    expect(res.body.data).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'needs_profile',
    });
    expect(res.body.data.needsProfile).toBe(true);
    expect(res.body.data.requiredQuestionnaireId).toBe('triathlon-running');
    expect(res.body.data.requiredQuestionnaireTitle).toContain('Running');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('marks needs-profile plan generation idempotency rows failed so retry re-runs', async () => {
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([{ key: 'fitness_goal', prompt: 'Goal?' }]);

    const body = {
      objective: 'General fitness',
      preferredTime: '12:00',
      idempotencyKey: 'needs-profile-retry-key',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    expect(first.statusCode).toBe(200);
    expect(first.body.data.needsProfile).toBe(true);
    expect(trainingGenerationIdempotencyRow('needs-profile-retry-key')?.status).toBe('failed');

    mockGetMissingProfileFields.mockClear();
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(second.statusCode).toBe(200);
    expect(second.body.data.needsProfile).toBe(true);
    expect(mockGetMissingProfileFields).toHaveBeenCalled();
    expect(trainingGenerationIdempotencyRow('needs-profile-retry-key')?.status).toBe('failed');
  });

  it('blocks event-based generated plans before writes when the race date is missing', async () => {
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
      goalMode: 'event_based',
    });

    // F27 stronger guarantee: a quality-gate block is a typed semantic
    // rejection, while profile/answer clarification handoffs remain 200.
    expect(res.statusCode).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TRAINING_PLAN_QUALITY_BLOCKED');
    expect(res.body.error.details).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'plan_quality_blocked',
    });
    expect(res.body.error.details.planLint.status).toBe('fail');
    expect(res.body.error.details.planLint.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'race_specific_plan_requires_race_date' }),
      ]),
    );
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('marks quality-gate idempotency rows failed so retry re-runs generation', async () => {
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
    const body = {
      objective: 'Lisbon Marathon',
      preferredTime: '07:00',
      goalMode: 'event_based',
      idempotencyKey: 'quality-gate-retry-key',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    // F27 stronger guarantee: retryable quality rejection uses the typed 422
    // envelope without changing the idempotency row's retry semantics.
    expect(first.statusCode).toBe(422);
    expect(first.body.error.details.status).toBe('plan_quality_blocked');
    expect(trainingGenerationIdempotencyRow('quality-gate-retry-key')?.status).toBe('failed');

    mockBuildCoachKernelTrainingPlan.mockClear();
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(second.statusCode).toBe(422);
    expect(second.body.error.details.status).toBe('plan_quality_blocked');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalled();
    expect(trainingGenerationIdempotencyRow('quality-gate-retry-key')?.status).toBe('failed');
  });

  it('marks clarification idempotency rows failed so retry re-runs generation', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate' };
      if (profile === 'triathlon-gym') return {};
      return null;
    });
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'unknown',
      canonicalProfile: { items: [] },
    });

    const body = {
      objective: 'Build muscle with a 5-day gym plan',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      idempotencyKey: 'clarification-retry-key',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'needs_clarification',
    });
    expect(trainingGenerationIdempotencyRow('clarification-retry-key')?.status).toBe('failed');

    mockBuildCoachKernelTrainingPlan.mockClear();
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(second.statusCode).toBe(200);
    expect(second.body.data.status).toBe('needs_clarification');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalled();
    expect(trainingGenerationIdempotencyRow('clarification-retry-key')?.status).toBe('failed');
  });

  it('creates continuous marathon-style plans without forcing a race date', async () => {
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
            description: 'Easy aerobic run.',
            exercises: [],
          },
        ],
      },
    ]));

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon',
      preferredTime: '07:00',
      goalMode: 'continuous',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'created',
    });
    expect(res.body.data.status).not.toBe('plan_quality_blocked');
    expect(mockCreatePlan).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalled();
    // Phase 1B: provider calendar events are created by the background
    // calendar-sync worker after activation, never inline in the route.
    expect(mockCreateEvent).not.toHaveBeenCalled();
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
    // Phase 1B: the separate preferred times are proven on the persisted
    // schedule windows (the calendar-sync worker rebuilds provider event
    // times from these rows) instead of on inline provider calls.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const createdSessions = mockCreateSession.mock.calls.map((call) => call[0] as Record<string, unknown>);
    // Exact-title match: volume enforcement adds filler sessions like
    // 'Runner Strength Support' on other days that a substring match would
    // wrongly capture.
    const runEvent = createdSessions.find((session) => session.title === 'Base Run');
    const gymEvent = createdSessions.find((session) => session.title === 'Runner Strength');

    expect(runEvent).toBeTruthy();
    expect(gymEvent).toBeTruthy();

    const runStart = new Date(String(runEvent!.scheduled_start_at));
    const gymStart = new Date(String(gymEvent!.scheduled_start_at));
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
    mockGetPlanById.mockReturnValue({ id: first.body.data.planId, user_id: 12, tenant_id: 12, status: 'active' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 3001, plan_id: first.body.data.planId, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([{ id: 4001, plan_id: first.body.data.planId, week_id: 3001, status: 'scheduled' }]);
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(createPlanCountAfterFirst).toBeGreaterThan(0);
    expect(createSessionCountAfterFirst).toBeGreaterThan(0);
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(mockCreateSession).toHaveBeenCalledTimes(createSessionCountAfterFirst);
    // Phase 1B: routes never call providers — the replay guarantee for
    // provider events is now the worker's ownership idempotency, covered in
    // the training-plan-calendar-sync worker suite.
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('retains a succeeded receipt and blocks regeneration when the referenced plan no longer exists', async () => {
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
    mockCreatePlan.mockReturnValueOnce({ id: 901 });

    const body = {
      objective: 'General fitness',
      preferredTime: '12:00',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 3,
      idempotencyKey: 'plan-create-stale',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    mockGetPlanById.mockReturnValue(null);

    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(first.body.data.planId).toBe(901);
    // Stronger guarantee: a missing read-model graph is not proof that the
    // successful create never happened. Preserve the receipt and require
    // reconciliation instead of resurrecting the plan with the same key.
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe('TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED');
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(trainingGenerationIdempotencyRow('plan-create-stale')?.status).toBe('succeeded');
  });

  it('maps an unreadable succeeded receipt to reconciliation without mutating or regenerating', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Intermediate', available_equipment: 'Full gym' }
        : null
    ));
    const body = {
      objective: 'Corrupt receipt recovery',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
      idempotencyKey: 'plan-create-corrupt-receipt',
    };
    const first = await dispatch('POST', '/plan/generate', {}, body);
    expect(first.statusCode).toBe(201);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    testDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET response_json = '{not-json'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(body.idempotencyKey);

    const second = await dispatch('POST', '/plan/generate', {}, body);

    // Stronger guarantee: an unreadable successful result is reconciliation
    // evidence, not key reuse, in-flight work, or permission to create again.
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
      details: { idempotencyKey: body.idempotencyKey },
    });
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(testDb.prepare(`
      SELECT status, response_json
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(body.idempotencyKey)).toMatchObject({
      status: 'succeeded',
      response_json: '{not-json',
    });
  });

  it.each([
    {
      reason: 'plan_owner_mismatch',
      expectedCode: 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 99, tenant_id: 12, status: 'active' });
      },
    },
    {
      reason: 'plan_owner_mismatch',
      expectedCode: 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 12, tenant_id: 34, status: 'active' });
      },
    },
    {
      reason: 'plan_not_active',
      expectedCode: 'TRAINING_PLAN_GENERATION_ALREADY_COMPLETED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 12, tenant_id: 12, status: 'canceled' });
        mockGetWeeksForPlan.mockReturnValue([{ id: 3003, plan_id: planId, week_number: 1 }]);
        mockGetSessionsForWeek.mockReturnValue([{ id: 4003, plan_id: planId, week_id: 3003 }]);
      },
    },
    {
      reason: 'plan_superseded',
      expectedCode: 'TRAINING_PLAN_GENERATION_ALREADY_COMPLETED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 12, tenant_id: 12, status: 'superseded' });
        mockGetWeeksForPlan.mockReturnValue([{ id: 3003, plan_id: planId, week_number: 1 }]);
        mockGetSessionsForWeek.mockReturnValue([{ id: 4003, plan_id: planId, week_id: 3003 }]);
      },
    },
    {
      reason: 'plan_has_no_weeks',
      expectedCode: 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 12, tenant_id: 12, status: 'active' });
        mockGetWeeksForPlan.mockReturnValue([]);
      },
    },
    {
      reason: 'plan_has_no_sessions',
      expectedCode: 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
      configureProof: (planId: number) => {
        mockGetPlanById.mockReturnValue({ id: planId, user_id: 12, tenant_id: 12, status: 'active' });
        mockGetWeeksForPlan.mockReturnValue([{ id: 3003, plan_id: planId, week_number: 1 }]);
        mockGetSessionsForWeek.mockReturnValue([]);
      },
    },
  ])('retains a confirmed receipt and blocks regeneration when proof resolves to $reason', async ({ configureProof, expectedCode }) => {
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
      idempotencyKey: 'plan-create-stale-proof',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    configureProof(Number(first.body.data.planId));

    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    // Stronger guarantee: lifecycle drift and integrity uncertainty never
    // authorize a second mutation for a receipt that already says succeeded.
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe(expectedCode);
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(trainingGenerationIdempotencyRow('plan-create-stale-proof')?.status).toBe('succeeded');
  });

  it('retains the succeeded receipt and returns 503 when replay proof lookup throws', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T06:00:00.000Z'));
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'Intermediate', available_equipment: 'Full gym' }
        : null
    ));
    const body = {
      objective: 'General fitness',
      preferredTime: '12:00',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 3,
      idempotencyKey: 'plan-create-proof-read-failure',
    };
    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    mockGetPlanById.mockImplementation(() => {
      throw new Error('private DB path must not escape');
    });

    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(503);
    expect(second.body.error.code).toBe('TRAINING_PLAN_GENERATION_STATUS_UNAVAILABLE');
    expect(JSON.stringify(second.body)).not.toContain('private DB path');
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(trainingGenerationIdempotencyRow('plan-create-proof-read-failure')?.status).toBe('succeeded');
  });

  it('returns 409 when a stale confirmed replay reappears after discard', async () => {
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
      idempotencyKey: 'plan-create-stale-reappears',
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    testDb.exec(`
      CREATE TRIGGER training_idempotency_reappears_after_delete
      AFTER DELETE ON training_plan_generation_idempotency_scoped
      WHEN OLD.idempotency_key = 'plan-create-stale-reappears'
      BEGIN
        INSERT INTO training_plan_generation_idempotency_scoped (
          user_id, tenant_id, idempotency_key, request_hash, status,
          response_json, status_code, created_at, updated_at
        ) VALUES (
          OLD.user_id, OLD.tenant_id, OLD.idempotency_key, OLD.request_hash,
          'succeeded', OLD.response_json, OLD.status_code, OLD.created_at, OLD.updated_at
        );
      END;
    `);
    mockGetPlanById.mockReturnValue(null);

    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    // Stronger guarantee: the route no longer deletes a successful receipt,
    // so this trigger never fires and the original row remains authoritative.
    expect(second.body.error.code).toBe('TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED');
    expect(second.body.error.details).toEqual(expect.objectContaining({
      idempotencyKey: 'plan-create-stale-reappears',
    }));
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
  });

  it('auto-dedupes rapid duplicate plan creation when the client omits an idempotency key', async () => {
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
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    const createSessionCountAfterFirst = mockCreateSession.mock.calls.length;
    const createEventCountAfterFirst = mockCreateEvent.mock.calls.length;
    mockGetPlanById.mockReturnValue({ id: first.body.data.planId, user_id: 12, tenant_id: 12, status: 'active' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 3002, plan_id: first.body.data.planId, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([{ id: 4002, plan_id: first.body.data.planId, week_id: 3002, status: 'scheduled' }]);
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(mockCreateSession).toHaveBeenCalledTimes(createSessionCountAfterFirst);
    expect(mockCreateEvent).toHaveBeenCalledTimes(createEventCountAfterFirst);
  });

  it('regenerates instead of replaying the auto-deduped plan after a clarification answer changes the profile', async () => {
    // Phase 2 (F2): clarification answers live in PROFILES, not the request
    // body. Without the answers fingerprint in the request hash, an athlete
    // who answers a clarification and immediately retries the identical
    // request inside the 90s auto-dedupe window would get the stale
    // pre-answer plan replayed — silently discarding their answer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T12:00:10.000Z'));

    let gymProfile: Record<string, unknown> = {};
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'Intermediate', available_equipment: 'Full gym' };
      if (profile === 'triathlon-gym') return gymProfile;
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
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    expect(first.statusCode).toBe(201);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    expect(createPlanCountAfterFirst).toBeGreaterThan(0);

    // The athlete answers a clarification through the canonical profile
    // path, then retries the same request seconds later.
    gymProfile = { session_duration_minutes: 60 };
    vi.setSystemTime(new Date('2026-04-15T12:00:20.000Z'));
    mockGetPlanById.mockReturnValue({ id: first.body.data.planId, user_id: 12, tenant_id: 12, status: 'active' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 3005, plan_id: first.body.data.planId, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([{ id: 4005, plan_id: first.body.data.planId, week_id: 3005, status: 'scheduled' }]);
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(second.statusCode).toBe(201);
    // A changed answer must change the request hash → fresh generation, not
    // a replay of the pre-answer plan.
    expect(mockCreatePlan.mock.calls.length).toBe(createPlanCountAfterFirst + 1);
  });

  it('auto-dedupes rapid duplicate plan creation across a minute boundary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T12:00:59.500Z'));

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
    };

    const first = await dispatch('POST', '/plan/generate', {}, body);
    const createPlanCountAfterFirst = mockCreatePlan.mock.calls.length;
    const createSessionCountAfterFirst = mockCreateSession.mock.calls.length;

    vi.setSystemTime(new Date('2026-04-15T12:01:00.500Z'));
    mockGetPlanById.mockReturnValue({ id: first.body.data.planId, user_id: 12, tenant_id: 12, status: 'active' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 3003, plan_id: first.body.data.planId, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([{ id: 4003, plan_id: first.body.data.planId, week_id: 3003, status: 'scheduled' }]);
    const second = await dispatch('POST', '/plan/generate', {}, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(createPlanCountAfterFirst).toBeGreaterThan(0);
    expect(createSessionCountAfterFirst).toBeGreaterThan(0);
    expect(mockCreatePlan).toHaveBeenCalledTimes(createPlanCountAfterFirst);
    expect(mockCreateSession).toHaveBeenCalledTimes(createSessionCountAfterFirst);
    // Phase 1B: routes never call providers — duplicate-event protection is
    // the worker's ownership idempotency, covered in its own suite.
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('keeps stale automatic plan-generation claims in progress while the first request is still running', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:slow-provider-request';
    const requestHash = 'same-plan-request-hash';

    const first = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);
    expect(first).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:01:40.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);

    expect(second).toEqual({ kind: 'in_progress', idempotencyKey: key });
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('preserves stale automatic succeeded plan-generation rows as immutable receipts', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:stale-success-request';
    const requestHash = 'same-plan-request-hash';
    const responseData = { planId: 901, resolvedStartDate: '2026-04-20' };

    const first = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);
    expect(first).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });
    if (first.kind !== 'claimed') throw new Error('expected owned claim');
    completeTrainingPlanGenerationIdempotency(12, 12, first, responseData, 201);

    vi.setSystemTime(new Date('2026-04-15T12:01:40.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);

    // Stronger guarantee: even server-generated keys cannot turn a successful
    // receipt into authority for a second plan mutation after a time window.
    expect(second).toEqual({
      kind: 'replay',
      idempotencyKey: key,
      responseData,
      statusCode: 201,
    });
  });

  it('replays slow automatic plan-generation successes from completion time', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:slow-success-request';
    const requestHash = 'same-plan-request-hash';
    const responseData = { planId: 902, resolvedStartDate: '2026-04-20' };

    const first = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);
    expect(first).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:02:00.000Z'));
    if (first.kind !== 'claimed') throw new Error('expected owned claim');
    completeTrainingPlanGenerationIdempotency(12, 12, first, responseData, 201);

    vi.setSystemTime(new Date('2026-04-15T12:02:01.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 12, key, requestHash);

    expect(second).toEqual({
      kind: 'replay',
      idempotencyKey: key,
      responseData,
      statusCode: 201,
    });
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
          code: 'session_compressed',
          text: 'Compressed because only one valid training window was available.',
          severity: 'info',
          sourceConstraint: {
            type: 'capacity',
            label: 'capacity_reconciliation',
          },
          affectedEntity: { type: 'week', id: 'week-1' },
          before: { minutes: 45 },
          after: { minutes: 25 },
          evidence: ['one_valid_training_window'],
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
    // F12 stronger guarantee: adding the race-date policy disclosure must
    // preserve pre-existing canonical kernel reasons instead of replacing
    // them, and every returned reason must use the typed wire vocabulary.
    expect(res.body.data.decisionReasons).toEqual([
      expect.objectContaining({
        code: 'session_compressed',
        sourceConstraint: expect.objectContaining({
          type: 'capacity',
          label: 'capacity_reconciliation',
        }),
      }),
      expect.objectContaining({
        code: 'race_date_implies_event_based',
        before: { goalMode: null },
        after: { goalMode: 'event_based' },
      }),
    ]);
  });

  it('marks a session as skipped and returns updated weekly adherence', async () => {
    mockGetActivePlan.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12 });
    mockGetCurrentWeek.mockReturnValue({ id: 78 });
    mockGetSessionsForWeek.mockReturnValue([
      { id: 321, day_of_week: resolveTrainingDay().weekdayName, status: 'pending', plan_id: 44 },
    ]);
    // Hardening 2026-04-21: ownership gate reads these.
    mockGetSessionById.mockReturnValue({ id: 321, plan_id: 44 });
    mockGetPlanById.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12 });
    mockGetWeeklyAdherence.mockReturnValue({ adherenceRate: 40 });

    const res = await dispatch('POST', '/skip', {}, { sessionId: 'today' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.skipped).toBe(true);
    expect(res.body.data.weeklyAdherence).toBe(0.4);
    // F18 strengthens the released skip path: even feedback-free skips write a
    // canonical completion row, and that service atomically applies `skipped`.
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 321,
      plan_id: 44,
      completion_state: 'skipped',
    }));
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
  });

  it('F18 — /skip persists released rich feedback instead of dropping it', async () => {
    mockGetSessionById.mockReturnValue({ id: 321, plan_id: 44, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 44, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);
    mockLogCompletion.mockReturnValue({
      id: 9001,
      session_id: 321,
      completion_state: 'skipped',
      readiness_level: 3,
      discomfort_flag: 1,
      discomfort_flags_json: JSON.stringify(['knee']),
      discomfort_locations_json: JSON.stringify(['left_knee']),
      discomfort_details: 'Mild discomfort after warm-up',
      substitutions_used_json: JSON.stringify(['easy_walk']),
      missed_reason: 'schedule_conflict',
      felt_too_hard: 1,
      felt_too_easy: 0,
      felt_too_long: 0,
      felt_too_short: 0,
      modality: 'running',
      session_role: 'quality',
    });

    const res = await dispatch('POST', '/skip', {}, {
      sessionId: '321',
      completionState: 'skipped',
      status: 'skipped',
      skippedReason: 'schedule_conflict',
      readinessLevel: 3,
      discomfortFlag: true,
      discomfortFlags: ['knee'],
      discomfortLocations: ['left_knee'],
      discomfortDetails: 'Mild discomfort after warm-up',
      substitutionsUsed: ['easy_walk'],
      feltTooHard: true,
      modality: 'running',
      sessionRole: 'quality',
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 321,
      plan_id: 44,
      completion_state: 'skipped',
      missed_reason: 'schedule_conflict',
      readiness_level: 3,
      discomfort_flag: true,
      discomfort_flags_json: JSON.stringify(['knee']),
      discomfort_locations_json: JSON.stringify(['left_knee']),
      discomfort_details: 'Mild discomfort after warm-up',
      substitutions_used_json: JSON.stringify(['easy_walk']),
      felt_too_hard: true,
      modality: 'running',
      session_role: 'quality',
    }));
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
    expect(res.body.data).toEqual(expect.objectContaining({
      skipped: true,
      completionState: 'skipped',
      feedback: expect.objectContaining({
        sessionId: '321',
        completionState: 'skipped',
        status: 'skipped',
        readinessLevel: 3,
        discomfortFlag: true,
        discomfortFlags: ['knee'],
        discomfortLocations: ['left_knee'],
        discomfortDetails: 'Mild discomfort after warm-up',
        substitutionsUsed: ['easy_walk'],
        skippedReason: 'schedule_conflict',
        feltTooHard: true,
        modality: 'running',
        sessionRole: 'quality',
      }),
    }));
  });

  it('returns uniform 404 from /skip when the session id belongs to a different user', async () => {
    // Hardening 2026-04-21: Alice (userId=12) must not be able to
    // skip Bob's session by POSTing Bob's session id. Previously
    // the route called markSessionSkipped(rowId) without any plan
    // ownership check — this test pins the new enforcement.
    mockGetSessionById.mockReturnValue({ id: 999, plan_id: 88 });
    mockGetPlanById.mockReturnValue({ id: 88, user_id: 77 }); // Bob owns plan 88

    const res = await dispatch('POST', '/skip', {}, { sessionId: '999' });

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
  });

  it('rejects /skip with 400 when session id is malformed', async () => {
    const res = await dispatch('POST', '/skip', {}, { sessionId: '12.5' });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toContain('sessionId must be a positive integer');
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
  });

  it('returns uniform 404 from /complete when the session id belongs to a different user', async () => {
    mockGetSessionById.mockReturnValue({ id: 999, plan_id: 88 });
    mockGetPlanById.mockReturnValue({ id: 88, user_id: 77 });

    const res = await dispatch('POST', '/complete', {}, { sessionId: '999' });

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects /complete with 400 when session id is malformed', async () => {
    const res = await dispatch('POST', '/complete', {}, { sessionId: 'abc' });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toContain('sessionId must be a positive integer');
  });

  it('F18 — /complete preserves partial state and all released rich feedback aliases', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);
    mockLogCompletion.mockReturnValue({
      id: 9002,
      session_id: 42,
      completion_state: 'partial',
      completed_duration_sec: 28 * 60,
      readiness_level: 4,
      difficulty_feedback: 'hard',
      duration_feedback: 'too_short',
      discomfort_flag: 1,
      discomfort_flags_json: JSON.stringify(['ankle']),
      discomfort_locations_json: JSON.stringify(['right_ankle']),
      discomfort_details: 'Stopped when discomfort increased',
      substitutions_used_json: JSON.stringify(['bike']),
      felt_too_hard: 1,
      felt_too_easy: 0,
      felt_too_long: 0,
      felt_too_short: 1,
      modality: 'running',
      session_role: 'long_run',
    });

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      completionState: 'partial',
      status: 'partial',
      actualDurationMinutes: 28,
      readinessLevel: 4,
      difficulty: 'hard',
      difficultyFeedback: 'hard',
      durationFeedback: 'too_short',
      discomfortFlag: true,
      discomfortFlags: ['ankle'],
      discomfortLocations: ['right_ankle'],
      discomfortDetails: 'Stopped when discomfort increased',
      substitutionsUsed: ['bike'],
      feltTooHard: true,
      feltTooEasy: false,
      feltTooLong: false,
      feltTooShort: true,
      modality: 'running',
      sessionRole: 'long_run',
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 42,
      plan_id: 7,
      completion_state: 'partial',
      completed_duration_sec: 28 * 60,
      readiness_level: 4,
      difficulty_feedback: 'hard',
      duration_feedback: 'too_short',
      discomfort_flag: true,
      discomfort_flags_json: JSON.stringify(['ankle']),
      discomfort_locations_json: JSON.stringify(['right_ankle']),
      discomfort_details: 'Stopped when discomfort increased',
      substitutions_used_json: JSON.stringify(['bike']),
      felt_too_hard: true,
      felt_too_easy: false,
      felt_too_long: false,
      felt_too_short: true,
      modality: 'running',
      session_role: 'long_run',
    }));
    expect(mockMarkSessionCompleted).not.toHaveBeenCalled();
    expect(mockEmitDomainEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        summary: expect.objectContaining({ status: 'partial' }),
      }),
    }));
    expect(res.body.data).toEqual(expect.objectContaining({
      completed: false,
      completionState: 'partial',
      feedback: expect.objectContaining({
        sessionId: '42',
        completionState: 'partial',
        status: 'partial',
        actualDurationMinutes: 28,
        readinessLevel: 4,
        difficulty: 'hard',
        difficultyFeedback: 'hard',
        durationFeedback: 'too_short',
        discomfortFlag: true,
        discomfortFlags: ['ankle'],
        discomfortLocations: ['right_ankle'],
        discomfortDetails: 'Stopped when discomfort increased',
        substitutionsUsed: ['bike'],
        feltTooHard: true,
        feltTooShort: true,
        modality: 'running',
        sessionRole: 'long_run',
      }),
    }));
  });

  it('F18 — completion events expose aggregate flags and a digest-only private key', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);
    mockLogCompletion.mockReturnValue({ id: 9003, completion_state: 'completed' });

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      completionState: 'completed',
      status: 'completed',
      notes: 'PRIVATE_F18_NOTES_SENTINEL',
      rpe: 9,
      painScore: 8,
      painLocation: 'PRIVATE_F18_PAIN_LOCATION',
      discomfortFlag: true,
      discomfortDetails: 'PRIVATE_F18_DISCOMFORT_DETAILS',
    });

    expect(res.statusCode).toBe(200);
    const emitted = mockEmitDomainEvent.mock.calls.at(-1)?.[0] as {
      privacyClassification?: string;
      idempotencyKey?: string;
      payload?: unknown;
    };
    expect(emitted).toBeDefined();
    expect(emitted.privacyClassification).toBe('health');
    expect(emitted.payload).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        status: 'completed',
        hasNotes: true,
        hasRpe: true,
      }),
    }));
    // Stronger F18 guarantee: health values may affect a one-way digest, but
    // no value (including RPE) is a readable segment of the durable key.
    expect(emitted.idempotencyKey).toMatch(
      /^training\.feedback\.recorded:12:42:completed:v2-[0-9a-f]{16}$/,
    );
    expect(emitted.idempotencyKey).not.toContain(':9:');
    const serializedEvent = JSON.stringify(emitted);
    expect(serializedEvent).not.toContain('PRIVATE_F18_NOTES_SENTINEL');
    expect(serializedEvent).not.toContain('PRIVATE_F18_PAIN_LOCATION');
    expect(serializedEvent).not.toContain('PRIVATE_F18_DISCOMFORT_DETAILS');
  });

  it('F18 — conflicting completionState/status aliases return 422 before mutation', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      completionState: 'partial',
      status: 'completed',
    });

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('TRAINING_COMPLETION_STATE_CONFLICT');
    expect(mockLogCompletion).not.toHaveBeenCalled();
    expect(mockMarkSessionCompleted).not.toHaveBeenCalled();
  });

  it('F18 — conflicting skippedReason/missedReason aliases return 422', async () => {
    const res = await dispatch('POST', '/skip', {}, {
      sessionId: '42',
      skippedReason: 'travel',
      missedReason: 'illness',
    });

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('TRAINING_COMPLETION_FEEDBACK_CONFLICT');
    expect(mockLogCompletion).not.toHaveBeenCalled();
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
  });

  it('F18 — absent state keeps the released legacy-completed behavior', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);
    mockMarkSessionCompleted.mockReturnValue(true);

    const res = await dispatch('POST', '/complete', {}, { sessionId: '42' });

    // Stronger contract: only an absent state defaults to completed; explicit
    // partial/skipped values must never pass through this legacy branch.
    expect(res.statusCode).toBe(200);
    expect(mockMarkSessionCompleted).toHaveBeenCalledWith(42);
    expect(res.body.data).toEqual(expect.objectContaining({
      completed: true,
      completionState: 'completed',
    }));
  });

  // ─── R4 P2 #1 — /complete V2 field validation hardening ───
  //
  // Codex caught (R4 P2) that R3's `typeof v === 'number'` accepted
  // NaN and Infinity, and the event hash only fingerprinted field
  // *presence* (so two distinct value payloads collapsed onto the
  // same outbox idempotency key). These tests pin the new behavior:
  // BAD_INPUT bails out *before* any DB access, so no plan/session
  // mocks are needed.

  it('R4 P2 — /complete rejects NaN rir as BAD_INPUT (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      rir: Number.NaN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/rir must be a finite number/);
  });

  it('R4 P2 — /complete rejects Infinity painScore as BAD_INPUT (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      painScore: Number.POSITIVE_INFINITY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/painScore must be a finite number/);
  });

  it('R4 P2 — /complete rejects out-of-range rir > 10 (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      rir: 25,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/rir must be between 0 and 10/);
  });

  it('R4 P2 — /complete rejects negative completedDurationSec (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      completedDurationSec: -120,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/completedDurationSec must be between 0 and 86400/);
  });

  it('R4 P2 — /complete rejects oversized completedSetsJson (400)', async () => {
    const tooBig = 'x'.repeat(9 * 1024); // > 8 KB cap
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      completedSetsJson: tooBig,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/completedSetsJson must be ≤ 8192 characters/);
  });

  it.each([
    ['non-finite rpe', { rpe: Number.NaN }, /rpe must be a finite number/],
    ['null rpe', { rpe: null }, /rpe must be a finite number/],
    ['out-of-range rpe', { rpe: 11 }, /rpe must be between 0 and 10/],
    ['non-string notes', { notes: 42 }, /notes must be a string/],
    ['null notes', { notes: null }, /notes must be a string/],
    ['oversized notes', { notes: 'x'.repeat(1025) }, /notes must be ≤ 1024 characters/],
  ] as const)('F18 — /complete rejects invalid legacy %s before mutation', async (_label, payload, expectedMessage) => {
    // Stronger parity guarantee: legacy fields receive the same finite/range/
    // length validation as rich /complete and /skip feedback.
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      ...payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(expectedMessage);
    expect(mockGetSessionById).not.toHaveBeenCalled();
    expect(mockLogCompletion).not.toHaveBeenCalled();
  });

  it('R4 P2 — /complete returns multiple errors joined when many fields are invalid', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      rir: Number.NaN,
      painScore: 99,
      completedDistanceMeters: Number.NEGATIVE_INFINITY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/rir must be a finite number/);
    expect(res.body.error.message).toMatch(/painScore must be between 0 and 10/);
    expect(res.body.error.message).toMatch(/completedDistanceMeters must be a finite number/);
  });

  // ─── rerun-5 S12 — iOS duration/wellbeing fields must persist ───
  // The iOS feedback sheet sends actualDurationMinutes / energyLevel /
  // sorenessLevel; the route used to silently drop all three, so every
  // iOS completion landed with NULL duration and the cardio chart
  // claimed "No running logged" while history showed the session.

  it('rerun-5 S12 — /complete persists actualDurationMinutes (as seconds), energyLevel, sorenessLevel', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      rpe: 7,
      actualDurationMinutes: 35,
      energyLevel: 6,
      sorenessLevel: 3,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockLogCompletion).toHaveBeenCalledTimes(1);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 42,
      plan_id: 7,
      rpe_overall: 7,
      completed_duration_sec: 35 * 60,
      energy_level: 6,
      soreness_level: 3,
    }));
  });

  it('rerun-6 S12 — /complete derives energy_level from fatigueLevel when energyLevel is absent', async () => {
    // The iOS feedback sheet collects "Fatigue" + "Soreness" only, so
    // it sends fatigueLevel (default 3) + sorenessLevel (default 0) but
    // no energyLevel — which used to leave energy_level NULL while
    // soreness_level was set. Energy is derived as 10 - fatigue.
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      rpe: 7,
      actualDurationMinutes: 25,
      fatigueLevel: 3,
      sorenessLevel: 0,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      completed_duration_sec: 25 * 60,
      energy_level: 7, // 10 - fatigue(3)
      soreness_level: 0,
    }));
  });

  it('rerun-6 S12 — explicit energyLevel wins over the fatigueLevel derivation', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      energyLevel: 9,
      fatigueLevel: 3,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      energy_level: 9,
    }));
  });

  it('rerun-6 S12 — /complete rejects out-of-range fatigueLevel (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      fatigueLevel: 11,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/fatigueLevel must be between 0 and 10/);
  });

  it('rerun-5 S12 — explicit completedDurationSec wins over the actualDurationMinutes alias', async () => {
    mockGetSessionById.mockReturnValue({ id: 42, plan_id: 7, status: 'pending' });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 12, tenant_id: 12 });
    mockGetActivePlan.mockReturnValue(null);

    const res = await dispatch('POST', '/complete', {}, {
      sessionId: '42',
      completedDurationSec: 1900,
      actualDurationMinutes: 35,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogCompletion).toHaveBeenCalledWith(expect.objectContaining({
      completed_duration_sec: 1900,
    }));
  });

  it('rerun-5 S12 — /complete rejects out-of-range actualDurationMinutes and energyLevel (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      actualDurationMinutes: 5000,
      energyLevel: 11,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/actualDurationMinutes must be between 0 and 1440/);
    expect(res.body.error.message).toMatch(/energyLevel must be between 0 and 10/);
  });

  it('R4 P2 — /complete accepts valid V2 payload (soft-success path proves bad-input gate is bypassed)', async () => {
    mockGetActivePlan.mockReturnValue(null);
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      rir: 2,
      painScore: 0,
      completedDurationSec: 1800,
      completedDistanceMeters: 5000,
    });
    // No active plan → soft success (200). Validation passed before
    // reaching the no-active-plan resolver.
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.noActiveSession).toBe(true);
  });

  // R7 P2/P3 — Codex caught the helper accepted explicit null as if
  // the field had been omitted, so `externalTrainingDeclared: null`
  // silently collapsed to false. The R7 contract is reject-on-non
  // -boolean including null; only `undefined` (absent from payload)
  // is omitted.

  it('R7 P2/P3 — /complete rejects explicit externalTrainingDeclared: null (400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      externalTrainingDeclared: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
    expect(res.body.error.message).toMatch(/externalTrainingDeclared must be a boolean/);
  });

  it('R7 P2/P3 — /complete rejects externalTrainingDeclared: "yes" (string, 400)', async () => {
    const res = await dispatch('POST', '/complete', {}, {
      sessionId: 'today',
      externalTrainingDeclared: 'yes',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_INPUT');
  });

  it('R7 P2/P3 — /complete still accepts externalTrainingDeclared: true / false / absent', async () => {
    mockGetActivePlan.mockReturnValue(null);
    for (const payload of [
      { sessionId: 'today', externalTrainingDeclared: true },
      { sessionId: 'today', externalTrainingDeclared: false },
      { sessionId: 'today' /* omitted */ },
    ]) {
      const res = await dispatch('POST', '/complete', {}, payload);
      expect(res.statusCode).toBe(200);
    }
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
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);

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
    expect(JSON.parse(gymCreateInput.exercises_json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'DB Floor Press' }),
        expect.objectContaining({ name: 'Goblet Squat' }),
        expect.objectContaining({ name: 'Romanian Deadlift' }),
      ]),
    );
  });

  it('uses the selected weekly structure for gym-only plans when strength count is omitted', async () => {
    mockGetProfile.mockImplementation((_userId: number, profile: string) => {
      if (profile === 'fitness') return { experienceLevel: 'intermediate', available_equipment: 'Full gym' };
      if (profile === 'triathlon-gym') return { equipment_access: 'Full gym', training_age: 'intermediate' };
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Strength Plan',
      sport: 'gym',
      periodization: 'block',
      weeks: [
        {
          weekNumber: 1,
          focus: 'strength',
          intensityPct: 70,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Upper Strength', durationMinutes: 55 },
            { dayOfWeek: 'Tuesday', sessionType: 'gym', title: 'Lower Strength', durationMinutes: 55 },
            { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Push Hypertrophy', durationMinutes: 55 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Pull Hypertrophy', durationMinutes: 55 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Leg Hypertrophy', durationMinutes: 55 },
          ],
        },
      ],
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Build muscle in the gym',
      sessionsPerWeek: 5,
      preferredTime: '07:00',
      trainingPriority: 'strength',
    });

    expect(res.statusCode).toBe(201);
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    }));
    expect(mockCreateSession).toHaveBeenCalledTimes(5);
  });

  it('rejects impossible race dates before plan generation starts', async () => {
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
      raceDate: '2026-02-30',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RACE_DATE');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects past race dates before plan generation starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Old race',
      raceDate: '2026-06-02',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('PAST_RACE_DATE');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects same-day race dates before plan generation starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Race day is already here',
      raceDate: '2026-06-03',
    });

    // F12 stronger guarantee: the boundary's "future" contract is strict;
    // same-day input fails before the generator and uses the established
    // non-future wire code for client compatibility.
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('PAST_RACE_DATE');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects same-day race dates on the non-mutating preview boundary too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/preview', {}, {
      objective: 'Race day is already here',
      raceDate: '2026-06-03',
    });

    // F12 stronger guarantee: preview and create share the same strict-future
    // wire contract, so a client cannot preview semantics it cannot create.
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('PAST_RACE_DATE');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('returns a typed 422 when a future race date falls before the resolved plan start', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    mockGetProfile.mockImplementation((_userId: number, profile: string) => (
      profile === 'fitness'
        ? { experienceLevel: 'intermediate', available_equipment: 'Full gym' }
        : null
    ));

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General fitness consistency',
      startPolicy: 'next_full_week',
      raceDate: '2026-06-13',
    });

    // F27 stronger guarantee: syntactically valid but semantically impossible
    // input is a versioned 422, not a successful profile handoff or generic 500.
    expect(res.statusCode).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'RACE_DATE_BEFORE_PLAN_START',
      details: {
        schemaVersion: 'training_plan_generation_response.v1',
        status: 'needs_profile',
        validationError: {
          code: 'RACE_DATE_BEFORE_PLAN_START',
          raceDate: '2026-06-13',
          resolvedStartDate: '2026-06-15',
        },
      },
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects unsupported selected-model parameters before generation starts', async () => {
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'General running consistency',
      goalMode: 'race',
      trainingPriority: 'bodybuilding',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_TRAINING_GOAL_MODE');
    expect(res.body.error.details).toEqual({ field: 'goalMode' });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects out-of-range modality targets instead of silently clamping create requests', async () => {
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Olympic triathlon',
      sessionsPerWeek: 7,
      bikeSessionsPerWeek: 8,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_TRAINING_MODALITY_TARGET');
    expect(res.body.error.details).toEqual({ field: 'bikeSessionsPerWeek' });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects unsupported selected-model parameters on plan preview too', async () => {
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/preview', {}, {
      objective: 'General running consistency',
      twoADayPreference: 'sometimes',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_TRAINING_TWO_A_DAY_PREFERENCE');
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('normalizes accepted two-a-day preference casing before forwarding', async () => {
    mockGetProfile.mockReturnValue({ experienceLevel: 'intermediate' });

    const res = await dispatch('POST', '/plan/preview', {}, {
      objective: 'General running consistency',
      twoADayPreference: ' Auto ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      schemaVersion: 'training_plan_generation_response.v1',
      status: 'preview',
    });
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      twoADayPreference: 'auto',
    }));
  });

  it('blocks deterministic fallback persistence when the coach kernel generation fails', async () => {
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

    // F27 stronger guarantee: a fallback that cannot be persisted is an
    // explicit semantic rejection rather than a successful generation.
    expect(res.statusCode).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TRAINING_PLAN_QUALITY_BLOCKED');
    expect(res.body.error.details.status).toBe('plan_quality_blocked');
    expect(res.body.error.details.fallbackTemplateUsed).toBe(true);
    expect(res.body.error.message).toContain('did not save it');
    expect(res.body.error.details.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'fallback_requires_review' }),
      ]),
    );
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('cancels an owned plan, removes linked calendar events, and hard-deletes the plan + cascades', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 44,
      user_id: 12,
      start_date: '2026-05-25T00:00:00.000Z',
      tenant_id: 12,
    });
    mockGetWeeksForPlan.mockReturnValue([{ id: 7001, week_number: 1 }]);
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 321,
        status: 'completed',
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Recovery Run',
        duration_minutes: 30,
        calendar_event_id: 'evt-completed',
        calendar_source: 'outlook',
      },
      {
        id: 322,
        status: 'planned',
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Strength + Core',
        duration_minutes: 40,
        session_identity_key: 'key-322',
        session_shape_hash: 'shape-322',
        calendar_event_id: 'evt-planned',
        calendar_source: 'google',
      },
    ]);
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-orphan-moved',
        source: 'google',
        summary: '💪 Strength + Core (40min)',
        start: '2026-05-31T18:00:00.000Z',
        end: '2026-05-31T18:40:00.000Z',
        description: 'Training moved by the user\n\n[NEXUS_TRAINING_IDENTITY plan=44;version=1;session=322;key=key-322;shape=shape-322]',
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
      removedEvents: 3,
      removedSessions: 2,
      removedWeeks: 1,
      removedCompletions: 1,
      removedPlans: 1,
      totalSessions: 2,
    });
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-completed', 'outlook', 12);
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-planned', 'google', 12);
    expect(mockDeleteEvent).toHaveBeenCalledWith('evt-orphan-moved', 'google', 12);
    expect(mockDeletePlanHard).toHaveBeenCalledWith(44, 12, 12);
    // Hard delete replaces the soft-update path; no per-session
    // status mutations or plan status mutation should fire anymore.
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockUpdatePlanStatus).not.toHaveBeenCalled();
  });

  it('returns uniform no-op from /plan/cancel when a requested plan belongs to another user', async () => {
    mockGetPlanById.mockReturnValue({ id: 99, user_id: 77 });

    const res = await dispatch('POST', '/plan/cancel', {}, { planId: 99 });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      cancelled: false,
      removedEvents: 0,
      removedSessions: 0,
      removedWeeks: 0,
      removedPlans: 0,
      totalSessions: 0,
    });
    expect(mockDeletePlanHard).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('returns uniform 404 from reflow preview for foreign and missing sessions', async () => {
    mockGetSessionById.mockReturnValue({ id: 100, week_id: 70, plan_id: 7 });
    mockGetPlanById.mockReturnValue({ id: 7, user_id: 77, start_date: '2026-04-20T00:00:00.000Z' });

    const foreign = await dispatch('POST', '/sessions/100/reflow-preview', {}, {});

    mockGetSessionById.mockReturnValue(null);
    mockGetPlanById.mockReturnValue(null);

    const missing = await dispatch('POST', '/sessions/100/reflow-preview', {}, {});

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    expect(foreign.body.error).toEqual(expect.objectContaining({
      code: 'NOT_FOUND',
      message: 'Training session not found.',
    }));
  });

  it('returns 503 from reflow preview when live calendar availability is degraded', async () => {
    mockGetSessionById.mockReturnValue({
      id: 200,
      week_id: 700,
      plan_id: 70,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Base Run',
      duration_minutes: 45,
      description: 'Easy aerobic run.',
      status: 'scheduled',
      calendar_event_id: null,
      calendar_source: null,
      session_identity_key: null,
      session_shape_hash: null,
      intensity_text: null,
      exercises_json: null,
      description_json: null,
    });
    mockGetPlanById.mockReturnValue({
      id: 70,
      user_id: 12,
      tenant_id: 12,
      start_date: '2026-06-15T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mockGetWeeksForPlan.mockReturnValue([{ id: 700, week_number: 1 }]);
    mockLoadLiveCalendarBusyWindows.mockResolvedValueOnce({
      windows: [],
      degraded: true,
      providerConfigured: true,
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
    });

    const res = await dispatch('POST', '/sessions/200/reflow-preview', {}, { calendarSource: 'google' });

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'TRAINING_CALENDAR_AVAILABILITY_UNAVAILABLE',
      message: 'Calendar availability could not be checked right now.',
    });
    expect(res.body.error.details).toMatchObject({
      reason: 'TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED',
      provider: 'google',
      sessionId: 200,
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
    });
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('returns 503 from reflow confirm when live calendar availability is degraded', async () => {
    mockGetSessionById.mockReturnValue({
      id: 201,
      week_id: 701,
      plan_id: 71,
      day_of_week: 'Tuesday',
      session_type: 'run',
      title: 'Tempo Run',
      duration_minutes: 50,
      description: 'Controlled tempo.',
      status: 'scheduled',
      calendar_event_id: null,
      calendar_source: null,
      session_identity_key: null,
      session_shape_hash: null,
      intensity_text: null,
      exercises_json: null,
      description_json: null,
    });
    mockGetPlanById.mockReturnValue({
      id: 71,
      user_id: 12,
      tenant_id: 12,
      start_date: '2026-06-15T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mockGetWeeksForPlan.mockReturnValue([{ id: 701, week_number: 1 }]);
    mockLoadLiveCalendarBusyWindows.mockResolvedValueOnce({
      windows: [],
      degraded: true,
      providerConfigured: true,
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook Calendar is unavailable right now.'],
    });

    const res = await dispatch('POST', '/sessions/201/reflow-confirm', {}, { calendarSource: 'outlook' });

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'TRAINING_CALENDAR_AVAILABILITY_UNAVAILABLE',
      message: 'Calendar availability could not be checked right now.',
    });
    expect(res.body.error.details).toMatchObject({
      reason: 'TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED',
      provider: 'outlook',
      sessionId: 201,
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
    });
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('returns uniform 404 from reflow confirm for foreign and missing sessions', async () => {
    mockGetSessionById.mockReturnValue({ id: 101, week_id: 71, plan_id: 8 });
    mockGetPlanById.mockReturnValue({ id: 8, user_id: 77, start_date: '2026-04-20T00:00:00.000Z' });

    const foreign = await dispatch('POST', '/sessions/101/reflow-confirm', {}, {});

    mockGetSessionById.mockReturnValue(null);
    mockGetPlanById.mockReturnValue(null);

    const missing = await dispatch('POST', '/sessions/101/reflow-confirm', {}, {});

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    expect(foreign.body.error).toEqual(expect.objectContaining({
      code: 'NOT_FOUND',
      message: 'Training session not found.',
    }));
    expect(mockUpdateSession).not.toHaveBeenCalled();
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
      calendarSyncState: 'not_requested',
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
