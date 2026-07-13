import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real-SQLite suite for the agenda-ownership lifecycle. The mocked
// reconciliation suite pins call routing; THIS suite pins the actual SQL
// semantics that historical bugs lived in: tenant-scoped uniqueness,
// status-based terminal-skip, and the deliberate keep-the-FK invariant on
// terminal rows (audit trail + orphan retry both need the event id).
let realDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!realDb) throw new Error('test db not initialized');
    return realDb;
  },
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  recordCalendarOwnership,
  markCalendarOwnershipDeleted,
  findOwnershipsForPlan,
  findOrphanedOwnerships,
  findOwnershipsNeedingReconciliation,
} from '../../src/services/training-plan-lifecycle';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const MIGRATIONS = [
  '023_fitness_training_plans.sql',
  '081_training_agenda_event_ownership.sql',
  '082_training_session_identity_shape_hash.sql',
  '099_training_agenda_ownership_tenant_scope.sql',
  '199_drop_stale_training_agenda_unique_index.sql',
  '215_training_agenda_ownership_sync_metadata.sql',
];

function seedPlanWithSession(userId: number): { planId: number; sessionId: number } {
  const plan = realDb.prepare(`
    INSERT INTO fitness_training_plans (user_id, name, duration_weeks, start_date, end_date, status)
    VALUES (?, 'Test Plan', 4, '2026-06-01', '2026-06-28', 'active')
  `).run(userId);
  const planId = Number(plan.lastInsertRowid);
  const week = realDb.prepare(`
    INSERT INTO training_weeks (plan_id, week_number) VALUES (?, 1)
  `).run(planId);
  const session = realDb.prepare(`
    INSERT INTO training_sessions (week_id, plan_id, day_of_week, session_type, title)
    VALUES (?, ?, 'Monday', 'run', 'Easy Run')
  `).run(Number(week.lastInsertRowid), planId);
  return { planId, sessionId: Number(session.lastInsertRowid) };
}

function ownershipInput(planId: number, sessionId: number, eventId = 'evt-1') {
  return {
    planId,
    planVersion: 1,
    sessionId,
    tenantId: 7,
    userId: 7,
    eventId,
    source: 'google',
  };
}

describe('training plan lifecycle ownership — real SQLite', () => {
  beforeEach(() => {
    realDb = new Database(':memory:');
    for (const migration of MIGRATIONS) {
      realDb.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), 'utf8'));
    }
  });

  afterEach(() => {
    realDb.close();
  });

  it('records ownership once and is idempotent for the same tuple', () => {
    const { planId, sessionId } = seedPlanWithSession(7);
    const first = recordCalendarOwnership(ownershipInput(planId, sessionId));
    const second = recordCalendarOwnership(ownershipInput(planId, sessionId));

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false, ownershipId: first.ownershipId });
    expect(findOwnershipsForPlan(planId, 7)).toHaveLength(1);
  });

  it('keeps the calendar event id on terminal rows (audit-trail invariant)', () => {
    const { planId, sessionId } = seedPlanWithSession(7);
    recordCalendarOwnership(ownershipInput(planId, sessionId));

    const result = markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      status: 'deleted',
      reason: 'plan_cancelled',
      tenantId: 7,
      userId: 7,
      planId,
    });
    expect(result.rowsAffected).toBe(1);

    const rows = findOwnershipsForPlan(planId, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('deleted');
    // The FK is kept ON PURPOSE: findOwnershipsForPlan is the audit view of
    // everything ever linked, and 'orphaned' rows need the id for the retry
    // queue. Terminal-skip is by STATUS (pinned below), never by FK-null.
    expect(rows[0].calendar_event_id).toBe('evt-1');
    expect(rows[0].delete_reason).toBe('plan_cancelled');
  });

  it('drops terminal rows from the orphan scan by status, not by event id', () => {
    const { planId, sessionId } = seedPlanWithSession(7);
    recordCalendarOwnership(ownershipInput(planId, sessionId));

    // Cancel the plan locally: the ownership row is now orphan-scan bait.
    realDb.prepare("UPDATE fitness_training_plans SET status = 'cancelled' WHERE id = ?").run(planId);
    expect(findOrphanedOwnerships(7, 7)).toHaveLength(1);

    markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      tenantId: 7,
      userId: 7,
      planId,
    });

    // Status flipped to 'deleted' → out of the scan even though the
    // calendar_event_id column still holds 'evt-1'.
    expect(findOrphanedOwnerships(7, 7)).toHaveLength(0);
  });

  it('routes orphaned rows through the reconciliation queue until terminally deleted', () => {
    const { planId, sessionId } = seedPlanWithSession(7);
    recordCalendarOwnership(ownershipInput(planId, sessionId));

    const orphaned = markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      status: 'orphaned',
      reason: 'provider_delete_failed',
      tenantId: 7,
      userId: 7,
      planId,
    });
    expect(orphaned.rowsAffected).toBe(1);

    const queue = findOwnershipsNeedingReconciliation(7, 7);
    expect(queue).toHaveLength(1);
    // The retry queue NEEDS the event id — nulling it on 'orphaned' would
    // permanently strand the real provider event.
    expect(queue[0].calendar_event_id).toBe('evt-1');

    const finished = markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      status: 'deleted',
      reason: 'reconciled',
      tenantId: 7,
      userId: 7,
      planId,
    });
    expect(finished.rowsAffected).toBe(1);
    expect(findOwnershipsNeedingReconciliation(7, 7)).toHaveLength(0);
  });

  it('is idempotent when re-marking an already-deleted row', () => {
    const { planId, sessionId } = seedPlanWithSession(7);
    recordCalendarOwnership(ownershipInput(planId, sessionId));
    markCalendarOwnershipDeleted({ eventId: 'evt-1', source: 'google', tenantId: 7, userId: 7, planId });

    const again = markCalendarOwnershipDeleted({ eventId: 'evt-1', source: 'google', tenantId: 7, userId: 7, planId });
    expect(again.rowsAffected).toBe(0);
  });

  it('scopes ownership uniqueness by tenant through the service layer', () => {
    const mine = seedPlanWithSession(7);
    recordCalendarOwnership(ownershipInput(mine.planId, mine.sessionId, 'evt-shared'));

    const theirs = seedPlanWithSession(8);
    const crossTenant = recordCalendarOwnership({
      ...ownershipInput(theirs.planId, theirs.sessionId, 'evt-shared'),
      tenantId: 8,
      userId: 8,
    });
    expect(crossTenant).toMatchObject({ ok: true, created: true });
    expect(findOwnershipsForPlan(mine.planId, 7)).toHaveLength(1);
    expect(findOwnershipsForPlan(theirs.planId, 8)).toHaveLength(1);
  });
});
