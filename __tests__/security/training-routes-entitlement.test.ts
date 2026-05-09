import express from 'express';
import http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateCoachBriefing = vi.fn();
const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetEffectiveEntitlement = vi.fn();
const mockIsSkillAllowedByEntitlement = vi.fn();
const mockIsUserOverDailyCap = vi.fn();

let lockTail: Promise<unknown> = Promise.resolve();

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
  applyCoachRecommendation: vi.fn(),
  applyCoachRecommendations: vi.fn(),
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

vi.mock('../../src/services/training-cache-invalidator', () => ({
  invalidateTrainingDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/resource-budgets', () => ({
  ensureResourceBudgetTables: vi.fn(),
  consumeResourceBudget: vi.fn(() => ({ allowed: true })),
  capSyncPageSize: vi.fn((rawLimit: unknown) => Number(rawLimit) || 100),
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
}));

vi.mock('../../src/services/entitlement', () => ({
  FREE_TIER_ALLOWED_SKILLS: new Set(['secretary', 'content']),
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  isSkillAllowedByEntitlement: (...args: unknown[]) => mockIsSkillAllowedByEntitlement(...args),
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
  restoreCoachBriefingFromLatestReport: vi.fn(() => null),
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
    allowedSkills: plan === 'free' ? new Set(['secretary']) : new Set(['training']),
    evaluatedAt: '2026-05-08T00:00:00.000Z',
  });
  mockIsSkillAllowedByEntitlement.mockImplementation((entitlement: { allowedSkills: Set<string> }, skill: string) => (
    entitlement.allowedSkills.has(skill)
  ));
}

async function getCoach(userId = 42): Promise<{ status: number; body: any }> {
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
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method: 'GET',
        path: '/training/coach?refresh=true',
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: data ? JSON.parse(data) : null,
        }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('training routes entitlement and AI cost guardrails', () => {
  beforeEach(() => {
    lockTail = Promise.resolve();
    mockGenerateCoachBriefing.mockReset();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetEffectiveEntitlement.mockReset();
    mockIsSkillAllowedByEntitlement.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetCached.mockReturnValue(null);
    mockGenerateCoachBriefing.mockResolvedValue({ message: 'Coach ready.', recommendations: [] });
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

  it('blocks pro users with exhausted daily quota before coach AI fires', async () => {
    setPlan('pro');
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.21,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-05-09T00:00:00.000Z',
    });

    const response = await getCoach();

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('daily_limit_exceeded');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('allows pro users under cap and preserves the coach response shape', async () => {
    setPlan('pro');

    const response = await getCoach();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.briefing).toBe('Coach ready.');
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(42);
  });

  it('serializes concurrent pro refreshes so one remaining quota slot cannot race', async () => {
    setPlan('pro');
    let remaining = 1;
    mockIsUserOverDailyCap.mockImplementation(() => ({
      over: remaining <= 0,
      spentUsd: remaining <= 0 ? 0.21 : 0.19,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-05-09T00:00:00.000Z',
    }));
    mockGenerateCoachBriefing.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      remaining -= 1;
      return { message: 'Coach ready.', recommendations: [] };
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => getCoach(777)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
  });
});
