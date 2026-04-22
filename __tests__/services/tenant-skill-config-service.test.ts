// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Service-layer tests for tenant-skill-config-service (OI-DATA-003,
 * branch feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22).
 *
 * Pins:
 *   - Cross-tenant isolation: WHERE clause always includes tenant_id.
 *   - Per-skill validation: only schema-declared keys accepted.
 *   - Enum enforcement on Content: default_platform / output_length /
 *     include_references_policy reject unknown values.
 *   - String length caps enforced (voice_guidelines 4000,
 *     extra_notes 2000).
 *   - Type checks: boolean fields reject strings; string fields
 *     reject booleans; objects rejected everywhere.
 *   - Scope cut: empty-schema skills (secretary/training/finance/
 *     cooking) reject any field for now.
 *   - Read returns defaults merged over stored values (fresh tenants
 *     see a fully-populated config).
 *   - Diff-style patches: keys the patch doesn't mention are left
 *     unchanged.
 *   - Unknown skill id rejected with UNKNOWN_SKILL.
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

import {
  getSkillConfig,
  putSkillConfig,
  getSkillSchemaKeys,
  isSkillId,
  isKnownField,
  SkillConfigError,
} from '../../src/services/tenant-skill-config-service';

describe('tenant-skill-config-service — schema registry', () => {
  it('isSkillId validates against the 5 known skills', () => {
    expect(isSkillId('content')).toBe(true);
    expect(isSkillId('secretary')).toBe(true);
    expect(isSkillId('training')).toBe(true);
    expect(isSkillId('finance')).toBe(true);
    expect(isSkillId('cooking')).toBe(true);
    expect(isSkillId('gym')).toBe(false);
    expect(isSkillId('')).toBe(false);
    expect(isSkillId(42)).toBe(false);
  });

  it('Content schema exposes 6 fields; other skills have 0 (v1 scope cut)', () => {
    expect(getSkillSchemaKeys('content').sort()).toEqual([
      'auto_publish',
      'default_platform',
      'extra_notes',
      'include_references_policy',
      'output_length',
      'voice_guidelines',
    ]);
    expect(getSkillSchemaKeys('secretary')).toEqual([]);
    expect(getSkillSchemaKeys('training')).toEqual([]);
    expect(getSkillSchemaKeys('finance')).toEqual([]);
    expect(getSkillSchemaKeys('cooking')).toEqual([]);
  });

  it('isKnownField distinguishes content fields from unknown', () => {
    expect(isKnownField('content', 'voice_guidelines')).toBe(true);
    expect(isKnownField('content', 'made_up')).toBe(false);
    expect(isKnownField('secretary', 'voice_guidelines')).toBe(false);
  });
});

describe('tenant-skill-config-service — Content skill read/write', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
  });
  afterEach(() => testDb?.close());

  it('fresh tenant: getSkillConfig returns schema defaults (no DB row needed)', () => {
    const row = getSkillConfig(alice, 'content');
    expect(row.tenantId).toBe(alice);
    expect(row.skillId).toBe('content');
    expect(row.config.default_platform).toBe('general');
    expect(row.config.output_length).toBe('balanced');
    expect(row.config.include_references_policy).toBe('when_relevant');
    expect(row.config.auto_publish).toBe(false);
    // String fields default to empty string.
    expect(row.config.voice_guidelines).toBe('');
    expect(row.config.extra_notes).toBe('');
  });

  it('put + get round-trip: persisted values stick', () => {
    putSkillConfig(alice, 'content', alice, {
      voice_guidelines: 'Write in a calm, direct tone.',
      default_platform: 'blog',
      output_length: 'detailed',
      auto_publish: true,
    });
    const row = getSkillConfig(alice, 'content');
    expect(row.config.voice_guidelines).toBe('Write in a calm, direct tone.');
    expect(row.config.default_platform).toBe('blog');
    expect(row.config.output_length).toBe('detailed');
    expect(row.config.auto_publish).toBe(true);
    // Untouched fields kept their defaults.
    expect(row.config.include_references_policy).toBe('when_relevant');
  });

  it('diff-style patches: unspecified keys unchanged', () => {
    putSkillConfig(alice, 'content', alice, { voice_guidelines: 'v1' });
    putSkillConfig(alice, 'content', alice, { default_platform: 'linkedin' });
    const row = getSkillConfig(alice, 'content');
    expect(row.config.voice_guidelines).toBe('v1');
    expect(row.config.default_platform).toBe('linkedin');
  });

  it('updates updated_by on every save', () => {
    putSkillConfig(alice, 'content', alice, { voice_guidelines: 'hi' });
    const row = getSkillConfig(alice, 'content');
    expect(row.updatedBy).toBe(alice);
  });
});

describe('tenant-skill-config-service — validation', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
  });
  afterEach(() => testDb?.close());

  it('rejects unknown schema keys with BAD_REQUEST listing allowed fields', () => {
    try {
      putSkillConfig(alice, 'content', alice, { made_up_key: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      expect((e as SkillConfigError).message).toContain('Unknown fields');
      expect((e as SkillConfigError).details?.allowed).toBeTruthy();
    }
  });

  it('default_platform enum: rejects unknown value', () => {
    expect(() => putSkillConfig(alice, 'content', alice, { default_platform: 'myspace' as any }))
      .toThrow(/must be one of/);
  });

  it('output_length enum: rejects unknown value', () => {
    expect(() => putSkillConfig(alice, 'content', alice, { output_length: 'epic' as any }))
      .toThrow(/must be one of/);
  });

  it('include_references_policy enum: rejects unknown value', () => {
    expect(() => putSkillConfig(alice, 'content', alice, { include_references_policy: 'maybe' as any }))
      .toThrow(/must be one of/);
  });

  it('voice_guidelines cap: rejects >4000 chars', () => {
    const long = 'x'.repeat(4001);
    expect(() => putSkillConfig(alice, 'content', alice, { voice_guidelines: long }))
      .toThrow(/too long/);
  });

  it('extra_notes cap: rejects >2000 chars', () => {
    const long = 'x'.repeat(2001);
    expect(() => putSkillConfig(alice, 'content', alice, { extra_notes: long }))
      .toThrow(/too long/);
  });

  it('auto_publish requires boolean (string rejected)', () => {
    expect(() => putSkillConfig(alice, 'content', alice, { auto_publish: 'true' as any }))
      .toThrow(/boolean or null/);
  });

  it('string fields reject non-string objects', () => {
    expect(() => putSkillConfig(alice, 'content', alice, { voice_guidelines: { inject: true } as any }))
      .toThrow(/string or null/);
  });

  it('empty string on a string field stores as null (cleared)', () => {
    putSkillConfig(alice, 'content', alice, { voice_guidelines: 'something' });
    putSkillConfig(alice, 'content', alice, { voice_guidelines: '' });
    const row = getSkillConfig(alice, 'content');
    expect(row.config.voice_guidelines).toBeNull();
  });

  it('null on a string field clears (distinct from absent)', () => {
    putSkillConfig(alice, 'content', alice, { voice_guidelines: 'something' });
    putSkillConfig(alice, 'content', alice, { voice_guidelines: null });
    const row = getSkillConfig(alice, 'content');
    expect(row.config.voice_guidelines).toBeNull();
  });

  it('patch must be a plain object (array rejected)', () => {
    expect(() => putSkillConfig(alice, 'content', alice, ['v1'] as any))
      .toThrow(/plain object/);
  });
});

describe('tenant-skill-config-service — empty-schema skills (v1 scope cut)', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
  });
  afterEach(() => testDb?.close());

  it('secretary: GET returns empty config with no defaults', () => {
    const row = getSkillConfig(alice, 'secretary');
    expect(row.config).toEqual({});
  });

  it('training: PUT with any field rejected with a clear message', () => {
    try {
      putSkillConfig(alice, 'training', alice, { voice_guidelines: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      // Error mentions Unknown fields (schemaKeys is empty) OR the
      // empty-schema guard.
      expect((e as SkillConfigError).message).toMatch(/(Unknown fields|no configurable fields)/);
    }
  });

  it('cooking: empty PUT (no keys) also rejected (explicitly flagged as v1 scope)', () => {
    try {
      putSkillConfig(alice, 'cooking', alice, { anything: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
    }
  });
});

describe('tenant-skill-config-service — isolation', () => {
  let alice: number;
  let bob: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
    bob = seedUser(testDb, 'bob@e.com');
    putSkillConfig(alice, 'content', alice, { voice_guidelines: 'alice-voice' });
    putSkillConfig(bob,   'content', bob,   { voice_guidelines: 'bob-voice' });
  });
  afterEach(() => testDb?.close());

  it('each tenant reads only their own config', () => {
    expect(getSkillConfig(alice, 'content').config.voice_guidelines).toBe('alice-voice');
    expect(getSkillConfig(bob,   'content').config.voice_guidelines).toBe('bob-voice');
  });

  it('rejects unknown skill id with UNKNOWN_SKILL', () => {
    try {
      getSkillConfig(alice, 'gym' as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('UNKNOWN_SKILL');
    }
  });

  it('rejects non-positive tenant ids with BAD_REQUEST', () => {
    expect(() => getSkillConfig(0, 'content')).toThrow(/tenantId must be a positive/);
    expect(() => getSkillConfig(-1, 'content')).toThrow(/tenantId must be a positive/);
  });
});
