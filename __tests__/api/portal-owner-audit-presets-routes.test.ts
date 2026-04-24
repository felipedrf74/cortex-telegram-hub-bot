// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-005c (2026-04-24) — route + UI tests for saved audit
 * filter presets on the Admin Console.
 *
 * Pins:
 *   Routes
 *     GET    /owner/audit-presets          — lists CALLING admin's presets
 *     POST   /owner/audit-presets          — creates, returns saved row
 *     DELETE /owner/audit-presets/:id      — removes, 404 for cross-owner
 *
 *   Auth chain
 *     401 without portal token
 *     401 without X-Admin-User-Id
 *     403 for non-platform-admin
 *     200 for platform_readonly (personal state — no write gate)
 *
 *   Isolation
 *     Cross-admin: Alice's preset never appears in Bob's GET
 *     Delete-cross-owner: Bob trying to delete Alice's preset → 404
 *
 *   UI (admin-console.html structural pins)
 *     Dropdown + Save/Delete buttons exist
 *     showPage('security') loads presets
 *     Save flow stores form-input values (not auditState)
 *     Delete flow confirms and refreshes
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import express from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
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
  return Number(r.lastInsertRowid);
}

function grantPlatformRole(userId: number, role: string): void {
  testDb.prepare(
    `INSERT OR REPLACE INTO platform_admins (user_id, role, granted_at) VALUES (?, ?, datetime('now'))`,
  ).run(userId, role);
}

import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';

function makeApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

const DEFAULT_TOKEN = 'audit-presets-owner-token-16chars';

async function req(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
  opts: { adminUserId?: number; body?: Record<string, unknown>; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
      const tokenValue = opts.token === undefined ? DEFAULT_TOKEN : opts.token;
      if (tokenValue !== null) headers['Authorization'] = 'Bearer ' + tokenValue;
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

describe('GET /owner/audit-presets (OI-DATA-005c)', () => {
  let app: express.Express;
  let alice: number;
  let bob: number;
  let readonlyAdmin: number;
  let regularUser: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;
  const originalAdminJwt = process.env.PORTAL_ADMIN_JWT_SECRET;

  beforeEach(() => {
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser('alice@example.com');
    bob = seedUser('bob@example.com');
    readonlyAdmin = seedUser('readonly@example.com');
    regularUser = seedUser('regular@example.com');
    grantPlatformRole(alice, 'platform_owner');
    grantPlatformRole(bob, 'platform_admin');
    grantPlatformRole(readonlyAdmin, 'platform_readonly');
    app = makeApp();
  });

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
    if (originalAdminJwt) process.env.PORTAL_ADMIN_JWT_SECRET = originalAdminJwt;
  });

  // ─── Auth chain ────────────────────────────────────────────────

  it('401 without portal token', async () => {
    const r = await req(app, 'GET', '/owner/audit-presets', { token: null });
    expect(r.status).toBe(401);
  });

  it('401 without X-Admin-User-Id', async () => {
    const r = await req(app, 'GET', '/owner/audit-presets');
    expect(r.status).toBe(401);
  });

  it('403 for non-platform-admin user', async () => {
    const r = await req(app, 'GET', '/owner/audit-presets', { adminUserId: regularUser });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
  });

  it('200 for platform_readonly (presets are personal; no write-role gate)', async () => {
    const r = await req(app, 'GET', '/owner/audit-presets', { adminUserId: readonlyAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.presets).toEqual([]);
  });

  // ─── Create + list ─────────────────────────────────────────────

  it('round-trip: POST creates → GET returns the saved preset', async () => {
    const created = await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: {
        name: 'Invite bursts',
        filters: { action: 'tenant.invite.*', q: 'tenant.' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.preset.name).toBe('Invite bursts');

    const list = await req(app, 'GET', '/owner/audit-presets', { adminUserId: alice });
    expect(list.body.data.presets).toHaveLength(1);
    expect(list.body.data.presets[0].filters.action).toBe('tenant.invite.*');
  });

  it('POST with empty name returns 400 INVALID_NAME', async () => {
    const r = await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: { name: '', filters: {} },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_NAME');
  });

  it('POST with filters containing value over 256 chars returns 400 INVALID_FILTERS', async () => {
    const r = await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: { name: 'x', filters: { q: 'a'.repeat(300) } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_FILTERS');
  });

  // ─── Isolation ─────────────────────────────────────────────────

  it('SECURITY: Alice\'s preset never appears in Bob\'s GET', async () => {
    await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: { name: 'alice private', filters: { q: 'secret' } },
    });
    await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: bob,
      body: { name: 'bob own', filters: { q: 'other' } },
    });
    const aliceList = await req(app, 'GET', '/owner/audit-presets', { adminUserId: alice });
    const bobList = await req(app, 'GET', '/owner/audit-presets', { adminUserId: bob });
    expect(aliceList.body.data.presets.map((p: any) => p.name)).toEqual(['alice private']);
    expect(bobList.body.data.presets.map((p: any) => p.name)).toEqual(['bob own']);
  });

  // ─── Delete ────────────────────────────────────────────────────

  it('DELETE removes the caller\'s preset', async () => {
    const created = await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: { name: 'tmp', filters: {} },
    });
    const id = created.body.data.preset.id;
    const del = await req(app, 'DELETE', `/owner/audit-presets/${id}`, { adminUserId: alice });
    expect(del.status).toBe(200);
    const list = await req(app, 'GET', '/owner/audit-presets', { adminUserId: alice });
    expect(list.body.data.presets).toEqual([]);
  });

  it('SECURITY: DELETE cross-owner returns 404 (existence non-leak, OI-TEST-001 pattern)', async () => {
    const created = await req(app, 'POST', '/owner/audit-presets', {
      adminUserId: alice,
      body: { name: 'alice preset', filters: {} },
    });
    const id = created.body.data.preset.id;
    // Bob tries to delete Alice's preset.
    const bobDel = await req(app, 'DELETE', `/owner/audit-presets/${id}`, { adminUserId: bob });
    expect(bobDel.status).toBe(404);
    // Indistinguishable from a never-existed id.
    const neverExisted = await req(app, 'DELETE', `/owner/audit-presets/99999`, { adminUserId: bob });
    expect(neverExisted.status).toBe(404);
    expect(bobDel.body.error.code).toBe(neverExisted.body.error.code);
    // Alice's preset survived.
    const list = await req(app, 'GET', '/owner/audit-presets', { adminUserId: alice });
    expect(list.body.data.presets).toHaveLength(1);
  });

  it('DELETE with bad id returns 400 BAD_REQUEST', async () => {
    const r = await req(app, 'DELETE', `/owner/audit-presets/not-a-number`, { adminUserId: alice });
    expect(r.status).toBe(400);
  });
});

// ─── Admin Console UI structural pins ────────────────────────────

describe('admin-console.html — saved-presets UI (OI-DATA-005c)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/portal/admin-console.html'), 'utf-8',
  );

  it('#fPreset dropdown + Save/Delete buttons exist in the Security panel', () => {
    expect(src).toMatch(/<select id="fPreset"[\s\S]{0,300}?onchange="auditApplyPreset\(\)"/);
    expect(src).toMatch(/onclick="auditSavePreset\(\)"/);
    expect(src).toMatch(/onclick="auditDeletePreset\(\)"/);
  });

  it('showPage("security") loads presets AND the audit rows', () => {
    // Both loaders must fire — loadAudit (existing) + loadAuditPresets
    // (new). A refactor that drops the latter silently breaks the
    // dropdown on page load.
    expect(src).toMatch(/id === ['"]security['"][\s\S]{0,200}?loadAudit\(\);\s*loadAuditPresets\(\)/);
  });

  it('loadAuditPresets fetches /owner/audit-presets', () => {
    expect(src).toMatch(/async function loadAuditPresets[\s\S]{0,400}?fetchJson\(['"]\/owner\/audit-presets['"]\)/);
  });

  it('paintAuditPresetDropdown renders options with esc() on the name + data-filters JSON', () => {
    // Defense in depth: preset names are user-controlled. A future
    // feature that shares presets across admins would immediately
    // need this escape; pinning it now prevents an XSS regression.
    expect(src).toMatch(/paintAuditPresetDropdown[\s\S]{0,600}?esc\(p\.name\)/);
    expect(src).toMatch(/paintAuditPresetDropdown[\s\S]{0,600}?data-filters='\$\{esc\(JSON\.stringify\(p\.filters \|\| \{\}\)\)\}'/);
  });

  it('auditApplyPreset reads from the <option>\'s data-filters, loads into FORM inputs (not auditState)', () => {
    // Semantic invariant: pressing a preset populates the form, but
    // the query only fires after auditApplyFilters() — matches
    // typing manually + Apply. Keeps one code path driving the
    // query.
    expect(src).toMatch(/window\.auditApplyPreset\s*=\s*function/);
    expect(src).toMatch(/auditApplyPreset[\s\S]{0,800}?getElementById\(['"]fActor['"]\)\.value\s*=[\s\S]{0,400}?window\.auditApplyFilters\(\)/);
  });

  it('auditSavePreset snapshots the current FORM inputs (not auditState)', () => {
    // User might type new filters without pressing Apply and save
    // what they SEE — not the last-applied query. Pinning source
    // of truth.
    expect(src).toMatch(/window\.auditSavePreset\s*=\s*async function/);
    expect(src).toMatch(/auditSavePreset[\s\S]{0,900}?getElementById\(['"]fActor['"]\)\.value\.trim\(\)/);
    expect(src).toMatch(/auditSavePreset[\s\S]{0,1500}?fetch[\s\S]{0,400}?\/owner\/audit-presets[\s\S]{0,200}?method:\s*['"]POST['"]/);
  });

  it('auditSavePreset cancels on null prompt (user pressed Cancel)', () => {
    // window.prompt returns null when user cancels; empty string
    // for a blank field. Both should short-circuit WITHOUT posting.
    expect(src).toMatch(/auditSavePreset[\s\S]{0,400}?if \(rawName == null\) return/);
  });

  it('auditDeletePreset prompts confirm() + DELETEs the selected id', () => {
    expect(src).toMatch(/window\.auditDeletePreset\s*=\s*async function/);
    expect(src).toMatch(/auditDeletePreset[\s\S]{0,600}?confirm\(/);
    expect(src).toMatch(/auditDeletePreset[\s\S]{0,1000}?\/owner\/audit-presets\/['"]\s*\+\s*encodeURIComponent\(id\)/);
  });
});
