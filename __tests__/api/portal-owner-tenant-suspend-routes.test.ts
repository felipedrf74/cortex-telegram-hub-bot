// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for POST /owner/tenants/:id/suspend + /activate
 * (OI-ADM-302, 2026-04-24).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch { /* skip */ }
  }
}
function seedUser(db: Database.Database, email: string): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email);
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`)
    .run(uid, `tenant-${uid}`, `Tenant ${uid}`);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
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

const DEFAULT_TOKEN = 'owner-console-token-for-tests-at-least-16-chars';

async function req(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts: { adminUserId?: number; body?: Record<string, unknown>; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
      const tokenValue = opts.token === undefined ? DEFAULT_TOKEN : opts.token;
      if (tokenValue !== null) headers['Authorization'] = 'Bearer ' + tokenValue;
      const body = opts.body ? JSON.stringify(opts.body) : undefined;
      const http = require('http');
      const r = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers },
        (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        },
      );
      r.on('error', (e: Error) => { server.close(); reject(e); });
      if (body) r.write(body);
      r.end();
    });
  });
}

describe('POST /owner/tenants/:id/suspend — auth (OI-ADM-302)', () => {
  let app: express.Express;
  let ownerUid: number;
  let tenantUid: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
  });

  beforeEach(() => {
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    ownerUid = seedUser(testDb, 'owner@example.com');
    grantPlatformRole(testDb, ownerUid, 'platform_owner');
    tenantUid = seedUser(testDb, 'victim-tenant@example.com');
    app = makeApp();
  });

  it('401 without owner token', async () => {
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: ownerUid, token: null,
    });
    expect(r.status).toBe(401);
  });

  it('401 without X-Admin-User-Id', async () => {
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {});
    expect(r.status).toBe(401);
  });

  it('403 when user is NOT a platform admin', async () => {
    const regularUid = seedUser(testDb, 'regular@example.com');
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: regularUid,
    });
    expect(r.status).toBe(403);
  });

  it('403 when user is platform_readonly (requirePlatformWrite)', async () => {
    const readOnlyUid = seedUser(testDb, 'readonly@example.com');
    grantPlatformRole(testDb, readOnlyUid, 'platform_readonly');
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: readOnlyUid,
    });
    expect(r.status).toBe(403);
  });

  it('200 when user is platform_admin (requirePlatformWrite allows both owner + admin)', async () => {
    const adminUid = seedUser(testDb, 'pa@example.com');
    grantPlatformRole(testDb, adminUid, 'platform_admin');
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: adminUid, body: { reason: 'non-payment' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.status).toBe('suspended');
  });
});

describe('POST /owner/tenants/:id/suspend — behavior (OI-ADM-302)', () => {
  let app: express.Express;
  let ownerUid: number;
  let tenantUid: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
  });

  beforeEach(() => {
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    ownerUid = seedUser(testDb, 'owner@example.com');
    grantPlatformRole(testDb, ownerUid, 'platform_owner');
    tenantUid = seedUser(testDb, 'victim-tenant@example.com');
    app = makeApp();
  });

  it('suspends the tenant + writes tenant.suspend audit row with actor + reason', async () => {
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: ownerUid, body: { reason: 'unpaid invoice' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.status).toBe('suspended');
    // Audit row.
    const auditRow = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'tenant.suspend' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor_id).toBe(ownerUid);
    expect(auditRow.resource).toBe(`tenant.${tenantUid}`);
    expect(JSON.parse(auditRow.details)).toMatchObject({
      tenantId: tenantUid,
      reason: 'unpaid invoice',
      beforeStatus: 'active',
    });
  });

  it('reason is optional (null when omitted)', async () => {
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: ownerUid, body: {},
    });
    expect(r.status).toBe(200);
    const auditRow = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'tenant.suspend' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(JSON.parse(auditRow.details).reason).toBeNull();
  });

  it('reason is trimmed + capped at 500 chars (no unbounded metadata leak)', async () => {
    const longReason = 'x'.repeat(1000);
    await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: ownerUid, body: { reason: longReason },
    });
    const auditRow = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'tenant.suspend' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(JSON.parse(auditRow.details).reason.length).toBe(500);
  });

  it('404 for unknown tenant id', async () => {
    const r = await req(app, 'POST', `/owner/tenants/99999/suspend`, {
      adminUserId: ownerUid, body: {},
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('400 for non-positive tenant id', async () => {
    const r = await req(app, 'POST', '/owner/tenants/0/suspend', {
      adminUserId: ownerUid, body: {},
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /owner/tenants/:id/activate (OI-ADM-302)', () => {
  let app: express.Express;
  let ownerUid: number;
  let tenantUid: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
  });

  beforeEach(() => {
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    ownerUid = seedUser(testDb, 'owner@example.com');
    grantPlatformRole(testDb, ownerUid, 'platform_owner');
    tenantUid = seedUser(testDb, 'victim-tenant@example.com');
    app = makeApp();
  });

  it('moves a suspended tenant back to active + writes tenant.activate audit', async () => {
    await req(app, 'POST', `/owner/tenants/${tenantUid}/suspend`, {
      adminUserId: ownerUid, body: { reason: 'test' },
    });
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/activate`, {
      adminUserId: ownerUid,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.status).toBe('active');
    const auditRow = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'tenant.activate' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor_id).toBe(ownerUid);
    expect(JSON.parse(auditRow.details)).toMatchObject({
      tenantId: tenantUid,
      beforeStatus: 'suspended',
    });
  });

  it('idempotent — activating an already-active tenant succeeds (200)', async () => {
    const r = await req(app, 'POST', `/owner/tenants/${tenantUid}/activate`, {
      adminUserId: ownerUid,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.status).toBe('active');
  });
});
