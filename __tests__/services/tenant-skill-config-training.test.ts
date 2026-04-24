// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training-specific service tests (OI-DATA-003b, 2026-04-23).
 *
 * Mirrors the Secretary test file's shape. The base service behavior
 * (round-trip, isolation, diff patches, etc.) is covered in
 * tenant-skill-config-service.test.ts. Here we pin Training's
 * schema-specific rules:
 *
 *   - 6 fields with correct defaults
 *   - enums (preferred_training_days × 5, recovery_priority × 3)
 *   - length caps (goals, equipment_available, constraints_and_injuries,
 *     extra_notes — all 2000)
 *   - empty-string → null semantics
 *   - unknown field 400 with Training's 6-field allowed list
 *   - diff-style patches work
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

describe('tenant-skill-config-service — Training schema (OI-DATA-003b)', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-train@e.com');
  });
  afterEach(() => testDb?.close());

  it('fresh tenant: returns 6 fields with correct defaults', () => {
    const row = getSkillConfig(alice, 'training');
    expect(row.skillId).toBe('training');
    // String-default fields default to ''.
    expect(row.config.goals).toBe('');
    expect(row.config.equipment_available).toBe('');
    expect(row.config.constraints_and_injuries).toBe('');
    expect(row.config.extra_notes).toBe('');
    // Enum defaults.
    expect(row.config.preferred_training_days).toBe('four_days');
    expect(row.config.recovery_priority).toBe('balanced');
  });

  it('put + get round-trip for all 6 fields', () => {
    putSkillConfig(alice, 'training', alice, {
      goals: 'Sub-2h half marathon by October.',
      equipment_available: 'Gym (squat rack, DBs to 50kg), road bike, 25m pool.',
      constraints_and_injuries: 'Left knee IT band syndrome. Easy pace only for 4 weeks.',
      preferred_training_days: 'five_days',
      recovery_priority: 'maximum',
      extra_notes: 'Race on October 12. Taper planned 2 weeks out.',
    });
    const row = getSkillConfig(alice, 'training');
    expect(row.config.goals).toBe('Sub-2h half marathon by October.');
    expect(row.config.equipment_available).toContain('squat rack');
    expect(row.config.constraints_and_injuries).toContain('IT band');
    expect(row.config.preferred_training_days).toBe('five_days');
    expect(row.config.recovery_priority).toBe('maximum');
    expect(row.config.extra_notes).toContain('October 12');
  });

  it('preferred_training_days enum: all 5 values accepted', () => {
    for (const v of ['daily', 'six_days', 'five_days', 'four_days', 'three_days']) {
      putSkillConfig(alice, 'training', alice, { preferred_training_days: v as any });
    }
  });

  it('preferred_training_days enum: rejects unknown "weekends"', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      preferred_training_days: 'weekends' as any,
    })).toThrow(/must be one of/);
  });

  it('recovery_priority enum: rejects "extreme"', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      recovery_priority: 'extreme' as any,
    })).toThrow(/must be one of/);
  });

  it('goals cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      goals: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('equipment_available cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      equipment_available: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('constraints_and_injuries cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      constraints_and_injuries: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('extra_notes cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'training', alice, {
      extra_notes: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('empty string on goals stores as null', () => {
    putSkillConfig(alice, 'training', alice, { goals: 'v1' });
    putSkillConfig(alice, 'training', alice, { goals: '' });
    expect(getSkillConfig(alice, 'training').config.goals).toBeNull();
  });

  it('unknown Training field: 400 with the 6 allowed fields in details', () => {
    try {
      putSkillConfig(alice, 'training', alice, { voice_guidelines: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      const allowed = (e as SkillConfigError).details?.allowed as string[];
      expect(allowed).toEqual(expect.arrayContaining([
        'goals',
        'equipment_available',
        'constraints_and_injuries',
        'preferred_training_days',
        'recovery_priority',
        'extra_notes',
      ]));
    }
  });

  it('diff-style patch: setting only recovery_priority leaves goals alone', () => {
    putSkillConfig(alice, 'training', alice, { goals: 'keep me' });
    putSkillConfig(alice, 'training', alice, { recovery_priority: 'maximum' });
    const row = getSkillConfig(alice, 'training');
    expect(row.config.goals).toBe('keep me');
    expect(row.config.recovery_priority).toBe('maximum');
  });
});
