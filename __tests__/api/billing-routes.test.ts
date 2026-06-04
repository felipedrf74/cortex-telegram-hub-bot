import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockHandleAppleTransaction = vi.fn();
const mockCreateCheckoutSessionForPlan = vi.fn();
const mockCreatePortalSession = vi.fn();
const mockClaimWebsiteStripeSubscriptionForUser = vi.fn();
const mockGrantNexusPoints = vi.fn();
const mockCreateNexusPointsCheckoutSession = vi.fn();
const mockIsStripeNexusPointsConfigured = vi.fn(() => true);
const mockLogAudit = vi.fn();

vi.mock('../../src/services/stripe-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/stripe-service')>('../../src/services/stripe-service');
  return {
    ...actual,
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
    createCheckoutSessionForPlan: (...args: unknown[]) => mockCreateCheckoutSessionForPlan(...args),
    createPortalSession: (...args: unknown[]) => mockCreatePortalSession(...args),
    claimWebsiteStripeSubscriptionForUser: (...args: unknown[]) => mockClaimWebsiteStripeSubscriptionForUser(...args),
    handleAppleTransaction: (...args: unknown[]) => mockHandleAppleTransaction(...args),
  };
});

vi.mock('../../src/services/cost-guardrail', () => ({
  buildQuotaUsagePayload: (usage: any) => ({
    resetAt: usage.resetAt,
    usageLevel: usage.usageLevel,
    usageFraction: usage.usageFraction,
    usagePercent: Math.round((usage.usageFraction || 0) * 100),
    isOverLimit: usage.over,
    boostAvailable: usage.boostAvailable,
    nexusPointsBalance: usage.nexusPointsBalance,
    nexusPointsExpiringSoon: usage.nexusPointsExpiringSoon,
    nextCreditExpiryAt: usage.nextCreditExpiryAt,
    pointsPurchaseAvailable: usage.pointsPurchaseAvailable,
    nexusPointPackages: [
      { productId: 'me.nexushub.points.small', label: 'small', points: 300 },
      { productId: 'me.nexushub.points.medium', label: 'medium', points: 600 },
      { productId: 'me.nexushub.points.large', label: 'large', points: 1200 },
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
  isStripeNexusPointsIdempotencyConflictError: (err: any) => err?.code === 'IDEMPOTENCY_CONFLICT',
  isStripeNexusPointsConfigured: () => mockIsStripeNexusPointsConfigured(),
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
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

function mockReq(method: string, path: string, body?: any, userId = 22, headers: Record<string, string> = {}): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers,
    body,
    userId,
  } as any;
}

async function dispatch(method: string, path: string, body?: any, userId = 22, headers: Record<string, string> = {}): Promise<MockRes> {
  const router = billingRoutes();
  const req = mockReq(method, path, body, userId, headers);
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
    mockCreateCheckoutSessionForPlan.mockReset();
    mockCreatePortalSession.mockReset();
    mockClaimWebsiteStripeSubscriptionForUser.mockReset();
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
    mockLogAudit.mockReset();
  });

  it('creates checkout from server-side plan/currency mapping', async () => {
    mockCreateCheckoutSessionForPlan.mockResolvedValueOnce('https://checkout.stripe.test/session');

    const res = await dispatch('POST', '/checkout', { plan: 'max', currency: 'brl' }, 99);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/session');
    expect(mockCreateCheckoutSessionForPlan).toHaveBeenCalledWith(
      99,
      'max',
      'brl',
      'https://nexushub.me/?checkout=success',
      'https://nexushub.me/?checkout=canceled',
    );
  });

  it('sanitizes authenticated checkout and portal redirect URLs', async () => {
    mockCreateCheckoutSessionForPlan.mockResolvedValueOnce('https://checkout.stripe.test/session');
    mockCreatePortalSession.mockResolvedValueOnce('https://billing.stripe.test/session');

    const checkout = await dispatch('POST', '/checkout', {
      plan: 'pro',
      currency: 'usd',
      successUrl: 'https://evil.example/success',
      cancelUrl: 'https://www.nexushub.me/cancel',
    }, 99);
    const portal = await dispatch('POST', '/portal', {
      returnUrl: 'https://evil.example/account',
    }, 99);

    expect(checkout.statusCode).toBe(200);
    expect(portal.statusCode).toBe(200);
    expect(mockCreateCheckoutSessionForPlan).toHaveBeenCalledWith(
      99,
      'pro',
      'usd',
      'https://nexushub.me/?checkout=success',
      'https://www.nexushub.me/cancel',
    );
    expect(mockCreatePortalSession).toHaveBeenCalledWith(99, 'https://nexushub.me/');
  });

  it('claims a verified website checkout for the authenticated user', async () => {
    mockClaimWebsiteStripeSubscriptionForUser.mockReturnValueOnce(true);

    const res = await dispatch('POST', '/claim-website-checkout', undefined, 99);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { claimed: true } });
    expect(mockClaimWebsiteStripeSubscriptionForUser).toHaveBeenCalledWith(99);
  });

  it('returns 404 when no verified website checkout can be claimed', async () => {
    mockClaimWebsiteStripeSubscriptionForUser.mockReturnValueOnce(false);

    const res = await dispatch('POST', '/claim-website-checkout', undefined, 99);

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NO_CLAIMABLE_SUBSCRIPTION');
  });

  it('rejects unknown checkout plan values before Stripe is called', async () => {
    const res = await dispatch('POST', '/checkout', { plan: 'ultra', currency: 'usd' }, 99);

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(mockCreateCheckoutSessionForPlan).not.toHaveBeenCalled();
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
      usageFraction: 0,
      usagePercent: 0,
      isOverLimit: false,
      pointsPurchaseAvailable: true,
    });
    expect(res.body.data.nexusPointPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'me.nexushub.points.small', points: 300 }),
      expect.objectContaining({ productId: 'me.nexushub.points.medium', points: 600 }),
      expect.objectContaining({ productId: 'me.nexushub.points.large', points: 1200 }),
    ]));
    expect(JSON.stringify(res.body.data)).not.toMatch(/usd|allowance/i);
  });

  it('returns Nexus Points availability in billing usage', async () => {
    const res = await dispatch('GET', '/usage', undefined, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      nexusPointsBalance: 0,
      usageFraction: 0,
      usagePercent: 0,
      isOverLimit: false,
      pointsPurchaseAvailable: true,
    });
    expect(JSON.stringify(res.body.data)).not.toMatch(/usd|allowance/i);
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
      metadata: {
        transactionId: '2000000123456790',
        originalTransactionId: '2000000123456790',
      },
    });
    expect(res.body.data).toMatchObject({
      pointsPurchaseAvailable: true,
      nexusPointsPurchase: {
        granted: true,
        productId: 'me.nexushub.points.small',
        points: 300,
      },
    });
    expect(JSON.stringify(res.body.data.nexusPointsPurchase)).not.toMatch(/usd|allowance/i);
  });

  it('rejects unsigned Apple transaction JWS in production mode', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const jwsTransaction = buildFakeJws({
        bundleId: 'me.nexushub.app',
        productId: 'me.nexushub.pro.monthly',
        transactionId: '2000000123456791',
        originalTransactionId: '2000000123456791',
        environment: 'Production',
        expiresDate: Date.now() + 7 * 86400000,
      });

      const res = await dispatch('POST', '/apple-verify', { jwsTransaction }, 42);

      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
      expect(mockHandleAppleTransaction).not.toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('creates web-only Stripe Nexus Points checkout from authenticated request scope', async () => {
    const res = await dispatch('POST', '/nexus-points/stripe-checkout', {
      packageId: 'me.nexushub.points.medium',
    }, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ sessionId: 'cs_points', checkoutUrl: 'https://checkout.stripe.test/points' });
    expect(mockCreateNexusPointsCheckoutSession).toHaveBeenCalledWith({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.medium',
      source: 'web',
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 42,
      userId: 42,
      actorId: 42,
      action: 'billing.nexus_points.checkout_started',
      details: expect.objectContaining({
        sessionId: 'cs_points',
        packageId: 'me.nexushub.points.medium',
        source: 'web',
      }),
    }));
  });

  it('rejects oversized and body-spoofed Stripe Nexus Points checkout requests', async () => {
    const oversized = await dispatch(
      'POST',
      '/nexus-points/stripe-checkout',
      { packageId: 'me.nexushub.points.small' },
      42,
      { 'content-length': String(100 * 1024) },
    );
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const spoofed = await dispatch('POST', '/nexus-points/stripe-checkout', {
      packageId: 'me.nexushub.points.medium',
      userId: 999,
      tenantId: 999,
    }, 42);
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.body.error.code).toBe('UNEXPECTED_BODY_FIELDS');
    expect(mockCreateNexusPointsCheckoutSession).not.toHaveBeenCalled();
  });

  it('maps Stripe Nexus Points idempotency conflicts to 409 for website checkout', async () => {
    mockCreateNexusPointsCheckoutSession.mockRejectedValueOnce({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'A different Stripe Nexus Points checkout was created with the same key in the current minute window. Wait ~60s before creating another checkout for this user/package/source.',
    });

    const res = await dispatch('POST', '/nexus-points/stripe-checkout', {
      packageId: 'me.nexushub.points.medium',
    }, 42);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(mockLogAudit).not.toHaveBeenCalled();
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
