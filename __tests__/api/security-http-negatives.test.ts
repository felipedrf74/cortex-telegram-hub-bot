// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-TEST-001/002/003 (2026-04-24) — HTTP-level negative-case pins
 * for security boundaries. Each boundary has a service-layer guard
 * already in place AND a service-level unit test; this file is the
 * "belt and suspenders" that locks down the HTTP wrapping so a
 * future refactor can't silently relax the behavior at the HTTP
 * boundary (wrong status code, wrong error shape, or forgetting to
 * propagate the service error at all).
 *
 * What's pinned:
 *
 *   OI-TEST-001 — cross-tenant resource DELETE returns 404 (never
 *   leaks existence via 403). Covers books + content + links. The
 *   existing portal-workspace-channels-routes.test.ts pins this for
 *   channels; this file brings books/content/links up to parity.
 *
 *   OI-TEST-002 — reachable-via-HTTP case is CANNOT_REMOVE_SELF
 *   (400). The CANNOT_REMOVE_LAST_ADMIN case IS an
 *   unreachable-via-HTTP code path (documented in-test) given the
 *   current `requireTenantAdmin` gate + self-check ordering — a
 *   non-self non-admin caller would be blocked at the gate before
 *   reaching the last-admin branch. Service-level coverage for the
 *   last-admin rule lives in tenant-service-remove-member.test.ts.
 *
 *   OI-TEST-003 — POST /owner/platform-admins with a
 *   platform_readonly actor must be rejected at the
 *   requirePlatformOwner middleware with 403
 *   INSUFFICIENT_PLATFORM_ROLE. The existing router test covers the
 *   platform_admin-rejection case (a different role); this pin
 *   closes the gap specifically for platform_readonly, which is the
 *   lowest-privilege role most likely to be introduced carelessly.
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

// Bypass the full iOS JWT auth-middleware so /workspace/* tests can
// run with a minimal Bearer token. Mirrors the pattern used by
// portal-workspace-resource-routes.test.ts.
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
    } catch { /* skip migrations our harness doesn't meet */ }
  }
}

function seedUser(db: Database.Database, email: string, tier = 'free'): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(email, tier);
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, ?)`)
    .run(uid, `user-${uid}`, email, tier);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

function grantPlatformRole(db: Database.Database, userId: number, role: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, ?, datetime('now'))`,
  ).run(userId, role);
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

async function workspaceReq(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts: { userId?: number; tenantId?: string; body?: any } = {},
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

async function ownerReq(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts: { adminUserId?: number; body?: any; token?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
      const tokenValue = opts.token ?? OWNER_TOKEN;
      headers['Authorization'] = 'Bearer ' + tokenValue;
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

const OWNER_TOKEN = 'security-negatives-owner-token-at-least-16-chars';

// ════════════════════════════════════════════════════════════════
// OI-TEST-001 — cross-tenant resource DELETE returns 404
// ════════════════════════════════════════════════════════════════

describe('OI-TEST-001 — cross-tenant resource DELETE returns 404 (not 403)', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    bob = seedUser(testDb, 'bob@e.com');
    app = makeWorkspaceApp();
  });

  afterEach(() => testDb?.close());

  // The existing test in portal-workspace-resource-routes.test.ts
  // for books covers the X-Tenant-Id SPOOF case (Bob declares he's
  // in Alice's tenant → membership guard rejects with 403
  // NOT_A_MEMBER). This test covers the DIRECT case: Bob stays in
  // his own tenant and tries to DELETE by id. The resource IS
  // scoped to Alice's tenant server-side, so it doesn't exist from
  // Bob's perspective. Must be 404 — never 403 — because a 403
  // would leak "this resource exists, you just can't touch it"
  // while 404 says "as far as you're concerned, no such resource".

  it('book: Bob DELETE-ing Alice\'s book-id from his own tenant returns 404', async () => {
    const created = await workspaceReq(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: 'Alice\'s Secret Book' },
    });
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);
    const bookId = created.body.data.book.id;

    const del = await workspaceReq(app, 'DELETE', `/workspace/books/${bookId}`, {
      userId: bob,
      // NO X-Tenant-Id — Bob stays in his own (solo) tenant.
    });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');
    // The error message must not leak the title or any tenant-scoped
    // metadata. A body echo of the title would confirm existence.
    expect(JSON.stringify(del.body)).not.toContain('Alice\'s Secret Book');

    // Alice can still read the book — side-verify isolation didn't
    // break Alice's own access as a byproduct.
    const aliceGet = await workspaceReq(app, 'GET', `/workspace/books/${bookId}`, { userId: alice });
    expect(aliceGet.status).toBe(200);
  });

  it('content: Bob DELETE-ing Alice\'s note-id from his own tenant returns 404', async () => {
    const created = await workspaceReq(app, 'POST', '/workspace/content', {
      userId: alice, body: { title: 'Alice\'s Idea', kind: 'note' },
    });
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);
    const noteId = created.body.data.note.id;

    const del = await workspaceReq(app, 'DELETE', `/workspace/content/${noteId}`, { userId: bob });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(del.body)).not.toContain('Alice\'s Idea');
  });

  it('link: Bob DELETE-ing Alice\'s link-id from his own tenant returns 404', async () => {
    const created = await workspaceReq(app, 'POST', '/workspace/links', {
      userId: alice, body: { url: 'https://alices-blog.example.com/private', title: 'Alice private' },
    });
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);
    const linkId = created.body.data.link.id;

    const del = await workspaceReq(app, 'DELETE', `/workspace/links/${linkId}`, { userId: bob });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');
    // URL is user-controlled — must not echo in the error body either.
    expect(JSON.stringify(del.body)).not.toContain('alices-blog.example.com');
  });

  it('status-code discipline: 404 not 403 — 403 would confirm "exists but forbidden"', async () => {
    // Explicit discipline pin: the behaviors above all returned
    // 404, not 403. If a future refactor changes one of them to 403
    // (e.g. by adding a separate permission check BEFORE the
    // tenant-scoped lookup), this regression guard fires. The
    // invariant is: a cross-tenant ID is indistinguishable from a
    // never-existed ID.
    const created = await workspaceReq(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: 'T' },
    });
    const bookId = created.body.data.book.id;
    const neverExisted = 999999;

    const realCross = await workspaceReq(app, 'DELETE', `/workspace/books/${bookId}`, { userId: bob });
    const madeUp = await workspaceReq(app, 'DELETE', `/workspace/books/${neverExisted}`, { userId: bob });

    // Both paths MUST produce the same 404 response shape — if
    // they diverge, an attacker can distinguish "exists in another
    // tenant" from "doesn't exist anywhere" by probing.
    expect(realCross.status).toBe(404);
    expect(madeUp.status).toBe(404);
    expect(realCross.body.error.code).toBe(madeUp.body.error.code);
  });
});

// ════════════════════════════════════════════════════════════════
// OI-TEST-002 — remove-member protections over HTTP
// ════════════════════════════════════════════════════════════════

describe('OI-TEST-002 — remove-member protections over HTTP', () => {
  let app: express.Express;
  let alice: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    app = makeWorkspaceApp();
  });

  afterEach(() => testDb?.close());

  // The user-facing last-admin protection manifests as
  // CANNOT_REMOVE_SELF (400) in practice: an admin can only
  // "accidentally" be the last admin of their own tenant, in
  // which case they'd need to remove themselves — which the
  // self-check refuses. The HTTP layer's job is to propagate
  // the service error with the correct status code.

  it('tenant_admin trying to remove themselves returns 400 CANNOT_REMOVE_SELF', async () => {
    const r = await workspaceReq(app, 'DELETE', `/workspace/members/${alice}`, { userId: alice });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CANNOT_REMOVE_SELF');
  });

  // The CANNOT_REMOVE_LAST_ADMIN (409) branch is unreachable via
  // the HTTP endpoint given the current gate ordering:
  //   1. `requireTenantAdmin` blocks non-admin callers with 403
  //   2. `removeMember` service blocks self-removal with 400
  //   3. If target is a different admin, there must be ≥2 admins
  //      (actor + target), so adminCount >= 2 → last-admin check
  //      cannot fire
  // Therefore the only way to hit CANNOT_REMOVE_LAST_ADMIN in
  // practice is a direct service call (e.g. from a future
  // admin-panel DELETE that targets another tenant's sole admin).
  // Service-level coverage lives in
  // __tests__/services/tenant-service-remove-member.test.ts.
  // We document the reachability here so a future contributor
  // who tries to write the HTTP test doesn't burn cycles
  // discovering the gate ordering themselves.
  it('documents: CANNOT_REMOVE_LAST_ADMIN is unreachable via /workspace/members (by design)', () => {
    // Intentional tautology — the point is the comment above.
    // If the gate ordering changes (e.g. self-check moves after
    // the admin-count check), the reachability analysis changes
    // and this test file should add an HTTP-level pin for the
    // 409 case.
    expect(true).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// OI-TEST-003 — POST /owner/platform-admins rejects platform_readonly
// ════════════════════════════════════════════════════════════════

describe('OI-TEST-003 — POST /owner/platform-admins rejects platform_readonly', () => {
  let app: express.Express;
  let readonlyAdmin: number;
  let ownerAdmin: number;
  let target: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;
  const originalJwtSecret = process.env.PORTAL_ADMIN_JWT_SECRET;

  beforeEach(() => {
    // Legacy mode so X-Admin-User-Id drives identity — lets us
    // swap the actor role between tests without minting JWTs.
    // OI-SEC-001 secure mode has its own test file.
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    process.env.PORTAL_OWNER_TOKEN = OWNER_TOKEN;

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    ownerAdmin = seedUser(testDb, 'owner@e.com');
    readonlyAdmin = seedUser(testDb, 'readonly@e.com');
    target = seedUser(testDb, 'target@e.com');
    grantPlatformRole(testDb, ownerAdmin, 'platform_owner');
    grantPlatformRole(testDb, readonlyAdmin, 'platform_readonly');
    app = makeOwnerApp();
  });

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
    if (originalJwtSecret) process.env.PORTAL_ADMIN_JWT_SECRET = originalJwtSecret;
  });

  it('platform_readonly POST-ing /owner/platform-admins is rejected with 403 INSUFFICIENT_PLATFORM_ROLE', async () => {
    const r = await ownerReq(app, 'POST', '/owner/platform-admins', {
      adminUserId: readonlyAdmin,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
    // Must not create the row — the guard runs before the DB write.
    const row = testDb.prepare('SELECT user_id FROM platform_admins WHERE user_id = ?').get(target);
    expect(row).toBeUndefined();
  });

  it('platform_readonly rejection message names their current role + required role', async () => {
    const r = await ownerReq(app, 'POST', '/owner/platform-admins', {
      adminUserId: readonlyAdmin,
      body: { userId: target, role: 'platform_admin' },
    });
    // Current middleware response includes details.currentRole +
    // requiredRole. Keeping this assertion loose — the string
    // shape may evolve — but the role names MUST appear so ops
    // can diagnose the rejection.
    expect(r.body.error.details?.currentRole).toBe('platform_readonly');
    expect(r.body.error.details?.requiredRole).toBe('platform_owner');
  });

  // Positive case — confirms the guard isn't over-tight. If the
  // middleware erroneously 403'd ALL callers, the negative tests
  // above would still pass but functionality would be broken.
  it('platform_owner POST-ing /owner/platform-admins succeeds (positive control)', async () => {
    const r = await ownerReq(app, 'POST', '/owner/platform-admins', {
      adminUserId: ownerAdmin,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(201);
    const row = testDb.prepare('SELECT user_id, role FROM platform_admins WHERE user_id = ?').get(target) as { user_id: number; role: string } | undefined;
    expect(row?.role).toBe('platform_admin');
  });

  // Round-trip on the DELETE side for the same role: platform_readonly
  // must also be blocked from REVOKING another admin. Otherwise an
  // attacker with only read access could still remove others.
  it('platform_readonly DELETE /owner/platform-admins/:userId is also rejected with 403', async () => {
    // Pre-grant someone so there's a real row to try to revoke.
    grantPlatformRole(testDb, target, 'platform_admin');
    const r = await ownerReq(app, 'DELETE', `/owner/platform-admins/${target}`, {
      adminUserId: readonlyAdmin,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_PLATFORM_ROLE');
    // Row must still exist — the guard runs before the DELETE.
    const row = testDb.prepare('SELECT user_id FROM platform_admins WHERE user_id = ?').get(target);
    expect(row).toBeDefined();
  });
});
