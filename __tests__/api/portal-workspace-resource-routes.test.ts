// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Router-level tests for Phase 2C additions:
 *   - Cost-privacy: /workspace/usage MUST NOT return costUsd
 *   - /workspace/books + /content + /links CRUD happy paths
 *   - /workspace/settings PATCH (tenant_admin only)
 *   - /workspace/security GET shape
 *   - Cross-tenant access returns 404/403, never data
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

// Bypass the full JWT middleware chain for tenant-internal scope.
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

describe('cost-privacy: /workspace/usage', () => {
  let app: express.Express;
  let u: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    u = seedUser(testDb, 'privacy@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('MUST NOT return costUsd to tenant users (only platform_owner sees spend)', async () => {
    // Seed some api_usage rows so costUsd would have been a non-zero value.
    testDb.prepare(
      `INSERT INTO api_usage (user_id, cost_usd, category, provider, model)
       VALUES (?, 0.50, 'chat', 'gemini', 'flash')`,
    ).run(u);

    const r = await req(app, 'GET', '/workspace/usage', { userId: u });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty('today');
    // Contract: calls is ok to expose; costUsd is NOT.
    expect(r.body.data.today).toHaveProperty('calls');
    expect(r.body.data.today).not.toHaveProperty('costUsd');
    expect(r.body.data.today).not.toHaveProperty('cost_usd');
    expect(r.body.data.today).not.toHaveProperty('cost');
  });
});

describe('/workspace/books CRUD', () => {
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

  it('create + list round-trips', async () => {
    const create = await req(app, 'POST', '/workspace/books', {
      userId: alice,
      body: { title: 'Atomic Habits', author: 'James Clear', tags: ['self', 'habits'] },
    });
    expect(create.status).toBe(201);
    expect(create.body.data.book.title).toBe('Atomic Habits');

    const list = await req(app, 'GET', '/workspace/books', { userId: alice });
    expect(list.status).toBe(200);
    expect(list.body.data.books).toHaveLength(1);
    expect(list.body.data.books[0].author).toBe('James Clear');
  });

  it('patch updates fields + finished_at on status=finished', async () => {
    const c = await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'T' } });
    const id = c.body.data.book.id;
    const u = await req(app, 'PATCH', `/workspace/books/${id}`, {
      userId: alice, body: { status: 'finished' },
    });
    expect(u.status).toBe(200);
    expect(u.body.data.book.status).toBe('finished');
    expect(u.body.data.book.finishedAt).not.toBeNull();
  });

  it('delete removes the row', async () => {
    const c = await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'T' } });
    const id = c.body.data.book.id;
    const d = await req(app, 'DELETE', `/workspace/books/${id}`, { userId: alice });
    expect(d.status).toBe(200);
    const g = await req(app, 'GET', `/workspace/books/${id}`, { userId: alice });
    expect(g.status).toBe(404);
  });

  it('Bob cannot read Alice\'s book even with the right id (cross-tenant isolation)', async () => {
    const c = await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'Alice book' } });
    const id = c.body.data.book.id;
    // Bob defaults to his own solo tenant; the book lives in Alice's.
    const r = await req(app, 'GET', `/workspace/books/${id}`, { userId: bob });
    expect(r.status).toBe(404);
  });

  it('Bob cannot delete Alice\'s book via X-Tenant-Id spoof (membership blocks first)', async () => {
    const c = await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'T' } });
    const id = c.body.data.book.id;
    // Bob tries to be in Alice's tenant — but he's not a member. Guard returns 403.
    const r = await req(app, 'DELETE', `/workspace/books/${id}`, {
      userId: bob, tenantId: String(alice),
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_MEMBER');
  });

  it('rejects empty title with 400', async () => {
    const r = await req(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: '' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('/workspace/content CRUD', () => {
  let app: express.Express;
  let u: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    u = seedUser(testDb, 'content@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('create + list + filter by kind', async () => {
    await req(app, 'POST', '/workspace/content', { userId: u, body: { title: 'an idea', kind: 'idea' } });
    await req(app, 'POST', '/workspace/content', { userId: u, body: { title: 'a draft', kind: 'draft' } });
    await req(app, 'POST', '/workspace/content', { userId: u, body: { title: 'a plain', body: 'hi' } });

    const all = await req(app, 'GET', '/workspace/content', { userId: u });
    expect(all.body.data.notes).toHaveLength(3);

    const ideas = await req(app, 'GET', '/workspace/content?kind=idea', { userId: u });
    expect(ideas.body.data.notes.map((n: any) => n.title)).toEqual(['an idea']);
  });

  it('patch + delete', async () => {
    const c = await req(app, 'POST', '/workspace/content', { userId: u, body: { title: 'T', body: 'orig' } });
    const id = c.body.data.note.id;
    const patched = await req(app, 'PATCH', `/workspace/content/${id}`, { userId: u, body: { body: 'edited' } });
    expect(patched.body.data.note.body).toBe('edited');
    const del = await req(app, 'DELETE', `/workspace/content/${id}`, { userId: u });
    expect(del.status).toBe(200);
  });
});

describe('/workspace/links CRUD', () => {
  let app: express.Express;
  let u: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    u = seedUser(testDb, 'links@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('create with valid url + toggle favorite', async () => {
    const c = await req(app, 'POST', '/workspace/links', {
      userId: u, body: { url: 'https://example.com/a', title: 'A' },
    });
    expect(c.status).toBe(201);
    expect(c.body.data.link.isFavorite).toBe(false);

    const id = c.body.data.link.id;
    const p = await req(app, 'PATCH', `/workspace/links/${id}`, {
      userId: u, body: { isFavorite: true },
    });
    expect(p.body.data.link.isFavorite).toBe(true);
  });

  it('favorites-only filter works', async () => {
    await req(app, 'POST', '/workspace/links', { userId: u, body: { url: 'https://a.com' } });
    await req(app, 'POST', '/workspace/links', { userId: u, body: { url: 'https://b.com', isFavorite: true } });
    const favs = await req(app, 'GET', '/workspace/links?favorites=true', { userId: u });
    expect(favs.body.data.links).toHaveLength(1);
    expect(favs.body.data.links[0].url).toBe('https://b.com');
  });

  it('rejects invalid url with 400', async () => {
    const r = await req(app, 'POST', '/workspace/links', { userId: u, body: { url: 'not-a-url' } });
    expect(r.status).toBe(400);
  });
});

describe('/workspace/settings + /workspace/security', () => {
  let app: express.Express;
  let u: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    u = seedUser(testDb, 'settings@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('GET /settings requires tenant_admin — admin sees tenant settings', async () => {
    const r = await req(app, 'GET', '/workspace/settings', { userId: u });
    expect(r.status).toBe(200);
    expect(r.body.data.settings.displayName).toBe('settings@e.com');
    expect(r.body.data.settings.slug).toBe(`user-${u}`);
  });

  it('PATCH /settings renames tenant', async () => {
    const r = await req(app, 'PATCH', '/workspace/settings', {
      userId: u, body: { displayName: 'My Workspace' },
    });
    expect(r.status).toBe(200);
    const check = await req(app, 'GET', '/workspace/me', { userId: u });
    expect(check.body.data.tenant.displayName).toBe('My Workspace');
  });

  it('PATCH /settings merges metadata rather than replacing', async () => {
    await req(app, 'PATCH', '/workspace/settings', { userId: u, body: { metadata: { theme: 'dark' } } });
    await req(app, 'PATCH', '/workspace/settings', { userId: u, body: { metadata: { timezone: 'Europe/Lisbon' } } });
    const r = await req(app, 'GET', '/workspace/settings', { userId: u });
    expect(r.body.data.settings.metadata).toEqual({ theme: 'dark', timezone: 'Europe/Lisbon' });
  });

  it('GET /security returns my devices + recent audit (no costUsd leaking here either)', async () => {
    const r = await req(app, 'GET', '/workspace/security', { userId: u });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty('devices');
    expect(r.body.data).toHaveProperty('recentAudit');
    expect(r.body.data.userId).toBe(u);
    // Privacy check: no costUsd anywhere in the payload.
    expect(JSON.stringify(r.body)).not.toMatch(/cost[_U]sd/i);
  });
});
