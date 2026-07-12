/**
 * Tests for training plan tool handlers in tool-executor.ts
 *
 * Verifies that tool executor correctly dispatches training plan
 * operations and returns expected response shapes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { listCanonicalMigrationFiles } from '../utils/migrations';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const files = listCanonicalMigrationFiles(fs.readdirSync(MIGRATIONS_DIR));
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
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
  testDb = createTestDb();
  applyMigrations(testDb);
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
