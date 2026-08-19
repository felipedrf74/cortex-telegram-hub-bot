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
const mockRecordCurrentLegalConsentForUser = vi.fn();
const mockGetEffectiveEntitlement = vi.fn();

// A genuinely Apple-signed JWS cannot be minted in a test. Setting
// `hoisted.signedApplePayload` stands in for one; leaving it null keeps the
// real structural + signature verifier in play.
const hoisted = vi.hoisted(() => ({ signedApplePayload: null as Record<string, unknown> | null }));

// appAccountToken derivation is keyed strictly on IOS_API_JWT_SECRET — there is
// no source-literal fallback, because one would make every token forgeable by
// anyone who can read the repo. The test env does not set that secret, so it is
// supplied here; without it the route correctly returns a null token.
vi.mock('../../src/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/config')>('../../src/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      ios: { ...actual.config.ios, jwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long' },
    },
  };
});

vi.mock('../../src/services/apple-jws-verifier', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/apple-jws-verifier')>('../../src/services/apple-jws-verifier');
  return {
    ...actual,
    verifyAppleJws: (jws: string, options?: any) => (
      hoisted.signedApplePayload
        ? { header: { alg: 'ES256', x5c: ['stub'] }, payload: hoisted.signedApplePayload }
        : (actual.verifyAppleJws as any)(jws, options)
    ),
  };
});

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
    plan: usage.plan,
    resetAt: usage.resetAt,
    usageLevel: usage.usageLevel,
    usageFraction: usage.usageFraction,
    usagePercent: Math.round((usage.usageFraction || 0) * 100),
    isOverLimit: usage.over,
    aiAccessAllowed: usage.aiAccessAllowed,
    blockReason: usage.blockReason,
    dailyUsageFraction: usage.dailyUsageFraction,
    dailyUsagePercent: Math.round((usage.dailyUsageFraction || 0) * 100),
    dailyIsOverLimit: usage.dailyOver,
    dailyResetsAt: usage.dailyResetAt,
    monthlyUsageFraction: usage.monthlyUsageFraction,
    monthlyUsagePercent: Math.round((usage.monthlyUsageFraction || 0) * 100),
    monthlyIsOverLimit: usage.monthlyOver,
    monthlyResetsAt: usage.monthlyResetAt,
    unblocksAt: usage.unblocksAt,
    boostAvailable: usage.boostAvailable,
    nexusPointsBalance: usage.nexusPointsBalance,
    nexusPointsExpiringSoon: usage.nexusPointsExpiringSoon,
    nextCreditExpiryAt: usage.nextCreditExpiryAt,
    pointsPurchaseAvailable: usage.pointsPurchaseAvailable,
    nexusPointPackages: [
      { productId: 'me.nexushub.points.small', label: 'small', points: 100 },
      { productId: 'me.nexushub.points.medium', label: 'medium', points: 250 },
      { productId: 'me.nexushub.points.large', label: 'large', points: 600 },
    ],
  }),
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.04,
    plan: 'pro',
    usageLevel: 'enhanced',
    usageFraction: 0,
    dailyUsageFraction: 0,
    monthlyUsageFraction: 0,
    dailyOver: false,
    monthlyOver: false,
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
    dailyResetAt: '2026-05-21T00:00:00.000Z',
    monthlyResetAt: '2026-06-01T00:00:00.000Z',
    unblocksAt: '2026-05-21T00:00:00.000Z',
    aiAccessAllowed: true,
    blockReason: null,
    entitlement: {
      plan: 'pro',
      source: 'stripe',
      status: 'active',
    },
  })),
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
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

vi.mock('../../src/services/legal-consent', () => ({
  validateCurrentLegalAcceptance: (input: any) => {
    if (!input?.accepted || input.termsVersion !== '2026-06-05' || input.privacyVersion !== '2026-06-05') {
      return { ok: false, reason: 'acceptedLegal is not current' };
    }
    return { ok: true, value: input };
  },
  legalConsentContextFromRequest: (_req: any, source: string) => ({
    source,
    locale: 'en-US',
    documentUrl: 'https://nexushub.me/legal',
  }),
  recordCurrentLegalConsentForUser: (...args: unknown[]) => mockRecordCurrentLegalConsentForUser(...args),
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

function legalAcceptance() {
  return {
    accepted: true,
    termsVersion: '2026-06-05',
    privacyVersion: '2026-06-05',
  };
}

describe('billing routes', () => {
  beforeEach(() => {
    hoisted.signedApplePayload = null;
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
    mockRecordCurrentLegalConsentForUser.mockReset();
    mockGetEffectiveEntitlement.mockReset();
    mockGetEffectiveEntitlement.mockReturnValue({
      plan: 'pro',
      source: 'stripe',
      status: 'active',
      nexusPointsAllowed: true,
    });
  });

  it('rejects authenticated checkout without current legal acceptance', async () => {
    const res = await dispatch('POST', '/checkout', { plan: 'max', currency: 'brl' }, 99);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('LEGAL_CONSENT_REQUIRED');
    expect(mockCreateCheckoutSessionForPlan).not.toHaveBeenCalled();
  });

  it('creates checkout from server-side plan/currency mapping', async () => {
    mockCreateCheckoutSessionForPlan.mockResolvedValueOnce('https://checkout.stripe.test/session');

    const res = await dispatch('POST', '/checkout', { plan: 'max', currency: 'brl', acceptedLegal: legalAcceptance() }, 99);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/session');
    expect(mockRecordCurrentLegalConsentForUser).toHaveBeenCalledWith(
      99,
      legalAcceptance(),
      expect.objectContaining({ source: 'billing_checkout' }),
    );
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
      acceptedLegal: legalAcceptance(),
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

  it('rejects an Apple subscription claimed by another active account', async () => {
    const claimed = new Error('APPLE_TRANSACTION_ALREADY_CLAIMED');
    claimed.name = 'AppleTransactionAlreadyClaimedError';
    mockHandleAppleTransaction.mockImplementationOnce(() => {
      throw claimed;
    });

    const jwsTransaction = buildFakeJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.pro.monthly',
      transactionId: '2000000123456792',
      originalTransactionId: '2000000123456792',
      environment: 'Production',
      expiresDate: Date.now() + 7 * 86400000,
    });

    const res = await dispatch('POST', '/apple-verify', { jwsTransaction }, 99);

    expect(res.statusCode).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('APPLE_TRANSACTION_ALREADY_CLAIMED');
    expect(res.body.error.message).toContain('already attached');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('grants a Sandbox Apple transaction under NODE_ENV=production and records its provenance', async () => {
    // App Review purchases carry environment 'Sandbox' even on an
    // App-Store-Connect-distributed build. Rejecting them 403'd every reviewer
    // purchase after the client had already called transaction.finish(), so
    // nothing unlocked and the purchase was consumed. Guideline 2.1 blocker.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const expiresDate = Date.now() + 7 * 86400000;
      const purchaseDate = Date.now();
      hoisted.signedApplePayload = {
        bundleId: 'me.nexushub.app',
        productId: 'me.nexushub.pro.monthly',
        transactionId: '2000000123456793',
        originalTransactionId: '2000000123456793',
        environment: 'Sandbox',
        appAccountToken: '01000000-6bd0-3a2e-4a24-8f1c9b0d5e77',
        purchaseDate,
        expiresDate,
      };
      mockHandleAppleTransaction.mockReturnValueOnce({
        plan: 'pro',
        period: 'monthly',
        environment: 'Sandbox',
        transferredFromUserId: null,
      });

      const res = await dispatch('POST', '/apple-verify', {
        jwsTransaction: buildFakeJws(hoisted.signedApplePayload),
      }, 42);

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockHandleAppleTransaction).toHaveBeenCalledWith(
        42,
        '2000000123456793',
        'me.nexushub.pro.monthly',
        new Date(expiresDate).toISOString(),
        new Date(purchaseDate).toISOString(),
        { environment: 'Sandbox', appAccountToken: '01000000-6bd0-3a2e-4a24-8f1c9b0d5e77' },
      );
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'create',
        resource: 'billing.apple_verify.subscription',
        details: expect.objectContaining({ environment: 'Sandbox' }),
      }));

      // Missing provenance remains grantable, but the audit record must make
      // that absence explicit instead of inventing Production.
      mockLogAudit.mockClear();
      hoisted.signedApplePayload = {
        bundleId: 'me.nexushub.app',
        productId: 'me.nexushub.pro.monthly',
        transactionId: '2000000123456794',
        originalTransactionId: '2000000123456794',
        expiresDate,
      };
      mockHandleAppleTransaction.mockReturnValueOnce({
        plan: 'pro',
        period: 'monthly',
        environment: '',
        transferredFromUserId: null,
      });

      const noEnvironment = await dispatch('POST', '/apple-verify', {
        jwsTransaction: buildFakeJws(hoisted.signedApplePayload),
      }, 42);

      expect(noEnvironment.statusCode).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        resource: 'billing.apple_verify.subscription',
        details: expect.objectContaining({ environment: 'unknown' }),
      }));
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('refuses a transaction whose product id is not mapped to a plan', async () => {
    const unknown = new Error('UNKNOWN_APPLE_PRODUCT');
    unknown.name = 'UnknownAppleProductError';
    mockHandleAppleTransaction.mockImplementationOnce(() => {
      throw unknown;
    });

    const jwsTransaction = buildFakeJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.pro.monthly',
      transactionId: '2000000123456795',
      originalTransactionId: '2000000123456795',
      environment: 'Production',
      expiresDate: Date.now() + 7 * 86400000,
    });

    const res = await dispatch('POST', '/apple-verify', { jwsTransaction }, 99);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_PRODUCT');
  });

  it('exposes a stable appAccountToken for StoreKit purchases', async () => {
    const first = await dispatch('GET', '/status', undefined, 42);
    const second = await dispatch('GET', '/status', undefined, 42);
    const other = await dispatch('GET', '/status', undefined, 43);

    expect(first.body.data.appAccountToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second.body.data.appAccountToken).toBe(first.body.data.appAccountToken);
    expect(other.body.data.appAccountToken).not.toBe(first.body.data.appAccountToken);
  });

  it('preserves last-known billing state when the entitlement read fails', async () => {
    const { getSubscriptionStatus } = await import('../../src/services/stripe-service');
    const { isUserOverDailyCap } = await import('../../src/services/cost-guardrail');
    vi.mocked(getSubscriptionStatus).mockReturnValueOnce({
      plan: 'max',
      period: 'monthly',
      status: 'active',
      provider: 'apple',
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      isActive: true,
      isPro: true,
    });
    // The quota resolver fails closed: plan 'none', no entitlement. That must
    // not downgrade a paying account's billing identity.
    vi.mocked(isUserOverDailyCap).mockReturnValueOnce({
      plan: 'none',
      entitlement: null,
      over: true,
      usageLevel: 'none',
      usageFraction: 0,
      dailyUsageFraction: 0,
      monthlyUsageFraction: 0,
      aiAccessAllowed: false,
      blockReason: 'entitlement_error',
      boostAvailable: false,
      pointsPurchaseAvailable: false,
      nexusPointsBalance: 0,
      resetAt: '2026-05-21T00:00:00.000Z',
      dailyResetAt: '2026-05-21T00:00:00.000Z',
      monthlyResetAt: '2026-06-01T00:00:00.000Z',
    } as any);

    const res = await dispatch('GET', '/status', undefined, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: 'max',
      status: 'active',
      isActive: true,
      isPro: true,
    });
  });

  it('returns Nexus Points availability in billing status', async () => {
    const res = await dispatch('GET', '/status', undefined, 42);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: 'pro',
      isActive: true,
      isPro: true,
      nexusPointsBalance: 0,
      usageFraction: 0,
      usagePercent: 0,
      isOverLimit: false,
      pointsPurchaseAvailable: true,
      aiAccessAllowed: true,
      dailyUsageFraction: 0,
      monthlyUsageFraction: 0,
      dailyResetsAt: '2026-05-21T00:00:00.000Z',
      monthlyResetsAt: '2026-06-01T00:00:00.000Z',
    });
    expect(res.body.data.nexusPointPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'me.nexushub.points.small', points: 100 }),
      expect.objectContaining({ productId: 'me.nexushub.points.medium', points: 250 }),
      expect.objectContaining({ productId: 'me.nexushub.points.large', points: 600 }),
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

  it('blocks Free and trial users from buying unusable Nexus Points', async () => {
    for (const entitlement of [
      { plan: 'free', source: 'free', status: 'none', nexusPointsAllowed: false },
      { plan: 'pro', source: 'stripe', status: 'trialing', nexusPointsAllowed: false },
    ]) {
      mockGetEffectiveEntitlement.mockReturnValueOnce(entitlement);
      const res = await dispatch('POST', '/nexus-points/stripe-checkout', {
        packageId: 'me.nexushub.points.small',
      }, 42);
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('AI_PLAN_REQUIRED');
    }
    expect(mockCreateNexusPointsCheckoutSession).not.toHaveBeenCalled();
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
