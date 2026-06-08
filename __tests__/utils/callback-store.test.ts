import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
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
  LOGGER_REDACTION_PATHS: [],
}));

import {
  __resetCallbackCacheForTests,
  consumeCallbackForScope,
  getCallback,
  getCallbackForScope,
  storeCallback,
  storeCallbackForScope,
} from '../../src/utils/callback-store';
import { logger } from '../../src/utils/logger';

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

  it('returns scoped callbacks only for the matching tenant and user', () => {
    const ref = storeCallbackForScope(
      { taskId: 'task-1' },
      { tenantId: 42, userId: 42, actionType: 'todo_task_complete' },
      300_000,
    );

    __resetCallbackCacheForTests();

    expect(getCallbackForScope(ref, { tenantId: 42, userId: 42 })).toEqual({ taskId: 'task-1' });
    expect(getCallbackForScope(ref, { tenantId: 43, userId: 42 })).toBeNull();
    expect(getCallbackForScope(ref, { tenantId: 42, userId: 43 })).toBeNull();
  });

  it('does not expose scoped callbacks through the legacy global lookup', () => {
    const ref = storeCallbackForScope(
      { recommendationIds: ['evt-1'] },
      { tenantId: 42, userId: 42, actionType: 'coach_recommendation_apply' },
      300_000,
    );

    expect(getCallback(ref)).toBeNull();
    expect(getCallbackForScope(ref, { tenantId: 42, userId: 42 })).toEqual({ recommendationIds: ['evt-1'] });
  });

  it('quarantines ambiguous legacy rows from scoped lookup while preserving legacy callers', () => {
    const ref = storeCallback({ taskId: 'legacy-task' }, 300_000);

    __resetCallbackCacheForTests();

    expect(getCallback(ref)).toEqual({ taskId: 'legacy-task' });
    expect(getCallbackForScope(ref, { tenantId: 42, userId: 42 })).toBeNull();
  });

  it('consumes scoped callbacks after one destructive use', () => {
    const ref = storeCallbackForScope(
      { taskId: 'task-1' },
      { tenantId: 42, userId: 42, actionType: 'todo_task_delete' },
      300_000,
    );

    expect(consumeCallbackForScope(ref, { tenantId: 42, userId: 42 })).toBe(true);
    expect(consumeCallbackForScope(ref, { tenantId: 42, userId: 42 })).toBe(false);
    expect(getCallbackForScope(ref, { tenantId: 42, userId: 42 })).toBeNull();
  });

  it('fails closed when consuming scoped callbacks against a legacy unscoped table', () => {
    const ref = storeCallbackForScope(
      { taskId: 'task-legacy-schema' },
      { tenantId: 42, userId: 42, actionType: 'todo_task_delete' },
      300_000,
    );
    testDb.exec(`
      ALTER TABLE callback_entries RENAME TO callback_entries_scoped;
      CREATE TABLE callback_entries (
        ref TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO callback_entries (ref, data_json, created_at_ms, expires_at_ms, updated_at)
      SELECT ref, data_json, created_at_ms, expires_at_ms, updated_at
      FROM callback_entries_scoped;
      DROP TABLE callback_entries_scoped;
    `);

    expect(consumeCallbackForScope(ref, { tenantId: 42, userId: 42 })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ref, userId: 42, tenantId: 42 }),
      'Failed closed while consuming scoped callback without persistent scope columns',
    );
  });
});
