import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockIsUserOverDailyCap = vi.fn((..._args: unknown[]) => ({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));
const mockWithAiBudgetReservation = vi.fn();
const mockGetScriptProvider = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }),
    transaction: (fn: () => unknown) => fn,
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/cost-guardrail', () => {
  class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.name = 'AiBudgetError'; this.decision = decision; }
  }
  return {
    AiBudgetError,
    buildQuotaExceededPayload: vi.fn((quota: { plan: string; resetAt: string }) => ({
      plan: quota.plan,
      resetAt: quota.resetAt,
    })),
    isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
    getDailyQuotaStatus: (...args: unknown[]) => {
      const quota = mockIsUserOverDailyCap(...args);
      return { ...quota, usageFraction: quota.over ? 1 : 0 };
    },
    withAiBudgetReservation: (...args: unknown[]) => mockWithAiBudgetReservation(...args),
    buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  };
});

vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => {
    const providerBoundary = args[16] as ((providerCall: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const providerCall = () => mockGetScriptProvider(...args.slice(0, 16));
    return providerBoundary ? providerBoundary(providerCall) : providerCall();
  },
}));

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: content-script-routes uses the strict by-id helper.
  getUserLanguage: () => 'pt-BR',
  getUserLanguageById: () => 'pt-BR',
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => true),
}));

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  getHeader(name: string): string | undefined;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; return response; },
    getHeader(name: string) { return response.headers[name.toLowerCase()]; },
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
    header: () => undefined,
    socket: { remoteAddress: '127.0.0.1' },
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
    mockWithAiBudgetReservation.mockReset();
    mockGetScriptProvider.mockReset();
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockWithAiBudgetReservation.mockImplementation(async (_request: unknown, providerCall: () => Promise<unknown>) => {
      const quota = mockIsUserOverDailyCap(12);
      if (quota.over) {
        const error = new Error('AI_DAILY_LIMIT_REACHED') as Error & { name: string; decision: Record<string, unknown> };
        error.name = 'AiBudgetError';
        error.decision = {
          allowed: false,
          status: 429,
          code: 'AI_DAILY_LIMIT_REACHED',
          window: 'daily',
          message: `Daily AI quota reached for the ${quota.plan} plan.`,
          quota: { ...quota, usageFraction: 1 },
          reservedCostUsd: 0.01,
          retryAfterSeconds: 60,
          unblocksAt: quota.resetAt,
        };
        throw error;
      }
      return providerCall();
    });
  });

  it('returns 429 before invoking script generation when quota is exhausted', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    });

    const errorLogs = mockLoggerError.mock.calls.map(([entry]) => ({
      name: (entry as any)?.err?.name,
      message: (entry as any)?.err?.message,
      decision: (entry as any)?.err?.decision,
    }));
    expect(response.statusCode, JSON.stringify({ body: response.body, logs: errorLogs })).toBe(429);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('AI_DAILY_LIMIT_REACHED');
    expect(response.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
      window: 'daily',
      unblocksAt: '2026-04-15T00:00:00.000Z',
      retryAfterSeconds: 60,
      error: 'rate_limited',
      retryable: true,
    });
    expect(mockGetScriptProvider).not.toHaveBeenCalled();
  });

  it('rejects invalid authenticated user scope before starting a budget reservation', async () => {
    const response = await dispatch({
      topic: 'How to recover after hard intervals',
      format: 'Reel',
    }, null);

    expect(response.statusCode).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toBe('Invalid authenticated user scope');
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();
    expect(mockIsUserOverDailyCap).not.toHaveBeenCalled();
  });
});
