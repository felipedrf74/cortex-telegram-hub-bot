/**
 * Tenant isolation integration tests for training-calendar-scope.
 *
 * These run against a real better-sqlite3 ':memory:' database with all
 * migrations applied, so the SQL tenant predicates, bind-parameter order,
 * and the tenant-matched LEFT JOIN are actually exercised — the unit test
 * file mocks the db layer and can only pin the JS post-filter.
 *
 * Pins:
 *   - Owner METADATA is tenant-scoped: getTrainingCalendarEventOwners never
 *     returns another tenant's rows.
 *   - Cross-tenant claims still VETO destructive decisions: a provider event
 *     claimed by tenant A is not "unclaimed" for tenant B (shared-calendar
 *     safety — provider event ids are shared across viewers).
 *   - isTrainingCalendarEventClaimedOutsideTenant is boolean-only and counts
 *     live claims (sessions + active/orphaned ownership rows), not deleted ones.
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
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

import {
  getTrainingCalendarEventOwners,
  isTrainingCalendarEventClaimedOutsideTenant,
  isTrainingCalendarEventUnclaimed,
} from '../../src/services/training-calendar-scope';

function seedPlan(input: { userId: number; tenantId: number; status?: string }): number {
  const result = testDb.prepare(`
    INSERT INTO fitness_training_plans (user_id, tenant_id, name, duration_weeks, status, start_date, end_date)
    VALUES (?, ?, 'Plan', 4, ?, '2026-04-20', '2026-05-18')
  `).run(input.userId, input.tenantId, input.status ?? 'active');
  return Number(result.lastInsertRowid);
}

function seedLinkedSession(input: { planId: number; tenantId: number; eventId: string; source: string }): number {
  const week = testDb.prepare(`
    INSERT INTO training_weeks (plan_id, week_number) VALUES (?, 1)
  `).run(input.planId);
  const session = testDb.prepare(`
    INSERT INTO training_sessions (week_id, plan_id, tenant_id, day_of_week, session_type, title, calendar_event_id, calendar_source)
    VALUES (?, ?, ?, 'Monday', 'run', 'Recovery Run', ?, ?)
  `).run(Number(week.lastInsertRowid), input.planId, input.tenantId, input.eventId, input.source);
  return Number(session.lastInsertRowid);
}

function seedOwnership(input: {
  planId: number;
  userId: number;
  tenantId: number;
  eventId: string;
  source: string;
  status?: string;
}): void {
  testDb.prepare(`
    INSERT INTO training_agenda_event_ownership (plan_id, plan_version, user_id, tenant_id, calendar_event_id, calendar_source, status)
    VALUES (?, 1, ?, ?, ?, ?, ?)
  `).run(input.planId, input.userId, input.tenantId, input.eventId, input.source, input.status ?? 'active');
}

describe('training-calendar-scope tenant isolation (real SQL)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });

  afterEach(() => testDb.close());

  it('scopes owner metadata to the requesting tenant while keeping cross-tenant claims as a veto', () => {
    const planA = seedPlan({ userId: 10, tenantId: 10 });
    seedLinkedSession({ planId: planA, tenantId: 10, eventId: 'evt-shared', source: 'google' });

    // Tenant A sees its own claim as metadata.
    const ownersForA = getTrainingCalendarEventOwners('evt-shared', 'google', 10);
    expect(ownersForA).toHaveLength(1);
    expect(ownersForA[0]).toMatchObject({ eventId: 'evt-shared', tenantId: 10, userId: 10, planStatus: 'active' });
    expect(isTrainingCalendarEventUnclaimed('evt-shared', 'google', 10)).toBe(false);

    // Tenant B never receives tenant A's rows...
    expect(getTrainingCalendarEventOwners('evt-shared', 'google', 20)).toEqual([]);
    // ...but the boolean safety check still vetoes deletion/adoption.
    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-shared', 'google', 20)).toBe(true);
    expect(isTrainingCalendarEventUnclaimed('evt-shared', 'google', 20)).toBe(false);

    // From tenant A's own perspective there is no outside claim.
    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-shared', 'google', 10)).toBe(false);
  });

  it('vetoes adoption through foreign active/orphaned ownership rows but not deleted ones', () => {
    const planA = seedPlan({ userId: 10, tenantId: 10 });
    seedOwnership({ planId: planA, userId: 10, tenantId: 10, eventId: 'evt-owned', source: 'google', status: 'orphaned' });
    seedOwnership({ planId: planA, userId: 10, tenantId: 10, eventId: 'evt-released', source: 'google', status: 'deleted' });

    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-owned', 'google', 20)).toBe(true);
    expect(isTrainingCalendarEventUnclaimed('evt-owned', 'google', 20)).toBe(false);

    // A deleted ownership row is not a live claim for anyone.
    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-released', 'google', 20)).toBe(false);
    expect(isTrainingCalendarEventUnclaimed('evt-released', 'google', 20)).toBe(true);
  });

  it('keeps same-tenant different-user rows visible as owner metadata', () => {
    const plan = seedPlan({ userId: 11, tenantId: 10 });
    seedLinkedSession({ planId: plan, tenantId: 10, eventId: 'evt-team', source: 'google' });

    const owners = getTrainingCalendarEventOwners('evt-team', 'google', 10);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ tenantId: 10, userId: 11 });
    expect(isTrainingCalendarEventUnclaimed('evt-team', 'google', 10)).toBe(false);
  });

  it('treats truly unclaimed events as unclaimed for every tenant', () => {
    expect(getTrainingCalendarEventOwners('evt-nobody', 'google', 10)).toEqual([]);
    expect(isTrainingCalendarEventClaimedOutsideTenant('evt-nobody', 'google', 10)).toBe(false);
    expect(isTrainingCalendarEventUnclaimed('evt-nobody', 'google', 10)).toBe(true);
  });

  it('keeps orphaned ownership rows with a deleted plan claimed for the owning tenant', () => {
    const plan = seedPlan({ userId: 10, tenantId: 10 });
    seedOwnership({ planId: plan, userId: 10, tenantId: 10, eventId: 'evt-orphan', source: 'google', status: 'orphaned' });
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = ?').run(plan);

    const owners = getTrainingCalendarEventOwners('evt-orphan', 'google', 10);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ eventId: 'evt-orphan', planStatus: 'missing' });
    expect(isTrainingCalendarEventUnclaimed('evt-orphan', 'google', 10)).toBe(false);
  });
});
