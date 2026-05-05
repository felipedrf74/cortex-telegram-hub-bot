import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/config', () => ({
  config: {
    portal: {
      token: 'legacy-token',
      readToken: 'portal-read-token',
      writeToken: 'portal-write-token',
      adminToken: 'portal-admin-token',
      allowLegacyFallback: false,
      allowLocalBypass: false,
      requireSessionAuth: false,
      sessionSecret: '',
      sessionMaxAgeMs: 28800000,
      adminRequireActor: true,
      adminActorAllowlist: ['agent5@nexushub.me'],
      adminActorSignatureSecret: '',
      adminActorSignatureToleranceMs: 300000,
    },
    health: { allowUnauthenticatedDetailed: false },
    financeEncryption: { enabled: false, masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
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

import { registerPortalAdminDataRoutes } from '../../src/portal/admin-data-routes';

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

function seedTenantRows(): void {
  // Seed the users table so the admin target-user guard (Gap 5) can resolve
  // the target canonical ids before reaching the handler body. These rows
  // are independent of the finance/audit isolation this suite exercises.
  const userInsert = testDb.prepare(
    `INSERT INTO users (id, telegram_id, first_name, status) VALUES (?, ?, ?, 'active')`,
  );
  userInsert.run(501, 100501, 'Tenant A');
  userInsert.run(502, 100502, 'Tenant B');

  testDb.prepare(`
    INSERT INTO finance_transactions (user_id, date, category, amount, currency, description)
    VALUES (?, '2026-04-01', 'income', 1000, 'EUR', ?)
  `).run(501, 'Tenant A revenue');
  testDb.prepare(`
    INSERT INTO finance_transactions (user_id, date, category, amount, currency, description)
    VALUES (?, '2026-04-02', 'income', 2000, 'EUR', ?)
  `).run(502, 'Tenant B revenue');
  testDb.prepare(`
    INSERT INTO finance_tax_events (user_id, month, gross_income, tax_due)
    VALUES (?, '2026-04', 1000, 100)
  `).run(501);
  testDb.prepare(`
    INSERT INTO finance_tax_events (user_id, month, gross_income, tax_due)
    VALUES (?, '2026-04', 2000, 200)
  `).run(502);
  testDb.prepare(`
    INSERT INTO audit_trail (user_id, actor_id, action, resource, details)
    VALUES (?, ?, 'access', 'finance.transactions', ?)
  `).run(501, 501, JSON.stringify({ marker: 'tenant-a-audit' }));
  testDb.prepare(`
    INSERT INTO audit_trail (user_id, actor_id, action, resource, details)
    VALUES (?, ?, 'access', 'finance.transactions', ?)
  `).run(502, 502, JSON.stringify({ marker: 'tenant-b-audit' }));
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  registerPortalAdminDataRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('Portal admin data route tenant isolation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
    seedTenantRows();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('requires admin scope before operator routes can read user data', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/501/data-summary`, {
        headers: {
          authorization: 'Bearer portal-read-token',
          'x-portal-actor': 'agent5@nexushub.me',
        },
      });
      const body = await response.json() as any;

      expect(response.status).toBe(401);
      expect(body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin token',
      });
    });
  });

  it('returns data-summary counts only for the requested canonical user id', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/501/data-summary`, {
        headers: {
          authorization: 'Bearer portal-admin-token',
          'x-portal-actor': 'agent5@nexushub.me',
        },
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        financeTransactions: 1,
        financeTaxEvents: 1,
      });
      expect(JSON.stringify(body)).not.toContain('Tenant B revenue');
    });
  });

  it('keeps audit trail filtering scoped when an admin requests one user', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/audit-trail?userId=501`, {
        headers: {
          authorization: 'Bearer portal-admin-token',
          'x-portal-actor': 'agent5@nexushub.me',
        },
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].user_id).toBe(501);
      expect(JSON.stringify(body)).toContain('tenant-a-audit');
      expect(JSON.stringify(body)).not.toContain('tenant-b-audit');
    });
  });
});
