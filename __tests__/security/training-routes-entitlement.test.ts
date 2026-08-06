import express from 'express';
import http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateCoachBriefing = vi.fn();
const mockApplyCoachRecommendations = vi.fn();
const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockRestoreCoachBriefingFromLatestReport = vi.fn();
const mockMarkKeepOriginalForToday = vi.fn();
const mockPreviewTrainingAdaptation = vi.fn();
const mockRequestTrainingAdaptationReview = vi.fn();
const mockSelectTrainingAdaptationOption = vi.fn();
const mockGetTrainingAdaptationOptionEnvelope = vi.fn();
const mockGetEffectiveEntitlement = vi.fn();
const mockIsSkillAllowedByEntitlement = vi.fn();
const mockIsUserOverDailyCap = vi.fn();
const mockGetActivePlan = vi.fn();

let lockTail: Promise<unknown> = Promise.resolve();

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
  applyCoachRecommendation: vi.fn(),
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/services/training-keep-original', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-keep-original')>(
    '../../src/services/training-keep-original'
  )),
  markKeepOriginalForToday: (...args: unknown[]) => mockMarkKeepOriginalForToday(...args),
}));

vi.mock('../../src/services/training-adaptation-proposals', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-adaptation-proposals')>(
    '../../src/services/training-adaptation-proposals'
  )),
  previewTrainingAdaptation: (...args: unknown[]) => mockPreviewTrainingAdaptation(...args),
  requestTrainingAdaptationReview: (...args: unknown[]) => mockRequestTrainingAdaptationReview(...args),
  selectTrainingAdaptationOption: (...args: unknown[]) => mockSelectTrainingAdaptationOption(...args),
  getTrainingAdaptationOptionEnvelope: (...args: unknown[]) => mockGetTrainingAdaptationOptionEnvelope(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCacheStoreStats: vi.fn(() => ({
    initCalls: 0,
    initFailures: 0,
    readCount: 0,
    swrReadCount: 0,
    hitCount: 0,
    missCount: 0,
    staleHitCount: 0,
    writeCount: 0,
    clearCount: 0,
    clearByPrefixCount: 0,
    expireSweepCount: 0,
    expiredEntriesCleared: 0,
    readErrors: 0,
    writeErrors: 0,
    parseErrors: 0,
    lastErrorAt: null,
    lastErrorOperation: null,
    lastErrorKey: null,
  })),
  _resetCacheStoreStatsForTests: vi.fn(),
  initCacheStore: vi.fn(),
  userCacheKey: vi.fn((_userId: number | undefined, base: string) => base),
  requireUserCacheKey: vi.fn((_userId: number, base: string) => base),
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  getCachedSWR: vi.fn(() => null),
  setCacheSWR: vi.fn(),
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
  clearExpired: vi.fn(),
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
  invalidateTrainingDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/resource-budgets', () => ({
  ensureResourceBudgetTables: vi.fn(),
  consumeResourceBudget: vi.fn(() => ({ allowed: true })),
  capSyncPageSize: vi.fn((rawLimit: unknown) => Number(rawLimit) || 100),
}));

vi.mock('../../src/services/cost-guardrail', () => {
  class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.name = 'AiBudgetError'; this.decision = decision; }
  }
  const withAiBudgetReservation = vi.fn(async (request: any, fn: () => Promise<unknown>) => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const prior = lockTail;
    lockTail = prior.catch(() => undefined).then(() => gate);
    await prior.catch(() => undefined);
    try {
      const quota = mockIsUserOverDailyCap(request.userId);
      if (process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED === 'true' && quota.over) {
        throw new AiBudgetError({
          allowed: false,
          code: 'AI_DAILY_LIMIT_REACHED',
          message: `Daily AI quota reached for the ${quota.plan} plan.`,
          status: 429,
          window: 'daily',
          unblocksAt: quota.resetAt,
          retryAfterSeconds: 60,
          reservedCostUsd: 0.01,
          quota,
        });
      }
      return await fn();
    } finally {
      releaseGate();
    }
  });
  return {
  AiBudgetError,
  buildQuotaExceededPayload: vi.fn((quota: any) => ({ plan: quota.plan, resetAt: quota.resetAt })),
  withAiBudgetReservation,
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
  acquireCostLock: vi.fn(async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const prior = lockTail;
    lockTail = prior.catch(() => undefined).then(() => gate);
    await prior.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  }),
  };
});

vi.mock('../../src/services/entitlement', () => ({
  FREE_TIER_ALLOWED_SKILLS: new Set(['secretary', 'content']),
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  isSkillAllowedByEntitlement: (...args: unknown[]) => mockIsSkillAllowedByEntitlement(...args),
  isCoachBriefingEntitlementEligible: (entitlement: { plan: string; source: string }) =>
    (entitlement.plan === 'pro' || entitlement.plan === 'max') && entitlement.source !== 'beta',
  isPaidAiCostControlsEnforcementEnabled: () => process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED === 'true',
  isAiInteractiveAllowedForRuntime: (entitlement: { aiAccessAllowed?: boolean }) =>
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED !== 'true' || entitlement.aiAccessAllowed === true,
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserByTelegramId: vi.fn(() => null),
  getOwnerBootstrapTelegramId: vi.fn(() => null),
  assertOwnerBootstrapReadyForRuntime: vi.fn(),
  isOwnerBootstrapTelegramId: vi.fn(() => false),
  getOrCreateUser: vi.fn(),
  getUserById: vi.fn(() => null),
  resolveCanonicalUserId: vi.fn((userRef: number) => userRef),
  getOwnerBootstrapUser: vi.fn(() => null),
  getOwnerBootstrapTarget: vi.fn(() => null),
  getActiveUserTargets: vi.fn(() => []),
  getOwnerBootstrapUserRefs: vi.fn(() => []),
  getOrCreateInviteSandboxUser: vi.fn(),
  resolveIosInviteRegistrationTarget: vi.fn(() => ({ kind: 'invalid' })),
  isOwnerUserRef: vi.fn(() => false),
  sanitizeDisplayName: vi.fn((value: string | null | undefined) => value ?? ''),
  getPreferredDisplayName: vi.fn(() => 'Test User'),
  getPreferredDisplayNameById: vi.fn(() => 'Test User'),
  getUserByAppleId: vi.fn(() => null),
  getUserByGoogleId: vi.fn(() => null),
  getUserByEmail: vi.fn(() => null),
  createAppleUser: vi.fn(),
  createGoogleUser: vi.fn(),
  createEmailUser: vi.fn(),
  emitProviderLinkedAudit: vi.fn(),
  isUserAuthorized: vi.fn(() => true),
  isOwner: vi.fn(() => false),
  touchUser: vi.fn(),
  getUserLanguageById: vi.fn(() => 'en-US'),
  getUserLanguage: vi.fn(() => 'en-US'),
  getUserTimezone: vi.fn(() => 'UTC'),
  getUserTimezoneById: vi.fn(() => 'UTC'),
  setUserLanguage: vi.fn(),
  listUsers: vi.fn(() => []),
  listUsersInternal: vi.fn(() => []),
  setUserStatus: vi.fn(),
  setUserStatusById: vi.fn(),
  setUserTier: vi.fn(),
  setUserLimits: vi.fn(),
  createInviteCode: vi.fn(() => 'TEST-CODE'),
  validateAndConsumeInviteCode: vi.fn(() => ({ valid: false })),
  listInviteCodes: vi.fn(() => []),
  deleteInviteCode: vi.fn(() => false),
  seedOwnerUser: vi.fn(),
}));

vi.mock('../../src/api/routes/training-coach-briefing', () => ({
  COACH_BRIEFING_TTL: 21_600,
  normalizeCoachRecommendation: vi.fn((rec: Record<string, unknown>) => rec),
  getCoachBriefingSnapshot: vi.fn(() => null),
  restoreCoachBriefingFromLatestReport: (...args: unknown[]) => (
    mockRestoreCoachBriefingFromLatestReport(...args)
  ),
  syncCoachStateForUser: vi.fn((_userId: number, payload: unknown) => payload),
}));

vi.mock('../../src/api/routes/training-read-models', () => ({
  adaptDtoSessionForReadiness: vi.fn((session: unknown) => session),
  getReadiness: vi.fn(async () => null),
  getTodaySession: vi.fn(async () => null),
  getAllPlanWeeks: vi.fn(() => []),
  getWeekPlan: vi.fn(() => ({ sessions: [] })),
  fetchCurrentReadinessForPlan: vi.fn(async () => null),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: vi.fn(() => ({ signals: [], counts: { total: 0, urgent: 0 } })),
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

import { requireEntitlement } from '../../src/api/entitlement-middleware';
import { trainingRoutes } from '../../src/api/routes/training';

function setPlan(plan: 'free' | 'pro'): void {
  mockGetEffectiveEntitlement.mockReturnValue({
    plan,
    source: 'subscription',
    aiAccessAllowed: plan === 'pro',
    blockReason: plan === 'free' ? 'plan_required' : null,
    allowedSkills: plan === 'free' ? new Set(['secretary']) : new Set(['training']),
    evaluatedAt: '2026-05-08T00:00:00.000Z',
  });
  mockIsSkillAllowedByEntitlement.mockImplementation((entitlement: { allowedSkills: Set<string> }, skill: string) => (
    entitlement.allowedSkills.has(skill)
  ));
}

async function requestCoach(
  method: 'GET' | 'POST',
  path: string,
  userId = 42,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    (req as any).tenantId = userId;
    next();
  });
  app.use('/training', requireEntitlement({ skill: 'training' }), trainingRoutes());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');

  try {
    return await new Promise((resolve, reject) => {
      const requestBody = body === undefined ? null : JSON.stringify(body);
      const requestOptions: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: address.port,
        method,
        path,
      };
      if (requestBody !== null) {
        requestOptions.headers = {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
        };
      }
      const req = http.request(requestOptions, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: data ? JSON.parse(data) : null,
        }));
      });
      req.on('error', reject);
      if (requestBody !== null) req.write(requestBody);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getCoach(userId = 42): Promise<{ status: number; body: any }> {
  return requestCoach('GET', '/training/coach?refresh=true', userId);
}

const productTrainingRouteCases = [
  {
    name: 'coach apply',
    method: 'POST' as const,
    path: '/training/coach/apply',
    body: { recommendationIds: ['recommendation-1'] },
    handler: mockApplyCoachRecommendations,
  },
  {
    name: 'keep original',
    method: 'POST' as const,
    path: '/training/today/keep-original',
    body: {},
    handler: mockMarkKeepOriginalForToday,
  },
  {
    name: 'adaptation preview',
    method: 'POST' as const,
    path: '/training/adaptations/preview',
    body: {
      eventId: 'event-1',
      currentRevisionId: 'revision-1',
      expectedContentHash: 'a'.repeat(64),
      contextVersion: 'context-1',
      requestedScope: 'SESSION',
      trigger: 'REFLOW',
      target: { workoutKey: 'week-1-monday' },
    },
    handler: mockPreviewTrainingAdaptation,
  },
  {
    name: 'adaptation review request',
    method: 'POST' as const,
    path: '/training/adaptations/adaptation-1/request-review',
    body: {
      optionId: 'option-1',
      expectedCurrentRevisionId: 'revision-1',
      expectedContextVersion: 'context-1',
    },
    handler: mockRequestTrainingAdaptationReview,
  },
  {
    name: 'adaptation option selection',
    method: 'POST' as const,
    path: '/training/adaptations/adaptation-1/select-option',
    body: {
      optionId: 'option-1',
      expectedCurrentRevisionId: 'revision-1',
      expectedContextVersion: 'context-1',
    },
    handler: mockSelectTrainingAdaptationOption,
  },
  {
    name: 'adaptation envelope read',
    method: 'GET' as const,
    path: '/training/adaptations/adaptation-1',
    body: undefined,
    handler: mockGetTrainingAdaptationOptionEnvelope,
  },
] as const;

describe('training routes entitlement and AI cost guardrails', () => {
  beforeEach(() => {
    lockTail = Promise.resolve();
    mockGenerateCoachBriefing.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockRestoreCoachBriefingFromLatestReport.mockReset();
    mockMarkKeepOriginalForToday.mockReset();
    mockPreviewTrainingAdaptation.mockReset();
    mockRequestTrainingAdaptationReview.mockReset();
    mockSelectTrainingAdaptationOption.mockReset();
    mockGetTrainingAdaptationOptionEnvelope.mockReset();
    mockGetEffectiveEntitlement.mockReset();
    mockIsSkillAllowedByEntitlement.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetActivePlan.mockReset();
    mockGetCached.mockReturnValue(null);
    mockRestoreCoachBriefingFromLatestReport.mockReturnValue(null);
    mockApplyCoachRecommendations.mockResolvedValue({ count: 1, appliedRecommendations: [] });
    mockPreviewTrainingAdaptation.mockReturnValue({ schemaVersion: 'training_adaptation_api.v1' });
    mockRequestTrainingAdaptationReview.mockResolvedValue({
      schemaVersion: 'training_adaptation_api.v1',
      status: 'PENDING_REVIEW',
    });
    mockSelectTrainingAdaptationOption.mockReturnValue({
      schemaVersion: 'training_adaptation_api.v1',
      status: 'SELECTED',
    });
    mockGetTrainingAdaptationOptionEnvelope.mockReturnValue({
      schemaVersion: 'training_adaptation_api.v1',
      option: { optionId: 'option-1' },
    });
    mockGetActivePlan.mockReturnValue({ id: 1, user_id: 42, tenant_id: 42, status: 'active' });
    mockGenerateCoachBriefing.mockResolvedValue({ message: 'Coach ready.', recommendations: [] });
    delete process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED;
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-05-09T00:00:00.000Z',
    });
  });

  it('blocks free-tier training coach before any AI or cost guardrail fires', async () => {
    setPlan('free');

    const response = await getCoach();

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('TIER_REQUIRED');
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('blocks a free user even when the Training skill is temporarily allow-listed', async () => {
    setPlan('free');
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);

    const response = await getCoach();

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('TIER_REQUIRED');
    expect(mockGetActivePlan).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('rechecks a downgraded entitlement before serving a cached GET coach briefing', async () => {
    setPlan('pro');
    mockGetCached.mockReturnValue({
      briefing: 'Paid snapshot',
      recommendations: [],
      garminData: null,
    });

    const eligible = await requestCoach('GET', '/training/coach');
    expect(eligible.status).toBe(200);
    expect(eligible.body.data.briefing).toBe('Paid snapshot');

    setPlan('free');
    // Let the request reach the route so this proves the route-level coach
    // eligibility gate, rather than the broad Training-skill middleware.
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);
    const downgraded = await requestCoach('GET', '/training/coach');

    expect(downgraded.status).toBe(403);
    expect(downgraded.body.error.code).toBe('TIER_REQUIRED');
    expect(mockGetCached).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('rechecks a downgraded entitlement before serving a cached POST coach report', async () => {
    setPlan('pro');
    mockGetCached.mockReturnValue({
      briefing: 'Paid report snapshot',
      recommendations: [],
      garminData: null,
    });

    const eligible = await requestCoach('POST', '/training/coach/report', 42, {});
    expect(eligible.status).toBe(200);

    setPlan('free');
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);
    const downgraded = await requestCoach('POST', '/training/coach/report', 42, {});

    expect(downgraded.status).toBe(403);
    expect(downgraded.body.error.code).toBe('TIER_REQUIRED');
    expect(mockGetCached).toHaveBeenCalledTimes(1);
    expect(mockRestoreCoachBriefingFromLatestReport).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('rechecks a downgraded entitlement before restoring a POST coach report', async () => {
    setPlan('pro');
    mockRestoreCoachBriefingFromLatestReport.mockReturnValue({
      briefing: 'Restored paid report',
      recommendations: [],
      garminData: null,
      restoredFromReport: true,
    });

    const eligible = await requestCoach('POST', '/training/coach/report', 42, {});
    expect(eligible.status).toBe(200);
    expect(mockRestoreCoachBriefingFromLatestReport).toHaveBeenCalledTimes(1);

    setPlan('free');
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);
    const downgraded = await requestCoach('POST', '/training/coach/report', 42, {});

    expect(downgraded.status).toBe(403);
    expect(downgraded.body.error.code).toBe('TIER_REQUIRED');
    expect(mockRestoreCoachBriefingFromLatestReport).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it.each(productTrainingRouteCases)(
    'denies an ineligible Free entitlement at the production Training mount before $name work',
    async ({ method, path, body, handler }) => {
      setPlan('free');

      const response = await requestCoach(method, path, 42, body);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('TIER_REQUIRED');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'beta'] as const)(
    'keeps %s product-grant access to non-model Training operations without a blanket coach gate',
    async (plan) => {
      mockGetEffectiveEntitlement.mockReturnValue({
        plan,
        source: plan,
        aiAccessAllowed: plan === 'owner',
        blockReason: plan === 'beta' ? 'beta_ai_disabled' : null,
        allowedSkills: new Set(['training']),
        evaluatedAt: '2026-05-08T00:00:00.000Z',
      });
      mockIsSkillAllowedByEntitlement.mockImplementation(
        (entitlement: { allowedSkills: Set<string> }, skill: string) => entitlement.allowedSkills.has(skill),
      );

      for (const routeCase of productTrainingRouteCases) {
        routeCase.handler.mockClear();
        const response = await requestCoach(
          routeCase.method,
          routeCase.path,
          42,
          routeCase.body,
        );

        expect(response.status, routeCase.name).not.toBe(403);
        expect(routeCase.handler, routeCase.name).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('blocks owner and beta bypass entitlements before coach work starts', async () => {
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);

    for (const entitlement of [
      { plan: 'owner', source: 'owner', allowedSkills: new Set(['training']) },
      { plan: 'beta', source: 'beta', allowedSkills: new Set(['training']) },
    ]) {
      mockGetEffectiveEntitlement.mockReturnValue(entitlement);
      const response = await getCoach();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('TIER_REQUIRED');
    }

    expect(mockGetActivePlan).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('uses the stable paid-AI code for Free when enforcement is enabled', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    setPlan('free');
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);
    const response = await getCoach();
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('AI_PLAN_REQUIRED');
  });

  it('allows owner and paid-trial interactive coach requests when enforcement is enabled', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    mockIsSkillAllowedByEntitlement.mockReturnValue(true);
    for (const entitlement of [
      { plan: 'owner', source: 'owner', aiAccessAllowed: true, allowedSkills: new Set(['training']) },
      { plan: 'pro', source: 'stripe', status: 'trialing', aiAccessAllowed: true, allowedSkills: new Set(['training']) },
    ]) {
      mockGetEffectiveEntitlement.mockReturnValue(entitlement);
      const response = await getCoach();
      expect(response.status).toBe(200);
    }
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(2);
  });

  it('blocks a paid user without an active plan before cache, calendar, or AI work', async () => {
    setPlan('pro');
    mockGetActivePlan.mockReturnValue(null);

    const response = await getCoach();

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACTIVE_TRAINING_PLAN_REQUIRED');
    expect(mockGetActivePlan).toHaveBeenCalledWith(42, 42);
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('blocks pro users with exhausted daily quota before coach AI fires', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    setPlan('pro');
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.21,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-05-09T00:00:00.000Z',
    });
    mockGenerateCoachBriefing.mockImplementationOnce(async () => {
      const { withAiBudgetReservation } = await import('../../src/services/cost-guardrail');
      return withAiBudgetReservation({
        userId: 42,
        requestSource: 'interactive',
        baseCategory: 'coach_analysis',
      }, async () => ({ message: 'unreachable', recommendations: [] }));
    });

    const response = await getCoach();

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
  });

  it('allows pro users under cap and preserves the coach response shape', async () => {
    setPlan('pro');

    const response = await getCoach();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.briefing).toBe('Coach ready.');
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(42, {
      tenantId: 42,
      meteringUserId: 42,
      budgetRequestSource: 'interactive',
      budgetJobName: 'coach_refresh',
    });
  });

  it('serializes concurrent pro refreshes so one remaining quota slot cannot race', async () => {
    process.env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED = 'true';
    setPlan('pro');
    let remaining = 1;
    let providerCalls = 0;
    mockIsUserOverDailyCap.mockImplementation(() => ({
      over: remaining <= 0,
      spentUsd: remaining <= 0 ? 0.21 : 0.19,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-05-09T00:00:00.000Z',
    }));
    mockGenerateCoachBriefing.mockImplementation(async () => {
      const { withAiBudgetReservation } = await import('../../src/services/cost-guardrail');
      return withAiBudgetReservation({
        userId: 777,
        requestSource: 'interactive',
        baseCategory: 'coach_analysis',
      }, async () => {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        remaining -= 1;
        return { message: 'Coach ready.', recommendations: [] };
      });
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => getCoach(777)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(5);
    expect(providerCalls).toBe(1);
  });
});
