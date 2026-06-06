import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));
const mockAcquireCostLock = vi.fn(async () => () => { /* no-op */ });

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

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  enforceCostGuardrails: (userId: number) => {
    const quota = mockIsUserOverDailyCap(userId);
    const global = { totalUsd: 0, limitUsd: 100, exceeded: false };
    if (!quota.over) return { block: false, status: 200, reason: 'ok', quota, global };
    return {
      block: true,
      status: 429,
      reason: 'daily_limit_exceeded',
      message: `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`,
      quota,
      global,
      details: {
        plan: quota.plan,
        resetAt: quota.resetAt,
      },
    };
  },
  acquireCostLock: (...args: unknown[]) => mockAcquireCostLock(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: content-script-routes uses the strict by-id helper.
  getUserLanguage: () => 'pt-BR',
  getUserLanguageById: () => 'pt-BR',
}));

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(body: any, userId?: number | null): Request {
  return {
    method: 'POST',
    url: '/script',
    originalUrl: '/script',
    baseUrl: '',
    path: '/script',
    query: {},
    params: {},
    headers: {},
    body,
    userId,
  } as any;
}

async function dispatch(body: any, userId: number | null = 12): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(body, userId);
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

describe('Content API — script quota enforcement', () => {
  beforeEach(() => {
    mockIsUserOverDailyCap.mockReset();
    mockAcquireCostLock.mockClear();
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('returns 429 before invoking script generation when quota is exhausted', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    });

    expect(response.statusCode).toBe(429);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('daily_limit_exceeded');
    expect(response.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('rejects invalid authenticated user scope before acquiring the cost lock', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    }, null);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toBe('Invalid authenticated user scope');
    expect(mockAcquireCostLock).not.toHaveBeenCalled();
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
  });
});
