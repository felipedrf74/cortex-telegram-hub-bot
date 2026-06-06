import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: vi.fn(),
}));

import {
  addToConversation,
  clearAllConversations,
  clearConversation,
  getConversationHistory,
  getLastAssistantMessage,
  markConversationLifecycle,
} from '../../src/state/conversation';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Optional migration dependencies are ignored in focused state tests.
      }
    }
  }
}

describe('state/conversation isolation contract', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('refuses reads and writes without persisting rows', () => {
      addToConversation(userId as number, 'secretary', 'user', 'unsafe');

      expect(getConversationHistory(userId as number, 'secretary')).toEqual([]);
      expect(getLastAssistantMessage(userId as number, 'secretary')).toBeNull();
      expect(markConversationLifecycle(userId as number, 'secretary', 'archived')).toBe(false);
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toMatchObject({ count: 0 });
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips in its own scope', () => {
      addToConversation(userId, 'secretary', 'assistant', `reply-${userId}`);

      expect(getConversationHistory(userId, 'secretary')).toEqual([{ role: 'assistant', content: `reply-${userId}` }]);
      expect(getLastAssistantMessage(userId, 'secretary')).toBe(`reply-${userId}`);
    });
  });

  it('user A cannot read user B rows', () => {
    addToConversation(1, 'secretary', 'user', 'A message');
    addToConversation(2, 'secretary', 'user', 'B message');

    expect(getConversationHistory(1, 'secretary')[0].content).toBe('A message');
    expect(getConversationHistory(2, 'secretary')[0].content).toBe('B message');
  });

  it('same user tenant scopes stay isolated', () => {
    addToConversation(7, 'secretary', 'assistant', 'Tenant A reply', 70);
    addToConversation(7, 'secretary', 'assistant', 'Tenant B reply', 71);

    expect(getLastAssistantMessage(7, 'secretary', 70)).toBe('Tenant A reply');
    expect(getLastAssistantMessage(7, 'secretary', 71)).toBe('Tenant B reply');
  });

  it('clearConversation and clearAllConversations do not cross user scope', () => {
    addToConversation(1, 'secretary', 'user', 'A secretary');
    addToConversation(1, 'content', 'user', 'A content');
    addToConversation(2, 'secretary', 'user', 'B secretary');

    clearConversation(1, 'secretary');
    expect(getConversationHistory(1, 'secretary')).toEqual([]);
    expect(getConversationHistory(1, 'content')).toHaveLength(1);
    expect(getConversationHistory(2, 'secretary')).toHaveLength(1);

    clearAllConversations(1);
    expect(getConversationHistory(1, 'content')).toEqual([]);
    expect(getConversationHistory(2, 'secretary')).toHaveLength(1);
  });
});
