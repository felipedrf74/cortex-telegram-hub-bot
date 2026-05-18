import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockHandleAppleTransaction = vi.fn();
const mockCreateCheckoutSessionForPlan = vi.fn();
const mockCreatePortalSession = vi.fn();
const mockClaimWebsiteStripeSubscriptionForUser = vi.fn();

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
    mockCreateCheckoutSessionForPlan.mockReset();
    mockCreatePortalSession.mockReset();
    mockClaimWebsiteStripeSubscriptionForUser.mockReset();
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
});
