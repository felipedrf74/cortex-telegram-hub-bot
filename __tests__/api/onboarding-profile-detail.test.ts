/**
 * Phase 3 Slice C — Athlete profile detail + field edit endpoint tests
 *
 * Covers the two new routes on /api/v1/onboarding:
 *
 *   GET /profile/detail        — full schema + values for all triathlon profiles
 *   PATCH /profile/:type/field — upsert a single field with validation
 *
 * Dispatches directly through the Express router without spinning up
 * the full API server. Same pattern as __tests__/api/skills-routes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
    anthropic: { apiKey: 'sk-test-placeholder' },
    openai: { apiKey: 'sk-test-placeholder' },
    gemini: { apiKey: 'test-placeholder' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import { onboardingRoutes } from '../../src/api/routes/onboarding';
import {
  upsertProfileField,
  getQuestionnaire,
} from '../../src/services/onboarding';

// ─── Mock req/res helpers ───────────────────────────────────────────

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

/**
 * Dispatch a request through the onboardingRoutes router stack.
 * The router uses Express's `handle` method so we don't need a live
 * HTTP server. Express populates req.params from the matched route
 * pattern, so URL parsing matters — we pass the URL verbatim.
 */
async function dispatch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = onboardingRoutes();
  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query: {},
    params: {},
    headers: {},
  } as any;

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

// ─── GET /profile/detail ────────────────────────────────────────────

describe('GET /api/v1/onboarding/profile/detail', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('returns 5 profiles (fitness + 4 sport) with empty values when no data exists', async () => {
    const res = await dispatch('GET', '/profile/detail', 1001);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = res.body.data;
    expect(data.profiles).toHaveLength(5);

    const types = data.profiles.map((p: any) => p.type).sort();
    expect(types).toEqual([
      'fitness',
      'triathlon-cycling',
      'triathlon-gym',
      'triathlon-running',
      'triathlon-swim',
    ]);

    // Every profile should have 0 answered and the full field count.
    for (const profile of data.profiles) {
      expect(profile.completedFieldCount).toBe(0);
      expect(profile.totalFieldCount).toBeGreaterThan(0);
      expect(profile.isComplete).toBe(false);
      expect(profile.fields).toHaveLength(profile.totalFieldCount);
      for (const field of profile.fields) {
        expect(field.value).toBeNull();
        expect(field.answered).toBe(false);
      }
    }
  });

  it('fails closed on invalid tenant scope before loading profile detail', async () => {
    const res = await dispatch('GET', '/profile/detail', 0);

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

  it('includes field schema metadata (prompt, type, options)', async () => {
    const res = await dispatch('GET', '/profile/detail', 1002);
    const gym = res.body.data.profiles.find((p: any) => p.type === 'triathlon-gym');
    expect(gym).toBeDefined();

    const trainingAge = gym.fields.find((f: any) => f.key === 'training_age');
    expect(trainingAge).toBeDefined();
    expect(trainingAge.prompt).toContain('strength training');
    expect(trainingAge.type).toBe('choice');
    expect(trainingAge.options).toContain('3-5 years');

    const squat = gym.fields.find((f: any) => f.key === 'squat_1rm_kg');
    expect(squat).toBeDefined();
    expect(squat.type).toBe('number');
    expect(squat.options).toBeNull();
  });

  it('marks partially answered fields correctly', async () => {
    upsertProfileField(1003, 'triathlon-gym', 'training_age', '3-5 years');
    upsertProfileField(1003, 'triathlon-gym', 'squat_1rm_kg', '150');

    const res = await dispatch('GET', '/profile/detail', 1003);
    const gym = res.body.data.profiles.find((p: any) => p.type === 'triathlon-gym');

    expect(gym.completedFieldCount).toBe(2);
    expect(gym.isComplete).toBe(false);

    const trainingAge = gym.fields.find((f: any) => f.key === 'training_age');
    expect(trainingAge.answered).toBe(true);
    expect(trainingAge.value).toBe('3-5 years');

    const bench = gym.fields.find((f: any) => f.key === 'bench_1rm_kg');
    expect(bench.answered).toBe(false);
    expect(bench.value).toBeNull();
  });

  it('marks a fully-answered profile as isComplete', async () => {
    const questionnaire = getQuestionnaire('triathlon-swim')!;
    for (const step of questionnaire.steps) {
      const value = step.type === 'number' ? '100' : (step.options?.[0] ?? 'x');
      upsertProfileField(1004, 'triathlon-swim', step.key, value);
    }

    const res = await dispatch('GET', '/profile/detail', 1004);
    const swim = res.body.data.profiles.find((p: any) => p.type === 'triathlon-swim');
    expect(swim.isComplete).toBe(true);
    expect(swim.completedFieldCount).toBe(swim.totalFieldCount);
  });

  it('includes summary totals', async () => {
    upsertProfileField(1005, 'triathlon-gym', 'training_age', '1-3 years');
    upsertProfileField(1005, 'triathlon-running', 'target_race', '10k');

    const res = await dispatch('GET', '/profile/detail', 1005);
    expect(res.body.data.summary.totalAnswered).toBe(2);
    expect(res.body.data.summary.totalFields).toBeGreaterThan(30);
    expect(res.body.data.summary.allComplete).toBe(false);
  });

  it('keeps users isolated', async () => {
    upsertProfileField(1006, 'triathlon-gym', 'training_age', '5+ years');
    upsertProfileField(1007, 'triathlon-gym', 'training_age', '< 1 year');

    const a = await dispatch('GET', '/profile/detail', 1006);
    const b = await dispatch('GET', '/profile/detail', 1007);

    const aGym = a.body.data.profiles.find((p: any) => p.type === 'triathlon-gym');
    const bGym = b.body.data.profiles.find((p: any) => p.type === 'triathlon-gym');

    expect(aGym.fields.find((f: any) => f.key === 'training_age').value).toBe('5+ years');
    expect(bGym.fields.find((f: any) => f.key === 'training_age').value).toBe('< 1 year');
  });
});

// ─── PATCH /profile/:type/field ─────────────────────────────────────

describe('PATCH /api/v1/onboarding/profile/:type/field', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });
  afterEach(() => testDb?.close());

  it('upserts a valid field and returns remaining pending fields', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2001,
      { fieldKey: 'training_age', value: '3-5 years' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.profileType).toBe('triathlon-gym');
    expect(res.body.data.fieldKey).toBe('training_age');
    expect(res.body.data.value).toBe('3-5 years');
    expect(res.body.data.profileComplete).toBe(false);
    expect(res.body.data.remainingFields).toBeInstanceOf(Array);
    expect(res.body.data.remainingFields).not.toContain('training_age');
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledWith(2001, 'triathlon-gym');
  });

  it('rejects profile types outside the athlete profile set', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/diet/field',
      2002,
      { fieldKey: 'diet_type', value: 'Carnivore' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('not an athlete profile');
  });

  it('rejects missing fieldKey', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2003,
      { value: '3-5 years' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('fieldKey');
  });

  it('rejects missing value', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2004,
      { fieldKey: 'training_age' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('value');
  });

  it('rejects unknown field keys', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2005,
      { fieldKey: 'favorite_color', value: 'blue' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('not a step');
  });

  it('rejects values that fail the step regex (running pace)', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-running/field',
      2006,
      { fieldKey: 'easy_pace_min_per_km', value: 'fast' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('does not match');
  });

  it('accepts a valid pace format matching the regex', async () => {
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-running/field',
      2007,
      { fieldKey: 'easy_pace_min_per_km', value: '5:30' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.value).toBe('5:30');
  });

  it('marks profileComplete: true after last field is saved', async () => {
    const questionnaire = getQuestionnaire('triathlon-swim')!;
    // Answer every field except the last via PATCH
    for (let i = 0; i < questionnaire.steps.length - 1; i++) {
      const step = questionnaire.steps[i];
      const value = step.type === 'number' ? '100' : (step.options?.[0] ?? 'x');
      await dispatch(
        'PATCH',
        '/profile/triathlon-swim/field',
        2008,
        { fieldKey: step.key, value },
      );
    }
    // Save the last one and check completion
    const lastStep = questionnaire.steps[questionnaire.steps.length - 1];
    const lastValue = lastStep.type === 'number' ? '100' : (lastStep.options?.[0] ?? 'x');
    const res = await dispatch(
      'PATCH',
      '/profile/triathlon-swim/field',
      2008,
      { fieldKey: lastStep.key, value: lastValue },
    );
    expect(res.body.data.profileComplete).toBe(true);
    expect(res.body.data.remainingFields).toHaveLength(0);
  });

  it('second PATCH for the same field overwrites the previous value', async () => {
    await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2009,
      { fieldKey: 'squat_1rm_kg', value: '140' },
    );
    const second = await dispatch(
      'PATCH',
      '/profile/triathlon-gym/field',
      2009,
      { fieldKey: 'squat_1rm_kg', value: '155' },
    );
    expect(second.body.data.value).toBe('155');

    // Verify the detail endpoint reflects the overwrite
    const detail = await dispatch('GET', '/profile/detail', 2009);
    const gym = detail.body.data.profiles.find((p: any) => p.type === 'triathlon-gym');
    const squat = gym.fields.find((f: any) => f.key === 'squat_1rm_kg');
    expect(squat.value).toBe('155');
  });
});
