/**
 * Tests for training plan tool handlers in tool-executor.ts
 *
 * Verifies that tool executor correctly dispatches training plan
 * operations and returns expected response shapes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
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
import { TOOLS } from '../../src/services/anthropic';
import { getSkillDefinition } from '../../src/skills/skill-config';
import trainingManifest from '../../src/skills/training/manifest.json';
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
  const retiredRawWriterNames = [
    'add_training_week',
    'add_training_session',
    'update_training_session',
  ] as const;

  /**
   * F13 (Phase 1A-3): `create_training_plan` no longer writes, so suites that
   * only need a plan to exist seed one directly.
   */
  function seedPlan(
    name = 'Plan',
    startDate = '2026-04-01',
    endDate = '2026-04-29',
  ): number {
    const row = testDb.prepare(`
      INSERT INTO fitness_training_plans
        (user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, 'strength', 4, ?, ?, 'active')
    `).run(testUserId, testUserId, name, startDate, endDate);
    return Number(row.lastInsertRowid);
  }

  function seedWeek(planId: number, weekNumber = 1): number {
    const row = testDb.prepare(`
      INSERT INTO training_weeks (plan_id, week_number, focus)
      VALUES (?, ?, 'base')
    `).run(planId, weekNumber);
    return Number(row.lastInsertRowid);
  }

  function seedSession(planId: number, weekId: number, title = 'Original'): number {
    const row = testDb.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, day_of_week, session_type, title, status
      ) VALUES (?, ?, 'Monday', 'strength', ?, 'pending')
    `).run(weekId, planId, title);
    return Number(row.lastInsertRowid);
  }

  function rawPlanGraphSnapshot(): unknown {
    return {
      plans: testDb.prepare(`
        SELECT id, user_id, tenant_id, name, status, source_revision_id
          FROM fitness_training_plans ORDER BY id
      `).all(),
      weeks: testDb.prepare(`
        SELECT id, plan_id, week_number, focus, source_revision_id
          FROM training_weeks ORDER BY id
      `).all(),
      sessions: testDb.prepare(`
        SELECT id, plan_id, week_id, title, status, exercises_json,
               duration_minutes, intensity_text, source_revision_id
          FROM training_sessions ORDER BY id
      `).all(),
    };
  }

  it('does not expose retired raw week/session writers to any model skill mirror', () => {
    const anthropicToolNames = TOOLS.map((tool) => tool.name);
    const configuredTools = getSkillDefinition('triathlon')
      .subSkills.find((subSkill) => subSkill.name === 'training-plans')!.tools;
    const manifestTools = trainingManifest.subSkills
      .find((subSkill) => subSkill.module_name === 'training-plans')!.tools;
    const promptText = [
      'prompts/triathlon.md',
      'prompts/triathlon/cycling.md',
      'prompts/triathlon/gym.md',
      'prompts/triathlon/running.md',
      'prompts/triathlon/swim.md',
    ].map((relativePath) => fs.readFileSync(
      path.join(__dirname, '..', '..', relativePath),
      'utf8',
    )).join('\n');

    for (const name of retiredRawWriterNames) {
      expect(anthropicToolNames).not.toContain(name);
      expect(configuredTools).not.toContain(name);
      expect(manifestTools).not.toContain(name);
      expect(promptText).not.toContain(name);
    }
    expect(anthropicToolNames).toContain('create_training_plan');
    expect(promptText).toContain('reviewed Training plan builder');
  });

  it('requires authenticated chat authorization before even refusing retired raw writers', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId);
    const before = rawPlanGraphSnapshot();

    for (const [toolName, input] of [
      ['add_training_week', { plan_id: planId, week_number: 2 }],
      ['add_training_session', {
        plan_id: planId, week_id: weekId, day_of_week: 'Tuesday',
        session_type: 'strength', title: 'Must not exist',
      }],
      ['update_training_session', { session_id: sessionId, title: 'Must not change' }],
    ] as const) {
      const result = await executeToolCallRaw(toolName, input, testUserId, testUserId);
      expect(result).toMatchObject({ success: false, code: 'AUTH_REQUIRED' });
    }
    expect(rawPlanGraphSnapshot()).toEqual(before);
  });

  it('does not disclose retired-writer handoffs for another tenant plan/session', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId);
    const attacker = testDb.prepare(`
      INSERT INTO users (
        telegram_id, first_name, tier, status,
        daily_message_limit, daily_token_limit, daily_cost_limit_usd
      ) VALUES (654321, 'Other', 'pro', 'active', 200, 500000, 1)
    `).run();
    const attackerId = Number(attacker.lastInsertRowid);
    const before = rawPlanGraphSnapshot();

    for (const [toolName, input] of [
      ['add_training_week', { plan_id: planId, week_number: 2 }],
      ['add_training_session', {
        plan_id: planId, week_id: weekId, day_of_week: 'Tuesday',
        session_type: 'strength', title: 'Must not exist',
      }],
      ['update_training_session', { session_id: sessionId, title: 'Must not change' }],
    ] as const) {
      const result = await executeToolCall(toolName, input, attackerId);
      expect(String(result.error)).toContain('cannot access that training');
      expect(result.handoff).toBeUndefined();
    }
    expect(rawPlanGraphSnapshot()).toEqual(before);
  });

  it('refuses every retired raw writer after authorization with zero plan/week/session mutation', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId);
    const before = rawPlanGraphSnapshot();

    for (const [toolName, input] of [
      ['add_training_week', { plan_id: planId, week_number: 2 }],
      ['add_training_session', {
        plan_id: planId, week_id: weekId, day_of_week: 'Tuesday',
        session_type: 'strength', title: 'Must not exist',
      }],
      ['update_training_session', { session_id: sessionId, title: 'Must not change' }],
    ] as const) {
      const result = await executeToolCall(toolName, input, testUserId);
      expect(result).toMatchObject({
        success: false,
        code: 'TRAINING_RAW_WRITER_DISABLED',
        handoff: 'training_plan_builder',
      });
    }
    expect(rawPlanGraphSnapshot()).toEqual(before);
  });

  it('create_training_plan refuses to write a plan and hands off to the reviewed builder', async () => {
    // Previously this asserted the tool created a plan row. That was the
    // defect: `createPlan` inserts with status defaulting to 'active' and
    // there is no unique constraint on active plans, so one model turn could
    // create an empty shell plan that shadowed the athlete's real one
    // (`getActivePlan` orders by created_at DESC). It also bypassed the coach
    // kernel, volume enforcement, the linter, the safety guardrails and the
    // cancellation saga.
    const before = testDb.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get() as { count: number };

    const result = await executeToolCall('create_training_plan', {
      name: 'Test Plan', sport: 'strength', duration_weeks: 8,
      start_date: '2026-04-01', end_date: '2026-05-27', goal: 'Build base',
    }, testUserId);

    expect(result).toMatchObject({
      success: false,
      code: 'TRAINING_RAW_WRITER_DISABLED',
    });
    expect(result.plan_id).toBeUndefined();
    expect(String(result.error)).toContain('cannot write Training plan projections directly');
    expect(result.handoff).toBe('training_plan_builder');

    const after = testDb.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get() as { count: number };
    expect(after.count).toBe(before.count);
  });

  it('add_training_week no longer creates a week', async () => {
    const planId = seedPlan();
    const result = await executeToolCall('add_training_week', {
      plan_id: planId, week_number: 1, focus: 'hypertrophy', intensity_pct: 100, volume_sessions: 5,
    }, testUserId);
    // F13's stronger guarantee supersedes the old fixture: model tools may
    // not grow a raw plan projection even for an authorized legacy scope.
    expect(result).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_weeks').get())
      .toEqual({ count: 0 });
  });

  it('add_training_session no longer creates a session', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const result = await executeToolCall('add_training_session', {
      week_id: weekId, plan_id: planId, day_of_week: 'Monday',
      session_type: 'strength', title: 'Upper Body Push',
      exercises_json: JSON.stringify([{ name: 'Bench Press', sets: 4, reps: 8 }]),
      duration_minutes: 60, intensity_text: 'RPE 7',
    }, testUserId);
    // F13's stronger guarantee supersedes direct session creation; the
    // complete candidate must pass the builder's lint/safety review instead.
    expect(result).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_sessions').get())
      .toEqual({ count: 0 });
  });

  it('blocks legacy plan creation and projection growth for an active enrolled user without mutating rows', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    const priorMode = process.env[modeKey];
    process.env[modeKey] = 'active';
    try {
      const blockedCreate = await executeToolCall('create_training_plan', {
        name: 'Forbidden legacy plan', sport: 'running', duration_weeks: 4,
        start_date: '2026-05-01', end_date: '2026-05-29',
      }, testUserId);
      // F13 (Phase 1A-3): creation is now refused for EVERY scope, not just
      // enrolled ones, so this no longer reaches the enrollment guard. The
      // guarantee is strictly stronger — enrolled or not, the model cannot
      // write a plan row. The week/session assertions below still exercise
      // the enrollment guard on projection growth.
      expect(blockedCreate.handoff).toBe('training_plan_builder');
      expect(blockedCreate.plan_id).toBeUndefined();

      testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-1' WHERE id = ?").run(planId);
      const blockedWeek = await executeToolCall('add_training_week', {
        plan_id: planId, week_number: 2, focus: 'forbidden growth',
      }, testUserId);
      const blockedSessionViaPlan = await executeToolCall('add_training_session', {
        week_id: weekId, plan_id: planId, day_of_week: 'Tuesday',
        session_type: 'strength', title: 'Forbidden projection session',
      }, testUserId);
      for (const result of [blockedWeek, blockedSessionViaPlan]) {
        expect(result).toMatchObject({
          success: false,
          // Stronger than the enrollment-only guard: every scope is blocked.
          code: 'TRAINING_RAW_WRITER_DISABLED',
        });
      }

      testDb.prepare('UPDATE fitness_training_plans SET source_revision_id = NULL WHERE id = 1').run();
      testDb.prepare("UPDATE training_weeks SET source_revision_id = 'revision-1' WHERE id = 1").run();
      const blockedSessionViaWeek = await executeToolCall('add_training_session', {
        week_id: weekId, plan_id: planId, day_of_week: 'Wednesday',
        session_type: 'strength', title: 'Forbidden revision week session',
      }, testUserId);
      expect(blockedSessionViaWeek).toMatchObject({
        success: false,
        code: 'TRAINING_RAW_WRITER_DISABLED',
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

  it('does not let enrollment flags re-enable retired raw projection writers', async () => {
    const planId = seedPlan();
    testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-legacy' WHERE id = 1").run();
    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    const otherModeKey = 'TRAINING_PLAN_REVISION_V1_MODE_USER_999999';
    const priorMode = process.env[modeKey];
    const priorOtherMode = process.env[otherModeKey];
    try {
      process.env[modeKey] = 'off';
      const offWeek = await executeToolCall('add_training_week', {
        plan_id: planId, week_number: 1,
      }, testUserId);
      const weekId = seedWeek(planId);
      const offSession = await executeToolCall('add_training_session', {
        week_id: weekId, plan_id: planId, day_of_week: 'Monday',
        session_type: 'strength', title: 'Legacy off session',
      }, testUserId);
      // The retired-tool refusal is unconditional; a rollout flag is not an
      // authorization mechanism and cannot resurrect these bypasses.
      expect(offWeek).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
      expect(offSession).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });

      delete process.env[modeKey];
      process.env[otherModeKey] = 'active';
      const otherScopeWeek = await executeToolCall('add_training_week', {
        plan_id: planId, week_number: 2,
      }, testUserId);
      expect(otherScopeWeek).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_weeks').get())
        .toEqual({ count: 1 });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_sessions').get())
        .toEqual({ count: 0 });
    } finally {
      if (priorMode === undefined) delete process.env[modeKey];
      else process.env[modeKey] = priorMode;
      if (priorOtherMode === undefined) delete process.env[otherModeKey];
      else process.env[otherModeKey] = priorOtherMode;
    }
  });

  it('keeps exercise normalization at the persistence boundary after retiring raw model writers', async () => {
    const priorMode = process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE;
    process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE = 'active';
    try {
      const planId = seedPlan();
      const weekId = seedWeek(planId);
      // The old test exercised normalization through add/update model tools.
      // Those tools are now unconditionally retired; normalization remains a
      // service invariant for reviewed REST/kernel persistence callers.
      const created = trainingPlans.createSession({
        week_id: weekId, plan_id: planId, day_of_week: 'Monday',
        session_type: 'strength', title: 'Canonical session',
        exercises_json: JSON.stringify([{ name: 'Tempo Split Squat', sets: 3, reps: 10 }]),
      });

      expect(JSON.parse((testDb.prepare('SELECT exercises_json FROM training_sessions WHERE id = ?')
        .get(created.id) as { exercises_json: string }).exercises_json)).toEqual([{
        name: 'Split Squat',
        sets: 3,
        reps: 10,
        exerciseId: 'split_squat',
        tempo: '3-1-1-0',
      }]);

      const updated = trainingPlans.updateSession(created.id, {
        exercises_json: JSON.stringify([{ name: 'Band Face Pull', sets: 2, reps: 15 }]),
      });
      expect(updated).toBe(true);
      expect(JSON.parse((testDb.prepare('SELECT exercises_json FROM training_sessions WHERE id = ?')
        .get(created.id) as { exercises_json: string }).exercises_json)).toEqual([{
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
    const planId = seedPlan();
    seedWeek(planId);
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

    // Current-dated: `get_training_plan` resolves sessions relative to today,
    // so the fixture plan must span now.
    const planId = seedPlan('Plan', today, endDate.toISOString().slice(0, 10));
    const weekId = seedWeek(planId);
    seedSession(planId, weekId, 'Push Day');

    const result = await executeToolCall('get_training_plan', { plan_id: planId }, testUserId);
    expect(result.plan.name).toBe('Plan');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].title).toBe('Push Day');
  });

  it('get_training_plan returns error when not found', async () => {
    const result = await executeToolCall('get_training_plan', { plan_id: 999 }, testUserId);
    expect(result.error).toBeTruthy();
  });

  it('log_training_completion logs and returns completion', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId, 'Test');

    const result = await executeToolCall('log_training_completion', {
      session_id: sessionId, rpe_overall: 7, energy_level: 8,
      soreness_level: 3, notes: 'Felt great',
    }, testUserId);
    expect(result.success).toBe(true);
    expect(result.completion_id).toBe(1);
  });

  it('log_training_completion returns error for invalid session', async () => {
    const result = await executeToolCall('log_training_completion', { session_id: 999 });
    expect(result.error).toBeTruthy();
  });

  it('update_training_session no longer updates raw session fields', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId, 'Original');

    const result = await executeToolCall('update_training_session', {
      session_id: sessionId, title: 'Updated', intensity_text: 'RPE 9',
    }, testUserId);
    // Stronger F13 guarantee: status/content changes go through reviewed
    // domain actions, never this raw model tool.
    expect(result).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
    expect(testDb.prepare('SELECT title, intensity_text FROM training_sessions WHERE id = ?')
      .get(sessionId)).toEqual({ title: 'Original', intensity_text: null });
  });

  it('link_session_calendar links session to calendar event', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId, 'Test');

    const result = await executeToolCall('link_session_calendar', {
      session_id: sessionId, calendar_event_id: 'AAMk456', calendar_source: 'outlook',
    }, testUserId);
    expect(result.success).toBe(true);
  });

  it('keeps completion/link behavior while raw content updates stay retired', async () => {
    const planId = seedPlan();
    const weekId = seedWeek(planId);
    const sessionId = seedSession(planId, weekId, 'Original');

    const modeKey = `TRAINING_PLAN_REVISION_V1_MODE_USER_${testUserId}`;
    process.env[modeKey] = 'active';
    try {
      const legacyUpdate = await executeToolCall('update_training_session', {
        session_id: sessionId, title: 'Must remain original',
      }, testUserId);
      const legacyLink = await executeToolCall('link_session_calendar', {
        session_id: sessionId, calendar_event_id: 'legacy-event', calendar_source: 'google',
      }, testUserId);
      expect(legacyUpdate).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
      expect(legacyLink.success).toBe(true);

      testDb.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-1' WHERE id = ?").run(planId);
      const blockedUpdate = await executeToolCall('update_training_session', {
        session_id: sessionId, title: 'Forbidden rewrite',
      }, testUserId);
      const blockedStatusOnly = await executeToolCall('update_training_session', {
        session_id: sessionId, status: 'completed',
      }, testUserId);
      const blockedLink = await executeToolCall('link_session_calendar', {
        session_id: sessionId, calendar_event_id: 'forbidden-event', calendar_source: 'outlook',
      }, testUserId);

      for (const result of [blockedUpdate, blockedStatusOnly]) {
        expect(result).toMatchObject({ success: false, code: 'TRAINING_RAW_WRITER_DISABLED' });
      }
      expect(blockedLink).toMatchObject({
        success: false,
        code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
      });
      expect(testDb.prepare(`
        SELECT title, status, calendar_event_id AS calendarEventId, calendar_source AS calendarSource
          FROM training_sessions WHERE id = ?
      `).get(sessionId)).toEqual({
        title: 'Original',
        status: 'pending',
        calendarEventId: 'legacy-event',
        calendarSource: 'google',
      });

      const completion = await executeToolCall('log_training_completion', {
        session_id: sessionId, rpe_overall: 7,
      }, testUserId);
      expect(completion.success).toBe(true);
      expect(testDb.prepare('SELECT status FROM training_sessions WHERE id = ?').get(sessionId))
        .toEqual({ status: 'completed' });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_completions WHERE session_id = ?').get(sessionId))
        .toEqual({ count: 1 });
    } finally {
      delete process.env[modeKey];
    }
  });
});
