// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * End-to-end tests for the /workspace/* tenant-scoped user console.
 *
 * Pins the isolation guarantees from the redesign doc:
 *   - Missing JWT → 401.
 *   - Valid JWT + no X-Tenant-Id → fall back to solo tenant (== userId).
 *   - X-Tenant-Id pointing at ANOTHER user's tenant → 403 NOT_A_MEMBER.
 *   - PATCH /profile updates ONLY the caller's row, never others.
 *   - /members is tenant-admin-only AND tenant-scoped.
 *   - /usage returns the caller's spend, not cross-tenant aggregates.
 *
 * Uses the setup.ts default JWT secret so no env juggling is needed.
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Bypass the full iOS JWT auth-middleware in these tests: we're not
// testing JWT verification (that's auth-routes.test), we're testing
// the /workspace/* permission layer. So we stub auth-middleware to
// just read `Authorization: Bearer <userId-as-string>` and attach
// the userId. This lets the tenant-context-guard (the thing we ARE
// testing) see a populated req.userId without the DB-status-check
// machinery in the way.
vi.mock('../../src/api/auth-middleware', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader: string | undefined = req.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing token' },
        timestamp: new Date().toISOString(),
      });
    }
    const raw = authHeader.slice(7);
    // The test helper signs a real JWT with TEST_JWT_SECRET; decode
    // without verifying (payload.userId is the only field we need).
    const jwtLib = require('jsonwebtoken');
    try {
      const payload = jwtLib.verify(raw, process.env.IOS_API_JWT_SECRET || 'test-setup-default-jwt-secret');
      req.userId = payload.userId;
      req.deviceId = payload.deviceId;
      return next();
    } catch {
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
        timestamp: new Date().toISOString(),
      });
    }
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
      // Skip migrations whose preconditions our harness doesn't meet.
    }
  }
}

function seedUser(db: Database.Database, email: string, tier = 'free'): number {
  const stmt = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  );
  const result = stmt.run(email, tier);
  const uid = Number(result.lastInsertRowid);
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
            try {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
            } catch {
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

describe('/workspace/* router integration', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    alice = seedUser(testDb, 'alice@e.com', 'pro');
    bob = seedUser(testDb, 'bob@e.com', 'free');
    app = makeApp();
  });

  afterEach(() => testDb?.close());

  it('401s without a valid Bearer JWT', async () => {
    const r = await req(app, 'GET', '/workspace/me');
    expect(r.status).toBe(401);
  });

  it('/workspace/me returns caller user + solo tenant when no X-Tenant-Id', async () => {
    const r = await req(app, 'GET', '/workspace/me', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.user.id).toBe(alice);
    expect(r.body.data.tenant.id).toBe(alice);
    expect(r.body.data.role).toBe('tenant_admin');
  });

  it('/workspace/tenants returns every tenant the user is a member of', async () => {
    const r = await req(app, 'GET', '/workspace/tenants', { userId: alice });
    expect(r.status).toBe(200);
    const ids = r.body.data.tenants.map((t: any) => t.tenant.id);
    expect(ids).toContain(alice);
    expect(ids).not.toContain(bob);
  });

  it('rejects alice trying to enter bob\'s tenant via X-Tenant-Id with 403 NOT_A_MEMBER', async () => {
    const r = await req(app, 'GET', '/workspace/me', { userId: alice, tenantId: String(bob) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_MEMBER');
    expect(r.body.error.details).toMatchObject({ tenantId: bob });
  });

  it('accepts the slug form of X-Tenant-Id ("user-N")', async () => {
    const r = await req(app, 'GET', '/workspace/me', { userId: alice, tenantId: `user-${alice}` });
    expect(r.status).toBe(200);
    expect(r.body.data.tenant.id).toBe(alice);
  });

  it('GET /workspace/profile returns only the caller\'s fields', async () => {
    const r = await req(app, 'GET', '/workspace/profile', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.profile.email).toBe('alice@e.com');
  });

  it('PATCH /workspace/profile can ONLY update the caller\'s own row, never another user\'s', async () => {
    const bobBefore = testDb.prepare('SELECT first_name FROM users WHERE id = ?').get(bob) as { first_name: string | null };

    const r = await req(app, 'PATCH', '/workspace/profile', {
      userId: alice,
      body: { firstName: 'Alice-Updated' },
    });
    expect(r.status).toBe(200);

    const aliceAfter = testDb.prepare('SELECT first_name FROM users WHERE id = ?').get(alice) as { first_name: string | null };
    const bobAfter = testDb.prepare('SELECT first_name FROM users WHERE id = ?').get(bob) as { first_name: string | null };
    expect(aliceAfter.first_name).toBe('Alice-Updated');
    expect(bobAfter.first_name).toBe(bobBefore.first_name);
  });

  it('PATCH /workspace/profile rejects a 400 when body is empty', async () => {
    const r = await req(app, 'PATCH', '/workspace/profile', { userId: alice, body: {} });
    expect(r.status).toBe(400);
  });

  it('/workspace/members lists ONLY the caller\'s tenant members (tenant_admin required)', async () => {
    const r = await req(app, 'GET', '/workspace/members', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.tenantId).toBe(alice);
    expect(r.body.data.members.map((m: any) => m.userId)).toEqual([alice]);
  });

  it('/workspace/members rejects a tenant_member with INSUFFICIENT_TENANT_ROLE', async () => {
    testDb.prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(alice, bob);

    const r = await req(app, 'GET', '/workspace/members', { userId: bob, tenantId: String(alice) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('INSUFFICIENT_TENANT_ROLE');
  });

  it('/workspace/books returns an empty list for a fresh tenant (Phase-2C real CRUD)', async () => {
    // Replaced the Phase-2 stub in 2026-04-22 with real CRUD backed by
    // tenant_books (migration 078). Shape is unchanged except that
    // the "note" field is gone — see the resource-routes test for
    // coverage of populated/created/updated/deleted rows.
    const r = await req(app, 'GET', '/workspace/books', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.tenantId).toBe(alice);
    expect(r.body.data.books).toEqual([]);
  });

  it('/workspace/usage returns the caller\'s call count scoped, WITHOUT cost (privacy invariant)', async () => {
    testDb.prepare(
      `INSERT INTO api_usage (user_id, cost_usd, category, provider, model)
       VALUES (?, 0.10, 'test', 'test', 'test-model')`,
    ).run(alice);
    testDb.prepare(
      `INSERT INTO api_usage (user_id, cost_usd, category, provider, model)
       VALUES (?, 0.25, 'test', 'test', 'test-model')`,
    ).run(bob);

    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.userId).toBe(alice);
    expect(r.body.data.today.calls).toBe(1);
    // Cost-privacy (2026-04-22): /workspace/* never exposes spend $.
    expect(r.body.data.today).not.toHaveProperty('costUsd');
  });
});
