// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for /workspace/activity (OI-DATA-005,
 * branch feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22).
 *
 * Pins:
 *   - SECURITY: tenant-scoped via dot-prefix (tenant 4 can't see
 *     tenant 42's events). Same boundary check as OI-ADM-301.
 *   - tenant_viewer has READ access (events are about shared state).
 *   - auth required; cross-tenant via X-Tenant-Id rejected (403).
 *   - filters: actor, action (exact + prefix), from/to, pagination.
 *   - LIKE-wildcard escape on action + length cap (shared pattern
 *     with OI-ADM-303; re-pinned because it's a new route).
 *   - DELETE of books / notes / links / channels writes audit rows
 *     that land in the feed (OI-DATA-005 side-effect pin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const TEST_JWT_SECRET = process.env.IOS_API_JWT_SECRET || 'test-setup-default-jwt-secret';

let testDb: Database.Database;

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
      const p = require('jsonwebtoken').verify(auth.slice(7), TEST_JWT_SECRET);
      req.userId = p.userId;
      req.deviceId = p.deviceId;
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' }, timestamp: new Date().toISOString() });
    }
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
function addMember(db: Database.Database, tenantId: number, userId: number, role: string): void {
  db.prepare('INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)')
    .run(tenantId, userId, role);
}
function writeAudit(
  db: Database.Database,
  opts: { actorId: number; action: string; resource: string; details?: Record<string, unknown>; ts?: string },
): void {
  db.prepare(
    `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    opts.actorId, opts.actorId, opts.action, opts.resource,
    opts.details ? JSON.stringify(opts.details) : null,
    opts.ts ?? null,
  );
}
function jwtFor(userId: number): string {
  return jwt.sign({ userId, deviceId: `test-device-${userId}` }, TEST_JWT_SECRET);
}

import { createPortalWorkspaceRouter } from '../../src/api/portal-workspace-router';

function makeApp(): express.Express {
  const app = express();
  app.use('/workspace', createPortalWorkspaceRouter());
  return app;
}

async function req(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
  opts: { userId?: number; tenantId?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.userId !== undefined) headers['Authorization'] = `Bearer ${jwtFor(opts.userId)}`;
      if (opts.tenantId !== undefined) headers['X-Tenant-Id'] = opts.tenantId;
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

describe('GET /workspace/activity — tenant audit feed (OI-DATA-005)', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    bob = seedUser(testDb, 'bob@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('empty tenant → empty feed with pagination meta', async () => {
    const r = await req(app, 'GET', '/workspace/activity', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toEqual([]);
    expect(r.body.data.tenantId).toBe(alice);
    expect(r.body.data.pagination).toMatchObject({ total: 0, limit: 100, offset: 0 });
  });

  it('requires authentication', async () => {
    const r = await req(app, 'GET', '/workspace/activity');
    expect(r.status).toBe(401);
  });

  it('returns tenant-scoped events (exact + dotted prefix)', async () => {
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    writeAudit(testDb, { actorId: alice, action: 'tenant.member.remove', resource: `tenant.${alice}.member.99` });
    // One for Bob's tenant — must NOT leak.
    writeAudit(testDb, { actorId: bob, action: 'tenant.invite.create', resource: `tenant.${bob}` });

    const r = await req(app, 'GET', '/workspace/activity', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(2);
    expect(r.body.data.events.every((e: any) => e.resource.startsWith(`tenant.${alice}`))).toBe(true);
  });

  it('SECURITY: tenant.4 does NOT match tenant.42.* (dot-prefix boundary, same as OI-ADM-301 pin)', async () => {
    // Force specific tenant ids so the numeric boundary is exercised.
    testDb.prepare(`INSERT OR REPLACE INTO tenants (id, slug, display_name, plan) VALUES (4, 'four', 'T4', 'free')`).run();
    testDb.prepare(`INSERT OR REPLACE INTO tenants (id, slug, display_name, plan) VALUES (42, 'forty-two', 'T42', 'free')`).run();
    testDb.prepare(`INSERT OR REPLACE INTO users (id, email, tier, email_verified, status, auth_provider) VALUES (4, 'u4@e.com', 'free', 1, 'active', 'email')`).run();
    testDb.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (4, 4, 'tenant_admin')`).run();
    writeAudit(testDb, { actorId: 42, action: 'tenant.member.remove', resource: 'tenant.42.member.1' });
    writeAudit(testDb, { actorId: 42, action: 'tenant.invite.create', resource: 'tenant.42' });

    const r = await req(app, 'GET', '/workspace/activity', { userId: 4 });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(0);
  });

  it('tenant_viewer CAN read the feed (shared-state visibility)', async () => {
    const viewer = seedUser(testDb, 'viewer@e.com');
    addMember(testDb, alice, viewer, 'tenant_viewer');
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });

    const r = await req(app, 'GET', '/workspace/activity', { userId: viewer, tenantId: String(alice) });
    expect(r.status).toBe(200);
    expect(r.body.data.events).toHaveLength(1);
  });

  it('rejects cross-tenant access via X-Tenant-Id (guard from tenant-context-middleware)', async () => {
    // Alice tries to read Bob's tenant's activity — she's not a member.
    writeAudit(testDb, { actorId: bob, action: 'tenant.invite.create', resource: `tenant.${bob}` });
    const r = await req(app, 'GET', '/workspace/activity', {
      userId: alice, tenantId: String(bob),
    });
    expect(r.status).toBe(403);
  });

  it('filters by actor', async () => {
    const member = seedUser(testDb, 'member@e.com');
    addMember(testDb, alice, member, 'tenant_member');
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    writeAudit(testDb, { actorId: member, action: 'tenant.book.delete', resource: `tenant.${alice}.book.1` });

    const r = await req(app, 'GET', `/workspace/activity?actor=${alice}`, { userId: alice });
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].actorId).toBe(alice);
  });

  it('filters by action prefix (trailing *)', async () => {
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.revoke', resource: `tenant.${alice}` });
    writeAudit(testDb, { actorId: alice, action: 'tenant.member.remove', resource: `tenant.${alice}.member.1` });

    const r = await req(app, 'GET', '/workspace/activity?action=tenant.invite.*', { userId: alice });
    expect(r.body.data.events).toHaveLength(2);
    expect(r.body.data.events.every((e: any) => e.action.startsWith('tenant.invite.'))).toBe(true);
  });

  it('SECURITY: LIKE-wildcards in action filter are escaped', async () => {
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    // `?action=tenant_invite.create` would match `tenant.invite.create`
    // if `_` were not escaped.
    const r = await req(app, 'GET', '/workspace/activity?action=tenant_invite.create', { userId: alice });
    expect(r.body.data.events).toHaveLength(0);
  });

  it('SECURITY: overlong action filter rejected with 400', async () => {
    const longAction = 'a'.repeat(200);
    const r = await req(app, 'GET', `/workspace/activity?action=${encodeURIComponent(longAction)}`, { userId: alice });
    expect(r.status).toBe(400);
  });

  it('filters by date range (from/to inclusive)', async () => {
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}`, ts: '2026-04-20 10:00:00' });
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.revoke', resource: `tenant.${alice}`, ts: '2026-04-22 12:00:00' });

    const from = encodeURIComponent('2026-04-22');
    const to = encodeURIComponent('2026-04-22 23:59:59');
    const r = await req(app, 'GET', `/workspace/activity?from=${from}&to=${to}`, { userId: alice });
    expect(r.body.data.events).toHaveLength(1);
    expect(r.body.data.events[0].action).toBe('tenant.invite.revoke');
  });

  it('clamps limit to 200', async () => {
    const r = await req(app, 'GET', '/workspace/activity?limit=10000', { userId: alice });
    expect(r.body.data.pagination.limit).toBe(200);
  });

  it('pagination offset works', async () => {
    for (let i = 0; i < 5; i++) {
      writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    }
    const p1 = await req(app, 'GET', '/workspace/activity?limit=2', { userId: alice });
    expect(p1.body.data.events).toHaveLength(2);
    const p2 = await req(app, 'GET', '/workspace/activity?limit=2&offset=2', { userId: alice });
    expect(p2.body.data.events).toHaveLength(2);
    expect(p1.body.data.events[0].id).not.toBe(p2.body.data.events[0].id);
  });

  it('cost-privacy: no costUsd / cost_usd / dollar amount in payload', async () => {
    testDb.prepare(
      `INSERT INTO api_usage (user_id, ts, category, model, cost_usd)
       VALUES (?, datetime('now'), 'chat', 'gemini', 9.99)`,
    ).run(alice);
    writeAudit(testDb, { actorId: alice, action: 'tenant.invite.create', resource: `tenant.${alice}` });
    const r = await req(app, 'GET', '/workspace/activity', { userId: alice });
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toMatch(/costUsd/i);
    expect(serialized).not.toMatch(/cost_usd/i);
    expect(serialized).not.toMatch(/9\.99/);
  });

  it('DELETE of a book writes tenant.book.delete to audit + shows up in the feed', async () => {
    // Create a book via the real route, then delete it.
    const create = await req(app, 'POST', '/workspace/books', {
      userId: alice, tenantId: String(alice),
      body: { title: 'Atomic Habits', author: 'James Clear' },
    });
    const id = create.body.data.book.id;
    await req(app, 'DELETE', `/workspace/books/${id}`, { userId: alice, tenantId: String(alice) });

    const activity = await req(app, 'GET', '/workspace/activity?action=tenant.book.delete', { userId: alice });
    expect(activity.body.data.events).toHaveLength(1);
    const ev = activity.body.data.events[0];
    expect(ev.resource).toBe(`tenant.${alice}.book.${id}`);
    // details should carry title for human-readable display.
    const details = JSON.parse(ev.details);
    expect(details.title).toBe('Atomic Habits');
    expect(details.bookId).toBe(id);
  });

  it('DELETE of a note / link / channel each writes its audit action', async () => {
    // Note
    const note = await req(app, 'POST', '/workspace/content', {
      userId: alice, tenantId: String(alice), body: { title: 'n', body: 'b' },
    });
    await req(app, 'DELETE', `/workspace/content/${note.body.data.note.id}`, {
      userId: alice, tenantId: String(alice),
    });
    // Link
    const link = await req(app, 'POST', '/workspace/links', {
      userId: alice, tenantId: String(alice), body: { url: 'https://example.com/' },
    });
    await req(app, 'DELETE', `/workspace/links/${link.body.data.link.id}`, {
      userId: alice, tenantId: String(alice),
    });
    // Channel
    const ch = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'Chan' },
    });
    await req(app, 'DELETE', `/workspace/channels/${ch.body.data.channel.id}`, {
      userId: alice, tenantId: String(alice),
    });

    const r = await req(app, 'GET', '/workspace/activity', { userId: alice });
    const actions = r.body.data.events.map((e: any) => e.action).sort();
    expect(actions).toContain('tenant.note.delete');
    expect(actions).toContain('tenant.link.delete');
    expect(actions).toContain('tenant.channel.delete');
  });
});
