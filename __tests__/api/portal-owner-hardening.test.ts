// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Validation / hardening tests added on branch
 * `hardening/nexus-hub-owner-workspace-validation` (2026-04-22).
 *
 * These cover three fixes flagged during the post-implementation
 * validation pass:
 *
 *   1. `/owner/*` rate limit: per-IP sliding window enforced BEFORE
 *      the token+identity check so a leaked PORTAL_OWNER_TOKEN
 *      cannot be used to enumerate platform_admin user ids.
 *
 *   2. `POST /owner/platform-admins` refuses to grant a platform
 *      role to a user whose `users.status !== 'active'`. Prior
 *      code only checked existence.
 *
 *   3. (Covered by service tests in the invite test file)
 *      `acceptInvite` timezone-ambiguity fix — the expiry compare
 *      now happens inside SQLite.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
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

function seedUser(db: Database.Database, email: string, opts: { tier?: string; status?: string } = {}): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, ?, 'email', datetime('now'))`,
  ).run(email, opts.tier ?? 'free', opts.status ?? 'active');
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`)
    .run(uid, `user-${uid}`, email);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

function grantPlatformOwner(db: Database.Database, userId: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_owner', datetime('now'))`,
  ).run(userId);
}

import {
  ownerRateLimitMiddleware,
  _resetOwnerRateLimiterForTests,
} from '../../src/api/platform-admin-guard';
import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';

const DEFAULT_TOKEN = 'owner-console-token-for-tests-at-least-16-chars';

function makeApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

async function req(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts: { adminUserId?: number; body?: Record<string, unknown>; token?: string | null } = {},
): Promise<{ status: number; body: any; headers: Record<string, any> }> {
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
      const request = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers },
        (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }); }
            catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
          });
        },
      );
      request.on('error', (e: Error) => { server.close(); reject(e); });
      if (body) request.write(body);
      request.end();
    });
  });
}

describe('/owner/* — rate limit (validation fix 1)', () => {
  let app: express.Express;
  let adminUid: number;
  const originalToken = process.env.PORTAL_OWNER_TOKEN;

  beforeEach(() => {
    _resetOwnerRateLimiterForTests();
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    adminUid = seedUser(testDb, 'admin@e.com', { tier: 'owner' });
    grantPlatformOwner(testDb, adminUid);
    app = makeApp();
  });

  afterEach(() => {
    process.env.PORTAL_OWNER_TOKEN = originalToken;
    testDb?.close();
  });

  it('tags responses with X-RateLimit-Bucket=owner', async () => {
    const r = await req(app, 'GET', '/owner/tenants', { adminUserId: adminUid });
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-bucket']).toBe('owner');
  });

  it('allows 30 req/min/IP (full budget) then 429s the 31st', async () => {
    // 30 consecutive requests succeed.
    for (let i = 0; i < 30; i++) {
      const r = await req(app, 'GET', '/owner/tenants', { adminUserId: adminUid });
      expect(r.status).toBe(200);
    }
    // 31st is throttled.
    const blocked = await req(app, 'GET', '/owner/tenants', { adminUserId: adminUid });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('rate limit kicks in BEFORE the token/identity check (no leak via timing)', async () => {
    // Burn the budget with WRONG tokens — these should ALL be
    // throttled too, not waved through to the identity check.
    for (let i = 0; i < 30; i++) {
      await req(app, 'GET', '/owner/tenants', { token: 'wrong-token-wrong-token', adminUserId: adminUid });
    }
    // 31st request with the CORRECT token is still throttled — the
    // IP is in penalty regardless of what token is presented.
    const blocked = await req(app, 'GET', '/owner/tenants', { adminUserId: adminUid });
    expect(blocked.status).toBe(429);
  });
});

describe('/owner/platform-admins POST — refuses non-active users (validation fix 2)', () => {
  let app: express.Express;
  let adminUid: number;
  const originalToken = process.env.PORTAL_OWNER_TOKEN;

  beforeEach(() => {
    _resetOwnerRateLimiterForTests();
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    adminUid = seedUser(testDb, 'admin@e.com', { tier: 'owner' });
    grantPlatformOwner(testDb, adminUid);
    app = makeApp();
  });

  afterEach(() => {
    process.env.PORTAL_OWNER_TOKEN = originalToken;
    testDb?.close();
  });

  it('grants to an active user — existing happy path still works', async () => {
    const target = seedUser(testDb, 'grantee@e.com', { status: 'active' });
    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: adminUid,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(201);
    expect(r.body.data.role).toBe('platform_admin');
  });

  it('rejects a grant to a SUSPENDED user with 400 USER_NOT_ACTIVE', async () => {
    const target = seedUser(testDb, 'suspended@e.com', { status: 'suspended' });
    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: adminUid,
      body: { userId: target, role: 'platform_admin' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('USER_NOT_ACTIVE');
    expect(r.body.error.details).toMatchObject({ userId: target, status: 'suspended' });
    // AND the platform_admins row was NOT created.
    const rows = testDb.prepare('SELECT user_id FROM platform_admins').all() as Array<{ user_id: number }>;
    expect(rows.map((r) => r.user_id)).not.toContain(target);
  });

  it('rejects a grant to a BANNED user', async () => {
    const target = seedUser(testDb, 'banned@e.com', { status: 'banned' });
    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: adminUid,
      body: { userId: target, role: 'platform_readonly' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('USER_NOT_ACTIVE');
  });

  it('404s a grant to a non-existent userId (unchanged behavior)', async () => {
    const r = await req(app, 'POST', '/owner/platform-admins', {
      adminUserId: adminUid,
      body: { userId: 99999, role: 'platform_admin' },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('USER_NOT_FOUND');
  });
});
