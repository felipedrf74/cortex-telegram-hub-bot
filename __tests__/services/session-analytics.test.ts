/**
 * Phase 4 Slice A — session analytics tests
 *
 * Three layers:
 *
 *   1. computeStreaks — pure function, covers current/longest streak
 *      edge cases without touching the database.
 *   2. getWeeklyActivitySummary — end-to-end aggregation against a
 *      real in-memory SQLite DB with training_plans + sessions +
 *      completions rows seeded per test.
 *   3. Sport normalization — raw session_type values map to the
 *      canonical 5-sport enum.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  getWeeklyActivitySummary,
  computeStreaks,
  type SportKey,
} from '../../src/services/session-analytics';

// ─── Fixture helpers ────────────────────────────────────────────────

/**
 * Seed a training plan + week + session + completion in a single
 * call. Returns the completion row ID so tests that care can reference
 * it. The fixture deliberately hard-codes `plan_id`, `week_id`,
 * `session_id` to values derived from `baseId` so multiple calls in
 * the same test don't collide.
 */
function seedCompletion(opts: {
  userId: number;
  sport: string;              // raw session_type value
  completedAt: string;        // ISO 8601
  rpe?: number;
  durationMin?: number;
  baseId?: number;            // unique suffix for plan/week/session/completion IDs
}): void {
  const base = opts.baseId ?? Math.floor(Math.random() * 1_000_000);

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'Test plan', ?, 12, '2026-01-01', '2026-04-01', 'active')
  `).run(base, opts.userId, opts.sport);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number)
    VALUES (?, ?, 1)
  `).run(base, base);

  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, ?, ?, 'Monday', ?, 'Test session', ?, 'completed')
  `).run(base, base, base, opts.sport, opts.durationMin ?? 60);

  testDb.prepare(`
    INSERT INTO training_completions
      (session_id, plan_id, completed_at, rpe_overall, duration_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(base, base, opts.completedAt, opts.rpe ?? null, opts.durationMin ?? null);
}

/** Midnight-aligned ISO string for a given Luxon DateTime. */
function isoAt(dt: DateTime, hour: number = 12): string {
  return dt.set({ hour, minute: 0, second: 0, millisecond: 0 }).toISO()!;
}

// ─── Pure function: computeStreaks ───────────────────────────────────

describe('computeStreaks', () => {
  const reference = DateTime.fromISO('2026-04-10T12:00:00', { zone: 'Europe/Lisbon' });

  it('returns 0/0 when there are no completion days', () => {
    const result = computeStreaks([], reference);
    expect(result.currentDays).toBe(0);
    expect(result.longestDays).toBe(0);
  });

  it('counts a single day as a 1-day streak', () => {
    const result = computeStreaks(['2026-04-10'], reference);
    expect(result.currentDays).toBe(1);
    expect(result.longestDays).toBe(1);
  });

  it('counts consecutive days ending today', () => {
    const days = ['2026-04-08', '2026-04-09', '2026-04-10'];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(3);
    expect(result.longestDays).toBe(3);
  });

  it('starts the current streak at yesterday when today is empty', () => {
    // Felipe hasn't trained yet today (it's 12pm) — streak should
    // still credit yesterday's session.
    const days = ['2026-04-07', '2026-04-08', '2026-04-09'];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(3);
    expect(result.longestDays).toBe(3);
  });

  it('returns 0 current streak when neither today nor yesterday exist', () => {
    const days = ['2026-04-01', '2026-04-02', '2026-04-03'];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(0);
    // Longest is still 3 from the earlier run
    expect(result.longestDays).toBe(3);
  });

  it('finds the longest streak in a gapped history', () => {
    const days = [
      '2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24', // 5-day run
      '2026-03-27', '2026-03-28',                                           // 2-day run
      '2026-04-09', '2026-04-10',                                           // current
    ];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(2);
    expect(result.longestDays).toBe(5);
  });

  it('deduplicates multiple completions on the same day', () => {
    const days = ['2026-04-09', '2026-04-09', '2026-04-09', '2026-04-10'];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(2);
    expect(result.longestDays).toBe(2);
  });

  it('handles a gap before today gracefully', () => {
    // Today has a completion but yesterday is empty — still 1
    const days = ['2026-04-07', '2026-04-10'];
    const result = computeStreaks(days, reference);
    expect(result.currentDays).toBe(1);
    expect(result.longestDays).toBe(1);
  });
});

// ─── End-to-end: getWeeklyActivitySummary against real DB ───────────

describe('getWeeklyActivitySummary', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const tz = 'Europe/Lisbon';

  it('returns an empty summary when the user has no completions', () => {
    const summary = getWeeklyActivitySummary(100);
    expect(summary.userId).toBe(100);
    expect(summary.totalCompletions).toBe(0);
    expect(summary.totalDurationMin).toBe(0);
    expect(summary.avgRpe).toBeNull();
    expect(summary.streak.currentDays).toBe(0);

    // Every sport key present with zeros
    const sports: SportKey[] = ['gym', 'running', 'cycling', 'swim', 'other'];
    for (const sport of sports) {
      expect(summary.bySport[sport].completions).toBe(0);
      expect(summary.bySport[sport].totalDurationMin).toBe(0);
      expect(summary.bySport[sport].avgRpe).toBeNull();
    }
  });

  it('includes week start/end as ISO 8601 strings', () => {
    const summary = getWeeklyActivitySummary(101);
    // Luxon's startOfWeek is Monday at 00:00:00 in the local TZ
    expect(summary.weekStart).toMatch(/T00:00:00\.000/);
    expect(summary.weekEnd).toMatch(/T23:59:59\.999/);
  });

  it('counts completions within the current week only', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const thisWeekMonday = ref.startOf('week');

    seedCompletion({
      userId: 200,
      sport: 'strength',
      completedAt: isoAt(thisWeekMonday),
      rpe: 8,
      durationMin: 60,
      baseId: 1,
    });
    // Last week — should be excluded
    seedCompletion({
      userId: 200,
      sport: 'running',
      completedAt: isoAt(thisWeekMonday.minus({ days: 3 })),
      rpe: 7,
      durationMin: 45,
      baseId: 2,
    });

    const summary = getWeeklyActivitySummary(200, ref);
    expect(summary.totalCompletions).toBe(1);
    expect(summary.bySport.gym.completions).toBe(1);
    expect(summary.bySport.running.completions).toBe(0);
  });

  it('normalizes session_type values to the canonical sport enum', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    // Seed one completion per raw sport type
    const entries: Array<[string, SportKey, number]> = [
      ['strength', 'gym', 10],
      ['gym', 'gym', 11],
      ['running', 'running', 12],
      ['run', 'running', 13],
      ['cycling', 'cycling', 14],
      ['bike', 'cycling', 15],
      ['swim', 'swim', 16],
      ['swimming', 'swim', 17],
      ['mobility', 'other', 18],
      ['recovery', 'other', 19],
    ];

    for (const [rawSport, _, baseId] of entries) {
      seedCompletion({
        userId: 300,
        sport: rawSport,
        completedAt: isoAt(monday),
        durationMin: 30,
        baseId,
      });
    }

    const summary = getWeeklyActivitySummary(300, ref);
    expect(summary.bySport.gym.completions).toBe(2);
    expect(summary.bySport.running.completions).toBe(2);
    expect(summary.bySport.cycling.completions).toBe(2);
    expect(summary.bySport.swim.completions).toBe(2);
    expect(summary.bySport.other.completions).toBe(2);
    expect(summary.totalCompletions).toBe(10);
  });

  it('sums duration_minutes per sport correctly', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    seedCompletion({ userId: 400, sport: 'running', completedAt: isoAt(monday), durationMin: 30, baseId: 20 });
    seedCompletion({ userId: 400, sport: 'running', completedAt: isoAt(monday), durationMin: 45, baseId: 21 });
    seedCompletion({ userId: 400, sport: 'strength', completedAt: isoAt(monday), durationMin: 60, baseId: 22 });

    const summary = getWeeklyActivitySummary(400, ref);
    expect(summary.bySport.running.totalDurationMin).toBe(75);
    expect(summary.bySport.gym.totalDurationMin).toBe(60);
    expect(summary.totalDurationMin).toBe(135);
  });

  it('computes per-sport average RPE with one decimal precision', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    seedCompletion({ userId: 500, sport: 'strength', completedAt: isoAt(monday), rpe: 8, durationMin: 60, baseId: 30 });
    seedCompletion({ userId: 500, sport: 'strength', completedAt: isoAt(monday), rpe: 9, durationMin: 60, baseId: 31 });
    seedCompletion({ userId: 500, sport: 'strength', completedAt: isoAt(monday), rpe: 7, durationMin: 60, baseId: 32 });

    const summary = getWeeklyActivitySummary(500, ref);
    expect(summary.bySport.gym.avgRpe).toBe(8.0);
    expect(summary.avgRpe).toBe(8.0);
  });

  it('handles null RPE rows without crashing', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    seedCompletion({ userId: 600, sport: 'running', completedAt: isoAt(monday), durationMin: 30, baseId: 40 });
    // No rpe passed → stored as NULL
    seedCompletion({ userId: 600, sport: 'running', completedAt: isoAt(monday), rpe: 6, durationMin: 40, baseId: 41 });

    const summary = getWeeklyActivitySummary(600, ref);
    expect(summary.bySport.running.completions).toBe(2);
    expect(summary.bySport.running.avgRpe).toBe(6.0); // only the non-null counts
  });

  it('keeps users isolated — one user\'s completions never leak to another', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    seedCompletion({ userId: 700, sport: 'running', completedAt: isoAt(monday), durationMin: 30, baseId: 50 });
    seedCompletion({ userId: 701, sport: 'cycling', completedAt: isoAt(monday), durationMin: 60, baseId: 51 });

    const a = getWeeklyActivitySummary(700, ref);
    const b = getWeeklyActivitySummary(701, ref);

    expect(a.totalCompletions).toBe(1);
    expect(a.bySport.running.completions).toBe(1);
    expect(a.bySport.cycling.completions).toBe(0);

    expect(b.totalCompletions).toBe(1);
    expect(b.bySport.cycling.completions).toBe(1);
    expect(b.bySport.running.completions).toBe(0);
  });

  it('computes current + longest streak from completion days', () => {
    const ref = DateTime.fromISO('2026-04-10T14:00:00', { zone: tz });

    // Seed a few days with completions: today, yesterday, 2 days ago,
    // plus an older run of 4 consecutive days
    const today = ref.startOf('day');
    seedCompletion({ userId: 800, sport: 'strength', completedAt: isoAt(today), durationMin: 60, baseId: 60 });
    seedCompletion({ userId: 800, sport: 'running', completedAt: isoAt(today.minus({ days: 1 })), durationMin: 30, baseId: 61 });
    seedCompletion({ userId: 800, sport: 'strength', completedAt: isoAt(today.minus({ days: 2 })), durationMin: 60, baseId: 62 });
    // 4-day run earlier
    seedCompletion({ userId: 800, sport: 'running', completedAt: isoAt(today.minus({ days: 15 })), durationMin: 30, baseId: 63 });
    seedCompletion({ userId: 800, sport: 'running', completedAt: isoAt(today.minus({ days: 16 })), durationMin: 30, baseId: 64 });
    seedCompletion({ userId: 800, sport: 'running', completedAt: isoAt(today.minus({ days: 17 })), durationMin: 30, baseId: 65 });
    seedCompletion({ userId: 800, sport: 'running', completedAt: isoAt(today.minus({ days: 18 })), durationMin: 30, baseId: 66 });

    const summary = getWeeklyActivitySummary(800, ref);
    expect(summary.streak.currentDays).toBe(3);
    expect(summary.streak.longestDays).toBe(4);
  });

  it('streak includes completions outside the current week', () => {
    // A completion 10 days ago doesn't contribute to the weekly
    // counts but DOES contribute to the streak lookback.
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: tz });
    const monday = ref.startOf('week');

    seedCompletion({ userId: 900, sport: 'strength', completedAt: isoAt(monday.minus({ days: 10 })), durationMin: 60, baseId: 70 });

    const summary = getWeeklyActivitySummary(900, ref);
    expect(summary.totalCompletions).toBe(0);
    expect(summary.streak.longestDays).toBe(1); // the 10-days-ago session
  });
});
