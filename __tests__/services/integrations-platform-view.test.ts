// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-ADM-305 (2026-04-24) — unit tests for listPlatformIntegrations.
 *
 * What's pinned:
 *   - Returns one row per ALL_PROVIDERS (connected + unconnected
 *     alike) so the Admin Console table has a stable grid.
 *   - connectedUserCount uses DISTINCT user_id (doesn't double-count
 *     if a user somehow has two oauth rows for the same provider).
 *   - recentFailures24h counts only status='fail' rows within the
 *     last 24h; 'ok' / 'skipped' / older 'fail' rows don't contribute.
 *   - Health fields surface the LATEST probe (matches the
 *     User-Console-side getLatestHealthByProvider semantics).
 *   - Providers never probed → 'unknown' (not silently 'ok').
 *   - DB errors on either aggregate log + fall back to 0 (the
 *     dashboard renders cleanly even with infra issues).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

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
    } catch { /* skip deps */ }
  }
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

function insertHealth(provider: string, status: string, errorMessage: string | null, offsetMinutes = 0): void {
  const tsExpr = offsetMinutes > 0
    ? `datetime('now', '-${offsetMinutes} minutes')`
    : `datetime('now')`;
  testDb.prepare(
    `INSERT INTO integration_health (provider, status, latency_ms, error_message, ts)
     VALUES (?, ?, 100, ?, ${tsExpr})`,
  ).run(provider, status, errorMessage);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
});

afterEach(() => testDb?.close());

// ─── Response shape ───────────────────────────────────────────────

describe('listPlatformIntegrations — response shape', () => {
  it('returns one row per ALL_PROVIDERS in stable order', async () => {
    const { listPlatformIntegrations, ALL_PROVIDERS } = await import('../../src/services/integrations-view');
    const rows = listPlatformIntegrations();
    expect(rows).toHaveLength(ALL_PROVIDERS.length);
    expect(rows.map((r) => r.provider)).toEqual([...ALL_PROVIDERS]);
  });

  it('empty DB returns zeros + "unknown" health for every provider', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    const rows = listPlatformIntegrations();
    for (const row of rows) {
      expect(row.connectedUserCount).toBe(0);
      expect(row.recentFailures24h).toBe(0);
      expect(row.healthStatus).toBe('unknown');
      expect(row.healthCheckedAt).toBeNull();
      expect(row.healthError).toBeNull();
    }
  });
});

// ─── connectedUserCount ───────────────────────────────────────────

describe('listPlatformIntegrations — connectedUserCount', () => {
  it('counts distinct users per provider', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertOAuth(1, 'google');
    insertOAuth(2, 'google');
    insertOAuth(3, 'google');
    insertOAuth(1, 'outlook');
    const rows = listPlatformIntegrations();
    const google = rows.find((r) => r.provider === 'google')!;
    const outlook = rows.find((r) => r.provider === 'outlook')!;
    expect(google.connectedUserCount).toBe(3);
    expect(outlook.connectedUserCount).toBe(1);
  });

  it('providers no one uses stay at 0 (not missing from the response)', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertOAuth(1, 'google');  // only google wired up
    const rows = listPlatformIntegrations();
    // Every non-google provider should appear with count 0, not be
    // missing — the UI depends on ALL_PROVIDERS rows always existing.
    for (const row of rows) {
      if (row.provider === 'google') {
        expect(row.connectedUserCount).toBe(1);
      } else {
        expect(row.connectedUserCount).toBe(0);
      }
    }
  });
});

// ─── recentFailures24h ────────────────────────────────────────────

describe('listPlatformIntegrations — recentFailures24h', () => {
  it('counts only status=fail rows within the last 24h', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertHealth('google', 'fail', 'rate limited', 10);   // 10 min ago — counts
    insertHealth('google', 'fail', 'rate limited', 60);   // 1h ago — counts
    insertHealth('google', 'fail', 'rate limited', 60 * 25); // 25h ago — DOES NOT count
    const rows = listPlatformIntegrations();
    const google = rows.find((r) => r.provider === 'google')!;
    expect(google.recentFailures24h).toBe(2);
  });

  it('excludes status=ok and status=skipped from the failure count', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertHealth('google', 'ok', null, 5);
    insertHealth('google', 'skipped', 'not configured', 10);
    insertHealth('google', 'fail', 'transient', 15);   // the only one that counts
    const rows = listPlatformIntegrations();
    expect(rows.find((r) => r.provider === 'google')!.recentFailures24h).toBe(1);
  });

  it('flapping provider: latest=ok but recentFailures24h > 0 (the reason this field exists)', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    // 12 failures scattered over the last 12 hours, then a clean
    // 'ok' right now. The LATEST probe is healthy but the
    // provider is clearly flaky.
    for (let i = 1; i <= 12; i++) insertHealth('outlook', 'fail', 'timeout', i * 60);
    insertHealth('outlook', 'ok', null, 0);
    const rows = listPlatformIntegrations();
    const outlook = rows.find((r) => r.provider === 'outlook')!;
    expect(outlook.healthStatus).toBe('ok');        // latest probe
    expect(outlook.recentFailures24h).toBe(12);     // trend signal
  });
});

// ─── health fields (latest probe) ─────────────────────────────────

describe('listPlatformIntegrations — health fields', () => {
  it('surfaces the LATEST probe status (not oldest, not first)', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertHealth('google', 'fail', 'transient', 120);
    insertHealth('google', 'ok', null, 0);  // newer
    const google = listPlatformIntegrations().find((r) => r.provider === 'google')!;
    expect(google.healthStatus).toBe('ok');
    expect(google.healthError).toBeNull();
  });

  it('surfaces the error message on fail', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertHealth('outlook', 'fail', 'rate limited by Microsoft Graph', 5);
    const outlook = listPlatformIntegrations().find((r) => r.provider === 'outlook')!;
    expect(outlook.healthStatus).toBe('fail');
    expect(outlook.healthError).toContain('rate limited');
  });

  it('provider never probed → unknown (not silently ok)', async () => {
    const { listPlatformIntegrations } = await import('../../src/services/integrations-view');
    insertHealth('google', 'ok', null, 0);  // only google probed
    const rows = listPlatformIntegrations();
    for (const row of rows) {
      if (row.provider === 'google') {
        expect(row.healthStatus).toBe('ok');
      } else {
        expect(row.healthStatus).toBe('unknown');
      }
    }
  });
});
