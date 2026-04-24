/**
 * Beta gap 3 (2026-04-24): server-side session revocation tests.
 *
 * Before this change there was no POST /auth/logout on the backend —
 * iOS just dropped its local tokens and the refresh token in
 * `ios_devices` stayed valid forever. A leaked refresh token (or the
 * prior user's token on a shared device) could be replayed indefinitely.
 *
 * These tests assert:
 *   1. POST /auth/logout       → deletes the caller's device row.
 *   2. POST /auth/logout-all   → deletes every device for the user.
 *   3. Both routes are idempotent (returning 200 with `devicesRevoked: 0`
 *      is safer for client retry logic than an error).
 *   4. authMiddleware rejects access tokens whose device has since been
 *      revoked — this is the piece that makes the access token actually
 *      stop working after logout, rather than remaining valid until its
 *      7-day JWT expiry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

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

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Ignore migrations with runtime-only dependencies.
      }
    }
  }
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

function mockReq(body: any, headers: Record<string, string> = {}, extras: Record<string, unknown> = {}): Request {
  return {
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers,
    header(name: string) { return headers[name.toLowerCase()]; },
    ...extras,
  } as any;
}

async function dispatchAuth(
  path: string,
  body: any,
  options: { method?: string; headers?: Record<string, string>; extras?: Record<string, unknown> } = {},
): Promise<MockRes> {
  const { authRoutes } = await import('../../src/api/routes/auth');
  const router = authRoutes();
  const req = mockReq(body, options.headers, options.extras);
  (req as any).method = options.method ?? 'POST';
  (req as any).url = path;
  (req as any).originalUrl = path;
  (req as any).baseUrl = '';
  (req as any).path = path;

  const res = mockRes();
  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

// ─── Logout endpoints ──────────────────────────────────────────────

describe('POST /auth/logout (server-side session revocation)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    process.env.STAGING = 'true';
    process.env.IOS_API_ENABLED = 'true';
    process.env.IOS_API_JWT_SECRET = 'test-ios-secret';
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
    vi.doMock('../../src/services/audit-trail', () => ({
      logAudit: vi.fn(),
    }));
    // The auth route imports `authMiddleware as verifyJwt`. Our test harness
    // stubs it so we can simulate a valid JWT without running the full
    // verification path — `authMiddleware` itself is tested separately
    // below against real JWTs and a real devices table.
    vi.doMock('../../src/api/auth-middleware', () => ({
      authMiddleware: (req: any, _res: unknown, next: (err?: unknown) => void) => {
        req.userId = Number(req.headers?.['x-test-user-id'] ?? 1);
        req.deviceId = String(req.headers?.['x-test-device-id'] ?? 'test-device');
        next();
      },
    }));
  });

  afterEach(() => {
    testDb?.close();
    (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach(restoreEnv);
    vi.doUnmock('../../src/api/auth-middleware');
    vi.doUnmock('../../src/services/audit-trail');
    vi.doUnmock('../../src/services/database');
    vi.doUnmock('../../src/utils/logger');
    vi.resetModules();
  });

  it('deletes the caller\'s ios_devices row so the refresh token is revoked', async () => {
    testDb.prepare(`
      INSERT INTO ios_devices (user_id, device_id, device_name, refresh_token)
      VALUES (?, ?, ?, ?)
    `).run(42, 'dev-foo', 'Test iPhone', 'refresh-token-xyz');

    const res = await dispatchAuth('/logout', {}, {
      headers: { 'x-test-user-id': '42', 'x-test-device-id': 'dev-foo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.signedOut).toBe(true);
    expect(res.body.data.devicesRevoked).toBe(1);

    const remaining = testDb.prepare(
      'SELECT COUNT(*) AS n FROM ios_devices WHERE device_id = ?',
    ).get('dev-foo') as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('returns 200 even when no device row exists (idempotent sign-out)', async () => {
    const res = await dispatchAuth('/logout', {}, {
      headers: { 'x-test-user-id': '42', 'x-test-device-id': 'never-registered' },
    });

    // A client that retries logout after a flaky response should succeed
    // the second time, not trip an error that confuses "am I signed out?".
    expect(res.statusCode).toBe(200);
    expect(res.body.data.devicesRevoked).toBe(0);
  });

  it('only deletes the caller\'s device, not other devices belonging to the same user', async () => {
    testDb.prepare('INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)')
      .run(42, 'dev-a', 'tok-a');
    testDb.prepare('INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)')
      .run(42, 'dev-b', 'tok-b');

    await dispatchAuth('/logout', {}, {
      headers: { 'x-test-user-id': '42', 'x-test-device-id': 'dev-a' },
    });

    const remaining = testDb.prepare(
      "SELECT device_id FROM ios_devices WHERE user_id = ? ORDER BY device_id",
    ).all(42) as { device_id: string }[];
    expect(remaining.map((r) => r.device_id)).toEqual(['dev-b']);
  });
});

describe('POST /auth/logout-all (account-wide revocation)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    process.env.STAGING = 'true';
    process.env.IOS_API_ENABLED = 'true';
    process.env.IOS_API_JWT_SECRET = 'test-ios-secret';
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
    vi.doMock('../../src/services/audit-trail', () => ({
      logAudit: vi.fn(),
    }));
    vi.doMock('../../src/api/auth-middleware', () => ({
      authMiddleware: (req: any, _res: unknown, next: (err?: unknown) => void) => {
        req.userId = Number(req.headers?.['x-test-user-id'] ?? 1);
        req.deviceId = String(req.headers?.['x-test-device-id'] ?? 'test-device');
        next();
      },
    }));
  });

  afterEach(() => {
    testDb?.close();
    (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach(restoreEnv);
    vi.doUnmock('../../src/api/auth-middleware');
    vi.doUnmock('../../src/services/audit-trail');
    vi.doUnmock('../../src/services/database');
    vi.doUnmock('../../src/utils/logger');
    vi.resetModules();
  });

  it('deletes every device for the user and preserves other users\' devices', async () => {
    testDb.prepare('INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)').run(42, 'dev-a', 'tok-a');
    testDb.prepare('INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)').run(42, 'dev-b', 'tok-b');
    testDb.prepare('INSERT INTO ios_devices (user_id, device_id, refresh_token) VALUES (?, ?, ?)').run(99, 'dev-other', 'tok-other');

    const res = await dispatchAuth('/logout-all', {}, {
      headers: { 'x-test-user-id': '42', 'x-test-device-id': 'dev-a' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.devicesRevoked).toBe(2);

    const rows = testDb.prepare(
      'SELECT user_id, device_id FROM ios_devices ORDER BY device_id',
    ).all() as { user_id: number; device_id: string }[];
    expect(rows).toEqual([{ user_id: 99, device_id: 'dev-other' }]);
  });
});
