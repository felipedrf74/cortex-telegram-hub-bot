/**
 * Beta gap 3 (2026-04-24): route-level tests for the onboarding API.
 *
 * Complements __tests__/services/onboarding-idempotency.test.ts — that
 * covers the service layer behavior; this one covers the HTTP surface
 * the iOS client actually talks to, including the new GET /status
 * read-only endpoint and the STEP_MISMATCH / 409 translation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
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
import { getActiveSession, startOrResume } from '../../src/services/onboarding';

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

async function dispatch(
  method: 'GET' | 'POST',
  url: string,
  userId: number,
  body?: any,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = onboardingRoutes();
  const [pathPart] = url.split('?');
  const segments = pathPart.split('/').filter(Boolean);

  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: pathPart,
    query: {},
    params: {} as Record<string, string>,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
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

describe('GET /onboarding/:questionnaireId/status', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns not_started for a fresh user WITHOUT creating a session', async () => {
    const res = await dispatch('GET', '/fitness/status', 2001);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('not_started');
    expect(res.body.data.currentStep).toBe(0);
    expect(res.body.data.totalSteps).toBeGreaterThan(0);
    // Critical: the read-only check must NOT implicitly start a session.
    // That was the whole point of splitting it from GET /:questionnaireId.
    expect(getActiveSession(2001, 'fitness')).toBeNull();
  });

  it('returns in_progress with the current step when a session exists', async () => {
    startOrResume(2002, 'fitness');
    // Advance one step so currentStep !== 0 and we can tell the two states apart.
    await dispatch('POST', '/fitness/answer', 2002, {
      stepIndex: 0,
      answer: 'Beginner (< 1 year)',
    });

    const res = await dispatch('GET', '/fitness/status', 2002);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('in_progress');
    expect(res.body.data.currentStep).toBe(1);
    expect(res.body.data.answeredKeys).toEqual(['experience_level']);
  });

  it('returns completed once a profile exists', async () => {
    testDb.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, 'fitness', ?)
    `).run(2003, JSON.stringify({ experience_level: 'Beginner (< 1 year)' }));

    const res = await dispatch('GET', '/fitness/status', 2003);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('completed');
    expect(res.body.data.currentStep).toBe(res.body.data.totalSteps);
  });

  it('returns unknown for a questionnaire this server does not define', async () => {
    const res = await dispatch('GET', '/definitely-not-a-real-questionnaire/status', 2004);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('unknown');
  });
});

describe('GET /onboarding/:questionnaireId localized wire copy', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns pt-PT swim prompts and labels with canonical option values', async () => {
    const res = await dispatch(
      'GET',
      '/triathlon-swim',
      2501,
      undefined,
      { 'x-language': 'pt-PT' },
    );

    expect(res.statusCode).toBe(200);
    const sessions = res.body.data.steps.find((step: any) => step.field === 'sessions_per_week');
    expect(sessions.question).toBe('Quantas sessões de natação podes fazer por semana?');
    const gear = res.body.data.steps.find((step: any) => step.field === 'equipment_access');
    expect(gear.options[0]).toBe('Pull buoy');
    expect(gear.optionLabels[0]).toBe('Flutuador de pernas');
  });
});

describe('POST /onboarding/:questionnaireId/answer stepIndex concurrency', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('suppresses a duplicate POST carrying the already-consumed stepIndex', async () => {
    startOrResume(3001, 'fitness');
    const first = await dispatch('POST', '/fitness/answer', 3001, {
      stepIndex: 0,
      answer: 'Beginner (< 1 year)',
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.data.currentStep).toBe(1);
    // A proper answer triggers the cache invalidator exactly once.
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledTimes(1);

    // Network blip: iOS retries the same POST.
    const replay = await dispatch('POST', '/fitness/answer', 3001, {
      stepIndex: 0,
      answer: 'Advanced (3+ years)',
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.currentStep).toBe(1); // not double-advanced
    expect(getActiveSession(3001, 'fitness')?.answers.experience_level)
      .toBe('Beginner (< 1 year)'); // retry did NOT overwrite

    // Critically: the replay did NOT trigger a second cache invalidation.
    // Downstream coaches/dashboards see one consistent answer, not two
    // churny rebuilds triggered by a retry with no data change.
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledTimes(1);
  });

  it('rejects a stepIndex ahead of the server with 409 STEP_MISMATCH and the real server step', async () => {
    startOrResume(3002, 'fitness');
    const res = await dispatch('POST', '/fitness/answer', 3002, {
      stepIndex: 3, // client claims it's on step 3, server is on 0
      answer: 'irrelevant',
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('STEP_MISMATCH');
    expect(res.body.error.details).toMatchObject({
      currentStep: 0,
      clientStep: 3,
    });
    // Server cursor is untouched.
    expect(getActiveSession(3002, 'fitness')?.current_step).toBe(0);
  });

  it('accepts skip=true without answer and does not mark the field answered', async () => {
    startOrResume(3003, 'fitness');
    const res = await dispatch('POST', '/fitness/answer', 3003, {
      stepIndex: 0,
      skip: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.skipped).toBe(true);
    expect(res.body.data.currentStep).toBe(1);
    expect(getActiveSession(3003, 'fitness')?.answers).toEqual({});
  });

  it('rejects a missing answer when skip is not explicitly true', async () => {
    startOrResume(3004, 'fitness');
    const res = await dispatch('POST', '/fitness/answer', 3004, {
      stepIndex: 0,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(getActiveSession(3004, 'fitness')?.current_step).toBe(0);
  });

  it('reports zero answered fields after every fitness step is skipped', async () => {
    startOrResume(3005, 'fitness');
    for (let stepIndex = 0; stepIndex < 7; stepIndex++) {
      const skipped = await dispatch('POST', '/fitness/answer', 3005, {
        stepIndex,
        skip: true,
      });
      expect(skipped.statusCode).toBe(200);
    }

    const detail = await dispatch('GET', '/profile/detail', 3005);
    const fitness = detail.body.data.profiles.find((profile: any) => profile.type === 'fitness');
    expect(fitness.completedFieldCount).toBe(0);
    expect(fitness.fields.every((field: any) => field.answered === false)).toBe(true);
  });
});
