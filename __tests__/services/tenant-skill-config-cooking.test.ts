// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cooking-specific service tests (OI-DATA-003d, 2026-04-23).
 * Last skill in the per-skill-schema arc. Mirrors the Secretary /
 * Training / Finance test shape.
 *
 * Key Cooking-specific nuance pinned here: `dietary_restrictions`
 * is the HARD constraint gated by the Home dependency, not
 * `preferences` (which is soft). Safety-relevant for allergies.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
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
  SkillConfigError,
} from '../../src/services/tenant-skill-config-service';

describe('tenant-skill-config-service — Cooking schema (OI-DATA-003d)', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-cook@e.com');
  });
  afterEach(() => testDb?.close());

  it('fresh tenant: returns 6 fields with correct defaults', () => {
    const row = getSkillConfig(alice, 'cooking');
    expect(row.skillId).toBe('cooking');
    expect(row.config.dietary_restrictions).toBe('');
    expect(row.config.preferences).toBe('');
    expect(row.config.kitchen_inventory).toBe('');
    expect(row.config.extra_notes).toBe('');
    // Enum defaults.
    expect(row.config.serving_size).toBe('2');
    expect(row.config.meal_cost_ceiling).toBe('moderate');
  });

  it('put + get round-trip for all 6 fields', () => {
    putSkillConfig(alice, 'cooking', alice, {
      dietary_restrictions: 'Tree nut allergy (severe). Lactose intolerant.',
      preferences: 'Love Thai and Mediterranean. Medium spice.',
      kitchen_inventory: 'Gas stove, instant pot, stand mixer. No sous vide.',
      serving_size: '4',
      meal_cost_ceiling: 'budget',
      extra_notes: 'Sunday = meal prep day.',
    });
    const row = getSkillConfig(alice, 'cooking');
    expect(row.config.dietary_restrictions).toContain('Tree nut');
    expect(row.config.preferences).toContain('Thai');
    expect(row.config.kitchen_inventory).toContain('instant pot');
    expect(row.config.serving_size).toBe('4');
    expect(row.config.meal_cost_ceiling).toBe('budget');
    expect(row.config.extra_notes).toContain('meal prep');
  });

  it('serving_size enum: all 5 values accepted', () => {
    for (const v of ['1', '2', '3', '4', '5_plus']) {
      putSkillConfig(alice, 'cooking', alice, { serving_size: v as any });
    }
  });

  it('serving_size enum: rejects "10"', () => {
    expect(() => putSkillConfig(alice, 'cooking', alice, {
      serving_size: '10' as any,
    })).toThrow(/must be one of/);
  });

  it('meal_cost_ceiling enum: all 4 values accepted', () => {
    for (const v of ['budget', 'moderate', 'premium', 'no_limit']) {
      putSkillConfig(alice, 'cooking', alice, { meal_cost_ceiling: v as any });
    }
  });

  it('meal_cost_ceiling enum: rejects "luxury"', () => {
    expect(() => putSkillConfig(alice, 'cooking', alice, {
      meal_cost_ceiling: 'luxury' as any,
    })).toThrow(/must be one of/);
  });

  it('dietary_restrictions cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'cooking', alice, {
      dietary_restrictions: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('preferences cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'cooking', alice, {
      preferences: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('kitchen_inventory cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'cooking', alice, {
      kitchen_inventory: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('empty string on dietary_restrictions stores as null (safe to clear)', () => {
    putSkillConfig(alice, 'cooking', alice, { dietary_restrictions: 'tree nut allergy' });
    putSkillConfig(alice, 'cooking', alice, { dietary_restrictions: '' });
    expect(getSkillConfig(alice, 'cooking').config.dietary_restrictions).toBeNull();
  });

  it('unknown Cooking field: 400 with 6 allowed fields in details', () => {
    try {
      putSkillConfig(alice, 'cooking', alice, { voice_guidelines: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      const allowed = (e as SkillConfigError).details?.allowed as string[];
      expect(allowed).toEqual(expect.arrayContaining([
        'dietary_restrictions',
        'preferences',
        'kitchen_inventory',
        'serving_size',
        'meal_cost_ceiling',
        'extra_notes',
      ]));
    }
  });

  it('diff-style patch: setting serving_size leaves dietary_restrictions alone', () => {
    putSkillConfig(alice, 'cooking', alice, { dietary_restrictions: 'preserve this' });
    putSkillConfig(alice, 'cooking', alice, { serving_size: '5_plus' });
    const row = getSkillConfig(alice, 'cooking');
    expect(row.config.dietary_restrictions).toBe('preserve this');
    expect(row.config.serving_size).toBe('5_plus');
  });
});
