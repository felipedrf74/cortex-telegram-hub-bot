/**
 * R6 P1 — log_training_completion must NOT return success when the
 * outbox transaction was rolled back.
 *
 * Codex (R6) caught: the closure inside `runOutboxTransaction(...)`
 * assigned the outer `completion` variable BEFORE emit. If emit
 * threw, Better-SQLite3 rolled back the row write, but the outer JS
 * variable stayed truthy. The catch block then SKIPPED the fallback
 * write and returned `{ success: true, completion_id: <id of a row
 * that no longer exists> }`. The athlete's logged completion was
 * silently lost.
 *
 * The fix:
 *   - The closure returns the row; the outer variable is assigned
 *     from `runOutboxTransaction`'s return value, which only fires
 *     AFTER commit.
 *   - The catch explicitly resets `completion = undefined` as
 *     belt-and-braces against any future regression that
 *     re-introduces the closure-assignment pattern.
 *   - The catch then runs a non-transactional fallback write so the
 *     athlete's data survives even if the outbox emission failed.
 *
 * These tests pin the behavior:
 *   - Happy path → row persists, event row exists.
 *   - Emit throws → outbox rollback removes both writes, fallback
 *     re-attempts the completion write; reported `completion_id`
 *     resolves to an actual row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

// Mock peripheral services the tool-executor pulls in.
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

// R6 P1 — force the outbox emit to throw on demand.
let forceEmitThrow = false;
vi.mock('../../src/services/event-outbox', async () => {
  // Re-export the real module but wrap runOutboxTransaction so the
  // test can inject a throw inside the transaction callback.
  const actual = await vi.importActual<typeof import('../../src/services/event-outbox')>(
    '../../src/services/event-outbox',
  );
  return {
    ...actual,
    runOutboxTransaction: <T,>(operation: (emit: typeof actual.emitDomainEvent) => T): T => {
      return actual.runOutboxTransaction((emit) => {
        return operation((input) => {
          if (forceEmitThrow) {
            throw new Error('R6 P1 simulated emit failure (rollback expected)');
          }
          return emit(input);
        });
      });
    },
  };
});

import { executeToolCall as executeToolCallRaw } from '../../src/services/tool-executor';
import { runWithChatToolAuthorization } from '../../src/services/chat-tool-authorization';

let userId: number;

function executeToolCall(toolName: string, input: Record<string, any>): Promise<any> {
  return runWithChatToolAuthorization({
    userId,
    tenantId: userId,
    confirmedDestructiveAction: true,
    confirmationSource: 'explicit_current_turn',
  }, () => executeToolCallRaw(toolName, input, userId, userId)) as Promise<any>;
}

beforeEach(async () => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
  forceEmitThrow = false;
  // Seed a user row — `requireOwnedTrainingSessionForTool` looks up
  // through users/plans so we need a real owner before authorization.
  const userRow = testDb.prepare(`
    INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (321321, 'Test', 'pro', 'active', 200, 500000, 1)
  `).run();
  userId = Number(userRow.lastInsertRowid);
  // Seed a plan + week + session so log_training_completion has a target.
  await executeToolCall('create_training_plan', {
    name: 'Plan', sport: 'strength', duration_weeks: 4,
    start_date: '2026-05-01', end_date: '2026-05-28',
  });
  await executeToolCall('add_training_week', { plan_id: 1, week_number: 1 });
  await executeToolCall('add_training_session', {
    week_id: 1, plan_id: 1, day_of_week: 'Monday',
    session_type: 'strength', title: 'Test',
  });
});

afterEach(() => {
  testDb.close();
});

describe('R6 P1 — log_training_completion rollback safety', () => {
  it('happy path: transaction commits → row persists + event row exists', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      duration_minutes: 45,
    });
    expect(result.success).toBe(true);
    expect(result.completion_id).toBeGreaterThan(0);

    const completionRow = testDb.prepare(
      'SELECT id FROM training_completions WHERE id = ?',
    ).get(result.completion_id);
    expect(completionRow).toBeDefined();

    const eventRow = testDb.prepare(
      "SELECT COUNT(*) AS n FROM event_outbox WHERE event_type = 'training.feedback.recorded' AND entity_id = ?",
    ).get('1') as { n: number };
    expect(eventRow.n).toBe(1);
  });

  it('rollback path: emit throws → completion row is rolled back AND fallback re-persists', async () => {
    forceEmitThrow = true;
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 6,
      duration_minutes: 40,
    });

    // R6 P1 invariant — must NOT return success referencing a
    // rolled-back row. The fix is to re-persist via the fallback.
    expect(result.success).toBe(true);
    expect(result.completion_id).toBeGreaterThan(0);

    // The completion_id reported on the response MUST resolve to a
    // real row. Pre-R6 fix: this row didn't exist (transaction was
    // rolled back and no fallback fired).
    const completionRow = testDb.prepare(
      'SELECT id FROM training_completions WHERE id = ?',
    ).get(result.completion_id);
    expect(completionRow).toBeDefined();

    // Event row should NOT exist — the transaction was rolled back.
    // The fallback explicitly doesn't re-emit (the outbox is the
    // event source of truth; losing the event is preferred over
    // losing the user's completion data).
    const eventRow = testDb.prepare(
      "SELECT COUNT(*) AS n FROM event_outbox WHERE event_type = 'training.feedback.recorded' AND entity_id = ?",
    ).get('1') as { n: number };
    expect(eventRow.n).toBe(0);
  });

  // R6 P3 — tool path now rejects non-boolean external_training_declared
  // with the same error shape REST does. Codex caught wrong-typed
  // values silently coercing to false via `=== true` at the
  // tool-input boundary.
  it('R6 P3 — rejects non-boolean external_training_declared', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      external_training_declared: 'yes',
    });
    expect(result.error).toBeTruthy();
    expect(String(result.error)).toMatch(/external_training_declared must be a boolean/);
  });

  it('R6 P3 — rejects external_training_declared: 1 (numeric truthy)', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      external_training_declared: 1,
    });
    expect(result.error).toBeTruthy();
  });

  it('R6 P3 — accepts external_training_declared: true', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      external_training_declared: true,
    });
    expect(result.success).toBe(true);
    const row = testDb.prepare(
      'SELECT external_training_declared FROM training_completions WHERE id = ?',
    ).get(result.completion_id) as { external_training_declared: number };
    expect(row.external_training_declared).toBe(1);
  });

  it('R6 P3 — accepts external_training_declared omitted (treat as undefined)', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
    });
    expect(result.success).toBe(true);
  });

  // R7 P2/P3 — Codex caught that the R6 helper silently treated
  // null as omitted (returned undefined). The R7 contract is
  // reject-on-non-boolean including explicit null. Only `undefined`
  // (key absent from the tool input) is omitted.
  it('R7 P2/P3 — rejects explicit external_training_declared: null', async () => {
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      external_training_declared: null,
    });
    expect(result.error).toBeTruthy();
    expect(String(result.error)).toMatch(/external_training_declared must be a boolean/);
  });

  it('R7 P2/P3 — accepts explicit external_training_declared: false', async () => {
    // The fix must NOT regress the false case — false is a valid
    // boolean payload meaning "athlete explicitly declared no
    // external training."
    const result = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      external_training_declared: false,
    });
    expect(result.success).toBe(true);
    const row = testDb.prepare(
      'SELECT external_training_declared FROM training_completions WHERE id = ?',
    ).get(result.completion_id) as { external_training_declared: number };
    expect(row.external_training_declared).toBe(0);
  });

  it('rollback path: a second attempt (with throw still active) still succeeds via fallback', async () => {
    forceEmitThrow = true;
    const r1 = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 6,
      duration_minutes: 40,
    });
    const r2 = await executeToolCall('log_training_completion', {
      session_id: 1,
      rpe_overall: 7,
      duration_minutes: 35,
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.completion_id).not.toBe(r2.completion_id);
    // Both fallback rows present.
    const both = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_completions WHERE session_id = 1',
    ).get() as { n: number };
    expect(both.n).toBe(2);
  });
});
