// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-COR-001 (2026-04-24) — aggregated tenant usage on
 * GET /workspace/usage.
 *
 * Pins:
 *   - Every caller still gets their OWN `today.calls` (regression
 *     vs. the pre-OI-COR-001 behavior).
 *   - A tenant_admin ADDITIONALLY gets `tenant.today` with `calls`
 *     (sum across all current tenant members) + `memberCount`.
 *   - A tenant_member / tenant_viewer does NOT get the `tenant`
 *     block — only admins see the rollup.
 *   - Cost-privacy invariant is preserved — costUsd must not
 *     appear anywhere in the response, including the new tenant
 *     block (tenants never see $; platform-owner's /owner/usage
 *     handles spend).
 *   - Isolation: the tenant rollup is scoped via tenant_members,
 *     so a user in tenant A never sees tenant B's calls even when
 *     they belong to both.
 *   - Semantics: memberCount counts members regardless of whether
 *     they made a call today; a tenant with 3 members and 0 calls
 *     returns `{ calls: 0, memberCount: 3 }`, not
 *     `{ calls: 0, memberCount: 0 }`.
 *   - A removed member's historical calls today are excluded (the
 *     join is against CURRENT membership).
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

function removeFromTenant(tenantId: number, userId: number): void {
  testDb.prepare(
    `DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?`,
  ).run(tenantId, userId);
}

function insertUsageRow(userId: number, opts: { costUsd?: number; category?: string } = {}): void {
  testDb.prepare(
    `INSERT INTO api_usage (user_id, cost_usd, category, provider, model)
     VALUES (?, ?, ?, 'gemini', 'flash')`,
  ).run(userId, opts.costUsd ?? 0.01, opts.category ?? 'chat');
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

describe('GET /workspace/usage — OI-COR-001 tenant rollup', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;
  let carol: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser('alice@e.com', 'pro');
    bob = seedUser('bob@e.com', 'free');
    carol = seedUser('carol@e.com', 'free');
    app = makeApp();
  });

  afterEach(() => testDb?.close());

  // ─── caller's own usage (regression guard) ────────────────────

  it('solo tenant: returns caller\'s own calls as today.calls (unchanged from pre-OI-COR-001)', async () => {
    insertUsageRow(alice);
    insertUsageRow(alice);
    insertUsageRow(alice);
    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.today.calls).toBe(3);
  });

  // ─── tenant_admin rollup ──────────────────────────────────────

  it('tenant_admin: response adds tenant.today with calls + memberCount', async () => {
    // Alice is admin of her solo tenant; add Bob as member and
    // Carol as viewer so the tenant has 3 members total.
    addToTenant(alice, bob, 'tenant_member');
    addToTenant(alice, carol, 'tenant_viewer');
    insertUsageRow(alice);
    insertUsageRow(bob);
    insertUsageRow(bob);
    insertUsageRow(carol);

    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.today.calls).toBe(1);   // alice's own
    expect(r.body.data.tenant).toBeDefined();
    expect(r.body.data.tenant.today.calls).toBe(4);       // 1 + 2 + 1
    expect(r.body.data.tenant.today.memberCount).toBe(3); // alice + bob + carol
  });

  it('tenant_admin in a tenant with zero calls today still returns memberCount > 0 (not 0)', async () => {
    // Subtle invariant: memberCount must count MEMBERS regardless
    // of today's activity. A tenant with 3 members and no calls
    // should report `{ calls: 0, memberCount: 3 }`, not
    // `{ calls: 0, memberCount: 0 }` — otherwise an admin sees
    // "0 members" in the UI and thinks the tenant is empty.
    addToTenant(alice, bob, 'tenant_member');
    addToTenant(alice, carol, 'tenant_viewer');
    // NO insertUsageRow calls.
    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    expect(r.body.data.tenant.today.calls).toBe(0);
    expect(r.body.data.tenant.today.memberCount).toBe(3);
  });

  // ─── non-admin gating ─────────────────────────────────────────

  it('tenant_member does NOT get the tenant block (only admins see the rollup)', async () => {
    addToTenant(alice, bob, 'tenant_member');
    insertUsageRow(alice);
    insertUsageRow(bob);
    const r = await req(app, 'GET', '/workspace/usage', {
      userId: bob,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    expect(r.body.data.today.calls).toBe(1);
    // Critical: the rollup field is ABSENT, not zero. Absence
    // signals the role gate; zero would suggest "you can see it,
    // there's just nothing there."
    expect(r.body.data).not.toHaveProperty('tenant');
  });

  it('tenant_viewer does NOT get the tenant block either', async () => {
    addToTenant(alice, bob, 'tenant_viewer');
    const r = await req(app, 'GET', '/workspace/usage', {
      userId: bob,
      tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    expect(r.body.data).not.toHaveProperty('tenant');
  });

  // ─── cost-privacy invariant (regression guard + new surface) ──

  it('cost-privacy: tenant rollup MUST NOT expose costUsd (even for admins)', async () => {
    addToTenant(alice, bob, 'tenant_member');
    insertUsageRow(alice, { costUsd: 0.50 });
    insertUsageRow(bob, { costUsd: 1.25 });
    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    const json = JSON.stringify(r.body);
    // Brutal string check — if ANY of the cost columns shows up
    // anywhere in the response body, regardless of shape, fail.
    expect(json).not.toContain('costUsd');
    expect(json).not.toContain('cost_usd');
    expect(json).not.toContain('0.5');   // alice's spend
    expect(json).not.toContain('1.25');  // bob's spend
    expect(r.body.data.tenant.today).not.toHaveProperty('costUsd');
    expect(r.body.data.tenant.today).not.toHaveProperty('cost_usd');
    expect(r.body.data.tenant.today).not.toHaveProperty('cost');
  });

  // ─── tenant isolation ─────────────────────────────────────────

  it('SECURITY: tenant rollup never leaks from another tenant (even for users in both)', async () => {
    // Alice's tenant has alice + bob. Carol owns her own tenant
    // but does NOT belong to Alice's. A tenant_admin in Alice's
    // tenant must never see Carol's calls.
    addToTenant(alice, bob, 'tenant_member');
    insertUsageRow(alice);
    insertUsageRow(bob);
    insertUsageRow(carol); // in carol's own tenant
    insertUsageRow(carol);

    const aliceResp = await req(app, 'GET', '/workspace/usage', { userId: alice });
    // Alice's tenant has 2 members, 2 calls (her + bob). Carol's
    // 2 calls must NOT contribute.
    expect(aliceResp.body.data.tenant.today.calls).toBe(2);
    expect(aliceResp.body.data.tenant.today.memberCount).toBe(2);

    // And Carol's view of HER tenant shouldn't see alice/bob.
    const carolResp = await req(app, 'GET', '/workspace/usage', { userId: carol });
    expect(carolResp.body.data.tenant.today.calls).toBe(2);
    expect(carolResp.body.data.tenant.today.memberCount).toBe(1);
  });

  // ─── membership-cascade semantics ─────────────────────────────

  it('a user REMOVED from the tenant is excluded from the rollup (membership is current, not historical)', async () => {
    addToTenant(alice, bob, 'tenant_member');
    insertUsageRow(bob);                     // bob's call while a member
    removeFromTenant(alice, bob);            // now bob is out
    insertUsageRow(alice);                   // alice calls after bob leaves
    const r = await req(app, 'GET', '/workspace/usage', { userId: alice });
    // tenant rollup should include alice only, because the JOIN
    // against tenant_members only sees current members.
    expect(r.body.data.tenant.today.calls).toBe(1);
    expect(r.body.data.tenant.today.memberCount).toBe(1);
  });
});
