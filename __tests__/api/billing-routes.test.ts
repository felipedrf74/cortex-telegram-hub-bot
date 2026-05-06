import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockHandleAppleTransaction = vi.fn();

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
