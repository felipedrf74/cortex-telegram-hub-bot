/**
 * R8 P0-2 — behavioral coverage for coach-action-executor.
 *
 * Codex caught that the only SQL writer for `CoachAction[]` →
 * `training_sessions / fitness_training_plans` had only a
 * source-grep test in coach-kernel-session-status.test.ts. The
 * actual mutation logic — UTC day-of-week math, tenant-safety
 * `plan_id` guards, scale_volume edge math, and the deferred /
 * skipped action types — had no behavioral tests.
 *
 * These tests pin the contract end-to-end against a real
 * in-memory SQLite, matching the setup pattern used in
 * coach-kernel-session-status.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
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
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* dependency-order skip */ }
    }
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

import { executeCoachActions } from '../../src/services/coach-kernel/coach-action-executor';
import type { CoachAction } from '../../src/services/coach-kernel/scenario-classifier';

function seedPlan(planId: number, userId = 99): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, status, start_date, end_date, duration_weeks, created_at)
    VALUES (?, ?, 'P', 'running', 'active', '2026-05-01', '2026-07-01', 8, datetime('now'))
  `).run(planId, userId);
}

function seedWeek(weekId: number, planId: number, weekNumber = 1): void {
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number, focus, intensity_pct, auto_adjusted, created_at)
    VALUES (?, ?, ?, 'base', 70, 0, datetime('now'))
  `).run(weekId, planId, weekNumber);
}

function seedSession(
  sessionId: number,
  weekId: number,
  planId: number,
  overrides: Partial<{ status: string; duration_minutes: number | null; day_of_week: string; intensity_text: string }> = {},
): void {
  const status = overrides.status ?? 'pending';
  const day = overrides.day_of_week ?? 'Monday';
  const duration = overrides.duration_minutes === undefined ? 60 : overrides.duration_minutes;
  const intensity = overrides.intensity_text ?? 'aerobic';
  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, intensity_text, status, created_at)
    VALUES (?, ?, ?, ?, 'run', 'T', ?, ?, ?, datetime('now'))
  `).run(sessionId, weekId, planId, day, duration, intensity, status);
}

describe('R8 P0-2 — move_session UTC weekday math', () => {
  it('"2026-05-04" (a Monday) routes to Monday — verifies getUTCDay() not local-time-shifted', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { day_of_week: 'Friday' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'move_session', sessionId: '100', toDate: '2026-05-04', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(1);
    const row = testDb.prepare('SELECT day_of_week, status FROM training_sessions WHERE id = 100').get() as { day_of_week: string; status: string };
    expect(row.day_of_week).toBe('Monday');
    expect(row.status).toBe('moved');
  });

  it('"2026-05-09" (a Saturday) routes to Saturday — Sun=0..Sat=6 indexing correct', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'move_session', sessionId: '100', toDate: '2026-05-09', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(1);
    const row = testDb.prepare('SELECT day_of_week FROM training_sessions WHERE id = 100').get() as { day_of_week: string };
    expect(row.day_of_week).toBe('Saturday');
  });

  it('"2026-05-10" (a Sunday) routes to Sunday', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1);
    executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'move_session', sessionId: '100', toDate: '2026-05-10', reasonCode: 'r' }],
    });
    const row = testDb.prepare('SELECT day_of_week FROM training_sessions WHERE id = 100').get() as { day_of_week: string };
    expect(row.day_of_week).toBe('Sunday');
  });

  it('malformed toDate → skipped invalid_to_date, row untouched', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { day_of_week: 'Friday' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'move_session', sessionId: '100', toDate: 'not-a-date', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(true);
    expect(r.perActionResults[0]?.skipReason).toBe('invalid_to_date');
    const row = testDb.prepare('SELECT day_of_week, status FROM training_sessions WHERE id = 100').get() as { day_of_week: string; status: string };
    expect(row.day_of_week).toBe('Friday');
    expect(row.status).toBe('pending');
  });
});

describe('R8 P0-2 — tenant-safety plan_id mismatch refuses to mutate', () => {
  it('drop_session targeting another plan\'s session → no mutation, no error', () => {
    seedPlan(1); seedPlan(2);
    seedWeek(10, 1); seedWeek(20, 2);
    seedSession(200, 20, 2);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'drop_session', sessionId: '200', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(true);
    const row = testDb.prepare('SELECT status FROM training_sessions WHERE id = 200').get() as { status: string };
    expect(row.status).toBe('pending');
  });

  it('move_session cross-plan → no mutation', () => {
    seedPlan(1); seedPlan(2);
    seedWeek(20, 2);
    seedSession(200, 20, 2, { day_of_week: 'Monday' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'move_session', sessionId: '200', toDate: '2026-05-09', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    const row = testDb.prepare('SELECT day_of_week FROM training_sessions WHERE id = 200').get() as { day_of_week: string };
    expect(row.day_of_week).toBe('Monday');
  });

  it('scale_volume cross-plan → session_not_found_or_foreign', () => {
    seedPlan(1); seedPlan(2);
    seedWeek(20, 2);
    seedSession(200, 20, 2, { duration_minutes: 60 });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '200', multiplier: 0.5, reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipReason).toBe('session_not_found_or_foreign');
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 200').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(60);
  });

  it('downgrade_intensity cross-plan → no mutation', () => {
    seedPlan(1); seedPlan(2);
    seedWeek(20, 2);
    seedSession(200, 20, 2, { intensity_text: 'tempo' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'downgrade_intensity', sessionId: '200', targetCeiling: 'aerobic', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    const row = testDb.prepare('SELECT intensity_text FROM training_sessions WHERE id = 200').get() as { intensity_text: string };
    expect(row.intensity_text).toBe('tempo');
  });
});

describe('R8 P0-2 — scale_volume edge math', () => {
  it('multiplier 0.5 halves duration (min floor 1)', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { duration_minutes: 60 });
    executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0.5, reasonCode: 'r' }],
    });
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(30);
  });

  it('multiplier 0 → skipped invalid_multiplier (must be > 0)', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { duration_minutes: 60 });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0, reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('invalid_multiplier');
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(60);
  });

  it('multiplier 0.001 with 60 min duration → 1 min (floor enforced)', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { duration_minutes: 60 });
    executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0.001, reasonCode: 'r' }],
    });
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(1);
  });

  it('NaN multiplier (e.g. 0/0) → skipped invalid_multiplier', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { duration_minutes: 60 });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0 / 0, reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('invalid_multiplier');
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(60);
  });

  it('null duration_minutes scaled by anything → result is 1 (Math.max floor)', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { duration_minutes: null });
    executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0.5, reasonCode: 'r' }],
    });
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(1);
  });
});

describe('R8 P0-2 — deferred action types are skipped, not silently dropped', () => {
  it('swap_exercise → skipped exercises_json_mutation_deferred', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'swap_exercise', sessionId: '100', fromExerciseId: 'a', toExerciseId: 'b', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(true);
    expect(r.perActionResults[0]?.skipReason).toBe('exercises_json_mutation_deferred');
  });

  it('insert_recovery_day → skipped insert_session_deferred', () => {
    seedPlan(1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'insert_recovery_day', date: '2026-05-10', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(true);
    expect(r.perActionResults[0]?.skipReason).toBe('insert_session_deferred');
  });
});

describe('R8 P0-2 — pause_training on nonexistent plan id', () => {
  it('no plan row matches → mutatedRows: 0, skipped: false (SQL update with 0 changes is not an error)', () => {
    seedPlan(1);
    const r = executeCoachActions(testDb, {
      planId: 99999, // doesn't exist
      actions: [{ type: 'pause_training', reasonCode: 'r', severity: 'pause' }],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(false);
  });

  it('plan exists → status flips to paused', () => {
    seedPlan(1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'pause_training', reasonCode: 'r', severity: 'pause' }],
    });
    expect(r.mutatedRows).toBe(1);
    const row = testDb.prepare('SELECT status FROM fitness_training_plans WHERE id = 1').get() as { status: string };
    expect(row.status).toBe('paused');
  });
});

describe('R8 P0-2 — unknown action type → default branch', () => {
  it('unknown action.type → exhaustiveness skip with unknown_action_type', () => {
    seedPlan(1);
    const bogus = { type: 'bogus_action_unknown', sessionId: '100', reasonCode: 'r' } as unknown as CoachAction;
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [bogus],
    });
    expect(r.mutatedRows).toBe(0);
    expect(r.perActionResults[0]?.skipped).toBe(true);
    expect(r.perActionResults[0]?.skipReason).toBe('unknown_action_type');
  });
});

describe('R8 P0-2 — invalid session id parsing', () => {
  it('drop_session with non-numeric id → invalid_session_id', () => {
    seedPlan(1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'drop_session', sessionId: 'not-a-number', reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('invalid_session_id');
  });

  it('drop_session with negative id → invalid_session_id', () => {
    seedPlan(1);
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'drop_session', sessionId: '-5', reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('invalid_session_id');
  });
});

describe('R8 P0-2 — non-actionable session statuses stay protected', () => {
  it('drop_session on a completed session → session_not_actionable', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { status: 'completed' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'drop_session', sessionId: '100', reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('session_not_actionable');
    const row = testDb.prepare('SELECT status FROM training_sessions WHERE id = 100').get() as { status: string };
    expect(row.status).toBe('completed');
  });

  it('scale_volume on a moved session → session_not_actionable', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { status: 'moved', duration_minutes: 60 });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'scale_volume', sessionId: '100', multiplier: 0.5, reasonCode: 'r' }],
    });
    expect(r.perActionResults[0]?.skipReason).toBe('session_not_actionable');
    const row = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 100').get() as { duration_minutes: number };
    expect(row.duration_minutes).toBe(60);
  });

  it('R6 P2 expansion: drop_session on a reflowed session SUCCEEDS (reflowed is actionable)', () => {
    seedPlan(1); seedWeek(10, 1); seedSession(100, 10, 1, { status: 'reflowed' });
    const r = executeCoachActions(testDb, {
      planId: 1,
      actions: [{ type: 'drop_session', sessionId: '100', reasonCode: 'r' }],
    });
    expect(r.mutatedRows).toBe(1);
    const row = testDb.prepare('SELECT status FROM training_sessions WHERE id = 100').get() as { status: string };
    expect(row.status).toBe('skipped');
  });
});
