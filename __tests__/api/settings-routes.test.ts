import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

async function getTenantScopeModule() {
  return import('../../src/services/tenant-scope-observability');
}

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
        // Some migrations rely on runtime services not needed here.
      }
    }
  }
}

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
  send(body?: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
    send(body?: any) { res.body = body ?? null; return res; },
  };
  return res;
}

function mockReq(userId: number, body: any): Request {
  return {
    userId,
    deviceId: 'test-device-id',
    body,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchLanguage(userId: number, language: string): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { language });
  (req as any).method = 'POST';
  (req as any).url = '/language';
  (req as any).originalUrl = '/language';
  (req as any).baseUrl = '';
  (req as any).path = '/language';
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

async function dispatchPushToken(userId: number, token: string, deviceId = 'test-device-id'): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { token });
  (req as any).deviceId = deviceId;
  (req as any).method = 'POST';
  (req as any).url = '/push-token';
  (req as any).originalUrl = '/push-token';
  (req as any).baseUrl = '';
  (req as any).path = '/push-token';
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

async function dispatchDeletePushToken(userId: number, deviceId = 'test-device-id'): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).deviceId = deviceId;
  (req as any).method = 'DELETE';
  (req as any).url = '/push-token';
  (req as any).originalUrl = '/push-token';
  (req as any).baseUrl = '';
  (req as any).path = '/push-token';
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

async function dispatchPushPreferencesGet(userId: number): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).method = 'GET';
  (req as any).url = '/push-preferences';
  (req as any).originalUrl = '/push-preferences';
  (req as any).baseUrl = '';
  (req as any).path = '/push-preferences';
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

async function dispatchPushPreferencesSet(userId: number, category: string, enabled: boolean): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { category, enabled });
  (req as any).method = 'PUT';
  (req as any).url = '/push-preferences';
  (req as any).originalUrl = '/push-preferences';
  (req as any).baseUrl = '';
  (req as any).path = '/push-preferences';
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

describe('Settings language route', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    testDb.prepare(`
      INSERT INTO users (id, first_name, language, status, auth_provider)
      VALUES (1, 'Beta Tester', 'pt-BR', 'active', 'invite_code')
    `).run();

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
    vi.doMock('../../src/services/user-service', () => ({
      setUserLanguage: (userId: number, language: string) => {
        testDb.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
      },
    }));
    return getTenantScopeModule().then(({ clearTenantScopeAnomaliesForTests }) => {
      clearTenantScopeAnomaliesForTests();
    });
  });

  it('accepts iOS short english code and stores canonical english', async () => {
    const res = await dispatchLanguage(1, 'en');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.language).toBe('en-US');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('en-US');
  });

  it('accepts portuguese from portugal and preserves pt-PT', async () => {
    const res = await dispatchLanguage(1, 'pt-PT');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-PT');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-PT');
  });

  it('accepts generic portuguese alias and stores canonical pt-BR', async () => {
    const res = await dispatchLanguage(1, 'pt');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-BR');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-BR');
  });

  it('upserts the push token even when the ios_devices row is missing', async () => {
    const res = await dispatchPushToken(1, 'abc123token', 'fresh-device');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = testDb.prepare(
      'SELECT user_id, device_id, push_token FROM ios_devices WHERE device_id = ?',
    ).get('fresh-device') as { user_id: number; device_id: string; push_token: string };

    expect(row.user_id).toBe(1);
    expect(row.push_token).toBe('abc123token');
  });

  it('revokes the authenticated device push token idempotently on sign-out', async () => {
    await dispatchPushToken(1, 'abc123token', 'signout-device');

    const res = await dispatchDeletePushToken(1, 'signout-device');
    const second = await dispatchDeletePushToken(1, 'signout-device');

    expect(res.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    const row = testDb.prepare(
      'SELECT push_token FROM ios_devices WHERE user_id = ? AND device_id = ?',
    ).get(1, 'signout-device') as { push_token: string | null };
    expect(row.push_token).toBeNull();
  });

  it('fails closed on invalid tenant scope for push preferences read', async () => {
    const res = await dispatchPushPreferencesGet(0);
    const { getTenantScopeAnomalies } = await getTenantScopeModule();

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'settings_route_get_push_preferences',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  it('reads and writes push preferences for a valid tenant scope', async () => {
    const setRes = await dispatchPushPreferencesSet(1, 'coach_briefing', false);

    expect(setRes.statusCode).toBe(200);
    expect(setRes.body.ok).toBe(true);
    expect(setRes.body.data).toEqual({ category: 'coach_briefing', enabled: false });

    const getRes = await dispatchPushPreferencesGet(1);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.data.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'coach_briefing', enabled: false }),
      ]),
    );
  });
});
