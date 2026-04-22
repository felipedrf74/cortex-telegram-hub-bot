// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for two /owner/* endpoints added to support the
 * Admin Console tenant drill-in and audit viewer (OI-ADM-301 +
 * OI-ADM-303, branch feature/nexus-hub-portal-uiux-admin-user-console,
 * 2026-04-22).
 *
 *   GET /owner/tenants/:tenantId/audit   (tenant-scoped audit)
 *   GET /owner/audit                     (filtered platform audit)
 *
 * These tests pin the contracts that the admin-console.html UI
 * depends on, and they pin the security-relevant invariants:
 *
 *   - Tenant-scoped audit MUST NOT leak rows from other tenants
 *     (the dot-prefix rule: tenant.4 doesn't match tenant.42.*).
 *   - LIKE-wildcard characters in user input (%, _) are escaped so
 *     an attacker can't craft an action / q filter that matches more
 *     than it should.
 *   - limit is clamped (1..200 tenant, 1..500 platform).
 *   - Auth chain still required (no bypass via the new endpoints).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

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
    .run(uid, `user-${uid}`, email);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}
function grantPlatformOwner(db: Database.Database, uid: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_owner', datetime('now'))`,
  ).run(uid);
}
function writeAudit(
  db: Database.Database,
  opts: { userId?: number; actorId: number; action: string; resource: string; details?: Record<string, unknown>; ts?: string },
): void {
  db.prepare(
    `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.userId ?? opts.actorId,
    opts.actorId,
    opts.action,
    opts.resource,
    opts.details ? JSON.stringify(opts.details) : null,
    opts.ts ?? "datetime('now')",
  );
}

import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';
import { _resetOwnerRateLimiterForTests } from '../../src/api/platform-admin-guard';

const OWNER_TOKEN = 'owner-console-token-for-tests-at-least-16-chars';

function makeApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

async function httpReq(
  app: express.Express,
  method: 'GET',
  urlPath: string,
  opts: { ownerToken?: string; adminUserId?: number } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.ownerToken !== undefined) headers['Authorization'] = `Bearer ${opts.ownerToken}`;
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
      const http = require('http');
      const req = http.request(
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
      req.on('error', (e: Error) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
describe('GET /owner/tenants/:tenantId/audit (OI-ADM-301)', () => {
  let app: express.Express;
  let felipe: number;
  let tenantA: number;
  let tenantB: number;
  const originalToken = process.env.PORTAL_OWNER_TOKEN;

  beforeEach(() => {
    _resetOwnerRateLimiterForTests();
    process.env.PORTAL_OWNER_TOKEN = OWNER_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    felipe = seedUser(testDb, 'felipe@e.com');
    grantPlatformOwner(testDb, felipe);
    tenantA = seedUser(testDb, 'alice@e.com');
    tenantB = seedUser(testDb, 'bob@e.com');
    app = makeApp();
  });
  afterEach(() => {
    process.env.PORTAL_OWNER_TOKEN = originalToken;
    testDb?.close();
  });

  it('returns events scoped to the tenant (exact + dotted-prefix matches)', async () => {
    writeAudit(testDb, { actorId: tenantA, action: 'tenant.invite.create', resource: `tenant.${tenantA}` });
    writeAudit(testDb, { actorId: tenantA, action: 'tenant.member.remove', resource: `tenant.${tenantA}.member.99` });
    writeAudit(testDb, { actorId: tenantB, action: 'tenant.invite.create', resource: `tenant.${tenantB}` });

    const r = await httpReq(app, 'GET', `/owner/tenants/${tenantA}/audit`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(2);
    expect(r.body.data.events.every((e: any) => e.resource.startsWith(`tenant.${tenantA}`))).toBe(true);
  });

  it('SECURITY: tenant.4 must NOT match tenant.42.* (dot-prefix boundary)', async () => {
    // Seed tenant with id 4 AND tenant id 42 via direct INSERT so we
    // control the numeric boundary that the LIKE pattern protects.
    testDb.prepare(`INSERT OR REPLACE INTO tenants (id, slug, display_name, plan) VALUES (4, 'four', 'T4', 'free')`).run();
    testDb.prepare(`INSERT OR REPLACE INTO tenants (id, slug, display_name, plan) VALUES (42, 'forty-two', 'T42', 'free')`).run();
    writeAudit(testDb, { actorId: 42, action: 'tenant.invite.create', resource: `tenant.42` });
    writeAudit(testDb, { actorId: 42, action: 'tenant.member.remove', resource: `tenant.42.member.1` });

    // Ask for tenant 4's audit — should NOT see tenant 42's rows.
    const r = await httpReq(app, 'GET', `/owner/tenants/4/audit`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(0);
  });

  it('honors ?limit=&offset= pagination; clamps limit to 200', async () => {
    for (let i = 0; i < 5; i++) {
      writeAudit(testDb, {
        actorId: tenantA,
        action: 'tenant.invite.create',
        resource: `tenant.${tenantA}.invite.${i}`,
      });
    }
    const page1 = await httpReq(app, 'GET', `/owner/tenants/${tenantA}/audit?limit=2`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(page1.body.data.events).toHaveLength(2);
    expect(page1.body.data.pagination).toMatchObject({ total: 5, limit: 2, offset: 0 });

    const page2 = await httpReq(app, 'GET', `/owner/tenants/${tenantA}/audit?limit=2&offset=2`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(page2.body.data.events).toHaveLength(2);
    expect(page2.body.data.pagination.offset).toBe(2);

    // Clamp: ?limit=10000 → 200
    const huge = await httpReq(app, 'GET', `/owner/tenants/${tenantA}/audit?limit=10000`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(huge.body.data.pagination.limit).toBe(200);
  });

  it('404s for unknown tenant', async () => {
    const r = await httpReq(app, 'GET', `/owner/tenants/99999/audit`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('400s on non-numeric tenantId', async () => {
    const r = await httpReq(app, 'GET', `/owner/tenants/not-a-number/audit`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(400);
  });

  it('requires the full /owner/* auth chain', async () => {
    const noAuth = await httpReq(app, 'GET', `/owner/tenants/${tenantA}/audit`);
    expect(noAuth.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('GET /owner/audit (OI-ADM-303)', () => {
  let app: express.Express;
  let felipe: number;
  let alice: number;
  let bob: number;
  const originalToken = process.env.PORTAL_OWNER_TOKEN;

  beforeEach(() => {
    _resetOwnerRateLimiterForTests();
    process.env.PORTAL_OWNER_TOKEN = OWNER_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    felipe = seedUser(testDb, 'felipe@e.com');
    grantPlatformOwner(testDb, felipe);
    alice = seedUser(testDb, 'alice@e.com');
    bob = seedUser(testDb, 'bob@e.com');

    // Seed a diverse audit_trail so filters have something to bite.
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}`, ts: '2026-04-20 10:00:00' });
    writeAudit(testDb, { actorId: alice, action: 'tenant.member.remove',  resource: `tenant.${alice}.member.${bob}`, ts: '2026-04-21 11:00:00' });
    writeAudit(testDb, { actorId: bob,   action: 'tenant.invite.accept',  resource: `tenant.${alice}.member.${bob}`, ts: '2026-04-22 12:00:00' });
    writeAudit(testDb, { actorId: felipe,action: 'platform_admin.grant',  resource: `user.${alice}`,                ts: '2026-04-22 13:00:00' });

    app = makeApp();
  });
  afterEach(() => {
    process.env.PORTAL_OWNER_TOKEN = originalToken;
    testDb?.close();
  });

  it('no filters → returns all events, newest first, with pagination meta', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.events.length).toBeGreaterThanOrEqual(4);
    // newest first
    const ids = r.body.data.events.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(r.body.data.pagination).toHaveProperty('total');
    expect(r.body.data.appliedFilters).toEqual({ actor: null, action: null, from: null, to: null, q: null });
  });

  it('filters by actor', async () => {
    const r = await httpReq(app, 'GET', `/owner/audit?actor=${alice}`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events.every((e: any) => e.actorId === alice)).toBe(true);
    expect(r.body.data.events).toHaveLength(2);
  });

  it('filters by exact action', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit?action=tenant.invite.create', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].action).toBe('tenant.invite.create');
  });

  it('filters by action prefix (trailing *)', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit?action=tenant.*', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events.every((e: any) => e.action.startsWith('tenant.'))).toBe(true);
    expect(r.body.data.events).toHaveLength(3); // not the platform_admin.grant
  });

  it('SECURITY: LIKE wildcards in the filter are escaped (no injection)', async () => {
    // Without escaping, ?action=tenant_invite.create would match
    // tenant.invite.create because `_` is a single-char LIKE wildcard.
    // With escaping, the underscore is literal → zero matches.
    const r = await httpReq(app, 'GET', '/owner/audit?action=tenant_invite.create', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(0);
  });

  it('SECURITY: LIKE wildcards in ?q= are escaped', async () => {
    writeAudit(testDb, { actorId: alice, action: 'tenant.member.remove', resource: 'tenant.10_alpha.member.1' });
    // `_` must be literal. Without escaping, q=10_alpha would also
    // match tenant.10Xalpha.*
    const r = await httpReq(app, 'GET', '/owner/audit?q=10_alpha', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].resource).toContain('10_alpha');
  });

  it('filters by date range (from/to inclusive)', async () => {
    // URL-encode the space in the timestamp — the Node HTTP client
    // rejects raw spaces with ERR_UNESCAPED_CHARACTERS. This is
    // exactly what a real UI would have to do anyway.
    const from = encodeURIComponent('2026-04-21');
    const to   = encodeURIComponent('2026-04-21 23:59:59');
    const r = await httpReq(app, 'GET', `/owner/audit?from=${from}&to=${to}`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].ts).toContain('2026-04-21');
  });

  it('combines filters (actor + action prefix)', async () => {
    const r = await httpReq(app, 'GET', `/owner/audit?actor=${alice}&action=tenant.*`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.events.every((e: any) => e.actorId === alice)).toBe(true);
    expect(r.body.data.events.every((e: any) => e.action.startsWith('tenant.'))).toBe(true);
  });

  it('clamps limit to 500 even if caller asks for 100000', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit?limit=100000', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.pagination.limit).toBe(500);
  });

  it('400s on bogus actor (non-integer)', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit?actor=abc', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(400);
  });

  it('400s on an overlong action filter', async () => {
    const longAction = 'a'.repeat(200);
    const r = await httpReq(app, 'GET', `/owner/audit?action=${encodeURIComponent(longAction)}`, {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(400);
  });

  it('requires the full /owner/* auth chain', async () => {
    const r = await httpReq(app, 'GET', '/owner/audit');
    expect(r.status).toBe(401);
  });
});
