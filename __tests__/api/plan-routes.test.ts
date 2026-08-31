import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockComposeWeeklyPlan = vi.fn();
const mockComposeDailyBrief = vi.fn();
const mockGetCachedSWR = vi.fn();
const mockSetCacheSWR = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGetUserById = vi.fn();
const mockGetUserLanguageById = vi.fn();
const mockGetUserTimezoneById = vi.fn();
let mockEffectivePlan: 'free' | 'pro' | 'max' | 'owner' = 'max';

function expectCachePrefixesCleared(...prefixes: string[]) {
  const cleared = mockClearCacheByPrefix.mock.calls.flatMap(([prefix]) => (
    Array.isArray(prefix) ? prefix : [prefix]
  ));
  for (const prefix of prefixes) {
    expect(cleared).toContain(prefix);
  }
}

vi.mock('../../src/services/weekly-plan-orchestrator', () => ({
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

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
    mockGetUserById.mockReturnValue({ id: 12, tier: 'max' });
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
  });

  it('keys implicit daily and weekly route caches in the authenticated user timezone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-13T01:00:00.000Z'));
    mockGetUserTimezoneById.mockReturnValue('Pacific/Honolulu');

    await dispatch('GET', '/today');
    await dispatch('GET', '/week');

    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:today:u:12:tenant:12:2026-04-12:tz:Pacific/Honolulu:route:pt-br',
    );
    expect(mockGetCachedSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:12:2026-04-06:tz:Pacific/Honolulu:route:pt-br',
    );
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      timezone: 'Pacific/Honolulu',
    }));
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      timezone: 'Pacific/Honolulu',
    }));
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
      timezone: 'Europe/Lisbon',
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
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      timezone: 'Europe/Lisbon',
    });
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:12:2026-04-13:tz:Europe/Lisbon:route:pt-br',
      expect.objectContaining({ weekStart: '2026-04-13' }),
      120,
      600,
    );
  });

  it('passes tenant scope into weekly plan routes', async () => {
    const response = await dispatch('GET', '/week?weekStart=2026-04-13', { tenantId: 34 });

    expect(response.statusCode).toBe(200);
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 34,
      weekStart: '2026-04-13',
      timezone: 'Europe/Lisbon',
    });
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'plan:week:u:12:tenant:34:2026-04-13:tz:Europe/Lisbon:route:pt-br',
      expect.objectContaining({ weekStart: '2026-04-13' }),
      120,
      600,
    );
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

  it('clears both caches and recomputes week + today on recompute', async () => {
    const response = await dispatch('POST', '/recompute', {
      body: { weekStart: '2026-04-13', date: '2026-04-14' },
    });

    expect(response.statusCode).toBe(200);
    expectCachePrefixesCleared('plan:week:u:12:', 'plan:today:u:12:');
    expect(response.body.ok).toBe(true);
    expect(response.body.data.week.weekStart).toBe('2026-04-13');
    expect(response.body.data.today.date).toBe('2026-04-14');
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      timezone: 'Europe/Lisbon',
      syncSignals: true,
    }));
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      timezone: 'Europe/Lisbon',
    }));
  });

  it('fails closed on invalid tenant scope before recompute invalidation and planner reads', async () => {
    const response = await dispatch('POST', '/recompute', {
      userId: 0,
      body: { weekStart: '2026-04-13', date: '2026-04-14' },
    });

    expect(response.statusCode, JSON.stringify(response.body)).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mockClearCacheByPrefix).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockComposeDailyBrief).not.toHaveBeenCalled();

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
