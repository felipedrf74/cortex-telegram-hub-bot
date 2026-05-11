import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const mockUpsertGarminSession = vi.fn();
const mockMarkGarminConnectionActive = vi.fn();
const mockClearGarminSession = vi.fn();
const mockHasActiveGarminConnection = vi.fn();
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockStartGarminInteractiveLogin = vi.fn();
const mockVerifyGarminInteractiveLogin = vi.fn();

vi.mock('../../src/services/garmin-session-store', () => ({
  upsertGarminSession: (...args: unknown[]) => mockUpsertGarminSession(...args),
  markGarminConnectionActive: (...args: unknown[]) => mockMarkGarminConnectionActive(...args),
  clearGarminSession: (...args: unknown[]) => mockClearGarminSession(...args),
  hasActiveGarminConnection: (...args: unknown[]) => mockHasActiveGarminConnection(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => mockDbGet(sql, ...args),
      run: (...args: unknown[]) => mockDbRun(sql, ...args),
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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

vi.mock('../../src/services/garmin-interactive-auth', () => ({
  startGarminInteractiveLogin: (...args: unknown[]) => mockStartGarminInteractiveLogin(...args),
  verifyGarminInteractiveLogin: (...args: unknown[]) => mockVerifyGarminInteractiveLogin(...args),
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
  userId = 12,
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
    userId,
  } as any;
}

async function dispatch(method: string, path: string, body?: any, userId = 12): Promise<MockRes> {
  const router = garminAuthRoutes();
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

describe('Garmin auth routes', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockUpsertGarminSession.mockReset();
    mockMarkGarminConnectionActive.mockReset();
    mockClearGarminSession.mockReset();
    mockHasActiveGarminConnection.mockReset();
    mockDbGet.mockReset();
    mockDbRun.mockReset();
    mockStartGarminInteractiveLogin.mockReset();
    mockVerifyGarminInteractiveLogin.mockReset();
    mockHasActiveGarminConnection.mockReturnValue(true);
    mockStartGarminInteractiveLogin.mockResolvedValue({
      mfaRequired: false,
      connected: true,
      status: 'active',
      email: 'athlete@example.com',
      tokens: {
        oauth1: { token: 'oauth1' },
        oauth2: { token: 'oauth2' },
      },
    });
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
    expect(mockStartGarminInteractiveLogin).not.toHaveBeenCalled();
  });

  it('fails closed on invalid tenant scope before starting Garmin reauth', async () => {
    const res = await dispatch('POST', '/reauth', {}, 0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockStartGarminInteractiveLogin).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'garmin_auth_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
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

  it('stores a pending Garmin MFA state without marking the connection active', async () => {
    mockStartGarminInteractiveLogin.mockResolvedValueOnce({
      mfaRequired: true,
      connected: false,
      status: 'mfa_pending',
      email: 'athlete@example.com',
      verificationFlow: {
        channel: 'email_code',
        verifyEndpoint: '/api/v1/garmin/verify',
        instructions: ['Check email', 'Enter code'],
      },
    });

    const res = await dispatch('POST', '/login', {
      email: 'athlete@example.com',
      password: 'secret',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      mfaRequired: true,
      connected: false,
      status: 'mfa_pending',
    });
    expect(mockDbRun).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO garmin_user_tokens'), 12, 'athlete@example.com');
    expect(mockUpsertGarminSession).not.toHaveBeenCalled();
    expect(mockMarkGarminConnectionActive).not.toHaveBeenCalled();
  });

  it('sanitizes login failures instead of leaking Garmin provider internals', async () => {
    mockStartGarminInteractiveLogin.mockRejectedValueOnce(
      new Error('garmin provider rejected credentials with trace')
    );

    const res = await dispatch('POST', '/login', {
      email: 'athlete@example.com',
      password: 'secret',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('AUTH_FAILED');
    expect(res.body.error.message).toBe('Garmin login failed');
    expect(JSON.stringify(res.body)).not.toContain('garmin provider rejected credentials');
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

  it('does not report connected when a row is active but no Garmin session material exists', async () => {
    mockHasActiveGarminConnection.mockReturnValue(false);
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email, status, last_refresh, last_used')) {
        return {
          garmin_email: 'athlete@example.com',
          status: 'active',
          last_refresh: '2026-04-14T08:00:00Z',
          last_used: '2026-04-14T08:05:00Z',
        };
      }
      return undefined;
    });

    const res = await dispatch('GET', '/status');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connected).toBe(false);
    expect(res.body.data.status).toBe('needs_reauth');
    expect(res.body.data.reauthEndpoint).toBe('/api/v1/garmin/reauth');
  });

  it('sanitizes manual reauth failures instead of leaking provider internals', async () => {
    mockStartGarminInteractiveLogin.mockRejectedValueOnce(
      new Error('garmin provider rejected manual reauth')
    );

    const res = await dispatch('POST', '/reauth', {
      email: 'athlete@example.com',
      password: 'secret',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('AUTH_FAILED');
    expect(res.body.error.message).toBe('Garmin re-authentication failed');
    expect(JSON.stringify(res.body)).not.toContain('garmin provider rejected manual reauth');
  });

  it('persists Garmin session tokens only after interactive MFA verification succeeds', async () => {
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email FROM garmin_user_tokens')) {
        return { garmin_email: 'athlete@example.com' };
      }
      return undefined;
    });
    mockVerifyGarminInteractiveLogin.mockResolvedValueOnce({
      email: 'athlete@example.com',
      tokens: {
        oauth1: { token: 'oauth1-after-mfa' },
        oauth2: { token: 'oauth2-after-mfa' },
      },
    });

    const res = await dispatch('POST', '/verify', { code: '123456' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      verified: true,
      connected: true,
      status: 'active',
    });
    expect(mockVerifyGarminInteractiveLogin).toHaveBeenCalledWith(12, '123456');
    expect(mockUpsertGarminSession).toHaveBeenCalledWith(12, {
      oauth1: { token: 'oauth1-after-mfa' },
      oauth2: { token: 'oauth2-after-mfa' },
    });
    expect(mockMarkGarminConnectionActive).toHaveBeenCalledWith(12, 'athlete@example.com');
  });

  it('fails honestly when MFA verification does not persist a readable Garmin session', async () => {
    mockHasActiveGarminConnection.mockReturnValue(false);
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email FROM garmin_user_tokens')) {
        return { garmin_email: 'athlete@example.com' };
      }
      return undefined;
    });
    mockVerifyGarminInteractiveLogin.mockResolvedValueOnce({
      email: 'athlete@example.com',
      tokens: {
        oauth1: { token: 'oauth1-after-mfa' },
        oauth2: { token: 'oauth2-after-mfa' },
      },
    });

    const res = await dispatch('POST', '/verify', { code: '123456' });

    expect(res.statusCode).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('GARMIN_SESSION_NOT_VERIFIED');
    expect(mockDbRun).toHaveBeenCalledWith(expect.stringContaining('UPDATE garmin_user_tokens'), 12);
  });

  it('sanitizes verify failures instead of leaking Garmin MFA internals', async () => {
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT garmin_email FROM garmin_user_tokens')) {
        return { garmin_email: 'athlete@example.com' };
      }
      return undefined;
    });
    mockVerifyGarminInteractiveLogin.mockRejectedValueOnce(
      Object.assign(new Error('garmin verify internal ticket trace'), {
        code: 'VERIFY_FAILED',
        statusCode: 400,
      })
    );

    const res = await dispatch('POST', '/verify', { code: '123456' });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VERIFY_FAILED');
    expect(res.body.error.message).toBe('Verification failed');
    expect(JSON.stringify(res.body)).not.toContain('garmin verify internal ticket trace');
  });

  it('sanitizes disconnect failures instead of leaking Garmin session internals', async () => {
    mockClearGarminSession.mockImplementationOnce(() => {
      throw new Error('garmin session store exploded');
    });

    const res = await dispatch('DELETE', '/disconnect');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Disconnect failed');
    expect(JSON.stringify(res.body)).not.toContain('garmin session store exploded');
  });
});
