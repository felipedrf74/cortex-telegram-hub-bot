/**
 * Slice C4 — gap detector + ReturnProtocol classification tests.
 *
 * Pins:
 *   - No gap when recent completion exists
 *   - Vacation-or-life-gap when no concurrent signals
 *   - Febrile_or_systemic_illness when fever symptom present
 *   - Post_exertional_symptom_risk overrides febrile
 *   - Injury_localized when only pain signals present
 *   - Minor_illness_resolved when non-fever illness only
 *   - Declared protocol always wins over inference
 *   - Returns null when gap < minGapDays
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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
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
      } catch { /* skip deps */ }
    }
  }
}

import { detectTrainingGap } from '../../src/services/gap-detector';
import { recordHealthSignal } from '../../src/services/health-signals';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => testDb.close());

function seedPlanWithCompletion(opts: { userId: number; completedAt: string }): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (1, ?, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
  `).run(opts.userId);
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1, 1, 1)
  `).run();
  testDb.prepare(`
    INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (1, 1, 1, 'monday', 'easy_run', 'x', 45, 'completed')
  `).run();
  testDb.prepare(`
    INSERT INTO training_completions (session_id, plan_id, completed_at, rpe_overall)
    VALUES (1, 1, ?, 6)
  `).run(opts.completedAt);
}

describe('detectTrainingGap — basic detection', () => {
  it('no gap when recent completion exists', () => {
    seedPlanWithCompletion({ userId: 100, completedAt: '2026-05-20T10:00:00Z' });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z', // 3 days
      minGapDays: 7,
    });
    expect(gap).toBeNull();
  });

  it('detects gap when last completion is >= minGapDays old', () => {
    seedPlanWithCompletion({ userId: 100, completedAt: '2026-05-01T10:00:00Z' });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z', // 22 days
      minGapDays: 7,
    });
    expect(gap).not.toBeNull();
    expect(gap!.gapDays).toBeGreaterThanOrEqual(20);
  });

  it('handles user with no completions (treats as very large gap)', () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (1, 100, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap).not.toBeNull();
    expect(gap!.gapDays).toBeGreaterThanOrEqual(7);
  });
});

describe('protocol classification', () => {
  beforeEach(() => {
    seedPlanWithCompletion({ userId: 100, completedAt: '2026-05-01T10:00:00Z' });
  });

  it('no signals → vacation_or_life_gap', () => {
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap!.protocol).toBe('vacation_or_life_gap');
  });

  it('fever symptom → febrile_or_systemic_illness', () => {
    recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      illnessSymptoms: ['fever', 'fatigue'],
      consentScope: ['illness'],
    });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap!.protocol).toBe('febrile_or_systemic_illness');
  });

  it('post-exertional symptom overrides febrile (slower ramp)', () => {
    recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      illnessSymptoms: ['fever', 'post_exertional_malaise'],
      consentScope: ['illness'],
    });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap!.protocol).toBe('post_exertional_symptom_risk');
  });

  it('pain only (no illness) → injury_localized', () => {
    recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      painScore: 6,
      painLocation: 'left calf',
      consentScope: ['pain'],
    });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap!.protocol).toBe('injury_localized');
  });

  it('non-fever illness only → minor_illness_resolved', () => {
    recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      illnessSymptoms: ['cough', 'congestion'],
      consentScope: ['illness'],
    });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });
    expect(gap!.protocol).toBe('minor_illness_resolved');
  });

  it('declared protocol wins over inference', () => {
    recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
      declaredProtocol: 'vacation_or_life_gap',
    });
    expect(gap!.protocol).toBe('vacation_or_life_gap');
  });
});

// R8 P1-3 — corrupt illness_symptoms_json was silently skipped,
// which downgrades an illness gap to "vacation" and applies the
// wrong return-from-gap ramp. The fix logs warn so SRE can spot
// recurring corruption AND a misclassified gap can be correlated
// after the fact.
describe('R8 P1-3 — corrupt illness_symptoms_json logs a warn', () => {
  beforeEach(() => {
    seedPlanWithCompletion({ userId: 100, completedAt: '2026-05-01T10:00:00Z' });
  });

  it('corrupt JSON in a single signal → warn fires AND classification falls back to minor_illness_resolved (signal row exists, symptoms unreadable)', async () => {
    // Insert a real fever signal first so the row exists with a
    // sensible date, then corrupt its illness_symptoms_json. The
    // pain/menstrual/etc. columns stay null so this signal contributes
    // ONLY through the JSON parse path.
    const inserted = recordHealthSignal({
      userId: 100,
      date: '2026-05-10',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    testDb.prepare(
      'UPDATE athlete_health_signals SET illness_symptoms_json = ? WHERE id = ?',
    ).run('{not-json', inserted.id);

    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();

    const gap = detectTrainingGap({
      userId: 100,
      asOfISODate: '2026-05-23T10:00:00Z',
    });

    // Without readable symptoms but with an illness-row present,
    // the classifier safely degrades to minor_illness_resolved
    // (between vacation and febrile_or_systemic). This is the
    // conservative middle ground; the warn lets SRE catch the
    // corruption signal so the misclassification can be repaired.
    expect(gap!.protocol).toBe('minor_illness_resolved');

    // The warn fired with the right context.
    const corruptCalls = warnSpy.mock.calls.filter(
      ([, msg]) => msg === 'gap_detector.illness_symptoms_parse_failed',
    );
    expect(corruptCalls.length).toBe(1);
    const meta = corruptCalls[0]?.[0] as { userId: number; signalId: number; err: unknown };
    expect(meta.userId).toBe(100);
    expect(meta.signalId).toBe(inserted.id);
    expect(meta.err).toBeInstanceOf(Error);
  });
});
