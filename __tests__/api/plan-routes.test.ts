import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockComposeWeeklyPlan = vi.fn();
const mockComposeDailyBrief = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockGetUserById = vi.fn();

vi.mock('../../src/services/weekly-plan-orchestrator', () => ({
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
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
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    body,
    userId,
  } as any;
}

async function dispatch(
  method: 'GET' | 'POST',
  path: string,
  options: {
    userId?: number;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<MockRes> {
  const { planRoutes } = await import('../../src/api/routes/plan');
  const router = planRoutes();
  const req = mockReq(method, path, options.userId, options.headers, options.body);
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
    clearTenantScopeAnomaliesForTests();
    mockComposeWeeklyPlan.mockReset();
    mockComposeDailyBrief.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockGetUserById.mockReset();

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
    });
    mockGetUserById.mockReturnValue({ id: 12, tier: 'max' });
  });

  it('keeps plan routes available even if the old mesh flag is off', async () => {
    const response = await dispatch('GET', '/week');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.weekStart).toBe('2026-04-13');
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

  it('requires max tier for the explain route', async () => {
    mockGetUserById.mockReturnValue({ id: 12, tier: 'pro' });

    const response = await dispatch('GET', '/week/explain');

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
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

  it('clears both caches and recomputes week + today on recompute', async () => {
    const response = await dispatch('POST', '/recompute', {
      body: { weekStart: '2026-04-13', date: '2026-04-14' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:week:u:12:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('plan:today:u:12:');
    expect(response.body.ok).toBe(true);
    expect(response.body.data.week.weekStart).toBe('2026-04-13');
    expect(response.body.data.today.date).toBe('2026-04-14');
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
