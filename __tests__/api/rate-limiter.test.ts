// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Hardening audit 2026-04-20: pins the rate-limiter's two-bucket
// behavior (user-keyed for authenticated traffic, IP-keyed for
// unauthenticated traffic). Before the fix, any request reaching the
// middleware without a `userId` sailed straight through `next()` with
// no floor — `/auth/register` + `/auth/refresh` were unthrottled and
// the invite code `BETA2026` was brute-forceable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  rateLimitMiddleware,
  webhookRateLimitMiddleware,
  internalRateLimitMiddleware,
  internalAiCompleteRateLimitMiddleware,
  _resetRateLimiterForTests,
} from '../../src/api/rate-limiter';
import { ROUTING_SYNTHETIC_QA_HEADERS } from '../../src/services/routing-synthetic-qa-contract';

const ROUTING_SYNTHETIC_QA_MANIFEST_SHA = `sha256:${'a'.repeat(64)}`;

function routingSyntheticQaHeaders(): Record<string, string> {
  return {
    [ROUTING_SYNTHETIC_QA_HEADERS.contract]: 'routing-synthetic-qa-v1',
    [ROUTING_SYNTHETIC_QA_HEADERS.manifestSha256]: ROUTING_SYNTHETIC_QA_MANIFEST_SHA,
    [ROUTING_SYNTHETIC_QA_HEADERS.surface]: 'classifierKeyword',
    [ROUTING_SYNTHETIC_QA_HEADERS.ordinal]: '1',
    [ROUTING_SYNTHETIC_QA_HEADERS.plannedTurns]: '200',
    [ROUTING_SYNTHETIC_QA_HEADERS.turnId]: `routing-synthetic-qa-v1:${'a'.repeat(64)}:classifierKeyword:001`,
  };
}

function mockReq(opts: {
  userId?: number;
  ip?: string;
  remoteAddress?: string;
  method?: string;
  headers?: Record<string, string>;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
} = {}): Request {
  return {
    method: opts.method,
    headers: opts.headers || {},
    originalUrl: opts.originalUrl,
    baseUrl: opts.baseUrl,
    path: opts.path,
    ip: opts.ip,
    socket: { remoteAddress: opts.remoteAddress || opts.ip || '203.0.113.1' },
    userId: opts.userId,
  } as unknown as Request;
}

function mockRes(): Response {
  const headers: Record<string, any> = {};
  const res: any = {
    statusCode: 200,
    headers,
    setHeader: (name: string, value: any) => { headers[name] = value; },
    status: vi.fn(function (this: any, code: number) {
      res.statusCode = code;
      return this;
    }),
    json: vi.fn().mockReturnThis(),
    ended: false,
  };
  return res as Response;
}

describe('rate-limiter — two-bucket behavior', () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows exactly 205 owner-authorized synthetic QA turns for the dedicated staging identity', () => {
    vi.stubEnv('NEXUS_RELEASE_ROLE', 'staging');
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    const next = vi.fn();

    for (let i = 0; i < 205; i++) {
      const res = mockRes();
      rateLimitMiddleware(
        mockReq({
          userId: 42,
          method: 'POST',
          originalUrl: '/api/v1/chat/message',
          headers: { 'x-language': 'en-US', ...routingSyntheticQaHeaders() },
        }),
        res,
        next as NextFunction,
      );
      expect((res as any).statusCode).toBe(200);
      expect((res as any).headers['X-RateLimit-Bucket']).toBe('routing-synthetic-qa-user');
      expect((res as any).headers['X-RateLimit-Limit']).toBe(205);
    }

    const blocked = mockRes();
    rateLimitMiddleware(
      mockReq({
        userId: 42,
        method: 'POST',
        originalUrl: '/api/v1/chat/message',
        headers: { 'x-language': 'en-US', ...routingSyntheticQaHeaders() },
      }),
      blocked,
      next as NextFunction,
    );
    expect((blocked as any).statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(205);
  });

  it.each([
    {
      name: 'partial QA headers',
      userId: 42,
      role: 'staging',
      nodeEnv: 'staging',
      headers: {
        [ROUTING_SYNTHETIC_QA_HEADERS.contract]: 'routing-synthetic-qa-v1',
      },
    },
    {
      name: 'wrong authenticated identity',
      userId: 43,
      role: 'staging',
      nodeEnv: 'staging',
      headers: routingSyntheticQaHeaders(),
    },
    {
      name: 'production runtime',
      userId: 42,
      role: 'production',
      nodeEnv: 'production',
      headers: routingSyntheticQaHeaders(),
    },
    {
      name: 'complete but non-canonical QA headers',
      userId: 42,
      role: 'staging',
      nodeEnv: 'staging',
      headers: {
        ...routingSyntheticQaHeaders(),
        [ROUTING_SYNTHETIC_QA_HEADERS.ordinal]: '001',
      },
    },
    {
      name: 'missing governed locale header',
      userId: 42,
      role: 'staging',
      nodeEnv: 'staging',
      headers: routingSyntheticQaHeaders(),
      omitLocale: true,
    },
  ])('keeps $name on the ordinary 60-request bucket', ({ userId, role, nodeEnv, headers, omitLocale }) => {
    vi.stubEnv('NEXUS_RELEASE_ROLE', role);
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    const next = vi.fn();

    for (let i = 0; i < 60; i++) {
      const res = mockRes();
      rateLimitMiddleware(
        mockReq({
          userId,
          method: 'POST',
          originalUrl: '/api/v1/chat/message',
          headers: omitLocale ? headers : { 'x-language': 'en-US', ...headers },
        }),
        res,
        next as NextFunction,
      );
      expect((res as any).statusCode).toBe(200);
      expect((res as any).headers['X-RateLimit-Bucket']).toBe('user');
    }

    const blocked = mockRes();
    rateLimitMiddleware(
      mockReq({
        userId,
        method: 'POST',
        originalUrl: '/api/v1/chat/message',
        headers: omitLocale ? headers : { 'x-language': 'en-US', ...headers },
      }),
      blocked,
      next as NextFunction,
    );
    expect((blocked as any).statusCode).toBe(429);
  });

  it('keys authenticated traffic by userId', () => {
    const res = mockRes();
    const next = vi.fn();
    rateLimitMiddleware(mockReq({ userId: 7, method: 'POST' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('user');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(60);
  });

  it('uses a higher separate bucket for authenticated GET navigation reads', () => {
    const next = vi.fn();

    for (let i = 0; i < 180; i++) {
      const res = mockRes();
      rateLimitMiddleware(mockReq({ userId: 7, method: 'GET' }), res, next as NextFunction);
      expect((res as any).statusCode).toBe(200);
      expect((res as any).headers['X-RateLimit-Bucket']).toBe('user-read');
      expect((res as any).headers['X-RateLimit-Limit']).toBe(300);
    }

    expect(next).toHaveBeenCalledTimes(180);
  });

  it('keeps authenticated GET bursts from consuming the tighter mutation/chat bucket', () => {
    const next = vi.fn();

    for (let i = 0; i < 180; i++) {
      rateLimitMiddleware(mockReq({ userId: 9, method: 'GET' }), mockRes(), next as NextFunction);
    }

    const mutationRes = mockRes();
    rateLimitMiddleware(mockReq({ userId: 9, method: 'POST' }), mutationRes, next as NextFunction);
    expect((mutationRes as any).statusCode).toBe(200);
    expect((mutationRes as any).headers['X-RateLimit-Bucket']).toBe('user');
    expect((mutationRes as any).headers['X-RateLimit-Remaining']).toBe(59);
  });

  it('keys unauthenticated traffic by client IP (tighter limit)', () => {
    const res = mockRes();
    const next = vi.fn();
    rateLimitMiddleware(mockReq({ ip: '198.51.100.42' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('ip');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(30);
  });

  it('uses Cloudflare visitor IP only when the immediate peer is local/private', () => {
    const next = vi.fn();

    for (let i = 0; i < 30; i++) {
      rateLimitMiddleware(
        mockReq({
          ip: '127.0.0.1',
          remoteAddress: '127.0.0.1',
          headers: { 'cf-connecting-ip': '198.51.100.10' },
        }),
        mockRes(),
        next,
      );
    }

    const blocked = mockRes();
    rateLimitMiddleware(
      mockReq({
        ip: '127.0.0.1',
        remoteAddress: '127.0.0.1',
        headers: { 'cf-connecting-ip': '198.51.100.10' },
      }),
      blocked,
      next,
    );
    expect((blocked as any).statusCode).toBe(429);

    const neighbor = mockRes();
    rateLimitMiddleware(
      mockReq({
        ip: '127.0.0.1',
        remoteAddress: '127.0.0.1',
        headers: { 'cf-connecting-ip': '198.51.100.11' },
      }),
      neighbor,
      next,
    );
    expect((neighbor as any).statusCode).toBe(200);
    expect((neighbor as any).headers['X-RateLimit-Remaining']).toBe(29);
  });

  it('ignores spoofed Cloudflare visitor headers from a public direct peer', () => {
    const next = vi.fn();

    for (let i = 0; i < 30; i++) {
      rateLimitMiddleware(
        mockReq({
          ip: '198.51.100.200',
          remoteAddress: '198.51.100.200',
          headers: { 'cf-connecting-ip': `203.0.113.${i + 1}` },
        }),
        mockRes(),
        next,
      );
    }

    const blocked = mockRes();
    rateLimitMiddleware(
      mockReq({
        ip: '198.51.100.200',
        remoteAddress: '198.51.100.200',
        headers: { 'cf-connecting-ip': '203.0.113.200' },
      }),
      blocked,
      next,
    );

    expect((blocked as any).statusCode).toBe(429);
    expect((blocked as any).headers['X-RateLimit-Bucket']).toBe('ip');
  });

  it('gives portal /api calls a higher bucket separate from generic unauthenticated traffic', () => {
    const next = vi.fn();

    for (let i = 0; i < 31; i++) {
      const res = mockRes();
      rateLimitMiddleware(
        mockReq({
          ip: '198.51.100.88',
          originalUrl: '/api/snapshot',
          baseUrl: '/api',
          path: '/snapshot',
        }),
        res,
        next,
      );
      expect((res as any).statusCode).toBe(200);
      expect((res as any).headers['X-RateLimit-Bucket']).toBe('portal-ip');
      expect((res as any).headers['X-RateLimit-Limit']).toBe(180);
    }
  });

  it('still throttles portal /api calls after the portal bucket is exhausted', () => {
    const next = vi.fn();
    const ip = '198.51.100.89';

    for (let i = 0; i < 180; i++) {
      rateLimitMiddleware(
        mockReq({ ip, originalUrl: '/api/snapshot', baseUrl: '/api', path: '/snapshot' }),
        mockRes(),
        next,
      );
    }

    const blocked = mockRes();
    rateLimitMiddleware(
      mockReq({ ip, originalUrl: '/api/snapshot', baseUrl: '/api', path: '/snapshot' }),
      blocked,
      next,
    );

    expect((blocked as any).statusCode).toBe(429);
    expect((blocked as any).headers['X-RateLimit-Bucket']).toBe('portal-ip');
    expect((blocked as any).headers['Retry-After']).toBe(60);
  });

  it('gives auth OAuth/browser routes their own bucket separate from portal reads', () => {
    const next = vi.fn();
    const ip = '198.51.100.90';

    for (let i = 0; i < 90; i++) {
      const res = mockRes();
      rateLimitMiddleware(
        mockReq({
          ip,
          method: 'POST',
          originalUrl: '/api/v1/auth/register/google/start',
          baseUrl: '/api/v1/auth',
          path: '/register/google/start',
        }),
        res,
        next,
      );
      expect((res as any).statusCode).toBe(200);
      expect((res as any).headers['X-RateLimit-Bucket']).toBe('auth-ip');
      expect((res as any).headers['X-RateLimit-Limit']).toBe(90);
    }

    const blockedAuth = mockRes();
    rateLimitMiddleware(
      mockReq({
        ip,
        method: 'POST',
        originalUrl: '/api/v1/auth/register/google/start',
        baseUrl: '/api/v1/auth',
        path: '/register/google/start',
      }),
      blockedAuth,
      next,
    );
    expect((blockedAuth as any).statusCode).toBe(429);
    expect((blockedAuth as any).headers['X-RateLimit-Bucket']).toBe('auth-ip');

    const portal = mockRes();
    rateLimitMiddleware(
      mockReq({ ip, originalUrl: '/api/snapshot', baseUrl: '/api', path: '/snapshot' }),
      portal,
      next,
    );
    expect((portal as any).statusCode).toBe(200);
    expect((portal as any).headers['X-RateLimit-Bucket']).toBe('portal-ip');
    expect((portal as any).headers['X-RateLimit-Remaining']).toBe(179);
  });

  it('throttles unauthenticated traffic at 31 requests in a window with 429 + Retry-After', () => {
    const ip = '198.51.100.99';
    const next = vi.fn();

    // Spend the 30-request budget
    for (let i = 0; i < 30; i++) {
      const res = mockRes();
      rateLimitMiddleware(mockReq({ ip }), res, next);
      expect((res as any).statusCode).toBe(200);
    }

    // 31st request must be throttled
    const blockedRes = mockRes();
    rateLimitMiddleware(mockReq({ ip }), blockedRes, next);
    expect((blockedRes as any).statusCode).toBe(429);
    expect((blockedRes as any).headers['Retry-After']).toBe(60);
    expect((blockedRes as any).headers['X-RateLimit-Bucket']).toBe('ip');
  });

  it('uses separate buckets per IP — one abuser does not throttle a neighbor', () => {
    const next = vi.fn();

    // Exhaust IP A
    for (let i = 0; i < 31; i++) {
      rateLimitMiddleware(mockReq({ ip: '198.51.100.1' }), mockRes(), next);
    }

    // IP B should still be clean
    const res = mockRes();
    rateLimitMiddleware(mockReq({ ip: '198.51.100.2' }), res, next);
    expect((res as any).statusCode).toBe(200);
    expect((res as any).headers['X-RateLimit-Remaining']).toBe(29);
  });

  it('keeps user and IP buckets independent — a userId exhausting the user bucket does not consume the IP bucket', () => {
    const next = vi.fn();

    // Exhaust user 1's bucket (60 requests)
    for (let i = 0; i < 61; i++) {
      rateLimitMiddleware(mockReq({ userId: 1, ip: '198.51.100.50', method: 'POST' }), mockRes(), next);
    }

    // Unauth'd call from the same IP should still work (hasn't touched the IP bucket)
    const res = mockRes();
    rateLimitMiddleware(mockReq({ ip: '198.51.100.50' }), res, next);
    expect((res as any).statusCode).toBe(200);
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('ip');
    expect((res as any).headers['X-RateLimit-Remaining']).toBe(29);
  });

  it('treats userId=0 / falsy userId as unauthenticated', () => {
    // Guards against the "if (!userId)" trap where 0 would fall
    // through to `next()` with no rate limit (documented as the old
    // behavior). Our new middleware uses `typeof userId === 'number'
    // && userId > 0` so `userId: 0` routes to IP bucket.
    const res = mockRes();
    const next = vi.fn();
    rateLimitMiddleware(mockReq({ userId: 0 as any, ip: '198.51.100.77' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('ip');
  });
});

// ── L-1 webhook bucket (2026-04-21 pass 2) ─────────────────────────
//
// Apple App Store + Stripe webhooks had no rate limit. A forged-
// payload flood could CPU-starve the Node event loop BEFORE the
// cheap signature/bundle-id checks reject it. `webhookRateLimitMiddleware`
// enforces 120 req/min/IP on those two endpoints.
describe('webhookRateLimitMiddleware', () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
  });

  it('keys by client IP and tags the response X-RateLimit-Bucket=webhook', () => {
    const res = mockRes();
    const next = vi.fn();
    webhookRateLimitMiddleware(mockReq({ ip: '203.0.113.9' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('webhook');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(120);
  });

  it('allows comfortable legitimate traffic (60 bursts from Stripe in 1 minute)', () => {
    const next = vi.fn();
    for (let i = 0; i < 60; i++) {
      webhookRateLimitMiddleware(
        mockReq({ ip: '198.51.100.1' }),
        mockRes(),
        next as NextFunction,
      );
    }
    expect(next).toHaveBeenCalledTimes(60);
  });

  it('rate-limits at 120/min with 429 + Retry-After', () => {
    const next = vi.fn();
    for (let i = 0; i < 120; i++) {
      webhookRateLimitMiddleware(
        mockReq({ ip: '198.51.100.2' }),
        mockRes(),
        next as NextFunction,
      );
    }
    // 121st call must be rejected.
    const blocked = mockRes();
    webhookRateLimitMiddleware(
      mockReq({ ip: '198.51.100.2' }),
      blocked,
      next as NextFunction,
    );
    expect((blocked as any).statusCode).toBe(429);
    expect((blocked as any).headers['Retry-After']).toBeDefined();
  });

  it('keeps separate IPs on independent buckets (no cross-blocking)', () => {
    const next = vi.fn();
    for (let i = 0; i < 121; i++) {
      webhookRateLimitMiddleware(
        mockReq({ ip: '198.51.100.3' }),
        mockRes(),
        next as NextFunction,
      );
    }
    // A DIFFERENT Stripe egress IP must still be welcomed.
    const fresh = mockRes();
    webhookRateLimitMiddleware(
      mockReq({ ip: '203.0.113.77' }),
      fresh,
      next as NextFunction,
    );
    expect((fresh as any).statusCode).toBe(200);
    expect((fresh as any).headers['X-RateLimit-Remaining']).toBe(119);
  });
});

describe('internal shared-secret rate limiting', () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
  });

  it('keys internal traffic by IP and tags the general internal bucket', () => {
    const res = mockRes();
    const next = vi.fn();
    internalRateLimitMiddleware(mockReq({ ip: '203.0.113.44' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('internal');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(180);
  });

  it('throttles general internal traffic after the configured budget', () => {
    const next = vi.fn();
    const ip = '203.0.113.45';

    for (let i = 0; i < 180; i++) {
      const res = mockRes();
      internalRateLimitMiddleware(mockReq({ ip }), res, next as NextFunction);
      expect((res as any).statusCode).toBe(200);
    }

    const blocked = mockRes();
    internalRateLimitMiddleware(mockReq({ ip }), blocked, next as NextFunction);
    expect((blocked as any).statusCode).toBe(429);
    expect((blocked as any).headers['X-RateLimit-Bucket']).toBe('internal');
    expect((blocked as any).headers['Retry-After']).toBe(60);
  });

  it('uses a tighter dedicated bucket for internal ai-complete traffic', () => {
    const res = mockRes();
    const next = vi.fn();
    internalAiCompleteRateLimitMiddleware(mockReq({ ip: '203.0.113.46' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('internal-ai');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(60);
  });

  it('throttles internal ai-complete traffic after the tighter budget', () => {
    const next = vi.fn();
    const ip = '203.0.113.47';

    for (let i = 0; i < 60; i++) {
      const res = mockRes();
      internalAiCompleteRateLimitMiddleware(mockReq({ ip }), res, next as NextFunction);
      expect((res as any).statusCode).toBe(200);
    }

    const blocked = mockRes();
    internalAiCompleteRateLimitMiddleware(mockReq({ ip }), blocked, next as NextFunction);
    expect((blocked as any).statusCode).toBe(429);
    expect((blocked as any).headers['X-RateLimit-Bucket']).toBe('internal-ai');
    expect((blocked as any).headers['Retry-After']).toBe(60);
  });
});
