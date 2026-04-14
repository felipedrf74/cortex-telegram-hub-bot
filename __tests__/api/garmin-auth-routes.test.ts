import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockUpsertGarminSession = vi.fn();
const mockMarkGarminConnectionActive = vi.fn();
const mockClearGarminSession = vi.fn();
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockLogin = vi.fn();

vi.mock('../../src/services/garmin-session-store', () => ({
  upsertGarminSession: (...args: unknown[]) => mockUpsertGarminSession(...args),
  markGarminConnectionActive: (...args: unknown[]) => mockMarkGarminConnectionActive(...args),
  clearGarminSession: (...args: unknown[]) => mockClearGarminSession(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => mockDbGet(sql, ...args),
      run: (...args: unknown[]) => mockDbRun(sql, ...args),
    }),
  }),
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
}));

vi.mock('garmin-connect', () => ({
  GarminConnect: class MockGarminConnect {
    client = {
      oauth1Token: { token: 'oauth1' },
      oauth2Token: { token: 'oauth2' },
    };

    async login() {
      return mockLogin();
    }
  },
}));

import { garminAuthRoutes } from '../../src/api/routes/garmin-auth';

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

function mockReq(
  method: string,
  path: string,
  body?: any,
): Request {
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
    userId: 12,
  } as any;
}

async function dispatch(method: string, path: string, body?: any): Promise<MockRes> {
  const router = garminAuthRoutes();
  const req = mockReq(method, path, body);
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

describe('Garmin auth routes', () => {
  beforeEach(() => {
    mockUpsertGarminSession.mockReset();
    mockMarkGarminConnectionActive.mockReset();
    mockClearGarminSession.mockReset();
    mockDbGet.mockReset();
    mockDbRun.mockReset();
    mockLogin.mockReset();
    mockLogin.mockResolvedValue(undefined);
  });

  it('returns the manual reauth flow contract without triggering login', async () => {
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email, status, last_refresh, last_used')) {
        return {
          garmin_email: 'athlete@example.com',
          status: 'needs_reauth',
          last_refresh: '2026-04-14T08:00:00Z',
          last_used: '2026-04-14T08:05:00Z',
        };
      }
      return undefined;
    });

    const res = await dispatch('POST', '/reauth', {});

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('needs_reauth');
    expect(res.body.data.email).toBe('athlete@example.com');
    expect(res.body.data.verificationFlow).toMatchObject({
      channel: 'email_code',
      startEndpoint: '/api/v1/garmin/login',
      verifyEndpoint: '/api/v1/garmin/verify',
      credentialsRequired: true,
    });
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('stores DB-backed session tokens on successful manual login', async () => {
    const res = await dispatch('POST', '/login', {
      email: 'athlete@example.com',
      password: 'secret',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      mfaRequired: false,
      connected: true,
      status: 'active',
    });
    expect(mockUpsertGarminSession).toHaveBeenCalledWith(12, {
      oauth1: { token: 'oauth1' },
      oauth2: { token: 'oauth2' },
    });
    expect(mockMarkGarminConnectionActive).toHaveBeenCalledWith(12, 'athlete@example.com');
  });

  it('surfaces a reauth endpoint when status is needs_reauth', async () => {
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email, status, last_refresh, last_used')) {
        return {
          garmin_email: 'athlete@example.com',
          status: 'needs_reauth',
          last_refresh: '2026-04-14T08:00:00Z',
          last_used: '2026-04-14T08:05:00Z',
        };
      }
      return undefined;
    });

    const res = await dispatch('GET', '/status');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('needs_reauth');
    expect(res.body.data.reauthEndpoint).toBe('/api/v1/garmin/reauth');
  });
});
