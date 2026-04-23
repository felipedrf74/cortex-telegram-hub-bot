// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for /workspace/channels/* (OI-DATA-002,
 * branch feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22).
 *
 * Pins the HTTP contract the User Console → Reference Center →
 * Channels tab depends on. Service-level invariants are covered by
 * __tests__/services/tenant-channel-service.test.ts; these tests
 * verify the glue: auth chain, HTTP status codes, request parsing,
 * and the `/workspace/console/home` payload changes (new channels
 * count + `content.channel.primary` dependency).
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

// ─────────────────────────────────────────────────────────────────────
describe('GET /workspace/channels — list', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('returns an empty list for a fresh tenant', async () => {
    const r = await req(app, 'GET', '/workspace/channels', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.channels).toEqual([]);
    expect(r.body.data.tenantId).toBe(alice);
  });

  it('requires authentication', async () => {
    const r = await req(app, 'GET', '/workspace/channels');
    expect(r.status).toBe(401);
  });
});

describe('POST /workspace/channels — create', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('creates a channel and returns it with 201', async () => {
    const r = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice),
      body: { title: 'Huberman Lab', url: 'https://hubermanlab.com/feed', kind: 'podcast' },
    });
    expect(r.status).toBe(201);
    expect(r.body.data.channel.title).toBe('Huberman Lab');
    expect(r.body.data.channel.kind).toBe('podcast');
    expect(r.body.data.channel.status).toBe('active');
  });

  it('400s when title is missing', async () => {
    const r = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { url: 'https://x.com' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
  });

  it('SECURITY: 400s on javascript: URL', async () => {
    const r = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice),
      body: { title: 'evil', url: 'javascript:alert(1)' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/must start with http/);
  });
});

describe('GET /workspace/channels/:id + cross-tenant isolation', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;
  let aliceChannelId: number;
  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    bob = seedUser(testDb, 'bob@e.com');
    app = makeApp();
    const created = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'alice-chan' },
    });
    aliceChannelId = created.body.data.channel.id;
  });
  afterEach(() => testDb?.close());

  it('owner can fetch their own channel', async () => {
    const r = await req(app, 'GET', `/workspace/channels/${aliceChannelId}`, {
      userId: alice, tenantId: String(alice),
    });
    expect(r.status).toBe(200);
    expect(r.body.data.channel.title).toBe('alice-chan');
  });

  it('SECURITY: cross-tenant GET returns 404 (no existence leak)', async () => {
    const r = await req(app, 'GET', `/workspace/channels/${aliceChannelId}`, {
      userId: bob, tenantId: String(bob),
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('SECURITY: cross-tenant DELETE returns 404 (existence non-leak)', async () => {
    const r = await req(app, 'DELETE', `/workspace/channels/${aliceChannelId}`, {
      userId: bob, tenantId: String(bob),
    });
    expect(r.status).toBe(404);
    // Row still exists on Alice's side.
    const check = await req(app, 'GET', `/workspace/channels/${aliceChannelId}`, {
      userId: alice, tenantId: String(alice),
    });
    expect(check.status).toBe(200);
  });
});

describe('PATCH /workspace/channels/:id', () => {
  let app: express.Express;
  let alice: number;
  let channelId: number;
  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    app = makeApp();
    const created = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'x' },
    });
    channelId = created.body.data.channel.id;
  });
  afterEach(() => testDb?.close());

  it('updates mutable fields', async () => {
    const r = await req(app, 'PATCH', `/workspace/channels/${channelId}`, {
      userId: alice, tenantId: String(alice),
      body: { status: 'muted', kind: 'youtube' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.channel.status).toBe('muted');
    expect(r.body.data.channel.kind).toBe('youtube');
  });

  it('supports nulling out url/handle/description explicitly', async () => {
    await req(app, 'PATCH', `/workspace/channels/${channelId}`, {
      userId: alice, tenantId: String(alice),
      body: { url: 'https://example.com' },
    });
    const r = await req(app, 'PATCH', `/workspace/channels/${channelId}`, {
      userId: alice, tenantId: String(alice), body: { url: null },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.channel.url).toBeNull();
  });

  it('404 when id does not exist', async () => {
    const r = await req(app, 'PATCH', `/workspace/channels/99999`, {
      userId: alice, tenantId: String(alice), body: { status: 'muted' },
    });
    expect(r.status).toBe(404);
  });
});

describe('GET /workspace/console/home — channels integration', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('zero channels: counts.channels === 0 AND dependency is missing with CTA', async () => {
    const r = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.body.data.counts.channels).toBe(0);
    const dep = r.body.data.dependencies.items.find((d: any) => d.id === 'content.channel.primary');
    expect(dep).toBeTruthy();
    expect(dep.status).toBe('missing');
    expect(dep.cta.href).toBe('#/references/channels');
  });

  it('adding a channel flips dependency to ready and increments count', async () => {
    await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'Podcast X', kind: 'podcast' },
    });
    const r = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.body.data.counts.channels).toBe(1);
    const dep = r.body.data.dependencies.items.find((d: any) => d.id === 'content.channel.primary');
    expect(dep.status).toBe('ready');
    expect(dep.cta).toBeNull();
  });

  it('muted channels do NOT count as ready for the dependency', async () => {
    // Create + immediately mute — the dependency is gated on
    // status='active', so a muted channel shouldn't satisfy it.
    const created = await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'X' },
    });
    await req(app, 'PATCH', `/workspace/channels/${created.body.data.channel.id}`, {
      userId: alice, tenantId: String(alice), body: { status: 'muted' },
    });
    const r = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    expect(r.body.data.counts.channels).toBe(0);
    const dep = r.body.data.dependencies.items.find((d: any) => d.id === 'content.channel.primary');
    expect(dep.status).toBe('missing');
  });

  it('cost-privacy invariant still holds with channels added', async () => {
    // Plant a cost_usd row + create a channel → neither surfaces
    // costUsd on the tenant plane.
    // Cost marker: 4-decimal value can't appear in ISO-8601 timestamps
    // (millis cap at 3 digits) — robust against clock-timing flakes
    // like `29.990Z` that were triggering false positives on `/9\.99/`.
    const COST_MARKER = '123.4567';
    testDb.prepare(
      `INSERT INTO api_usage (user_id, ts, category, model, cost_usd)
       VALUES (?, datetime('now'), 'chat', 'gemini', ${COST_MARKER})`,
    ).run(alice);
    await req(app, 'POST', '/workspace/channels', {
      userId: alice, tenantId: String(alice), body: { title: 'X' },
    });
    const r = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toMatch(/costUsd/i);
    expect(serialized).not.toContain(COST_MARKER);
  });
});
