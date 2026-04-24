// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-005c (2026-04-24) — unit tests for audit-preset-service.
 *
 * Pins the CRUD contract, the personal-isolation guarantee, and
 * the input-validation boundary. The service is the single source
 * of truth for preset semantics — the routes + UI trust it to
 * enforce name length, scope whitelist, and ownership scoping.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
});

afterEach(() => testDb?.close());

// ─── migration 085 — table shape ─────────────────────────────────

describe('migration 085 — audit_filter_presets table', () => {
  it('accepts scope in {workspace, owner}', () => {
    for (const scope of ['workspace', 'owner']) {
      expect(() => testDb.prepare(
        `INSERT INTO audit_filter_presets (owner_user_id, scope, name, filters_json)
         VALUES (?, ?, ?, ?)`,
      ).run(1, scope, 'x', '{}')).not.toThrow();
    }
  });

  it('rejects unknown scopes (CHECK constraint)', () => {
    expect(() => testDb.prepare(
      `INSERT INTO audit_filter_presets (owner_user_id, scope, name, filters_json)
       VALUES (?, ?, ?, ?)`,
    ).run(1, 'platform_admin', 'x', '{}')).toThrow(/CHECK constraint/i);
  });

  it('created_at + updated_at default to now', () => {
    testDb.prepare(
      `INSERT INTO audit_filter_presets (owner_user_id, scope, name, filters_json)
       VALUES (?, ?, ?, ?)`,
    ).run(1, 'owner', 'x', '{}');
    const row = testDb.prepare(
      `SELECT created_at, updated_at FROM audit_filter_presets WHERE name = ?`,
    ).get('x') as { created_at: string; updated_at: string };
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });
});

// ─── createAuditPreset ───────────────────────────────────────────

describe('createAuditPreset', () => {
  it('round-trips: create → list returns the saved preset with normalized filters', async () => {
    const { createAuditPreset, listAuditPresets } = await import('../../src/services/audit-preset-service');
    const saved = createAuditPreset(42, 'owner', 'Invite bursts', {
      action: 'tenant.invite.*',
      from: '2026-04-01',
      q: 'tenant.',
    });
    expect(saved.id).toBeGreaterThan(0);
    expect(saved.ownerUserId).toBe(42);
    expect(saved.scope).toBe('owner');
    expect(saved.name).toBe('Invite bursts');
    expect(saved.filters.action).toBe('tenant.invite.*');

    const listed = listAuditPresets(42, 'owner');
    expect(listed).toHaveLength(1);
    expect(listed[0].filters).toEqual({
      action: 'tenant.invite.*',
      from: '2026-04-01',
      q: 'tenant.',
    });
  });

  it('trims whitespace-only names to empty and rejects with INVALID_NAME', async () => {
    const { createAuditPreset, AuditPresetError } = await import('../../src/services/audit-preset-service');
    for (const badName of ['', '   ', '\t\n']) {
      try {
        createAuditPreset(42, 'owner', badName, {});
        expect.fail('expected INVALID_NAME');
      } catch (e) {
        expect(e).toBeInstanceOf(AuditPresetError);
        expect((e as { code: string }).code).toBe('INVALID_NAME');
      }
    }
  });

  it('rejects names over 64 chars', async () => {
    const { createAuditPreset, AuditPresetError } = await import('../../src/services/audit-preset-service');
    const tooLong = 'x'.repeat(65);
    try {
      createAuditPreset(42, 'owner', tooLong, {});
      expect.fail('expected INVALID_NAME');
    } catch (e) {
      expect((e as AuditPresetError).code).toBe('INVALID_NAME');
    }
  });

  it('rejects unknown scopes', async () => {
    const { createAuditPreset, AuditPresetError } = await import('../../src/services/audit-preset-service');
    try {
      createAuditPreset(42, 'platform_admin' as unknown as 'owner', 'x', {});
      expect.fail('expected INVALID_SCOPE');
    } catch (e) {
      expect((e as AuditPresetError).code).toBe('INVALID_SCOPE');
    }
  });

  it('drops unknown filter keys (forward-compat, no barf)', async () => {
    const { createAuditPreset } = await import('../../src/services/audit-preset-service');
    const saved = createAuditPreset(42, 'owner', 'x', {
      action: 'tenant.*',
      futureField: 'ignored',   // will be dropped
      moreJunk: 42,              // also dropped
    });
    expect(saved.filters.action).toBe('tenant.*');
    expect((saved.filters as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('coerces non-string filter values to strings', async () => {
    const { createAuditPreset } = await import('../../src/services/audit-preset-service');
    const saved = createAuditPreset(42, 'owner', 'x', {
      actor: 42,         // number → "42"
      q: true as unknown as string,  // boolean → "true"
    });
    expect(saved.filters.actor).toBe('42');
    expect(saved.filters.q).toBe('true');
  });

  it('rejects filter values over 256 chars with INVALID_FILTERS', async () => {
    const { createAuditPreset, AuditPresetError } = await import('../../src/services/audit-preset-service');
    try {
      createAuditPreset(42, 'owner', 'x', { q: 'a'.repeat(257) });
      expect.fail('expected INVALID_FILTERS');
    } catch (e) {
      expect((e as AuditPresetError).code).toBe('INVALID_FILTERS');
    }
  });

  it('allows duplicate names under the same owner+scope', async () => {
    // User iterates on a filter name — no uniqueness constraint.
    const { createAuditPreset } = await import('../../src/services/audit-preset-service');
    createAuditPreset(42, 'owner', 'Invite bursts', { action: 'tenant.invite.*' });
    expect(() => createAuditPreset(42, 'owner', 'Invite bursts', { action: 'tenant.invite.revoke' })).not.toThrow();
  });
});

// ─── listAuditPresets ────────────────────────────────────────────

describe('listAuditPresets', () => {
  it('returns presets newest-first (by updated_at)', async () => {
    const { createAuditPreset, listAuditPresets } = await import('../../src/services/audit-preset-service');
    createAuditPreset(42, 'owner', 'First', {});
    createAuditPreset(42, 'owner', 'Second', {});
    createAuditPreset(42, 'owner', 'Third', {});
    const out = listAuditPresets(42, 'owner');
    // All three visible, newest first
    expect(out).toHaveLength(3);
    expect(out[0].name).toBe('Third');
  });

  it('SECURITY: scopes by owner — caller cannot see another user\'s presets', async () => {
    const { createAuditPreset, listAuditPresets } = await import('../../src/services/audit-preset-service');
    createAuditPreset(42, 'owner', 'alice preset', { q: 'a' });
    createAuditPreset(99, 'owner', 'bob preset', { q: 'b' });
    const alice = listAuditPresets(42, 'owner');
    const bob = listAuditPresets(99, 'owner');
    expect(alice.map((p) => p.name)).toEqual(['alice preset']);
    expect(bob.map((p) => p.name)).toEqual(['bob preset']);
  });

  it('isolates by scope: a workspace preset does not leak into owner listing', async () => {
    const { createAuditPreset, listAuditPresets } = await import('../../src/services/audit-preset-service');
    createAuditPreset(42, 'workspace', 'workspace preset', {});
    createAuditPreset(42, 'owner', 'owner preset', {});
    const workspaceList = listAuditPresets(42, 'workspace');
    const ownerList = listAuditPresets(42, 'owner');
    expect(workspaceList.map((p) => p.name)).toEqual(['workspace preset']);
    expect(ownerList.map((p) => p.name)).toEqual(['owner preset']);
  });

  it('invalid inputs return an empty array (no throw)', async () => {
    const { listAuditPresets } = await import('../../src/services/audit-preset-service');
    expect(listAuditPresets(0, 'owner')).toEqual([]);
    expect(listAuditPresets(-1, 'owner')).toEqual([]);
    expect(listAuditPresets(NaN, 'owner')).toEqual([]);
    expect(listAuditPresets(42, 'garbage' as unknown as 'owner')).toEqual([]);
  });

  it('malformed filters_json in DB falls back to empty filters (no crash)', async () => {
    const { listAuditPresets } = await import('../../src/services/audit-preset-service');
    testDb.prepare(
      `INSERT INTO audit_filter_presets (owner_user_id, scope, name, filters_json)
       VALUES (?, 'owner', ?, ?)`,
    ).run(42, 'corrupt', '{not valid json');
    const out = listAuditPresets(42, 'owner');
    expect(out).toHaveLength(1);
    expect(out[0].filters).toEqual({});
  });
});

// ─── deleteAuditPreset ───────────────────────────────────────────

describe('deleteAuditPreset', () => {
  it('deletes a preset owned by the caller', async () => {
    const { createAuditPreset, deleteAuditPreset, listAuditPresets } = await import('../../src/services/audit-preset-service');
    const saved = createAuditPreset(42, 'owner', 'temp', {});
    deleteAuditPreset(42, saved.id);
    expect(listAuditPresets(42, 'owner')).toEqual([]);
  });

  it('SECURITY: refuses to delete a preset owned by someone else (NOT_FOUND, not FORBIDDEN)', async () => {
    // Matches OI-TEST-001 existence-non-leak: a user guessing
    // another user's preset id can't distinguish "exists but
    // forbidden" from "never existed."
    const { createAuditPreset, deleteAuditPreset, listAuditPresets, AuditPresetError } = await import('../../src/services/audit-preset-service');
    const saved = createAuditPreset(42, 'owner', 'alice preset', {});
    try {
      deleteAuditPreset(99, saved.id);  // Bob trying to delete Alice's
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as AuditPresetError).code).toBe('NOT_FOUND');
    }
    // Alice's preset still exists.
    expect(listAuditPresets(42, 'owner')).toHaveLength(1);
  });

  it('returns NOT_FOUND for a never-existed id (indistinguishable from cross-owner)', async () => {
    const { deleteAuditPreset, AuditPresetError } = await import('../../src/services/audit-preset-service');
    try {
      deleteAuditPreset(42, 99999);
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as AuditPresetError).code).toBe('NOT_FOUND');
    }
  });
});
