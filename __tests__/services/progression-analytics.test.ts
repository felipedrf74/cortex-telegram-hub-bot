/**
 * Phase 4 Slice D — Progression analytics tests
 *
 * Four layers:
 *
 *   1. Pure functions — normalizeLiftName + estimateOneRm with no DB.
 *   2. JSON parsing shapes — the defensive parser handles flat,
 *      nested-sets, and mixed field-name variants without throwing.
 *   3. End-to-end aggregation — getStrengthProgression against a real
 *      in-memory SQLite DB seeded with completion fixtures; covers
 *      empty state, single-session, trend classification, window
 *      filtering, and user isolation.
 *   4. Prompt formatter — the <athlete_progression> block renders
 *      correctly for every trend and stays empty when there's nothing
 *      to show.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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
  normalizeLiftName,
  estimateOneRm,
  extractStrengthDataPoints,
  getStrengthProgression,
  formatStrengthProgressionForPrompt,
  extractCardioDataPoints,
  getCardioProgression,
  formatCardioProgressionForPrompt,
  type CanonicalLift,
  type CardioSport,
} from '../../src/services/progression-analytics';

// ─── Fixture helpers ────────────────────────────────────────────

/**
 * Seed a plan + week + session + completion with the given
 * `actual_exercises_json` payload at the given date. Returns the
 * completion id for reference.
 */
function seedCompletion(opts: {
  userId: number;
  tenantId?: number;
  completedAt: string;
  actualExercisesJson: string | null;
  baseId?: number;
}): void {
  const base = opts.baseId ?? Math.floor(Math.random() * 1_000_000);
  const tenantId = opts.tenantId ?? opts.userId;

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Test plan', 'strength', 12, '2026-01-01', '2027-01-01', 'active')
  `).run(base, opts.userId, tenantId);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number)
    VALUES (?, ?, 1)
  `).run(base, base);

  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, status)
    VALUES (?, ?, ?, 'Monday', 'strength', 'Strength', 'completed')
  `).run(base, base, base);

  testDb.prepare(`
    INSERT INTO training_completions
      (session_id, plan_id, completed_at, actual_exercises_json)
    VALUES (?, ?, ?, ?)
  `).run(base, base, opts.completedAt, opts.actualExercisesJson);
}

// ─── Layer 1: pure functions ────────────────────────────────────

describe('normalizeLiftName', () => {
  const cases: Array<[string, CanonicalLift | null]> = [
    // Back squat variants
    ['Back Squat', 'Back Squat'],
    ['back squat', 'Back Squat'],
    ['BB Back Squat', 'Back Squat'],
    ['squat', 'Back Squat'],
    ['squats', 'Back Squat'],
    ['low-bar squat', 'Back Squat'],
    ['low bar squat', 'Back Squat'],
    ['barbell squat', 'Back Squat'],
    // Front squat
    ['Front Squat', 'Front Squat'],
    ['front squat', 'Front Squat'],
    // Squat exclusions
    ['goblet squat', null],
    ['bulgarian split squat', null],
    ['pistol squat', null],
    ['hack squat', null],
    ['box squat', null],
    // Bench variants
    ['Bench Press', 'Bench Press'],
    ['bench press', 'Bench Press'],
    ['bench', 'Bench Press'],
    // Bench exclusions
    ['incline bench press', null],
    ['decline bench', null],
    ['close-grip bench', null],
    ['dumbbell bench press', null],
    ['DB bench', null],
    // Deadlift
    ['Deadlift', 'Deadlift'],
    ['deadlift', 'Deadlift'],
    ['DL', 'Deadlift'],
    ['deadlifts', 'Deadlift'],
    // Deadlift exclusions
    ['Romanian deadlift', null],
    ['RDL', null],
    ['stiff-leg deadlift', null],
    ['sumo deadlift', null],
    ['trap-bar deadlift', null],
    ['rack pull', null],
    // OHP
    ['OHP', 'Overhead Press'],
    ['overhead press', 'Overhead Press'],
    ['Military Press', 'Overhead Press'],
    ['strict press', 'Overhead Press'],
    // OHP exclusions
    ['push press', null],
    ['clean and jerk', null],
    // Nonsense
    ['', null],
    ['pull-up', null],
    ['lateral raise', null],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected ?? 'null'}`, () => {
      expect(normalizeLiftName(input)).toBe(expected);
    });
  }

  it('handles non-string inputs gracefully', () => {
    expect(normalizeLiftName(null as any)).toBeNull();
    expect(normalizeLiftName(undefined as any)).toBeNull();
    expect(normalizeLiftName(42 as any)).toBeNull();
  });
});

describe('estimateOneRm — Epley formula', () => {
  it('returns the weight itself for a 1-rep max attempt', () => {
    expect(estimateOneRm(150, 1)).toBe(150);
  });

  it('computes 5×150 → 175.0 (150 × (1 + 5/30) = 175)', () => {
    expect(estimateOneRm(150, 5)).toBe(175);
  });

  it('computes 3×180 → 198.0 (180 × (1 + 3/30) = 198)', () => {
    expect(estimateOneRm(180, 3)).toBe(198);
  });

  it('returns 0 for invalid inputs', () => {
    expect(estimateOneRm(0, 5)).toBe(0);
    expect(estimateOneRm(150, 0)).toBe(0);
    expect(estimateOneRm(-50, 5)).toBe(0);
  });

  it('rounds to 1 decimal', () => {
    // 100 × (1 + 7/30) = 123.333...
    expect(estimateOneRm(100, 7)).toBe(123.3);
  });
});

// ─── Layer 2: JSON parsing shapes ───────────────────────────────

describe('extractStrengthDataPoints — JSON shape variants', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });

  it('parses a flat array with top-level weight+reps', () => {
    const json = JSON.stringify([
      { name: 'Back Squat', weight: 140, reps: 5 },
      { name: 'Bench Press', weight: 100, reps: 3 },
    ]);
    seedCompletion({ userId: 100, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 1 });

    const dps = extractStrengthDataPoints(100, 100, 8, ref);
    expect(dps).toHaveLength(2);
    expect(dps.find(d => d.lift === 'Back Squat')).toMatchObject({ weightKg: 140, reps: 5 });
    expect(dps.find(d => d.lift === 'Bench Press')).toMatchObject({ weightKg: 100, reps: 3 });
  });

  it('parses weight_kg field alias', () => {
    const json = JSON.stringify([{ name: 'Deadlift', weight_kg: 180, reps: 3 }]);
    seedCompletion({ userId: 101, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 2 });

    const dps = extractStrengthDataPoints(101, 101, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0]).toMatchObject({ lift: 'Deadlift', weightKg: 180, reps: 3 });
  });

  it('parses nested sets array — picks heaviest 1RM set', () => {
    const json = JSON.stringify([
      {
        name: 'Back Squat',
        sets: [
          { weight: 120, reps: 10 }, // 1RM ≈ 160
          { weight: 140, reps: 5 },  // 1RM ≈ 163.3
          { weight: 150, reps: 3 },  // 1RM ≈ 165 ← winner
          { weight: 145, reps: 4 },  // 1RM ≈ 164.3
        ],
      },
    ]);
    seedCompletion({ userId: 102, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 3 });

    const dps = extractStrengthDataPoints(102, 102, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0]).toMatchObject({ lift: 'Back Squat', weightKg: 150, reps: 3 });
  });

  it('parses a single exercise object (not wrapped in an array)', () => {
    const json = JSON.stringify({ name: 'Overhead Press', weight: 60, reps: 5 });
    seedCompletion({ userId: 103, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 4 });

    const dps = extractStrengthDataPoints(103, 103, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0].lift).toBe('Overhead Press');
  });

  it('accepts "exercise" as an alias for "name"', () => {
    const json = JSON.stringify([{ exercise: 'squats', weight: 140, reps: 5 }]);
    seedCompletion({ userId: 104, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 5 });

    const dps = extractStrengthDataPoints(104, 104, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0].lift).toBe('Back Squat');
  });

  it('accepts string-typed numbers ("weight": "140")', () => {
    const json = JSON.stringify([{ name: 'Bench', weight: '100', reps: '5' }]);
    seedCompletion({ userId: 105, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 6 });

    const dps = extractStrengthDataPoints(105, 105, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0]).toMatchObject({ weightKg: 100, reps: 5 });
  });

  it('skips unparseable JSON without throwing', () => {
    seedCompletion({ userId: 106, completedAt: '2026-04-07T12:00:00', actualExercisesJson: 'not valid json', baseId: 7 });
    const dps = extractStrengthDataPoints(106, 106, 8, ref);
    expect(dps).toEqual([]);
  });

  it('skips null actual_exercises_json', () => {
    seedCompletion({ userId: 107, completedAt: '2026-04-07T12:00:00', actualExercisesJson: null, baseId: 8 });
    const dps = extractStrengthDataPoints(107, 107, 8, ref);
    expect(dps).toEqual([]);
  });

  it('skips exercises not in the tracked main-lift set', () => {
    const json = JSON.stringify([
      { name: 'lateral raise', weight: 10, reps: 15 },
      { name: 'bicep curl', weight: 20, reps: 10 },
      { name: 'Back Squat', weight: 140, reps: 5 },
    ]);
    seedCompletion({ userId: 108, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 9 });

    const dps = extractStrengthDataPoints(108, 108, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0].lift).toBe('Back Squat');
  });

  it('filters sets with reps > 10 (Epley unreliable)', () => {
    const json = JSON.stringify([
      {
        name: 'Back Squat',
        sets: [
          { weight: 80, reps: 20 },  // skipped — too many reps
          { weight: 100, reps: 8 },  // kept
        ],
      },
    ]);
    seedCompletion({ userId: 109, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 10 });

    const dps = extractStrengthDataPoints(109, 109, 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0]).toMatchObject({ weightKg: 100, reps: 8 });
  });

  it('ignores negative/zero weights', () => {
    const json = JSON.stringify([
      { name: 'Back Squat', weight: 0, reps: 5 },
      { name: 'Bench Press', weight: -50, reps: 5 },
    ]);
    seedCompletion({ userId: 110, completedAt: '2026-04-07T12:00:00', actualExercisesJson: json, baseId: 11 });

    const dps = extractStrengthDataPoints(110, 110, 8, ref);
    expect(dps).toEqual([]);
  });
});

// ─── Layer 3: end-to-end aggregation ────────────────────────────

describe('getStrengthProgression', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });

  /** Seed a sequence of Back Squat sessions at given dates + weights. */
  function seedSquatSessions(userId: number, sessions: Array<[string, number, number]>, tenantId = userId) {
    // Use a dedicated plan for all sessions so they share plan_id scope
    const planBase = Math.floor(Math.random() * 100_000) + userId;
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, 'Plan', 'strength', 12, '2026-01-01', '2027-01-01', 'active')
    `).run(planBase, userId, tenantId);
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)
    `).run(planBase, planBase);

    for (let i = 0; i < sessions.length; i++) {
      const [date, weight, reps] = sessions[i];
      const sid = planBase * 100 + i;
      testDb.prepare(`
        INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, status)
        VALUES (?, ?, ?, 'Monday', 'strength', 'Squat day', 'completed')
      `).run(sid, planBase, planBase);
      testDb.prepare(`
        INSERT INTO training_completions (session_id, plan_id, completed_at, actual_exercises_json)
        VALUES (?, ?, ?, ?)
      `).run(sid, planBase, date, JSON.stringify([{ name: 'Back Squat', weight, reps }]));
    }
  }

  it('returns empty lifts when the user has no completions', () => {
    const report = getStrengthProgression(200, 200, 8, ref);
    expect(report.userId).toBe(200);
    expect(report.lifts).toEqual([]);
  });

  it('reports insufficient_data for a lift with only one session', () => {
    seedSquatSessions(201, [['2026-04-01T12:00:00', 140, 5]]);
    const report = getStrengthProgression(201, 201, 8, ref);
    expect(report.lifts).toHaveLength(1);
    expect(report.lifts[0].lift).toBe('Back Squat');
    expect(report.lifts[0].trend).toBe('insufficient_data');
    expect(report.lifts[0].deltaKg).toBeNull();
  });

  it('classifies an UP trend when current > start by more than 2.5%', () => {
    // Reference is 2026-04-08, so the 8-week window starts at 2026-02-11.
    // All 5 dates below must be ≥ 2026-02-11 to be included in the report.
    seedSquatSessions(202, [
      ['2026-02-15T12:00:00', 140, 5],  // estimated 1RM 163.3
      ['2026-03-01T12:00:00', 145, 5],  // 169.2
      ['2026-03-15T12:00:00', 150, 5],  // 175.0
      ['2026-03-29T12:00:00', 155, 5],  // 180.8
      ['2026-04-05T12:00:00', 160, 5],  // 186.7
    ]);
    const report = getStrengthProgression(202, 202, 8, ref);
    expect(report.lifts).toHaveLength(1);
    const squat = report.lifts[0];
    expect(squat.trend).toBe('up');
    expect(squat.startOneRm).toBeCloseTo(163.3, 1);
    expect(squat.currentOneRm).toBeCloseTo(186.7, 1);
    expect(squat.deltaKg).toBeGreaterThan(0);
    expect(squat.deltaPct).toBeGreaterThan(2.5);
  });

  it('classifies a FLAT trend when delta is within the ±2.5% band', () => {
    seedSquatSessions(203, [
      ['2026-02-10T12:00:00', 140, 5],  // 163.3
      ['2026-02-24T12:00:00', 140, 5],  // 163.3
      ['2026-03-10T12:00:00', 140, 5],
      ['2026-04-07T12:00:00', 140, 5],
    ]);
    const report = getStrengthProgression(203, 203, 8, ref);
    expect(report.lifts[0].trend).toBe('flat');
  });

  it('classifies a DOWN trend when current drops below -2.5%', () => {
    seedSquatSessions(204, [
      ['2026-02-10T12:00:00', 150, 5],  // 175
      ['2026-02-24T12:00:00', 145, 5],
      ['2026-03-10T12:00:00', 140, 5],
      ['2026-04-07T12:00:00', 130, 5],  // 151.7 — down ~13%
    ]);
    const report = getStrengthProgression(204, 204, 8, ref);
    expect(report.lifts[0].trend).toBe('down');
    expect(report.lifts[0].deltaPct).toBeLessThan(-2.5);
  });

  it('respects the window — sessions outside the window are excluded', () => {
    seedSquatSessions(205, [
      ['2025-12-01T12:00:00', 120, 5],  // 10+ weeks ago, outside 8-week window
      ['2026-03-01T12:00:00', 140, 5],
      ['2026-04-05T12:00:00', 150, 5],
    ]);
    const report = getStrengthProgression(205, 205, 8, ref);
    expect(report.lifts[0].dataPoints).toHaveLength(2);
    expect(report.lifts[0].dataPoints[0].date).toBe('2026-03-01');
  });

  it('keeps users isolated', () => {
    seedSquatSessions(300, [
      ['2026-03-01T12:00:00', 140, 5],
      ['2026-04-01T12:00:00', 150, 5],
    ]);
    seedSquatSessions(301, [
      ['2026-03-01T12:00:00', 80, 5],
      ['2026-04-01T12:00:00', 85, 5],
    ]);

    const a = getStrengthProgression(300, 300, 8, ref);
    const b = getStrengthProgression(301, 301, 8, ref);

    expect(a.lifts[0].currentOneRm).not.toBe(b.lifts[0].currentOneRm);
    expect(a.lifts[0].dataPoints.every(d => d.weightKg > 100)).toBe(true);
    expect(b.lifts[0].dataPoints.every(d => d.weightKg < 100)).toBe(true);
  });

  it('keeps same-user strength progression isolated by tenant', () => {
    seedSquatSessions(302, [
      ['2026-03-01T12:00:00', 140, 5],
      ['2026-04-01T12:00:00', 150, 5],
    ], 30);
    seedSquatSessions(302, [
      ['2026-03-01T12:00:00', 80, 5],
      ['2026-04-01T12:00:00', 85, 5],
    ], 40);

    const tenantA = getStrengthProgression(302, 30, 8, ref);
    const tenantB = getStrengthProgression(302, 40, 8, ref);

    expect(tenantA.lifts[0].currentOneRm).not.toBe(tenantB.lifts[0].currentOneRm);
    expect(tenantA.lifts[0].dataPoints.every(d => d.weightKg > 100)).toBe(true);
    expect(tenantB.lifts[0].dataPoints.every(d => d.weightKg < 100)).toBe(true);
  });
});

// ─── Layer 4: prompt formatter ──────────────────────────────────

describe('formatStrengthProgressionForPrompt', () => {
  it('returns empty string when no lifts have data', () => {
    const result = formatStrengthProgressionForPrompt({
      userId: 1,
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      lifts: [],
    });
    expect(result).toBe('');
  });

  it('renders the tagged block with one line per lift', () => {
    const result = formatStrengthProgressionForPrompt({
      userId: 1,
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      lifts: [
        {
          lift: 'Back Squat',
          dataPoints: [],
          startOneRm: 140,
          currentOneRm: 152.5,
          deltaKg: 12.5,
          deltaPct: 8.9,
          trend: 'up',
        },
        {
          lift: 'Bench Press',
          dataPoints: [],
          startOneRm: 100,
          currentOneRm: 100,
          deltaKg: 0,
          deltaPct: 0,
          trend: 'flat',
        },
      ],
    });
    expect(result).toContain('<athlete_progression window_weeks="8">');
    expect(result).toContain('Back Squat: 140kg → 152.5kg (+12.5kg, +8.9%), trending UP');
    expect(result).toContain('Bench Press: 100kg → 100kg (+0kg, +0%), trending FLAT');
    expect(result).toContain('</athlete_progression>');
  });

  it('renders insufficient_data lifts with a distinct line', () => {
    const result = formatStrengthProgressionForPrompt({
      userId: 1,
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      lifts: [
        {
          lift: 'Deadlift',
          dataPoints: [],
          startOneRm: 180,
          currentOneRm: 180,
          deltaKg: null,
          deltaPct: null,
          trend: 'insufficient_data',
        },
      ],
    });
    expect(result).toContain('Deadlift: one session only — insufficient data for a trend.');
    expect(result).not.toContain('trending');
  });
});

// ════════════════════════════════════════════════════════════════
// Phase 4 Slice F — Cardio progression (running + cycling)
// ════════════════════════════════════════════════════════════════
//
// Four layers mirror the strength suite above:
//
//   1. Extraction — parsing distance/duration from a cardio completion
//      under its many `actual_exercises_json` shapes (distance_km,
//      distance+unit, nested metrics, meters, miles).
//   2. Sport filtering — only sessions whose `session_type` maps to
//      the requested sport are counted; gym / swim / other are ignored.
//   3. End-to-end aggregation — getCardioProgression against an
//      in-memory SQLite DB covering empty, single-week, trend
//      classification, window filtering, and user isolation.
//   4. Prompt formatter — the coach context lines render with the
//      right totals/trend and fall back gracefully on empty data.

/**
 * Seed a cardio completion with explicit session_type, duration, and
 * actual_exercises_json. Mirrors `seedCompletion` but exposes the
 * session type as a parameter so both running and cycling rows can
 * land in the same DB from one test.
 */
function seedCardioCompletion(opts: {
  userId: number;
  tenantId?: number;
  sessionType: 'running' | 'cycling' | 'strength' | 'swim' | string;
  completedAt: string;
  durationMinutes: number | null;
  actualExercisesJson: string | null;
  baseId?: number;
  completedDurationSec?: number | null;
}): void {
  const base = opts.baseId ?? Math.floor(Math.random() * 1_000_000);
  const tenantId = opts.tenantId ?? opts.userId;

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Cardio plan', ?, 12, '2026-01-01', '2027-01-01', 'active')
  `).run(base, opts.userId, tenantId, opts.sessionType);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number)
    VALUES (?, ?, 1)
  `).run(base, base);

  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, status, duration_minutes)
    VALUES (?, ?, ?, 'Monday', ?, ?, 'completed', ?)
  `).run(base, base, base, opts.sessionType, `${opts.sessionType} session`, opts.durationMinutes);

  testDb.prepare(`
    INSERT INTO training_completions
      (session_id, plan_id, completed_at, duration_minutes, actual_exercises_json,
       completed_duration_sec)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    base, base, opts.completedAt, opts.durationMinutes, opts.actualExercisesJson,
    opts.completedDurationSec ?? null,
  );
}

// ─── Layer 1: extraction ────────────────────────────────────────

describe('extractCardioDataPoints', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });

  it('parses distance_km directly from an exercises blob', () => {
    seedCardioCompletion({
      userId: 400,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 42,
      actualExercisesJson: JSON.stringify({ distance_km: 8.5 }),
      baseId: 400,
    });
    const dps = extractCardioDataPoints(400, 400, 'running', 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0].distanceKm).toBeCloseTo(8.5, 2);
    expect(dps[0].durationMin).toBe(42);
    expect(dps[0].date).toBe('2026-04-05');
  });

  it('parses distance + meters unit into km', () => {
    seedCardioCompletion({
      userId: 401,
      sessionType: 'cycling',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 60,
      actualExercisesJson: JSON.stringify({ distance: 25000, unit: 'm' }),
      baseId: 401,
    });
    const dps = extractCardioDataPoints(401, 401, 'cycling', 8, ref);
    expect(dps[0].distanceKm).toBeCloseTo(25, 2);
  });

  it('parses distance + miles unit into km', () => {
    seedCardioCompletion({
      userId: 402,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 30,
      actualExercisesJson: JSON.stringify({ distance: 5, unit: 'mi' }),
      baseId: 402,
    });
    const dps = extractCardioDataPoints(402, 402, 'running', 8, ref);
    // 5 miles ≈ 8.04672 km
    expect(dps[0].distanceKm).toBeCloseTo(8.04, 1);
  });

  it('parses distance from a nested metrics object', () => {
    seedCardioCompletion({
      userId: 403,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 35,
      actualExercisesJson: JSON.stringify({ metrics: { distance_km: 7.2 } }),
      baseId: 403,
    });
    const dps = extractCardioDataPoints(403, 403, 'running', 8, ref);
    expect(dps[0].distanceKm).toBeCloseTo(7.2, 2);
  });

  it('parses distance from an array-wrapped entry', () => {
    seedCardioCompletion({
      userId: 404,
      sessionType: 'cycling',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 90,
      actualExercisesJson: JSON.stringify([{ distance_km: 45 }]),
      baseId: 404,
    });
    const dps = extractCardioDataPoints(404, 404, 'cycling', 8, ref);
    expect(dps[0].distanceKm).toBeCloseTo(45, 2);
  });

  it('keeps a duration-only entry (distance=0) as a valid data point', () => {
    seedCardioCompletion({
      userId: 405,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 40,
      actualExercisesJson: null, // no structured data, just duration
      baseId: 405,
    });
    const dps = extractCardioDataPoints(405, 405, 'running', 8, ref);
    expect(dps).toHaveLength(1);
    expect(dps[0].distanceKm).toBe(0);
    expect(dps[0].durationMin).toBe(40);
  });

  it('skips entries with neither distance nor duration', () => {
    seedCardioCompletion({
      userId: 406,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: null,
      actualExercisesJson: null,
      baseId: 406,
    });
    const dps = extractCardioDataPoints(406, 406, 'running', 8, ref);
    expect(dps).toEqual([]);
  });

  it('rerun-5 S12 — includes iOS-logged completions that only carry completed_duration_sec', () => {
    // iOS /complete writes the V2 seconds column, never the legacy
    // duration_minutes. Reading only the legacy column made the chart
    // claim "No running logged" while history showed the session.
    seedCardioCompletion({
      userId: 412,
      sessionType: 'run',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: null,
      actualExercisesJson: null,
      completedDurationSec: 35 * 60,
      baseId: 412,
    });
    const dps = extractCardioDataPoints(412, 412, 'running', 8, ref);
    expect(dps).toEqual([
      { date: '2026-04-05', distanceKm: 0, durationMin: 35 },
    ]);
  });

  it('only returns sessions for the requested sport', () => {
    // Two rows for user 407 — one running, one cycling.
    seedCardioCompletion({
      userId: 407,
      sessionType: 'running',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 30,
      actualExercisesJson: JSON.stringify({ distance_km: 5 }),
      baseId: 407,
    });
    seedCardioCompletion({
      userId: 407,
      sessionType: 'cycling',
      completedAt: '2026-04-05T18:00:00',
      durationMinutes: 60,
      actualExercisesJson: JSON.stringify({ distance_km: 30 }),
      baseId: 408,
    });

    const runs = extractCardioDataPoints(407, 407, 'running', 8, ref);
    const rides = extractCardioDataPoints(407, 407, 'cycling', 8, ref);
    expect(runs).toHaveLength(1);
    expect(runs[0].distanceKm).toBeCloseTo(5, 2);
    expect(rides).toHaveLength(1);
    expect(rides[0].distanceKm).toBeCloseTo(30, 2);
  });

  it('ignores strength sessions entirely', () => {
    seedCardioCompletion({
      userId: 409,
      sessionType: 'strength',
      completedAt: '2026-04-05T08:00:00',
      durationMinutes: 60,
      actualExercisesJson: JSON.stringify([{ name: 'Back Squat', weight: 140, reps: 5 }]),
      baseId: 409,
    });
    const runs = extractCardioDataPoints(409, 409, 'running', 8, ref);
    expect(runs).toEqual([]);
  });
});

// ─── Layer 2: end-to-end aggregation ────────────────────────────

describe('getCardioProgression', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });

  /** Seed a run-of-runs at given (date, km, minutes) tuples. */
  function seedRuns(userId: number, runs: Array<[string, number, number]>, tenantId = userId) {
    const planBase = Math.floor(Math.random() * 100_000) + userId;
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, 'Running plan', 'running', 12, '2026-01-01', '2027-01-01', 'active')
    `).run(planBase, userId, tenantId);
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)
    `).run(planBase, planBase);

    for (let i = 0; i < runs.length; i++) {
      const [date, km, minutes] = runs[i];
      const sid = planBase * 100 + i;
      testDb.prepare(`
        INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, status, duration_minutes)
        VALUES (?, ?, ?, 'Monday', 'running', 'Run', 'completed', ?)
      `).run(sid, planBase, planBase, minutes);
      testDb.prepare(`
        INSERT INTO training_completions (session_id, plan_id, completed_at, duration_minutes, actual_exercises_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(sid, planBase, date, minutes, JSON.stringify({ distance_km: km }));
    }
  }

  it('returns an insufficient_data report when the user has no runs', () => {
    const report = getCardioProgression(500, 500, 'running', 8, ref);
    expect(report.userId).toBe(500);
    expect(report.sport).toBe('running');
    expect(report.weeks).toEqual([]);
    expect(report.trend).toBe('insufficient_data');
    expect(report.totalKm).toBe(0);
    expect(report.totalSessions).toBe(0);
  });

  it('reports a single-week run as insufficient_data but tracks totals', () => {
    // Both dates land in the SAME ISO week (Mon 2026-04-06 → Sun 2026-04-12).
    // Picking a Sunday + Monday pair would split across two ISO weeks.
    seedRuns(501, [
      ['2026-04-06T08:00:00', 5, 30],
      ['2026-04-07T08:00:00', 7, 42],
    ]);
    const report = getCardioProgression(501, 501, 'running', 8, ref);
    expect(report.weeks).toHaveLength(1);
    expect(report.weeks[0].sessions).toBe(2);
    expect(report.weeks[0].distanceKm).toBeCloseTo(12, 1);
    expect(report.weeks[0].longestKm).toBeCloseTo(7, 1);
    expect(report.trend).toBe('insufficient_data');
    expect(report.totalKm).toBeCloseTo(12, 1);
    expect(report.totalSessions).toBe(2);
    expect(report.totalDurationMin).toBe(72);
  });

  it('classifies an UP trend when weekly km grows > 2.5%', () => {
    // Week of Feb 23 (25 km) vs week of Apr 6 (38 km) → +52%
    seedRuns(502, [
      ['2026-02-24T08:00:00', 10, 50],
      ['2026-02-26T08:00:00', 15, 80],
      ['2026-04-06T08:00:00', 20, 100],
      ['2026-04-07T08:00:00', 18, 90],
    ]);
    const report = getCardioProgression(502, 502, 'running', 8, ref);
    expect(report.weeks.length).toBeGreaterThanOrEqual(2);
    expect(report.startWeeklyKm).toBeCloseTo(25, 1);
    expect(report.currentWeeklyKm).toBeCloseTo(38, 1);
    expect(report.trend).toBe('up');
    expect(report.deltaKm).toBeCloseTo(13, 1);
    expect(report.deltaPct).toBeGreaterThan(2.5);
  });

  it('classifies a FLAT trend when weekly km stays within ±2.5%', () => {
    seedRuns(503, [
      ['2026-02-24T08:00:00', 20, 100],
      ['2026-04-06T08:00:00', 20, 100],
    ]);
    const report = getCardioProgression(503, 503, 'running', 8, ref);
    expect(report.trend).toBe('flat');
  });

  it('classifies a DOWN trend when weekly km drops below -2.5%', () => {
    seedRuns(504, [
      ['2026-02-24T08:00:00', 30, 150],
      ['2026-04-06T08:00:00', 20, 100],
    ]);
    const report = getCardioProgression(504, 504, 'running', 8, ref);
    expect(report.trend).toBe('down');
    expect(report.deltaKm).toBeLessThan(0);
  });

  it('respects the window — sessions outside the window are excluded', () => {
    seedRuns(505, [
      ['2025-12-01T08:00:00', 50, 240], // ~18 weeks ago, outside 8-week window
      ['2026-03-15T08:00:00', 10, 60],
      ['2026-04-05T08:00:00', 12, 65],
    ]);
    const report = getCardioProgression(505, 505, 'running', 8, ref);
    // The stale December run must NOT contribute
    expect(report.totalKm).toBeCloseTo(22, 1);
    expect(report.weeks.every((w) => w.weekStart >= '2026-02-09')).toBe(true);
  });

  it('keeps users isolated', () => {
    seedRuns(600, [
      ['2026-03-15T08:00:00', 50, 300],
      ['2026-04-05T08:00:00', 55, 320],
    ]);
    seedRuns(601, [
      ['2026-03-15T08:00:00', 5, 30],
      ['2026-04-05T08:00:00', 6, 35],
    ]);

    const a = getCardioProgression(600, 600, 'running', 8, ref);
    const b = getCardioProgression(601, 601, 'running', 8, ref);

    expect(a.totalKm).toBeGreaterThan(b.totalKm);
    expect(a.weeks.every((w) => w.distanceKm >= 50)).toBe(true);
    expect(b.weeks.every((w) => w.distanceKm <= 10)).toBe(true);
  });

  it('keeps same-user cardio progression isolated by tenant', () => {
    seedRuns(602, [
      ['2026-03-15T08:00:00', 50, 300],
      ['2026-04-05T08:00:00', 55, 320],
    ], 60);
    seedRuns(602, [
      ['2026-03-15T08:00:00', 5, 30],
      ['2026-04-05T08:00:00', 6, 35],
    ], 70);

    const tenantA = getCardioProgression(602, 60, 'running', 8, ref);
    const tenantB = getCardioProgression(602, 70, 'running', 8, ref);

    expect(tenantA.totalKm).toBeGreaterThan(tenantB.totalKm);
    expect(tenantA.weeks.every((w) => w.distanceKm >= 50)).toBe(true);
    expect(tenantB.weeks.every((w) => w.distanceKm <= 10)).toBe(true);
  });

  it('only counts cycling sessions when sport=cycling is requested', () => {
    // Mix: 3 runs + 2 rides, same user
    seedRuns(700, [
      ['2026-03-15T08:00:00', 10, 60],
      ['2026-04-05T08:00:00', 12, 65],
    ]);
    seedCardioCompletion({
      userId: 700,
      sessionType: 'cycling',
      completedAt: '2026-03-16T08:00:00',
      durationMinutes: 90,
      actualExercisesJson: JSON.stringify({ distance_km: 40 }),
      baseId: 710,
    });
    seedCardioCompletion({
      userId: 700,
      sessionType: 'cycling',
      completedAt: '2026-04-06T08:00:00',
      durationMinutes: 120,
      actualExercisesJson: JSON.stringify({ distance_km: 55 }),
      baseId: 711,
    });

    const runReport = getCardioProgression(700, 700, 'running', 8, ref);
    const rideReport = getCardioProgression(700, 700, 'cycling', 8, ref);
    expect(runReport.totalSessions).toBe(2);
    expect(runReport.totalKm).toBeCloseTo(22, 1);
    expect(rideReport.totalSessions).toBe(2);
    expect(rideReport.totalKm).toBeCloseTo(95, 1);
  });
});

// ─── Layer 3: prompt formatter ──────────────────────────────────

describe('formatCardioProgressionForPrompt', () => {
  it('returns empty string when no weeks have data', () => {
    const result = formatCardioProgressionForPrompt({
      userId: 1,
      sport: 'running',
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      weeks: [],
      startWeeklyKm: null,
      currentWeeklyKm: null,
      deltaKm: null,
      deltaPct: null,
      totalKm: 0,
      totalDurationMin: 0,
      totalSessions: 0,
      trend: 'insufficient_data',
    });
    expect(result).toBe('');
  });

  it('renders the cardio summary with totals and trend for UP', () => {
    const result = formatCardioProgressionForPrompt({
      userId: 1,
      sport: 'running',
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      weeks: [
        { weekStart: '2026-02-09', distanceKm: 25, durationMin: 120, sessions: 3, longestKm: 10 },
        { weekStart: '2026-04-06', distanceKm: 38, durationMin: 180, sessions: 4, longestKm: 18 },
      ],
      startWeeklyKm: 25,
      currentWeeklyKm: 38,
      deltaKm: 13,
      deltaPct: 52,
      totalKm: 63,
      totalDurationMin: 300,
      totalSessions: 7,
      trend: 'up',
    });
    expect(result).toContain('Running — past 8 weeks:');
    expect(result).toContain('Total: 63km across 7 sessions (5h 0m)');
    expect(result).toContain('Weekly km: 25km → 38km (+13km, +52%), trending UP');
    expect(result).toContain('Longest session: 18km');
  });

  it('renders the Cycling label for cycling sport', () => {
    const result = formatCardioProgressionForPrompt({
      userId: 1,
      sport: 'cycling',
      windowWeeks: 8,
      windowStart: '2026-02-10T00:00:00Z',
      weeks: [
        { weekStart: '2026-04-06', distanceKm: 80, durationMin: 180, sessions: 2, longestKm: 50 },
      ],
      startWeeklyKm: 80,
      currentWeeklyKm: 80,
      deltaKm: null,
      deltaPct: null,
      totalKm: 80,
      totalDurationMin: 180,
      totalSessions: 2,
      trend: 'insufficient_data',
    });
    expect(result).toContain('Cycling — past 8 weeks:');
    expect(result).toContain('Total: 80km across 2 sessions (3h 0m)');
    expect(result).toContain('Weekly km: not enough weeks for a trend yet.');
  });

  it('formats duration under an hour without the h prefix', () => {
    const result = formatCardioProgressionForPrompt({
      userId: 1,
      sport: 'running',
      windowWeeks: 4,
      windowStart: '2026-03-10T00:00:00Z',
      weeks: [
        { weekStart: '2026-04-06', distanceKm: 5, durationMin: 35, sessions: 1, longestKm: 5 },
      ],
      startWeeklyKm: 5,
      currentWeeklyKm: 5,
      deltaKm: null,
      deltaPct: null,
      totalKm: 5,
      totalDurationMin: 35,
      totalSessions: 1,
      trend: 'insufficient_data',
    });
    expect(result).toContain('(35m)');
    expect(result).not.toContain('0h');
  });
});
