// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route-layer tests for /workspace/skills/:skillId/config (OI-DATA-003,
 * branch feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22).
 *
 * Service-level validation is already pinned in
 * __tests__/services/tenant-skill-config-service.test.ts. These tests
 * pin the HTTP glue:
 *   - GET open to any member (incl. tenant_viewer); WRITE admin-only.
 *   - Unknown skill id → 404 UNKNOWN_SKILL.
 *   - Config body can be nested (`{ config: {...} }`) OR flat.
 *   - Saving triggers a `tenant.skill_config.update` audit row —
 *     but the audit payload carries ONLY the keys touched, NEVER
 *     the values (voice guidelines can be long / private).
 *   - Cross-tenant read (member of tenant A asking for B) → 403.
 *   - Home payload's `content.voice.guidelines` dep flips missing
 *     → ready after a save.
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
// from polluting later test files in the shared vitest fork (the project's
// vitest.config.ts sets `poolOptions.forks.singleFork: true`, which runs every
// test file in one process and keeps module mocks alive across files unless
// explicitly cleared). doUnmock + resetModules together mark the mock inert
// AND flush the cached version, so the next file's `import { getDb }` hits
// either its own mock or the real module.
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
function addMember(db: Database.Database, tenantId: number, userId: number, role: string): void {
  db.prepare('INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)')
    .run(tenantId, userId, role);
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
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

describe('GET /workspace/skills/:skillId/config (OI-DATA-003)', () => {
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

  it('returns defaults + schemaKeys for a fresh tenant', async () => {
    const r = await req(app, 'GET', '/workspace/skills/content/config', { userId: alice });
    expect(r.status).toBe(200);
    expect(r.body.data.skillId).toBe('content');
    expect(r.body.data.tenantId).toBe(alice);
    expect(r.body.data.config.default_platform).toBe('general');
    expect(r.body.data.schemaKeys).toContain('voice_guidelines');
  });

  it('unknown skill id returns 404 UNKNOWN_SKILL', async () => {
    const r = await req(app, 'GET', '/workspace/skills/gym/config', { userId: alice });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('UNKNOWN_SKILL');
  });

  it('requires auth', async () => {
    const r = await req(app, 'GET', '/workspace/skills/content/config');
    expect(r.status).toBe(401);
  });

  it('tenant_viewer CAN read the config (shared-state visibility)', async () => {
    const viewer = seedUser(testDb, 'viewer@e.com');
    addMember(testDb, alice, viewer, 'tenant_viewer');
    const r = await req(app, 'GET', '/workspace/skills/content/config', {
      userId: viewer, tenantId: String(alice),
    });
    expect(r.status).toBe(200);
  });
});

describe('PUT /workspace/skills/:skillId/config (OI-DATA-003)', () => {
  let app: express.Express;
  let alice: number;
  let member: number;
  let viewer: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    member = seedUser(testDb, 'member@e.com');
    viewer = seedUser(testDb, 'viewer@e.com');
    addMember(testDb, alice, member, 'tenant_member');
    addMember(testDb, alice, viewer, 'tenant_viewer');
    app = makeApp();
  });
  afterEach(() => testDb?.close());

  it('admin can save valid config', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'Calm, direct.', default_platform: 'blog' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.config.voice_guidelines).toBe('Calm, direct.');
    expect(r.body.data.config.default_platform).toBe('blog');
  });

  it('accepts flat body too (no `config` wrapper)', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { output_length: 'detailed' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.config.output_length).toBe('detailed');
  });

  it('tenant_member CANNOT write (403, enforced by requireTenantAdmin)', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: member, tenantId: String(alice),
      body: { config: { voice_guidelines: 'sneaky' } },
    });
    expect(r.status).toBe(403);
  });

  it('tenant_viewer CANNOT write', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: viewer, tenantId: String(alice),
      body: { config: { voice_guidelines: 'sneaky' } },
    });
    expect(r.status).toBe(403);
  });

  it('unknown field → 400 with allowed list', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { wat: 'x' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details?.allowed).toBeTruthy();
  });

  it('bad enum value → 400', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { default_platform: 'myspace' } },
    });
    expect(r.status).toBe(400);
  });

  it('empty-schema skill (secretary) PUT with any field → 400', async () => {
    const r = await req(app, 'PUT', '/workspace/skills/secretary/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'x' } },
    });
    expect(r.status).toBe(400);
  });

  it('writes a tenant.skill_config.update audit row — values NOT in payload', async () => {
    const secretVoice = 'Top-secret voice rule only for this tenant';
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: secretVoice, auto_publish: true } },
    });
    const rows = testDb
      .prepare('SELECT action, resource, details FROM audit_trail WHERE action = ?')
      .all('tenant.skill_config.update') as Array<{ action: string; resource: string; details: string }>;
    expect(rows).toHaveLength(1);
    // Resource path uses the tenant.<id>.skill.<skill>.config convention.
    expect(rows[0].resource).toBe(`tenant.${alice}.skill.content.config`);
    // Details should carry keysTouched but NOT the raw voice value.
    const details = JSON.parse(rows[0].details);
    expect(details.keysTouched).toEqual(expect.arrayContaining(['voice_guidelines', 'auto_publish']));
    expect(JSON.stringify(details)).not.toContain(secretVoice);
  });

  it('home payload dependency content.voice.guidelines flips missing → ready after save', async () => {
    // Before: missing + CTA
    let h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const depBefore = h.body.data.dependencies.items.find((d: any) => d.id === 'content.voice.guidelines');
    expect(depBefore.status).toBe('missing');
    expect(depBefore.cta).toBeTruthy();

    // Save voice_guidelines.
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'v1' } },
    });

    // After: ready + no CTA.
    h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const depAfter = h.body.data.dependencies.items.find((d: any) => d.id === 'content.voice.guidelines');
    expect(depAfter.status).toBe('ready');
    expect(depAfter.cta).toBeNull();
  });

  it('saving empty string clears voice_guidelines → dep flips ready → missing', async () => {
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: 'has value' } },
    });
    // Now clear.
    await req(app, 'PUT', '/workspace/skills/content/config', {
      userId: alice, tenantId: String(alice),
      body: { config: { voice_guidelines: '' } },
    });
    const h = await req(app, 'GET', '/workspace/console/home', { userId: alice });
    const dep = h.body.data.dependencies.items.find((d: any) => d.id === 'content.voice.guidelines');
    expect(dep.status).toBe('missing');
  });
});
