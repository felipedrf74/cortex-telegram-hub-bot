/**
 * Slice A0 — adaptation_revision column + helpers.
 *
 * Closes the Week-Level Adaptability + Periodization plan (v2.1)
 * substrate gap by introducing the second versioning counter:
 *
 *   - `plan_version` (existing, migration 081): bumps on manual
 *     regeneration; heavyweight; triggers calendar supersession.
 *   - `adaptation_revision` (new, migration 155): bumps on persisted
 *     adaptive reflows; lightweight; does NOT trigger calendar
 *     supersession.
 *
 * Pins:
 *   - migration 155 adds the column with DEFAULT 0
 *   - existing plans backfill to 0 (not 1 like plan_version)
 *   - incrementAdaptationRevision bumps and persists
 *   - getAdaptationRevision returns 0 for never-reflowed plans
 *   - getAdaptationRevision returns null for missing plans
 *   - the two counters are independent (incrementing one does not
 *     touch the other)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        /* skip deps */
      }
    }
  }
}

import {
  getAdaptationRevision,
  getPlanVersion,
  incrementAdaptationRevision,
  incrementPlanVersion,
} from '../../src/services/training-plan-lifecycle';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(id: number, userId = 100): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'Test plan', 'gym', 12, '2026-01-01', '2026-04-01', 'active')
  `).run(id, userId);
}

describe('migration 155 — adaptation_revision column', () => {
  it('adds adaptation_revision column with DEFAULT 0', () => {
    seedPlan(1);
    const row = testDb.prepare(
      'SELECT adaptation_revision FROM fitness_training_plans WHERE id = ?',
    ).get(1) as { adaptation_revision: number };
    expect(row.adaptation_revision).toBe(0);
  });

  it('defaults newly-generated plans to revision 0 (not 1 like plan_version)', () => {
    seedPlan(2);
    const row = testDb.prepare(
      'SELECT plan_version, adaptation_revision FROM fitness_training_plans WHERE id = ?',
    ).get(2) as { plan_version: number; adaptation_revision: number };
    expect(row.plan_version).toBe(1);
    expect(row.adaptation_revision).toBe(0);
  });
});

describe('incrementAdaptationRevision', () => {
  it('bumps adaptation_revision from 0 → 1 on first reflow', () => {
    seedPlan(10);
    const newRevision = incrementAdaptationRevision(10);
    expect(newRevision).toBe(1);
    const row = testDb.prepare(
      'SELECT adaptation_revision FROM fitness_training_plans WHERE id = ?',
    ).get(10) as { adaptation_revision: number };
    expect(row.adaptation_revision).toBe(1);
  });

  it('bumps monotonically across multiple reflows', () => {
    seedPlan(11);
    expect(incrementAdaptationRevision(11)).toBe(1);
    expect(incrementAdaptationRevision(11)).toBe(2);
    expect(incrementAdaptationRevision(11)).toBe(3);
  });

  it('returns null for a plan that does not exist', () => {
    const result = incrementAdaptationRevision(9999);
    expect(result).toBeNull();
  });

  it('updates updated_at timestamp on increment', () => {
    seedPlan(12);
    const beforeRow = testDb.prepare(
      'SELECT updated_at FROM fitness_training_plans WHERE id = ?',
    ).get(12) as { updated_at: string };
    // Force a clock tick — SQLite datetime('now') has 1-second resolution.
    const future = new Date(Date.now() + 2000).toISOString().slice(0, 19).replace('T', ' ');
    testDb.prepare(
      'UPDATE fitness_training_plans SET updated_at = ? WHERE id = ?',
    ).run(future, 12);
    // Pre-increment guard: confirm we did move the clock backwards so
    // the post-increment comparison is meaningful.
    const seededRow = testDb.prepare(
      'SELECT updated_at FROM fitness_training_plans WHERE id = ?',
    ).get(12) as { updated_at: string };
    expect(seededRow.updated_at).not.toBe(beforeRow.updated_at);
    incrementAdaptationRevision(12);
    const afterRow = testDb.prepare(
      'SELECT updated_at FROM fitness_training_plans WHERE id = ?',
    ).get(12) as { updated_at: string };
    // After increment, updated_at is rewritten to datetime('now'),
    // overwriting the manually-seeded future timestamp.
    expect(afterRow.updated_at).not.toBe(seededRow.updated_at);
  });
});

describe('getAdaptationRevision', () => {
  it('returns 0 for a newly-generated plan with no reflows', () => {
    seedPlan(20);
    expect(getAdaptationRevision(20)).toBe(0);
  });

  it('returns the current revision after reflows', () => {
    seedPlan(21);
    incrementAdaptationRevision(21);
    incrementAdaptationRevision(21);
    expect(getAdaptationRevision(21)).toBe(2);
  });

  it('returns null for a plan that does not exist', () => {
    expect(getAdaptationRevision(9999)).toBeNull();
  });
});

describe('two-counter independence', () => {
  it('incrementAdaptationRevision does not bump plan_version', () => {
    seedPlan(30);
    expect(getPlanVersion(30)).toBe(1);
    incrementAdaptationRevision(30);
    incrementAdaptationRevision(30);
    expect(getPlanVersion(30)).toBe(1);
    expect(getAdaptationRevision(30)).toBe(2);
  });

  it('incrementPlanVersion does not bump adaptation_revision', () => {
    seedPlan(31);
    expect(getAdaptationRevision(31)).toBe(0);
    incrementPlanVersion(31);
    expect(getPlanVersion(31)).toBe(2);
    expect(getAdaptationRevision(31)).toBe(0);
  });

  it('manual regeneration resets adaptation_revision to 0 for the new generation', () => {
    // Simulate a manual regen flow: previous generation accumulated
    // adaptation reflows; the regen deletes the old plan and creates a
    // new one. The new row defaults to revision 0.
    seedPlan(40);
    incrementAdaptationRevision(40);
    incrementAdaptationRevision(40);
    expect(getAdaptationRevision(40)).toBe(2);
    // Simulate regen: delete and re-create with a new id.
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(40);
    seedPlan(41);
    expect(getAdaptationRevision(41)).toBe(0);
  });
});
