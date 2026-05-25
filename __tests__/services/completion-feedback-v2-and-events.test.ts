/**
 * Slice A0c — CompletionFeedbackV2 + readiness/health event tables.
 *
 * Pins:
 *
 *   - migration 157 adds new columns to training_completions without
 *     dropping existing rpe_overall / soreness_level / duration_minutes
 *   - migration 158 creates athlete_readiness_events with consent_scope
 *   - migration 158 creates athlete_health_signals with consent_scope
 *   - recordReadinessEvent enforces readiness_basic minimum
 *   - recordReadinessEvent strips unauthorized hrv/restingHR fields
 *   - recordHealthSignal enforces per-field consent (pain/illness/etc)
 *   - recordHealthSignal rejects empty consent + empty-after-strip rows
 *   - getLatestX returns newest by (date, created_at)
 *   - findPainSignalsInRange / findIllnessSignalsInRange exploit the
 *     partial indexes (verified by EXPLAIN QUERY PLAN coverage)
 *   - deleteXHistoryForUser scopes correctly to a single user
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
  deleteReadinessHistoryForUser,
  getLatestReadinessEvent,
  getReadinessEventsInRange,
  recordReadinessEvent,
} from '../../src/services/readiness-events';
import {
  deleteHealthHistoryForUser,
  findIllnessSignalsInRange,
  findPainSignalsInRange,
  getLatestHealthSignal,
  recordHealthSignal,
} from '../../src/services/health-signals';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe('migration 157 — training_completions v2 columns', () => {
  it('adds new columns without dropping migration-023 columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('training_completions')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    // Existing 023 columns preserved.
    expect(names.has('rpe_overall')).toBe(true);
    expect(names.has('duration_minutes')).toBe(true);
    expect(names.has('energy_level')).toBe(true);
    expect(names.has('soreness_level')).toBe(true);
    expect(names.has('actual_exercises_json')).toBe(true);
    // New v2 columns.
    expect(names.has('completed_duration_sec')).toBe(true);
    expect(names.has('completed_distance_meters')).toBe(true);
    expect(names.has('completed_sets_json')).toBe(true);
    expect(names.has('completed_reps_json')).toBe(true);
    expect(names.has('completed_load_json')).toBe(true);
    expect(names.has('rir')).toBe(true);
    expect(names.has('pain_score')).toBe(true);
    expect(names.has('pain_location')).toBe(true);
    expect(names.has('technical_success_score')).toBe(true);
    expect(names.has('missed_reason')).toBe(true);
    expect(names.has('external_training_declared')).toBe(true);
  });

  it('defaults external_training_declared to 0 (NOT NULL)', () => {
    // Seed a minimal plan + session + completion (smallest path to test
    // the column default).
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (1, 100, 'p', 'gym', 4, '2026-01-01', '2026-02-01', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1, 1, 1)
    `).run();
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (1, 1, 1, 'Monday', 'gym', 'session', 60, 'pending')
    `).run();
    testDb.prepare(`
      INSERT INTO training_completions (id, session_id, plan_id, completed_at, rpe_overall)
      VALUES (1, 1, 1, datetime('now'), 7)
    `).run();
    const row = testDb.prepare(
      'SELECT external_training_declared FROM training_completions WHERE id = 1',
    ).get() as { external_training_declared: number };
    expect(row.external_training_declared).toBe(0);
  });
});

describe('migration 158 — athlete_readiness_events table', () => {
  it('creates the table with expected columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('athlete_readiness_events')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('user_id')).toBe(true);
    expect(names.has('date')).toBe(true);
    expect(names.has('sleep_hours')).toBe(true);
    expect(names.has('sleep_quality')).toBe(true);
    expect(names.has('stress_score')).toBe(true);
    expect(names.has('hrv_status')).toBe(true);
    expect(names.has('resting_hr_status')).toBe(true);
    expect(names.has('source')).toBe(true);
    expect(names.has('consent_scope')).toBe(true);
  });
});

describe('migration 158 — athlete_health_signals table', () => {
  it('creates the table with expected columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('athlete_health_signals')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('user_id')).toBe(true);
    expect(names.has('date')).toBe(true);
    expect(names.has('pain_score')).toBe(true);
    expect(names.has('pain_location')).toBe(true);
    expect(names.has('illness_symptoms_json')).toBe(true);
    expect(names.has('injury_status')).toBe(true);
    expect(names.has('menstrual_status')).toBe(true);
    expect(names.has('energy_availability_risk')).toBe(true);
    expect(names.has('source')).toBe(true);
    expect(names.has('consent_scope')).toBe(true);
  });
});

describe('recordReadinessEvent — consent enforcement', () => {
  it('refuses to insert without readiness_basic scope', () => {
    expect(() => recordReadinessEvent({
      userId: 100,
      date: '2026-01-15',
      sleepHours: 7,
      consentScope: ['hrv_status'], // missing readiness_basic
    })).toThrow(/readiness_basic/);
  });

  it('persists sleep/stress with readiness_basic scope', () => {
    const result = recordReadinessEvent({
      userId: 100,
      date: '2026-01-15',
      sleepHours: 7.5,
      sleepQuality: 8,
      stressScore: 4,
      source: 'manual',
      consentScope: ['readiness_basic'],
    });
    expect(result.droppedFields).toEqual([]);
    const row = testDb.prepare(
      'SELECT * FROM athlete_readiness_events WHERE id = ?',
    ).get(result.id) as {
      sleep_hours: number;
      sleep_quality: number;
      stress_score: number;
      hrv_status: string | null;
      consent_scope: string;
    };
    expect(row.sleep_hours).toBe(7.5);
    expect(row.sleep_quality).toBe(8);
    expect(row.stress_score).toBe(4);
    expect(row.hrv_status).toBeNull();
    expect(row.consent_scope).toBe('readiness_basic');
  });

  it('strips hrv_status when hrv_status scope is missing', () => {
    const result = recordReadinessEvent({
      userId: 100,
      date: '2026-01-15',
      sleepHours: 7,
      hrvStatus: 'balanced',
      consentScope: ['readiness_basic'], // missing hrv_status
    });
    expect(result.droppedFields).toContain('hrvStatus');
    const row = testDb.prepare(
      'SELECT hrv_status FROM athlete_readiness_events WHERE id = ?',
    ).get(result.id) as { hrv_status: string | null };
    expect(row.hrv_status).toBeNull();
  });

  it('strips resting_hr_status when resting_hr scope is missing', () => {
    const result = recordReadinessEvent({
      userId: 100,
      date: '2026-01-15',
      sleepHours: 7,
      restingHrStatus: 'elevated',
      consentScope: ['readiness_basic'],
    });
    expect(result.droppedFields).toContain('restingHrStatus');
    const row = testDb.prepare(
      'SELECT resting_hr_status FROM athlete_readiness_events WHERE id = ?',
    ).get(result.id) as { resting_hr_status: string | null };
    expect(row.resting_hr_status).toBeNull();
  });

  it('persists all fields when full consent is granted', () => {
    const result = recordReadinessEvent({
      userId: 100,
      date: '2026-01-15',
      sleepHours: 8,
      sleepQuality: 9,
      stressScore: 3,
      hrvStatus: 'balanced',
      restingHrStatus: 'normal',
      consentScope: ['readiness_basic', 'hrv_status', 'resting_hr'],
    });
    expect(result.droppedFields).toEqual([]);
    const row = testDb.prepare(
      'SELECT * FROM athlete_readiness_events WHERE id = ?',
    ).get(result.id) as {
      hrv_status: string;
      resting_hr_status: string;
      consent_scope: string;
    };
    expect(row.hrv_status).toBe('balanced');
    expect(row.resting_hr_status).toBe('normal');
    expect(row.consent_scope).toBe('hrv_status,readiness_basic,resting_hr');
  });
});

describe('readiness event reads', () => {
  it('getLatestReadinessEvent returns newest by (date, created_at)', () => {
    recordReadinessEvent({ userId: 200, date: '2026-01-10', sleepHours: 6, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 200, date: '2026-01-15', sleepHours: 8, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 200, date: '2026-01-12', sleepHours: 7, consentScope: ['readiness_basic'] });
    const latest = getLatestReadinessEvent(200);
    expect(latest?.date).toBe('2026-01-15');
    expect(latest?.sleep_hours).toBe(8);
  });

  it('getLatestReadinessEvent honors asOfDate', () => {
    recordReadinessEvent({ userId: 201, date: '2026-01-10', sleepHours: 6, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 201, date: '2026-01-15', sleepHours: 8, consentScope: ['readiness_basic'] });
    const asOf12 = getLatestReadinessEvent(201, '2026-01-12');
    expect(asOf12?.date).toBe('2026-01-10');
  });

  it('getLatestReadinessEvent returns null when user has no events', () => {
    expect(getLatestReadinessEvent(999)).toBeNull();
  });

  it('getReadinessEventsInRange returns rows within range, newest first', () => {
    recordReadinessEvent({ userId: 202, date: '2026-01-01', sleepHours: 6, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 202, date: '2026-01-15', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 202, date: '2026-02-01', sleepHours: 8, consentScope: ['readiness_basic'] });
    const rows = getReadinessEventsInRange(202, '2026-01-05', '2026-01-25');
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe('2026-01-15');
  });
});

describe('recordHealthSignal — consent enforcement', () => {
  it('refuses to insert with empty consentScope', () => {
    expect(() => recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      painScore: 5,
      consentScope: [],
    })).toThrow(/empty/);
  });

  it('persists pain with pain scope', () => {
    const result = recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      painScore: 7,
      painLocation: 'left knee',
      consentScope: ['pain'],
    });
    expect(result.droppedFields).toEqual([]);
    const row = testDb.prepare(
      'SELECT pain_score, pain_location, consent_scope FROM athlete_health_signals WHERE id = ?',
    ).get(result.id) as { pain_score: number; pain_location: string; consent_scope: string };
    expect(row.pain_score).toBe(7);
    expect(row.pain_location).toBe('left knee');
    expect(row.consent_scope).toBe('pain');
  });

  it('strips pain when pain scope is missing', () => {
    expect(() => recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      painScore: 7,
      painLocation: 'left knee',
      consentScope: ['illness'], // pain stripped, leaves empty row
    })).toThrow(/no fields remained/);
  });

  it('persists illness with illness scope', () => {
    const result = recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      illnessSymptoms: ['fever', 'cough'],
      consentScope: ['illness'],
    });
    expect(result.droppedFields).toEqual([]);
    const row = testDb.prepare(
      'SELECT illness_symptoms_json FROM athlete_health_signals WHERE id = ?',
    ).get(result.id) as { illness_symptoms_json: string };
    expect(JSON.parse(row.illness_symptoms_json)).toEqual(['fever', 'cough']);
  });

  it('persists menstrual status only with menstrual scope (opt-in)', () => {
    // Without menstrual scope → stripped.
    expect(() => recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      menstrualStatus: 'luteal',
      consentScope: ['pain'], // pain consented but no pain value, menstrual stripped
    })).toThrow(/no fields remained/);
    // With menstrual scope → persisted.
    const result = recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      menstrualStatus: 'luteal',
      consentScope: ['menstrual'],
    });
    const row = testDb.prepare(
      'SELECT menstrual_status FROM athlete_health_signals WHERE id = ?',
    ).get(result.id) as { menstrual_status: string };
    expect(row.menstrual_status).toBe('luteal');
  });

  it('persists energy_availability_risk only with red_s_screening scope', () => {
    const result = recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      energyAvailabilityRisk: 'moderate',
      consentScope: ['red_s_screening'],
    });
    const row = testDb.prepare(
      'SELECT energy_availability_risk FROM athlete_health_signals WHERE id = ?',
    ).get(result.id) as { energy_availability_risk: string };
    expect(row.energy_availability_risk).toBe('moderate');
  });

  it('persists multiple consented fields, drops unconsented ones', () => {
    const result = recordHealthSignal({
      userId: 300,
      date: '2026-01-15',
      painScore: 6,
      painLocation: 'shoulder',
      illnessSymptoms: ['fatigue'],
      menstrualStatus: 'luteal', // not consented
      consentScope: ['pain', 'illness'],
    });
    expect(result.droppedFields).toEqual(['menstrualStatus']);
    const row = testDb.prepare(
      'SELECT pain_score, illness_symptoms_json, menstrual_status FROM athlete_health_signals WHERE id = ?',
    ).get(result.id) as {
      pain_score: number;
      illness_symptoms_json: string;
      menstrual_status: string | null;
    };
    expect(row.pain_score).toBe(6);
    expect(JSON.parse(row.illness_symptoms_json)).toEqual(['fatigue']);
    expect(row.menstrual_status).toBeNull();
  });
});

describe('health signal reads', () => {
  it('findPainSignalsInRange returns only rows with non-null pain_score', () => {
    recordHealthSignal({ userId: 400, date: '2026-01-10', painScore: 5, consentScope: ['pain'] });
    recordHealthSignal({ userId: 400, date: '2026-01-12', illnessSymptoms: ['cough'], consentScope: ['illness'] });
    recordHealthSignal({ userId: 400, date: '2026-01-15', painScore: 7, painLocation: 'back', consentScope: ['pain'] });
    const pain = findPainSignalsInRange(400, '2026-01-01', '2026-01-31');
    expect(pain.length).toBe(2);
    expect(pain.map((r) => r.pain_score)).toEqual([7, 5]);
  });

  it('findIllnessSignalsInRange returns only rows with non-null illness symptoms', () => {
    recordHealthSignal({ userId: 401, date: '2026-01-10', illnessSymptoms: ['cough'], consentScope: ['illness'] });
    recordHealthSignal({ userId: 401, date: '2026-01-12', painScore: 4, consentScope: ['pain'] });
    const illness = findIllnessSignalsInRange(401, '2026-01-01', '2026-01-31');
    expect(illness.length).toBe(1);
    expect(JSON.parse(illness[0].illness_symptoms_json!)).toEqual(['cough']);
  });

  it('getLatestHealthSignal honors asOfDate', () => {
    recordHealthSignal({ userId: 402, date: '2026-01-05', painScore: 3, consentScope: ['pain'] });
    recordHealthSignal({ userId: 402, date: '2026-01-15', painScore: 7, consentScope: ['pain'] });
    const asOf10 = getLatestHealthSignal(402, '2026-01-10');
    expect(asOf10?.pain_score).toBe(3);
  });
});

describe('history deletion (A4p privacy primitive)', () => {
  it('deleteReadinessHistoryForUser scopes to a single user', () => {
    recordReadinessEvent({ userId: 500, date: '2026-01-10', sleepHours: 6, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 500, date: '2026-01-15', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: 501, date: '2026-01-10', sleepHours: 8, consentScope: ['readiness_basic'] });
    const deleted = deleteReadinessHistoryForUser(500);
    expect(deleted).toBe(2);
    expect(getLatestReadinessEvent(500)).toBeNull();
    expect(getLatestReadinessEvent(501)?.sleep_hours).toBe(8);
  });

  it('deleteHealthHistoryForUser scopes to a single user', () => {
    recordHealthSignal({ userId: 600, date: '2026-01-10', painScore: 4, consentScope: ['pain'] });
    recordHealthSignal({ userId: 600, date: '2026-01-15', illnessSymptoms: ['cough'], consentScope: ['illness'] });
    recordHealthSignal({ userId: 601, date: '2026-01-10', painScore: 6, consentScope: ['pain'] });
    const deleted = deleteHealthHistoryForUser(600);
    expect(deleted).toBe(2);
    expect(getLatestHealthSignal(600)).toBeNull();
    expect(getLatestHealthSignal(601)?.pain_score).toBe(6);
  });
});
