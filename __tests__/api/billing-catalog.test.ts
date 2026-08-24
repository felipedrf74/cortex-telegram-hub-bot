// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

let stripePriceIds = {
  planProMonthly: '',
  planMaxMonthly: '',
  pack100: '',
  pack250: '',
  pack600: '',
};
let appleProductIds = { pack100: '', pack250: '', pack600: '' };
let anonymousCheckoutEnabled = true;
let subscriptionCheckoutEnabled = true;
let stripePackSalesEnabled = false;
let applePackSalesEnabled = false;
let stripeConfigured = true;
let entitlement: { plan: string; status: string } = { plan: 'pro', status: 'active' };

const mockCreateCheckoutSession = vi.fn(async () => 'https://checkout.stripe.test/session');
const mockCreateCreditPackCheckoutSession = vi.fn(async () => 'https://checkout.stripe.test/pack-session');
const mockCreatePublicCheckoutSession = vi.fn(async () => 'https://checkout.stripe.test/public');
const mockRecordLegalConsent = vi.fn(async () => undefined);

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      stripe: {
        ...actual.config.stripe,
        expectedAccountId: 'acct_catalogtest',
      },
      get hybridCommerce() {
        return {
          stripePriceIds,
          appleProductIds,
          applePackFulfillmentEnabled: applePackSalesEnabled,
          stripePackFulfillmentEnabled: stripePackSalesEnabled,
          subscriptionCheckoutEnabled,
          anonymousCheckoutEnabled,
        };
      },
    },
  };
});

vi.mock('../../src/services/stripe-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stripe-service')>();
  return {
    ...actual,
    isStripeConfigured: () => stripeConfigured,
    createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...(args as [])),
    createCreditPackCheckoutSession: (...args: unknown[]) => mockCreateCreditPackCheckoutSession(...(args as [])),
    createPublicCheckoutSession: (...args: unknown[]) => mockCreatePublicCheckoutSession(...(args as [])),
  };
});

vi.mock('../../src/services/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/entitlement')>();
  return {
    ...actual,
    getEffectiveEntitlement: vi.fn(() => entitlement),
  };
});

vi.mock('../../src/services/credit-pack-entitlement', () => ({
  isCreditPackPurchaseEligible: vi.fn(() => (
    (entitlement.plan === 'pro' || entitlement.plan === 'max')
      && entitlement.status === 'active'
  )),
}));

vi.mock('../../src/services/plan-quotas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/plan-quotas')>();
  return {
    ...actual,
    resolveBillingPlanForUser: vi.fn(() => 'pro'),
  };
});

vi.mock('../../src/services/ai-credit-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ai-credit-ledger')>();
  return {
    ...actual,
    getAiCreditWallet: vi.fn(() => ({
      includedRemaining: 480,
      promotionalRemaining: 20,
      purchasedRemaining: 100,
      reservedCredits: 3,
      availableCredits: 597,
      dailyCapCredits: 50,
      dailyUsedCredits: 5,
      dailyRemainingCredits: 45,
      planMonthlyCredits: 500,
    })),
  };
});

vi.mock('../../src/services/legal-consent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/legal-consent')>();
  return {
    ...actual,
    validateCurrentLegalAcceptance: vi.fn(() => ({ ok: true })),
    recordCurrentLegalConsentForUser: (...args: unknown[]) => mockRecordLegalConsent(...(args as [])),
  };
});

vi.mock('../../src/services/cost-guardrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/cost-guardrail')>();
  return {
    ...actual,
    buildQuotaUsagePayload: vi.fn(() => ({})),
    isUserOverDailyCap: vi.fn(() => ({})),
  };
});

vi.mock('../../src/services/audit-trail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/audit-trail')>();
  return {
    ...actual,
    logAudit: vi.fn(),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { billingRoutes } from '../../src/api/routes/billing';
import { createPublicBillingRouter } from '../../src/api/routes/public-billing';

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
    headers: { 'x-forwarded-for': '203.0.113.42' },
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
    headers: { 'x-forwarded-for': '203.0.113.42' },
    body,
    userId,
  } as any;
}

async function dispatch(router: any, method: string, path: string, body?: any, userId = 22): Promise<MockRes> {
  const req = mockReq(method, path, body, userId);
  const res = mockRes();
  await new Promise<void>((resolve) => {
    router.handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setTimeout(resolve, 25);
  });
  return res;
}

const LEGAL = { termsVersion: 'current', privacyVersion: 'current' };

describe('billing catalog, wallet, and credits checkout', () => {
  beforeEach(() => {
    stripePriceIds = { planProMonthly: '', planMaxMonthly: '', pack100: '', pack250: '', pack600: '' };
    appleProductIds = { pack100: '', pack250: '', pack600: '' };
    anonymousCheckoutEnabled = true;
    subscriptionCheckoutEnabled = true;
    stripePackSalesEnabled = false;
    applePackSalesEnabled = false;
    stripeConfigured = true;
    entitlement = { plan: 'pro', status: 'active' };
    mockCreateCheckoutSession.mockClear();
    mockCreateCreditPackCheckoutSession.mockClear();
    mockCreatePublicCheckoutSession.mockClear();
  });

  it('serves the versioned catalog with fail-closed purchasability and no provider ids', async () => {
    stripePriceIds.planProMonthly = 'price_pro_test';
    stripePriceIds.pack100 = 'price_pack100_test';
    const res = await dispatch(billingRoutes(), 'GET', '/catalog');
    expect(res.statusCode).toBe(200);
    const items = res.body.data.items;
    const byId = new Map(items.map((item: any) => [item.id, item]));
    expect((byId.get('plan.pro.monthly') as any).purchasable).toBe(true);
    expect(byId.get('plan.max.monthly') as any).toMatchObject({
      purchasable: false,
      unavailableReason: 'provider_price_missing',
    });
    expect(byId.get('pack.credits.100') as any).toMatchObject({
      purchasable: false,
      unavailableReason: 'fulfillment_pending',
      requiresActivePaidPlan: true,
    });
    expect(byId.get('pack.credits.250') as any).toMatchObject({
      purchasable: false,
      unavailableReason: 'provider_price_missing',
    });
    for (const item of items) {
      expect(item).not.toHaveProperty('stripePriceId');
      if (item.kind === 'subscription') {
        expect(item).not.toHaveProperty('appleProductId');
      }
    }
  });

  it('exposes configured Apple product ids on packs only, never Stripe prices', async () => {
    appleProductIds.pack100 = 'me.nexushub.credits.pack100';
    const res = await dispatch(billingRoutes(), 'GET', '/catalog');
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.body.data.items.map((item: any) => [item.id, item]));
    // iOS binds catalog packs to StoreKit products by this public identifier.
    expect((byId.get('pack.credits.100') as any).appleProductId).toBe('me.nexushub.credits.pack100');
    // An unconfigured pack omits the field instead of sending an empty string.
    expect(byId.get('pack.credits.250') as any).not.toHaveProperty('appleProductId');
    // Subscriptions and Stripe identifiers never leave the server.
    expect(byId.get('plan.pro.monthly') as any).not.toHaveProperty('appleProductId');
    for (const item of res.body.data.items) {
      expect(item).not.toHaveProperty('stripePriceId');
    }
  });

  it('serves the wallet with separated credit balances', async () => {
    const res = await dispatch(billingRoutes(), 'GET', '/wallet');
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: 'pro',
      wallet: {
        includedRemaining: 480,
        promotionalRemaining: 20,
        purchasedRemaining: 100,
        reservedCredits: 3,
        availableCredits: 597,
      },
    });
  });

  it('rejects unknown catalog items without touching Stripe', async () => {
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'plan.legacy.yearly',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_CATALOG_ITEM');
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('requires an active paid plan before a pack can be considered', async () => {
    entitlement = { plan: 'free', status: 'none' };
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'pack.credits.100',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('PACK_REQUIRES_PAID_PLAN');
  });

  it('fails closed on packs until fulfillment exists, even for paid users', async () => {
    stripePriceIds.pack100 = 'price_pack100_test';
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'pack.credits.100',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_ITEM_UNAVAILABLE');
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('sells packs through a payment-mode session once the sales switch is on', async () => {
    stripePackSalesEnabled = true;
    stripePriceIds.pack100 = 'price_pack100_test';
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'pack.credits.100',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/pack-session');
    expect(mockCreateCreditPackCheckoutSession).toHaveBeenCalledTimes(1);
    const [userId, packInput] = mockCreateCreditPackCheckoutSession.mock.calls[0] as unknown as [number, { catalogItemId: string; priceId: string }];
    expect(userId).toBe(22);
    expect(packInput).toEqual({ catalogItemId: 'pack.credits.100', priceId: 'price_pack100_test' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses web pack checkout when only the Apple channel is live (QA5 P1-3)', async () => {
    // The Stripe pack kill switch is engaged (stripePackSalesEnabled=false)
    // while Apple sells packs. Gating on the cross-channel OR would leave web
    // checkout open and make the Stripe kill switch ineffective.
    applePackSalesEnabled = true;
    stripePriceIds.pack100 = 'price_pack100_test';
    appleProductIds.pack100 = 'me.nexushub.credits.pack100';
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'pack.credits.100',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_ITEM_UNAVAILABLE');
    expect(mockCreateCreditPackCheckoutSession).not.toHaveBeenCalled();
  });

  it('creates subscription checkout with the server-resolved price id only', async () => {
    stripePriceIds.planProMonthly = 'price_pro_test';
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'plan.pro.monthly',
      acceptedLegal: LEGAL,
      successUrl: 'https://evil.example/redirect',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/session');
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    const [userId, priceId, successUrl] = mockCreateCheckoutSession.mock.calls[0] as unknown as [number, string, string];
    expect(userId).toBe(22);
    expect(priceId).toBe('price_pro_test');
    expect(successUrl).not.toContain('evil.example');
  });

  it('maps Stripe account-binding failures to a fail-closed 503 response', async () => {
    stripePriceIds.planProMonthly = 'price_pro_test';
    const bindingError = Object.assign(new Error('wrong account'), { name: 'StripeAccountBindingError' });
    mockCreateCheckoutSession.mockRejectedValueOnce(bindingError);
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'plan.pro.monthly',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CHECKOUT_UNAVAILABLE');
  });

  it('fails closed when the subscription price object is not provisioned', async () => {
    const res = await dispatch(billingRoutes(), 'POST', '/credits-checkout', {
      catalogItemId: 'plan.pro.monthly',
      acceptedLegal: LEGAL,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_ITEM_UNAVAILABLE');
  });

  it('keeps configured subscription prices unavailable until positive activation', async () => {
    stripePriceIds.planProMonthly = 'price_pro_test';
    subscriptionCheckoutEnabled = false;
    const res = await dispatch(billingRoutes(), 'GET', '/catalog');
    const pro = res.body.data.items.find((item: any) => item.id === 'plan.pro.monthly');
    expect(pro).toMatchObject({
      purchasable: false,
      stripePurchasable: false,
      unavailableReason: 'fulfillment_pending',
    });
  });
});

describe('anonymous checkout sunset', () => {
  beforeEach(() => {
    anonymousCheckoutEnabled = true;
    stripeConfigured = false;
  });

  it('returns 410 for new anonymous sessions once the sunset flag flips', async () => {
    anonymousCheckoutEnabled = false;
    const res = await dispatch(createPublicBillingRouter(), 'POST', '/checkout', { email: 'a@b.co', plan: 'pro' });
    expect(res.statusCode).toBe(410);
  });

  it('keeps the path reachable while the flag is on', async () => {
    const res = await dispatch(createPublicBillingRouter(), 'POST', '/checkout', { email: 'a@b.co', plan: 'pro' });
    expect(res.statusCode).toBe(503);
  });

  it('maps public Stripe account-binding failures to 503 without treating them as bad input', async () => {
    stripeConfigured = true;
    const bindingError = Object.assign(new Error('wrong account'), { name: 'StripeAccountBindingError' });
    mockCreatePublicCheckoutSession.mockRejectedValueOnce(bindingError);
    const res = await dispatch(createPublicBillingRouter(), 'POST', '/checkout', { email: 'a@b.co', plan: 'pro' });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('Checkout is temporarily unavailable.');
  });
});
