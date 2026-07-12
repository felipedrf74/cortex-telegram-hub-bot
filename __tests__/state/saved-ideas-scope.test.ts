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

  it('scopes mark-used/promote/delete mutations by user id', () => {
    const userA = saveIdea({ title: 'A idea', sourceDate: '2026-05-07', userId: 101 });
    const userB = saveIdea({ title: 'B idea', sourceDate: '2026-05-07', userId: 202 });

    expect(markIdeaPromoted(userA.id, 202)).toBe(false);
    expect(markIdeaPromoted(userA.id, 101)).toBe(true);
    expect(markIdeaUsed(userB.id, 101)).toBe(false);
    expect(markIdeaUsed(userB.id, 202)).toBe(true);
    expect(deleteIdea(userB.id, 101)).toBe(false);

    const a = testDb.prepare('SELECT status FROM saved_ideas WHERE id = ?').get(userA.id) as { status: string };
    const b = testDb.prepare('SELECT status FROM saved_ideas WHERE id = ?').get(userB.id) as { status: string };
    expect(a.status).toBe('promoted');
    expect(b.status).toBe('used');
  });
});
