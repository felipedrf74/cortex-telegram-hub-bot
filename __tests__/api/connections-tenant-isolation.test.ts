import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    google: { clientId: 'google-client', clientSecret: 'google-secret', refreshToken: '' },
    outlook: { clientId: 'outlook-client', clientSecret: 'outlook-secret', tenantId: 'common', refreshToken: '' },
    financeEncryption: { enabled: false, masterKey: '' },
  },
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateIntegrationDerivedCaches: vi.fn(),
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

import { connectionRoutes } from '../../src/api/routes/connections';
import { storeTokens } from '../../src/services/oauth-store';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some unrelated migrations require tables not present in this harness.
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

async function dispatchRoute(method: string, routePath: string, userId: number): Promise<MockRes> {
  const router = connectionRoutes();
  const req = {
    userId,
    method,
    url: routePath,
    originalUrl: routePath,
    baseUrl: '',
    path: routePath,
    query: {},
    params: {},
    headers: {},
  } as any as Request;
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

async function dispatch(userId: number): Promise<MockRes> {
  return dispatchRoute('GET', '/', userId);
}

describe('Connections API tenant isolation', () => {
  beforeEach(() => {
    process.env.OAUTH_ENCRYPTION_KEY = 'tenant-isolation-oauth-key-32-bytes-minimum';
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
    delete process.env.OAUTH_ENCRYPTION_KEY;
    vi.unstubAllGlobals();
  });

  it('returns only the authenticated user integration metadata and never token material', async () => {
    const userA = 301;
    const userB = 302;
    storeTokens(userA, 'google', {
      accessToken: 'access-secret-a',
      refreshToken: 'refresh-secret-a',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    storeTokens(userB, 'outlook', {
      accessToken: 'access-secret-b',
      refreshToken: 'refresh-secret-b',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: ['Mail.ReadWrite'],
    });
    testDb.prepare(`
      INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
      VALUES (?, ?, ?, 'active')
    `).run(userA, 'tenant-a@garmin.example', '{"refresh":"garmin-secret-a"}');
    testDb.prepare(`
      INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json, last_refreshed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(userA, '{"token":"oauth1-a"}', '{"token":"oauth2-a"}');

    const forA = await dispatch(userA);
    const forB = await dispatch(userB);

    expect(forA.statusCode).toBe(200);
    expect(forA.body.data.connections.map((connection: any) => connection.provider).sort()).toEqual([
      'garmin',
      'google',
    ]);
    expect(forB.statusCode).toBe(200);
    expect(forB.body.data.connections.map((connection: any) => connection.provider)).toEqual(['outlook']);
    expect(forB.body.data.connections.some((connection: any) => connection.provider === 'google')).toBe(false);
    expect(forB.body.data.connections.some((connection: any) => connection.provider === 'garmin')).toBe(false);

    const serializedA = JSON.stringify(forA.body);
    const serializedB = JSON.stringify(forB.body);
    expect(serializedA).not.toContain('access-secret-a');
    expect(serializedA).not.toContain('refresh-secret-a');
    expect(serializedA).not.toContain('garmin-secret-a');
    expect(serializedB).not.toContain('access-secret-b');
    expect(serializedB).not.toContain('refresh-secret-b');
    expect(serializedB).not.toContain('tenant-a@garmin.example');
    expect(serializedA).not.toContain('outlook-secret');
  });

  it('revokes and removes only the authenticated user provider connection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);

    storeTokens(401, 'google', {
      accessToken: 'access-secret-a',
      refreshToken: 'refresh-secret-a',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    storeTokens(402, 'google', {
      accessToken: 'access-secret-b',
      refreshToken: 'refresh-secret-b',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const res = await dispatchRoute('DELETE', '/google', 401);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'google',
      disconnected: true,
      connectedBefore: true,
      revocation: {
        provider: 'google',
        attempted: true,
        status: 'revoked',
        statusCode: 200,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(testDb.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = ? AND provider = ?').get(401, 'google')).toBeUndefined();
    expect(testDb.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = ? AND provider = ?').get(402, 'google')).toBeTruthy();
  });
});
