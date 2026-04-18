import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockGetDailySummary = vi.fn();
const mockGetReadiness = vi.fn();
const mockGetSleep = vi.fn();
const mockGetUserProviders = vi.fn();
const mockGetCached = vi.fn();
const mockSetCache = vi.fn();

vi.mock('../../src/services/wearable', () => ({
  getDailySummary: (...args: unknown[]) => mockGetDailySummary(...args),
  getReadiness: (...args: unknown[]) => mockGetReadiness(...args),
  getSleep: (...args: unknown[]) => mockGetSleep(...args),
  getUserProviders: (...args: unknown[]) => mockGetUserProviders(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
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

import { wearableRoutes } from '../../src/api/routes/wearable';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function mockReq(userId: number, path: string): Request {
  const parsed = new URL(path, 'http://test.local');
  return {
    userId,
    method: 'GET',
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatch(userId: number, path: string): Promise<MockRes> {
  const router = wearableRoutes();
  const req = mockReq(userId, path);
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

describe('Wearable routes', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    vi.clearAllMocks();
    mockGetCached.mockReturnValue(null);
    mockGetDailySummary.mockResolvedValue({
      steps: 12000,
      calories: 2500,
    });
  });

  it('returns wearable summary for a valid authenticated user', async () => {
    const res = await dispatch(14, '/summary?date=2026-04-16');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.summary).toEqual({
      steps: 12000,
      calories: 2500,
    });
    expect(mockGetDailySummary).toHaveBeenCalledWith(14, '2026-04-16');
  });

  it('fails closed on invalid tenant scope before loading wearable summary', async () => {
    const res = await dispatch(0, '/summary?date=2026-04-16');

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockGetDailySummary).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'wearable_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });
});
