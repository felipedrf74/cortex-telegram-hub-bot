// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-007 (2026-04-24) — unit tests for the
 * listUserIntegrations view helper.
 *
 * Pins:
 *   - ALL_PROVIDERS appear in the response (connected + unconnected
 *     alike) — the Integrations page depends on this to render
 *     "connect these" CTAs.
 *   - Order matches ALL_PROVIDERS (deterministic; UI doesn't
 *     re-shuffle between requests).
 *   - An oauth row is correctly joined to its provider row.
 *   - A disconnected provider returns `connected: false` with null
 *     connectedAt/expiresAt and [] scopes.
 *   - Malformed scopes JSON does NOT crash — falls back to [].
 *   - Health probe join: ok/fail/skipped pass through; missing
 *     probe falls back to 'unknown' (not silently ok).
 *   - Cross-user isolation: calling listUserIntegrations(userA)
 *     never leaks userB's rows.
 *   - Invalid userId returns an all-disconnected list (no throw).
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

function insertOAuthRow(
  userId: number,
  provider: string,
  opts: {
    createdAt?: string;
    expiresAt?: string | null;
    scopes?: string;   // raw JSON; caller can pass malformed
  } = {},
): void {
  testDb.prepare(
    `INSERT INTO user_oauth_tokens (
       user_id, provider, access_token, refresh_token, token_type,
       expires_at, scopes, created_at, updated_at
     ) VALUES (?, ?, 'at', 'rt', 'Bearer', ?, ?, ?, datetime('now'))`,
  ).run(
    userId,
    provider,
    opts.expiresAt ?? null,
    opts.scopes ?? '[]',
    opts.createdAt ?? '2026-04-01T00:00:00Z',
  );
}

function insertHealthRow(provider: string, status: string, errorMessage: string | null): void {
  testDb.prepare(
    `INSERT INTO integration_health (provider, status, latency_ms, error_message, ts)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(provider, status, 100, errorMessage);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb?.close();
});

// ─── Provider list invariants ────────────────────────────────────

describe('ALL_PROVIDERS', () => {
  it('includes all 8 product-supported providers in a stable order', async () => {
    const { ALL_PROVIDERS } = await import('../../src/services/integrations-view');
    // Order matters — UI depends on it for grid layout. If a new
    // provider is added, append rather than reorder.
    expect([...ALL_PROVIDERS]).toEqual([
      'google', 'outlook', 'notion', 'todoist',
      'strava', 'whoop', 'fitbit', 'garmin',
    ]);
  });
});

// ─── listUserIntegrations — response shape ───────────────────────

describe('listUserIntegrations — response shape', () => {
  it('returns one row per provider in ALL_PROVIDERS order', async () => {
    const { listUserIntegrations, ALL_PROVIDERS } = await import('../../src/services/integrations-view');
    const rows = listUserIntegrations(42);
    expect(rows).toHaveLength(ALL_PROVIDERS.length);
    expect(rows.map((r) => r.provider)).toEqual([...ALL_PROVIDERS]);
  });

  it('all-disconnected user returns connected=false + nulls + empty scopes', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    const rows = listUserIntegrations(42);
    for (const row of rows) {
      expect(row.connected).toBe(false);
      expect(row.connectedAt).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.scopes).toEqual([]);
      expect(row.healthStatus).toBe('unknown');
    }
  });
});

// ─── OAuth row join ──────────────────────────────────────────────

describe('listUserIntegrations — oauth row join', () => {
  it('marks a provider as connected when the user has a token row', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertOAuthRow(42, 'google', {
      createdAt: '2026-04-01T12:00:00Z',
      expiresAt: '2026-05-01T12:00:00Z',
      scopes: JSON.stringify(['https://www.googleapis.com/auth/calendar']),
    });
    const rows = listUserIntegrations(42);
    const google = rows.find((r) => r.provider === 'google');
    expect(google).toBeDefined();
    expect(google!.connected).toBe(true);
    expect(google!.connectedAt).toBe('2026-04-01T12:00:00Z');
    expect(google!.expiresAt).toBe('2026-05-01T12:00:00Z');
    expect(google!.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('connected=true with null expiresAt when the provider issues non-expiring tokens', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertOAuthRow(42, 'notion', { expiresAt: null });
    const notion = listUserIntegrations(42).find((r) => r.provider === 'notion')!;
    expect(notion.connected).toBe(true);
    expect(notion.expiresAt).toBeNull();
  });

  it('malformed scopes JSON falls back to [] (defensive — never crashes the whole view)', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertOAuthRow(42, 'google', { scopes: '{not valid json' });
    const google = listUserIntegrations(42).find((r) => r.provider === 'google')!;
    expect(google.connected).toBe(true);
    expect(google.scopes).toEqual([]);
  });

  it('non-string elements in scopes array are filtered out (defensive parse)', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertOAuthRow(42, 'google', { scopes: JSON.stringify(['valid', 123, null, 'also-valid']) });
    const google = listUserIntegrations(42).find((r) => r.provider === 'google')!;
    expect(google.scopes).toEqual(['valid', 'also-valid']);
  });
});

// ─── Health probe join ───────────────────────────────────────────

describe('listUserIntegrations — health probe join', () => {
  it('latest probe result threads through (ok)', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertHealthRow('google', 'ok', null);
    const google = listUserIntegrations(42).find((r) => r.provider === 'google')!;
    expect(google.healthStatus).toBe('ok');
    expect(google.healthCheckedAt).not.toBeNull();
    expect(google.healthError).toBeNull();
  });

  it('latest probe result threads through (fail + error message)', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertHealthRow('outlook', 'fail', 'rate limited by Microsoft Graph');
    const outlook = listUserIntegrations(42).find((r) => r.provider === 'outlook')!;
    expect(outlook.healthStatus).toBe('fail');
    expect(outlook.healthError).toContain('rate limited');
  });

  it('latest-per-provider semantics: only the most recent ts wins', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertHealthRow('google', 'fail', 'transient error');
    insertHealthRow('google', 'ok', null); // newer row (higher id)
    const google = listUserIntegrations(42).find((r) => r.provider === 'google')!;
    expect(google.healthStatus).toBe('ok');
    expect(google.healthError).toBeNull();
  });

  it('providers without a probe fall back to "unknown" (not silently "ok")', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertHealthRow('google', 'ok', null);  // only google is probed
    const rows = listUserIntegrations(42);
    // Every provider other than google should be 'unknown'.
    for (const row of rows) {
      if (row.provider === 'google') {
        expect(row.healthStatus).toBe('ok');
      } else {
        expect(row.healthStatus).toBe('unknown');
      }
    }
  });
});

// ─── Cross-user isolation ────────────────────────────────────────

describe('listUserIntegrations — cross-user isolation', () => {
  it('returns only the CALLER user\'s rows, never another user\'s', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    insertOAuthRow(42, 'google');
    insertOAuthRow(43, 'outlook');
    const alice = listUserIntegrations(42);
    const bob = listUserIntegrations(43);
    expect(alice.find((r) => r.provider === 'google')!.connected).toBe(true);
    expect(alice.find((r) => r.provider === 'outlook')!.connected).toBe(false);
    expect(bob.find((r) => r.provider === 'outlook')!.connected).toBe(true);
    expect(bob.find((r) => r.provider === 'google')!.connected).toBe(false);
  });

  it('invalid userId (0/negative/NaN) returns all-disconnected WITHOUT throwing', async () => {
    const { listUserIntegrations } = await import('../../src/services/integrations-view');
    for (const bad of [0, -1, NaN]) {
      const rows = listUserIntegrations(bad);
      expect(rows.every((r) => !r.connected)).toBe(true);
    }
  });
});
