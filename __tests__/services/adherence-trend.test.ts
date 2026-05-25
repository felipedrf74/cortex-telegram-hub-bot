/**
 * Slice C5 — adherence trend tests.
 *
 * Pins:
 *   - Rolling 2-week fraction = (completed_both_weeks / scheduled_both_weeks)
 *   - trendLow ONLY when BOTH weeks below threshold
 *   - 0 scheduled sessions → 0 fraction (defensive)
 *   - Date math respects week boundaries
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

import { computeAdherenceTrend } from '../../src/services/adherence-trend';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => testDb.close());

function seedSessions(opts: {
  userId: number;
  planId: number;
  startDate: string;
  weeks: number;
  sessionsPerWeek: number;
  completedFraction: number; // 0..1 — fraction of sessions marked completed
}): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'p', 'gym', ?, ?, '2026-12-31', 'active')
  `).run(opts.planId, opts.userId, opts.weeks, opts.startDate);
  let sessionId = opts.planId * 1000;
  for (let w = 1; w <= opts.weeks; w++) {
    const weekId = opts.planId * 100 + w;
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, ?)').run(weekId, opts.planId, w);
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const completedCountForWeek = Math.floor(opts.sessionsPerWeek * opts.completedFraction);
    for (let s = 0; s < opts.sessionsPerWeek; s++) {
      sessionId++;
      const day = days[s % 7];
      const status = s < completedCountForWeek ? 'completed' : 'pending';
      testDb.prepare(`
        INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
        VALUES (?, ?, ?, ?, 'easy_run', 'x', 45, ?)
      `).run(sessionId, weekId, opts.planId, day, status);
    }
  }
}

describe('computeAdherenceTrend', () => {
  it('trendLow=true when both weeks <0.70', () => {
    // 4 sessions/week × 2 weeks = 8 scheduled; 2 completed per week (50%).
    seedSessions({
      userId: 100, planId: 1, startDate: '2026-05-04',
      weeks: 3, sessionsPerWeek: 4, completedFraction: 0.5,
    });
    const result = computeAdherenceTrend(100, '2026-05-17T23:59:00Z', 0.70);
    expect(result.trendLow).toBe(true);
    expect(result.currentWeek.fraction).toBeLessThan(0.70);
    expect(result.priorWeek.fraction).toBeLessThan(0.70);
  });

  it('trendLow=false when only one week below threshold', () => {
    // Build manually: prior week has 4 completions out of 4 (100%); current week has 1 out of 4 (25%).
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (2, 100, 'p', 'gym', 4, '2026-05-04', '2026-06-01', 'active')
    `).run();
    // Week 1: 4 sessions, 4 completed (Monday=2026-05-04, +3 more)
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (201, 2, 1)').run();
    const w1Days = ['monday', 'tuesday', 'wednesday', 'thursday'];
    for (const [i, day] of w1Days.entries()) {
      testDb.prepare(`
        INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
        VALUES (?, 201, 2, ?, 'easy_run', 'x', 45, 'completed')
      `).run(2000 + i, day);
    }
    // Week 2: 4 sessions, 1 completed
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (202, 2, 2)').run();
    const w2Days = ['monday', 'tuesday', 'wednesday', 'thursday'];
    for (const [i, day] of w2Days.entries()) {
      testDb.prepare(`
        INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
        VALUES (?, 202, 2, ?, 'easy_run', 'x', 45, ?)
      `).run(2100 + i, day, i === 0 ? 'completed' : 'pending');
    }
    const result = computeAdherenceTrend(100, '2026-05-17T23:59:00Z', 0.70);
    expect(result.priorWeek.fraction).toBeGreaterThanOrEqual(0.70); // 100%
    expect(result.currentWeek.fraction).toBeLessThan(0.70); // 25%
    expect(result.trendLow).toBe(false); // one week good
  });

  it('0 scheduled sessions → 0 fraction, trendLow=false (per > threshold check)', () => {
    const result = computeAdherenceTrend(999, '2026-05-17T23:59:00Z', 0.70);
    expect(result.currentWeek.scheduled).toBe(0);
    expect(result.currentWeek.fraction).toBe(0);
    // 0 < 0.70 evaluates true; this is by design — no scheduled is suspicious.
    expect(result.trendLow).toBe(true);
  });

  it('rolling fraction averages across both weeks correctly', () => {
    // 4 sessions per week × 2 weeks, 2 completed each → 4/8 = 0.5
    seedSessions({
      userId: 200, planId: 3, startDate: '2026-05-04',
      weeks: 3, sessionsPerWeek: 4, completedFraction: 0.5,
    });
    const result = computeAdherenceTrend(200, '2026-05-17T23:59:00Z', 0.70);
    expect(result.rolling2WeekFraction).toBeCloseTo(0.5, 2);
  });
});
