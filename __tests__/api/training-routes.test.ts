import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockClearCache = vi.fn();
const mockGenerateCoachBriefing = vi.fn();
const mockGetLatestByType = vi.fn();
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  clearCache: (...args: unknown[]) => mockClearCache(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
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

import { trainingRoutes } from '../../src/api/routes/training';

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

function mockReq(
  method: string,
  path: string,
  query: Record<string, any> = {},
  body?: any,
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers: {},
    body,
    userId: 12,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  query: Record<string, any> = {},
  body?: any,
): Promise<MockRes> {
  const router = trainingRoutes();
  const req = mockReq(method, path, query, body);
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

describe('Training API routes', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockClearCache.mockReset();
    mockGenerateCoachBriefing.mockReset();
    mockGetLatestByType.mockReset();
    mockIsUserOverDailyCap.mockReset();

    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue(null);
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGenerateCoachBriefing.mockResolvedValue({
      message: 'Coach ready.',
      recommendations: [],
      garminData: null,
    });
  });

  it('returns a cache-only miss without triggering a new coach generation', async () => {
    const res = await dispatch('GET', '/coach', { cacheOnly: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.cachedOnlyMiss).toBe(true);
    expect(res.body.data.briefing).toBe('');
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('restores the cached coach briefing from the latest coach report document', async () => {
    mockGetLatestByType.mockReturnValue({
      createdAt: new Date().toISOString(),
      summary: 'Automatic coach update ready.',
      documentJson: {
        message: 'Automatic coach update ready.',
        recommendations: [
          {
            action: 'MODIFY',
            eventId: 'evt-1',
            source: 'outlook',
            originalTitle: 'Track workout',
            newTitle: 'Easy run 30min',
            newStart: '2026-04-16T17:30:00Z',
            newEnd: '2026-04-16T18:00:00Z',
            summary: 'Move the quality work to tomorrow evening.',
            reason: 'Recovery is too low for speed work.',
          },
        ],
        readiness: {
          factors: {
            sleep: { score: 74 },
            bodyBattery: { score: 61 },
          },
        },
        errors: ['Garmin sync was unavailable.'],
      },
    });

    const res = await dispatch('GET', '/coach', { cacheOnly: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.briefing).toBe('Automatic coach update ready.');
    expect(res.body.data.restoredFromReport).toBe(true);
    expect(res.body.data.garminData).toEqual({
      sleepScore: 74,
      bodyBattery: 61,
      steps: null,
      activeMinutes: null,
    });
    expect(res.body.data.recommendations).toHaveLength(1);
    expect(res.body.data.warnings).toEqual(['Garmin sync was unavailable.']);
    expect(res.body.data.cachedOnlyMiss).toBeUndefined();
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalled();
  });

  it('returns 402 on plan generation when the user is over quota', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });

    const res = await dispatch('POST', '/plan/generate', {}, {
      objective: 'Lisbon Marathon October 2026',
    });

    expect(res.statusCode).toBe(402);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });
});
