import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockEmit = vi.fn();

vi.mock('../../src/services/product-analytics', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/product-analytics')>(
    '../../src/services/product-analytics',
  );
  return {
    ...actual,
    emitProductAnalyticsEvent: (...args: unknown[]) => mockEmit(...args),
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

import { analyticsRoutes } from '../../src/api/routes/analytics';
import { ProductAnalyticsValidationError } from '../../src/services/product-analytics';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeReq(userId: number, body?: unknown): Request {
  return {
    method: 'POST',
    url: '/events',
    originalUrl: '/events',
    baseUrl: '/analytics',
    path: '/events',
    query: {},
    params: {},
    headers: {},
    body,
    userId,
  } as any;
}

async function dispatch(userId: number, body?: unknown): Promise<MockRes> {
  const router = analyticsRoutes();
  const req = makeReq(userId, body);
  const res = mockRes();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

describe('POST /api/v1/analytics/events', () => {
  beforeEach(() => {
    mockEmit.mockReset();
    mockEmit.mockReturnValue({ eventId: 'evt-1' });
  });

  it('rejects unauthenticated scope', async () => {
    const res = await dispatch(0, {
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('accepts client-owned app_open', async () => {
    const res = await dispatch(12, {
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '261', surface: 'ios' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      event: 'app_open',
      source: 'ios',
    }));
  });

  it('rejects server-owned events from the client', async () => {
    const res = await dispatch(12, {
      event: 'purchase_completed',
      properties: { plan: 'pro', provider: 'apple' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('rejects invented event names', async () => {
    const res = await dispatch(12, {
      event: 'session_start',
      properties: {},
    });
    expect(res.statusCode).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('maps validation failures to BAD_REQUEST', async () => {
    mockEmit.mockImplementation(() => {
      throw new ProductAnalyticsValidationError('Analytics properties must not include PII keys');
    });
    const res = await dispatch(12, {
      event: 'onboarding_completed',
      properties: { locale: 'en', skipped: false, email: 'hidden' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('PII');
  });

  it('treats a missing body as an unknown event', async () => {
    const res = await dispatch(12);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('coerces non-object properties and maps persist misses', async () => {
    mockEmit.mockReturnValue(null);
    const res = await dispatch(12, {
      event: 'paywall_viewed',
      properties: 'not-an-object',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.eventId).toBeNull();
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'paywall_viewed',
      properties: {},
    }));
  });

  it('maps unexpected persist failures to an internal error', async () => {
    mockEmit.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await dispatch(12, {
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
    });
    expect(res.statusCode).toBe(500);
    expect(mockEmit).toHaveBeenCalled();
  });
});
