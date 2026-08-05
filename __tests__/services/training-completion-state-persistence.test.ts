import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_023 = path.resolve(__dirname, '../../migrations/023_fitness_training_plans.sql');
const MIGRATION_187 = path.resolve(__dirname, '../../migrations/187_completion_feedback_v2.sql');
const MIGRATION_277 = path.resolve(__dirname, '../../migrations/277_training_completion_state.sql');

let testDb: Database.Database;

const { loggerInfoSpy } = vi.hoisted(() => ({ loggerInfoSpy: vi.fn() }));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: loggerInfoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  getWeeklyAdherence,
  logCompletion,
} from '../../src/services/training-plans';

function addExpectedCompletionColumns(db: Database.Database): void {
  // Establish the post-migration shape so this service contract goes red on
  // the production writer/state transition, independently of migration-file
  // existence (which is pinned in its own test below).
  db.exec(`
    ALTER TABLE training_completions ADD COLUMN completion_state TEXT NOT NULL DEFAULT 'completed';
    ALTER TABLE training_completions ADD COLUMN readiness_level INTEGER;
    ALTER TABLE training_completions ADD COLUMN difficulty_feedback TEXT;
    ALTER TABLE training_completions ADD COLUMN duration_feedback TEXT;
    ALTER TABLE training_completions ADD COLUMN discomfort_flag INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE training_completions ADD COLUMN discomfort_flags_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE training_completions ADD COLUMN discomfort_locations_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE training_completions ADD COLUMN discomfort_details TEXT;
    ALTER TABLE training_completions ADD COLUMN substitutions_used_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE training_completions ADD COLUMN felt_too_hard INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE training_completions ADD COLUMN felt_too_easy INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE training_completions ADD COLUMN felt_too_long INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE training_completions ADD COLUMN felt_too_short INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE training_completions ADD COLUMN modality TEXT;
    ALTER TABLE training_completions ADD COLUMN session_role TEXT;
  `);
}

function seedSession(): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans (
      id, user_id, name, sport, goal, duration_weeks, periodization,
      status, start_date, end_date, preferences_json
    ) VALUES (7, 12, 'F18 plan', 'running', 'Complete safely', 4,
              'linear', 'active', '2026-08-01', '2026-08-28', '{}')
  `).run();
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number, focus)
    VALUES (70, 7, 1, 'base')
  `).run();
  testDb.prepare(`
    INSERT INTO training_sessions (
      id, week_id, plan_id, day_of_week, session_type, title, status
    ) VALUES (42, 70, 7, 'Monday', 'running', 'Easy run', 'pending')
  `).run();
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_023, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_187, 'utf8'));
  addExpectedCompletionColumns(testDb);
  seedSession();
  loggerInfoSpy.mockReset();
});

afterEach(() => {
  testDb.close();
});

describe('F18 completion-state persistence', () => {
  it('ships migration 277 with the additive rich feedback columns', () => {
    expect(fs.existsSync(MIGRATION_277)).toBe(true);
    if (!fs.existsSync(MIGRATION_277)) return;
    const source = fs.readFileSync(MIGRATION_277, 'utf8');
    for (const column of [
      'completion_state',
      'readiness_level',
      'difficulty_feedback',
      'duration_feedback',
      'discomfort_flag',
      'discomfort_flags_json',
      'discomfort_locations_json',
      'discomfort_details',
      'substitutions_used_json',
      'felt_too_hard',
      'felt_too_easy',
      'felt_too_long',
      'felt_too_short',
      'modality',
      'session_role',
    ]) {
      expect(source).toContain(column);
    }
  });

  it('persists partial feedback without marking the session completed', () => {
    const completion = logCompletion({
      session_id: 42,
      plan_id: 7,
      completion_state: 'partial',
      completed_duration_sec: 1_680,
      readiness_level: 4,
      difficulty_feedback: 'hard',
      duration_feedback: 'too_short',
      discomfort_flag: true,
      discomfort_flags_json: JSON.stringify(['ankle']),
      discomfort_locations_json: JSON.stringify(['right_ankle']),
      discomfort_details: 'Stopped safely',
      substitutions_used_json: JSON.stringify(['bike']),
      felt_too_hard: true,
      felt_too_short: true,
      modality: 'running',
      session_role: 'long_run',
    } as any) as any;

    expect(completion).toMatchObject({
      completion_state: 'partial',
      readiness_level: 4,
      difficulty_feedback: 'hard',
      discomfort_flag: 1,
      discomfort_details: 'Stopped safely',
      felt_too_hard: 1,
      felt_too_short: 1,
      modality: 'running',
      session_role: 'long_run',
    });
    const session = testDb.prepare('SELECT status FROM training_sessions WHERE id = 42').get() as { status: string };
    expect(session.status).toBe('partial');
    expect(getWeeklyAdherence(7, 70)).toMatchObject({
      completedSessions: 0,
      partialSessions: 1,
      skippedSessions: 0,
      pendingSessions: 0,
      adherenceRate: 50,
    });
  });

  it('persists skipped feedback and keeps adherence honest', () => {
    const completion = logCompletion({
      session_id: 42,
      plan_id: 7,
      completion_state: 'skipped',
      missed_reason: 'schedule_conflict',
    } as any) as any;

    expect(completion).toMatchObject({
      completion_state: 'skipped',
      missed_reason: 'schedule_conflict',
    });
    const session = testDb.prepare('SELECT status FROM training_sessions WHERE id = 42').get() as { status: string };
    expect(session.status).toBe('skipped');
    expect(getWeeklyAdherence(7, 70)).toMatchObject({
      completedSessions: 0,
      partialSessions: 0,
      skippedSessions: 1,
      pendingSessions: 0,
      adherenceRate: 0,
    });
  });

  it('collapses an exact completion retry to one durable row', () => {
    const input = {
      session_id: 42,
      plan_id: 7,
      completion_state: 'partial',
      completed_duration_sec: 1_680,
      readiness_level: 4,
      discomfort_flag: true,
      discomfort_locations_json: JSON.stringify(['right_ankle']),
    } as any;

    const first = logCompletion(input) as any;
    const retry = logCompletion(input) as any;

    // Stronger F18 guarantee: a client retry after a lost response is a replay,
    // not a second training action that biases history/adherence aggregates.
    expect(retry.id).toBe(first.id);
    expect((testDb.prepare(`
      SELECT COUNT(*) AS count FROM training_completions
      WHERE session_id = 42 AND plan_id = 7
    `).get() as { count: number }).count).toBe(1);
    expect((testDb.prepare('SELECT status FROM training_sessions WHERE id = 42').get() as { status: string }).status)
      .toBe('partial');
  });

  it('rolls back when the supplied plan does not own the session', () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (
        id, user_id, name, sport, goal, duration_weeks, periodization,
        status, start_date, end_date, preferences_json
      ) VALUES (8, 99, 'Other plan', 'running', 'Other tenant', 4,
                'linear', 'active', '2026-08-01', '2026-08-28', '{}')
    `).run();

    expect(() => logCompletion({
      session_id: 42,
      plan_id: 8,
      completion_state: 'completed',
    } as any)).toThrow(/TRAINING_COMPLETION_SESSION_PLAN_MISMATCH/);

    expect((testDb.prepare('SELECT COUNT(*) AS count FROM training_completions').get() as { count: number }).count)
      .toBe(0);
    expect((testDb.prepare('SELECT status FROM training_sessions WHERE id = 42').get() as { status: string }).status)
      .toBe('pending');
  });

  it('logs only presence metadata, never raw health feedback values', () => {
    logCompletion({
      session_id: 42,
      plan_id: 7,
      completion_state: 'completed',
      rpe_overall: 9,
      pain_score: 8,
      pain_location: 'private-left-knee',
      discomfort_details: 'private-health-detail',
    } as any);

    const metadata = loggerInfoSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(metadata).toEqual(expect.objectContaining({
      hasRpe: true,
      hasPainScore: true,
      hasPainLocation: true,
      hasDiscomfortDetails: true,
    }));
    expect(metadata).not.toHaveProperty('rpe');
    expect(metadata).not.toHaveProperty('painScore');
    expect(JSON.stringify(loggerInfoSpy.mock.calls)).not.toContain('private-left-knee');
    expect(JSON.stringify(loggerInfoSpy.mock.calls)).not.toContain('private-health-detail');
  });
});
