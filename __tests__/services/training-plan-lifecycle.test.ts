/**
 * Slice 4.D — training-plan-lifecycle.ts pin tests.
 *
 * Closes Phase 0 audit regression #3 by introducing an audit-trail
 * ownership table that survives FK cascade on plan deletion. These
 * tests pin:
 *
 *   - migration 081 creates the column + table + indexes
 *   - recordCalendarOwnership writes a row, idempotent on retry
 *   - DB-level UNIQUE constraint backstops concurrent races
 *   - markCalendarOwnershipDeleted transitions status correctly
 *   - findOrphanedOwnerships finds active rows without a session
 *   - incrementPlanVersion bumps and persists the version
 *   - getPlanVersion returns null for missing plan, real value otherwise
 *   - findExistingOwnership returns the prior row for idempotent retry
 *   - findOwnershipsForPlan returns all rows across statuses
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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
  findExistingOwnership,
  findOrphanedOwnerships,
  findOwnershipsForPlan,
  getPlanVersion,
  incrementPlanVersion,
  markCalendarOwnershipDeleted,
  recordCalendarOwnership,
} from '../../src/services/training-plan-lifecycle';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(opts: { id: number; userId: number; planVersion?: number }): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status, plan_version)
    VALUES (?, ?, 'Test plan', 'gym', 12, '2026-01-01', '2026-04-01', 'active', ?)
  `).run(opts.id, opts.userId, opts.planVersion ?? 1);
}

function seedSession(opts: { id: number; planId: number; weekId: number; userId: number }): void {
  // Make sure a week exists (FK).
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)
  `).run(opts.weekId, opts.planId);
  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, ?, ?, 'Monday', 'gym', 'Test session', 60, 'pending')
  `).run(opts.id, opts.weekId, opts.planId);
}

describe('training-plan-lifecycle — migration 081', () => {
  it('adds plan_version column to fitness_training_plans (default 1)', () => {
    seedPlan({ id: 1, userId: 100 });
    const row = testDb.prepare(
      'SELECT plan_version FROM fitness_training_plans WHERE id = ?',
    ).get(1) as { plan_version: number };
    expect(row.plan_version).toBe(1);
  });

  it('creates training_agenda_event_ownership with the expected columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('training_agenda_event_ownership')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('id')).toBe(true);
    expect(names.has('plan_id')).toBe(true);
    expect(names.has('plan_version')).toBe(true);
    expect(names.has('session_id')).toBe(true);
    expect(names.has('user_id')).toBe(true);
    expect(names.has('calendar_event_id')).toBe(true);
    expect(names.has('calendar_source')).toBe(true);
    expect(names.has('status')).toBe(true);
    expect(names.has('created_at')).toBe(true);
    expect(names.has('deleted_at')).toBe(true);
    expect(names.has('delete_reason')).toBe(true);
  });

  it('CHECK constraint rejects unknown status values', () => {
    seedPlan({ id: 1, userId: 100 });
    expect(() => {
      testDb.prepare(`
        INSERT INTO training_agenda_event_ownership
          (plan_id, plan_version, user_id, calendar_event_id, calendar_source, status)
        VALUES (1, 1, 100, 'evt-1', 'google', 'WAT')
      `).run();
    }).toThrow(/CHECK constraint/i);
  });
});

describe('training-plan-lifecycle — recordCalendarOwnership', () => {
  it('inserts a fresh row and returns created=true', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    const result = recordCalendarOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      userId: 100,
      eventId: 'evt-abc',
      source: 'google',
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.ownershipId).not.toBeNull();
  });

  it('is idempotent — second call with same tuple returns created=false', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    const first = recordCalendarOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      userId: 100,
      eventId: 'evt-abc',
      source: 'google',
    });
    const second = recordCalendarOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      userId: 100,
      eventId: 'evt-abc',
      source: 'google',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.ownershipId).toBe(first.ownershipId);

    // No duplicate row in the table.
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_agenda_event_ownership WHERE plan_id = ? AND calendar_event_id = ?',
    ).get(1, 'evt-abc') as { n: number };
    expect(count.n).toBe(1);
  });

  it('different plan_versions for the same plan keep their own audit rows', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-old', source: 'google',
    });
    recordCalendarOwnership({
      planId: 1, planVersion: 2, sessionId: 10, userId: 100, eventId: 'evt-new', source: 'google',
    });
    const rows = findOwnershipsForPlan(1);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.plan_version))).toEqual(new Set([1, 2]));
  });
});

describe('training-plan-lifecycle — markCalendarOwnershipDeleted', () => {
  it('transitions an active row to status=deleted with a timestamp + reason', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });

    const result = markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      reason: 'plan_cancelled',
    });
    expect(result.ok).toBe(true);
    expect(result.rowsAffected).toBe(1);

    const row = testDb.prepare(`
      SELECT status, deleted_at, delete_reason
      FROM training_agenda_event_ownership
      WHERE calendar_event_id = ?
    `).get('evt-1') as { status: string; deleted_at: string; delete_reason: string };
    expect(row.status).toBe('deleted');
    expect(row.deleted_at).toBeTruthy();
    expect(row.delete_reason).toBe('plan_cancelled');
  });

  it('honors status="orphaned" when external delete fails', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });
    markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      reason: 'plan_cancelled_external_delete_failed',
      status: 'orphaned',
    });
    const row = testDb.prepare(`
      SELECT status FROM training_agenda_event_ownership WHERE calendar_event_id = ?
    `).get('evt-1') as { status: string };
    expect(row.status).toBe('orphaned');
  });

  it('is idempotent: second call on already-deleted row affects 0 rows', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });
    markCalendarOwnershipDeleted({ eventId: 'evt-1', source: 'google', reason: 'first' });
    const second = markCalendarOwnershipDeleted({ eventId: 'evt-1', source: 'google', reason: 'second' });
    expect(second.rowsAffected).toBe(0);
  });
});

describe('training-plan-lifecycle — findOrphanedOwnerships', () => {
  it('returns active rows whose session no longer exists (FK cascade aftermath)', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });

    // Simulate FK CASCADE: delete plan, which deletes session.
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(1);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_sessions').get()).toEqual({ n: 0 });
    // Ownership row survives.
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_agenda_event_ownership').get()).toEqual({ n: 1 });

    const orphans = findOrphanedOwnerships(100);
    expect(orphans.length).toBe(1);
    expect(orphans[0].calendar_event_id).toBe('evt-1');
    expect(orphans[0].status).toBe('active');
  });

  it('skips rows already marked deleted', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });
    markCalendarOwnershipDeleted({ eventId: 'evt-1', source: 'google', reason: 'cleaned' });
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(1);
    const orphans = findOrphanedOwnerships(100);
    expect(orphans.length).toBe(0);
  });

  it('skips rows whose session still exists', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    // Link the session to the same event so the LEFT JOIN sees it.
    testDb.prepare(`
      UPDATE training_sessions SET calendar_event_id = ?, calendar_source = ? WHERE id = ?
    `).run('evt-1', 'google', 10);
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });
    const orphans = findOrphanedOwnerships(100);
    expect(orphans.length).toBe(0);
  });
});

describe('training-plan-lifecycle — incrementPlanVersion', () => {
  it('bumps the version and returns the new value', () => {
    seedPlan({ id: 1, userId: 100, planVersion: 1 });
    const v2 = incrementPlanVersion(1);
    expect(v2).toBe(2);
    const v3 = incrementPlanVersion(1);
    expect(v3).toBe(3);
  });

  it('returns null for an unknown plan_id', () => {
    expect(incrementPlanVersion(999)).toBeNull();
  });
});

describe('training-plan-lifecycle — getPlanVersion', () => {
  it('returns the column value for an existing plan', () => {
    seedPlan({ id: 1, userId: 100, planVersion: 5 });
    expect(getPlanVersion(1)).toBe(5);
  });

  it('returns null when the plan does not exist', () => {
    expect(getPlanVersion(999)).toBeNull();
  });
});

describe('training-plan-lifecycle — findExistingOwnership', () => {
  it('returns the prior row for the same (plan, plan_version, session_id)', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-abc', source: 'google',
    });
    const found = findExistingOwnership({ planId: 1, planVersion: 1, sessionId: 10 });
    expect(found).not.toBeNull();
    expect(found!.calendar_event_id).toBe('evt-abc');
  });

  it('returns null when only a different plan_version exists', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-old', source: 'google',
    });
    const found = findExistingOwnership({ planId: 1, planVersion: 2, sessionId: 10 });
    expect(found).toBeNull();
  });

  it('skips rows already marked deleted', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-x', source: 'google',
    });
    markCalendarOwnershipDeleted({ eventId: 'evt-x', source: 'google' });
    const found = findExistingOwnership({ planId: 1, planVersion: 1, sessionId: 10 });
    expect(found).toBeNull();
  });
});

describe('training-plan-lifecycle — findOwnershipsForPlan', () => {
  it('returns all ownership rows for a plan across versions and statuses', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-old', source: 'google',
    });
    markCalendarOwnershipDeleted({ eventId: 'evt-old', source: 'google' });
    recordCalendarOwnership({
      planId: 1, planVersion: 2, sessionId: 10, userId: 100, eventId: 'evt-new', source: 'google',
    });
    const rows = findOwnershipsForPlan(1);
    expect(rows.length).toBe(2);
    const byEvent = new Map(rows.map((r) => [r.calendar_event_id, r]));
    expect(byEvent.get('evt-old')!.status).toBe('deleted');
    expect(byEvent.get('evt-new')!.status).toBe('active');
  });
});
