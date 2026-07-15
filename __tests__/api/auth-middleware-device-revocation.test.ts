/**
 * Beta gap 3 (2026-04-24): authMiddleware must reject an access token
 * whose underlying device session has been revoked (via POST /auth/logout
 * or /auth/logout-all). The access token itself remains cryptographically
 * valid for up to its 7-day JWT expiry, so the only point at which we can
 * enforce logout is by checking `ios_devices` on each authenticated
 * request — which is what the middleware now does.
 *
 * These tests are intentionally in their own file. The auth-routes tests
 * stub out authMiddleware via `vi.doMock` so they don't exercise the
 * real JWT path. vi.doMock registrations persist across `describe` blocks
 * (vi.resetModules clears the module cache but not the mock registry),
 * so sharing a file with those tests masks the real middleware with
 * the stub. Isolating these tests here keeps the full middleware
 * behavior under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import path from 'path';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

let testDb: Database.Database;
const TEST_IOS_JWT_SECRET = 'test-ios-secret-000000000000000000000000000000';

const originalEnv = {
  STAGING: process.env.STAGING,
  IOS_API_ENABLED: process.env.IOS_API_ENABLED,
  IOS_API_JWT_SECRET: process.env.IOS_API_JWT_SECRET,
  IOS_INVITE_CODE: process.env.IOS_INVITE_CODE,
  IOS_OWNER_CODE: process.env.IOS_OWNER_CODE,
  OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
};

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}


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
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
  };
  return res;
}

function mockReq(headers: Record<string, string>, method = 'GET', url = '/noop'): Request {
  return {
    headers,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    header(name: string) { return headers[name.toLowerCase()]; },
    method,
    url,
  } as any;
}

describe('authMiddleware: device revocation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();

    process.env.STAGING = 'true';
    process.env.IOS_API_ENABLED = 'true';
    process.env.IOS_API_JWT_SECRET = TEST_IOS_JWT_SECRET;
    process.env.IOS_INVITE_CODE = 'LOCALBETA_TEST';
    process.env.IOS_OWNER_CODE = 'LOCALOWNER_TEST';
    process.env.OWNER_TELEGRAM_ID = '991122';

    vi.resetModules();
    vi.doMock('../../src/services/database', () => ({
      getDb: () => testDb,
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        debug: vi.fn(), trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
  });

  afterEach(() => {
    testDb?.close();
    (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach(restoreEnv);
    vi.doUnmock('../../src/services/database');
    vi.doUnmock('../../src/utils/logger');
    vi.resetModules();
  });

  async function runMiddleware(
    userId: number,
    deviceId: string,
    options: {
      seedDevice?: boolean;
      userStatus?: string;
      headers?: Record<string, string>;
      method?: string;
      url?: string;
      conflictingDeviceUserId?: number;
    } = {},
  ): Promise<MockRes & { admitted: boolean; requestTenantId?: number; requestUserId?: number }> {
    const seedDevice = options.seedDevice !== false;
    const userStatus = options.userStatus ?? 'active';

    testDb.prepare(
      'INSERT OR REPLACE INTO users (id, telegram_id, first_name, status) VALUES (?, ?, ?, ?)',
    ).run(userId, 700000 + userId, `User${userId}`, userStatus);
    if (seedDevice) {
      testDb.prepare(
        'INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)',
      ).run(userId, deviceId, `refresh-${deviceId}`);
    }
    if (options.conflictingDeviceUserId) {
      testDb.prepare(
        'INSERT OR REPLACE INTO users (id, telegram_id, first_name, status) VALUES (?, ?, ?, ?)',
      ).run(
        options.conflictingDeviceUserId,
        700000 + options.conflictingDeviceUserId,
        `User${options.conflictingDeviceUserId}`,
        'active',
      );
      testDb.prepare(
        'INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)',
      ).run(options.conflictingDeviceUserId, deviceId, `refresh-conflict-${deviceId}`);
    }

    const token = jwt.sign(
      { userId, deviceId },
      TEST_IOS_JWT_SECRET,
      { expiresIn: '7d' as any },
    );

    const { authMiddleware } = await import('../../src/api/auth-middleware');
    const req = mockReq({
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    }, options.method, options.url);
    const res = mockRes();

    let admitted = false;
    await new Promise<void>((resolve) => {
      const next: NextFunction = () => { admitted = true; resolve(); };
      authMiddleware(req, res as unknown as Response, next);
      setImmediate(resolve);
    });

    return Object.assign(res, {
      admitted,
      requestTenantId: (req as any).tenantId,
      requestUserId: (req as any).userId,
    });
  }

  async function runMiddlewareWithRawPayload(
    payload: Record<string, unknown>,
  ): Promise<MockRes & { admitted: boolean; requestTenantId?: number; requestUserId?: number }> {
    const token = jwt.sign(
      payload,
      TEST_IOS_JWT_SECRET,
      { expiresIn: '7d' as any },
    );

    const { authMiddleware } = await import('../../src/api/auth-middleware');
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();

    let admitted = false;
    await new Promise<void>((resolve) => {
      const next: NextFunction = () => { admitted = true; resolve(); };
      authMiddleware(req, res as unknown as Response, next);
      setImmediate(resolve);
    });

    return Object.assign(res, {
      admitted,
      requestTenantId: (req as any).tenantId,
      requestUserId: (req as any).userId,
    });
  }

  it('admits a request when the device row still exists', async () => {
    const res = await runMiddleware(501, 'dev-live');
    expect(res.admitted).toBe(true);
  });

  it('fails closed when the JWT userId is not a positive integer number', async () => {
    const stringUser = await runMiddlewareWithRawPayload({
      userId: '501',
      deviceId: 'dev-string-user',
    });
    expect(stringUser.admitted).toBe(false);
    expect(stringUser.statusCode).toBe(401);
    expect(stringUser.body.error.code).toBe('UNAUTHORIZED');
    expect(stringUser.body.error.message).toBe('Invalid authenticated user scope');

    const fractionalUser = await runMiddlewareWithRawPayload({
      userId: 501.5,
      deviceId: 'dev-fractional-user',
    });
    expect(fractionalUser.admitted).toBe(false);
    expect(fractionalUser.statusCode).toBe(401);
    expect(fractionalUser.body.error.code).toBe('UNAUTHORIZED');
    expect(fractionalUser.body.error.message).toBe('Invalid authenticated user scope');
  });

  it('admits an explicit active-tenant header only when it matches the canonical tenant', async () => {
    const res = await runMiddleware(504, 'dev-active-tenant', {
      headers: { 'x-nexus-active-tenant-id': '504' },
    });

    expect(res.admitted).toBe(true);
    expect(res.requestUserId).toBe(504);
    expect(res.requestTenantId).toBe(504);
  });

  it('fails closed when the same user tries to switch to a non-membership-backed tenant', async () => {
    const res = await runMiddleware(505, 'dev-tenant-switch', {
      headers: { 'x-nexus-active-tenant-id': '1505' },
    });

    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Active tenant switching is not enabled for this session');
  });

  it('fails closed before a Cooking POST when the active tenant header is forged', async () => {
    const res = await runMiddleware(507, 'dev-cooking-tenant-forge', {
      method: 'POST',
      url: '/api/v1/cooking/recipes',
      headers: { 'x-nexus-active-tenant-id': '1507' },
    });

    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Active tenant switching is not enabled for this session');
  });

  it('fails closed when the active-tenant header is malformed', async () => {
    const res = await runMiddleware(506, 'dev-bad-active-tenant', {
      headers: { 'x-nexus-active-tenant-id': '506abc' },
    });

    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Invalid active tenant scope');
  });

  it('rejects a request whose device has been revoked, with 401 Session has been revoked', async () => {
    // Simulate the post-logout state: the JWT is still cryptographically
    // valid (7d expiry, signed with the current secret) and the users
    // row is present + active, BUT the ios_devices row was deleted by
    // /auth/logout. This is the ONLY way the middleware learns that
    // the session was revoked.
    const res = await runMiddleware(502, 'dev-revoked', { seedDevice: false });
    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Session has been revoked');
  });

  it('rejects a stale access token after the same physical device switches to another account', async () => {
    const res = await runMiddleware(508, 'shared-device-after-account-switch', {
      seedDevice: false,
      conflictingDeviceUserId: 509,
    });

    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Session has been revoked');
  });

  it('still rejects when the user account itself is no longer active (banned/suspended)', async () => {
    // Regression: the existing user-status check must continue to fire
    // BEFORE the device check, so banned users see the same "not active"
    // message they did before the device check was added.
    const res = await runMiddleware(503, 'dev-banned', { userStatus: 'banned' });
    expect(res.admitted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toBe('User account is not active');
  });
});
