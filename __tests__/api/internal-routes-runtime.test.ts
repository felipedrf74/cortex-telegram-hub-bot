// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { _resetRateLimiterForTests } from '../../src/api/rate-limiter';

let ownerTarget: { tenantId: number; telegramId: number } | null = null;
const getPerformanceSummary = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: '' },
  },
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: () => ownerTarget,
}));

vi.mock('../../src/services/content-learning-store', () => ({
  getPerformanceSummary,
}));

async function fetchJson(
  app: express.Express,
  pathname: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as any;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: options.method,
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe('internal routes runtime hardening', () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;

  beforeEach(() => {
    vi.resetModules();
    _resetRateLimiterForTests();
    process.env.INTERNAL_API_SECRET = 'test-internal-secret';
    ownerTarget = { tenantId: 42, telegramId: 999 };
    getPerformanceSummary.mockReset();
    getPerformanceSummary.mockReturnValue({
      entries: [],
      count: 0,
      avgViews: 0,
      avgRetention: 0,
    });
  });

  afterEach(() => {
    process.env.INTERNAL_API_SECRET = originalSecret;
  });

  it('rejects requests without the shared secret', async () => {
    const { internalRoutes } = await import('../../src/api/routes/internal');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/internal', internalRoutes());

    const res = await fetchJson(app, '/api/v1/internal/performance-summary');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('uses the owner bootstrap tenant id for performance summaries', async () => {
    const { internalRoutes } = await import('../../src/api/routes/internal');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/internal', internalRoutes());

    const res = await fetchJson(app, '/api/v1/internal/performance-summary?days=7', {
      headers: {
        'x-internal-secret': 'test-internal-secret',
      },
    });

    expect(res.status).toBe(200);
    expect(getPerformanceSummary).toHaveBeenCalledWith(42, 7);
  });

  it('fails closed when the owner bootstrap tenant is unavailable', async () => {
    ownerTarget = null;
    const { internalRoutes } = await import('../../src/api/routes/internal');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/internal', internalRoutes());

    const res = await fetchJson(app, '/api/v1/internal/performance-summary', {
      headers: {
        'x-internal-secret': 'test-internal-secret',
      },
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(getPerformanceSummary).not.toHaveBeenCalled();
  });

  it('rate-limits repeated bad-secret guesses before they can brute-force forever', async () => {
    const { internalRoutes } = await import('../../src/api/routes/internal');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/internal', internalRoutes());

    let res: { status: number; body: any } | null = null;
    for (let i = 0; i < 181; i++) {
      res = await fetchJson(app, '/api/v1/internal/performance-summary', {
        headers: {
          'x-internal-secret': 'wrong-secret',
        },
      });
    }

    expect(res?.status).toBe(429);
    expect(res?.body.error.code).toBe('RATE_LIMITED');
  });

  it('uses a tighter dedicated rate limit for the internal ai-complete proxy', async () => {
    const { internalRoutes } = await import('../../src/api/routes/internal');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/internal', internalRoutes());

    let res: { status: number; body: any } | null = null;
    for (let i = 0; i < 61; i++) {
      res = await fetchJson(app, '/api/v1/internal/ai-complete', {
        method: 'POST',
        headers: {
          'x-internal-secret': 'test-internal-secret',
          'content-type': 'application/json',
        },
        body: {},
      });
    }

    expect(res?.status).toBe(429);
    expect(res?.body.error.code).toBe('RATE_LIMITED');
  });
});
