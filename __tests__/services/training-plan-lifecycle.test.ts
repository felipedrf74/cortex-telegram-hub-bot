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
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
  findExistingOwnership as findExistingOwnershipRaw,
  findOrphanedOwnerships as findOrphanedOwnershipsRaw,
  findOwnershipsForPlan as findOwnershipsForPlanRaw,
  findOwnershipsNeedingReconciliation as findOwnershipsNeedingReconciliationRaw,
  findReusableOwnershipBySessionIdentity as findReusableOwnershipBySessionIdentityRaw,
  getPlanVersion,
  incrementPlanVersion,
  markCalendarOwnershipDeleted as markCalendarOwnershipDeletedRaw,
  recordCalendarOwnership as recordCalendarOwnershipRaw,
} from '../../src/services/training-plan-lifecycle';

type TestRecordCalendarOwnershipInput = Omit<
  Parameters<typeof recordCalendarOwnershipRaw>[0],
  'tenantId'
> & { tenantId?: number };

type TestMarkCalendarOwnershipDeletedInput = Omit<
  Parameters<typeof markCalendarOwnershipDeletedRaw>[0],
  'tenantId' | 'userId'
> & { tenantId?: number; userId?: number };

function recordCalendarOwnership(input: TestRecordCalendarOwnershipInput) {
  return recordCalendarOwnershipRaw({
    ...input,
    tenantId: input.tenantId ?? input.userId,
  });
}

function markCalendarOwnershipDeleted(input: TestMarkCalendarOwnershipDeletedInput) {
  const userId = input.userId ?? 100;
  return markCalendarOwnershipDeletedRaw({
    ...input,
    userId,
    tenantId: input.tenantId ?? userId,
  });
}

function findOwnershipsForPlan(planId: number, tenantId = 100) {
  return findOwnershipsForPlanRaw(planId, tenantId);
}

function findOrphanedOwnerships(userId: number, tenantId = userId) {
  return findOrphanedOwnershipsRaw(userId, tenantId);
}

function findOwnershipsNeedingReconciliation(userId: number, tenantId = userId) {
  return findOwnershipsNeedingReconciliationRaw(userId, tenantId);
}

function findExistingOwnership(
  input: Omit<Parameters<typeof findExistingOwnershipRaw>[0], 'tenantId' | 'userId'> & {
    tenantId?: number;
    userId?: number;
  },
) {
  const userId = input.userId ?? 100;
  return findExistingOwnershipRaw({
    ...input,
    userId,
    tenantId: input.tenantId ?? userId,
  });
}

function findReusableOwnershipBySessionIdentity(
  input: Omit<Parameters<typeof findReusableOwnershipBySessionIdentityRaw>[0], 'tenantId'> & {
    tenantId?: number;
  },
) {
  return findReusableOwnershipBySessionIdentityRaw({
    ...input,
    tenantId: input.tenantId ?? input.userId,
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(opts: { id: number; userId: number; planVersion?: number; status?: string }): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status, plan_version)
    VALUES (?, ?, 'Test plan', 'gym', 12, '2026-01-01', '2026-04-01', ?, ?)
  `).run(opts.id, opts.userId, opts.status ?? 'active', opts.planVersion ?? 1);
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
    expect(names.has('tenant_id')).toBe(true);
    expect(names.has('user_id')).toBe(true);
    expect(names.has('calendar_event_id')).toBe(true);
    expect(names.has('calendar_source')).toBe(true);
    expect(names.has('calendar_id')).toBe(true);
    expect(names.has('last_verified_at')).toBe(true);
    expect(names.has('sync_version')).toBe(true);
    expect(names.has('session_identity_key')).toBe(true);
    expect(names.has('session_shape_hash')).toBe(true);
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
          (plan_id, plan_version, tenant_id, user_id, calendar_event_id, calendar_source, status)
        VALUES (1, 1, 100, 100, 'evt-1', 'google', 'WAT')
      `).run();
    }).toThrow(/CHECK constraint/i);
  });
});

describe('training-plan-lifecycle — recordCalendarOwnership', () => {
  it('requires tenant scope', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    expect(() => recordCalendarOwnershipRaw({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      tenantId: undefined as unknown as number,
      userId: 100,
      eventId: 'evt-missing-tenant',
      source: 'google',
    })).toThrow(/TENANT_SCOPE_REQUIRED|requires a validated tenantId/);
  });

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
    const row = testDb.prepare(`
      SELECT calendar_id, last_verified_at, sync_version
      FROM training_agenda_event_ownership
      WHERE id = ?
    `).get(result.ownershipId) as {
      calendar_id: string;
      last_verified_at: string | null;
      sync_version: string;
    };
    expect(row.calendar_id).toBe('primary');
    expect(row.last_verified_at).toBeTruthy();
    expect(row.sync_version).toBe('training_calendar_sync_v1');
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
  it('requires tenant scope', () => {
    expect(() => markCalendarOwnershipDeletedRaw({
      eventId: 'evt-1',
      source: 'google',
      reason: 'missing_tenant',
      tenantId: undefined as unknown as number,
      userId: 100,
    })).toThrow(/TENANT_SCOPE_REQUIRED|requires a validated tenantId/);
  });

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

  it('can reconcile an orphaned row back to deleted after a retry succeeds', () => {
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

    const result = markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      reason: 'orphan_reconciled',
      status: 'deleted',
    });

    expect(result.rowsAffected).toBe(1);
    const row = testDb.prepare(`
      SELECT status, delete_reason FROM training_agenda_event_ownership WHERE calendar_event_id = ?
    `).get('evt-1') as { status: string; delete_reason: string };
    expect(row.status).toBe('deleted');
    expect(row.delete_reason).toBe('orphan_reconciled');
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

  it('returns active rows when the owning plan is no longer active even if sessions remain', () => {
    seedPlan({ id: 1, userId: 100, status: 'cancelled' });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-cancelled-plan', source: 'google',
    });

    const orphans = findOrphanedOwnerships(100);

    expect(orphans.length).toBe(1);
    expect(orphans[0].calendar_event_id).toBe('evt-cancelled-plan');
  });

  it('does not treat an existing unlinked session as an orphan while sync can still relink it', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });

    const orphans = findOrphanedOwnerships(100);

    expect(orphans.length).toBe(0);
  });
});

describe('training-plan-lifecycle — findOwnershipsNeedingReconciliation', () => {
  it('returns rows marked orphaned after external calendar deletion failed', () => {
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

    const rows = findOwnershipsNeedingReconciliation(100);

    expect(rows).toHaveLength(1);
    expect(rows[0].calendar_event_id).toBe('evt-1');
    expect(rows[0].status).toBe('orphaned');
  });

  it('does not return deleted rows after reconciliation', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-1', source: 'google',
    });
    markCalendarOwnershipDeleted({
      eventId: 'evt-1',
      source: 'google',
      reason: 'plan_cancelled',
      status: 'deleted',
    });

    expect(findOwnershipsNeedingReconciliation(100)).toHaveLength(0);
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
  it('requires tenant scope', () => {
    expect(() => findExistingOwnershipRaw({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      tenantId: undefined as unknown as number,
      userId: 100,
    })).toThrow(/TENANT_SCOPE_REQUIRED|requires a validated tenantId/);
  });

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

describe('training-plan-lifecycle — findReusableOwnershipBySessionIdentity', () => {
  it('finds reusable active ownership by logical identity and shape across plan versions', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      userId: 100,
      eventId: 'evt-same-shape',
      source: 'google',
      sessionIdentityKey: 'plan:1|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'shape-a',
    });

    const found = findReusableOwnershipBySessionIdentity({
      planId: 1,
      userId: 100,
      sessionIdentityKey: 'plan:1|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'shape-a',
    });

    expect(found).not.toBeNull();
    expect(found!.calendar_event_id).toBe('evt-same-shape');
  });

  it('does not reuse ownership when the material shape changed', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    recordCalendarOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      userId: 100,
      eventId: 'evt-old-shape',
      source: 'google',
      sessionIdentityKey: 'plan:1|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'shape-old',
    });

    expect(findReusableOwnershipBySessionIdentity({
      planId: 1,
      userId: 100,
      sessionIdentityKey: 'plan:1|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'shape-new',
    })).toBeNull();
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

describe('training-plan-lifecycle — scoped ownership transitions', () => {
  it('does not mark another user or plan when the provider event id collides', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    seedPlan({ id: 2, userId: 200 });
    seedSession({ id: 11, planId: 2, weekId: 21, userId: 200 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, userId: 100, eventId: 'evt-shared', source: 'google',
    });
    recordCalendarOwnership({
      planId: 2, planVersion: 1, sessionId: 11, userId: 200, eventId: 'evt-shared', source: 'google',
    });

    const result = markCalendarOwnershipDeleted({
      eventId: 'evt-shared',
      source: 'google',
      reason: 'plan_cancelled',
      userId: 100,
      planId: 1,
    });

    expect(result.rowsAffected).toBe(1);
    const rows = testDb.prepare(`
      SELECT plan_id, user_id, status
      FROM training_agenda_event_ownership
      WHERE calendar_event_id = ?
      ORDER BY plan_id ASC
    `).all('evt-shared') as Array<{ plan_id: number; user_id: number; status: string }>;
    expect(rows).toEqual([
      { plan_id: 1, user_id: 100, status: 'deleted' },
      { plan_id: 2, user_id: 200, status: 'active' },
    ]);
  });

  it('does not return ownership rows outside the requested tenant', () => {
    seedPlan({ id: 1, userId: 100 });
    seedSession({ id: 10, planId: 1, weekId: 20, userId: 100 });
    seedPlan({ id: 2, userId: 200 });
    seedSession({ id: 11, planId: 2, weekId: 21, userId: 200 });
    recordCalendarOwnership({
      planId: 1, planVersion: 1, sessionId: 10, tenantId: 100, userId: 100, eventId: 'evt-a', source: 'google',
    });
    recordCalendarOwnership({
      planId: 2, planVersion: 1, sessionId: 11, tenantId: 200, userId: 200, eventId: 'evt-b', source: 'google',
    });

    expect(findOwnershipsForPlan(1, 200)).toEqual([]);
    expect(findOrphanedOwnerships(100, 200)).toEqual([]);
    expect(findExistingOwnership({
      planId: 1,
      planVersion: 1,
      sessionId: 10,
      tenantId: 200,
      userId: 100,
    })).toBeNull();
  });
});
