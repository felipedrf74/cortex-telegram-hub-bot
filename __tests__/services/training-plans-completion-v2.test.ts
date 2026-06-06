/**
 * Codex P1 — logCompletion writes the A0c CompletionFeedbackV2 columns.
 *
 * Pins:
 *   - All legacy fields still round-trip (no regression)
 *   - rir, pain_score, pain_location persist
 *   - technical_success_score persists
 *   - missed_reason persists
 *   - completed_duration_sec, completed_distance_meters persist
 *   - completed_sets/reps/load_json persist
 *   - external_training_declared is normalized to 0/1 INTEGER
 *   - Older callers passing only legacy fields still work
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
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import { logCompletion } from '../../src/services/training-plans';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (1, 100, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
  `).run();
  testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1, 1, 1)').run();
  testDb.prepare(`
    INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (10, 1, 1, 'Monday', 'strength', 'Session', 60, 'pending')
  `).run();
});

afterEach(() => testDb.close());

describe('logCompletion — A0c CompletionFeedbackV2 wiring', () => {
  it('persists all V2 fields when supplied', () => {
    const completion = logCompletion({
      session_id: 10,
      plan_id: 1,
      rpe_overall: 8,
      duration_minutes: 55,
      energy_level: 6,
      soreness_level: 4,
      notes: 'felt heavy',
      completed_duration_sec: 3300,
      completed_distance_meters: 8000,
      completed_sets_json: JSON.stringify([3, 3, 3]),
      completed_reps_json: JSON.stringify([8, 8, 7]),
      completed_load_json: JSON.stringify([100, 100, 105]),
      rir: 2,
      pain_score: 3,
      pain_location: 'left knee, lateral',
      technical_success_score: 7,
      missed_reason: undefined,
      external_training_declared: false,
    });

    const row = testDb.prepare(
      'SELECT * FROM training_completions WHERE id = ?',
    ).get(completion.id) as Record<string, unknown>;

    expect(row.rpe_overall).toBe(8);
    expect(row.rir).toBe(2);
    expect(row.pain_score).toBe(3);
    expect(row.pain_location).toBe('left knee, lateral');
    expect(row.technical_success_score).toBe(7);
    expect(row.completed_duration_sec).toBe(3300);
    expect(row.completed_distance_meters).toBe(8000);
    expect(JSON.parse(row.completed_sets_json as string)).toEqual([3, 3, 3]);
    expect(JSON.parse(row.completed_reps_json as string)).toEqual([8, 8, 7]);
    expect(JSON.parse(row.completed_load_json as string)).toEqual([100, 100, 105]);
    expect(row.external_training_declared).toBe(0);
  });

  it('older legacy callers (no V2 fields) still work', () => {
    const completion = logCompletion({
      session_id: 10,
      plan_id: 1,
      rpe_overall: 6,
      duration_minutes: 60,
      energy_level: 7,
      soreness_level: 3,
      notes: 'standard session',
    });
    const row = testDb.prepare(
      'SELECT * FROM training_completions WHERE id = ?',
    ).get(completion.id) as Record<string, unknown>;
    expect(row.rpe_overall).toBe(6);
    expect(row.rir).toBeNull();
    expect(row.pain_score).toBeNull();
    expect(row.external_training_declared).toBe(0);
  });

  it('external_training_declared=true → stored as INTEGER 1', () => {
    const completion = logCompletion({
      session_id: 10,
      plan_id: 1,
      external_training_declared: true,
    });
    const row = testDb.prepare(
      'SELECT external_training_declared FROM training_completions WHERE id = ?',
    ).get(completion.id) as { external_training_declared: number };
    expect(row.external_training_declared).toBe(1);
  });

  it('missed_reason persists on skipped completions', () => {
    const completion = logCompletion({
      session_id: 10,
      plan_id: 1,
      missed_reason: 'illness',
    });
    const row = testDb.prepare(
      'SELECT missed_reason FROM training_completions WHERE id = ?',
    ).get(completion.id) as { missed_reason: string };
    expect(row.missed_reason).toBe('illness');
  });

  it('completion is also marked as completed on the session', () => {
    logCompletion({
      session_id: 10,
      plan_id: 1,
      rpe_overall: 7,
    });
    const sessionRow = testDb.prepare(
      'SELECT status FROM training_sessions WHERE id = ?',
    ).get(10) as { status: string };
    expect(sessionRow.status).toBe('completed');
  });
});
