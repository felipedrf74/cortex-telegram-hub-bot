/**
 * Tests for training plan tool handlers in tool-executor.ts
 *
 * Verifies that tool executor correctly dispatches training plan
 * operations and returns expected response shapes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { listCanonicalMigrationFiles } from '../utils/migrations';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;
let testUserId: number;

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Mock external services that tool-executor imports
vi.mock('../../src/state/notes', () => ({ saveNote: vi.fn(), searchNotes: vi.fn() }));
vi.mock('../../src/state/reminders', () => ({ setReminder: vi.fn() }));
vi.mock('../../src/state/shared-memory', () => ({ setSharedMemory: vi.fn(), removeSharedMemory: vi.fn(), getSharedMemory: vi.fn(() => []), getSharedMemorySummary: vi.fn(() => '') }));
vi.mock('../../src/services/unified-calendar', () => ({
  isAnyCalendarConfigured: vi.fn().mockReturnValue(false),
  getEvents: vi.fn(), createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(),
}));
vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn().mockReturnValue(false),
  searchEmails: vi.fn(), readEmail: vi.fn(), sendEmail: vi.fn(), replyToEmail: vi.fn(), getUnreadEmails: vi.fn(),
}));
vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn().mockReturnValue(false),
}));

import { executeToolCall as executeToolCallRaw } from '../../src/services/tool-executor';
import { runWithChatToolAuthorization } from '../../src/services/chat-tool-authorization';
import * as trainingPlans from '../../src/services/training-plans';

function executeToolCall(toolName: string, input: Record<string, any>, userId?: number, tenantId = userId): Promise<any> {
  if (!userId || !tenantId) {
    return executeToolCallRaw(toolName, input, userId, tenantId);
  }
  return runWithChatToolAuthorization({
    userId,
    tenantId,
    confirmedDestructiveAction: true,
    confirmationSource: 'explicit_current_turn',
  }, () => executeToolCallRaw(toolName, input, userId, tenantId)) as Promise<any>;
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  const result = testDb.prepare(`
    INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (123456, 'Tester', 'pro', 'active', 200, 500000, 1)
  `).run();
  testUserId = Number(result.lastInsertRowid);
});

describe('Training Plan Tool Handlers', () => {
  it('create_training_plan creates a plan and returns ID', async () => {
    const result = await executeToolCall('create_training_plan', {
      name: 'Test Plan', sport: 'strength', duration_weeks: 8,
      start_date: '2026-04-01', end_date: '2026-05-27', goal: 'Build base',
    }, testUserId);
    expect(result.success).toBe(true);
    expect(result.plan_id).toBe(1);
    expect(result.name).toBe('Test Plan');
  });

  it('add_training_week creates a week', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    const result = await executeToolCall('add_training_week', {
      plan_id: 1, week_number: 1, focus: 'hypertrophy', intensity_pct: 100, volume_sessions: 5,
    }, testUserId);
    expect(result.success).toBe(true);
    expect(result.week_id).toBe(1);
  });

  it('add_training_session creates a session', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    const result = await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Upper Body Push',
      exercises_json: JSON.stringify([{ name: 'Bench Press', sets: 4, reps: 8 }]),
      duration_minutes: 60, intensity_text: 'RPE 7',
    }, testUserId);
    expect(result.success).toBe(true);
    expect(result.session_id).toBe(1);
    expect(result.title).toBe('Upper Body Push');
  });

  it('blocks legacy plan creation and projection growth for an active enrolled user without mutating rows', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Projection', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    const priorMode = process.env[modeKey];
    process.env[modeKey] = 'active';
    try {
      const blockedCreate = await executeToolCall('create_training_plan', {
        name: 'Forbidden legacy plan', sport: 'running', duration_weeks: 4,
        start_date: '2026-05-01', end_date: '2026-05-29',
      }, testUserId);
      expect(blockedCreate).toMatchObject({
        success: false,
        code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
      });

      testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-1' WHERE id = 1").run();
      const blockedWeek = await executeToolCall('add_training_week', {
        plan_id: 1, week_number: 2, focus: 'forbidden growth',
      }, testUserId);
      const blockedSessionViaPlan = await executeToolCall('add_training_session', {
        week_id: 1, plan_id: 1, day_of_week: 'Tuesday',
        session_type: 'strength', title: 'Forbidden projection session',
      }, testUserId);
      for (const result of [blockedWeek, blockedSessionViaPlan]) {
        expect(result).toMatchObject({
          success: false,
          code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
        });
      }

      testDb.prepare('UPDATE fitness_training_plans SET source_revision_id = NULL WHERE id = 1').run();
      testDb.prepare("UPDATE training_weeks SET source_revision_id = 'revision-1' WHERE id = 1").run();
      const blockedSessionViaWeek = await executeToolCall('add_training_session', {
        week_id: 1, plan_id: 1, day_of_week: 'Wednesday',
        session_type: 'strength', title: 'Forbidden revision week session',
      }, testUserId);
      expect(blockedSessionViaWeek).toMatchObject({
        success: false,
        code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
      });

      expect(testDb.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get())
        .toEqual({ count: 1 });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_weeks').get())
        .toEqual({ count: 1 });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_sessions').get())
        .toEqual({ count: 0 });
    } finally {
      if (priorMode === undefined) delete process.env[modeKey];
      else process.env[modeKey] = priorMode;
    }
  });

  it('preserves legacy projection growth when this exact scope is off or only another scope is enrolled', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Legacy projection', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-legacy' WHERE id = 1").run();
    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    const otherModeKey = 'TRAINING_PLAN_REVISION_V1_MODE_USER_999999';
    const priorMode = process.env[modeKey];
    const priorOtherMode = process.env[otherModeKey];
    try {
      process.env[modeKey] = 'off';
      const offWeek = await executeToolCall('add_training_week', {
        plan_id: 1, week_number: 1,
      }, testUserId);
      const offSession = await executeToolCall('add_training_session', {
        week_id: offWeek.week_id, plan_id: 1, day_of_week: 'Monday',
        session_type: 'strength', title: 'Legacy off session',
      }, testUserId);
      expect(offWeek.success).toBe(true);
      expect(offSession.success).toBe(true);

      delete process.env[modeKey];
      process.env[otherModeKey] = 'active';
      const otherScopeWeek = await executeToolCall('add_training_week', {
        plan_id: 1, week_number: 2,
      }, testUserId);
      expect(otherScopeWeek.success).toBe(true);
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_weeks').get())
        .toEqual({ count: 2 });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_sessions').get())
        .toEqual({ count: 1 });
    } finally {
      if (priorMode === undefined) delete process.env[modeKey];
      else process.env[modeKey] = priorMode;
      if (priorOtherMode === undefined) delete process.env[otherModeKey];
      else process.env[otherModeKey] = priorOtherMode;
    }
  });

  it('normalizes new exercise prescriptions at both tool and persistence boundaries only when active', async () => {
    const priorMode = process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE;
    process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE = 'active';
    try {
      await executeToolCall('create_training_plan', {
        name: 'Identity Plan', sport: 'strength', duration_weeks: 4,
        start_date: '2026-04-01', end_date: '2026-04-29',
      }, testUserId);
      await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
      const created = await executeToolCall('add_training_session', {
        week_id: 1, plan_id: 1, day_of_week: 'Monday',
        session_type: 'strength', title: 'Canonical session',
        exercises_json: JSON.stringify([{ name: 'Tempo Split Squat', sets: 3, reps: 10 }]),
      }, testUserId);

      expect(created.success).toBe(true);
      expect(JSON.parse((testDb.prepare('SELECT exercises_json FROM training_sessions WHERE id = 1')
        .get() as { exercises_json: string }).exercises_json)).toEqual([{
        name: 'Split Squat',
        sets: 3,
        reps: 10,
        exerciseId: 'split_squat',
        tempo: '3-1-1-0',
      }]);

      const updated = await executeToolCall('update_training_session', {
        session_id: 1,
        exercises_json: JSON.stringify([{ name: 'Band Face Pull', sets: 2, reps: 15 }]),
      }, testUserId);
      expect(updated.success).toBe(true);
      expect(JSON.parse((testDb.prepare('SELECT exercises_json FROM training_sessions WHERE id = 1')
        .get() as { exercises_json: string }).exercises_json)).toEqual([{
        name: 'Face Pull',
        sets: 2,
        reps: 15,
        exerciseId: 'face_pull',
      }]);
    } finally {
      if (priorMode === undefined) delete process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE;
      else process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE = priorMode;
    }
  });

  it('preserves legacy service writes with missing user scope off and fails closed only when active', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Legacy Scope Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    testDb.pragma('foreign_keys = OFF');
    testDb.prepare('UPDATE fitness_training_plans SET user_id = 0 WHERE id = 1').run();

    const globalKey = 'TRAINING_EXERCISE_IDENTITY_V1_MODE';
    const tenantKey = `TRAINING_EXERCISE_IDENTITY_V1_MODE_TENANT_${testUserId}`;
    const priorGlobal = process.env[globalKey];
    const priorTenant = process.env[tenantKey];
    const legacyExercises = JSON.stringify([{ name: 'Legacy Custom Move', sets: 2, reps: 12 }]);
    try {
      process.env[globalKey] = 'off';
      process.env[tenantKey] = 'off';
      const created = trainingPlans.createSession({
        week_id: 1,
        plan_id: 1,
        day_of_week: 'Monday',
        session_type: 'strength',
        title: 'Legacy custom session',
        exercises_json: legacyExercises,
      });
      expect(created.exercises_json).toBe(legacyExercises);
      expect(trainingPlans.updateSession(created.id, { exercises_json: legacyExercises })).toBe(true);
      expect(trainingPlans.getSessionById(created.id)?.exercises_json).toBe(legacyExercises);

      process.env[globalKey] = 'active';
      process.env[tenantKey] = 'active';
      expect(() => trainingPlans.updateSession(created.id, { exercises_json: legacyExercises }))
        .toThrow(/TRAINING_SESSION_SCOPE_MISSING/);
    } finally {
      if (priorGlobal === undefined) delete process.env[globalKey];
      else process.env[globalKey] = priorGlobal;
      if (priorTenant === undefined) delete process.env[tenantKey];
      else process.env[tenantKey] = priorTenant;
    }
  });

  it('get_training_plan returns plan with sessions', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 28);

    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: today, end_date: endDate.toISOString().slice(0, 10),
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1, focus: 'hypertrophy' }, testUserId);
    await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Push Day',
    }, testUserId);

    const result = await executeToolCall('get_training_plan', { plan_id: 1 }, testUserId);
    expect(result.plan.name).toBe('Plan');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].title).toBe('Push Day');
  });

  it('get_training_plan returns error when not found', async () => {
    const result = await executeToolCall('get_training_plan', { plan_id: 999 }, testUserId);
    expect(result.error).toBeTruthy();
  });

  it('log_training_completion logs and returns completion', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Test',
    }, testUserId);

    const result = await executeToolCall('log_training_completion', {
      session_id: 1, rpe_overall: 7, energy_level: 8,
      soreness_level: 3, notes: 'Felt great',
    }, testUserId);
    expect(result.success).toBe(true);
    expect(result.completion_id).toBe(1);
  });

  it('log_training_completion returns error for invalid session', async () => {
    const result = await executeToolCall('log_training_completion', { session_id: 999 });
    expect(result.error).toBeTruthy();
  });

  it('update_training_session updates fields', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Original',
    }, testUserId);

    const result = await executeToolCall('update_training_session', {
      session_id: 1, title: 'Updated', intensity_text: 'RPE 9',
    }, testUserId);
    expect(result.success).toBe(true);
  });

  it('link_session_calendar links session to calendar event', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Test',
    }, testUserId);

    const result = await executeToolCall('link_session_calendar', {
      session_id: 1, calendar_event_id: 'AAMk456', calendar_source: 'outlook',
    }, testUserId);
    expect(result.success).toBe(true);
  });

  it('allows legacy session tools but blocks revision-owned projection rewrites', async () => {
    await executeToolCall('create_training_plan', {
      name: 'Plan', sport: 'strength', duration_weeks: 4,
      start_date: '2026-04-01', end_date: '2026-04-29',
    }, testUserId);
    await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 }, testUserId);
    await executeToolCall('add_training_session', {
      week_id: 1, plan_id: 1, day_of_week: 'Monday',
      session_type: 'strength', title: 'Original',
    }, testUserId);

    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    process.env[modeKey] = 'active';
    try {
      const legacyUpdate = await executeToolCall('update_training_session', {
        session_id: 1, title: 'Allowed legacy update',
      }, testUserId);
      const legacyLink = await executeToolCall('link_session_calendar', {
        session_id: 1, calendar_event_id: 'legacy-event', calendar_source: 'google',
      }, testUserId);
      expect(legacyUpdate.success).toBe(true);
      expect(legacyLink.success).toBe(true);

      testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-1' WHERE id = 1").run();
      const blockedUpdate = await executeToolCall('update_training_session', {
        session_id: 1, title: 'Forbidden rewrite',
      }, testUserId);
      const blockedStatusOnly = await executeToolCall('update_training_session', {
        session_id: 1, status: 'completed',
      }, testUserId);
      const blockedLink = await executeToolCall('link_session_calendar', {
        session_id: 1, calendar_event_id: 'forbidden-event', calendar_source: 'outlook',
      }, testUserId);

      for (const result of [blockedUpdate, blockedStatusOnly, blockedLink]) {
        expect(result).toMatchObject({
          success: false,
          code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
        });
      }
      expect(testDb.prepare(`
        SELECT title, status, calendar_event_id AS calendarEventId, calendar_source AS calendarSource
          FROM training_sessions WHERE id = 1
      `).get()).toEqual({
        title: 'Allowed legacy update',
        status: 'pending',
        calendarEventId: 'legacy-event',
        calendarSource: 'google',
      });

      const completion = await executeToolCall('log_training_completion', {
        session_id: 1, rpe_overall: 7,
      }, testUserId);
      expect(completion.success).toBe(true);
      expect(testDb.prepare('SELECT status FROM training_sessions WHERE id = 1').get())
        .toEqual({ status: 'completed' });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_completions WHERE session_id = 1').get())
        .toEqual({ count: 1 });
    } finally {
      delete process.env[modeKey];
    }
  });
});
