import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDb: Database.Database;
let tempDir: string;

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

import {
  createPlan,
  createSession,
  createWeek,
  getSessionById,
  syncSessionWithCoachRecommendation,
} from '../../src/services/training-plans';


describe('Training plan coach sync', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-sync-'));
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates the linked training session when a workout moves to another day', () => {
    const plan = createPlan({
      user_id: 12,
      tenant_id: 12,
      name: 'Half marathon',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-13',
      end_date: '2026-05-11',
    });
    const week = createWeek({
      plan_id: plan.id,
      week_number: 1,
      focus: 'base',
    });
    const session = createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: 'Tuesday',
      session_type: 'run',
      title: 'Intervals',
      duration_minutes: 60,
      calendar_event_id: 'evt-1',
      calendar_source: 'outlook',
    });

    const changed = syncSessionWithCoachRecommendation({
      eventId: 'evt-1',
      source: 'outlook',
      userId: 12,
      tenantId: 12,
      action: 'MODIFY',
      newTitle: 'Easy run 30min',
      newStart: '2026-04-15T17:30:00Z',
    });

    const updated = getSessionById(session.id);
    expect(changed).toBe(true);
    expect(updated?.title).toBe('Easy run 30min');
    expect(updated?.day_of_week).toBe('Wednesday');
  });

  it('does not sync a coach recommendation into another user session with the same provider event id', () => {
    const planA = createPlan({
      user_id: 12,
      tenant_id: 12,
      name: 'Half marathon',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-13',
      end_date: '2026-05-11',
    });
    const weekA = createWeek({ plan_id: planA.id, week_number: 1 });
    const sessionA = createSession({
      week_id: weekA.id,
      plan_id: planA.id,
      day_of_week: 'Tuesday',
      session_type: 'run',
      title: 'Owner intervals',
      calendar_event_id: 'evt-shared',
      calendar_source: 'outlook',
    });

    const planB = createPlan({
      user_id: 99,
      tenant_id: 99,
      name: 'Other plan',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-13',
      end_date: '2026-05-11',
    });
    const weekB = createWeek({ plan_id: planB.id, week_number: 1 });
    const sessionB = createSession({
      week_id: weekB.id,
      plan_id: planB.id,
      day_of_week: 'Thursday',
      session_type: 'run',
      title: 'Other user run',
      calendar_event_id: 'evt-shared',
      calendar_source: 'outlook',
    });

    const changed = syncSessionWithCoachRecommendation({
      eventId: 'evt-shared',
      source: 'outlook',
      userId: 12,
      tenantId: 12,
      action: 'MODIFY',
      newTitle: 'Owner easy run',
      newStart: '2026-04-15T17:30:00Z',
    });

    expect(changed).toBe(true);
    expect(getSessionById(sessionA.id)?.title).toBe('Owner easy run');
    expect(getSessionById(sessionB.id)?.title).toBe('Other user run');
  });

  it('uses the user timezone instead of hardcoded Lisbon when deriving moved session weekday', () => {
    const plan = createPlan({
      user_id: 12,
      tenant_id: 12,
      name: 'Half marathon',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-13',
      end_date: '2026-05-11',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });
    const session = createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: 'Wednesday',
      session_type: 'run',
      title: 'Late run',
      calendar_event_id: 'evt-tz',
      calendar_source: 'outlook',
    });

    const changed = syncSessionWithCoachRecommendation({
      eventId: 'evt-tz',
      source: 'outlook',
      userId: 12,
      tenantId: 12,
      timezone: 'America/New_York',
      action: 'MODIFY',
      newStart: '2026-04-15T02:30:00.000Z',
    });

    expect(changed).toBe(true);
    expect(getSessionById(session.id)?.day_of_week).toBe('Tuesday');
  });
});
