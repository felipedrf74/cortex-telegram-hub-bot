/**
 * Beta gap 3 (2026-04-24): reliability tests for the onboarding service.
 *
 * These cover the brittle states that caused beta users to either lose
 * data or get stuck in an unrecoverable loop:
 *
 *   - iOS retries a POST /answer after a network blip → server advances
 *     twice → answers written to the wrong step keys.
 *   - iOS sends a stale stepIndex → server silently accepts it, answers
 *     drift out of alignment with the UI.
 *   - Crash / transaction abort between session-UPDATE and
 *     profile-INSERT → user appears to be "still onboarding" forever
 *     because getPendingOnboardings looks at profiles, not sessions.
 *
 * The service now supports optimistic-concurrency via stepIndex and
 * self-heals divergence between the session row and the profile row.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

import {
  startOrResume,
  answerStep,
  getActiveSession,
  getProfile,
  OnboardingStepMismatchError,
  QUESTIONNAIRES,
} from '../../src/services/onboarding';

const USER = 9001;

describe('onboarding idempotent answer (stepIndex concurrency)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  it('advances normally when the client sends the server\'s current step', () => {
    startOrResume(USER, 'fitness');
    const result = answerStep(USER, 'fitness', 'Beginner (< 1 year)', {
      expectedStepIndex: 0,
    });
    expect(result.idempotentReplay).toBeUndefined();
    expect(getActiveSession(USER, 'fitness')?.current_step).toBe(1);
  });

  it('treats a retry of an already-answered step as a no-op (does not double-advance)', () => {
    startOrResume(USER, 'fitness');
    answerStep(USER, 'fitness', 'Beginner (< 1 year)', { expectedStepIndex: 0 });
    // Network blip: client re-sends stepIndex=0 with some arbitrary answer.
    const replay = answerStep(USER, 'fitness', 'Advanced (3+ years)', {
      expectedStepIndex: 0,
    });

    expect(replay.idempotentReplay).toBe(true);
    // Server is still on step 1 — the retry did not advance past it.
    expect(getActiveSession(USER, 'fitness')?.current_step).toBe(1);
    // The original answer is preserved; the retry did NOT overwrite it.
    expect(getActiveSession(USER, 'fitness')?.answers.experience_level)
      .toBe('Beginner (< 1 year)');
  });

  it('rejects a stepIndex ahead of the server with OnboardingStepMismatchError', () => {
    startOrResume(USER, 'fitness');
    // Client thinks it's on step 2 but server is still on step 0.
    expect(() =>
      answerStep(USER, 'fitness', 'irrelevant', { expectedStepIndex: 2 }),
    ).toThrow(OnboardingStepMismatchError);
    // Server cursor is unchanged — the failed call did not consume a step.
    expect(getActiveSession(USER, 'fitness')?.current_step).toBe(0);
  });

  it('keeps legacy callers (no stepIndex) working unchanged', () => {
    startOrResume(USER, 'fitness');
    const result = answerStep(USER, 'fitness', 'Beginner (< 1 year)');
    expect(result.idempotentReplay).toBeUndefined();
    expect(result.nextStep?.key).toBe('weekly_frequency');
  });
});

describe('onboarding completion is transactional', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  it('writes the profile atomically with the final session UPDATE', () => {
    startOrResume(USER, 'fitness');
    const steps = QUESTIONNAIRES.fitness.steps;
    for (let i = 0; i < steps.length; i++) {
      answerStep(USER, 'fitness', steps[i].options?.[0] ?? 'whatever', {
        expectedStepIndex: i,
      });
    }

    const profile = getProfile(USER, 'fitness');
    expect(profile).not.toBeNull();
    expect(profile?.data.experience_level).toBe(steps[0].options?.[0]);

    const row = testDb.prepare(
      "SELECT status FROM onboarding_sessions WHERE user_id = ? AND questionnaire = 'fitness'",
    ).get(USER) as { status: string };
    expect(row.status).toBe('completed');
  });

  it('rolls back the session update when the profile write fails', () => {
    startOrResume(USER, 'fitness');
    const steps = QUESTIONNAIRES.fitness.steps;
    for (let i = 0; i < steps.length - 1; i++) {
      answerStep(USER, 'fitness', steps[i].options?.[0] ?? 'x', {
        expectedStepIndex: i,
      });
    }

    // Force the final saveProfile INSERT to fail by dropping its table
    // RIGHT before the terminal answer. The transaction wrapper around
    // the session UPDATE + profile INSERT must roll both back so the
    // session does NOT end up status='completed' without a profile —
    // that's the exact "stuck forever" state this fixes.
    testDb.exec('DROP TABLE user_profiles');

    expect(() =>
      answerStep(USER, 'fitness', steps[steps.length - 1].options?.[0] ?? 'x', {
        expectedStepIndex: steps.length - 1,
      }),
    ).toThrow();

    // Recreate the table so we can inspect the session row (the session
    // table itself was never dropped — only user_profiles was).
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        profile_type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, profile_type)
      );
    `);

    const row = testDb.prepare(
      "SELECT status, current_step FROM onboarding_sessions WHERE user_id = ? AND questionnaire = 'fitness'",
    ).get(USER) as { status: string; current_step: number };

    // Without the transaction, the session would be `completed` with no
    // profile. With it, the rollback means the session is still
    // in_progress on the penultimate step — the user can retry cleanly.
    expect(row.status).toBe('in_progress');
    expect(row.current_step).toBe(steps.length - 1);

    // And of course no profile row was created.
    expect(getProfile(USER, 'fitness')).toBeNull();
  });
});

describe('onboarding self-heals orphan completed sessions', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  it('re-saves the profile row when re-entering a completed session whose profile was lost', () => {
    // Simulate the pre-fix stuck state: a session marked `completed`
    // with full answers, but no matching user_profiles row — which is
    // exactly what a crash between UPDATE and saveProfile produced
    // before the transaction wrapper landed.
    const storedAnswers = {
      experience_level: 'Beginner (< 1 year)',
      weekly_frequency: '2-3 days',
    };
    testDb.prepare(`
      INSERT INTO onboarding_sessions (user_id, questionnaire, current_step, answers, status, completed_at)
      VALUES (?, 'fitness', 5, ?, 'completed', datetime('now'))
    `).run(USER, JSON.stringify(storedAnswers));

    expect(getProfile(USER, 'fitness')).toBeNull();

    // Re-entering via startOrResume should self-heal the profile.
    startOrResume(USER, 'fitness');

    const profile = getProfile(USER, 'fitness');
    expect(profile).not.toBeNull();
    expect(profile?.data).toMatchObject(storedAnswers);
  });

  it('does not double-write the profile when one already exists', () => {
    const answers = { experience_level: 'Beginner (< 1 year)' };
    testDb.prepare(`
      INSERT INTO onboarding_sessions (user_id, questionnaire, current_step, answers, status, completed_at)
      VALUES (?, 'fitness', 5, ?, 'completed', datetime('now'))
    `).run(USER, JSON.stringify(answers));
    testDb.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, 'fitness', ?)
    `).run(USER, JSON.stringify({ experience_level: 'Advanced (3+ years)' }));

    startOrResume(USER, 'fitness');

    // The heal must NOT stomp an existing profile with stale session data.
    expect(getProfile(USER, 'fitness')?.data.experience_level)
      .toBe('Advanced (3+ years)');
  });
});
