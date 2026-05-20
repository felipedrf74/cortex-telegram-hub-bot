import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockHandleAppleTransaction = vi.fn();
const mockGrantNexusPoints = vi.fn();
const mockCreateNexusPointsCheckoutSession = vi.fn();
const mockIsStripeNexusPointsConfigured = vi.fn(() => true);

vi.mock('../../src/services/stripe-service', () => ({
  isStripeConfigured: vi.fn(() => true),
  getSubscriptionStatus: vi.fn(() => ({
    plan: 'free',
    period: 'monthly',
    status: 'inactive',
    provider: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isActive: false,
    isPro: false,
  })),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  handleAppleTransaction: (...args: unknown[]) => mockHandleAppleTransaction(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  buildQuotaUsagePayload: (usage: any) => ({
    resetAt: usage.resetAt,
    limitUsd: usage.limitUsd,
    usedUsd: usage.usedUsd,
    remainingUsd: usage.remainingUsd,
    planDailyLimitUsd: usage.planDailyLimitUsd,
    includedRemainingUsd: usage.includedRemainingUsd,
    nexusPointsBalance: usage.nexusPointsBalance,
    nexusPointsRemainingUsd: usage.nexusPointsRemainingUsd,
    nexusPointsExpiringSoon: usage.nexusPointsExpiringSoon,
    nexusPointsExpiringSoonUsd: usage.nexusPointsExpiringSoonUsd,
    nextCreditExpiryAt: usage.nextCreditExpiryAt,
    totalRemainingUsd: usage.totalRemainingUsd,
    pointsPurchaseAvailable: usage.pointsPurchaseAvailable,
    nexusPointPackages: [
      { productId: 'me.nexushub.points.small', label: 'small', priceUsd: 5, points: 300, usdAllowance: 0.30, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
      { productId: 'me.nexushub.points.medium', label: 'medium', priceUsd: 10, points: 600, usdAllowance: 0.60, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
      { productId: 'me.nexushub.points.large', label: 'large', priceUsd: 20, points: 1200, usdAllowance: 1.20, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
    ],
  }),
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.04,
    plan: 'pro',
    usageLevel: 'enhanced',
    usageFraction: 0,
    callsToday: 0,
    boostAvailable: true,
    limitUsd: 0.04,
    usedUsd: 0,
    remainingUsd: 0.04,
    planDailyLimitUsd: 0.04,
    includedRemainingUsd: 0.04,
    nexusPointsBalance: 0,
    nexusPointsRemainingUsd: 0,
    nexusPointsExpiringSoon: 0,
    nexusPointsExpiringSoonUsd: 0,
    nextCreditExpiryAt: null,
    totalRemainingUsd: 0.04,
    pointsPurchaseAvailable: true,
    resetAt: '2026-05-21T00:00:00.000Z',
  })),
}));

vi.mock('../../src/services/nexus-points', () => ({
  isNexusPointProductId: (productId: string) => productId.startsWith('me.nexushub.points.'),
  listNexusPointPackages: vi.fn(() => [
    { productId: 'me.nexushub.points.small', label: 'small', priceUsd: 5, points: 300, usdAllowance: 0.30, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
    { productId: 'me.nexushub.points.medium', label: 'medium', priceUsd: 10, points: 600, usdAllowance: 0.60, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
    { productId: 'me.nexushub.points.large', label: 'large', priceUsd: 20, points: 1200, usdAllowance: 1.20, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
  ]),
  grantNexusPoints: (...args: unknown[]) => mockGrantNexusPoints(...args),
}));

vi.mock('../../src/services/stripe-nexus-points-service', () => ({
  createNexusPointsCheckoutSession: (...args: unknown[]) => mockCreateNexusPointsCheckoutSession(...args),
  isStripeNexusPointsConfigured: () => mockIsStripeNexusPointsConfigured(),
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
  LOGGER_REDACTION_PATHS: [],
}));

import { billingRoutes } from '../../src/api/routes/billing';

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

function mockReq(method: string, path: string, body?: any, userId = 22): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers: {},
    body,
    userId,
  } as any;
}

async function dispatch(method: string, path: string, body?: any, userId = 22): Promise<MockRes> {
  const router = billingRoutes();
  const req = mockReq(method, path, body, userId);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setTimeout(resolve, 25);
  });

  return res;
}

function buildFakeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('billing routes', () => {
  beforeEach(() => {
    mockHandleAppleTransaction.mockReset();
    mockGrantNexusPoints.mockReset();
    mockGrantNexusPoints.mockReturnValue({
      granted: true,
      creditId: 77,
      package: { productId: 'me.nexushub.points.small', label: 'small', priceUsd: 5, points: 300, usdAllowance: 0.30, aiOnlyMarginPct: 94, netMarginAfterAppleCutPct: 91.4 },
    });
    mockCreateNexusPointsCheckoutSession.mockReset();
    mockCreateNexusPointsCheckoutSession.mockResolvedValue({ sessionId: 'cs_points', checkoutUrl: 'https://checkout.stripe.test/points' });
    mockIsStripeNexusPointsConfigured.mockReset();
    mockIsStripeNexusPointsConfigured.mockReturnValue(true);
  });

  it('sanitizes apple verification failures instead of leaking internals', async () => {
    mockHandleAppleTransaction.mockImplementationOnce(() => {
      throw new Error('sqlite write exploded during apple verify');
    });

    const jwsTransaction = buildFakeJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.pro.monthly',
      transactionId: '2000000123456789',
      originalTransactionId: '2000000123456789',
      environment: 'Production',
      expiresDate: Date.now() + 7 * 86400000,
    });

    const res = await dispatch('POST', '/apple-verify', { jwsTransaction });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VERIFICATION_FAILED');
    expect(res.body.error.message).toBe('Failed to verify Apple transaction');
    expect(JSON.stringify(res.body)).not.toContain('sqlite write exploded');
  });

  it('returns Nexus Points availability in billing status', async () => {
    const res = await dispatch('GET', '/status', undefined, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      nexusPointsBalance: 0,
      includedRemainingUsd: 0.04,
      totalRemainingUsd: 0.04,
      pointsPurchaseAvailable: true,
    });
    expect(res.body.data.nexusPointPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'me.nexushub.points.small', points: 300 }),
      expect.objectContaining({ productId: 'me.nexushub.points.medium', points: 600 }),
      expect.objectContaining({ productId: 'me.nexushub.points.large', points: 1200 }),
    ]));
  });

  it('returns Nexus Points availability in billing usage', async () => {
    const res = await dispatch('GET', '/usage', undefined, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      nexusPointsBalance: 0,
      includedRemainingUsd: 0.04,
      totalRemainingUsd: 0.04,
      pointsPurchaseAvailable: true,
    });
  });

  it('processes Nexus Point Apple products through the point ledger instead of subscriptions', async () => {
    const jwsTransaction = buildFakeJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.points.small',
      transactionId: '2000000123456790',
      originalTransactionId: '2000000123456790',
      environment: 'Production',
    });

    const res = await dispatch('POST', '/apple-verify', { jwsTransaction }, 42);

    expect(res.statusCode).toBe(200);
    expect(mockHandleAppleTransaction).not.toHaveBeenCalled();
    expect(mockGrantNexusPoints).toHaveBeenCalledWith({
      userId: 42,
      provider: 'apple',
      providerTransactionId: '2000000123456790',
      productId: 'me.nexushub.points.small',
      source: 'apple_iap',
    });
    expect(res.body.data).toMatchObject({
      pointsPurchaseAvailable: true,
      nexusPointsPurchase: {
        granted: true,
        productId: 'me.nexushub.points.small',
        points: 300,
        usdAllowance: 0.30,
      },
    });
  });

  it('creates web-only Stripe Nexus Points checkout from authenticated request scope', async () => {
    const res = await dispatch('POST', '/nexus-points/stripe-checkout', {
      packageId: 'me.nexushub.points.medium',
      userId: 999,
      tenantId: 999,
    }, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ sessionId: 'cs_points', checkoutUrl: 'https://checkout.stripe.test/points' });
    expect(mockCreateNexusPointsCheckoutSession).toHaveBeenCalledWith({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.medium',
      source: 'web',
    });
  });

  it('rejects bad or disabled Stripe Nexus Points checkout requests', async () => {
    const bad = await dispatch('POST', '/nexus-points/stripe-checkout', { packageId: 'bad' }, 42);
    expect(bad.statusCode).toBe(400);
    expect(mockCreateNexusPointsCheckoutSession).not.toHaveBeenCalled();

    mockIsStripeNexusPointsConfigured.mockReturnValue(false);
    const disabled = await dispatch('POST', '/nexus-points/stripe-checkout', { packageId: 'me.nexushub.points.small' }, 42);
    expect(disabled.statusCode).toBe(503);
  });
});
