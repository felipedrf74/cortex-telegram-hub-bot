// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-007 (2026-04-24) — route-level tests for
 * GET /workspace/integrations.
 *
 * Pins:
 *   - 401 without a JWT
 *   - Response shape matches the service contract (array of rows
 *     keyed on provider, with connected / connectedAt / expiresAt
 *     / scopes / healthStatus / healthCheckedAt / healthError)
 *   - Cross-user isolation: Alice's integrations never leak to Bob
 *   - tenant_viewer can read (this is a read-only status view; no
 *     reason to gate it higher than tenant_member)
 *   - Any member in a tenant sees THEIR OWN connections, not the
 *     tenant owner's. Integrations are user-scoped, not tenant-
 *     scoped.
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

// Bypass the heavy iOS JWT middleware; decode the token we mint
// locally and attach userId to the request.
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
    } catch { /* skip deps */ }
  }
}

function seedUser(email: string, tier = 'free'): number {
  const r = testDb.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(email, tier);
  const uid = Number(r.lastInsertRowid);
  testDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, ?)`,
  ).run(uid, `user-${uid}`, email, tier);
  testDb.prepare(
    `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
  ).run(uid, uid);
  return uid;
}

function addToTenant(tenantId: number, userId: number, role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer'): void {
  testDb.prepare(
    `INSERT OR REPLACE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)`,
  ).run(tenantId, userId, role);
}

function insertOAuth(userId: number, provider: string, createdAt: string, expiresAt: string | null = null): void {
  testDb.prepare(
    `INSERT INTO user_oauth_tokens (
       user_id, provider, access_token, refresh_token, token_type,
       expires_at, scopes, created_at, updated_at
     ) VALUES (?, ?, 'at', 'rt', 'Bearer', ?, '[]', ?, datetime('now'))`,
  ).run(userId, provider, expiresAt, createdAt);
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
  method: 'GET',
  urlPath: string,
  opts: { userId?: number; tenantId?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.userId !== undefined) headers['Authorization'] = `Bearer ${jwtFor(opts.userId)}`;
      if (opts.tenantId !== undefined) headers['X-Tenant-Id'] = opts.tenantId;
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
      request.end();
    });
  });
}

describe('GET /workspace/integrations (OI-DATA-007)', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser('alice@e.com', 'pro');
    bob = seedUser('bob@e.com', 'free');
    app = makeApp();
  });

  afterEach(() => testDb?.close());

  it('returns 401 without a Bearer token', async () => {
    const r = await req(app, 'GET', '/workspace/integrations');
    expect(r.status).toBe(401);
  });

  it('returns a list of integration rows for the caller', async () => {
    const r = await req(app, 'GET', '/workspace/integrations', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.data.integrations)).toBe(true);
    // Every row has the full shape — `connected`, `scopes`, etc.
    for (const row of r.body.data.integrations) {
      expect(row).toHaveProperty('provider');
      expect(row).toHaveProperty('connected');
      expect(row).toHaveProperty('connectedAt');
      expect(row).toHaveProperty('expiresAt');
      expect(row).toHaveProperty('scopes');
      expect(row).toHaveProperty('healthStatus');
    }
  });

  it('surfaces a connected provider for the caller', async () => {
    insertOAuth(alice, 'google', '2026-04-01T12:00:00Z', '2026-05-01T12:00:00Z');
    const r = await req(app, 'GET', '/workspace/integrations', { userId: alice });
    const google = r.body.data.integrations.find((x: any) => x.provider === 'google');
    expect(google?.connected).toBe(true);
    expect(google?.connectedAt).toBe('2026-04-01T12:00:00Z');
    expect(google?.expiresAt).toBe('2026-05-01T12:00:00Z');
  });

  it('SECURITY: cross-user isolation — Bob\'s response does NOT leak Alice\'s connections', async () => {
    insertOAuth(alice, 'google', '2026-04-01T12:00:00Z');
    insertOAuth(bob, 'outlook', '2026-04-02T12:00:00Z');

    const bobResponse = await req(app, 'GET', '/workspace/integrations', { userId: bob });
    const providers = bobResponse.body.data.integrations as Array<{ provider: string; connected: boolean }>;
    const google = providers.find((x) => x.provider === 'google');
    const outlook = providers.find((x) => x.provider === 'outlook');
    // Bob sees HIS outlook as connected.
    expect(outlook?.connected).toBe(true);
    // Bob does NOT see Alice's google — even though the global
    // response schema includes a row for google, it's marked as
    // disconnected from Bob's perspective.
    expect(google?.connected).toBe(false);
  });

  it('integrations are user-scoped, NOT tenant-scoped — a tenant_admin sees only their own, not the owner\'s', async () => {
    // Alice is the owner of her tenant. Bob joins Alice's tenant
    // as a tenant_admin. Bob's GET /workspace/integrations with
    // X-Tenant-Id pointing at Alice's tenant should STILL only
    // return Bob's integrations, not the tenant-owner's.
    addToTenant(alice, bob, 'tenant_admin');
    insertOAuth(alice, 'google', '2026-04-01T12:00:00Z');
    insertOAuth(bob, 'outlook', '2026-04-02T12:00:00Z');

    const r = await req(app, 'GET', '/workspace/integrations', {
      userId: bob,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    const providers = r.body.data.integrations as Array<{ provider: string; connected: boolean }>;
    expect(providers.find((x) => x.provider === 'google')?.connected).toBe(false);
    expect(providers.find((x) => x.provider === 'outlook')?.connected).toBe(true);
  });

  it('tenant_viewer can read (integrations is status-view — no reason to gate higher)', async () => {
    // Alice makes Bob a tenant_viewer in her tenant. Bob queries
    // /workspace/integrations with X-Tenant-Id=alice.
    // Expected: 200, no 403 gate.
    addToTenant(alice, bob, 'tenant_viewer');
    insertOAuth(bob, 'notion', '2026-04-03T12:00:00Z');

    const r = await req(app, 'GET', '/workspace/integrations', {
      userId: bob,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    const notion = (r.body.data.integrations as Array<{ provider: string; connected: boolean }>)
      .find((x) => x.provider === 'notion');
    expect(notion?.connected).toBe(true);
  });
});
