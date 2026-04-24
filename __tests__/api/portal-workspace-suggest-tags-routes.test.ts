// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for POST /workspace/skills/suggest-tags
 * (OI-USR-405b, 2026-04-24).
 *
 * Pins the HTTP contract the User Console's "Suggest skills"
 * button depends on. Service-level scoring invariants are covered
 * by __tests__/services/skill-inference.test.ts. These tests
 * verify the glue: auth, request parsing, cold-start, and the
 * end-to-end response shape.
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
// from polluting later test files in the shared vitest fork.
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

/** Seed a book with the given tags, return its id. */
function seedBook(db: Database.Database, tenantId: number, title: string, tags: string[], createdBy: number): number {
  const r = db.prepare(
    `INSERT INTO tenant_books (tenant_id, title, author, status, tags_json, created_by, created_at)
     VALUES (?, ?, '', 'want_to_read', ?, ?, datetime('now'))`,
  ).run(tenantId, title, JSON.stringify(tags), createdBy);
  return Number(r.lastInsertRowid);
}

describe('POST /workspace/skills/suggest-tags — auth + validation (OI-USR-405b)', () => {
  let app: express.Express;
  let alice: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@example.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('requires authentication', async () => {
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', { body: { kind: 'book', id: 1 } });
    expect(r.status).toBe(401);
  });

  it('400 when kind is not one of book|link|note|channel', async () => {
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'banana', id: 1 },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_KIND');
  });

  it('400 when id is missing or non-positive', async () => {
    for (const idBad of [0, -1, 'not-a-num', null]) {
      const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
        userId: alice,
        body: { kind: 'book', id: idBad as unknown as number },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_ID');
    }
  });

  it('404 when the target reference does not exist', async () => {
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: 99999 },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('REF_NOT_FOUND');
  });
});

describe('POST /workspace/skills/suggest-tags — cold-start behavior', () => {
  let app: express.Express;
  let alice: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@example.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('returns coldStart:true when fewer than 4 refs carry skill tags', async () => {
    const target = seedBook(testDb, alice, 'Atomic Habits', ['habit', 'self-help'], alice);
    // Only 3 skill-tagged refs = below the COLD_START_REF_THRESHOLD.
    seedBook(testDb, alice, 'Other 1', ['skill:content', 'fiction'], alice);
    seedBook(testDb, alice, 'Other 2', ['skill:content', 'fiction'], alice);
    seedBook(testDb, alice, 'Other 3', ['skill:content', 'fiction'], alice);

    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: target },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.coldStart).toBe(true);
    expect(r.body.data.suggestions).toEqual([]);
  });

  it('returns coldStart:false once ≥ 4 refs carry skill tags', async () => {
    const target = seedBook(testDb, alice, 'Atomic Habits', ['habit', 'self-help'], alice);
    for (let i = 0; i < 4; i += 1) {
      seedBook(testDb, alice, `ContentRef ${i}`, ['skill:content', 'fiction'], alice);
    }
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: target },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.coldStart).toBe(false);
  });
});

describe('POST /workspace/skills/suggest-tags — signal extraction', () => {
  let app: express.Express;
  let alice: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@example.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('suggests the skill whose tagged refs share the most tags with the target', async () => {
    // Target: a book with 'habit' + 'productivity' — overlaps best with Content refs.
    const target = seedBook(testDb, alice, 'Atomic Habits', ['habit', 'productivity'], alice);
    // Above the cold-start threshold: 4 content-tagged refs share tags with target.
    seedBook(testDb, alice, 'Deep Work', ['skill:content', 'productivity', 'habit'], alice);
    seedBook(testDb, alice, 'Getting Things Done', ['skill:content', 'habit'], alice);
    seedBook(testDb, alice, 'The Power of Habit', ['skill:content', 'habit'], alice);
    seedBook(testDb, alice, 'Focus', ['skill:content', 'productivity'], alice);
    // Training refs carry different tags — should NOT be top suggestion.
    seedBook(testDb, alice, 'Starting Strength', ['skill:training', 'gym', 'strength'], alice);
    seedBook(testDb, alice, '5/3/1', ['skill:training', 'gym', 'strength'], alice);

    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: target },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.coldStart).toBe(false);
    expect(r.body.data.suggestions.length).toBeGreaterThan(0);
    expect(r.body.data.suggestions[0].skillId).toBe('content');
    expect(r.body.data.suggestions[0].confidence).toBeGreaterThan(0);
    // Supporting refs carry { kind, id } pairs.
    for (const support of r.body.data.suggestions[0].supportingRefs) {
      expect(support.kind).toBe('book');
      expect(typeof support.id).toBe('number');
    }
  });

  it('excludes the target reference itself from its own scoring pool', async () => {
    // Set the target up with a skill tag. If the pool DIDN'T exclude
    // the target, Jaccard against itself would be 1.0 and skew the
    // "top suggestion" to be the target's own skill, even if other
    // refs have better overlap via shared user tags.
    const target = seedBook(testDb, alice, 'Self-referential', ['habit'], alice); // no skill yet
    // These 4 SHARE the target's 'habit' tag — 'content' should win cleanly.
    seedBook(testDb, alice, 'Ref A', ['skill:content', 'habit'], alice);
    seedBook(testDb, alice, 'Ref B', ['skill:content', 'habit'], alice);
    seedBook(testDb, alice, 'Ref C', ['skill:content', 'habit'], alice);
    seedBook(testDb, alice, 'Ref D', ['skill:content', 'habit'], alice);

    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: target },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.suggestions[0].skillId).toBe('content');
    // Target is id=1. Supporting refs should NOT include it.
    const supportingIds = r.body.data.suggestions[0].supportingRefs.map((s: any) => s.id);
    expect(supportingIds).not.toContain(target);
  });

  it('returns empty suggestions when target has no non-skill tags (nothing to compare)', async () => {
    const target = seedBook(testDb, alice, 'Empty tags', [], alice);
    // Build enough tagged history so cold-start doesn't fire.
    for (let i = 0; i < 4; i += 1) {
      seedBook(testDb, alice, `Other ${i}`, ['skill:content', 'fiction'], alice);
    }
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: target },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.coldStart).toBe(false);
    expect(r.body.data.suggestions).toEqual([]);
  });
});

describe('POST /workspace/skills/suggest-tags — tenant isolation', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@example.com');
    bob = seedUser(testDb, 'bob@example.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('does NOT see bob refs when scoring alice target — no cross-tenant signal leak', async () => {
    const aliceTarget = seedBook(testDb, alice, 'Alice target', ['shared-tag'], alice);
    // Bob has 10 content-tagged refs all carrying 'shared-tag'. If tenant
    // isolation broke, alice would see a strong 'content' suggestion;
    // if it holds (as it should), alice cold-starts.
    for (let i = 0; i < 10; i += 1) {
      seedBook(testDb, bob, `Bob content ${i}`, ['skill:content', 'shared-tag'], bob);
    }
    const r = await req(app, 'POST', '/workspace/skills/suggest-tags', {
      userId: alice,
      body: { kind: 'book', id: aliceTarget },
    });
    expect(r.status).toBe(200);
    // Alice's tenant has ONLY the target (no skill-tagged refs) → cold-start.
    expect(r.body.data.coldStart).toBe(true);
    expect(r.body.data.suggestions).toEqual([]);
  });
});
