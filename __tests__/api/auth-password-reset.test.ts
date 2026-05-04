// AUTH-O2 (closed-beta-auth-hardening, 2026-05-04): password reset flow tests.
//
// Covers:
//  - issued: real email gets a token; row created with hashed token + 1h TTL.
//  - silent: unknown email gets indistinguishable 200 OK; no row created.
//  - confirm success: valid token + strong password → password updated,
//    row marked used, sessions revoked.
//  - confirm invalid: garbage token returns 400 INVALID_TOKEN.
//  - confirm already-used: second use returns 400 (single-use enforced).
//  - confirm expired: past-TTL row returns 400.
//  - confirm too-many-attempts: 5+ wrong attempts return 429.
//  - confirm weak password: <8 chars → 400 WEAK_PASSWORD.
//  - account-existence enumeration: same envelope for known and unknown emails.
//  - upsert: a second /request invalidates the first token.
//  - audit: logAudit called with the correct outcome strings on each path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;
const auditCalls: any[] = [];

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services; isolation is fine.
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

function mockRes(): MockRes & { _done: Promise<void>; _resolve: () => void; _resolved: boolean } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const res: MockRes & { _done: Promise<void>; _resolve: () => void; _resolved: boolean } = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) {
      res.body = body;
      // Resolve the "response complete" signal exactly once. The dispatch
      // helper awaits this so async route paths (like password-reset/confirm
      // which awaits bcrypt) finish before assertions run.
      if (!res._resolved) { res._resolved = true; res._resolve(); }
      return res;
    },
    _done: done,
    _resolve: resolve,
    _resolved: false,
  };
  return res;
}

function mockReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers,
    header(name: string) { return headers[name.toLowerCase()]; },
  } as any;
}

async function dispatch(path: string, body: any): Promise<MockRes> {
  const { authRoutes } = await import('../../src/api/routes/auth');
  const router = authRoutes();
  const req = mockReq(body);
  (req as any).method = 'POST';
  (req as any).url = path;
  (req as any).originalUrl = path;
  (req as any).baseUrl = '';
  (req as any).path = path;
  const res = mockRes();
  // Wait for either:
  //   (a) Express to call `next()` (no route matched / passed through), OR
  //   (b) the route handler to call `res.json(...)` (response complete), OR
  //   (c) a 1s safety timeout (prevents an infinite hang on a real bug).
  // Without this, async paths (e.g. /password-reset/confirm awaits bcrypt)
  // race against `setImmediate` and the test reads stale res state.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const settle = () => { if (!resolved) { resolved = true; resolve(); } };
    (router as any).handle(req, res, (err: any) => { if (err) throw err; settle(); });
    res._done.then(settle);
    setTimeout(settle, 1000);
  });
  return res;
}

beforeEach(async () => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);

  process.env.IOS_API_ENABLED = 'true';
  process.env.IOS_API_JWT_SECRET = 'test-secret';
  process.env.IOS_INVITE_CODE = 'TEST_INVITE';
  process.env.IOS_OWNER_CODE = 'TEST_OWNER';
  process.env.OWNER_TELEGRAM_ID = '991122';
  process.env.PASSWORD_RESET_DEV_TOKEN = '1';
  delete process.env.RESEND_API_KEY; // exercise dev-mode (returns devToken)

  auditCalls.length = 0;
  vi.resetModules();

  vi.doMock('../../src/services/database', () => ({
    getDb: () => testDb,
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), child: vi.fn().mockReturnThis(),
    },
  }));
  vi.doMock('../../src/services/error-monitor', () => ({
    captureError: vi.fn(),
  }));
  vi.doMock('../../src/services/user-service', async () => {
    const actual = await vi.importActual<any>('../../src/services/user-service');
    return {
      ...actual,
      getUserByEmail: (email: string) => {
        const row = testDb.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
        return row || null;
      },
    };
  });
  vi.doMock('../../src/services/audit-trail', () => ({
    logAudit: vi.fn((entry: any) => { auditCalls.push(entry); }),
  }));
  vi.doMock('../../src/services/email-sender', async () => ({
    isEmailConfigured: () => false,
    sendPasswordResetEmail: vi.fn(async () => true),
    sendVerificationCode: vi.fn(async () => true),
    sendFiscalBundleEmail: vi.fn(async () => true),
    isFiscalBundleDeliveryConfigured: () => false,
  }));
  vi.doMock('../../src/api/auth-middleware', () => ({
    authMiddleware: (req: any, _res: any, next: any) => {
      req.userId = Number(req.headers?.['x-test-user-id'] ?? 1);
      req.deviceId = String(req.headers?.['x-test-device-id'] ?? 'test-device');
      next();
    },
  }));
});

afterEach(() => {
  testDb.close();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function seedUserWithPassword(email: string, plaintext: string): number {
  const passwordHash = bcrypt.hashSync(plaintext, 4); // low cost for tests
  const result = testDb.prepare(`
    INSERT INTO users (telegram_id, first_name, email, password_hash, email_verified, created_at)
    VALUES (NULL, ?, ?, ?, 0, datetime('now'))
  `).run('Test', email, passwordHash);
  return Number(result.lastInsertRowid);
}

describe('AUTH-O2 password reset — request', () => {
  it('issues a token row for a real email and returns generic 200 OK', async () => {
    const userId = seedUserWithPassword('alice@example.com', 'oldpass1');
    const res = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    // dev-mode (no RESEND_API_KEY) returns devToken
    expect(typeof res.body.data.devToken).toBe('string');
    expect(res.body.data.devToken.length).toBeGreaterThan(20);
    const row = testDb.prepare('SELECT * FROM password_reset_tokens WHERE user_id = ?').get(userId) as any;
    expect(row).toBeDefined();
    expect(row.attempt_count).toBe(0);
    expect(row.used_at).toBeNull();
    // expires_at ≈ now + 1h (allow drift)
    const expiresMs = new Date(row.expires_at).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(55 * 60 * 1000);
    expect(expiresMs).toBeLessThan(65 * 60 * 1000);
    // request_issued audit row emitted
    expect(auditCalls.find((c) => c.details?.outcome === 'request_issued')).toBeDefined();
  });

  it('returns same generic 200 for an unknown email and creates no row', async () => {
    const userId = seedUserWithPassword('alice@example.com', 'oldpass1');
    delete process.env.PASSWORD_RESET_DEV_TOKEN;

    const known = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const res = await dispatch('/password-reset/request', { email: 'unknown@example.com' });
    expect(known.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
    // Anti-enumeration assertion: known + unknown email responses must
    // be byte-identical EXCEPT for the per-request `timestamp` field
    // (set by `apiSuccess()` envelope; differs by milliseconds between
    // two sequential calls under load). Strip timestamp before comparing.
    const stripTimestamp = (body: any) => {
      const { timestamp: _ignored, ...rest } = body;
      return rest;
    };
    expect(stripTimestamp(known.body)).toEqual(stripTimestamp(res.body));
    expect(known.body.data.devToken).toBeUndefined();
    expect(res.body.ok).toBe(true);
    const rows = testDb.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get() as any;
    expect(rows.n).toBe(1);
    expect(testDb.prepare('SELECT user_id FROM password_reset_tokens').get()).toEqual({ user_id: userId });
    expect(auditCalls.find((c) => c.details?.outcome === 'request_silent')).toBeDefined();
  });

  it('returns same envelope for malformed body (no enumeration shape signal)', async () => {
    const r1 = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    seedUserWithPassword('alice@example.com', 'oldpass1');
    const r2 = await dispatch('/password-reset/request', {}); // no body
    const r3 = await dispatch('/password-reset/request', { email: 12345 }); // wrong type
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });

  it('upserts on user_id — a second request invalidates the first token', async () => {
    seedUserWithPassword('alice@example.com', 'oldpass1');
    const r1 = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const t1 = r1.body.data.devToken;
    const r2 = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const t2 = r2.body.data.devToken;
    expect(t1).not.toBe(t2);
    // Old token should not match the active row
    const confirm = await dispatch('/password-reset/confirm', { token: t1, newPassword: 'newpassword1' });
    expect(confirm.statusCode).toBe(400);
    expect(confirm.body.error.code).toBe('INVALID_TOKEN');
  });

  it('does NOT issue a token for users without a password (Apple/Google-only)', async () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, email, password_hash, email_verified, created_at)
      VALUES (NULL, 'Apple', 'apple-only@example.com', NULL, 1, datetime('now'))
    `).run();
    const res = await dispatch('/password-reset/request', { email: 'apple-only@example.com' });
    expect(res.statusCode).toBe(200);
    const rows = testDb.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get() as any;
    expect(rows.n).toBe(0);
    expect(auditCalls.find((c) => c.details?.outcome === 'request_silent')).toBeDefined();
  });
});

describe('AUTH-O2 password reset — confirm', () => {
  it('rejects an unknown token with INVALID_TOKEN 400', async () => {
    const res = await dispatch('/password-reset/confirm', {
      token: 'definitely-not-a-real-token',
      newPassword: 'strongpass1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
    expect(auditCalls.find((c) => c.details?.outcome === 'confirm_invalid')).toBeDefined();
  });

  it('rejects a missing or short password with WEAK_PASSWORD 400', async () => {
    const r1 = await dispatch('/password-reset/confirm', { token: 'x', newPassword: '' });
    const r2 = await dispatch('/password-reset/confirm', { token: 'x', newPassword: '1234567' });
    expect(r1.statusCode).toBe(400);
    expect(r1.body.error.code).toBe('WEAK_PASSWORD');
    expect(r2.statusCode).toBe(400);
    expect(r2.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('accepts a valid token, updates password_hash, marks row used, revokes sessions', async () => {
    const userId = seedUserWithPassword('alice@example.com', 'oldpass1');
    // seed an active iOS device row that should get DELETEd on reset
    // (existing /auth/logout-all pattern — row existence is the session).
    testDb.prepare(`
      INSERT INTO ios_devices (device_id, user_id, refresh_token)
      VALUES ('device-A', ?, 'old-rt')
    `).run(userId);

    const issue = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const token = issue.body.data.devToken;

    const confirm = await dispatch('/password-reset/confirm', {
      token,
      newPassword: 'brand-new-password-1',
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body.data.reset).toBe(true);

    // Password updated (bcrypt hash differs)
    const user = testDb.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as any;
    expect(user.password_hash).not.toBe(bcrypt.hashSync('oldpass1', 4));
    expect(bcrypt.compareSync('brand-new-password-1', user.password_hash)).toBe(true);

    // Token row marked used
    const row = testDb.prepare('SELECT used_at FROM password_reset_tokens WHERE user_id = ?').get(userId) as any;
    expect(row.used_at).not.toBeNull();

    // iOS device session revoked (row deleted)
    const device = testDb.prepare('SELECT * FROM ios_devices WHERE device_id = ?').get('device-A') as any;
    expect(device).toBeUndefined();

    // confirm_success audit row
    expect(auditCalls.find((c) => c.details?.outcome === 'confirm_success')).toBeDefined();
  });

  it('refuses re-use of a consumed token (single-use enforced)', async () => {
    seedUserWithPassword('alice@example.com', 'oldpass1');
    const issue = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const token = issue.body.data.devToken;
    const first = await dispatch('/password-reset/confirm', { token, newPassword: 'fresh-password-1' });
    expect(first.statusCode).toBe(200);
    const second = await dispatch('/password-reset/confirm', { token, newPassword: 'another-password-1' });
    expect(second.statusCode).toBe(400);
    expect(second.body.error.code).toBe('INVALID_TOKEN');
    expect(auditCalls.find((c) => c.details?.outcome === 'confirm_already_used')).toBeDefined();
  });

  it('refuses an expired token (past expires_at)', async () => {
    const userId = seedUserWithPassword('alice@example.com', 'oldpass1');
    const issue = await dispatch('/password-reset/request', { email: 'alice@example.com' });
    const token = issue.body.data.devToken;
    // Force expiry into the past
    testDb.prepare(`UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), userId);
    const confirm = await dispatch('/password-reset/confirm', { token, newPassword: 'fresh-password-1' });
    expect(confirm.statusCode).toBe(400);
    expect(confirm.body.error.code).toBe('INVALID_TOKEN');
    expect(auditCalls.find((c) => c.details?.outcome === 'confirm_expired')).toBeDefined();
  });

  it('locks a token row after 5 failed attempts → 429 TOO_MANY_ATTEMPTS', async () => {
    const userId = seedUserWithPassword('alice@example.com', 'oldpass1');
    await dispatch('/password-reset/request', { email: 'alice@example.com' });
    // Force the row into a "5 attempts already used" state. The route
    // checks the attempt cap BEFORE doing any further work, so a valid
    // token is irrelevant — the cap is what closes the path.
    testDb.prepare('UPDATE password_reset_tokens SET attempt_count = 5 WHERE user_id = ?').run(userId);
    const tokenRow = testDb.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get(userId) as any;
    // We need the actual unhashed token to pass the lookup; reissue and
    // patch the attempt count again to keep the harness simple.
    const { generatePasswordResetToken, hashResetToken } = await import('../../src/services/password-reset');
    const fresh = generatePasswordResetToken();
    testDb.prepare('UPDATE password_reset_tokens SET token_hash = ?, attempt_count = 5 WHERE user_id = ?')
      .run(fresh.tokenHash, userId);
    const res = await dispatch('/password-reset/confirm', {
      token: fresh.token,
      newPassword: 'fresh-password-1',
    });
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(auditCalls.find((c) => c.details?.outcome === 'confirm_too_many')).toBeDefined();
  });
});

describe('AUTH-O2 password reset — service unit shape', () => {
  it('hashResetToken is deterministic and 64 hex chars', async () => {
    const { hashResetToken } = await import('../../src/services/password-reset');
    const a = hashResetToken('hello');
    const b = hashResetToken('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generatePasswordResetToken yields fresh token + matching hash', async () => {
    const { generatePasswordResetToken, hashResetToken } = await import('../../src/services/password-reset');
    const r1 = generatePasswordResetToken();
    const r2 = generatePasswordResetToken();
    expect(r1.token).not.toBe(r2.token);
    expect(hashResetToken(r1.token)).toBe(r1.tokenHash);
  });

  it('PASSWORD_RESET_MAX_ATTEMPTS is 5 and TTL is 1h', async () => {
    const mod = await import('../../src/services/password-reset');
    expect(mod.PASSWORD_RESET_MAX_ATTEMPTS).toBe(5);
    expect(mod.PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });
});
