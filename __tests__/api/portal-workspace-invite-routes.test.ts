// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * End-to-end tests for the multi-tenant invite flow in
 * /workspace/invites + /workspace/my-invites.
 *
 * Pins:
 *   - POST /workspace/invites requires tenant_admin role; returns
 *     the invite with invite_code.
 *   - POST /workspace/invites rejects bad email and bad role.
 *   - DELETE /workspace/invites/:id is tenant-scoped (rejects
 *     cross-tenant revoke attempts with 404 rather than 403 —
 *     existence non-leakage).
 *   - GET /workspace/my-invites lists only invites addressed to
 *     the caller's email (regardless of active tenant).
 *   - POST /workspace/my-invites/:code/accept rejects on
 *     email mismatch with 403 EMAIL_MISMATCH.
 *   - Successful accept creates membership; subsequent
 *     GET /workspace/tenants returns both tenants.
 *   - Double-accept returns 409 ALREADY_ACCEPTED.
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

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// Same pattern as portal-workspace-router.test.ts: stub auth-middleware
// to skip the full iOS JWT DB chain; we're testing the invite permission
// surface, not JWT verification.
vi.mock('../../src/api/auth-middleware', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const auth: string | undefined = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' }, timestamp: new Date().toISOString() });
    }
    const raw = auth.slice(7);
    try {
      const payload = require('jsonwebtoken').verify(raw, TEST_JWT_SECRET);
      req.userId = payload.userId;
      req.deviceId = payload.deviceId;
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

function seedUser(db: Database.Database, email: string, tier = 'free'): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(email, tier);
  const uid = Number(r.lastInsertRowid);
  db.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, ?)`,
  ).run(uid, `user-${uid}`, email, tier);
  db.prepare(
    `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
  ).run(uid, uid);
  return uid;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
      const request = http.request(
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
      request.on('error', (e: Error) => { server.close(); reject(e); });
      if (body) request.write(body);
      request.end();
    });
  });
}

describe('/workspace/invites — admin side', () => {
  let app: express.Express;
  let alice: number;
  let aliceEmail = 'alice@e.com';
  let bobEmail = 'bob@e.com';

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, aliceEmail);
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('POST /invites requires tenant_admin — returns 201 + invite_code', async () => {
    const r = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      body: { email: bobEmail, role: 'tenant_member' },
    });
    expect(r.status).toBe(201);
    expect(r.body.data.invite.status).toBe('pending');
    expect(r.body.data.invite.email).toBe(bobEmail);
    expect(r.body.data.invite.inviteCode).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('POST /invites rejects malformed email (400)', async () => {
    const r = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      body: { email: 'not-an-email', role: 'tenant_member' },
    });
    expect(r.status).toBe(400);
  });

  it('POST /invites rejects bad role (400)', async () => {
    const r = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      body: { email: bobEmail, role: 'platform_owner' },
    });
    expect(r.status).toBe(400);
  });

  it('POST /invites returns 409 DUPLICATE_PENDING on a second pending invite', async () => {
    await req(app, 'POST', '/workspace/invites', { userId: alice, body: { email: bobEmail } });
    const r = await req(app, 'POST', '/workspace/invites', { userId: alice, body: { email: bobEmail } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_PENDING');
  });

  it('POST /invites rejects a tenant_member caller (not tenant_admin) with 403', async () => {
    const viewer = seedUser(testDb, 'viewer@e.com');
    // Demote viewer to tenant_member of alice's tenant.
    testDb.prepare(
      `INSERT OR REPLACE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(alice, viewer);
    const r = await req(app, 'POST', '/workspace/invites', {
      userId: viewer, tenantId: String(alice),
      body: { email: 'newperson@e.com', role: 'tenant_member' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_TENANT_ROLE');
  });

  it('GET /invites returns only the active tenant\'s invites (no cross-tenant)', async () => {
    const bob = seedUser(testDb, bobEmail);
    await req(app, 'POST', '/workspace/invites', { userId: alice, body: { email: 'guest-a@e.com' } });
    await req(app, 'POST', '/workspace/invites', { userId: bob, body: { email: 'guest-b@e.com' } });

    const aliceList = await req(app, 'GET', '/workspace/invites', { userId: alice });
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.data.invites.map((i: any) => i.email)).toEqual(['guest-a@e.com']);
    // Verify explicitly: no guest-b.
    expect(aliceList.body.data.invites.map((i: any) => i.email)).not.toContain('guest-b@e.com');
  });

  it('DELETE /invites/:id revokes a pending invite (tenant_admin)', async () => {
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: 'revoke-test@e.com' },
    });
    const inviteId = created.body.data.invite.id;

    const r = await req(app, 'DELETE', `/workspace/invites/${inviteId}`, { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.invite.status).toBe('revoked');
  });

  it('DELETE /invites/:id on another tenant\'s invite returns 404 (existence non-leakage)', async () => {
    const bob = seedUser(testDb, bobEmail);
    const bobInvite = await req(app, 'POST', '/workspace/invites', {
      userId: bob, body: { email: 'guest-on-bobs-tenant@e.com' },
    });
    const bobInviteId = bobInvite.body.data.invite.id;

    // Alice (admin of HER tenant) tries to revoke Bob's invite.
    const r = await req(app, 'DELETE', `/workspace/invites/${bobInviteId}`, { userId: alice });
    // 404, not 403: we don't leak whether the invite exists.
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('/workspace/my-invites — invitee side', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;
  const bobEmail = 'bob-inv@e.com';

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-inv@e.com');
    bob = seedUser(testDb, bobEmail);
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('GET /my-invites lists invites addressed to me (not others)', async () => {
    await req(app, 'POST', '/workspace/invites', { userId: alice, body: { email: bobEmail } });
    await req(app, 'POST', '/workspace/invites', { userId: alice, body: { email: 'someone-else@e.com' } });

    const r = await req(app, 'GET', '/workspace/my-invites', { userId: bob });
    expect(r.status).toBe(200);
    expect(r.body.data.email).toBe(bobEmail);
    expect(r.body.data.invites).toHaveLength(1);
    expect(r.body.data.invites[0].email).toBe(bobEmail);
    // Should be decorated with the tenant reference.
    expect(r.body.data.invites[0].tenant).toMatchObject({ id: alice, slug: `user-${alice}` });
  });

  it('POST /my-invites/:code/accept creates membership + marks accepted', async () => {
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: bobEmail, role: 'tenant_member' },
    });
    const code = created.body.data.invite.inviteCode;

    const accept = await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });
    expect(accept.status).toBe(200);
    expect(accept.body.data.invite.status).toBe('accepted');
    expect(accept.body.data.tenantId).toBe(alice);
    expect(accept.body.data.role).toBe('tenant_member');

    // Bob's /workspace/tenants now lists BOTH tenants.
    const tenants = await req(app, 'GET', '/workspace/tenants', { userId: bob });
    const ids = tenants.body.data.tenants.map((t: any) => t.tenant.id);
    expect(ids).toEqual(expect.arrayContaining([alice, bob]));
  });

  it('accept rejects with 403 EMAIL_MISMATCH when invite is for a different email', async () => {
    // Alice invites someone-else@e.com; Bob tries to accept.
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: 'someone-else@e.com' },
    });
    const code = created.body.data.invite.inviteCode;

    const r = await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMAIL_MISMATCH');
  });

  it('accept rejects with 404 NOT_FOUND on bogus code', async () => {
    const r = await req(app, 'POST', '/workspace/my-invites/bogus-16-chars-long-enough/accept', { userId: bob });
    expect(r.status).toBe(404);
  });

  it('double-accept returns 409 ALREADY_ACCEPTED', async () => {
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: bobEmail },
    });
    const code = created.body.data.invite.inviteCode;

    await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });
    const second = await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_ACCEPTED');
  });

  it('after accept, Bob can read Alice\'s tenant via X-Tenant-Id without 403', async () => {
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: bobEmail, role: 'tenant_member' },
    });
    const code = created.body.data.invite.inviteCode;
    await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });

    // Bob switches to Alice's tenant via X-Tenant-Id.
    const r = await req(app, 'GET', '/workspace/me', { userId: bob, tenantId: String(alice) });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.id).toBe(alice);
    expect(r.body.data.role).toBe('tenant_member');
  });

  it('after accept as tenant_member, Bob CANNOT access /workspace/members (admin-only)', async () => {
    const created = await req(app, 'POST', '/workspace/invites', {
      userId: alice, body: { email: bobEmail, role: 'tenant_member' },
    });
    const code = created.body.data.invite.inviteCode;
    await req(app, 'POST', `/workspace/my-invites/${code}/accept`, { userId: bob });

    const r = await req(app, 'GET', '/workspace/members', { userId: bob, tenantId: String(alice) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_TENANT_ROLE');
  });
});
