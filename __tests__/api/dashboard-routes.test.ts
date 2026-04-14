import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetUserById = vi.fn((userId: number) => ({ id: userId, first_name: 'Felipe' }));
const mockRuntimeStatus = vi.fn(() => ({
  serviceStatus: 'online',
  databaseStatus: 'connected',
  botStatus: 'offline',
  lastMessageAt: null,
}));
const mockDashboardDbAll = vi.fn(() => []);
const mockGetDailyQuotaStatus = vi.fn(() => ({
  over: false,
  spentUsd: 0.12,
  capUsd: 0.2,
  plan: 'pro',
  usageLevel: 'enhanced',
  usageFraction: 0.6,
  callsToday: 3,
  boostAvailable: false,
  limitUsd: 0.2,
  usedUsd: 0.12,
  remainingUsd: 0.08,
  resetAt: '2026-04-15T00:00:00.000Z',
}));
vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserLanguage: () => 'pt-BR',
}));

vi.mock('../../src/services/runtime-status', () => ({
  getRuntimeStatus: (...args: unknown[]) => mockRuntimeStatus(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  getDailyQuotaStatus: (...args: unknown[]) => mockGetDailyQuotaStatus(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockDashboardDbAll(...args),
      get: () => ({ ok: 1 }),
    }),
  }),
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

import { dashboardRoutes } from '../../src/api/routes/dashboard';

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

function mockReq(userId: number, headers: Record<string, string> = {}): Request {
  return {
    userId,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

async function dispatch(userId = 4, headers: Record<string, string> = {}): Promise<MockRes> {
  const router = dashboardRoutes();
  const req = mockReq(userId, headers);
  (req as any).method = 'GET';
  (req as any).url = '/';
  (req as any).originalUrl = '/';
  (req as any).baseUrl = '';
  (req as any).path = '/';
  (req as any).query = {};
  (req as any).params = {};
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

describe('Dashboard API route', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetUserById.mockReset();
    mockRuntimeStatus.mockReset();
    mockDashboardDbAll.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetUserById.mockImplementation((userId: number) => ({ id: userId, first_name: 'Felipe' }));
    mockRuntimeStatus.mockReturnValue({
      serviceStatus: 'online',
      databaseStatus: 'connected',
      botStatus: 'offline',
      lastMessageAt: null,
    });
    mockDashboardDbAll.mockReturnValue([]);
  });

  it('returns explicit unavailable states instead of silent dashboard zeroes', async () => {
    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.calendar.status).toBe('unavailable');
    expect(res.body.data.calendar.warningCodes).toEqual(['CALENDAR_UNAVAILABLE']);
    expect(res.body.data.tasks.status).toBe('unavailable');
    expect(res.body.data.training.status).toBe('unavailable');
    expect(res.body.data.training.readinessStatus).toBe('unavailable');
    expect(res.body.data.training.bodyBatteryStatus).toBe('unavailable');
    expect(res.body.data.training.readinessScore).toBeNull();
    expect(res.body.data.training.bodyBattery).toBeNull();
    expect(res.body.data.quota).toEqual({
      used_usd: 0.12,
      limit_usd: 0.2,
      remaining_usd: 0.08,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('localizes greeting and weekday when x-language is Portuguese', async () => {
    const res = await dispatch(4, { 'x-language': 'pt-BR' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.greeting).toMatch(/^(Bom dia|Boa tarde|Boa noite)(, Felipe)?$/);
    expect([
      'Segunda-feira',
      'Terça-feira',
      'Quarta-feira',
      'Quinta-feira',
      'Sexta-feira',
      'Sábado',
      'Domingo',
    ]).toContain(res.body.data.dayOfWeek);
  });

  it('marks content as unavailable instead of returning fake zero pipeline counts on database failure', async () => {
    mockDashboardDbAll.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    const res = await dispatch(4);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.content.status).toBe('unavailable');
    expect(res.body.data.content.warningCodes).toEqual(['CONTENT_UNAVAILABLE']);
    expect(res.body.data.content.pipelineCount).toEqual({
      ideas: 0,
      scripted: 0,
      filmed: 0,
      editing: 0,
      published: 0,
    });
  });
});
