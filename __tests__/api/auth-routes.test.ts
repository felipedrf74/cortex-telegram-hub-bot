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

function mockReq(body: any): Request {
  return {
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchRegisterInvite(body: any): Promise<MockRes> {
  const { authRoutes } = await import('../../src/api/routes/auth');
  const router = authRoutes();
  const req = mockReq(body);
  (req as any).method = 'POST';
  (req as any).url = '/register';
  (req as any).originalUrl = '/register';
  (req as any).baseUrl = '';
  (req as any).path = '/register';
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
      authMiddleware: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
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
});
