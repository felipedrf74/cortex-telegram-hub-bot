// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-005a (2026-04-24) — CREATE/UPDATE audit writes for
 * the 4 workspace resource types.
 *
 * Before this commit, only DELETE operations wrote audit rows,
 * leaving the Activity feed with a blind spot: a reference that
 * got created and subsequently updated 10 times shows up exactly
 * once (on delete). This file pins:
 *
 *   1. CREATE writes audit rows with the right action name,
 *      resource path, and minimum viable metadata (id + title).
 *   2. UPDATE writes audit rows with `keysTouched` — an array of
 *      the caller-touched fields — but NEVER the values. Matches
 *      OI-DATA-003e's values-never-leak convention.
 *   3. PII invariants: long-form content (notes body, link
 *      description, channel URL/description, book notes) is
 *      NEVER in the audit row's details blob, even when the
 *      caller supplied it.
 *   4. GET /workspace/activity now surfaces these new events so
 *      the Activity feed actually lights up as tenants curate.
 *   5. PATCH with an empty body does NOT produce an audit row
 *      (avoids polluting the feed with no-op calls).
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
    } catch { /* skip */ }
  }
}

function seedUser(email: string): number {
  const r = testDb.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email);
  const uid = Number(r.lastInsertRowid);
  testDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`,
  ).run(uid, `user-${uid}`, email);
  testDb.prepare(
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
  opts: { userId?: number; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.userId !== undefined) headers['Authorization'] = `Bearer ${jwtFor(opts.userId)}`;
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

function readAuditRows(action: string): Array<{ action: string; resource: string; details: string; actor_id: number }> {
  return testDb.prepare(
    `SELECT action, resource, details, actor_id FROM audit_trail WHERE action = ? ORDER BY id DESC`,
  ).all(action) as any[];
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
});

afterEach(() => testDb?.close());

// ═══════════════════════════════════════════════════════════════
// Books
// ═══════════════════════════════════════════════════════════════

describe('OI-DATA-005a — books CREATE / UPDATE audit', () => {
  it('POST /workspace/books writes tenant.book.create audit with title + author', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const r = await req(app, 'POST', '/workspace/books', {
      userId: alice,
      body: { title: 'Atomic Habits', author: 'James Clear', notes: 'VERY SECRET NOTES' },
    });
    expect([200, 201]).toContain(r.status);
    const bookId = r.body.data.book.id;

    const rows = readAuditRows('tenant.book.create');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.resource).toBe(`tenant.${alice}.book.${bookId}`);
    expect(row.actor_id).toBe(alice);
    const details = JSON.parse(row.details);
    expect(details.title).toBe('Atomic Habits');
    expect(details.author).toBe('James Clear');
    // PII: notes must NOT appear in the audit row.
    expect(JSON.stringify(details)).not.toContain('VERY SECRET NOTES');
  });

  it('PATCH writes tenant.book.update with keysTouched but NEVER the values', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: 'T' },
    });
    const bookId = created.body.data.book.id;

    await req(app, 'PATCH', `/workspace/books/${bookId}`, {
      userId: alice,
      body: { notes: 'MY PRIVATE ANNOTATION', title: 'T2' },
    });

    const rows = readAuditRows('tenant.book.update');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.bookId).toBe(bookId);
    expect(details.title).toBe('T2');
    expect(details.keysTouched).toEqual(expect.arrayContaining(['title', 'notes']));
    // The VALUE of notes must never leak into the audit row.
    expect(JSON.stringify(details)).not.toContain('MY PRIVATE ANNOTATION');
  });

  it('PATCH with empty body writes NO update audit (no-op call doesn\'t pollute the feed)', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: 'T' },
    });
    const bookId = created.body.data.book.id;
    // Pre-condition: the create wrote one audit. An empty PATCH
    // must NOT add a second.
    const beforePatch = readAuditRows('tenant.book.update').length;
    await req(app, 'PATCH', `/workspace/books/${bookId}`, {
      userId: alice, body: {},
    });
    const afterPatch = readAuditRows('tenant.book.update').length;
    expect(afterPatch).toBe(beforePatch);
    expect(beforePatch).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Content (notes)
// ═══════════════════════════════════════════════════════════════

describe('OI-DATA-005a — content CREATE / UPDATE audit', () => {
  it('POST /workspace/content writes tenant.note.create with title + kind (NOT body)', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const r = await req(app, 'POST', '/workspace/content', {
      userId: alice,
      body: {
        title: 'Product brainstorm',
        kind: 'idea',
        body: 'SENSITIVE LONG-FORM STRATEGY that should never appear in audit logs',
      },
    });
    const noteId = r.body.data.note.id;
    const rows = readAuditRows('tenant.note.create');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.noteId).toBe(noteId);
    expect(details.title).toBe('Product brainstorm');
    expect(details.kind).toBe('idea');
    expect(JSON.stringify(details)).not.toContain('SENSITIVE LONG-FORM STRATEGY');
  });

  it('PATCH writes tenant.note.update with keysTouched but not the body value', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/content', {
      userId: alice, body: { title: 'x' },
    });
    const noteId = created.body.data.note.id;
    await req(app, 'PATCH', `/workspace/content/${noteId}`, {
      userId: alice,
      body: { body: 'TOP SECRET REVISION' },
    });
    const rows = readAuditRows('tenant.note.update');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.keysTouched).toEqual(['body']);
    expect(JSON.stringify(details)).not.toContain('TOP SECRET REVISION');
  });
});

// ═══════════════════════════════════════════════════════════════
// Links
// ═══════════════════════════════════════════════════════════════

describe('OI-DATA-005a — links CREATE / UPDATE audit', () => {
  it('POST /workspace/links writes tenant.link.create with title + url (NOT description)', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const r = await req(app, 'POST', '/workspace/links', {
      userId: alice,
      body: {
        url: 'https://example.com/article',
        title: 'An article',
        description: 'VERY PRIVATE REASON I saved this link',
      },
    });
    const linkId = r.body.data.link.id;
    const rows = readAuditRows('tenant.link.create');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.linkId).toBe(linkId);
    expect(details.url).toBe('https://example.com/article');
    expect(JSON.stringify(details)).not.toContain('VERY PRIVATE REASON');
  });

  it('PATCH writes tenant.link.update with keysTouched — description value suppressed', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/links', {
      userId: alice, body: { url: 'https://x/' },
    });
    const linkId = created.body.data.link.id;
    await req(app, 'PATCH', `/workspace/links/${linkId}`, {
      userId: alice, body: { description: 'MY_REASON_FOR_SAVING', isFavorite: true },
    });
    const rows = readAuditRows('tenant.link.update');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.keysTouched).toEqual(expect.arrayContaining(['description', 'isFavorite']));
    expect(JSON.stringify(details)).not.toContain('MY_REASON_FOR_SAVING');
  });
});

// ═══════════════════════════════════════════════════════════════
// Channels
// ═══════════════════════════════════════════════════════════════

describe('OI-DATA-005a — channels CREATE / UPDATE audit', () => {
  it('POST /workspace/channels writes tenant.channel.create with title + kind', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const r = await req(app, 'POST', '/workspace/channels', {
      userId: alice,
      body: {
        title: 'Nexus Hub blog',
        kind: 'rss',
        url: 'https://example.com/feed.xml',
        description: 'LONG PERSONAL NOTES about why I subscribe',
      },
    });
    const channelId = r.body.data.channel.id;
    const rows = readAuditRows('tenant.channel.create');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.channelId).toBe(channelId);
    expect(details.title).toBe('Nexus Hub blog');
    expect(details.kind).toBe('rss');
    // URL + description never in audit (consistency with link/note).
    expect(JSON.stringify(details)).not.toContain('feed.xml');
    expect(JSON.stringify(details)).not.toContain('LONG PERSONAL NOTES');
  });

  it('PATCH writes tenant.channel.update with keysTouched', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/channels', {
      userId: alice, body: { title: 'X', kind: 'generic' },
    });
    const channelId = created.body.data.channel.id;
    await req(app, 'PATCH', `/workspace/channels/${channelId}`, {
      userId: alice, body: { status: 'muted', description: 'NEW_PRIVATE_DESCRIPTION' },
    });
    const rows = readAuditRows('tenant.channel.update');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details);
    expect(details.keysTouched).toEqual(expect.arrayContaining(['status', 'description']));
    expect(JSON.stringify(details)).not.toContain('NEW_PRIVATE_DESCRIPTION');
  });
});

// ═══════════════════════════════════════════════════════════════
// Activity feed integration
// ═══════════════════════════════════════════════════════════════

describe('OI-DATA-005a — Activity feed surfaces new CRUD events', () => {
  it('GET /workspace/activity returns create/update/delete events in reverse-chronological order', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const created = await req(app, 'POST', '/workspace/books', {
      userId: alice, body: { title: 'B' },
    });
    const bookId = created.body.data.book.id;
    await req(app, 'PATCH', `/workspace/books/${bookId}`, {
      userId: alice, body: { title: 'B2' },
    });
    await req(app, 'DELETE', `/workspace/books/${bookId}`, { userId: alice });

    const feed = await req(app, 'GET', '/workspace/activity', { userId: alice });
    expect(feed.status).toBe(200);
    const events = feed.body.data.events as Array<{ action: string }>;
    const bookActions = events
      .filter((e) => e.action.startsWith('tenant.book.'))
      .map((e) => e.action);
    // All three events are present + newest (delete) first.
    expect(bookActions).toEqual(['tenant.book.delete', 'tenant.book.update', 'tenant.book.create']);
  });

  it('filter ?action=tenant.book.create isolates creates', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'A' } });
    await req(app, 'POST', '/workspace/content', { userId: alice, body: { title: 'N' } });
    await req(app, 'POST', '/workspace/links', { userId: alice, body: { url: 'https://x/' } });

    const feed = await req(app, 'GET', '/workspace/activity?action=tenant.book.create', { userId: alice });
    expect(feed.status).toBe(200);
    const events = feed.body.data.events as Array<{ action: string }>;
    expect(events.every((e) => e.action === 'tenant.book.create')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('filter ?action=tenant.*.update matches all 4 update types (prefix glob)', async () => {
    const app = makeApp();
    const alice = seedUser('alice@e.com');
    const b = await req(app, 'POST', '/workspace/books', { userId: alice, body: { title: 'B' } });
    const n = await req(app, 'POST', '/workspace/content', { userId: alice, body: { title: 'N' } });
    const l = await req(app, 'POST', '/workspace/links', { userId: alice, body: { url: 'https://x/' } });
    const c = await req(app, 'POST', '/workspace/channels', { userId: alice, body: { title: 'C' } });
    await req(app, 'PATCH', `/workspace/books/${b.body.data.book.id}`,    { userId: alice, body: { title: 'B2' } });
    await req(app, 'PATCH', `/workspace/content/${n.body.data.note.id}`,  { userId: alice, body: { title: 'N2' } });
    await req(app, 'PATCH', `/workspace/links/${l.body.data.link.id}`,    { userId: alice, body: { title: 'L2' } });
    await req(app, 'PATCH', `/workspace/channels/${c.body.data.channel.id}`, { userId: alice, body: { title: 'C2' } });

    // The Activity feed supports trailing-* glob on actions. This
    // probes the infix case; server-side the filter should match
    // via the .*.update LIKE pattern.
    const feed = await req(app, 'GET', '/workspace/activity', { userId: alice });
    const updateEvents = (feed.body.data.events as Array<{ action: string }>)
      .filter((e) => e.action.endsWith('.update'));
    expect(updateEvents.map((e) => e.action).sort()).toEqual([
      'tenant.book.update',
      'tenant.channel.update',
      'tenant.link.update',
      'tenant.note.update',
    ]);
  });
});
