/**
 * Slice A5 — CoachPlanPolicy persistence + defaults.
 *
 * Pins:
 *   - Migration 159 adds coach_plan_policy_json column
 *   - getCoachPlanPolicy returns defaults when column NULL
 *   - getCoachPlanPolicy returns null when plan missing
 *   - setCoachPlanPolicy validates + persists + returns merged result
 *   - Invalid enum values throw with descriptive messages
 *   - adaptationRateLimits validation (non-negative integers)
 *   - schemaVersion always stamped at write
 *   - 'data_informed' (NOT 'data_driven') enum value
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
  COACH_PLAN_POLICY_SCHEMA_VERSION,
  DEFAULT_COACH_PLAN_POLICY,
  getCoachPlanPolicy,
  setCoachPlanPolicy,
} from '../../src/services/coach-plan-policy';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(id: number, userId = 100): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'p', 'gym', 4, '2026-01-01', '2026-02-01', 'active')
  `).run(id, userId);
}

describe('migration 159 — coach_plan_policy_json column', () => {
  it('adds nullable coach_plan_policy_json column', () => {
    seedPlan(1);
    const row = testDb.prepare(
      'SELECT coach_plan_policy_json FROM fitness_training_plans WHERE id = ?',
    ).get(1) as { coach_plan_policy_json: string | null };
    expect(row.coach_plan_policy_json).toBeNull();
  });
});

describe('getCoachPlanPolicy', () => {
  it('returns defaults when column is null', () => {
    seedPlan(10);
    const policy = getCoachPlanPolicy(10);
    expect(policy).toEqual(DEFAULT_COACH_PLAN_POLICY);
  });

  it('returns null when plan does not exist', () => {
    expect(getCoachPlanPolicy(9999)).toBeNull();
  });

  it('returns persisted policy with defaults merged for missing fields', () => {
    seedPlan(11);
    testDb.prepare(
      'UPDATE fitness_training_plans SET coach_plan_policy_json = ? WHERE id = ?',
    ).run(
      JSON.stringify({ progressionAggressiveness: 'aggressive' }),
      11,
    );
    const policy = getCoachPlanPolicy(11);
    expect(policy?.progressionAggressiveness).toBe('aggressive');
    // Defaults applied for the rest.
    expect(policy?.deloadStrategy).toBe('hybrid');
    expect(policy?.taperStrategy).toBe('auto');
  });

  it('falls back to defaults when persisted JSON is malformed', () => {
    seedPlan(12);
    testDb.prepare(
      'UPDATE fitness_training_plans SET coach_plan_policy_json = ? WHERE id = ?',
    ).run('not valid json', 12);
    const policy = getCoachPlanPolicy(12);
    expect(policy).toEqual(DEFAULT_COACH_PLAN_POLICY);
  });
});

describe('setCoachPlanPolicy — validation + persistence', () => {
  it('persists full policy', () => {
    seedPlan(20);
    const written = setCoachPlanPolicy(20, {
      intensityDistributionPreference: 'polarized',
      progressionAggressiveness: 'conservative',
      deloadStrategy: 'data_informed',
      missedSessionPolicy: 'preserve_key_sessions',
      taperStrategy: 'extended',
      adaptationRateLimits: { perDay: 2, perWeek: 4 },
      schemaVersion: COACH_PLAN_POLICY_SCHEMA_VERSION,
    });
    expect(written.deloadStrategy).toBe('data_informed');
    const read = getCoachPlanPolicy(20);
    expect(read?.deloadStrategy).toBe('data_informed');
    expect(read?.adaptationRateLimits?.perWeek).toBe(4);
  });

  it('rejects invalid intensityDistributionPreference', () => {
    seedPlan(21);
    expect(() => setCoachPlanPolicy(21, {
      // @ts-expect-error testing runtime validation of an invalid value
      intensityDistributionPreference: 'made_up_model',
    })).toThrow(/intensityDistributionPreference/);
  });

  it("rejects 'data_driven' (use 'data_informed' per v2.1 wording)", () => {
    seedPlan(22);
    expect(() => setCoachPlanPolicy(22, {
      // @ts-expect-error data_driven was the v1 name; v2.1 uses data_informed
      deloadStrategy: 'data_driven',
    })).toThrow(/deloadStrategy/);
    // Confirm data_informed IS accepted.
    expect(() => setCoachPlanPolicy(22, { deloadStrategy: 'data_informed' })).not.toThrow();
  });

  it('rejects negative adaptationRateLimits', () => {
    seedPlan(23);
    expect(() => setCoachPlanPolicy(23, {
      adaptationRateLimits: { perDay: -1 },
    })).toThrow(/non-negative integer/);
  });

  it('rejects non-integer adaptationRateLimits', () => {
    seedPlan(24);
    expect(() => setCoachPlanPolicy(24, {
      adaptationRateLimits: { perWeek: 1.5 },
    })).toThrow(/non-negative integer/);
  });

  it('stamps current schemaVersion regardless of input', () => {
    seedPlan(25);
    const written = setCoachPlanPolicy(25, {
      // @ts-expect-error testing version override is ignored
      schemaVersion: 999,
    });
    expect(written.schemaVersion).toBe(COACH_PLAN_POLICY_SCHEMA_VERSION);
  });

  it('throws when plan does not exist', () => {
    expect(() => setCoachPlanPolicy(9999, { deloadStrategy: 'scheduled' })).toThrow(/does not exist/);
  });
});

describe('DEFAULT_COACH_PLAN_POLICY values', () => {
  it("defaults deloadStrategy to 'hybrid' (not 'data_informed' alone)", () => {
    expect(DEFAULT_COACH_PLAN_POLICY.deloadStrategy).toBe('hybrid');
  });

  it("defaults missedSessionPolicy to 'drop_low_priority' (never cram)", () => {
    expect(DEFAULT_COACH_PLAN_POLICY.missedSessionPolicy).toBe('drop_low_priority');
  });

  it('defaults adaptationRateLimits to 1/day, 2/week', () => {
    expect(DEFAULT_COACH_PLAN_POLICY.adaptationRateLimits?.perDay).toBe(1);
    expect(DEFAULT_COACH_PLAN_POLICY.adaptationRateLimits?.perWeek).toBe(2);
  });

  it("defaults intensityDistributionPreference to 'auto'", () => {
    expect(DEFAULT_COACH_PLAN_POLICY.intensityDistributionPreference).toBe('auto');
  });
});
