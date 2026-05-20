import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services; auth route tests
        // only need the schema that applies cleanly in isolation.
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

function mockRes(onJson?: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; onJson?.(); return res; },
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

async function dispatchAuth(path: string, body: any, options: { method?: string; headers?: Record<string, string> } = {}): Promise<MockRes> {
  const { authRoutes } = await import('../../src/api/routes/auth');
  const router = authRoutes();
  const req = mockReq(body, options.headers);
  (req as any).method = options.method ?? 'POST';
  (req as any).url = path;
  (req as any).originalUrl = path;
  (req as any).baseUrl = '';
  (req as any).path = path;
  let res!: MockRes;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res = mockRes(finish);
    (router as any).handle(req, res, (err: any) => {
      if (err) {
        reject(err);
        return;
      }
      finish();
    });
    setTimeout(finish, 1000);
  });

  return res;
}

async function dispatchRegisterInvite(body: any): Promise<MockRes> {
  return dispatchAuth('/register', body);
}

describe('Auth invite registration', () => {
  const originalEnv = {
    STAGING: process.env.STAGING,
    IOS_API_ENABLED: process.env.IOS_API_ENABLED,
    IOS_API_JWT_SECRET: process.env.IOS_API_JWT_SECRET,
    IOS_INVITE_CODE: process.env.IOS_INVITE_CODE,
    IOS_OWNER_CODE: process.env.IOS_OWNER_CODE,
    OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    APPLE_WEB_CLIENT_ID: process.env.APPLE_WEB_CLIENT_ID,
    APPLE_WEB_REDIRECT_URI: process.env.APPLE_WEB_REDIRECT_URI,
  };

  function restoreEnv(key: keyof typeof originalEnv): void {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  beforeEach(async () => {
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
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
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
    vi.resetModules();
  });

  it('logs asynchronous verification email send failures instead of swallowing them', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/auth.ts'), 'utf8');
    expect(source).toContain('Verification email send failed');
    expect(source).toContain('userId: user.id');
    expect(source).toContain('emailHash: hashEmail');
  });

  it('provisions beta invite users with active max-tier sandbox access', async () => {
    const res = await dispatchRegisterInvite({
      deviceId: 'beta-device-1234',
      deviceName: 'Beta Tester',
      inviteCode: 'LOCALBETA_TEST',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.user.id).toBeTypeOf('number');

    const user = testDb.prepare(
      'SELECT tier, status, auth_provider, daily_cost_limit_usd FROM users WHERE id = ?'
    ).get(res.body.data.user.id) as {
      tier: string;
      status: string;
      auth_provider: string;
      daily_cost_limit_usd: number;
    };

    expect(user.tier).toBe('max');
    expect(user.status).toBe('active');
    expect(user.auth_provider).toBe('invite_code');
    expect(user.daily_cost_limit_usd).toBeGreaterThanOrEqual(0.06);

    const subscription = testDb.prepare(
      'SELECT plan, status, provider, period, current_period_end FROM subscriptions WHERE user_id = ?'
    ).get(res.body.data.user.id) as {
      plan: string;
      status: string;
      provider: string;
      period: string;
      current_period_end: string;
    };

    expect(subscription).toMatchObject({
      plan: 'max',
      status: 'trialing',
      provider: 'beta',
      period: 'monthly',
    });
    const days = (Date.parse(subscription.current_period_end) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(366);
  });

  it('provisions database invite users with the invite expiration date', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    testDb.prepare(`
      INSERT INTO invite_codes (code, created_by, max_uses, used_count, expires_at)
      VALUES ('DB_INVITE_30D', 0, 1, 0, ?)
    `).run(expiresAt);

    const res = await dispatchRegisterInvite({
      deviceId: 'db-invite-device-1234',
      deviceName: 'Beta Tester',
      inviteCode: 'DB_INVITE_30D',
    });

    expect(res.statusCode).toBe(201);
    const subscription = testDb.prepare(
      'SELECT current_period_end FROM subscriptions WHERE user_id = ?',
    ).get(res.body.data.user.id) as { current_period_end: string };
    const days = (Date.parse(subscription.current_period_end) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  it('accepts invite codes case-insensitively for iOS keyboard compatibility', async () => {
    const res = await dispatchRegisterInvite({
      deviceId: 'beta-device-case-test',
      deviceName: 'Beta Tester',
      inviteCode: 'Localbeta_Test',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.user.id).toBeTypeOf('number');
  });

  it('localizes invite-registration validation errors for Portuguese requests', async () => {
    const res = await dispatchAuth(
      '/register',
      {},
      {
        headers: {
          'x-language': 'pt-BR',
        },
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('deviceId é obrigatório');
  });

  it('resolves the owner invite code through the seeded owner bootstrap user instead of inline route mapping', async () => {
    const res = await dispatchRegisterInvite({
      deviceId: 'owner-device-1234',
      deviceName: 'Owner iPhone',
      inviteCode: 'LOCALOWNER_TEST',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);

    const owner = testDb.prepare(
      'SELECT id, telegram_id, tier, first_name FROM users WHERE id = ?',
    ).get(res.body.data.user.id) as {
      id: number;
      telegram_id: number;
      tier: string;
      first_name: string;
    };

    expect(owner.telegram_id).toBe(991122);
    expect(owner.tier).toBe('owner');
    expect(owner.first_name).toBe('Owner');
  });

  it('starts Google web sign-in with a one-time iOS auth state', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-web-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';

    const res = await dispatchAuth('/register/google/start', {
      deviceId: 'ios-device-google-start',
      deviceName: 'iPhone',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('google');
    expect(res.body.data.url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(res.body.data.url).toContain('client_id=google-web-client');
    expect(res.body.data.url).toContain('state=ios-auth%3A');
    expect(res.body.data.url).toContain('scope=openid+email+profile');
  });

  it('starts Google browser sign-in with a web callback state for the user login page', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-web-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';

    const res = await dispatchAuth('/register/google/start', {
      deviceId: 'web-browser-device',
      deviceName: 'Nexus Web',
      flow: 'web',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('google');
    expect(res.body.data.flow).toBe('web');
    expect(res.body.data.url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(res.body.data.url).toContain('client_id=google-web-client');
    expect(res.body.data.url).toContain('state=web-auth%3A');
    expect(res.body.data.url).toContain('scope=openid+email+profile');
  });

  it('finishes Google web sign-in with a stored auth completion payload', async () => {
    const { storeGoogleAuthCompletion } = await import('../../src/services/google-auth-session-store');

    const authCode = storeGoogleAuthCompletion({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 604800,
      user: {
        id: 77,
        firstName: 'Jaqueline',
        lastName: 'Silva',
        language: 'pt-BR',
      },
    });

    const res = await dispatchAuth('/register/google/finish', { authCode });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.accessToken).toBe('access-token');
    expect(res.body.data.user.firstName).toBe('Jaqueline');
    expect(res.body.data.user.lastName).toBe('Silva');
  });

  it('returns a setup error when Apple browser sign-in has no Services ID', async () => {
    delete process.env.APPLE_WEB_CLIENT_ID;
    delete process.env.APPLE_WEB_REDIRECT_URI;

    const res = await dispatchAuth('/register/apple/start', {
      deviceId: 'web-browser-device-apple',
      deviceName: 'Nexus Web',
      flow: 'web',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('starts Apple browser sign-in with a Services-ID audience and form_post callback', async () => {
    process.env.APPLE_WEB_CLIENT_ID = 'me.nexushub.web';
    process.env.APPLE_WEB_REDIRECT_URI = 'https://api.test/oauth/apple/callback';

    const res = await dispatchAuth('/register/apple/start', {
      deviceId: 'web-browser-device-apple',
      deviceName: 'Nexus Web',
      flow: 'web',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('apple');
    expect(res.body.data.flow).toBe('web');
    expect(res.body.data.url).toContain('https://appleid.apple.com/auth/authorize?');
    expect(res.body.data.url).toContain('client_id=me.nexushub.web');
    expect(res.body.data.url).toContain('redirect_uri=https%3A%2F%2Fapi.test%2Foauth%2Fapple%2Fcallback');
    expect(res.body.data.url).toContain('response_type=code+id_token');
    expect(res.body.data.url).toContain('response_mode=form_post');
    expect(res.body.data.url).toContain('scope=name+email');
    expect(res.body.data.url).toContain('state=web-apple%3A');
    expect(res.body.data.url).toContain('nonce=');
  });

  it('finishes Apple web sign-in with a stored auth completion payload', async () => {
    const { storeAppleWebAuthCompletion } = await import('../../src/services/apple-web-sign-in');

    const authCode = storeAppleWebAuthCompletion({
      accessToken: 'apple-access-token',
      refreshToken: 'apple-refresh-token',
      expiresIn: 604800,
      user: {
        id: 88,
        firstName: 'Apple',
        language: 'en',
        authProvider: 'apple',
      },
    });

    const res = await dispatchAuth('/register/apple/finish', { authCode });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.accessToken).toBe('apple-access-token');
    expect(res.body.data.user.firstName).toBe('Apple');
    expect(res.body.data.user.authProvider).toBe('apple');
  });

  it('rejects native Google registration when Google has not verified the email claim', async () => {
    class MockGoogleAccountLinkRequiresVerificationError extends Error {}
    class MockGoogleEmailNotVerifiedError extends Error {}
    vi.doMock('../../src/services/google-sign-in', () => ({
      GoogleAccountLinkRequiresVerificationError: MockGoogleAccountLinkRequiresVerificationError,
      GoogleEmailNotVerifiedError: MockGoogleEmailNotVerifiedError,
      verifyGoogleIdentityToken: vi.fn(async () => ({
        iss: 'https://accounts.google.com',
        aud: 'google-ios-client',
        sub: 'google-sub-unverified',
        email: 'unverified@example.com',
        emailVerified: false,
      })),
      resolveGoogleIdentityUser: vi.fn(() => {
        throw new MockGoogleEmailNotVerifiedError('Google email is not verified');
      }),
    }));

    const res = await dispatchAuth('/register/google', {
      idToken: 'google-id-token',
      deviceId: 'ios-device-google-unverified',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
  });

  it('requires Apple rawNonce before attempting Apple identity registration', async () => {
    const res = await dispatchAuth('/register/apple', {
      identityToken: 'apple-id-token',
      deviceId: 'ios-device-apple-no-nonce',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('rawNonce');
  });

  it('invalidates stale device refresh tokens when the same device switches accounts', async () => {
    const userAResult = testDb.prepare(`
      INSERT INTO users (email, first_name, language, auth_provider, daily_cost_limit_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run('tenant-a@example.com', 'Tenant A', 'en', 'email', 0.05);
    const userBResult = testDb.prepare(`
      INSERT INTO users (email, first_name, language, auth_provider, daily_cost_limit_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run('tenant-b@example.com', 'Tenant B', 'en', 'email', 0.05);
    const userAId = Number(userAResult.lastInsertRowid);
    const userBId = Number(userBResult.lastInsertRowid);
    const { createAuthSessionAndRegisterDevice } = await import('../../src/services/ios-auth-session');

    const sessionA = createAuthSessionAndRegisterDevice({
      userId: userAId,
      deviceId: 'shared-ios-device',
      deviceName: 'Felipe iPhone',
      pushToken: 'push-a',
      user: { first_name: 'Tenant A', language: 'en' },
      ipAddress: '127.0.0.1',
    });
    const sessionB = createAuthSessionAndRegisterDevice({
      userId: userBId,
      deviceId: 'shared-ios-device',
      deviceName: 'Felipe iPhone',
      pushToken: 'push-b',
      user: { first_name: 'Tenant B', language: 'en' },
      ipAddress: '127.0.0.1',
    });

    const staleRefresh = await dispatchAuth('/refresh', { refreshToken: sessionA.refreshToken });

    expect(staleRefresh.statusCode).toBe(401);
    expect(staleRefresh.body.error.code).toBe('UNAUTHORIZED');

    const activeRefresh = await dispatchAuth('/refresh', { refreshToken: sessionB.refreshToken });

    expect(activeRefresh.statusCode).toBe(200);
    expect(activeRefresh.body.ok).toBe(true);
    expect(activeRefresh.body.data.refreshToken).not.toBe(sessionB.refreshToken);
    const decoded = jwt.verify(activeRefresh.body.data.accessToken, 'test-ios-secret') as {
      userId: number;
      deviceId: string;
    };
    expect(decoded.userId).toBe(userBId);
    expect(decoded.deviceId).toBe('shared-ios-device');

    const device = testDb.prepare(
      'SELECT user_id, push_token, refresh_token, refresh_token_hash FROM ios_devices WHERE device_id = ?',
    ).get('shared-ios-device') as {
      user_id: number;
      push_token: string;
      refresh_token: string | null;
      refresh_token_hash: string | null;
    };

    expect(device.user_id).toBe(userBId);
    expect(device.push_token).toBe('push-b');
    // AUTH-O4 (closed-beta-auth-hardening, 2026-05-04): refresh tokens
    // are now stored as SHA-256 hash at rest, not plaintext. The
    // plaintext column is cleared on every write; the hash column is
    // what backs lookup at /auth/refresh.
    expect(device.refresh_token).toBeNull();
    const crypto = await import('crypto');
    const expectedHash = crypto.createHash('sha256')
      .update(activeRefresh.body.data.refreshToken, 'utf8').digest('hex');
    expect(device.refresh_token_hash).toBe(expectedHash);

    const replayPrevious = await dispatchAuth('/refresh', { refreshToken: sessionB.refreshToken });
    expect(replayPrevious.statusCode).toBe(401);
    expect(replayPrevious.body.error.code).toBe('UNAUTHORIZED');
    const remainingSessions = testDb.prepare('SELECT COUNT(*) AS n FROM ios_devices WHERE user_id = ?')
      .get(userBId) as { n: number };
    expect(remainingSessions.n).toBe(0);

    testDb.prepare(`
      INSERT INTO ios_devices (device_id, user_id, refresh_token)
      VALUES ('legacy-device', ?, 'legacy-refresh-token')
    `).run(userAId);
    const countBeforeBackfill = testDb.prepare('SELECT COUNT(*) AS n FROM ios_devices').get() as { n: number };
    const { backfillLegacyRefreshTokenHashes } = await import('../../src/services/ios-auth-session');
    const backfill = backfillLegacyRefreshTokenHashes();
    const countAfterBackfill = testDb.prepare('SELECT COUNT(*) AS n FROM ios_devices').get() as { n: number };
    expect(countAfterBackfill.n).toBe(countBeforeBackfill.n);
    expect(backfill.hashedRows).toBe(1);
    const legacy = testDb.prepare(`
      SELECT refresh_token, refresh_token_hash
      FROM ios_devices
      WHERE device_id = 'legacy-device'
    `).get() as { refresh_token: string | null; refresh_token_hash: string | null };
    expect(legacy.refresh_token).toBeNull();
    expect(legacy.refresh_token_hash).toBe(
      crypto.createHash('sha256').update('legacy-refresh-token', 'utf8').digest('hex'),
    );
  });

  it('returns the authenticated user profile for session rehydration', async () => {
    const db = testDb;
    const result = db.prepare(`
      INSERT INTO users (
        email,
        first_name,
        last_name,
        language,
        auth_provider,
        daily_cost_limit_usd
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'felipe@example.com',
      'Felipe',
      'Dominguez',
      'pt-BR',
      'email',
      0.05,
    );

    const userId = Number(result.lastInsertRowid);
    const res = await dispatchAuth(
      '/me',
      undefined,
      {
        method: 'GET',
        headers: {
          'x-test-user-id': String(userId),
          authorization: 'Bearer test-token',
        },
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      id: userId,
      firstName: 'Felipe',
      lastName: 'Dominguez',
      language: 'pt-BR',
    });
  });

  it('localizes email-login auth failures for Portuguese requests', async () => {
    const res = await dispatchAuth(
      '/login/email',
      {
        email: 'nobody@example.com',
        password: 'wrong-password',
        deviceId: 'ios-device-auth',
      },
      {
        headers: {
          'x-language': 'pt-BR',
        },
      },
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('AUTH_FAILED');
    expect(res.body.error.message).toBe('E-mail ou senha inválidos');
  });

  it('keeps email/password registration behind the closed-beta invite gate', async () => {
    const res = await dispatchAuth('/register/email', {
      email: 'new-email-user@example.com',
      password: 'correct-horse-battery',
      firstName: 'New',
      deviceId: 'ios-device-register-missing-invite',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVITE_REQUIRED');
  });

  it('rejects invalid invite codes during email/password registration', async () => {
    const res = await dispatchAuth('/register/email', {
      email: 'new-email-user@example.com',
      password: 'correct-horse-battery',
      firstName: 'New',
      deviceId: 'ios-device-register-invalid-invite',
      inviteCode: 'NOT_THE_BETA_CODE',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_INVITE');
  });

  it('requires invite code on legacy iOS invite registration', async () => {
    const res = await dispatchAuth('/register', {
      deviceId: 'ios-device-register-no-invite',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVITE_REQUIRED');
  });

  it('does not reveal whether an email already exists during email registration', async () => {
    testDb.prepare(`
      INSERT INTO users (email, password_hash, first_name, language, auth_provider, daily_cost_limit_usd)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('registered@example.com', 'bcrypt-hash', 'Registered', 'en', 'email', 0.05);

    const res = await dispatchAuth('/register/email', {
      email: 'registered@example.com',
      password: 'correct-horse-battery',
      firstName: 'Registered',
      deviceId: 'ios-device-register-duplicate',
      inviteCode: 'LOCALBETA_TEST',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('REGISTRATION_REJECTED');
    expect(res.body.error.code).not.toBe('EMAIL_EXISTS');
  });

  it('grants static beta access during email/password registration', async () => {
    const res = await dispatchAuth('/register/email', {
      email: 'static-beta@example.com',
      password: 'correct-horse-battery',
      firstName: 'Static',
      deviceId: 'ios-device-register-static-beta',
      inviteCode: 'LOCALBETA_TEST',
    });

    expect(res.statusCode).toBe(201);
    const sub = testDb.prepare(`
      SELECT plan, status, provider, current_period_end
      FROM subscriptions
      WHERE user_id = ?
    `).get(res.body.data.user.id) as {
      plan: string;
      status: string;
      provider: string;
      current_period_end: string;
    };
    expect(sub).toMatchObject({ plan: 'max', status: 'trialing', provider: 'beta' });
    const days = (Date.parse(sub.current_period_end) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(366);
  });

  it('caps email verification code guesses and locks the active code', async () => {
    const userId = Number(testDb.prepare(`
      INSERT INTO users (email, first_name, language, auth_provider, daily_cost_limit_usd, email_verified)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('verify@example.com', 'Verify', 'en', 'email', 0.05, 0).lastInsertRowid);
    testDb.prepare(`
      INSERT INTO email_verification_codes (user_id, email, code, expires_at, attempt_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, 'verify@example.com', '123456', new Date(Date.now() + 60_000).toISOString(), 0);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await dispatchAuth(
        '/verify-email',
        { code: '000000' },
        { headers: { 'x-test-user-id': String(userId) } },
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CODE');
    }

    const fifth = await dispatchAuth(
      '/verify-email',
      { code: '000000' },
      { headers: { 'x-test-user-id': String(userId) } },
    );
    expect(fifth.statusCode).toBe(429);
    expect(fifth.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    const correctAfterLock = await dispatchAuth(
      '/verify-email',
      { code: '123456' },
      { headers: { 'x-test-user-id': String(userId) } },
    );
    expect(correctAfterLock.statusCode).toBe(429);
    expect(correctAfterLock.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    const row = testDb.prepare('SELECT attempt_count FROM email_verification_codes WHERE user_id = ?')
      .get(userId) as { attempt_count: number };
    expect(row.attempt_count).toBe(5);
  });

});
