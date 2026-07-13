/**
 * Slice 4.E — training-history.ts pin tests.
 *
 * Closes Phase 0 audit Layer-8 finding (Critical: blocks credible
 * long-term coaching). The pre-slice planner used
 * `buildTrailingSeries(currentWeekMinutes)` — 4 copies of one
 * synthesized number — making ACWR math meaningless.
 *
 * These tests pin:
 *   - empty-history case returns undefined per sport (caller falls
 *     back to synthesis)
 *   - per-sport per-week bucketing is correct
 *   - sport normalization (gym/strength/lifting all map to 'strength')
 *   - cross-user isolation (other user's completions don't leak)
 *   - 28-day window boundary (older completions excluded)
 *   - mixed-sport real data: e.g. real running + no strength history
 *     → real running, undefined strength
 *   - oldest-first ordering of trailing4WeekMinutesBySport series
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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
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
  readTrainingComplianceFromRecentHistory,
  readTrainingHistoryFromCompletions,
} from '../../src/services/training-history';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

interface SeedOpts {
  userId: number;
  tenantId?: number;
  sessionType: string;
  daysAgo: number;
  durationMin: number;
  baseId: number;
}

function seed(opts: SeedOpts): void {
  const tenantId = opts.tenantId ?? opts.userId;
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Test', ?, 12, '2026-01-01', '2026-04-01', 'active')
  `).run(opts.baseId, opts.userId, tenantId, opts.sessionType);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)
  `).run(opts.baseId, opts.baseId);

  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, ?, ?, 'Monday', ?, 'Session', ?, 'completed')
  `).run(opts.baseId, opts.baseId, opts.baseId, opts.sessionType, opts.durationMin);

  // Compute completed_at = asOf - daysAgo (in UTC).
  const completedAt = new Date(ASOF.getTime() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString();

  testDb.prepare(`
    INSERT INTO training_completions
      (session_id, plan_id, completed_at, duration_minutes)
    VALUES (?, ?, ?, ?)
  `).run(opts.baseId, opts.baseId, completedAt, opts.durationMin);
}

function seedSessionAction(opts: SeedOpts & {
  status: 'completed' | 'skipped';
  actualDurationMin?: number;
}): void {
  const tenantId = opts.tenantId ?? opts.userId;
  const actionAt = new Date(ASOF.getTime() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString();

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Compliance Test', ?, 12, '2026-01-01', '2026-04-01', 'active')
  `).run(opts.baseId, opts.userId, tenantId, opts.sessionType);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)
  `).run(opts.baseId, opts.baseId);

  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status, updated_at)
    VALUES (?, ?, ?, 'Monday', ?, 'Session', ?, ?, ?)
  `).run(opts.baseId, opts.baseId, opts.baseId, opts.sessionType, opts.durationMin, opts.status, actionAt);

  if (opts.status === 'completed') {
    testDb.prepare(`
      INSERT INTO training_completions
        (session_id, plan_id, completed_at, duration_minutes)
      VALUES (?, ?, ?, ?)
    `).run(opts.baseId, opts.baseId, actionAt, opts.actualDurationMin ?? opts.durationMin);
  }
}

const ASOF = new Date('2026-04-27T12:00:00.000Z');
const READ = (userId: number, tenantId = userId) => readTrainingHistoryFromCompletions(userId, { asOf: ASOF, tenantId });

describe('training-history — empty case', () => {
  it('returns no-history when the user has no completions', () => {
    const result = READ(100);
    expect(result.hasAnyHistory).toBe(false);
    expect(result.rawCompletionCount).toBe(0);
    expect(result.lastWeekMinutesBySport).toEqual({});
    expect(result.trailing4WeekMinutesBySport).toEqual({});
  });

  it('returns no-history when only a different user has completions', () => {
    seed({ userId: 200, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    const result = READ(100);
    expect(result.hasAnyHistory).toBe(false);
  });

  it('fails closed to no-history when tenantId is missing', () => {
    seed({ userId: 100, tenantId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    const result = readTrainingHistoryFromCompletions(100, { asOf: ASOF });
    expect(result.hasAnyHistory).toBe(false);
    expect(result.rawCompletionCount).toBe(0);
  });

  it('does not leak same-user completions from another tenant', () => {
    seed({ userId: 100, tenantId: 200, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    const result = READ(100, 100);
    expect(result.hasAnyHistory).toBe(false);

    const tenantResult = READ(100, 200);
    expect(tenantResult.hasAnyHistory).toBe(true);
    expect(tenantResult.lastWeekMinutesBySport.running).toBe(45);
  });
});

describe('training-history — bucketing', () => {
  it('buckets completion in last 7 days into week 0 (most recent)', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    const result = READ(100);
    expect(result.hasAnyHistory).toBe(true);
    expect(result.lastWeekMinutesBySport.running).toBe(45);
    // Series is OLDEST FIRST: [w3, w2, w1, w0]
    expect(result.trailing4WeekMinutesBySport.running).toEqual([0, 0, 0, 45]);
  });

  it('normalizes offset timestamps to UTC in recent sessions', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    testDb.prepare(`
      UPDATE training_completions
         SET completed_at = '2026-04-27T01:00:00+02:00'
       WHERE session_id = 1
    `).run();

    const result = READ(100);

    expect(result.recentSessions[0].completedAt).toBe('2026-04-26T23:00:00.000Z');
    expect(result.recentSessions[0].id).toContain('2026-04-26T23:00:00.000Z');
  });

  it('buckets completion 8-14 days ago into week 1', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 10, durationMin: 60, baseId: 1 });
    const result = READ(100);
    expect(result.trailing4WeekMinutesBySport.running).toEqual([0, 0, 60, 0]);
  });

  it('buckets completion 21-27 days ago into week 3 (oldest)', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 25, durationMin: 30, baseId: 1 });
    const result = READ(100);
    expect(result.trailing4WeekMinutesBySport.running).toEqual([30, 0, 0, 0]);
  });

  it('excludes completion 28+ days ago (outside window)', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 30, durationMin: 50, baseId: 1 });
    const result = READ(100);
    expect(result.hasAnyHistory).toBe(false);
  });

  it('sums multiple completions in the same week-bucket', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    seed({ userId: 100, sessionType: 'running', daysAgo: 5, durationMin: 30, baseId: 2 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(75);
  });

  it('lastWeekMinutesBySport equals series[3] (most recent week)', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 1 });
    seed({ userId: 100, sessionType: 'running', daysAgo: 10, durationMin: 60, baseId: 2 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(45);
    expect(result.trailing4WeekMinutesBySport.running![3]).toBe(45);
    expect(result.trailing4WeekMinutesBySport.running![2]).toBe(60);
  });
});

describe('training-history — sport normalization', () => {
  it('maps gym/strength/lifting all to "strength"', () => {
    seed({ userId: 100, sessionType: 'gym', daysAgo: 1, durationMin: 30, baseId: 1 });
    seed({ userId: 100, sessionType: 'strength', daysAgo: 2, durationMin: 40, baseId: 2 });
    seed({ userId: 100, sessionType: 'lifting', daysAgo: 3, durationMin: 50, baseId: 3 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.strength).toBe(120);
  });

  it('maps run/running/easy_run/long_run all to "running"', () => {
    seed({ userId: 100, sessionType: 'easy_run', daysAgo: 1, durationMin: 30, baseId: 1 });
    seed({ userId: 100, sessionType: 'long_run', daysAgo: 2, durationMin: 90, baseId: 2 });
    seed({ userId: 100, sessionType: 'running', daysAgo: 3, durationMin: 45, baseId: 3 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(165);
  });

  it('maps cycling variants to "cycling"', () => {
    seed({ userId: 100, sessionType: 'endurance_ride', daysAgo: 1, durationMin: 60, baseId: 1 });
    seed({ userId: 100, sessionType: 'cycling', daysAgo: 2, durationMin: 90, baseId: 2 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.cycling).toBe(150);
  });

  it('drops completions whose session_type is "rest" or unknown', () => {
    seed({ userId: 100, sessionType: 'rest', daysAgo: 1, durationMin: 30, baseId: 1 });
    seed({ userId: 100, sessionType: 'something_unknown', daysAgo: 2, durationMin: 30, baseId: 2 });
    const result = READ(100);
    expect(result.hasAnyHistory).toBe(false);
  });
});

describe('training-history — recent compliance', () => {
  it('derives compliance from completed, partial, and skipped recent actions', () => {
    seedSessionAction({
      userId: 100,
      sessionType: 'easy_run',
      daysAgo: 1,
      durationMin: 50,
      baseId: 9001,
      status: 'completed',
    });
    seedSessionAction({
      userId: 100,
      sessionType: 'threshold_run',
      daysAgo: 2,
      durationMin: 60,
      actualDurationMin: 20,
      baseId: 9002,
      status: 'completed',
    });
    seedSessionAction({
      userId: 100,
      sessionType: 'long_run',
      daysAgo: 3,
      durationMin: 90,
      baseId: 9003,
      status: 'skipped',
    });

    const result = readTrainingComplianceFromRecentHistory(100, { tenantId: 100, asOf: ASOF });

    expect(result.hasSignal).toBe(true);
    expect(result.actionCount).toBe(3);
    expect(result.completedCount).toBe(1);
    expect(result.partialCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.compliance?.trailing14DayCompliance).toBeCloseTo(0.5, 5);
    expect(result.compliance?.bySport.running).toBeCloseTo(1.5, 5);
    expect(result.compliance?.missedKeySessions).toBe(1);
    expect(result.compliance?.consecutiveMisses).toBe(0);
  });

  it('counts consecutive misses from the most recent history items', () => {
    seedSessionAction({
      userId: 100,
      sessionType: 'long_run',
      daysAgo: 1,
      durationMin: 90,
      baseId: 9011,
      status: 'skipped',
    });
    seedSessionAction({
      userId: 100,
      sessionType: 'threshold_run',
      daysAgo: 2,
      durationMin: 50,
      baseId: 9012,
      status: 'skipped',
    });
    seedSessionAction({
      userId: 100,
      sessionType: 'easy_run',
      daysAgo: 3,
      durationMin: 40,
      baseId: 9013,
      status: 'completed',
    });

    const result = readTrainingComplianceFromRecentHistory(100, { tenantId: 100, asOf: ASOF });

    expect(result.compliance?.consecutiveMisses).toBe(2);
    expect(result.compliance?.missedKeySessions).toBe(2);
    expect(result.compliance?.trailing14DayCompliance).toBeCloseTo(1 / 3, 5);
  });

  it('does not derive compliance from another tenant or without tenant scope', () => {
    seedSessionAction({
      userId: 100,
      tenantId: 200,
      sessionType: 'easy_run',
      daysAgo: 1,
      durationMin: 50,
      baseId: 9021,
      status: 'completed',
    });

    expect(readTrainingComplianceFromRecentHistory(100, { tenantId: 100, asOf: ASOF }).hasSignal).toBe(false);
    expect(readTrainingComplianceFromRecentHistory(100, { asOf: ASOF }).hasSignal).toBe(false);
  });

  it('keeps SQLite no-offset timestamps on the UTC compliance boundary', () => {
    const asOf = new Date('2026-04-27T00:30:00.000Z');
    seedSessionAction({
      userId: 100,
      sessionType: 'easy_run',
      daysAgo: 1,
      durationMin: 45,
      baseId: 9031,
      status: 'completed',
    });
    seedSessionAction({
      userId: 100,
      sessionType: 'easy_run',
      daysAgo: 2,
      durationMin: 45,
      baseId: 9032,
      status: 'completed',
    });

    testDb.prepare(`
      UPDATE training_completions
         SET completed_at = '2026-04-13 00:15:00'
       WHERE session_id = 9031
    `).run();
    testDb.prepare(`
      UPDATE training_sessions
         SET updated_at = '2026-04-13 00:15:00'
       WHERE id = 9031
    `).run();
    testDb.prepare(`
      UPDATE training_completions
         SET completed_at = '2026-04-12 23:59:59'
       WHERE session_id = 9032
    `).run();
    testDb.prepare(`
      UPDATE training_sessions
         SET updated_at = '2026-04-12 23:59:59'
       WHERE id = 9032
    `).run();

    const result = readTrainingComplianceFromRecentHistory(100, { tenantId: 100, asOf });

    expect(result.hasSignal).toBe(true);
    expect(result.actionCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.compliance?.bySport.running).toBe(1);
  });
});

describe('training-history — multi-sport mix', () => {
  it('returns real data per sport without leakage', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 2, durationMin: 50, baseId: 1 });
    seed({ userId: 100, sessionType: 'gym', daysAgo: 3, durationMin: 40, baseId: 2 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(50);
    expect(result.lastWeekMinutesBySport.strength).toBe(40);
    expect(result.lastWeekMinutesBySport.cycling).toBeUndefined();
    expect(result.lastWeekMinutesBySport.swimming).toBeUndefined();
  });

  it('omits sports with no completions from trailing4WeekMinutesBySport', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 2, durationMin: 50, baseId: 1 });
    const result = READ(100);
    expect(result.trailing4WeekMinutesBySport.running).toEqual([0, 0, 0, 50]);
    expect(result.trailing4WeekMinutesBySport.strength).toBeUndefined();
    expect(result.trailing4WeekMinutesBySport.cycling).toBeUndefined();
    expect(result.trailing4WeekMinutesBySport.swimming).toBeUndefined();
  });

  it('reports rawCompletionCount across all sports + weeks', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 2, durationMin: 50, baseId: 1 });
    seed({ userId: 100, sessionType: 'gym', daysAgo: 3, durationMin: 40, baseId: 2 });
    seed({ userId: 100, sessionType: 'cycling', daysAgo: 10, durationMin: 60, baseId: 3 });
    const result = READ(100);
    expect(result.rawCompletionCount).toBe(3);
  });
});

describe('training-history — duration fallback', () => {
  it('uses training_completions.duration_minutes when set', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 2, durationMin: 45, baseId: 1 });
    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(45);
  });

  it('returns recent feedback samples for the coach feedback loop', () => {
    seed({ userId: 100, sessionType: 'running', daysAgo: 2, durationMin: 45, baseId: 1 });
    testDb.prepare(`
      UPDATE training_completions
      SET duration_minutes = 62,
          rpe_overall = 9,
          soreness_level = 8,
          energy_level = 3,
          actual_exercises_json = ?
      WHERE session_id = 1
    `).run(JSON.stringify({ distance_km: 10, notes: 'substituted because hotel travel' }));

    const result = READ(100);
    expect(result.recentSessions).toHaveLength(1);
    expect(result.recentSessions[0]).toMatchObject({
      sport: 'running',
      sessionType: 'easy_run',
      plannedDurationMinutes: 45,
      actualDurationMinutes: 62,
      rpe: 9,
      sorenessLevel: 8,
      energyLevel: 3,
      distanceKm: 10,
      feedbackTags: expect.arrayContaining(['too_hard', 'too_long', 'pain', 'substitution', 'travel']),
    });
  });

  it('falls back to training_sessions.duration_minutes when completion has no duration', () => {
    // Insert plan + week + session with duration 60.
    testDb.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (1, 100, 100, 'Test', 'running', 12, '2026-01-01', '2026-04-01', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1, 1, 1)
    `).run();
    testDb.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (1, 1, 1, 'Monday', 'running', 'Run', 60, 'completed')
    `).run();
    // Completion has NULL duration_minutes — should pull from session row.
    const completedAt = new Date(ASOF.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    testDb.prepare(`
      INSERT INTO training_completions
        (session_id, plan_id, completed_at, duration_minutes)
      VALUES (1, 1, ?, NULL)
    `).run(completedAt);

    const result = READ(100);
    expect(result.lastWeekMinutesBySport.running).toBe(60);
  });
});
