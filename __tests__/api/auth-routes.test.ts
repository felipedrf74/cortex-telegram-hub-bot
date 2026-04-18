import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

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

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
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

async function dispatchRegisterInvite(body: any): Promise<MockRes> {
  return dispatchAuth('/register', body);
}

describe('Auth invite registration', () => {
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
    expect(user.daily_cost_limit_usd).toBeGreaterThanOrEqual(0.6);

    const subscription = testDb.prepare(
      'SELECT plan, status, provider, period FROM subscriptions WHERE user_id = ?'
    ).get(res.body.data.user.id) as {
      plan: string;
      status: string;
      provider: string;
      period: string;
    };

    expect(subscription).toMatchObject({
      plan: 'max',
      status: 'trialing',
      provider: 'none',
      period: 'yearly',
    });
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
    expect(res.body.error.message).toBe('deviceId e inviteCode são obrigatórios');
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
});
