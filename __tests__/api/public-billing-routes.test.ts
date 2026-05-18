import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const hoisted = vi.hoisted(() => ({
  createPublicCheckoutSession: vi.fn(),
}));

vi.mock('../../src/services/stripe-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/stripe-service')>('../../src/services/stripe-service');
  return {
    ...actual,
    isStripeConfigured: vi.fn(() => true),
    createPublicCheckoutSession: (...args: unknown[]) => hoisted.createPublicCheckoutSession(...args),
  };
});

vi.mock('../../src/services/waitlist-ip-hash', () => ({
  hashWaitlistIpAddress: (ip: string) => `hash:${ip}`,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { _resetPublicBillingRateLimiterForTests, createPublicBillingRouter } from '../../src/api/routes/public-billing';

async function dispatch(body: any): Promise<{ statusCode: number; body: any }> {
  const app = express();
  app.use('/billing', createPublicBillingRouter());
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify(body),
    });
    return { statusCode: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('public billing routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPublicBillingRateLimiterForTests();
    hoisted.createPublicCheckoutSession.mockResolvedValue('https://checkout.stripe.test/session');
  });

  it('starts website checkout with allowlisted email, plan, and currency only', async () => {
    const res = await dispatch({
      email: ' buyer@example.com ',
      plan: 'pro',
      currency: 'usd',
      successUrl: 'https://evil.example/success',
      cancelUrl: 'https://nexushub.me/canceled',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, url: 'https://checkout.stripe.test/session' });
    expect(hoisted.createPublicCheckoutSession).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      plan: 'pro',
      currency: 'usd',
      successUrl: 'https://nexushub.me/?checkout=success',
      cancelUrl: 'https://nexushub.me/canceled',
    });
  });

  it('returns a generic 400 for invalid checkout inputs', async () => {
    hoisted.createPublicCheckoutSession.mockRejectedValueOnce(new Error('INVALID_PLAN'));

    const res = await dispatch({ email: 'buyer@example.com', plan: 'ultra', currency: 'usd' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'Invalid checkout request.' });
  });
});
