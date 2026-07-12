/**
 * Tests for src/services/training-comparison.ts
 *
 * Tests the planned vs actual comparison engine and formatting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { listCanonicalMigrationFiles } from '../utils/migrations';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = listCanonicalMigrationFiles(fs.readdirSync(MIGRATIONS_DIR));
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
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
vi.mock('../../src/config', () => ({
  config: { financeEncryption: { enabled: false, masterKey: '' } },
}));

const mockGarmin = vi.hoisted(() => ({
  isGarminConfigured: vi.fn(() => true),
  getActivitiesByDate: vi.fn(),
  getHrvData: vi.fn(),
  getSleepData: vi.fn(),
  getBodyBatteryEvents: vi.fn(),
  getTrainingReadiness: vi.fn(),
}));
vi.mock('../../src/services/garmin', () => mockGarmin);
vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: vi.fn(),
  isAnyCalendarConfigured: vi.fn(() => false),
}));

import {
  createPlan, createWeek, createSession,
  getActivePlan, getCurrentWeek, getSessionsForWeek,
} from '../../src/services/training-plans';
import { comparePlannedVsActual, formatComparison, getWeekMonday } from '../../src/services/training-comparison';
import type { GarminActivity } from '../../src/services/garmin';

// ── Test helpers ──

function seedPlanWithSessions(userId: number): { planId: number; weekId: number } {
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 28);

  const plan = createPlan({
    user_id: userId,
    tenant_id: userId,
    name: 'Test Plan',
    sport: 'gym',
    duration_weeks: 4,
    start_date: today.toISOString().slice(0, 10),
    end_date: endDate.toISOString().slice(0, 10),
  });

  const week = createWeek({
    plan_id: plan.id,
    week_number: 1,
    focus: 'Hypertrophy',
    intensity_pct: 100,
    volume_sessions: 3,
  });

  createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'strength', title: 'Upper Body Push', duration_minutes: 60 });
  createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Wednesday', session_type: 'strength', title: 'Lower Body', duration_minutes: 60 });
  createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Friday', session_type: 'strength', title: 'Upper Body Pull', duration_minutes: 60 });

  return { planId: plan.id, weekId: week.id };
}

function makeActivity(overrides: Partial<GarminActivity> & { startTimeLocal: string }): GarminActivity {
  return {
    activityId: Math.floor(Math.random() * 999999),
    activityName: 'Strength Training',
    activityType: { typeKey: 'strength_training' },
    duration: 3600, // 60 min
    ...overrides,
  };
}

// ── Tests ──

describe('training-comparison', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    vi.clearAllMocks();
  });
  afterEach(() => { testDb.close(); });

  describe('comparePlannedVsActual', () => {
    it('matches session to Garmin activity by same day', async () => {
      const { planId } = seedPlanWithSessions(1);
      const monday = getWeekMonday();

      mockGarmin.getActivitiesByDate.mockResolvedValue([
        makeActivity({ startTimeLocal: `${monday}T06:30:00` }),
      ]);

      const result = await comparePlannedVsActual(1);
      const mondayComp = result.comparisons.find(c => c.session?.day_of_week === 'Monday');
      expect(mondayComp?.match).toBe('exact');
    });

    it('detects duration discrepancy', async () => {
      seedPlanWithSessions(1);
      const monday = getWeekMonday();

      mockGarmin.getActivitiesByDate.mockResolvedValue([
        makeActivity({ startTimeLocal: `${monday}T06:30:00`, duration: 1500 }), // 25min vs planned 60min
      ]);

      const result = await comparePlannedVsActual(1);
      const mondayComp = result.comparisons.find(c => c.session?.day_of_week === 'Monday');
      expect(mondayComp?.match).toBe('partial');
      expect(mondayComp?.discrepancies.some(d => d.includes('Duration'))).toBe(true);
    });

    it('detects type mismatch', async () => {
      seedPlanWithSessions(1);
      const monday = getWeekMonday();

      mockGarmin.getActivitiesByDate.mockResolvedValue([
        makeActivity({
          startTimeLocal: `${monday}T06:30:00`,
          activityType: { typeKey: 'walking' },
        }),
      ]);

      const result = await comparePlannedVsActual(1);
      const mondayComp = result.comparisons.find(c => c.session?.day_of_week === 'Monday');
      expect(mondayComp?.discrepancies.some(d => d.includes('Type'))).toBe(true);
    });

    it('marks session as missed when no activity on that day', async () => {
      seedPlanWithSessions(1);
      mockGarmin.getActivitiesByDate.mockResolvedValue([]); // no activities

      const result = await comparePlannedVsActual(1);
      expect(result.comparisons.filter(c => c.match === 'missed')).toHaveLength(3);
      expect(result.summary.missed).toBe(3);
    });

    it('identifies extra unplanned activities', async () => {
      seedPlanWithSessions(1);
      const saturday = getWeekMonday();
      // Activity on Saturday (no session planned)
      const satDate = new Date(saturday);
      satDate.setDate(satDate.getDate() + 5);
      const satStr = satDate.toISOString().slice(0, 10);

      mockGarmin.getActivitiesByDate.mockResolvedValue([
        makeActivity({
          startTimeLocal: `${satStr}T10:00:00`,
          activityType: { typeKey: 'cycling' },
          duration: 2700,
        }),
      ]);

      const result = await comparePlannedVsActual(1);
      expect(result.summary.extra).toBe(1);
      const extra = result.comparisons.find(c => c.match === 'extra');
      expect(extra?.discrepancies[0]).toContain('Unplanned');
    });

    it('summary counts are correct', async () => {
      seedPlanWithSessions(1); // 3 sessions: Mon, Wed, Fri
      const monday = getWeekMonday();
      const wed = new Date(monday);
      wed.setDate(wed.getDate() + 2);
      const wedStr = wed.toISOString().slice(0, 10);

      mockGarmin.getActivitiesByDate.mockResolvedValue([
        makeActivity({ startTimeLocal: `${monday}T06:30:00` }), // matches Monday
        makeActivity({ startTimeLocal: `${wedStr}T06:30:00`, duration: 1500 }), // partial Wed
        // Friday missed, no activity
      ]);

      const result = await comparePlannedVsActual(1);
      expect(result.summary.planned).toBe(3);
      expect(result.summary.completed).toBe(2); // exact + partial
      expect(result.summary.missed).toBe(1); // Friday
    });

    it('handles empty Garmin activities (all missed)', async () => {
      seedPlanWithSessions(1);
      mockGarmin.getActivitiesByDate.mockResolvedValue([]);

      const result = await comparePlannedVsActual(1);
      expect(result.summary.missed).toBe(3);
      expect(result.summary.completed).toBe(0);
    });

    it('handles Garmin API failure gracefully', async () => {
      seedPlanWithSessions(1);
      mockGarmin.getActivitiesByDate.mockRejectedValue(new Error('Garmin down'));

      const result = await comparePlannedVsActual(1);
      expect(result.summary.missed).toBe(3); // all missed when no activity data
    });
  });

  describe('formatComparison', () => {
    it('produces HTML-formatted output', () => {
      const result = {
        weekOf: '2026-04-06',
        comparisons: [
          { session: { day_of_week: 'Monday', title: 'Push' } as any, garminActivity: { duration: 3600 } as any, match: 'exact' as const, discrepancies: [] },
          { session: { day_of_week: 'Wednesday', title: 'Legs' } as any, garminActivity: null, match: 'missed' as const, discrepancies: ['No matching activity'] },
        ],
        summary: { planned: 2, completed: 1, missed: 1, extra: 0 },
      };

      const html = formatComparison(result);
      expect(html).toContain('Planned vs Actual');
      expect(html).toContain('✅');
      expect(html).toContain('❌');
      expect(html).toContain('1/2 matched');
    });
  });
});
