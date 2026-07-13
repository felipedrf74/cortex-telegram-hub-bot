import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import Database from 'better-sqlite3';

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
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    portal: {
      token: 'write-token',
      readToken: 'read-token',
      writeToken: 'write-token',
      allowLegacyFallback: false,
      allowLocalBypass: false,
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: vi.fn(),
}));

async function fetchJson(app: express.Express, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no address'));
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: url,
        method,
        headers: {
          Authorization: 'Bearer write-token',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function appWithRoutes(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
  app.use('/api/v1/admin/content', contentAdminWriteRoutes());
  return app;
}

describe('content admin pillar tenant scope', () => {
  beforeEach(() => {
    vi.resetModules();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE config_pillars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '[]',
        weight REAL NOT NULL DEFAULT 1.0,
        language TEXT NOT NULL DEFAULT 'pt-BR',
        user_id INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        tenant_id INTEGER,
        owner_user_id INTEGER,
        visibility_scope TEXT,
        lifecycle_state TEXT,
        scope_status TEXT,
        created_by INTEGER,
        updated_by INTEGER,
        audit_metadata_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO config_pillars (name, keywords, user_id, tenant_id, owner_user_id, visibility_scope, scope_status)
      VALUES
        ('user-a', '["a"]', 10, 10, 10, 'user_private', 'active'),
        ('user-b', '["b"]', 20, 20, 20, 'user_private', 'active');
    `);
  });

  it('User B cannot enumerate User A pillars', async () => {
    const app = await appWithRoutes();
    const res = await fetchJson(app, 'GET', '/api/v1/admin/content/pillars?userId=20&tenantId=20');

    expect(res.status).toBe(200);
    expect(res.body.pillars).toHaveLength(1);
    expect(res.body.pillars[0].name).toBe('user-b');
  });

  it('User B cannot delete User A pillars', async () => {
    const app = await appWithRoutes();
    const res = await fetchJson(app, 'DELETE', '/api/v1/admin/content/pillars/1?userId=20&tenantId=20');

    expect(res.status).toBe(404);
    const row = testDb.prepare('SELECT name FROM config_pillars WHERE id = 1').get() as { name: string };
    expect(row.name).toBe('user-a');
  });

  it('rejects non-string pillar names instead of throwing a 500', async () => {
    const app = await appWithRoutes();
    const createRes = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/pillars',
      { userId: 20, tenantId: 20, name: { bad: true }, keywords: ['valid'] },
    );
    const patchRes = await fetchJson(
      app,
      'PATCH',
      '/api/v1/admin/content/pillars/2?userId=20&tenantId=20',
      { name: 123 },
    );

    expect(createRes.status).toBe(400);
    expect(createRes.body.error.message).toContain('name (string)');
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.error.message).toBe('name must be a non-empty string');
  });

  it('rejects client-supplied historical comparison visibility scopes outside the content allowlist', async () => {
    const app = await appWithRoutes();
    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/historical-comparison',
      {
        userId: 20,
        tenantId: 20,
        title: 'Candidate idea',
        visibilityScope: 'platform_internal',
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('visibilityScope must be one of');
  });
});
