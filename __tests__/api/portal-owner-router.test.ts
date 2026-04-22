// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * End-to-end test for the /owner/* control-plane router.
 *
 * Uses a real in-memory SQLite DB (so migration 076's backfill +
 * platform-admin seed actually run), a real Express app mounting
 * the router, and supertest-style synthetic requests. Pins:
 *
 *   - /owner/tenants requires X-Admin-User-Id (401 without).
 *   - /owner/tenants requires the id to map to a platform_admins row
 *     (403 NOT_A_PLATFORM_ADMIN for a regular user).
 *   - /owner/tenants returns the full cross-tenant list for a
 *     platform_owner.
 *   - PATCH /owner/tenants/:id requires requirePlatformWrite (rejects
 *     platform_readonly).
 *   - POST /owner/platform-admins requires requirePlatformOwner
 *     (rejects platform_admin, accepts platform_owner).
 *   - Audit trail row is written on mutation with actor_id = the
 *     real admin userId (not 0 — the hardening target).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // Skip incompatible migrations in isolated harness.
    }
  }
}

function seedUser(db: Database.Database, email: string, tier: string = 'free'): number {
  const stmt = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  );
  const result = stmt.run(email, tier);
  return Number(result.lastInsertRowid);
}

function grantPlatformRole(db: Database.Database, userId: number, role: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, ?, datetime('now'))`,
  ).run(userId, role);
}

import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';

function makeApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

async function req(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts: { adminUserId?: number; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminUserId !== undefined) {
        headers['X-Admin-User-Id'] = String(opts.adminUserId);
      }
      const body = opts.body ? JSON.stringify(opts.body) : undefined;

      const http = require('http');
      const request = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers },
        (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
            } catch (e) {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      request.on('error', (e: Error) => {
        server.close();
        reject(e);
      });
      if (body) request.write(body);
      request.end();
    });
  });
}

describe('/owner/* router integration', () => {
  let app: express.Express;
  let adminUid: number;
  let regularUid: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    // Seed an admin (platform_owner) and a regular user. Each becomes
    // their own solo tenant via migration 076's backfill.
    adminUid = seedUser(testDb, 'admin@e.com', 'owner');
    regularUid = seedUser(testDb, 'alice@e.com', 'free');
    // Make sure both have solo tenants (migration may have run before
    // seedUser, so backfill here).
    testDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'owner')`,
    ).run(adminUid, `user-${adminUid}`, 'admin@e.com');
    testDb.prepare(
      `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
    ).run(adminUid, adminUid);
    testDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`,
    ).run(regularUid, `user-${regularUid}`, 'alice@e.com');
    testDb.prepare(
      `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
    ).run(regularUid, regularUid);

    grantPlatformRole(testDb, adminUid, 'platform_owner');

    app = makeApp();
  });

  afterEach(() => testDb?.close());

  it('rejects unauthenticated access with 401', async () => {
    const r = await req(app, 'GET', '/owner/tenants');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a regular user with 403 NOT_A_PLATFORM_ADMIN', async () => {
    const r = await req(app, 'GET', '/owner/tenants', { adminUserId: regularUid });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
  });

  it('lists all tenants for a platform_owner', async () => {
    const r = await req(app, 'GET', '/owner/tenants', { adminUserId: adminUid });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.data.tenants)).toBe(true);
    expect(r.body.data.tenants.length).toBeGreaterThanOrEqual(2);
    expect(r.body.data.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('returns 400 on invalid tenantId', async () => {
    const r = await req(app, 'GET', '/owner/tenants/not-a-number', { adminUserId: adminUid });
    expect(r.status).toBe(400);
  });

  it('returns 404 for unknown tenantId', async () => {
    const r = await req(app, 'GET', '/owner/tenants/99999', { adminUserId: adminUid });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('returns tenant detail including member count for valid tenantId', async () => {
    const r = await req(app, 'GET', `/owner/tenants/${regularUid}`, { adminUserId: adminUid });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.id).toBe(regularUid);
    expect(r.body.data.memberCount).toBe(1);
  });

  it('PATCH /owner/tenants/:id updates status and writes audit_trail row with REAL actor_id', async () => {
    const r = await req(app, 'PATCH', `/owner/tenants/${regularUid}`, {
      adminUserId: adminUid,
      body: { status: 'suspended' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.status).toBe('suspended');

    // Audit row exists with actor_id = adminUid (NOT 0 — this is the fix).
    const audit = testDb
      .prepare(
        `SELECT user_id, actor_id, action, resource FROM audit_trail
         WHERE action = 'tenant.update' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { user_id: number; actor_id: number; action: string; resource: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit?.actor_id).toBe(adminUid);
    expect(audit?.resource).toBe(`tenant.${regularUid}`);
  });

  it('PATCH rejects platform_readonly with 403 (requirePlatformWrite)', async () => {
    const readonlyUid = seedUser(testDb, 'readonly@e.com');
    grantPlatformRole(testDb, readonlyUid, 'platform_readonly');

    const r = await req(app, 'PATCH', `/owner/tenants/${regularUid}`, {
      adminUserId: readonlyUid,
      body: { status: 'suspended' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
  });

  it('POST /owner/platform-admins rejects a platform_admin (only platform_owner can grant)', async () => {
    const secondAdmin = seedUser(testDb, 'second@e.com');
    grantPlatformRole(testDb, secondAdmin, 'platform_admin');

    const target = seedUser(testDb, 'target@e.com');

    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: secondAdmin,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
  });

  it('POST /owner/platform-admins accepts platform_owner and creates the row', async () => {
    const target = seedUser(testDb, 'grantee@e.com');
    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: adminUid,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ userId: target, role: 'platform_admin' });

    const row = testDb
      .prepare('SELECT role, granted_by FROM platform_admins WHERE user_id = ?')
      .get(target) as { role: string; granted_by: number } | undefined;
    expect(row?.role).toBe('platform_admin');
    expect(row?.granted_by).toBe(adminUid);
  });

  it('DELETE /owner/platform-admins refuses to revoke self', async () => {
    const r = await req(app, 'DELETE', `/owner/platform-admins/${adminUid}`, { adminUserId: adminUid });
    expect(r.status).toBe(400);
  });

  it('GET /owner/usage returns a cross-tenant usage snapshot (empty today)', async () => {
    const r = await req(app, 'GET', '/owner/usage', { adminUserId: adminUid });
    expect(r.status).toBe(200);
    expect(r.body.data.today).toHaveProperty('totalUsd');
    expect(Array.isArray(r.body.data.today.byTenant)).toBe(true);
  });
});
