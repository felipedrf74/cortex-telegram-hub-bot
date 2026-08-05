import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  commitTrainingCalendarSessionMapping,
  retireTrainingCalendarSessionMapping,
} from '../../src/services/training-calendar-link-commit';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const MIGRATIONS = [
  '023_fitness_training_plans.sql',
  '081_training_agenda_event_ownership.sql',
  '082_training_session_identity_shape_hash.sql',
  '099_training_agenda_ownership_tenant_scope.sql',
  '140_training_tenant_id.sql',
  '199_drop_stale_training_agenda_unique_index.sql',
  '215_training_agenda_ownership_sync_metadata.sql',
  '083_secretary_agenda_ledger.sql',
  '098_secretary_decision_explanation.sql',
];

function seedPlanWithSession(): { planId: number; sessionId: number } {
  const plan = realDb.prepare(`
    INSERT INTO fitness_training_plans (user_id, tenant_id, name, duration_weeks, start_date, end_date, status)
    VALUES (7, 7, 'Atomic Link', 4, '2026-08-03', '2026-08-30', 'active')
  `).run();
  const planId = Number(plan.lastInsertRowid);
  const week = realDb.prepare(
    'INSERT INTO training_weeks (plan_id, week_number) VALUES (?, 1)',
  ).run(planId);
  const session = realDb.prepare(`
    INSERT INTO training_sessions (week_id, plan_id, tenant_id, day_of_week, session_type, title, status)
    VALUES (?, ?, 7, 'Monday', 'run', 'Easy Run', 'pending')
  `).run(Number(week.lastInsertRowid), planId);
  return { planId, sessionId: Number(session.lastInsertRowid) };
}

function commitInput(planId: number, sessionId: number) {
  return {
    sessionId,
    eventId: 'evt-atomic',
    source: 'google' as const,
    sessionPatch: { status: 'scheduled' },
    ownership: {
      planId,
      planVersion: 1,
      sessionId,
      tenantId: 7,
      userId: 7,
      eventId: 'evt-atomic',
      source: 'google',
      calendarId: 'primary',
      sessionIdentityKey: 'plan:1:week:1:day:monday:run:1',
      sessionShapeHash: 'shape-a',
    },
  };
}

function sessionRow(sessionId: number): Record<string, unknown> | undefined {
  return realDb.prepare(`
    SELECT status, calendar_event_id, calendar_source
      FROM training_sessions
     WHERE id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;
}

function activeOwnershipId(planId: number, sessionId: number): number {
  const row = realDb.prepare(`
    SELECT id
      FROM training_agenda_event_ownership
     WHERE plan_id = ? AND session_id = ? AND status = 'active'
  `).get(planId, sessionId) as { id: number } | undefined;
  if (!row) throw new Error('active ownership missing');
  return row.id;
}

function seedSecretaryDeletedMapping(agendaItemId: string): void {
  realDb.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, provider_event_id, provider_source,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, decision_explanation, source_shape_hash,
      scheduled_segments_json, cancellation_reason, created_at, updated_at,
      reasoning_trail_json
    ) VALUES (
      ?, 'training:atomic:1', 'training', 'schedule_session',
      '1', 'training_session', 7, '7',
      'superseded', 'deleted', 'evt-atomic', 'google',
      1, 'Easy Run', '2026-08-03T08:00:00.000Z', '2026-08-03T09:00:00.000Z',
      60, 'scheduled', '[]', 'fixture', 'shape-a', '[]',
      'provider_deleted_local_pending', '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z', '[]'
    )
  `).run(agendaItemId);
}

describe('Training calendar local mapping commit — real SQLite', () => {
  beforeEach(() => {
    realDb = new Database(':memory:');
    for (const migration of MIGRATIONS) {
      realDb.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), 'utf8'));
    }
    realDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  });

  afterEach(() => {
    realDb.close();
  });

  it('rolls back the session link and state when the ownership insert fails', () => {
    const { planId, sessionId } = seedPlanWithSession();
    realDb.exec(`
      CREATE TRIGGER fail_training_ownership_insert
      BEFORE INSERT ON training_agenda_event_ownership
      BEGIN
        SELECT RAISE(ABORT, 'forced ownership failure');
      END;
    `);

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId)))
      .toThrow('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it('writes no ownership when the initial session-link update misses', () => {
    const { planId, sessionId } = seedPlanWithSession();

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId + 10_000)))
      .toThrow('TRAINING_CALENDAR_SESSION_LINK_FAILED');
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it('fails closed when the session exists without its owning plan scope', () => {
    const { planId, sessionId } = seedPlanWithSession();
    realDb.pragma('foreign_keys = OFF');
    realDb.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(planId);
    expect(sessionRow(sessionId)).toBeDefined();

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId)))
      .toThrow('TRAINING_CALENDAR_MAPPING_SCOPE_MISMATCH');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it('rolls back a successful link when the following session-state update misses', () => {
    const { planId, sessionId } = seedPlanWithSession();
    realDb.exec(`
      CREATE TRIGGER remove_session_after_calendar_link
      AFTER UPDATE OF calendar_event_id ON training_sessions
      WHEN NEW.calendar_event_id IS NOT NULL
      BEGIN
        DELETE FROM training_sessions WHERE id = NEW.id;
      END;
    `);

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId)))
      .toThrow('TRAINING_CALENDAR_SESSION_STATE_UPDATE_FAILED');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it('rejects a mismatched exact tuple before any local mutation', () => {
    const { planId, sessionId } = seedPlanWithSession();
    const input = commitInput(planId, sessionId);
    input.ownership.eventId = 'evt-other';

    expect(() => commitTrainingCalendarSessionMapping(input))
      .toThrow('TRAINING_CALENDAR_MAPPING_TUPLE_MISMATCH');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it.each([
    ['plan', { planId: 9_999 }],
    ['tenant', { tenantId: 8 }],
    ['user', { userId: 8 }],
  ])('rejects a cross-%s ownership scope before any local mutation', (_label, override) => {
    const { planId, sessionId } = seedPlanWithSession();
    const input = commitInput(planId, sessionId);
    Object.assign(input.ownership, override);

    expect(() => commitTrainingCalendarSessionMapping(input))
      .toThrow('TRAINING_CALENDAR_MAPPING_SCOPE_MISMATCH');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT COUNT(*) AS count FROM training_agenda_event_ownership').get())
      .toEqual({ count: 0 });
  });

  it('rejects an idempotency collision owned by a different session', () => {
    const { planId, sessionId } = seedPlanWithSession();
    const other = realDb.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, tenant_id, day_of_week, session_type, title, status
      )
      SELECT week_id, plan_id, tenant_id, 'Tuesday', session_type, 'Other Run', 'pending'
        FROM training_sessions WHERE id = ?
    `).run(sessionId);
    realDb.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, tenant_id, user_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, ?, 7, 7, 'evt-atomic', 'google', 'active')
    `).run(planId, Number(other.lastInsertRowid));

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId)))
      // Stronger global lifecycle guarantee: the recorder itself rejects the
      // idempotency collision before the helper can accept the wrong row.
      .toThrow('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
  });

  it('does not reactivate a deleted ownership row by relinking the session', () => {
    const { planId, sessionId } = seedPlanWithSession();
    realDb.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, tenant_id, user_id,
        calendar_event_id, calendar_source, status, deleted_at
      ) VALUES (?, 1, ?, 7, 7, 'evt-atomic', 'google', 'deleted', datetime('now'))
    `).run(planId, sessionId);

    expect(() => commitTrainingCalendarSessionMapping(commitInput(planId, sessionId)))
      // Terminal audit rows are never silently reactivated by idempotency.
      .toThrow('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    expect(sessionRow(sessionId)).toEqual({
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare('SELECT status FROM training_agenda_event_ownership').get())
      .toEqual({ status: 'deleted' });
  });

  it('retires the exact ownership and linked session in one local transaction', () => {
    const { planId, sessionId } = seedPlanWithSession();
    commitTrainingCalendarSessionMapping(commitInput(planId, sessionId));
    const ownershipId = activeOwnershipId(planId, sessionId);

    expect(retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: 7,
      userId: 7,
      ownershipId,
      reason: 'provider_switch',
    })).toEqual({ ownershipRowsAffected: 1, sessionUnlinked: true });
    expect(sessionRow(sessionId)).toMatchObject({
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(realDb.prepare(`
      SELECT status, delete_reason FROM training_agenda_event_ownership WHERE id = ?
    `).get(ownershipId)).toEqual({ status: 'deleted', delete_reason: 'provider_switch' });
  });

  it('retires a prior-version reusable ownership when the current session is already unlinked', () => {
    const { planId, sessionId } = seedPlanWithSession();
    const inserted = realDb.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, tenant_id, user_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, ?, 7, 7, 'evt-atomic', 'google', 'active')
    `).run(planId, sessionId);

    expect(retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: 7,
      userId: 7,
      ownershipId: Number(inserted.lastInsertRowid),
      reason: 'prior_version_provider_switch',
      allowAlreadyUnlinked: true,
    })).toEqual({ ownershipRowsAffected: 1, sessionUnlinked: false });
  });

  it('rolls back ownership retirement when the exact session unlink fence fails', () => {
    const { planId, sessionId } = seedPlanWithSession();
    const inserted = realDb.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, tenant_id, user_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, ?, 7, 7, 'evt-atomic', 'google', 'active')
    `).run(planId, sessionId);
    realDb.prepare(`
      UPDATE training_sessions
         SET calendar_event_id = 'different-event', calendar_source = 'google'
       WHERE id = ?
    `).run(sessionId);

    expect(() => retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: 7,
      userId: 7,
      ownershipId: Number(inserted.lastInsertRowid),
      reason: 'provider_switch',
    })).toThrow('TRAINING_CALENDAR_SESSION_UNLINK_FENCE_FAILED');
    expect(realDb.prepare(`
      SELECT status, deleted_at FROM training_agenda_event_ownership WHERE id = ?
    `).get(inserted.lastInsertRowid)).toEqual({ status: 'active', deleted_at: null });
    expect(sessionRow(sessionId)).toMatchObject({
      calendar_event_id: 'different-event',
      calendar_source: 'google',
    });
  });

  it.each([
    ['wrong ownership id', { ownershipIdOffset: 10_000 }, 'TRAINING_CALENDAR_OWNERSHIP_DELETE_FENCE_FAILED'],
    ['cross-tenant scope', { tenantId: 8 }, 'TRAINING_CALENDAR_RETIRE_SCOPE_MISMATCH'],
  ])('fails closed for %s without retiring or unlinking', (_label, override, expectedError) => {
    const { planId, sessionId } = seedPlanWithSession();
    commitTrainingCalendarSessionMapping(commitInput(planId, sessionId));
    const ownershipId = activeOwnershipId(planId, sessionId);

    expect(() => retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: override.tenantId ?? 7,
      userId: 7,
      ownershipId: ownershipId + (override.ownershipIdOffset ?? 0),
      reason: 'provider_switch',
    })).toThrow(expectedError);
    expect(sessionRow(sessionId)).toMatchObject({
      calendar_event_id: 'evt-atomic',
      calendar_source: 'google',
    });
    expect(realDb.prepare(`
      SELECT status, deleted_at FROM training_agenda_event_ownership WHERE id = ?
    `).get(ownershipId)).toEqual({ status: 'active', deleted_at: null });
  });

  it('clears the Secretary deleted-id tombstone in the same retirement transaction', () => {
    const { planId, sessionId } = seedPlanWithSession();
    commitTrainingCalendarSessionMapping(commitInput(planId, sessionId));
    const ownershipId = activeOwnershipId(planId, sessionId);
    seedSecretaryDeletedMapping('sec-atomic');

    retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: 7,
      userId: 7,
      ownershipId,
      reason: 'provider_switch',
      secretaryTombstone: { agendaItemId: 'sec-atomic', now: '2026-08-03T10:00:00.000Z' },
    });

    expect(realDb.prepare(`
      SELECT provider_event_id, provider_source, provider_sync_state, lifecycle_state
        FROM secretary_agenda_items WHERE agenda_item_id = 'sec-atomic'
    `).get()).toEqual({
      provider_event_id: null,
      provider_source: null,
      provider_sync_state: 'deleted',
      lifecycle_state: 'unscheduled',
    });
  });

  it('rolls back the local retirement when the Secretary tombstone clear fence misses', () => {
    const { planId, sessionId } = seedPlanWithSession();
    commitTrainingCalendarSessionMapping(commitInput(planId, sessionId));
    const ownershipId = activeOwnershipId(planId, sessionId);

    expect(() => retireTrainingCalendarSessionMapping({
      sessionId,
      eventId: 'evt-atomic',
      source: 'google',
      planId,
      tenantId: 7,
      userId: 7,
      ownershipId,
      reason: 'provider_switch',
      secretaryTombstone: { agendaItemId: 'missing-agenda' },
    })).toThrow('TRAINING_CALENDAR_SECRETARY_TOMBSTONE_CLEAR_FENCE_FAILED');
    expect(sessionRow(sessionId)).toMatchObject({
      calendar_event_id: 'evt-atomic',
      calendar_source: 'google',
    });
    expect(realDb.prepare(`
      SELECT status, deleted_at FROM training_agenda_event_ownership WHERE id = ?
    `).get(ownershipId)).toEqual({ status: 'active', deleted_at: null });
  });
});
