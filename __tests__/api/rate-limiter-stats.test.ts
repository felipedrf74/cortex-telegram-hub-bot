import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

vi.mock('../../src/config', () => ({
  config: { ios: { rateLimit: 2, readRateLimit: 2 }, portal: {} },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { _resetRateLimiterForTests, getRateLimitStats, rateLimitMiddleware } from '../../src/api/rate-limiter';

function makeReq(userId: number, method = 'POST'): Request {
  return { method, path: '/api/v1/x', headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, userId, header: () => undefined } as unknown as Request;
}

function makeRes(): Response & { statusCode: number } {
  const res: any = { statusCode: 200, setHeader: vi.fn(), status: vi.fn((c: number) => { res.statusCode = c; return res; }), json: vi.fn(() => res) };
  return res;
}

describe('rate limiter stats', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('counts 429s per bucket and reports active keys', () => {
    const next = vi.fn() as unknown as NextFunction;
    for (let i = 0; i < 3; i += 1) rateLimitMiddleware(makeReq(7), makeRes(), next);
    rateLimitMiddleware(makeReq(8, 'GET'), makeRes(), next);

    const stats = getRateLimitStats();
    expect(stats.throttled.last5m).toBe(1);
    expect(stats.throttled.last1h).toBe(1);
    expect(stats.throttled.byBucket).toEqual({ user: { last5m: 1, last1h: 1 } });
    expect(stats.buckets.find((b) => b.name === 'user')).toMatchObject({ limit: 2, activeKeys: 1, hottestCount: 3 });
    expect(stats.buckets.find((b) => b.name === 'user-read')).toMatchObject({ activeKeys: 1, hottestCount: 1 });
    expect(JSON.stringify(stats)).not.toContain('127.0.0.1');
  });

  it('resets counters for tests', () => {
    const next = vi.fn() as unknown as NextFunction;
    for (let i = 0; i < 3; i += 1) rateLimitMiddleware(makeReq(7), makeRes(), next);
    _resetRateLimiterForTests();
    expect(getRateLimitStats().throttled.last1h).toBe(0);
  });
});
