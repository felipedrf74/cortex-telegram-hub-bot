import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockWarn = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    fatal: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

describe('cache-store api_cache safety valve', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWarn.mockReset();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE api_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_api_cache_expires_key ON api_cache(expires_at, cache_key);
      CREATE TABLE error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        context TEXT,
        alerted INTEGER DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    testDb.close();
  });

  it('limits one expired-row sweep to 10K rows and writes a warning when backlog remains', async () => {
    const insert = testDb.prepare('INSERT INTO api_cache (cache_key, value_json, expires_at) VALUES (?, ?, ?)');
    const expiredAt = '2020-01-01T00:00:00.000Z';
    const tx = testDb.transaction(() => {
      for (let index = 0; index < 50_000; index += 1) {
        insert.run(`expired:${index}`, '{"ok":true}', expiredAt);
      }
    });
    tx();

    const { clearExpired, getCacheStoreStats } = await import('../../src/services/cache-store');
    clearExpired();

    const remaining = testDb.prepare('SELECT COUNT(*) as count FROM api_cache').get() as { count: number };
    const warning = testDb.prepare('SELECT message, context FROM error_log WHERE source = ?').get('job') as
      | { message: string; context: string }
      | undefined;

    expect(remaining.count).toBe(40_000);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ cleared: 10_000, batchSize: 10_000 }),
      'api_cache expiry cleanup safety valve fired',
    );
    expect(warning?.message).toBe('api_cache expiry cleanup safety valve fired');
    expect(JSON.parse(warning?.context ?? '{}')).toMatchObject({ cleared: 10_000, batchSize: 10_000 });
    expect(getCacheStoreStats()).toMatchObject({
      expireSweepCount: 1,
      expiredEntriesCleared: 10_000,
    });
  });
});
