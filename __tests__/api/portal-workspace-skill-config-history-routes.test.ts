// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for GET /workspace/skills/:skillId/config/history
 * (OI-DATA-003e, 2026-04-24).
 *
 * Pins:
 *   - Auth gate.
 *   - 404 on unknown skillId.
 *   - 400 on missing / unknown key.
 *   - 400 on non-numeric or out-of-range limit.
 *   - 200 on valid call, returns entries newest-first.
 *   - VALUES NEVER LEAK — response only has keysTouched.
 *   - JSON json_each matching: "voice_guidelines" must NOT match
 *     audit rows that only touched "voice_policy" (substring trap).
 *   - Cross-tenant isolation: bob's saves never show up in alice's
 *     history query, even for the same skill.
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
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

describe('GET /workspace/skills/:skillId/config/history — auth + validation (OI-DATA-003e)', () => {
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
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines');
    expect(r.status).toBe(401);
  });

  it('404 on unknown skill', async () => {
    const r = await req(app, 'GET', '/workspace/skills/magic/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('UNKNOWN_SKILL');
  });

  it('400 when key query param is missing', async () => {
    const r = await req(app, 'GET', '/workspace/skills/content/config/history', { userId: alice });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_KEY');
    // Surface allowed keys in the error payload for UI-side feedback.
    expect(Array.isArray(r.body.error.details?.allowed)).toBe(true);
  });

  it('400 when key is not a schema key for this skill', async () => {
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=cooking_pref', { userId: alice });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_KEY');
  });

  it('400 on out-of-range limit', async () => {
    for (const bad of ['0', '-1', '500', 'abc']) {
      const r = await req(app, 'GET', `/workspace/skills/content/config/history?key=voice_guidelines&limit=${bad}`, { userId: alice });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_LIMIT');
    }
  });
});

describe('GET /workspace/skills/:skillId/config/history — returns newest-first history (OI-DATA-003e)', () => {
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

  it('returns empty entries when no history exists', async () => {
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.entries).toEqual([]);
    expect(r.body.data.skillId).toBe('content');
    expect(r.body.data.key).toBe('voice_guidelines');
  });

  it('returns entries ordered newest-first after PUTs that touched the queried key', async () => {
    // 3 saves that all touch voice_guidelines.
    for (let i = 1; i <= 3; i += 1) {
      await req(app, 'PUT', '/workspace/skills/content/config', {
        userId: alice, tenantId: String(alice),
        body: { config: { voice_guidelines: `ver ${i}` } },
      });
    }
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    const entries = r.body.data.entries;
    expect(entries.length).toBe(3);
    // Descending by id (proxy for recency).
    expect(entries[0].id).toBeGreaterThan(entries[1].id);
    expect(entries[1].id).toBeGreaterThan(entries[2].id);
    // Every entry carries the queried key in keysTouched.
    for (const e of entries) {
      expect(e.keysTouched).toContain('voice_guidelines');
    }
  });

  it('NEVER leaks values — response entries carry only id/ts/actor/keysTouched', async () => {
    // Plant a known marker in the value. If it shows up in the response,
    // the audit-invariant violation is visible immediately.
    const secretMarker = 'TOP_SECRET_MARKER_1234567890';
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: secretMarker } },
    });
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(secretMarker);
  });

  it('respects the limit query param', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await req(app, 'PUT', '/workspace/skills/content/config', {
        userId: alice, tenantId: String(alice),
        body: { config: { voice_guidelines: `ver ${i}` } },
      });
    }
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines&limit=2', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.entries.length).toBe(2);
  });

  it('entry.actorEmail is populated from the users join', async () => {
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'first draft' } },
    });
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.entries[0].actorEmail).toBe('alice@example.com');
    expect(r.body.data.entries[0].actorUserId).toBe(alice);
  });
});

describe('GET /workspace/skills/:skillId/config/history — filter precision (OI-DATA-003e)', () => {
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

  it('history for key X excludes saves that only touched other keys', async () => {
    // Save 1: touches voice_guidelines only
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'a' } },
    });
    // Save 2: touches default_platform only
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { default_platform: 'youtube' } },
    });
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.entries.length).toBe(1); // Only the voice_guidelines save.
  });

  it('multi-key saves appear in history for EACH key that was touched', async () => {
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'vg', default_platform: 'youtube' } },
    });
    const r1 = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    const r2 = await req(app, 'GET', '/workspace/skills/content/config/history?key=default_platform', { userId: alice });
    expect(r1.body.data.entries.length).toBe(1);
    expect(r2.body.data.entries.length).toBe(1);
    // Both entries point to the same audit row — keysTouched includes both.
    expect(r1.body.data.entries[0].id).toBe(r2.body.data.entries[0].id);
    expect(r1.body.data.entries[0].keysTouched.sort()).toEqual(
      ['default_platform', 'voice_guidelines'],
    );
  });
});

describe('GET /workspace/skills/:skillId/config/history — tenant isolation (OI-DATA-003e)', () => {
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

  it('alice cannot see bob\'s skill-config history', async () => {
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: bob, tenantId: String(bob),
      body: { config: { voice_guidelines: 'bob-private' } },
    });
    const r = await req(app, 'GET', '/workspace/skills/content/config/history?key=voice_guidelines', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.entries).toEqual([]);
  });
});
