// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Validation / hardening tests added on branch
 * `hardening/nexus-hub-owner-workspace-validation` (2026-04-22).
 *
 * These cover validation fix #3: `/workspace/*` mutation routes
 * (member removal, invite create / revoke / accept) now write
 * rows to `audit_trail` with:
 *
 *   - actor_id = the authenticated iOS user
 *   - action   = tenant.{member.remove | invite.create | invite.revoke | invite.accept}
 *   - resource = the tenant scope (e.g. tenant:<id>)
 *   - details  = JSON blob WITHOUT the raw invite_code
 *                (so an audit-log leak cannot hand someone a live invite)
 *
 * Prior to this fix tenant-plane mutations were silent — a malicious
 * admin could remove members / revoke invites without leaving a trail.
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


// OI-UX-106 rebase cleanup: prevent this file's vi.mock('services/database')
// from polluting later test files in the shared vitest fork (the project's
// vitest.config.ts sets `poolOptions.forks.singleFork: true`, which runs every
// test file in one process and keeps module mocks alive across files unless
// explicitly cleared). doUnmock + resetModules together mark the mock inert
// AND flush the cached version, so the next file's `import { getDb }` hits
// either its own mock or the real module.
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

// Re-use the same lightweight auth stub used by the other workspace tests
// — we're testing the audit side-effect, not JWT verification.
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

function addMember(db: Database.Database, tenantId: number, userId: number, role = 'tenant_member'): void {
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)`)
    .run(tenantId, userId, role);
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

interface AuditRow {
  user_id: number;
  actor_id: number;
  action: string;
  resource: string;
  details: string | null;
}

function auditRows(action?: string): AuditRow[] {
  const q = action
    ? testDb.prepare('SELECT user_id, actor_id, action, resource, details FROM audit_trail WHERE action = ? ORDER BY id')
    : testDb.prepare('SELECT user_id, actor_id, action, resource, details FROM audit_trail ORDER BY id');
  return (action ? q.all(action) : q.all()) as AuditRow[];
}

describe('/workspace/* — audit trail (validation fix 3)', () => {
  let app: express.Express;
  let alice: number;   // tenant_admin / tenant owner
  let bob: number;     // tenant_member to be removed
  let carol: number;   // invitee
  const carolEmail = 'carol@e.com';

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-audit@e.com');
    bob = seedUser(testDb, 'bob-audit@e.com');
    carol = seedUser(testDb, carolEmail);
    addMember(testDb, alice, bob, 'tenant_member');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('removeMember writes a tenant.member.remove audit row', async () => {
    const r = await req(app, 'DELETE', `/workspace/members/${bob}`, {
      userId: alice,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    const rows = auditRows('tenant.member.remove');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(alice);
    expect(rows[0].user_id).toBe(alice);
    expect(rows[0].resource).toContain(String(alice));
    // Details mentions the removed user id.
    expect(rows[0].details).toContain(String(bob));
  });

  it('createInvite writes tenant.invite.create — WITHOUT the raw invite_code', async () => {
    const create = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      tenantId: String(alice),
      body: { email: carolEmail, role: 'tenant_member' },
    });
    expect(create.status).toBe(201);
    const code: string = create.body.data.invite.invite_code || create.body.data.invite.inviteCode;
    expect(code?.length).toBeGreaterThan(16);

    const rows = auditRows('tenant.invite.create');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(alice);
    // CRITICAL: the details blob MUST NOT contain the raw invite code,
    // otherwise anyone with audit-log read could accept the invite.
    expect(rows[0].details).not.toContain(code);
    // But it SHOULD carry metadata useful for forensics.
    expect(rows[0].details).toContain(carolEmail);
  });

  it('revokeInvite writes tenant.invite.revoke', async () => {
    const create = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      tenantId: String(alice),
      body: { email: carolEmail, role: 'tenant_member' },
    });
    const inviteId: number = create.body.data.invite.id;
    const del = await req(app, 'DELETE', `/workspace/invites/${inviteId}`, {
      userId: alice,
      tenantId: String(alice),
    });
    expect(del.status).toBe(200);

    const rows = auditRows('tenant.invite.revoke');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(alice);
    expect(rows[0].details).toContain(String(inviteId));
  });

  it('acceptInvite writes tenant.invite.accept with acceptor as actor', async () => {
    const create = await req(app, 'POST', '/workspace/invites', {
      userId: alice,
      tenantId: String(alice),
      body: { email: carolEmail, role: 'tenant_member' },
    });
    const code: string = create.body.data.invite.invite_code || create.body.data.invite.inviteCode;

    const accept = await req(app, 'POST', `/workspace/my-invites/${code}/accept`, {
      userId: carol,
    });
    expect(accept.status).toBe(200);

    const rows = auditRows('tenant.invite.accept');
    expect(rows).toHaveLength(1);
    // actor is Carol (the acceptor), NOT Alice (the inviter).
    expect(rows[0].actor_id).toBe(carol);
    expect(rows[0].resource).toContain(String(alice)); // target tenant
  });

  it('a best-effort audit failure does not break the mutation (no 500)', async () => {
    // Drop audit_trail to simulate a schema issue; the writeWorkspaceAudit
    // helper is wrapped in try/catch so the mutation should still succeed
    // rather than cascading into a user-facing 500.
    testDb.exec('DROP TABLE audit_trail');
    const r = await req(app, 'DELETE', `/workspace/members/${bob}`, {
      userId: alice,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
  });
});
