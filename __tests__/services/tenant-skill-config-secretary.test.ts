// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary-specific service tests (OI-DATA-003a, 2026-04-23).
 *
 * The base service behavior (round-trip, isolation, diff patches,
 * etc.) is covered once in __tests__/services/tenant-skill-config-
 * service.test.ts — those tests now include a check that Secretary
 * exposes 6 schema fields. These Secretary-scoped tests pin the
 * field-specific validations:
 *
 *   - daily_routines + extra_notes string-length caps (4000 / 2000)
 *   - focus_block_policy / primary_calendar / interruption_tolerance
 *     enums reject unknown values
 *   - priority_rules 2000-char cap
 *   - Defaults: policy='none', calendar='none', tolerance='medium'
 *   - Empty-string → null semantics (same as Content)
 *   - Unknown key → 400 with allowed list including ALL 6 Secretary
 *     fields
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

describe('tenant-skill-config-service — Secretary schema (OI-DATA-003a)', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice@e.com');
  });
  afterEach(() => testDb?.close());

  it('fresh tenant: returns all 6 fields with defaults', () => {
    const row = getSkillConfig(alice, 'secretary');
    expect(row.skillId).toBe('secretary');
    // String-default fields default to ''.
    expect(row.config.daily_routines).toBe('');
    expect(row.config.priority_rules).toBe('');
    expect(row.config.extra_notes).toBe('');
    // Enum defaults.
    expect(row.config.focus_block_policy).toBe('none');
    expect(row.config.primary_calendar).toBe('none');
    expect(row.config.interruption_tolerance).toBe('medium');
  });

  it('put + get round-trip for all 6 fields', () => {
    putSkillConfig(alice, 'secretary', alice, {
      daily_routines: 'Wake 6am, write 7–8, focus block 8–11.',
      priority_rules: 'Felipe > family > email. Never email before 11.',
      focus_block_policy: 'mornings',
      primary_calendar: 'google',
      interruption_tolerance: 'low',
      extra_notes: 'Dog walk at 5pm is non-negotiable.',
    });
    const row = getSkillConfig(alice, 'secretary');
    expect(row.config.daily_routines).toBe('Wake 6am, write 7–8, focus block 8–11.');
    expect(row.config.priority_rules).toContain('Felipe > family > email');
    expect(row.config.focus_block_policy).toBe('mornings');
    expect(row.config.primary_calendar).toBe('google');
    expect(row.config.interruption_tolerance).toBe('low');
    expect(row.config.extra_notes).toContain('Dog walk');
  });

  it('focus_block_policy enum: all 5 values accepted', () => {
    for (const v of ['none', 'mornings', 'afternoons', 'all_day', 'custom']) {
      putSkillConfig(alice, 'secretary', alice, { focus_block_policy: v as any });
    }
  });

  it('focus_block_policy enum: unknown value rejected', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      focus_block_policy: 'evenings' as any,
    })).toThrow(/must be one of/);
  });

  it('primary_calendar enum: rejects fastmail', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      primary_calendar: 'fastmail' as any,
    })).toThrow(/must be one of/);
  });

  it('interruption_tolerance enum: rejects silent', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      interruption_tolerance: 'silent' as any,
    })).toThrow(/must be one of/);
  });

  it('daily_routines cap: rejects >4000 chars', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      daily_routines: 'x'.repeat(4001),
    })).toThrow(/too long/);
  });

  it('priority_rules cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      priority_rules: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('extra_notes cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'secretary', alice, {
      extra_notes: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('empty string on daily_routines stores as null', () => {
    putSkillConfig(alice, 'secretary', alice, { daily_routines: 'v1' });
    putSkillConfig(alice, 'secretary', alice, { daily_routines: '' });
    expect(getSkillConfig(alice, 'secretary').config.daily_routines).toBeNull();
  });

  it('unknown Secretary field: 400 with all 6 allowed fields in details', () => {
    try {
      putSkillConfig(alice, 'secretary', alice, { voice_guidelines: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      const allowed = (e as SkillConfigError).details?.allowed as string[];
      expect(allowed).toEqual(expect.arrayContaining([
        'daily_routines',
        'priority_rules',
        'focus_block_policy',
        'primary_calendar',
        'interruption_tolerance',
        'extra_notes',
      ]));
    }
  });

  it('diff-style patch: setting only focus_block_policy leaves daily_routines alone', () => {
    putSkillConfig(alice, 'secretary', alice, { daily_routines: 'keeper' });
    putSkillConfig(alice, 'secretary', alice, { focus_block_policy: 'all_day' });
    const row = getSkillConfig(alice, 'secretary');
    expect(row.config.daily_routines).toBe('keeper');
    expect(row.config.focus_block_policy).toBe('all_day');
  });
});
