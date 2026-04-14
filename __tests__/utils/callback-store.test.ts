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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { __resetCallbackCacheForTests, getCallback, storeCallback } from '../../src/utils/callback-store';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // These tests only need callback_entries from the lightweight migrations.
      }
    }
  }
}

describe('callback-store persistence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
    __resetCallbackCacheForTests();
  });

  afterEach(() => {
    __resetCallbackCacheForTests();
    testDb?.close();
  });

  it('reloads persisted callbacks after the in-memory cache is cleared', () => {
    const ref = storeCallback({ recommendationIds: ['evt-1'] }, 300_000);

    __resetCallbackCacheForTests();

    expect(getCallback(ref)).toEqual({ recommendationIds: ['evt-1'] });
  });

  it('drops expired callbacks from persistent storage', () => {
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const ref = storeCallback({ taskId: 'task-1' }, 1_000);

    __resetCallbackCacheForTests();
    nowSpy.mockReturnValue(baseNow + 5_000);

    expect(getCallback(ref)).toBeNull();

    const remaining = testDb.prepare('SELECT COUNT(*) as count FROM callback_entries WHERE ref = ?').get(ref) as { count: number };
    expect(remaining.count).toBe(0);

    nowSpy.mockRestore();
  });
});
