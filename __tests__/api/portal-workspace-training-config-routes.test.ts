// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route tests for Training skill config (OI-DATA-003b, 2026-04-23).
 * Mirrors the Secretary route test file.
 *
 * Pins the Training-SPECIFIC pieces of the HTTP surface:
 *   - GET returns 6 Training-scoped defaults + schemaKeys
 *   - PUT with Content's `voice_guidelines` field → 400 with
 *     Training's 6-field allowed list in details
 *   - Home dependency `training.goals.set` flips missing → ready
 *     when `goals` is set, ready → missing when cleared
 *   - cost-privacy invariant still holds
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

describe('Training config routes (OI-DATA-003b)', () => {
  let app: express.Express;
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-train@e.com');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('GET /workspace/skills/training/config returns 6 default fields + schemaKeys', async () => {
    const r = await req(app, 'GET', '/workspace/skills/training/config', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.skillId).toBe('training');
    expect(r.body.data.config.preferred_training_days).toBe('four_days');
    expect(r.body.data.config.recovery_priority).toBe('balanced');
    expect(r.body.data.schemaKeys.sort()).toEqual([
      'constraints_and_injuries',
      'equipment_available',
      'extra_notes',
      'goals',
      'preferred_training_days',
      'recovery_priority',
    ]);
  });

  it('PUT valid Training body saves', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/training/config', {
      userId: alice, tenantId: String(alice),
      body: { config: {
        goals: 'Sub-2h half by October',
        preferred_training_days: 'five_days',
        recovery_priority: 'maximum',
      } },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.config.goals).toBe('Sub-2h half by October');
    expect(r.body.data.config.preferred_training_days).toBe('five_days');
  });

  it('PUT with Content-only field (voice_guidelines) → 400 with Training allowed fields', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/training/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'wrong skill' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details?.allowed).toEqual(expect.arrayContaining([
      'goals', 'equipment_available', 'constraints_and_injuries',
      'preferred_training_days', 'recovery_priority', 'extra_notes',
    ]));
  });

  it('Home dep training.goals.set: missing before → ready after setting goals → missing after clearing', async () => {
    let h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    let dep = h.body.data.dependencies.items.find((d: any) => d.id === 'training.goals.set');
    expect(dep).toBeTruthy();
    expect(dep.status).toBe('missing');
    expect(dep.cta.href).toBe('#/skills/training/configuration');

    await req(app, 'PUT', '/workspace/skills/training/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { goals: 'Sub-2h half by October' } },
    });
    h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    dep = h.body.data.dependencies.items.find((d: any) => d.id === 'training.goals.set');
    expect(dep.status).toBe('ready');
    expect(dep.cta).toBeNull();

    await req(app, 'PUT', '/workspace/skills/training/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { goals: '' } },
    });
    h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    dep = h.body.data.dependencies.items.find((d: any) => d.id === 'training.goals.set');
    expect(dep.status).toBe('missing');
  });

  it('cost-privacy invariant still holds with Training config in the mix', async () => {
    // 4-decimal cost marker — can't appear in ISO-8601 timestamps.
    const COST_MARKER = '123.4567';
    testDb.prepare(
      `INSERT INTO api_usage (user_id, ts, category, model, cost_usd)
       VALUES (?, datetime('now'), 'chat', 'gemini', ${COST_MARKER})`,
    ).run(alice);
    await req(app, 'PUT', '/workspace/skills/training/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { goals: 'private goal' } },
    });
    const h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const serialized = JSON.stringify(h.body);
    expect(serialized).not.toMatch(/costUsd/i);
    expect(serialized).not.toContain(COST_MARKER);
  });
});
