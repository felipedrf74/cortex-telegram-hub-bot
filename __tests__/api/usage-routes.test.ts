import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDailyUsage = vi.fn();
const mockGetDailyQuotaStatus = vi.fn();

vi.mock('../../src/services/usage-metering', () => ({
  getDailyUsage: (...args: unknown[]) => mockGetDailyUsage(...args),
  getUsageRange: vi.fn(() => []),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  getDailyQuotaStatus: (...args: unknown[]) => mockGetDailyQuotaStatus(...args),
  buildQuotaUsagePayload: (quota: any) => ({
    plan: quota.plan,
    usageFraction: quota.usageFraction,
    usagePercent: Math.round(quota.usageFraction * 100),
    isOverLimit: quota.over,
    enforcementEnabled: quota.enforcementEnabled,
    aiAccessAllowed: quota.aiAccessAllowed,
    blockReason: quota.blockReason,
    dailyIsOverLimit: quota.dailyOver,
    monthlyIsOverLimit: quota.monthlyOver,
  }),
}));

vi.mock('../../src/api/tenant-route-scope', () => ({
  ensureValidTenantRouteScope: vi.fn(() => true),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { usageRoutes } from '../../src/api/routes/usage';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(name: string, value: string): MockResponse;
  end(): MockResponse;
}

function response(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    setHeader(name, value) { res.headers[name] = value; return res; },
    end() { return res; },
  };
  return res;
}

async function getUsage(): Promise<MockResponse> {
  const req = {
    method: 'GET',
    url: '/',
    originalUrl: '/',
    baseUrl: '',
    path: '/',
    query: {},
    params: {},
    headers: {},
    userId: 44,
  } as unknown as Request;
  const res = response();
  const router = usageRoutes();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: unknown) => err ? reject(err) : resolve());
    setTimeout(resolve, 20);
  });
  return res;
}

function quota(overrides: Record<string, unknown> = {}) {
  return {
    plan: 'free',
    usageFraction: 0,
    over: false,
    enforcementEnabled: true,
    aiAccessAllowed: false,
    blockReason: 'plan_required',
    dailyOver: false,
    monthlyOver: false,
    ...overrides,
  };
}

describe('GET /api/v1/usage compatibility contract', () => {
  beforeEach(() => {
    mockGetDailyUsage.mockReset();
    mockGetDailyQuotaStatus.mockReset();
    mockGetDailyUsage.mockReturnValue({
      date: '2026-07-10',
      messageCount: 2,
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      apiCalls: 2,
    });
  });

  it('does not emit a plan exceedance when Free is not effectively blocked', async () => {
    mockGetDailyQuotaStatus.mockReturnValue(quota());
    const res = await getUsage();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      usageLevel: 'ok',
      allowed: true,
      exceeded: [],
      isOverLimit: false,
      enforcementEnabled: true,
    });
  });

  it('keeps the legacy meter enum and reports only effective daily exhaustion', async () => {
    mockGetDailyQuotaStatus.mockReturnValue(quota({
      plan: 'pro',
      usageFraction: 1,
      over: true,
      aiAccessAllowed: true,
      blockReason: null,
      dailyOver: true,
    }));
    const res = await getUsage();
    expect(res.body.data).toMatchObject({
      usageLevel: 'exhausted',
      allowed: false,
      exceeded: ['daily'],
    });
  });

  it('uses near_limit without manufacturing an exceedance', async () => {
    mockGetDailyQuotaStatus.mockReturnValue(quota({
      plan: 'pro',
      usageFraction: 0.85,
      aiAccessAllowed: true,
      blockReason: null,
    }));
    const res = await getUsage();
    expect(res.body.data).toMatchObject({
      usageLevel: 'near_limit',
      allowed: true,
      exceeded: [],
    });
  });
});
