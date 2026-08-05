/**
 * Tests for src/services/training-plans.ts
 *
 * Tests CRUD operations for training plans, weeks, sessions, completions,
 * analytics (adherence), and the auto-adjustment algorithm.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { listCanonicalMigrationFiles } from '../utils/migrations';

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


// ── Mock DB ──────────────────────────────────────────────────────

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
  },
  LOGGER_REDACTION_PATHS: [],
}));

// Import AFTER mocks
import {
  createPlan,
  getActivePlan,
  getPlanById,
  getUserPlans,
  updatePlanStatus,
  createWeek,
  getWeeksForPlan,
  getCurrentWeek,
  resolveTrainingPlanWeekNumber,
  updateWeekAdjustment,
  createSession,
  getSessionsForWeek,
  getSessionById,
  getSessionByIdForScope,
  getSessionByCalendarEvent,
  updateSession,
  markSessionCompleted,
  markSessionSkipped,
  linkSessionToCalendar,
  logCompletion,
  getWeeklyAdherence,
  getCrossplanWeeklyLoad,
  computeAdjustmentRecommendation,
  getActivePlanSummary,
  getPlanStats,
} from '../../src/services/training-plans';

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  testDb = createMigratedTestDatabase();
});

// ── Plan CRUD ──────────────────────────────────────────────────────

describe('Plan CRUD', () => {
  it('creates a training plan', () => {
    const plan = createPlan({
      user_id: 42,
      tenant_id: 42,
      name: '12-Week Strength Base',
      sport: 'strength',
      goal: 'Build strength foundation',
      duration_weeks: 12,
      periodization: 'linear',
      start_date: '2026-04-01',
      end_date: '2026-06-24',
    });
    expect(plan.id).toBe(1);
    expect(plan.name).toBe('12-Week Strength Base');
    expect(plan.sport).toBe('strength');
    expect(plan.status).toBe('active');
    expect(plan.duration_weeks).toBe(12);
  });

  it('gets active plan for user', () => {
    createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan A', sport: 'running',
      duration_weeks: 8, start_date: '2026-04-01', end_date: '2026-05-27',
    });
    const plan = getActivePlan(42, 42);
    expect(plan).not.toBeNull();
    expect(plan!.name).toBe('Plan A');
  });

  it('returns null when no active plan', () => {
    expect(getActivePlan(99, 99)).toBeNull();
  });

  it('gets plan by ID', () => {
    const created = createPlan({
      user_id: 42, tenant_id: 42, name: 'My Plan', sport: 'cycling',
      duration_weeks: 6, start_date: '2026-04-01', end_date: '2026-05-13',
    });
    const found = getPlanById(created.id);
    expect(found).not.toBeNull();
    expect(found!.sport).toBe('cycling');
  });

  it('lists user plans', () => {
    createPlan({ user_id: 42, tenant_id: 42, name: 'Plan 1', sport: 'running', duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29' });
    createPlan({ user_id: 42, tenant_id: 42, name: 'Plan 2', sport: 'strength', duration_weeks: 8, start_date: '2026-05-01', end_date: '2026-06-26' });
    createPlan({ user_id: 99, tenant_id: 99, name: 'Other User', sport: 'cycling', duration_weeks: 6, start_date: '2026-04-01', end_date: '2026-05-13' });

    const plans = getUserPlans(42);
    expect(plans).toHaveLength(2);
  });

  it('updates plan status', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const updated = updatePlanStatus(plan.id, 'paused');
    expect(updated).toBe(true);

    const found = getPlanById(plan.id);
    expect(found!.status).toBe('paused');
  });

  it('returns only active plan (most recent)', () => {
    const plan1 = createPlan({
      user_id: 42, tenant_id: 42, name: 'Old Plan', sport: 'running',
      duration_weeks: 4, start_date: '2026-01-01', end_date: '2026-01-29',
    });
    updatePlanStatus(plan1.id, 'completed');

    createPlan({
      user_id: 42, tenant_id: 42, name: 'New Plan', sport: 'strength',
      duration_weeks: 8, start_date: '2026-04-01', end_date: '2026-05-27',
    });

    const active = getActivePlan(42, 42);
    expect(active!.name).toBe('New Plan');
  });
});

// ── Week CRUD ──────────────────────────────────────────────────────

describe('Week CRUD', () => {
  it('creates a training week', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });

    const week = createWeek({
      plan_id: plan.id, week_number: 1,
      focus: 'hypertrophy', intensity_pct: 100, volume_sessions: 5,
    });
    expect(week.id).toBe(1);
    expect(week.focus).toBe('hypertrophy');
    expect(week.intensity_pct).toBe(100);
  });

  it('gets weeks for plan in order', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });

    createWeek({ plan_id: plan.id, week_number: 3, focus: 'power' });
    createWeek({ plan_id: plan.id, week_number: 1, focus: 'hypertrophy' });
    createWeek({ plan_id: plan.id, week_number: 2, focus: 'strength' });

    const weeks = getWeeksForPlan(plan.id);
    expect(weeks).toHaveLength(3);
    expect(weeks[0].week_number).toBe(1);
    expect(weeks[1].week_number).toBe(2);
    expect(weeks[2].week_number).toBe(3);
  });

  it('resolves current week using training timezone day boundaries', () => {
    const weekNumber = resolveTrainingPlanWeekNumber(
      { start_date: '2026-05-04', duration_weeks: 4 },
      {
        now: new Date('2026-05-10T23:30:00.000Z'),
        timezone: 'Europe/Lisbon',
      },
    );

    expect(weekNumber).toBe(2);
  });

  it('resolves the current week from the plan-persisted timezone by default', () => {
    const plan = createPlan({
      user_id: 42,
      tenant_id: 42,
      name: 'Immutable timezone plan',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-05-04',
      end_date: '2026-06-01',
      preferences_json: JSON.stringify({ schedulingTimezone: 'America/Los_Angeles' }),
    });
    createWeek({ plan_id: plan.id, week_number: 1, focus: 'base' });
    createWeek({ plan_id: plan.id, week_number: 2, focus: 'build' });

    // At this instant Lisbon/Tokyo are already Monday (week 2), while the
    // plan's persisted Los Angeles wall clock is still Sunday (week 1).
    // F11 requires later reads to remain pinned even after a user-zone change.
    const now = new Date('2026-05-10T23:30:00.000Z');
    expect(resolveTrainingPlanWeekNumber(plan, { now })).toBe(1);
    expect(getCurrentWeek(plan.id, { now })?.week_number).toBe(1);
  });

  it('updates week adjustment', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });

    updateWeekAdjustment(week.id, 80, 'high fatigue + low adherence');

    const weeks = getWeeksForPlan(plan.id);
    expect(weeks[0].intensity_pct).toBe(80);
    expect(weeks[0].auto_adjusted).toBe(1);
    expect(weeks[0].adjustment_reason).toBe('high fatigue + low adherence');
  });

  it('keeps revision-owned weeks immutable when the exact personal scope is active', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Revision plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, intensity_pct: 100 });
    testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-active' WHERE id = ?")
      .run(plan.id);

    const flagKey = 'TRAINING_PLAN_REVISION_V1_MODE_USER_42';
    const priorFlag = process.env[flagKey];
    process.env[flagKey] = 'active';
    try {
      expect(() => updateWeekAdjustment(week.id, 70, 'must not mutate approved projection'))
        .toThrowError(expect.objectContaining({
          code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
        }));
      expect(getWeeksForPlan(plan.id)[0]).toMatchObject({
        intensity_pct: 100,
        auto_adjusted: 0,
        adjustment_reason: null,
      });
    } finally {
      if (priorFlag === undefined) delete process.env[flagKey];
      else process.env[flagKey] = priorFlag;
    }
  });

  it('preserves legacy weekly adjustment when the exact scope is explicitly off', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Legacy plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, intensity_pct: 100 });
    testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'legacy-projection' WHERE id = ?")
      .run(plan.id);

    const globalKey = 'TRAINING_PLAN_REVISION_V1_MODE';
    const scopedKey = 'TRAINING_PLAN_REVISION_V1_MODE_USER_42';
    const priorGlobal = process.env[globalKey];
    const priorScoped = process.env[scopedKey];
    process.env[globalKey] = 'active';
    process.env[scopedKey] = 'off';
    try {
      expect(updateWeekAdjustment(week.id, 80, 'legacy scope remains mutable')).toBe(true);
      expect(getWeeksForPlan(plan.id)[0]).toMatchObject({
        intensity_pct: 80,
        auto_adjusted: 1,
        adjustment_reason: 'legacy scope remains mutable',
      });
    } finally {
      if (priorGlobal === undefined) delete process.env[globalKey];
      else process.env[globalKey] = priorGlobal;
      if (priorScoped === undefined) delete process.env[scopedKey];
      else process.env[scopedKey] = priorScoped;
    }
  });
});

// ── Session CRUD ───────────────────────────────────────────────────

describe('Session CRUD', () => {
  let planId: number;
  let weekId: number;

  beforeEach(() => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    planId = plan.id;
    const week = createWeek({ plan_id: planId, week_number: 1 });
    weekId = week.id;
  });

  it('refuses to create a session when the plan has no explicit tenant scope', () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, tenant_id, name, sport, goal, duration_weeks, periodization, start_date, end_date, status)
      VALUES (99, 42, 0, 'Legacy bad scope', 'running', 'base', 4, 'base', '2026-04-01', '2026-04-29', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number, focus, intensity_pct)
      VALUES (99, 99, 1, 'base', 100)
    `).run();

    expect(() => createSession({
      week_id: 99,
      plan_id: 99,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Bad scope run',
    })).toThrow(/TRAINING_PLAN_TENANT_SCOPE_MISSING/);
  });

  it('creates a session', () => {
    const session = createSession({
      week_id: weekId, plan_id: planId,
      day_of_week: 'Monday', session_type: 'strength',
      title: 'Upper Body Push', duration_minutes: 60,
      intensity_text: 'RPE 7',
    });
    expect(session.id).toBe(1);
    expect(session.title).toBe('Upper Body Push');
    expect(session.status).toBe('pending');
  });

  it('gets sessions for week in day order', () => {
    createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Friday', session_type: 'running', title: 'Easy Run' });
    createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Upper' });
    createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Wednesday', session_type: 'strength', title: 'Lower' });

    const sessions = getSessionsForWeek(weekId);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].day_of_week).toBe('Monday');
    expect(sessions[1].day_of_week).toBe('Wednesday');
    expect(sessions[2].day_of_week).toBe('Friday');
  });

  it('gets session by ID', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Test' });
    const found = getSessionById(s.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Test');
  });

  it('gets a session by ID only inside the owning user and tenant scope', () => {
    const currentSession = createSession({
      week_id: weekId,
      plan_id: planId,
      day_of_week: 'Monday',
      session_type: 'strength',
      title: 'Current user session',
      description: 'Current user body',
    });
    const foreignPlan = createPlan({
      user_id: 99,
      tenant_id: 99,
      name: 'Foreign Plan',
      sport: 'swim',
      duration_weeks: 4,
      start_date: '2026-04-01',
      end_date: '2026-04-29',
    });
    const foreignWeek = createWeek({ plan_id: foreignPlan.id, week_number: 1 });
    const foreignSession = createSession({
      week_id: foreignWeek.id,
      plan_id: foreignPlan.id,
      day_of_week: 'Tuesday',
      session_type: 'swim',
      title: 'Foreign private session',
      description: 'Foreign private body',
    });

    expect(getSessionByIdForScope(currentSession.id, { userId: 42, tenantId: 42 })?.title)
      .toBe('Current user session');
    expect(getSessionByIdForScope(foreignSession.id, { userId: 42, tenantId: 42 }))
      .toBeNull();
    expect(getSessionByIdForScope(foreignSession.id, { userId: 99, tenantId: 99 })?.title)
      .toBe('Foreign private session');
  });

  it('fails closed when the scoped ownership tables are unavailable', () => {
    testDb = createTestDb();

    expect(() => getSessionByIdForScope(970, { userId: 42, tenantId: 42 })).not.toThrow();
    expect(getSessionByIdForScope(970, { userId: 42, tenantId: 42 })).toBeNull();
  });

  it('updates session fields', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Original' });
    updateSession(s.id, { title: 'Updated', intensity_text: 'RPE 8' });

    const found = getSessionById(s.id);
    expect(found!.title).toBe('Updated');
    expect(found!.intensity_text).toBe('RPE 8');
  });

  it('rejects runtime update keys that are not training_session columns', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Original' });

    expect(() => updateSession(s.id, {
      "status = 'completed' WHERE 1=1 --": 'completed',
    } as any)).toThrow(/TRAINING_SESSION_UPDATE_INVALID_FIELD/);

    const found = getSessionById(s.id);
    expect(found!.status).toBe('pending');
    expect(found!.title).toBe('Original');
  });

  it('marks session completed', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Test' });
    markSessionCompleted(s.id);

    const found = getSessionById(s.id);
    expect(found!.status).toBe('completed');
  });

  it('marks session skipped', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Test' });
    markSessionSkipped(s.id);

    const found = getSessionById(s.id);
    expect(found!.status).toBe('skipped');
  });

  it('links session to calendar', () => {
    const s = createSession({ week_id: weekId, plan_id: planId, day_of_week: 'Monday', session_type: 'strength', title: 'Test' });
    linkSessionToCalendar(s.id, 'AAMk123', 'outlook');

    const found = getSessionById(s.id);
    expect(found!.calendar_event_id).toBe('AAMk123');
    expect(found!.calendar_source).toBe('outlook');
  });

  it('scopes calendar event lookups by training plan owner when event ids collide', () => {
    const userAPlan = getPlanById(planId)!;
    const userAWeek = createWeek({ plan_id: userAPlan.id, week_number: 2 });
    const userASession = createSession({
      week_id: userAWeek.id,
      plan_id: userAPlan.id,
      day_of_week: 'Tuesday',
      session_type: 'running',
      title: 'User A Run',
      calendar_event_id: 'shared-event-id',
      calendar_source: 'outlook',
    });
    const userBPlan = createPlan({
      user_id: 99,
      tenant_id: 99,
      name: 'Other Plan',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-01',
      end_date: '2026-04-29',
    });
    const userBWeek = createWeek({ plan_id: userBPlan.id, week_number: 1 });
    createSession({
      week_id: userBWeek.id,
      plan_id: userBPlan.id,
      day_of_week: 'Wednesday',
      session_type: 'running',
      title: 'User B Run',
      calendar_event_id: 'shared-event-id',
      calendar_source: 'outlook',
    });

    const found = getSessionByCalendarEvent('shared-event-id', 'outlook', { userId: 42, tenantId: 42 });
    expect(found?.id).toBe(userASession.id);
    expect(found?.title).toBe('User A Run');
  });
});

// ── Completion Logging ─────────────────────────────────────────────

describe('Completion Logging', () => {
  it('logs a completion and marks session as completed', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });
    const session = createSession({
      week_id: week.id, plan_id: plan.id,
      day_of_week: 'Monday', session_type: 'strength', title: 'Test',
    });

    const completion = logCompletion({
      session_id: session.id, plan_id: plan.id,
      rpe_overall: 7, duration_minutes: 55,
      energy_level: 8, soreness_level: 4, notes: 'Felt strong',
    });

    expect(completion.id).toBe(1);
    expect(completion.rpe_overall).toBe(7);

    // Session should be marked completed
    const found = getSessionById(session.id);
    expect(found!.status).toBe('completed');
  });
});

// ── Weekly Adherence ───────────────────────────────────────────────

describe('Weekly Adherence', () => {
  it('calculates adherence stats correctly', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, volume_sessions: 4 });

    // Create 4 sessions
    const s1 = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'strength', title: 'Upper' });
    const s2 = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Tuesday', session_type: 'running', title: 'Run' });
    const s3 = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Thursday', session_type: 'strength', title: 'Lower' });
    const s4 = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Friday', session_type: 'running', title: 'Run 2' });

    // Complete 2, skip 1, leave 1 pending
    logCompletion({ session_id: s1.id, plan_id: plan.id, rpe_overall: 7, energy_level: 8, soreness_level: 3 });
    logCompletion({ session_id: s2.id, plan_id: plan.id, rpe_overall: 6, energy_level: 7, soreness_level: 2 });
    markSessionSkipped(s3.id);

    const stats = getWeeklyAdherence(plan.id, week.id);
    expect(stats.totalSessions).toBe(4);
    expect(stats.completedSessions).toBe(2);
    expect(stats.skippedSessions).toBe(1);
    expect(stats.pendingSessions).toBe(1);
    expect(stats.adherenceRate).toBe(50); // 2/4
    expect(stats.avgRpe).toBe(6.5);
    expect(stats.avgEnergy).toBe(7.5);
    expect(stats.avgSoreness).toBe(2.5);
  });

  it('handles zero sessions', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'strength',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });

    const stats = getWeeklyAdherence(plan.id, week.id);
    expect(stats.totalSessions).toBe(0);
    expect(stats.adherenceRate).toBe(0);
    expect(stats.avgRpe).toBeNull();
  });

  it('excludes unscheduled/deferred/superseded sessions from adherence totals', () => {
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'hybrid',
      duration_weeks: 4, start_date: '2026-04-01', end_date: '2026-04-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, volume_sessions: 5 });

    const completed = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'running', title: 'Run', status: 'scheduled' });
    const skipped = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Tuesday', session_type: 'strength', title: 'Lift', status: 'reflowed' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Wednesday', session_type: 'running', title: 'Compressed Run', status: 'compressed' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Thursday', session_type: 'running', title: 'No Slot Run', status: 'unscheduled' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Friday', session_type: 'strength', title: 'Old Lift', status: 'superseded' });

    logCompletion({ session_id: completed.id, plan_id: plan.id, rpe_overall: 6 });
    markSessionSkipped(skipped.id);

    const stats = getWeeklyAdherence(plan.id, week.id);
    expect(stats.totalSessions).toBe(3);
    expect(stats.completedSessions).toBe(1);
    expect(stats.skippedSessions).toBe(1);
    expect(stats.pendingSessions).toBe(1);
    expect(stats.adherenceRate).toBe(33);
  });

  it('excludes inactive rich lifecycle states from cross-plan load', () => {
    const today = new Date().toISOString().slice(0, 10);
    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Plan', sport: 'hybrid',
      duration_weeks: 4, start_date: today, end_date: '2026-05-29',
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, volume_sessions: 4 });

    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'running', title: 'Scheduled Run', duration_minutes: 40, status: 'scheduled' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Tuesday', session_type: 'strength', title: 'Reflowed Lift', duration_minutes: 35, status: 'reflowed' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Wednesday', session_type: 'running', title: 'No Slot Run', duration_minutes: 45, status: 'unscheduled' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Thursday', session_type: 'running', title: 'Skipped Run', duration_minutes: 30, status: 'skipped' });

    const load = getCrossplanWeeklyLoad(42, 42);
    expect(load.totalSessions).toBe(2);
    expect(load.totalMinutes).toBe(75);
  });
});

// ── Auto-Adjust Algorithm ──────────────────────────────────────────

describe('computeAdjustmentRecommendation', () => {
  it('suggests reduction for low adherence', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 2, skippedSessions: 2, pendingSessions: 1,
      adherenceRate: 40, avgRpe: 7, avgEnergy: 6, avgSoreness: 5,
    });
    expect(result.adjustIntensity).toBeLessThan(100);
    expect(result.reason).toContain('adherence');
  });

  it('suggests reduction for high RPE', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 5, skippedSessions: 0, pendingSessions: 0,
      adherenceRate: 100, avgRpe: 9.2, avgEnergy: 5, avgSoreness: 7,
    });
    expect(result.adjustIntensity).toBeLessThan(100);
    expect(result.reason).toContain('RPE');
  });

  it('suggests increase for strong recovery signals', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 5, skippedSessions: 0, pendingSessions: 0,
      adherenceRate: 100, avgRpe: 6, avgEnergy: 8, avgSoreness: 3,
    });
    expect(result.adjustIntensity).toBeGreaterThanOrEqual(100);
    expect(result.reason).toContain('strong adherence');
  });

  it('suggests strong reduction for combined fatigue signals', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 2, skippedSessions: 3, pendingSessions: 0,
      adherenceRate: 40, avgRpe: 9.5, avgEnergy: 2, avgSoreness: 9,
    });
    // Should be clamped to 60 minimum
    expect(result.adjustIntensity).toBe(60);
  });

  it('reports on-track when metrics are normal', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 4, skippedSessions: 0, pendingSessions: 1,
      adherenceRate: 80, avgRpe: 7, avgEnergy: 7, avgSoreness: 4,
    });
    expect(result.adjustIntensity).toBe(100);
    expect(result.reason).toBe('on track — no adjustment needed');
  });

  it('never exceeds 110%', () => {
    const result = computeAdjustmentRecommendation({
      planId: 1, weekNumber: 1, totalSessions: 5,
      completedSessions: 5, skippedSessions: 0, pendingSessions: 0,
      adherenceRate: 100, avgRpe: 5, avgEnergy: 9, avgSoreness: 1,
    });
    expect(result.adjustIntensity).toBeLessThanOrEqual(110);
  });
});

// ── Plan Summary ───────────────────────────────────────────────────

describe('getActivePlanSummary', () => {
  it('returns null when no active plan', () => {
    expect(getActivePlanSummary(99, 99)).toBeNull();
  });

  it('returns plan summary with current week', () => {
    // Create a plan that started "today" — week 1 should be current
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 28);

    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Test Plan', sport: 'strength', goal: 'Get strong',
      duration_weeks: 4, start_date: today, end_date: endDate.toISOString().slice(0, 10),
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1, focus: 'hypertrophy' });
    createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'strength', title: 'Upper Push' });

    const summary = getActivePlanSummary(42, 42);
    expect(summary).not.toBeNull();
    expect(summary).toContain('Test Plan');
    expect(summary).toContain('strength');
    expect(summary).toContain('Week 1');
    expect(summary).toContain('Upper Push');
  });
});

// ── Plan Stats ─────────────────────────────────────────────────────

describe('getPlanStats', () => {
  it('returns stats for user with active plan', () => {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 28);

    const plan = createPlan({
      user_id: 42, tenant_id: 42, name: 'Test', sport: 'strength',
      duration_weeks: 4, start_date: today, end_date: endDate.toISOString().slice(0, 10),
    });
    const week = createWeek({ plan_id: plan.id, week_number: 1 });
    const s = createSession({ week_id: week.id, plan_id: plan.id, day_of_week: 'Monday', session_type: 'strength', title: 'Test' });
    logCompletion({ session_id: s.id, plan_id: plan.id, rpe_overall: 7 });

    const stats = getPlanStats(42, 42);
    expect(stats.activePlans).toBe(1);
    expect(stats.totalCompletedSessions).toBe(1);
    expect(stats.currentPlanName).toBe('Test');
  });

  it('returns zeros for user with no plans', () => {
    const stats = getPlanStats(99, 99);
    expect(stats.activePlans).toBe(0);
    expect(stats.totalCompletedSessions).toBe(0);
    expect(stats.currentPlanName).toBeNull();
  });
});
