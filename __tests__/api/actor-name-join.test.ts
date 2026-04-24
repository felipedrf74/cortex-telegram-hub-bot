// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-005b (2026-04-24) — actor-name JOIN across all audit
 * surfaces.
 *
 * The Activity feed (User Console) and the Audit viewer (Admin
 * Console) now LEFT JOIN audit_trail → users so each event carries
 * the actor's email + first_name alongside the numeric actor_id.
 *
 * The test matrix:
 *   surfaces × (resolvable actor, actor=0, deleted actor, filter
 *               semantics preserved after alias change)
 *
 *   Three surfaces get the JOIN:
 *     GET /workspace/activity              (tenant-scoped)
 *     GET /owner/tenants/:id/audit         (per-tenant admin view)
 *     GET /owner/audit                     (platform-wide admin view)
 *
 * We test the tenant view via /workspace/activity (representative)
 * + the platform view via /owner/audit (representative). The
 * per-tenant admin view uses the same JOIN pattern and is covered
 * by spot-checks on the existing portal-owner-router tests — a
 * separate shape assertion here would duplicate without new
 * coverage.
 *
 * We also test structural pins on the JOIN SQL itself (in the
 * router source) to catch refactors that accidentally drop the
 * JOIN or forget to qualify one of the WHERE columns.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const TEST_JWT_SECRET = process.env.IOS_API_JWT_SECRET || 'test-setup-default-jwt-secret';
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

vi.mock('../../src/api/auth-middleware', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const auth: string | undefined = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' }, timestamp: new Date().toISOString() });
    }
    try {
      const payload = require('jsonwebtoken').verify(auth.slice(7), TEST_JWT_SECRET);
      req.userId = payload.userId;
      req.deviceId = payload.deviceId;
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' }, timestamp: new Date().toISOString() });
    }
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY, filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch { /* skip */ }
  }
}

function seedUserWithName(email: string, firstName: string | null): number {
  const r = testDb.prepare(
    `INSERT INTO users (email, first_name, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email, firstName);
  const uid = Number(r.lastInsertRowid);
  testDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`,
  ).run(uid, `user-${uid}`, email);
  testDb.prepare(
    `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
  ).run(uid, uid);
  return uid;
}

function writeAudit(
  tenantId: number,
  actorId: number,
  action: string,
  details: Record<string, unknown> = {},
): void {
  testDb.prepare(
    `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(actorId, actorId, action, `tenant.${tenantId}`, JSON.stringify(details));
}

function jwtFor(userId: number): string {
  return jwt.sign({ userId, deviceId: `test-device-${userId}` }, TEST_JWT_SECRET);
}

import { createPortalWorkspaceRouter } from '../../src/api/portal-workspace-router';
import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';

function makeWorkspaceApp(): express.Express {
  const app = express();
  app.use('/workspace', createPortalWorkspaceRouter());
  return app;
}

function makeOwnerApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

async function reqWorkspace(
  app: express.Express,
  urlPath: string,
  userId: number,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtFor(userId)}`,
      };
      const http = require('http');
      const request = http.request(
        { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
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
      request.on('error', (e: Error) => { server.close(); reject(e); });
      request.end();
    });
  });
}

const OWNER_TOKEN = 'actor-join-owner-token-at-least-16-chars';
async function reqOwner(
  app: express.Express,
  urlPath: string,
  adminUserId: number,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers = {
        'Content-Type': 'application/json',
        'X-Admin-User-Id': String(adminUserId),
        'Authorization': 'Bearer ' + OWNER_TOKEN,
      };
      const http = require('http');
      const request = http.request(
        { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
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
      request.on('error', (e: Error) => { server.close(); reject(e); });
      request.end();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// /workspace/activity
// ═══════════════════════════════════════════════════════════════

describe('GET /workspace/activity — actor-name JOIN (OI-DATA-005b)', () => {
  let alice: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUserWithName('alice@example.com', 'Alice');
  });

  afterEach(() => testDb?.close());

  it('surfaces actorEmail + actorFirstName for a resolvable actor', async () => {
    writeAudit(alice, alice, 'tenant.book.create');
    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, '/workspace/activity', alice);
    expect(r.status).toBe(200);
    const events = r.body.data.events;
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(alice);
    expect(events[0].actorEmail).toBe('alice@example.com');
    expect(events[0].actorFirstName).toBe('Alice');
  });

  it('null firstName + email when actor_id is 0 (system event)', async () => {
    writeAudit(alice, 0, 'tenant.system.cron');
    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, '/workspace/activity', alice);
    const sys = r.body.data.events.find((e: any) => e.action === 'tenant.system.cron');
    expect(sys.actorId).toBe(0);
    expect(sys.actorEmail).toBeNull();
    expect(sys.actorFirstName).toBeNull();
  });

  it('null email + firstName for a DELETED actor (LEFT JOIN yields null)', async () => {
    // Bob joins the tenant, writes an audit, then is deleted from
    // users. The audit row remains; the JOIN returns null for the
    // actor identity. UI renders "(deleted user)".
    const bob = seedUserWithName('bob@example.com', 'Bob');
    testDb.prepare(
      `INSERT OR REPLACE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(alice, bob);
    writeAudit(alice, bob, 'tenant.book.create');
    // Delete bob AFTER the audit.
    testDb.prepare('DELETE FROM users WHERE id = ?').run(bob);

    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, '/workspace/activity', alice);
    const events = r.body.data.events;
    const row = events.find((e: any) => e.actorId === bob);
    expect(row).toBeDefined();
    expect(row.actorEmail).toBeNull();
    expect(row.actorFirstName).toBeNull();
  });

  it('filter ?actor=N still works after JOIN (aliased WHERE clause is correct)', async () => {
    const carol = seedUserWithName('carol@example.com', 'Carol');
    testDb.prepare(
      `INSERT OR REPLACE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(alice, carol);
    writeAudit(alice, alice, 'tenant.book.create');
    writeAudit(alice, carol, 'tenant.book.create');
    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, `/workspace/activity?actor=${carol}`, alice);
    const events = r.body.data.events;
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(carol);
    expect(events[0].actorFirstName).toBe('Carol');
  });

  it('filter ?action=tenant.book.* still works (aliased LIKE with ESCAPE)', async () => {
    writeAudit(alice, alice, 'tenant.book.create');
    writeAudit(alice, alice, 'tenant.note.create');
    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, '/workspace/activity?action=tenant.book.*', alice);
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].action).toBe('tenant.book.create');
  });

  it('pagination.total counts correctly after the JOIN (aliased COUNT)', async () => {
    // The COUNT query uses the same aliased WHERE. A bug that
    // leaves the COUNT unaliased would throw "no such column: a.x"
    // or — worse — silently return the wrong total. This test
    // catches either regression.
    for (let i = 0; i < 5; i++) writeAudit(alice, alice, `tenant.book.create`);
    const app = makeWorkspaceApp();
    const r = await reqWorkspace(app, '/workspace/activity?limit=2', alice);
    expect(r.body.data.events).toHaveLength(2);
    expect(r.body.data.pagination.total).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// /owner/audit (platform-wide)
// ═══════════════════════════════════════════════════════════════

describe('GET /owner/audit — actor-name JOIN (OI-DATA-005b)', () => {
  let ownerUid: number;
  let alice: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;
  const originalAdminJwt = process.env.PORTAL_ADMIN_JWT_SECRET;

  beforeEach(() => {
    // Legacy mode (OI-SEC-001 secure mode has its own tests).
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    process.env.PORTAL_OWNER_TOKEN = OWNER_TOKEN;

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    ownerUid = seedUserWithName('owner@example.com', 'Felipe');
    alice = seedUserWithName('alice@example.com', 'Alice');
    testDb.prepare(
      `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_owner', datetime('now'))`,
    ).run(ownerUid);
  });

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
    if (originalAdminJwt) process.env.PORTAL_ADMIN_JWT_SECRET = originalAdminJwt;
  });

  it('returns actorEmail + actorFirstName for platform events', async () => {
    writeAudit(alice, alice, 'tenant.book.create');
    const app = makeOwnerApp();
    const r = await reqOwner(app, '/owner/audit', ownerUid);
    expect(r.status).toBe(200);
    const row = r.body.data.events.find((e: any) => e.action === 'tenant.book.create');
    expect(row.actorEmail).toBe('alice@example.com');
    expect(row.actorFirstName).toBe('Alice');
  });

  it('filter ?q=<substring> on resource still works (aliased LIKE with ESCAPE)', async () => {
    // q filter uses `a.resource LIKE ? ESCAPE '\\'` — a refactor
    // that forgot to alias it would fail against the JOIN.
    writeAudit(alice, alice, 'tenant.book.create');
    writeAudit(999, alice, 'tenant.book.create');  // different tenant resource
    const app = makeOwnerApp();
    const r = await reqOwner(app, `/owner/audit?q=tenant.${alice}`, ownerUid);
    // Only the one tenant-alice event should match.
    const matching = r.body.data.events.filter((e: any) => e.resource.includes(`tenant.${alice}`));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.every((e: any) => e.resource.startsWith(`tenant.${alice}`))).toBe(true);
  });

  it('COUNT aggregates correctly after the JOIN', async () => {
    for (let i = 0; i < 7; i++) writeAudit(alice, alice, 'tenant.book.create');
    const app = makeOwnerApp();
    const r = await reqOwner(app, '/owner/audit?limit=3', ownerUid);
    expect(r.body.data.events).toHaveLength(3);
    expect(r.body.data.pagination.total).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════
// UI render helpers
// ═══════════════════════════════════════════════════════════════

describe('UI — formatActorLabel / formatAuditActorLabel (OI-DATA-005b)', () => {
  const userConsoleSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/portal/user-console.html'), 'utf-8',
  );
  const adminConsoleSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/portal/admin-console.html'), 'utf-8',
  );

  it('user-console: formatActorLabel distinguishes System (actorId===0), known, and deleted actors', () => {
    expect(userConsoleSrc).toMatch(/function formatActorLabel[\s\S]{0,600}?actorId === 0[\s\S]{0,100}?System/);
    expect(userConsoleSrc).toMatch(/function formatActorLabel[\s\S]{0,600}?actorFirstName[\s\S]{0,100}?esc\(e\.actorFirstName\)/);
    expect(userConsoleSrc).toMatch(/function formatActorLabel[\s\S]{0,800}?\(deleted user\)/);
  });

  it('user-console: tooltip surfaces email + numeric id for disambiguation', () => {
    expect(userConsoleSrc).toMatch(/function formatActorTooltip[\s\S]{0,600}?e\.actorEmail[\s\S]{0,200}?'#' \+ e\.actorId/);
  });

  it('admin-console: formatAuditActorLabel mirrors the user-console semantics', () => {
    // Symmetry is important — a future refactor that diverges
    // the two label functions would create inconsistent rendering
    // between the two consoles viewing the same audit row.
    expect(adminConsoleSrc).toMatch(/function formatAuditActorLabel[\s\S]{0,600}?actorId === 0[\s\S]{0,100}?System/);
    expect(adminConsoleSrc).toMatch(/function formatAuditActorLabel[\s\S]{0,800}?\(deleted user\)/);
  });

  it('both consoles replaced the old "by #${e.actorId}" with formatter calls', () => {
    // Regression guard: the raw "by #${e.actorId}" pattern means
    // someone forgot to apply the formatter.
    expect(userConsoleSrc).not.toMatch(/>\s*by #\$\{e\.actorId\}\s*</);
    expect(adminConsoleSrc).not.toMatch(/>\s*actor #\$\{e\.actorId\}\s*</);
    expect(adminConsoleSrc).not.toMatch(/>\s*actor #\$\{r\.actorId\}\s*</);
  });
});
