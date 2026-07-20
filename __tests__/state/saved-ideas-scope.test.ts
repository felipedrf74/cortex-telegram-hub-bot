import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  getDb: () => testDb,
  initDatabase: vi.fn(() => testDb),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  deleteIdea,
  getSavedIdeas,
  markIdeaPromoted,
  markIdeaUsed,
  saveIdea,
} from '../../src/state/saved-ideas';

function seedSchema(): void {
  testDb.exec(`
    CREATE TABLE saved_ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'saved',
      source TEXT NOT NULL DEFAULT 'manual',
      score REAL NOT NULL DEFAULT 0,
      workflow_eligible INTEGER NOT NULL DEFAULT 0,
      angle_tag TEXT,
      niche TEXT,
      hook_idea TEXT,
      why_now TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('saved ideas user scoping', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    seedSchema();
  });

  afterEach(() => {
    testDb.close();
  });

  it('rejects the legacy two-argument save path instead of writing user_id=0', () => {
    expect(() => (saveIdea as any)('Global leak', '2026-05-07')).toThrow(/userId required/i);
    const rows = testDb.prepare('SELECT * FROM saved_ideas').all();
    expect(rows).toHaveLength(0);
  });

  it('requires a positive userId for new saves and scoped reads', () => {
    for (const invalidUserId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => saveIdea({ title: 'No owner', sourceDate: '2026-05-07', userId: invalidUserId })).toThrow(/positive integer/i);
      expect(() => getSavedIdeas('saved', invalidUserId)).toThrow(/positive integer/i);
    }
  });

  it('keeps the compatibility archive readable by owner but freezes every mutation', () => {
    testDb.prepare(`
      INSERT INTO saved_ideas (title, source_date, user_id)
      VALUES ('A idea', '2026-05-07', 101), ('B idea', '2026-05-07', 202)
    `).run();
    const userA = getSavedIdeas('saved', 101)[0];
    const userB = getSavedIdeas('saved', 202)[0];

    for (const mutation of [
      () => saveIdea({ title: 'New orphan', sourceDate: '2026-05-07', userId: 101 }),
      () => markIdeaPromoted(userA.id, 101),
      () => markIdeaUsed(userB.id, 202),
      () => deleteIdea(userB.id, 202),
    ]) {
      expect(mutation).toThrow(/read-only compatibility archive.*Content workspace/i);
    }
    expect(testDb.prepare('SELECT id, status FROM saved_ideas ORDER BY id').all()).toEqual([
      { id: userA.id, status: 'saved' },
      { id: userB.id, status: 'saved' },
    ]);
  });
});
