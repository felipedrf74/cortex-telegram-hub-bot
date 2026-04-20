// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Hardening audit 2026-04-20: pins the rate-limiter's two-bucket
// behavior (user-keyed for authenticated traffic, IP-keyed for
// unauthenticated traffic). Before the fix, any request reaching the
// middleware without a `userId` sailed straight through `next()` with
// no floor — `/auth/register` + `/auth/refresh` were unthrottled and
// the invite code `BETA2026` was brute-forceable.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { rateLimitMiddleware, _resetRateLimiterForTests } from '../../src/api/rate-limiter';

function mockReq(opts: { userId?: number; ip?: string } = {}): Request {
  return {
    ip: opts.ip,
    socket: { remoteAddress: opts.ip || '203.0.113.1' },
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

  it('keys authenticated traffic by userId', () => {
    const res = mockRes();
    const next = vi.fn();
    rateLimitMiddleware(mockReq({ userId: 7 }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('user');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(60);
  });

  it('keys unauthenticated traffic by client IP (tighter limit)', () => {
    const res = mockRes();
    const next = vi.fn();
    rateLimitMiddleware(mockReq({ ip: '198.51.100.42' }), res, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).headers['X-RateLimit-Bucket']).toBe('ip');
    expect((res as any).headers['X-RateLimit-Limit']).toBe(30);
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
      rateLimitMiddleware(mockReq({ userId: 1, ip: '198.51.100.50' }), mockRes(), next);
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
