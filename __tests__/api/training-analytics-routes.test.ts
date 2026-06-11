import { Router } from 'express';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// Real in-memory DB for GET /history — its pagination/merge logic lives
// in SQL + JS keyset code that mocking would render untested.
let testDb: Database.Database | null = null;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetCardioProgression = vi.fn();
const mockGetStrengthProgression = vi.fn();
const mockGetUnifiedWeeklyActivitySummary = vi.fn();
const mockPublishAdherenceSignalsForUser = vi.fn();
const mockPublishPlanDriftSignalForUser = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/progression-analytics', () => ({
  getCardioProgression: (...args: unknown[]) => mockGetCardioProgression(...args),
  getStrengthProgression: (...args: unknown[]) => mockGetStrengthProgression(...args),
}));

vi.mock('../../src/services/session-analytics', () => ({
  getUnifiedWeeklyActivitySummary: (...args: unknown[]) => mockGetUnifiedWeeklyActivitySummary(...args),
}));

vi.mock('../../src/services/adherence-signals', () => ({
  publishAdherenceSignalsForUser: (...args: unknown[]) => mockPublishAdherenceSignalsForUser(...args),
  publishPlanDriftSignalForUser: (...args: unknown[]) => mockPublishPlanDriftSignalForUser(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  registerTrainingAnalyticsRoutes,
  type TrainingLanguageResolver,
} from '../../src/api/routes/training-analytics-routes';

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        /* skip deps */
      }
    }
  }
}

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

function mockReq(method: string, path: string, query: Record<string, any>, userId = 12, tenantId = 34): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers: {},
    header: () => undefined,
    body: undefined,
    userId,
    tenantId,
  } as any;
}

async function dispatch(
  path: string,
  query: Record<string, any> = {},
  language: ReturnType<TrainingLanguageResolver> = 'en-US',
  tenantId = 34,
): Promise<MockRes> {
  const router = Router();
  registerTrainingAnalyticsRoutes(router, (() => language) as TrainingLanguageResolver);
  const req = mockReq('GET', path, query, 12, tenantId);
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

describe('training analytics route registrar', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetCardioProgression.mockReset();
    mockGetStrengthProgression.mockReset();
    mockGetUnifiedWeeklyActivitySummary.mockReset();
    mockPublishAdherenceSignalsForUser.mockReset();
    mockPublishPlanDriftSignalForUser.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetCardioProgression.mockReturnValue({
      userId: 12,
      sport: 'running',
      windowWeeks: 8,
      weeks: [],
    });
    mockGetStrengthProgression.mockReturnValue({
      userId: 12,
      windowWeeks: 8,
      lifts: [],
    });
    mockGetUnifiedWeeklyActivitySummary.mockResolvedValue({
      userId: 12,
      totalCompletions: 2,
      totalDurationMin: 90,
      bySport: {},
    });
  });

  it('localizes cardio progression validation without touching analytics services', async () => {
    const res = await dispatch('/progression/cardio', { sport: 'swimming' }, 'pt-BR');

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'o parâmetro sport deve ser "running" ou "cycling"',
    });
    expect(mockGetCardioProgression).not.toHaveBeenCalled();
  });

  it('clamps cardio lookback and caches the report', async () => {
    const res = await dispatch('/progression/cardio', { sport: 'running', weeks: '999' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetCardioProgression).toHaveBeenCalledWith(12, 34, 'running', 52);
    expect(mockSetCache).toHaveBeenCalledWith('cardio-progression:34:12:running:52', res.body.data, 120);
  });

  it('returns cached strength progression without recomputing', async () => {
    mockGetCached.mockReturnValueOnce({ userId: 12, windowWeeks: 4, lifts: [{ lift: 'Back Squat' }] });

    const res = await dispatch('/progression/strength', { weeks: '4' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.lifts[0].lift).toBe('Back Squat');
    expect(mockGetStrengthProgression).not.toHaveBeenCalled();
  });

  it('returns weekly activity even when best-effort signal publishing fails', async () => {
    mockPublishAdherenceSignalsForUser.mockImplementation(() => {
      throw new Error('bus unavailable');
    });

    const res = await dispatch('/activity/weekly');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totalCompletions).toBe(2);
    expect(mockGetUnifiedWeeklyActivitySummary).toHaveBeenCalledWith(12, 34);
    expect(mockPublishAdherenceSignalsForUser).toHaveBeenCalledWith(12, 34);
    expect(mockPublishPlanDriftSignalForUser).toHaveBeenCalledWith(12, 34);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12, tenantId: 34 }),
      'adherence signal publish failed — summary still returned',
    );
    expect(mockSetCache).toHaveBeenCalledWith('training-activity-weekly:34:12', res.body.data, 60);
  });

  it('fails closed when tenant scope is missing', async () => {
    const res = await dispatch('/activity/weekly', {}, 'en-US', null as any);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(mockGetUnifiedWeeklyActivitySummary).not.toHaveBeenCalled();
    expect(mockPublishAdherenceSignalsForUser).not.toHaveBeenCalled();
    expect(mockPublishPlanDriftSignalForUser).not.toHaveBeenCalled();
  });
});

describe('GET /history', () => {
  beforeAll(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });

  afterAll(() => {
    testDb?.close();
    testDb = null;
  });

  beforeEach(() => {
    testDb!.exec(`
      DELETE FROM training_completions;
      DELETE FROM training_sessions;
      DELETE FROM training_weeks;
      DELETE FROM fitness_training_plans;
    `);
  });

  function seedPlan(planId: number, opts: { userId?: number; tenantId?: number; name?: string } = {}): void {
    testDb!.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, ?, 'strength', 12, '2026-01-01', '2026-04-01', 'active')
    `).run(planId, opts.userId ?? 12, opts.tenantId ?? 34, opts.name ?? 'Base Plan');
    testDb!.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 2)').run(planId, planId);
  }

  function seedSession(
    sessionId: number,
    planId: number,
    opts: { sessionType?: string; title?: string; durationMin?: number; status?: string; updatedAt?: string } = {},
  ): void {
    testDb!.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status, updated_at)
      VALUES (?, ?, ?, 'Monday', ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      planId,
      planId,
      opts.sessionType ?? 'strength',
      opts.title ?? 'Session',
      opts.durationMin ?? 60,
      opts.status ?? 'completed',
      opts.updatedAt ?? '2026-06-01T00:00:00.000Z',
    );
  }

  function seedCompletion(
    completionId: number,
    sessionId: number,
    planId: number,
    opts: {
      completedAt: string;
      durationMin?: number;
      distanceMeters?: number;
      rpe?: number;
      energy?: number;
      soreness?: number;
      notes?: string;
    },
  ): void {
    testDb!.prepare(`
      INSERT INTO training_completions
        (id, session_id, plan_id, completed_at, duration_minutes, completed_distance_meters,
         rpe_overall, energy_level, soreness_level, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      completionId,
      sessionId,
      planId,
      opts.completedAt,
      opts.durationMin ?? null,
      opts.distanceMeters ?? null,
      opts.rpe ?? null,
      opts.energy ?? null,
      opts.soreness ?? null,
      opts.notes ?? null,
    );
  }

  it('pages through history with a stable keyset cursor and no overlap', async () => {
    seedPlan(1);
    for (let i = 0; i < 5; i++) {
      seedSession(101 + i, 1);
      // completion 201 is newest (06-05), 205 oldest (06-01).
      seedCompletion(201 + i, 101 + i, 1, { completedAt: `2026-06-0${5 - i}T10:00:00.000Z`, durationMin: 60 });
    }

    const page1 = await dispatch('/history', { limit: '2' });
    expect(page1.statusCode).toBe(200);
    expect(page1.body.data.items.map((item: any) => item.id)).toEqual(['completion-201', 'completion-202']);
    expect(page1.body.data.nextCursor).toEqual(expect.any(String));

    const page2 = await dispatch('/history', { limit: '2', cursor: page1.body.data.nextCursor });
    expect(page2.statusCode).toBe(200);
    expect(page2.body.data.items.map((item: any) => item.id)).toEqual(['completion-203', 'completion-204']);
    expect(page2.body.data.nextCursor).toEqual(expect.any(String));

    const page3 = await dispatch('/history', { limit: '2', cursor: page2.body.data.nextCursor });
    expect(page3.statusCode).toBe(200);
    expect(page3.body.data.items.map((item: any) => item.id)).toEqual(['completion-205']);
    expect(page3.body.data.nextCursor).toBeNull();

    expect(page1.body.data.items[0]).toMatchObject({
      type: 'completion',
      sessionId: 101,
      sport: 'strength',
      status: 'completed',
      planName: 'Base Plan',
      weekNumber: 2,
    });
  });

  it('keeps the cursor stable across identical timestamps and both arms', async () => {
    const tied = '2026-06-03T08:00:00.000Z';
    seedPlan(1);
    for (let i = 0; i < 3; i++) {
      seedSession(111 + i, 1);
      seedCompletion(301 + i, 111 + i, 1, { completedAt: tied, durationMin: 60 });
    }
    seedSession(114, 1, { status: 'skipped', updatedAt: tied });

    const page1 = await dispatch('/history', { limit: '2' });
    expect(page1.body.data.items.map((item: any) => item.id)).toEqual(['completion-303', 'completion-302']);

    const page2 = await dispatch('/history', { limit: '2', cursor: page1.body.data.nextCursor });
    expect(page2.body.data.items.map((item: any) => item.id)).toEqual(['completion-301', 'skipped-114']);
    expect(page2.body.data.nextCursor).toBeNull();

    const seen = [...page1.body.data.items, ...page2.body.data.items].map((item: any) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('fails closed when tenant scope is missing', async () => {
    seedPlan(1);
    seedSession(101, 1);
    seedCompletion(201, 101, 1, { completedAt: '2026-06-05T10:00:00.000Z' });

    const res = await dispatch('/history', {}, 'en-US', null as any);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('does not return rows from another tenant for the same user id', async () => {
    seedPlan(1, { userId: 12, tenantId: 99 });
    seedSession(101, 1);
    seedCompletion(201, 101, 1, { completedAt: '2026-06-05T10:00:00.000Z' });
    seedSession(102, 1, { status: 'skipped' });

    const res = await dispatch('/history');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('filters by sport via session-type normalization across both arms', async () => {
    seedPlan(1);
    seedSession(101, 1, { sessionType: 'easy_run' });
    seedCompletion(201, 101, 1, { completedAt: '2026-06-05T10:00:00.000Z', durationMin: 45 });
    seedSession(102, 1, { sessionType: 'gym' });
    seedCompletion(202, 102, 1, { completedAt: '2026-06-04T10:00:00.000Z', durationMin: 50 });
    seedSession(103, 1, { sessionType: 'endurance_ride', status: 'skipped', updatedAt: '2026-06-03T10:00:00.000Z' });

    const running = await dispatch('/history', { sport: 'running' });
    expect(running.body.data.items.map((item: any) => item.id)).toEqual(['completion-201']);
    expect(running.body.data.items[0].sport).toBe('running');

    const cycling = await dispatch('/history', { sport: 'cycling' });
    expect(cycling.body.data.items.map((item: any) => item.id)).toEqual(['skipped-103']);
  });

  it('rejects an invalid sport filter without touching the page reader', async () => {
    const res = await dispatch('/history', { sport: 'rowing' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'sport query param must be "running", "cycling", "strength" or "swimming"',
    });
  });

  it('rejects a malformed cursor instead of silently restarting from page 1', async () => {
    const res = await dispatch('/history', { cursor: 'not-a-keyset-token' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'cursor query param is invalid',
    });
  });

  it('includes skipped sessions without a reason field', async () => {
    seedPlan(1);
    seedSession(101, 1, { status: 'skipped', title: 'Tempo Ride', sessionType: 'tempo_ride', updatedAt: '2026-06-02T09:00:00.000Z' });

    const res = await dispatch('/history');

    expect(res.body.data.items).toHaveLength(1);
    const item = res.body.data.items[0];
    expect(item).toMatchObject({
      id: 'skipped-101',
      type: 'skipped',
      sessionId: 101,
      status: 'skipped',
      sport: 'cycling',
      title: 'Tempo Ride',
      plannedDurationMin: 60,
      actualDurationMin: null,
      rpe: null,
      notes: null,
    });
    expect(item).not.toHaveProperty('reason');
  });

  it('classifies completions under 72% of planned duration as partial', async () => {
    seedPlan(1);
    seedSession(101, 1, { durationMin: 60 });
    seedCompletion(201, 101, 1, { completedAt: '2026-06-05T10:00:00.000Z', durationMin: 40, distanceMeters: 5000, rpe: 7 });
    seedSession(102, 1, { durationMin: 60 });
    seedCompletion(202, 102, 1, { completedAt: '2026-06-04T10:00:00.000Z', durationMin: 50 });

    const res = await dispatch('/history');

    expect(res.body.data.items.map((item: any) => [item.id, item.status])).toEqual([
      ['completion-201', 'partial'],
      ['completion-202', 'completed'],
    ]);
    expect(res.body.data.items[0]).toMatchObject({
      actualDurationMin: 40,
      actualDistanceKm: 5,
      rpe: 7,
    });
  });

  it('caches the first page only, never cursor pages', async () => {
    seedPlan(1);
    for (let i = 0; i < 3; i++) {
      seedSession(101 + i, 1);
      seedCompletion(201 + i, 101 + i, 1, { completedAt: `2026-06-0${3 - i}T10:00:00.000Z`, durationMin: 60 });
    }

    const page1 = await dispatch('/history', { limit: '2', sport: 'strength' });
    expect(mockSetCache).toHaveBeenCalledWith('training-history:34:12:strength:2', page1.body.data, 60);

    mockSetCache.mockClear();
    const page2 = await dispatch('/history', { limit: '2', sport: 'strength', cursor: page1.body.data.nextCursor });
    expect(page2.statusCode).toBe(200);
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('returns the cached first page without recomputing', async () => {
    const cachedPage = { items: [{ id: 'completion-9' }], nextCursor: null };
    mockGetCached.mockReturnValueOnce(cachedPage);

    const res = await dispatch('/history');

    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.data).toEqual(cachedPage);
    expect(mockGetCached).toHaveBeenCalledWith('training-history:34:12:all:20');
  });
});
