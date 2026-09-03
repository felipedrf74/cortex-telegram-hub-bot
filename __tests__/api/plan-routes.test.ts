import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockComposeWeeklyPlan = vi.fn();
const mockComposeDailyBrief = vi.fn();
const mockRecomputePlanningSnapshot = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGetUserById = vi.fn();
const mockGetUserLanguageById = vi.fn();
const mockGetUserTimezoneById = vi.fn();
let mockEffectivePlan: 'free' | 'pro' | 'max' | 'owner' = 'max';

vi.mock('../../src/services/weekly-plan-orchestrator', () => ({
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/planning-recompute-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/planning-recompute-service')>(
    '../../src/services/planning-recompute-service',
  );
  return {
    ...actual,
    recomputePlanningSnapshot: (...args: unknown[]) => mockRecomputePlanningSnapshot(...args),
  };
});

vi.mock('../../src/services/cache-store', () => ({
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguageById(...args),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezoneById(...args),
}));

vi.mock('../../src/services/entitlement', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/entitlement')>(
    '../../src/services/entitlement',
  );
  return {
    ...actual,
    getEffectiveEntitlement: vi.fn(() => ({ plan: mockEffectivePlan })),
    entitlementPlanToSkillTier: vi.fn((plan: string) => plan),
  };
});

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
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name] = value; return response; },
    end() { return response; },
  };
  return response;
}

function mockReq(
  method: 'GET' | 'POST',
  path: string,
  userId = 12,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {},
  tenantId = userId,
): Request {
  const parsed = new URL(path, 'http://test.local');
  return {
    method,
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
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
  method: 'GET' | 'POST',
  path: string,
  options: {
    userId?: number;
    tenantId?: number;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<MockRes> {
  const { planRoutes } = await import('../../src/api/routes/plan');
  const router = planRoutes();
  const req = mockReq(method, path, options.userId, options.headers, options.body, options.tenantId ?? options.userId);
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

describe('plan routes', () => {
  beforeEach(() => {
    mockEffectivePlan = 'max';
    clearTenantScopeAnomaliesForTests();
    mockComposeWeeklyPlan.mockReset();
    mockComposeDailyBrief.mockReset();
    mockRecomputePlanningSnapshot.mockReset();
    mockGetCachedSWR.mockReset();
    mockSetCacheSWR.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGetUserById.mockReset();
    mockGetUserLanguageById.mockReset();
    mockGetUserTimezoneById.mockReset();

    mockComposeWeeklyPlan.mockResolvedValue({
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      generatedAt: '2026-04-14T10:00:00.000Z',
      variant: 'steady',
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: 'Headline', note: 'Note' },
      summary: { sessionCount: 3, mealCount: 4, activeConflictCount: 0 },
      days: [],
    });
    mockComposeDailyBrief.mockResolvedValue({
      date: '2026-04-14',
      generatedAt: '2026-04-14T10:00:00.000Z',
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: 'Headline', note: 'Note' },
      day: {
        date: '2026-04-14',
        weekday: 'Tuesday',
        headline: 'Travel day',
        training: { title: 'Recovery', type: 'rest', status: 'rest', durationMinutes: null, intensity: null, reason: 'Rest', decisions: [] },
        meals: [],
        content: null,
        secretary: { focusBlock: null, pendingTasks: 0, overdueTasks: 0, travel: false, busy: false, decisions: [] },
        finance: null,
      },
      coordination: {
        topPriority: 'Protect the first deep-work block.',
        executionOrder: ['Protect the first deep-work block.'],
        watchouts: [],
        handoffs: [],
        confidence: 'high',
        dayOrchestration: {
          posture: 'deep_work_day',
          title: 'Protect the morning block first.',
          summary: 'Keep the first half of the day free of admin drift.',
          confidence: 'high',
          mainThing: 'Ship the main block before admin',
          reasons: ['Calendar pressure is still low before lunch.'],
          affectedSkills: ['secretary'],
        },
        weekOrchestration: {
          posture: 'consistency',
          title: 'This week protects consistency first.',
          summary: 'Reduce randomness today so the week keeps margin.',
          confidence: 'high',
          reasons: [],
          affectedSkills: ['secretary'],
        },
        nextBestAction: {
          kind: 'protect_focus',
          title: 'Protect 09:00-10:30',
          summary: 'Lock the first focus block before reactive work expands.',
          whyNow: 'This keeps the week executable.',
          targetWindow: '09:00-10:30',
          urgency: 'today',
          confidence: 'high',
          affectedSkills: ['secretary'],
        },
        blockers: [],
        suggestedMoves: [],
        protectedBlocks: [],
        risks: [],
        crossSkillImpacts: [],
      },
    });
    mockRecomputePlanningSnapshot.mockResolvedValue({
      week: {
        weekStart: '2026-04-13',
        weekEnd: '2026-04-19',
        generatedAt: '2026-04-14T10:00:00.000Z',
        days: [],
      },
      today: {
        date: '2026-04-14',
        generatedAt: '2026-04-14T10:00:00.000Z',
      },
    });
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'pt-BR',
      timezone: 'Europe/Lisbon',
    });
    mockGetUserLanguageById.mockReturnValue('pt-BR');
    mockGetUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mockGetCachedSWR.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps plan routes available even if the old mesh flag is off', async () => {
    const response = await dispatch('GET', '/week');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.weekStart).toBe('2026-04-13');
    expect(response.headers['Server-Timing']).toEqual(expect.stringContaining('weekly_plan;dur='));
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      cacheMode: 'bypass',
    }));
  });

  it('returns the daily plan route with stable coordination data and honors If-None-Match', async () => {
    const first = await dispatch('GET', '/today');
    const second = await dispatch('GET', '/today', {
      headers: { 'if-none-match': first.headers.ETag },
    });

    expect(first.statusCode).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data.date).toBe('2026-04-14');
    expect(first.body.data.coordination.dayOrchestration.title).toBe('Protect the morning block first.');
    expect(first.headers.ETag).toBeTruthy();
    expect(first.headers['Server-Timing']).toEqual(expect.stringContaining('daily_brief;dur='));
    expect(second.statusCode).toBe(304);
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      cacheMode: 'bypass',
    }));
  });

  it('keys implicit daily and weekly route caches in the authenticated user timezone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-13T01:00:00.000Z'));
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'pt-BR',
      timezone: 'Pacific/Honolulu',
    });

    await dispatch('GET', '/today');
    await dispatch('GET', '/week');

    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:today:u:12:tenant:12:2026-04-12:tz:Pacific/Honolulu:route:pt-br',
    );
    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:12:2026-04-06:tz:Pacific/Honolulu:route:pt-br',
    );
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ timezone: 'Pacific/Honolulu' }),
    }));
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ timezone: 'Pacific/Honolulu' }),
    }));
  });

  it('never shares a daily plan cache entry across authenticated user or tenant scope', async () => {
    mockGetUserById.mockImplementation((userId: number) => ({
      id: userId,
      tier: 'max',
      language: 'pt-BR',
      timezone: 'Europe/Lisbon',
    }));
    await dispatch('GET', '/today?date=2026-04-14', { userId: 12, tenantId: 12 });
    await dispatch('GET', '/today?date=2026-04-14', { userId: 13, tenantId: 13 });

    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:today:u:12:tenant:12:2026-04-14:tz:Europe/Lisbon:route:pt-br',
    );
    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:today:u:13:tenant:13:2026-04-14:tz:Europe/Lisbon:route:pt-br',
    );
    expect(mockComposeDailyBrief).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: 12,
      tenantId: 12,
    }));
    expect(mockComposeDailyBrief).toHaveBeenNthCalledWith(2, expect.objectContaining({
      userId: 13,
      tenantId: 13,
    }));
  });

  it('rejects malformed and impossible daily dates before cache or planner work', async () => {
    const malformed = await dispatch('GET', '/today?date=2026-04-14T10%3A00%3A00Z');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });

    const impossible = await dispatch('GET', '/today?date=2026-02-30');
    expect(impossible.statusCode).toBe(400);
    expect(impossible.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(mockGetCachedSWR).not.toHaveBeenCalled();
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();
  });

  it('requires exact Monday week starts on weekly reads before cache or planner work', async () => {
    const response = await dispatch('GET', '/week?weekStart=2026-04-14');

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(mockGetCachedSWR).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
  });

  it('validates the requested week on the explanation read', async () => {
    const response = await dispatch('GET', '/week/explain?weekStart=not-a-date');

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
  });

  it('fails closed on invalid tenant scope before composing the weekly plan', async () => {
    const response = await dispatch('GET', '/week', { userId: 0 });

    expect(response.statusCode, JSON.stringify(response.body)).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'plan_route_week',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('fails closed on invalid tenant scope before composing the daily brief', async () => {
    const response = await dispatch('GET', '/today', { userId: 0 });

    expect(response.statusCode, JSON.stringify(response.body)).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'plan_route_today',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('requires max tier for the explain route', async () => {
    mockEffectivePlan = 'pro';

    const response = await dispatch('GET', '/week/explain');

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('does not attribute every degraded weekly plan to the daily AI cap', async () => {
    mockComposeWeeklyPlan.mockResolvedValueOnce({
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      generatedAt: '2026-04-14T10:00:00.000Z',
      variant: 'conservative',
      degraded: true,
      gated: { skills: ['cooking'] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: '', note: '' },
      summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
      days: [],
    });

    const response = await dispatch('GET', '/week/explain?weekStart=2026-04-13');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.explanation).toContain('planning sources or generation gates were unavailable');
    expect(response.body.data.explanation).not.toContain('daily AI cap');
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ timezone: 'Europe/Lisbon' }),
    }));
  });

  it('returns ETag headers and honors If-None-Match', async () => {
    const first = await dispatch('GET', '/week');
    const second = await dispatch('GET', '/week', {
      headers: { 'if-none-match': first.headers.ETag },
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers.ETag).toBeTruthy();
    expect(second.statusCode).toBe(304);
  });

  it('serves a fresh cached daily plan without recomposing and returns a stable ETag', async () => {
    mockGetCachedSWR.mockReturnValueOnce({
      fresh: true,
      value: {
        date: '2026-04-14',
        generatedAt: '2026-04-14T09:00:00.000Z',
        degraded: false,
        gated: { skills: [] },
        garmin_stale: false,
        timezone: 'Europe/Lisbon',
        warningCodes: [],
        warnings: [],
        sourceHealth: {
          calendar: { status: 'ready', warningCodes: [], warnings: [] },
        },
        conflicts: [],
        creativeCopy: { headline: 'Cached', note: 'Cached note' },
        day: {
          date: '2026-04-14',
          weekday: 'Tuesday',
          headline: 'Cached day',
          training: null,
          meals: [],
          content: null,
          secretary: { focusBlock: null, pendingTasks: 0, overdueTasks: 0, travel: false, busy: false, decisions: [] },
          finance: null,
        },
        coordination: { topPriority: 'Cached', executionOrder: [], watchouts: [], handoffs: [], confidence: 'high' },
      },
    });

    const response = await dispatch('GET', '/today?date=2026-04-14', {
      headers: { 'x-language': 'pt-BR' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.cached).toBe(true);
    expect(response.body.data.creativeCopy.headline).toBe('Cached');
    expect(response.headers.ETag).toBeTruthy();
    expect(mockGetCachedSWR).toHaveBeenCalledWith('plan:today:u:12:tenant:12:2026-04-14:tz:Europe/Lisbon:route:pt-br');
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();
  });

  it('serves stale weekly plan data immediately and refreshes the route cache in the background', async () => {
    mockGetCachedSWR.mockReturnValueOnce({
      fresh: false,
      value: {
        weekStart: '2026-04-13',
        weekEnd: '2026-04-19',
        generatedAt: '2026-04-14T09:00:00.000Z',
        variant: 'cached',
        degraded: false,
        gated: { skills: [] },
        garmin_stale: false,
        timezone: 'Europe/Lisbon',
        warningCodes: [],
        warnings: [],
        sourceHealth: {
          calendar: { status: 'ready', warningCodes: [], warnings: [] },
        },
        conflicts: [],
        creativeCopy: { headline: 'Stale', note: 'Stale note' },
        summary: { sessionCount: 1, mealCount: 1, activeConflictCount: 0 },
        days: [],
      },
    });

    const response = await dispatch('GET', '/week?weekStart=2026-04-13');
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(200);
    expect(response.body.cached).toBe(true);
    expect(response.body.data.creativeCopy.headline).toBe('Stale');
    expect(response.body.data.sourceHealth.calendar.status).toBe('stale');
    expect(response.body.data.warningCodes).toContain('PLAN_CACHE_STALE');
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      language: 'pt-BR',
      context: expect.objectContaining({
        userId: 12,
        tenantId: 12,
        timezone: 'Europe/Lisbon',
        language: 'pt-BR',
      }),
    }));
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:12:2026-04-13:tz:Europe/Lisbon:route:pt-br',
      expect.objectContaining({ weekStart: '2026-04-13' }),
      120,
      600,
    );
  });

  it('rejects an authenticated tenant mismatch before planning reads', async () => {
    const response = await dispatch('GET', '/week?weekStart=2026-04-13', { tenantId: 34 });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockSetCacheSWR).not.toHaveBeenCalled();
  });

  it('rejects an explicitly invalid authenticated tenant before cache or planner access', async () => {
    const response = await dispatch('GET', '/week?weekStart=2026-04-13', { tenantId: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: 'INVALID_INPUT',
      message: 'The active tenant must match the authenticated user.',
    });
    expect(mockGetCachedSWR).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'plan_route_week',
        reason: 'tenant_mismatch',
        userId: 12,
        details: expect.objectContaining({ tenantId: 0 }),
      }),
    ]);
  });

  it('returns a client-safe error when the daily plan build throws unexpectedly', async () => {
    mockComposeDailyBrief.mockRejectedValueOnce(new Error('raw planner failure leaked from composeDailyBrief'));

    const response = await dispatch('GET', '/today');

    expect(response.statusCode).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load the daily plan right now.',
    });
  });

  it('delegates validated idempotent week + today recompute to one coherent snapshot owner', async () => {
    const response = await dispatch('POST', '/recompute', {
      body: { idempotencyKey: 'plan-route-recompute-1', weekStart: '2026-04-13', date: '2026-04-14' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).not.toHaveProperty('snapshot');
    expect(response.body.data.week.weekStart).toBe('2026-04-13');
    expect(response.body.data.today.date).toBe('2026-04-14');
    expect(mockRecomputePlanningSnapshot).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      context: expect.objectContaining({
        userId: 12,
        tenantId: 12,
        timezone: 'Europe/Lisbon',
        language: 'pt-BR',
      }),
      idempotencyKey: 'plan-route-recompute-1',
      weekStart: '2026-04-13',
      date: '2026-04-14',
    });

    mockRecomputePlanningSnapshot.mockClear();
    const headerReplay = await dispatch('POST', '/recompute', {
      headers: { 'idempotency-key': 'plan-route-header-recompute-1' },
      body: null as unknown as Record<string, unknown>,
    });
    expect(headerReplay.statusCode).toBe(200);
    const replayInput = mockRecomputePlanningSnapshot.mock.calls[0]?.[0];
    expect(replayInput).toEqual(expect.objectContaining({
      idempotencyKey: 'plan-route-header-recompute-1',
    }));
    expect(replayInput.date).toBe(replayInput.context.targetDate);
    expect(replayInput.weekStart).toBe(replayInput.context.weekStart);
  });

  it('returns INVALID_INPUT for a malformed date before planner or profile reads', async () => {
    const response = await dispatch('GET', '/today?date=2026-02-30');

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();
  });

  it('rejects non-string recompute dates instead of silently defaulting them', async () => {
    const response = await dispatch('POST', '/recompute', {
      body: { weekStart: 20260413, date: ['2026-04-14'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockClearCacheByPrefix).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();
  });

  it('rejects recompute inputs whose requested date is outside the requested week', async () => {
    const response = await dispatch('POST', '/recompute', {
      body: { weekStart: '2026-04-13', date: '2026-04-21' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(mockClearCacheByPrefix).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();
  });

  it('separates route cache identity by the saved timezone', async () => {
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'pt-PT',
      timezone: 'America/New_York',
    });

    await dispatch('GET', '/week?weekStart=2026-04-13');

    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:12:2026-04-13:tz:America/New_York:route:pt',
    );
  });

  it('separates English, Brazilian Portuguese, and European Portuguese route caches', async () => {
    await dispatch('GET', '/week?weekStart=2026-04-13', {
      headers: { 'x-language': 'en-US' },
    });
    await dispatch('GET', '/week?weekStart=2026-04-13', {
      headers: { 'x-language': 'pt-BR' },
    });
    await dispatch('GET', '/week?weekStart=2026-04-13', {
      headers: { 'x-language': 'pt-PT' },
    });

    expect(mockGetCachedSWR.mock.calls.map(([key]) => key)).toEqual([
      'plan:week:u:12:tenant:12:2026-04-13:tz:Europe/Lisbon:route:en-us',
      'plan:week:u:12:tenant:12:2026-04-13:tz:Europe/Lisbon:route:pt-br',
      'plan:week:u:12:tenant:12:2026-04-13:tz:Europe/Lisbon:route:pt',
    ]);
  });

  it('returns typed validation and idempotency-conflict errors from recompute', async () => {
    const { PlanningRecomputeError } = await import('../../src/services/planning-recompute-service');
    mockRecomputePlanningSnapshot.mockRejectedValueOnce(new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IDEMPOTENCY_REQUIRED',
      'idempotencyKey is required.',
      400,
    ));
    const missingKey = await dispatch('POST', '/recompute', { body: {} });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.body.error.code).toBe('PLANNING_RECOMPUTE_IDEMPOTENCY_REQUIRED');

    mockRecomputePlanningSnapshot.mockRejectedValueOnce(new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IDEMPOTENCY_REUSED',
      'This idempotency key was already used for a different recompute request.',
      409,
    ));
    const reused = await dispatch('POST', '/recompute', {
      body: { idempotencyKey: 'reused', weekStart: '2026-04-13' },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.body.error.code).toBe('PLANNING_RECOMPUTE_IDEMPOTENCY_REUSED');
  });

  it('rejects malformed recompute dates before invoking the snapshot owner', async () => {
    const invalidWeek = await dispatch('POST', '/recompute', {
      body: { idempotencyKey: 'invalid-week', weekStart: '2026-04-14' },
    });
    expect(invalidWeek.statusCode).toBe(400);
    expect(invalidWeek.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });

    const invalidDate = await dispatch('POST', '/recompute', {
      body: { idempotencyKey: 'invalid-date', date: '2026-02-30' },
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.body.error).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(mockRecomputePlanningSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed on invalid tenant scope before recompute invalidation and planner reads', async () => {
    const response = await dispatch('POST', '/recompute', {
      userId: 0,
      body: { idempotencyKey: 'invalid-scope', weekStart: '2026-04-13', date: '2026-04-14' },
    });

    expect(response.statusCode, JSON.stringify(response.body)).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mockRecomputePlanningSnapshot).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'plan_route_recompute',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });
});
