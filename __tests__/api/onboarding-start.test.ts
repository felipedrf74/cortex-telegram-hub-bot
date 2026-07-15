import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

let testDb: Database.Database;
const mockInvalidateOnboardingDerivedCaches = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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
  invalidateOnboardingDerivedCaches: (...args: unknown[]) => mockInvalidateOnboardingDerivedCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));


import { onboardingRoutes } from '../../src/api/routes/onboarding';
import { getActiveSession } from '../../src/services/onboarding';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function expectOk(res: MockRes): void {
  if (res.statusCode !== 200) {
    throw new Error(`Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }
}

async function dispatch(
  method: 'GET' | 'POST',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = onboardingRoutes();
  const segments = url.split('?')[0].split('/').filter(Boolean);
  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query: {},
    params: {} as Record<string, string>,
    headers: {},
  } as unknown as Request;

  if (segments[0] && !['pending', 'profile'].includes(segments[0])) {
    (req as any).params.questionnaireId = segments[0];
  }

  const res = mockRes();
  await new Promise<void>((resolve) => {
    (router as any).handle(req, res as unknown as Response, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Onboarding questionnaire start flow', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('POST /:questionnaireId/start starts a fresh questionnaire for a new user', async () => {
    const res = await dispatch('POST', '/fitness/start', 1401);

    expectOk(res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('fitness');
    expect(res.body.data.currentStep).toBe(0);
    expect(res.body.data.steps.length).toBeGreaterThan(0);

    const session = getActiveSession(1401, 'fitness');
    expect(session).not.toBeNull();
    expect(session?.current_step).toBe(0);
  });

  it('fails closed on invalid tenant scope before starting onboarding', async () => {
    const res = await dispatch('POST', '/fitness/start', 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'onboarding_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('GET /:questionnaireId implicitly starts the session so the first answer works for fresh users', async () => {
    const questionnaire = await dispatch('GET', '/fitness', 1402);
    expectOk(questionnaire);
    expect(questionnaire.body.ok).toBe(true);
    expect(questionnaire.body.data.currentStep).toBe(0);

    const answer = await dispatch('POST', '/fitness/answer', 1402, {
      stepIndex: 0,
      answer: 'Intermediate (1-3 years)',
    });

    expectOk(answer);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.data.isComplete).toBe(false);
    expect(answer.body.data.nextStep.field).toBe('weekly_frequency');

    const session = getActiveSession(1402, 'fitness');
    expect(session).not.toBeNull();
    expect(session?.current_step).toBe(1);
    expect(session?.answers.experience_level).toBe('Intermediate (1-3 years)');
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledWith(1402, 'fitness');
  });
});
