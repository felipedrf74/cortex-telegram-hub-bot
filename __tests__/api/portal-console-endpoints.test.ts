// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for the two convenience endpoints added on branch
 * `feature/nexus-hub-portal-uiux-admin-user-console` (2026-04-22).
 *
 *   GET /workspace/console/home      — User Console home payload
 *   GET /owner/console/overview      — Admin Console overview payload
 *
 * Both endpoints are READ-ONLY aggregators — they compose existing
 * tables and never mutate. These tests pin:
 *
 *   - The cost-privacy invariant: /workspace/console/home NEVER
 *     surfaces `costUsd` on any field (admin-plane only).
 *   - Dependency derivation is consistent with data (empty books =>
 *     books-library dependency is 'missing', not 'ready').
 *   - Insight generators produce ONE insight per missing dependency
 *     and include a CTA — no insight without a resolution path.
 *   - Setup milestones advance when the underlying data changes.
 *   - /owner/console/overview counts agree with the raw tables.
 *   - /owner/console/overview does NOT crash when optional tables
 *     (e.g. waitlist) are absent — the endpoint is resilient.
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
function grantPlatformOwner(db: Database.Database, uid: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_owner', datetime('now'))`,
  ).run(uid);
}
function jwtFor(userId: number): string {
  return jwt.sign({ userId, deviceId: `test-device-${userId}` }, TEST_JWT_SECRET);
}

import { createPortalWorkspaceRouter } from '../../src/api/portal-workspace-router';
import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';
import { _resetOwnerRateLimiterForTests } from '../../src/api/platform-admin-guard';

const OWNER_TOKEN = 'owner-console-token-for-tests-at-least-16-chars';

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
async function httpReq(
  app: express.Express,
  method: 'GET' | 'POST',
  urlPath: string,
  opts: { userId?: number; tenantId?: string; body?: Record<string, unknown>; ownerToken?: string; adminUserId?: number } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.userId !== undefined) headers['Authorization'] = `Bearer ${jwtFor(opts.userId)}`;
      if (opts.ownerToken !== undefined) headers['Authorization'] = `Bearer ${opts.ownerToken}`;
      if (opts.tenantId !== undefined) headers['X-Tenant-Id'] = opts.tenantId;
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
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

// ─────────────────────────────────────────────────────────────────────
describe('GET /workspace/console/home — User Console home payload', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-console@e.com');
    app = makeWorkspaceApp();
  });
  afterEach(() => testDb?.close());

  it('returns a well-formed payload with zero-state counts', async () => {
    const r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.tenant.id).toBe(alice);
    expect(d.tenant.role).toBe('tenant_admin');
    expect(d.counts).toMatchObject({ books: 0, notes: 0, links: 0 });
    expect(d.counts.members).toBe(1); // alice is a member of her own tenant
    expect(d.setup.total).toBe(4);
    expect(d.setup.percent).toBeGreaterThanOrEqual(0);
  });

  it('NEVER surfaces costUsd anywhere in the payload (cost-privacy invariant)', async () => {
    // Plant a high-cost api_usage row just to be sure — if the
    // endpoint accidentally joined the table and surfaced cost, it
    // would fail this grep.
    // api_usage schema (post-migration 029): id, ts, category, model,
    // input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    // cost_usd, duration_ms, provider, user_id. `calls` is NOT a column
    // — it's a COUNT(*) alias in the reading queries.
    //
    // Cost marker: use a 4-decimal value. Timestamps are
    // `YYYY-MM-DDTHH:MM:SS.sssZ` — the fractional part has at most
    // 3 digits. A 4-decimal cost like `123.4567` can never appear
    // in a timestamp → the leak check is robust to clock timing.
    // (The earlier value `9.99` occasionally collided with timestamp
    // fragments like `29.990Z`, making this test flaky.)
    const COST_MARKER = '123.4567';
    testDb.prepare(
      `INSERT INTO api_usage (user_id, ts, category, model, cost_usd)
       VALUES (?, datetime('now'), 'chat', 'gemini', ${COST_MARKER})`,
    ).run(alice);
    const r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.status).toBe(200);
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toMatch(/costUsd/i);
    expect(serialized).not.toMatch(/cost_usd/i);
    expect(serialized).not.toContain(COST_MARKER); // the exact amount doesn't leak either
  });

  it('books-library dependency flips from missing → ready when a book is added', async () => {
    // Before: no books → missing
    let r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    let books = r.body.data.dependencies.items.find((d: any) => d.id === 'content.books.library');
    expect(books.status).toBe('missing');
    expect(books.cta).toBeTruthy();

    // Add a book via the real route.
    await httpReq(app, 'POST', '/workspace/books', {
      userId: alice, tenantId: String(alice),
      body: { title: 'Atomic Habits', author: 'James Clear', status: 'reading' },
    });

    // After: at least one book → ready
    r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    books = r.body.data.dependencies.items.find((d: any) => d.id === 'content.books.library');
    expect(books.status).toBe('ready');
    expect(books.cta).toBeNull();
  });

  it('every generated insight has a CTA — no dead-end warnings', async () => {
    const r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.status).toBe(200);
    for (const insight of r.body.data.insights) {
      // Every insight either has a CTA (points at a resolution) or is
      // the setup-nudge which points at home. Zero-resolution insights
      // are forbidden by the UX spec.
      expect(insight.cta).toBeTruthy();
      expect(insight.cta.href).toMatch(/^#\//);
    }
  });

  it('exactly one dependency-missing insight per missing dependency', async () => {
    const r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    const missingDeps = r.body.data.dependencies.items.filter((d: any) => d.status === 'missing');
    const depInsights = r.body.data.insights.filter((i: any) => i.kind === 'dependency-missing');
    expect(depInsights).toHaveLength(missingDeps.length);
    // Every insight id references a real dependency id.
    for (const ins of depInsights) {
      expect(ins.id).toMatch(/^dep:/);
    }
  });

  it('setup percent advances as milestones complete', async () => {
    let r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    const startPercent = r.body.data.setup.percent;
    // Add a book → advances the 'first-book' milestone
    await httpReq(app, 'POST', '/workspace/books', {
      userId: alice, tenantId: String(alice),
      body: { title: 'Deep Work', author: 'Cal Newport' },
    });
    r = await httpReq(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.body.data.setup.percent).toBeGreaterThan(startPercent);
    expect(r.body.data.setup.milestones.find((m: any) => m.id === 'first-book').done).toBe(true);
  });

  it('requires authentication — 401 without JWT', async () => {
    const r = await httpReq(app, 'GET', '/workspace/console/home');
    expect(r.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('GET /owner/console/overview — Admin Console overview', () => {
  let app: express.Express;
  let felipe: number;
  const originalToken = process.env.PORTAL_OWNER_TOKEN;

  beforeEach(() => {
    _resetOwnerRateLimiterForTests();
    process.env.PORTAL_OWNER_TOKEN = OWNER_TOKEN;
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    felipe = seedUser(testDb, 'felipe@e.com');
    grantPlatformOwner(testDb, felipe);
    app = makeOwnerApp();
  });
  afterEach(() => {
    process.env.PORTAL_OWNER_TOKEN = originalToken;
    testDb?.close();
  });

  it('returns a well-formed payload with honest counts', async () => {
    // Seed a second user to get tenant/user counts > 1
    seedUser(testDb, 'bob@e.com');
    const r = await httpReq(app, 'GET', '/owner/console/overview', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.counts.tenants).toBe(2);
    expect(d.counts.users).toBe(2);
    expect(d.counts.activeUsers).toBe(2);
    expect(d.counts.suspendedUsers).toBe(0);
    expect(d.usageToday).toHaveProperty('totalUsd');
    expect(d.usageToday).toHaveProperty('calls');
    expect(Array.isArray(d.recentAudit)).toBe(true);
    expect(Array.isArray(d.adoptionRisk.samples)).toBe(true);
  });

  it('counts suspended users separately from active', async () => {
    const bob = seedUser(testDb, 'bob-suspended@e.com');
    testDb.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(bob);
    const r = await httpReq(app, 'GET', '/owner/console/overview', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.body.data.counts.activeUsers).toBe(1);
    expect(r.body.data.counts.suspendedUsers).toBe(1);
  });

  it('does NOT crash when the waitlist table is absent', async () => {
    // Drop the waitlist table if the migration created it.
    try { testDb.exec('DROP TABLE IF EXISTS waitlist'); } catch {}
    const r = await httpReq(app, 'GET', '/owner/console/overview', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.counts.waitlistPending).toBe(0);
  });

  it('requires owner token + admin identity (defense in depth)', async () => {
    // No token → 401
    const noToken = await httpReq(app, 'GET', '/owner/console/overview');
    expect(noToken.status).toBe(401);

    // Token but no admin id → 401
    const noId = await httpReq(app, 'GET', '/owner/console/overview', {
      ownerToken: OWNER_TOKEN,
    });
    expect(noId.status).toBe(401);
  });

  it('lists at most 20 inactive tenants in adoptionRisk samples', async () => {
    // Seed 25 users — none have api_usage, so all should be flagged inactive.
    for (let i = 0; i < 25; i++) seedUser(testDb, `user${i}@e.com`);
    const r = await httpReq(app, 'GET', '/owner/console/overview', {
      ownerToken: OWNER_TOKEN, adminUserId: felipe,
    });
    expect(r.status).toBe(200);
    // The LIMIT 20 in the SQL caps the samples list at 20.
    expect(r.body.data.adoptionRisk.samples.length).toBeLessThanOrEqual(20);
  });
});
