// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for Secretary skill config (OI-DATA-003a).
 *
 * The generic route glue (auth, admin-only PUT, audit redaction,
 * nested+flat body, unknown field 400) is already pinned for
 * Content in portal-workspace-skill-config-routes.test.ts. Because
 * the route accepts any `isSkillId(skillId)` value, those pins
 * cover Secretary too.
 *
 * This file pins the Secretary-SPECIFIC pieces:
 *   - GET returns the 6 Secretary fields with defaults
 *   - PUT with Content's `voice_guidelines` field → 400 (wrong skill)
 *   - Home dependency `secretary.routines.set` flips missing → ready
 *     when daily_routines is set and ready → missing when cleared
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
  method: 'GET' | 'PUT',
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

describe('Secretary config routes (OI-DATA-003a)', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-sec@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('GET /workspace/skills/secretary/config returns 6 default fields + schemaKeys', async () => {
    const r = await req(app, 'GET', '/workspace/skills/secretary/config', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.skillId).toBe('secretary');
    expect(r.body.data.config.focus_block_policy).toBe('none');
    expect(r.body.data.config.primary_calendar).toBe('none');
    expect(r.body.data.config.interruption_tolerance).toBe('medium');
    expect(r.body.data.schemaKeys.sort()).toEqual([
      'daily_routines',
      'extra_notes',
      'focus_block_policy',
      'interruption_tolerance',
      'primary_calendar',
      'priority_rules',
    ]);
  });

  it('PUT valid Secretary body saves', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: {
        daily_routines: 'Morning writing, afternoon meetings.',
        focus_block_policy: 'mornings',
        primary_calendar: 'google',
      } },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.config.daily_routines).toBe('Morning writing, afternoon meetings.');
    expect(r.body.data.config.focus_block_policy).toBe('mornings');
  });

  it('PUT with Content-only field (voice_guidelines) → 400 with allowed Secretary fields', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'wrong skill' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details?.allowed).toEqual(expect.arrayContaining([
      'daily_routines', 'priority_rules', 'focus_block_policy',
      'primary_calendar', 'interruption_tolerance', 'extra_notes',
    ]));
  });

  it('Home dep secretary.routines.set: missing before → ready after setting daily_routines → missing after clearing', async () => {
    // Before.
    let h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    let dep = h.body.data.dependencies.items.find((d: any) => d.id === 'secretary.routines.set');
    expect(dep).toBeTruthy();
    expect(dep.status).toBe('missing');
    expect(dep.cta.href).toBe('#/skills/secretary/configuration');

    // Set routines.
    await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { daily_routines: 'wake early, write first' } },
    });
    h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    dep = h.body.data.dependencies.items.find((d: any) => d.id === 'secretary.routines.set');
    expect(dep.status).toBe('ready');
    expect(dep.cta).toBeNull();

    // Clear via empty string (service maps empty → null internally).
    await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { daily_routines: '' } },
    });
    h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    dep = h.body.data.dependencies.items.find((d: any) => d.id === 'secretary.routines.set');
    expect(dep.status).toBe('missing');
  });

  it('cost-privacy invariant still holds with Secretary config in the mix', async () => {
    testDb.prepare(
      `INSERT INTO api_usage (user_id, ts, category, model, cost_usd)
       VALUES (?, datetime('now'), 'chat', 'gemini', 9.99)`,
    ).run(alice);
    await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { daily_routines: 'secret routine' } },
    });
    const h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const serialized = JSON.stringify(h.body);
    expect(serialized).not.toMatch(/costUsd/i);
    expect(serialized).not.toMatch(/9\.99/);
  });
});
