/**
 * Slice C1 — missed-session sweep tests.
 *
 * Pins:
 *   - computeSessionScheduledDate reconstructs from start + week + day
 *   - Pending session past deadline → missed
 *   - Completed session → NOT missed
 *   - external_training_declared=1 → NOT missed
 *   - Preview adaptation references session → NOT missed
 *   - Grace period not yet passed → NOT missed
 *   - Key session uses shorter grace period than easy
 *   - Multiple plans for same user → both contribute
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
  computeSessionScheduledDate,
  detectMissedSessions,
} from '../../src/services/missed-session-sweep';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlanWithSession(opts: {
  planId: number;
  userId: number;
  tenantId?: number;
  weekId: number;
  sessionId: number;
  startDate: string;
  weekNumber: number;
  dayOfWeek: string;
  sessionType: string;
  title?: string;
  status?: string;
}): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'p', 'gym', 12, ?, '2026-12-31', 'active')
  `).run(opts.planId, opts.userId, opts.tenantId ?? opts.userId, opts.startDate);
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, ?)
  `).run(opts.weekId, opts.planId, opts.weekNumber);
  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, 45, ?)
  `).run(
    opts.sessionId,
    opts.weekId,
    opts.planId,
    opts.dayOfWeek,
    opts.sessionType,
    opts.title ?? 'session',
    opts.status ?? 'pending',
  );
}

describe('computeSessionScheduledDate', () => {
  it('week 1 monday from plan start 2026-01-05 = 2026-01-05', () => {
    expect(computeSessionScheduledDate('2026-01-05', 1, 'monday')).toBe('2026-01-05');
  });

  it('week 1 sunday = start + 6 days', () => {
    expect(computeSessionScheduledDate('2026-01-05', 1, 'sunday')).toBe('2026-01-11');
  });

  it('week 3 wednesday = start + 16 days', () => {
    expect(computeSessionScheduledDate('2026-01-05', 3, 'wednesday')).toBe('2026-01-21');
  });

  it('returns null for unknown day', () => {
    expect(computeSessionScheduledDate('2026-01-05', 1, 'someday')).toBeNull();
  });

  it('returns null for invalid start date', () => {
    expect(computeSessionScheduledDate('not-a-date', 1, 'monday')).toBeNull();
  });
});

describe('detectMissedSessions — basic detection', () => {
  it('pending session past deadline → missed', () => {
    seedPlanWithSession({
      planId: 1, userId: 100, weekId: 1, sessionId: 1,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z', // 5 days past the scheduled monday
    });
    expect(missed.length).toBe(1);
    expect(missed[0].sessionId).toBe(1);
    expect(missed[0].scheduledDate).toBe('2026-01-05');
  });

  it('completed session → NOT missed', () => {
    seedPlanWithSession({
      planId: 2, userId: 100, weekId: 2, sessionId: 2,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    testDb.prepare(`
      INSERT INTO training_completions (session_id, plan_id, rpe_overall)
      VALUES (2, 2, 6)
    `).run();
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    expect(missed.length).toBe(0);
  });

  it('external_training_declared=1 → NOT missed', () => {
    seedPlanWithSession({
      planId: 3, userId: 100, weekId: 3, sessionId: 3,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    testDb.prepare(`
      INSERT INTO training_completions (session_id, plan_id, external_training_declared)
      VALUES (3, 3, 1)
    `).run();
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    expect(missed.length).toBe(0);
  });

  it('grace period not yet passed → NOT missed', () => {
    seedPlanWithSession({
      planId: 4, userId: 100, weekId: 4, sessionId: 4,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    // Just 6 hours past midnight Tuesday — within 24h grace.
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-06T06:00:00Z',
      gracePeriodHoursEasy: 24,
    });
    expect(missed.length).toBe(0);
  });

  it('key session uses shorter grace (12h vs 24h)', () => {
    seedPlanWithSession({
      planId: 5, userId: 100, weekId: 5, sessionId: 5,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'threshold_run',
      title: 'Key Threshold Run',
    });
    // 18 hours past Tuesday midnight — past 12h key grace, before 24h easy grace.
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-06T18:00:00Z',
      gracePeriodHoursKey: 12,
      gracePeriodHoursEasy: 24,
    });
    expect(missed.length).toBe(1);
    expect(missed[0].isKeySession).toBe(true);
    expect(missed[0].severity).toBe('key');
  });

  it('preview adaptation referencing session → NOT missed', () => {
    seedPlanWithSession({
      planId: 6, userId: 100, weekId: 6, sessionId: 6,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, trigger_payload_json, science_policy_version)
      VALUES (6, 'preview', 'reflow_preview', '{"sessionId":6,"hypothetical":true}', '1.0.0')
    `).run();
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    expect(missed.length).toBe(0);
  });

  it('completed status → NOT missed', () => {
    seedPlanWithSession({
      planId: 7, userId: 100, weekId: 7, sessionId: 7,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
      status: 'completed',
    });
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    expect(missed.length).toBe(0);
  });

  it('Codex R2 P2 — preview with sessionsToPreserve array matches via json_each', () => {
    seedPlanWithSession({
      planId: 8, userId: 100, weekId: 8, sessionId: 80,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    // Real preview shape from recordPreviewAdaptation — sessionsToPreserve array.
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, trigger_payload_json, science_policy_version)
      VALUES (8, 'preview', 'reflow_preview', '{"weekId":8,"sessionsToPreserve":[80]}', '1.0.0')
    `).run();
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    expect(missed.length).toBe(0);
  });

  it('Codex R2 P2 — substring collision avoided (sessionId 12 vs 123)', () => {
    // Seed two plans owned by the same user with sessions 12 and 123.
    seedPlanWithSession({
      planId: 9, userId: 100, weekId: 9, sessionId: 12,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    seedPlanWithSession({
      planId: 10, userId: 100, weekId: 10, sessionId: 123,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'tuesday',
      sessionType: 'easy_run',
    });
    // Preview targets session 123 only — must NOT also exclude session 12.
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, trigger_payload_json, science_policy_version)
      VALUES (10, 'preview', 'reflow_preview', '{"weekId":10,"sessionsToPreserve":[123]}', '1.0.0')
    `).run();
    const missed = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    const ids = missed.map((m) => m.sessionId);
    // 12 IS missed (preview did NOT exclude it); 123 is NOT missed.
    expect(ids).toContain(12);
    expect(ids).not.toContain(123);
  });

  it('excludes active plans from another tenant for the same user', () => {
    seedPlanWithSession({
      planId: 11, userId: 100, tenantId: 100, weekId: 11, sessionId: 110,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'monday',
      sessionType: 'easy_run',
    });
    seedPlanWithSession({
      planId: 12, userId: 100, tenantId: 200, weekId: 12, sessionId: 120,
      startDate: '2026-01-05', weekNumber: 1, dayOfWeek: 'tuesday',
      sessionType: 'easy_run',
    });

    const tenant100 = detectMissedSessions({
      userId: 100,
      tenantId: 100,
      asOfISODate: '2026-01-10T12:00:00Z',
    });
    const tenant200 = detectMissedSessions({
      userId: 100,
      tenantId: 200,
      asOfISODate: '2026-01-10T12:00:00Z',
    });

    expect(tenant100.map((m) => m.sessionId)).toEqual([110]);
    expect(tenant200.map((m) => m.sessionId)).toEqual([120]);
  });
});
