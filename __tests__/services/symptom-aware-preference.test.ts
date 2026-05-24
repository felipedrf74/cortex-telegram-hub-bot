/**
 * Slice B4b — symptom-aware session preferences (capture only).
 *
 * Pins:
 *   - Migration 160 creates table with expected shape
 *   - Record + read round-trips
 *   - Reason tag preserved (menstrual_symptom, travel_fatigue, etc.)
 *   - Range query honors date bounds
 *   - Deletion scopes to single user
 *   - Symptom-aware preference is NEVER a predictive/inferred field
 *     — caller controls all input
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
  deletePreferenceHistoryForUser,
  getPreferenceForDate,
  getPreferencesInRange,
  recordSessionPreference,
} from '../../src/services/symptom-aware-preference';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe('migration 160 — athlete_session_preferences table', () => {
  it('creates the table with expected columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('athlete_session_preferences')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('user_id')).toBe(true);
    expect(names.has('date')).toBe(true);
    expect(names.has('intensity_preference')).toBe(true);
    expect(names.has('reason_tag')).toBe(true);
  });
});

describe('recordSessionPreference + getPreferenceForDate', () => {
  it('round-trips a lower_intensity preference with menstrual_symptom tag', () => {
    const result = recordSessionPreference({
      userId: 100,
      date: '2026-05-23',
      intensityPreference: 'lower_intensity',
      reasonTag: 'menstrual_symptom',
      notes: 'feeling crampy',
    });
    expect(result.id).toBeGreaterThan(0);
    const found = getPreferenceForDate(100, '2026-05-23');
    expect(found?.intensity_preference).toBe('lower_intensity');
    expect(found?.reason_tag).toBe('menstrual_symptom');
    expect(found?.notes).toBe('feeling crampy');
  });

  it('round-trips travel_fatigue preference', () => {
    recordSessionPreference({
      userId: 100,
      date: '2026-05-24',
      intensityPreference: 'lower_intensity',
      reasonTag: 'travel_fatigue',
    });
    expect(getPreferenceForDate(100, '2026-05-24')?.reason_tag).toBe('travel_fatigue');
  });

  it('returns null when no preference for date', () => {
    expect(getPreferenceForDate(100, '2026-01-01')).toBeNull();
  });

  it('most-recent wins when multiple preferences for same date', () => {
    recordSessionPreference({
      userId: 100,
      date: '2026-05-23',
      intensityPreference: 'higher_intensity',
    });
    recordSessionPreference({
      userId: 100,
      date: '2026-05-23',
      intensityPreference: 'lower_intensity',
      reasonTag: 'updated',
    });
    expect(getPreferenceForDate(100, '2026-05-23')?.intensity_preference).toBe('lower_intensity');
  });
});

describe('getPreferencesInRange', () => {
  it('returns preferences within date range', () => {
    recordSessionPreference({ userId: 200, date: '2026-05-10', intensityPreference: 'standard' });
    recordSessionPreference({ userId: 200, date: '2026-05-15', intensityPreference: 'lower_intensity' });
    recordSessionPreference({ userId: 200, date: '2026-05-20', intensityPreference: 'higher_intensity' });
    recordSessionPreference({ userId: 200, date: '2026-06-01', intensityPreference: 'standard' });
    const range = getPreferencesInRange(200, '2026-05-11', '2026-05-25');
    expect(range.length).toBe(2);
  });
});

describe('deletePreferenceHistoryForUser', () => {
  it('scopes to single user', () => {
    recordSessionPreference({ userId: 300, date: '2026-05-10', intensityPreference: 'lower_intensity' });
    recordSessionPreference({ userId: 301, date: '2026-05-10', intensityPreference: 'lower_intensity' });
    const deleted = deletePreferenceHistoryForUser(300);
    expect(deleted).toBe(1);
    expect(getPreferenceForDate(300, '2026-05-10')).toBeNull();
    expect(getPreferenceForDate(301, '2026-05-10')?.intensity_preference).toBe('lower_intensity');
  });
});
