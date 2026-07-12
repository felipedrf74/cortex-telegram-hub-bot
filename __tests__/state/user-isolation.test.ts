/**
 * Per-User Data Isolation Tests
 *
 * Verifies that user A's data is never visible to user B.
 * Uses real SQLite (in-memory) to test actual query isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
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
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/date-parser', () => ({
  now: vi.fn().mockReturnValue({
    toFormat: vi.fn().mockReturnValue('2026-04-03'),
    setZone: vi.fn((zone: string) => ({
      toFormat: vi.fn().mockReturnValue(zone === 'America/New_York' ? '2026-04-02' : '2026-04-03'),
    })),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-04-02') }),
    toISO: vi.fn().mockReturnValue('2026-04-03T12:00:00.000+01:00'),
  }),
  formatDateTime: vi.fn((d: string) => d),
}));

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  addToConversation, getConversationHistory, getLastAssistantMessage,
  clearConversation, clearAllConversations,
} from '../../src/state/conversation';
import { createTodo, listTodos } from '../../src/state/todos';
import { setReminder, getActiveReminders, getRemindersForToday, getRemindersForWindow, markReminderFired } from '../../src/state/reminders';
import { setSharedMemory, getSharedMemory, getSharedMemorySummary } from '../../src/state/shared-memory';
import { saveNote, searchNotes } from '../../src/state/notes';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

const USER_A = 111111;
const USER_B = 222222;
const SAME_USER = 333333;
const TENANT_A = 444444;
const TENANT_B = 555555;

describe('Per-user data isolation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('conversations', () => {
    it('user A conversations are not visible to user B', () => {
      addToConversation(USER_A, 'secretary', 'user', 'Hello from A');
      addToConversation(USER_B, 'secretary', 'user', 'Hello from B');

      const histA = getConversationHistory(USER_A, 'secretary');
      const histB = getConversationHistory(USER_B, 'secretary');

      expect(histA).toHaveLength(1);
      expect(histA[0].content).toBe('Hello from A');
      expect(histB).toHaveLength(1);
      expect(histB[0].content).toBe('Hello from B');
    });

    it('clearConversation for user A does not affect user B', () => {
      addToConversation(USER_A, 'secretary', 'user', 'A msg');
      addToConversation(USER_B, 'secretary', 'user', 'B msg');

      clearConversation(USER_A, 'secretary');

      expect(getConversationHistory(USER_A, 'secretary')).toHaveLength(0);
      expect(getConversationHistory(USER_B, 'secretary')).toHaveLength(1);
    });

    it('clearAllConversations for user A does not affect user B', () => {
      addToConversation(USER_A, 'secretary', 'user', 'A sec');
      addToConversation(USER_A, 'triathlon', 'user', 'A tri');
      addToConversation(USER_B, 'secretary', 'user', 'B sec');

      clearAllConversations(USER_A);

      expect(getConversationHistory(USER_A, 'secretary')).toHaveLength(0);
      expect(getConversationHistory(USER_A, 'triathlon')).toHaveLength(0);
      expect(getConversationHistory(USER_B, 'secretary')).toHaveLength(1);
    });

    it('getLastAssistantMessage is user-scoped', () => {
      addToConversation(USER_A, 'secretary', 'assistant', 'A reply');
      addToConversation(USER_B, 'secretary', 'assistant', 'B reply');

      expect(getLastAssistantMessage(USER_A, 'secretary')).toBe('A reply');
      expect(getLastAssistantMessage(USER_B, 'secretary')).toBe('B reply');
    });

    it('same user conversation context is isolated by explicit tenant scope', () => {
      addToConversation(SAME_USER, 'secretary', 'assistant', 'Tenant A reply', TENANT_A);
      addToConversation(SAME_USER, 'secretary', 'assistant', 'Tenant B reply', TENANT_B);

      expect(getConversationHistory(SAME_USER, 'secretary', TENANT_A)).toHaveLength(1);
      expect(getConversationHistory(SAME_USER, 'secretary', TENANT_A)[0].content).toBe('Tenant A reply');
      expect(getConversationHistory(SAME_USER, 'secretary', TENANT_B)).toHaveLength(1);
      expect(getConversationHistory(SAME_USER, 'secretary', TENANT_B)[0].content).toBe('Tenant B reply');
      expect(getLastAssistantMessage(SAME_USER, 'secretary', TENANT_A)).toBe('Tenant A reply');
      expect(getLastAssistantMessage(SAME_USER, 'secretary', TENANT_B)).toBe('Tenant B reply');
    });
  });

  describe('todos', () => {
    it('user A todos are not visible to user B', () => {
      createTodo(USER_A, { title: 'A task' });
      createTodo(USER_B, { title: 'B task' });

      const todosA = listTodos(USER_A);
      const todosB = listTodos(USER_B);

      expect(todosA).toHaveLength(1);
      expect(todosA[0].title).toBe('A task');
      expect(todosB).toHaveLength(1);
      expect(todosB[0].title).toBe('B task');
    });
  });

  describe('reminders', () => {
    it('user A reminders are not visible to user B', () => {
      setReminder(USER_A, { message: 'A reminder', remind_at: '2026-04-03T15:00:00' });
      setReminder(USER_B, { message: 'B reminder', remind_at: '2026-04-03T16:00:00' });

      const remA = getActiveReminders(USER_A);
      const remB = getActiveReminders(USER_B);

      expect(remA).toHaveLength(1);
      expect(remA[0].message).toBe('A reminder');
      expect(remB).toHaveLength(1);
      expect(remB[0].message).toBe('B reminder');
    });

    it('getRemindersForToday is user-scoped', () => {
      setReminder(USER_A, { message: 'A today', remind_at: '2026-04-03T10:00:00' });
      setReminder(USER_B, { message: 'B today', remind_at: '2026-04-03T11:00:00' });

      const todayA = getRemindersForToday(USER_A);
      const todayB = getRemindersForToday(USER_B);

      expect(todayA).toHaveLength(1);
      expect(todayA[0].message).toBe('A today');
      expect(todayB).toHaveLength(1);
      expect(todayB[0].message).toBe('B today');
    });

    it('getRemindersForToday uses each reminder timezone for the local day', () => {
      setReminder(USER_A, {
        message: 'NY local today',
        remind_at: '2026-04-02T20:00:00-04:00',
        timezone: 'America/New_York',
      });
      setReminder(USER_A, {
        message: 'Lisbon today',
        remind_at: '2026-04-03T10:00:00+01:00',
        timezone: 'Europe/Lisbon',
      });

      const today = getRemindersForToday(USER_A, undefined, 'Europe/Lisbon');

      expect(today.map((reminder) => reminder.message)).toEqual([
        'NY local today',
        'Lisbon today',
      ]);
    });

    it('getRemindersForWindow is tenant/user scoped and honors a future absolute window', () => {
      setReminder(SAME_USER, {
        message: 'Tenant A tomorrow',
        remind_at: '2026-04-04T10:00:00+01:00',
      }, { tenantId: TENANT_A, timezone: 'Europe/Lisbon' });
      setReminder(SAME_USER, {
        message: 'Tenant B tomorrow',
        remind_at: '2026-04-04T11:00:00+01:00',
      }, { tenantId: TENANT_B, timezone: 'Europe/Lisbon' });

      const tenantA = getRemindersForWindow(
        SAME_USER,
        TENANT_A,
        '2026-04-03T23:00:00.000Z',
        '2026-04-04T22:59:59.999Z',
        'Europe/Lisbon',
      );

      expect(tenantA.map((reminder) => reminder.message)).toEqual(['Tenant A tomorrow']);
    });

    it('same-user reminders are isolated by tenant', () => {
      setReminder(SAME_USER, {
        message: 'Tenant A reminder',
        remind_at: '2026-04-03T10:00:00',
      }, { tenantId: TENANT_A });
      setReminder(SAME_USER, {
        message: 'Tenant B reminder',
        remind_at: '2026-04-03T11:00:00',
      }, { tenantId: TENANT_B });

      expect(getActiveReminders(SAME_USER, TENANT_A).map((reminder) => reminder.message)).toEqual([
        'Tenant A reminder',
      ]);
      expect(getActiveReminders(SAME_USER, TENANT_B).map((reminder) => reminder.message)).toEqual([
        'Tenant B reminder',
      ]);
    });

    it('markReminderFired updates only the owning tenant reminder row', () => {
      const tenantAReminder = setReminder(SAME_USER, {
        message: 'Tenant A one-shot',
        remind_at: '2026-04-03T10:00:00',
      }, { tenantId: TENANT_A });
      setReminder(SAME_USER, {
        message: 'Tenant B still active',
        remind_at: '2026-04-03T11:00:00',
      }, { tenantId: TENANT_B });

      markReminderFired(tenantAReminder.id);

      expect(getActiveReminders(SAME_USER, TENANT_A)).toHaveLength(0);
      expect(getActiveReminders(SAME_USER, TENANT_B).map((reminder) => reminder.message)).toEqual([
        'Tenant B still active',
      ]);
    });

    it('recurs daily reminders in the reminder timezone across Lisbon DST', () => {
      const reminder = setReminder(USER_A, {
        message: 'Daily local reminder',
        remind_at: '2026-03-29T00:30:00',
        recurring: 'daily',
        timezone: 'Europe/Lisbon',
      }, { timezone: 'Europe/Lisbon' });

      markReminderFired(reminder.id);

      const [next] = getActiveReminders(USER_A);
      const nextLocal = DateTime.fromISO(next.remind_at, { setZone: true }).setZone('Europe/Lisbon');
      expect(nextLocal.toFormat('yyyy-LL-dd HH:mm')).toBe('2026-03-30 00:30');
      expect(nextLocal.offset).toBe(60);
    });
  });

  describe('shared memory', () => {
    it('user A shared memory with unique keys is isolated from user B', () => {
      // Use different keys per user to avoid UNIQUE(key) collision
      // TODO: Future migration should change UNIQUE(key) to UNIQUE(user_id, key)
      setSharedMemory(USER_A, 'a_marathon_date', '2026-10-01', 'triathlon');
      setSharedMemory(USER_B, 'b_marathon_date', '2026-11-15', 'triathlon');

      const memA = getSharedMemory(USER_A, 'a_marathon_date');
      const memB = getSharedMemory(USER_B, 'b_marathon_date');

      expect(memA).toHaveLength(1);
      expect(memA[0].value).toBe('2026-10-01');
      expect(memB).toHaveLength(1);
      expect(memB[0].value).toBe('2026-11-15');
    });

    it('getSharedMemorySummary is user-scoped', () => {
      setSharedMemory(USER_A, 'key_a', 'value_a', 'secretary');
      // USER_B gets nothing
      const summaryB = getSharedMemorySummary(USER_B);
      expect(summaryB).toBe('');
    });

    it('same user shared memory can store the same key independently per tenant', () => {
      setSharedMemory(SAME_USER, 'planning_style', 'protect mornings', 'secretary', undefined, TENANT_A);
      setSharedMemory(SAME_USER, 'planning_style', 'flexible afternoons', 'secretary', undefined, TENANT_B);

      expect(getSharedMemory(SAME_USER, 'planning_style', TENANT_A)[0].value).toBe('protect mornings');
      expect(getSharedMemory(SAME_USER, 'planning_style', TENANT_B)[0].value).toBe('flexible afternoons');
      expect(getSharedMemorySummary(SAME_USER, TENANT_A)).toContain('protect mornings');
      expect(getSharedMemorySummary(SAME_USER, TENANT_B)).toContain('flexible afternoons');
    });
  });

  describe('notes', () => {
    it('user A notes are not visible to user B', () => {
      saveNote(USER_A, { content: 'A note' });
      saveNote(USER_B, { content: 'B note' });

      const notesA = searchNotes(USER_A);
      const notesB = searchNotes(USER_B);

      expect(notesA).toHaveLength(1);
      expect(notesA[0].content).toBe('A note');
      expect(notesB).toHaveLength(1);
      expect(notesB[0].content).toBe('B note');
    });
  });

  describe('backward compatibility', () => {
    it('ambiguous user_id=0 conversation data is not exposed as active chat context', () => {
      addToConversation(0, 'secretary', 'user', 'legacy message');
      const hist = getConversationHistory(0, 'secretary');
      expect(hist).toHaveLength(0);
    });
  });

  // ── Invoice isolation ──────────────────────────────────────────
  describe('invoice_vendors isolation', () => {
    it('user A vendor not visible to user B', () => {
      testDb.prepare(
        'INSERT INTO invoice_vendors (name, sender_pattern, user_id) VALUES (?, ?, ?)'
      ).run('VendorA', 'a@example.com', USER_A);
      testDb.prepare(
        'INSERT INTO invoice_vendors (name, sender_pattern, user_id) VALUES (?, ?, ?)'
      ).run('VendorB', 'b@example.com', USER_B);

      const vendorsA = testDb.prepare(
        'SELECT * FROM invoice_vendors WHERE user_id IN (0, ?)'
      ).all(USER_A);
      const vendorsB = testDb.prepare(
        'SELECT * FROM invoice_vendors WHERE user_id IN (0, ?)'
      ).all(USER_B);

      expect(vendorsA).toHaveLength(1);
      expect(vendorsB).toHaveLength(1);
      expect((vendorsA[0] as any).name).toBe('VendorA');
      expect((vendorsB[0] as any).name).toBe('VendorB');
    });
  });

  describe('invoice_filings isolation', () => {
    it('user A filing not visible to user B', () => {
      testDb.prepare(
        "INSERT INTO invoice_filings (vendor, source, status, user_id) VALUES (?, ?, ?, ?)"
      ).run('TestVendor', 'photo', 'filed', USER_A);

      const filingsA = testDb.prepare(
        'SELECT * FROM invoice_filings WHERE user_id = ?'
      ).all(USER_A);
      const filingsB = testDb.prepare(
        'SELECT * FROM invoice_filings WHERE user_id = ?'
      ).all(USER_B);

      expect(filingsA).toHaveLength(1);
      expect(filingsB).toHaveLength(0);
    });
  });

  // ── Content isolation ──────────────────────────────────────────
  describe('content_ref_channels isolation', () => {
    it('user A channel not visible to user B', () => {
      testDb.prepare(
        "INSERT INTO content_ref_channels (channel_url, status, user_id) VALUES (?, 'active', ?)"
      ).run('https://youtube.com/@channelA', USER_A);
      testDb.prepare(
        "INSERT INTO content_ref_channels (channel_url, status, user_id) VALUES (?, 'active', ?)"
      ).run('https://youtube.com/@channelB', USER_B);

      const chA = testDb.prepare(
        'SELECT * FROM content_ref_channels WHERE user_id IN (0, ?)'
      ).all(USER_A);
      const chB = testDb.prepare(
        'SELECT * FROM content_ref_channels WHERE user_id IN (0, ?)'
      ).all(USER_B);

      expect(chA).toHaveLength(1);
      expect(chB).toHaveLength(1);
      expect((chA[0] as any).channel_url).toContain('channelA');
      expect((chB[0] as any).channel_url).toContain('channelB');
    });

    it('same channel URL allowed for different users (composite uniqueness)', () => {
      testDb.prepare(
        "INSERT INTO content_ref_channels (channel_url, status, user_id) VALUES (?, 'active', ?)"
      ).run('https://youtube.com/@shared', USER_A);

      // Should NOT throw — different user_id makes it unique
      expect(() => {
        testDb.prepare(
          "INSERT INTO content_ref_channels (channel_url, status, user_id) VALUES (?, 'active', ?)"
        ).run('https://youtube.com/@shared', USER_B);
      }).not.toThrow();
    });
  });

  describe('book_library isolation', () => {
    it('user A book not visible to user B', () => {
      testDb.prepare(
        "INSERT INTO book_library (title, author, extraction_status, user_id) VALUES (?, ?, 'pending', ?)"
      ).run('Book A', 'Author A', USER_A);
      testDb.prepare(
        "INSERT INTO book_library (title, author, extraction_status, user_id) VALUES (?, ?, 'pending', ?)"
      ).run('Book B', 'Author B', USER_B);

      const booksA = testDb.prepare(
        'SELECT * FROM book_library WHERE user_id IN (0, ?)'
      ).all(USER_A);
      const booksB = testDb.prepare(
        'SELECT * FROM book_library WHERE user_id IN (0, ?)'
      ).all(USER_B);

      expect(booksA).toHaveLength(1);
      expect(booksB).toHaveLength(1);
    });
  });

  describe('saved_ideas isolation', () => {
    it('user A idea not visible to user B', () => {
      testDb.prepare(
        "INSERT INTO saved_ideas (title, source_date, user_id) VALUES (?, ?, ?)"
      ).run('Idea A', '2026-04-12', USER_A);
      testDb.prepare(
        "INSERT INTO saved_ideas (title, source_date, user_id) VALUES (?, ?, ?)"
      ).run('Idea B', '2026-04-12', USER_B);

      const ideasA = testDb.prepare(
        "SELECT * FROM saved_ideas WHERE user_id IN (0, ?) AND status = 'saved'"
      ).all(USER_A);
      const ideasB = testDb.prepare(
        "SELECT * FROM saved_ideas WHERE user_id IN (0, ?) AND status = 'saved'"
      ).all(USER_B);

      expect(ideasA).toHaveLength(1);
      expect(ideasB).toHaveLength(1);
      expect((ideasA[0] as any).title).toBe('Idea A');
      expect((ideasB[0] as any).title).toBe('Idea B');
    });
  });
});
