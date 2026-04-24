// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-ADM-305 (2026-04-24) — integration tests for
 * GET /owner/integrations.
 *
 * Pins:
 *   - 401 without the owner-console token
 *   - 401 without X-Admin-User-Id (legacy identity mode; OI-SEC-001
 *     secure mode has its own tests)
 *   - 403 for non-platform-admin caller
 *   - 200 for platform_readonly (read-only telemetry; no higher gate)
 *   - Response shape matches listPlatformIntegrations contract
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
    } catch { /* skip incompatible migrations */ }
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

function insertOAuth(userId: number, provider: string): void {
  testDb.prepare(
    `INSERT INTO user_oauth_tokens (
       user_id, provider, access_token, refresh_token, token_type,
       expires_at, scopes, created_at, updated_at
     ) VALUES (?, ?, 'at', 'rt', 'Bearer', NULL, '[]',
               datetime('now'), datetime('now'))`,
  ).run(userId, provider);
}

import { createPortalOwnerRouter } from '../../src/api/portal-owner-router';

function makeApp(): express.Express {
  const app = express();
  app.use('/owner', createPortalOwnerRouter());
  return app;
}

const DEFAULT_TOKEN = 'owner-console-token-for-tests-at-least-16-chars';

async function req(
  app: express.Express,
  method: 'GET',
  urlPath: string,
  opts: { adminUserId?: number; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminUserId !== undefined) headers['X-Admin-User-Id'] = String(opts.adminUserId);
      const tokenValue = opts.token === undefined ? DEFAULT_TOKEN : opts.token;
      if (tokenValue !== null) headers['Authorization'] = 'Bearer ' + tokenValue;
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
      request.end();
    });
  });
}

describe('GET /owner/integrations (OI-ADM-305)', () => {
  let app: express.Express;
  let owner: number;
  let readonlyAdmin: number;
  let regularUser: number;
  const originalOwnerToken = process.env.PORTAL_OWNER_TOKEN;
  const originalAdminJwt = process.env.PORTAL_ADMIN_JWT_SECRET;

  beforeEach(() => {
    // Force legacy mode (OI-SEC-001 secure mode has its own tests).
    delete process.env.PORTAL_ADMIN_JWT_SECRET;
    process.env.PORTAL_OWNER_TOKEN = DEFAULT_TOKEN;

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    owner = seedUser('owner@e.com');
    readonlyAdmin = seedUser('readonly@e.com');
    regularUser = seedUser('alice@e.com');
    grantPlatformRole(owner, 'platform_owner');
    grantPlatformRole(readonlyAdmin, 'platform_readonly');
    app = makeApp();
  });

  afterEach(() => {
    testDb?.close();
    process.env.PORTAL_OWNER_TOKEN = originalOwnerToken;
    if (originalAdminJwt) process.env.PORTAL_ADMIN_JWT_SECRET = originalAdminJwt;
  });

  it('rejects unauthenticated access with 401 (no token)', async () => {
    const r = await req(app, 'GET', '/owner/integrations', { token: null });
    expect(r.status).toBe(401);
  });

  it('rejects missing X-Admin-User-Id with 401', async () => {
    const r = await req(app, 'GET', '/owner/integrations');
    expect(r.status).toBe(401);
  });

  it('rejects a regular (non-platform) user with 403', async () => {
    const r = await req(app, 'GET', '/owner/integrations', { adminUserId: regularUser });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_PLATFORM_ADMIN');
  });

  it('platform_readonly can read (it\'s telemetry, no write-role gate)', async () => {
    const r = await req(app, 'GET', '/owner/integrations', { adminUserId: readonlyAdmin });
    expect(r.status).toBe(200);
  });

  it('returns an array of integration rows for platform_owner', async () => {
    // Seed some state so the response has data, not all zeros.
    insertOAuth(owner, 'google');
    insertOAuth(readonlyAdmin, 'google');
    insertOAuth(regularUser, 'outlook');
    testDb.prepare(
      `INSERT INTO integration_health (provider, status, error_message, ts)
       VALUES ('google', 'ok', NULL, datetime('now'))`,
    ).run();

    const r = await req(app, 'GET', '/owner/integrations', { adminUserId: owner });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const rows = r.body.data.integrations as Array<{
      provider: string;
      connectedUserCount: number;
      recentFailures24h: number;
      healthStatus: string;
    }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const google = rows.find((x) => x.provider === 'google')!;
    expect(google.connectedUserCount).toBe(2);
    expect(google.healthStatus).toBe('ok');
    const outlook = rows.find((x) => x.provider === 'outlook')!;
    expect(outlook.connectedUserCount).toBe(1);
  });

  it('every response row carries the full platform-view shape', async () => {
    const r = await req(app, 'GET', '/owner/integrations', { adminUserId: owner });
    for (const row of r.body.data.integrations) {
      expect(row).toHaveProperty('provider');
      expect(row).toHaveProperty('connectedUserCount');
      expect(row).toHaveProperty('recentFailures24h');
      expect(row).toHaveProperty('healthStatus');
      expect(row).toHaveProperty('healthCheckedAt');
      expect(row).toHaveProperty('healthError');
    }
  });
});

// ─── Admin Console UI structural pins ────────────────────────────

describe('admin-console.html — Integrations page (OI-ADM-305)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/portal/admin-console.html'), 'utf-8');

  it('legacy "Provider health lives in the legacy portal" empty state is GONE', () => {
    expect(src).not.toContain('Provider health lives in the legacy portal');
  });

  it('Integrations section renders a panel with #ownerIntegrationsTable + #ownerIntegrationsMeta', () => {
    expect(src).toMatch(/<section[^>]*data-page="integrations"[\s\S]*?id="ownerIntegrationsTable"/);
    expect(src).toMatch(/<section[^>]*data-page="integrations"[\s\S]*?id="ownerIntegrationsMeta"/);
  });

  it('showPage("integrations") calls loadOwnerIntegrations', () => {
    expect(src).toMatch(/if \(id === ['"]integrations['"]\)\s*loadOwnerIntegrations\(\)/);
  });

  it('loadOwnerIntegrations fetches /owner/integrations via fetchJson', () => {
    expect(src).toMatch(/loadOwnerIntegrations[\s\S]{0,500}?fetchJson\(['"]\/owner\/integrations['"]\)/);
  });

  it('defensively guards r.data.integrations with Array.isArray', () => {
    expect(src).toMatch(/const rows = Array\.isArray\(r\?\.data\?\.integrations\)\s*\?\s*r\.data\.integrations\s*:\s*\[\]/);
  });

  it('renders 5 columns in the Integrations table (provider / connected users / failures / health / last checked)', () => {
    expect(src).toMatch(/<th>Provider<\/th>[\s\S]{0,300}?Connected users[\s\S]{0,300}?Failures \(24h\)[\s\S]{0,300}?Platform health[\s\S]{0,300}?Last checked/);
  });

  it('renderOwnerIntegrationRow highlights non-zero recentFailures24h with danger color', () => {
    // Flapping provider visibility invariant from OI-ADM-305 — a
    // provider that's currently 'ok' but has failures in the 24h
    // window should draw the eye.
    expect(src).toMatch(/recentFailures24h \|\| 0\) > 0[\s\S]{0,400}?var\(--danger/);
  });

  it('healthStatus → pill class map handles ok / fail / skipped / unknown', () => {
    expect(src).toMatch(
      /healthStatus === ['"]ok['"]\s*\?\s*['"]ready['"][\s\S]{0,200}?['"]fail['"]\s*\?\s*['"]danger['"][\s\S]{0,200}?['"]skipped['"]\s*\?\s*['"]info['"]/,
    );
  });

  it('esc() runs on provider + healthError (defense in depth)', () => {
    expect(src).toMatch(/renderOwnerIntegrationRow[\s\S]{0,1500}?esc\(x\.provider\)/);
    expect(src).toMatch(/renderOwnerIntegrationRow[\s\S]{0,2000}?esc\(x\.healthError\)/);
  });

  it('meta counter shows total connected user-connections', () => {
    expect(src).toMatch(/totalConnected[\s\S]{0,200}?total user-connections across/);
  });

  it('has a footer note explaining what "failures (24h)" means', () => {
    expect(src).toMatch(/Failure count is probes that returned.*fail.*last 24 hours/);
  });
});
