import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));


import {
  addChannel,
  getAllChannels,
  getAllKnowledge,
  getKnowledgeByCategory,
  upsertKnowledge,
} from '../../src/state/content-references';

describe('content ownership scope', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb?.close());

  it('preserves explicit system rows but prefers user channels over the same system URL', () => {
    testDb.prepare(`
      INSERT INTO content_ref_channels (channel_url, channel_name, status, user_id, owner_scope)
      VALUES (?, ?, 'active', 0, 'system')
    `).run('https://youtube.com/@shared', 'System Channel');

    addChannel('https://youtube.com/@shared', 'manual', 42);

    const rows = getAllChannels(42);

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_url).toBe('https://youtube.com/@shared');
    expect(rows[0].user_id).toBe(42);
    expect(rows[0].owner_scope).toBe('user');
  });

  it('prefers user voice DNA over the same system category', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, owner_scope, version)
      VALUES ('brand_voice', 'System voice', '["system"]', 0, 'system', 1)
    `).run();

    upsertKnowledge('brand_voice', 'User voice', ['@user'], 42);

    const selected = getKnowledgeByCategory('brand_voice', 42);
    const allForUser = getAllKnowledge(42);

    expect(selected?.synthesized_text).toBe('User voice');
    expect(allForUser).toHaveLength(1);
    expect(allForUser[0].synthesized_text).toBe('User voice');
    expect(allForUser[0].user_id).toBe(42);
    expect(allForUser[0].owner_scope).toBe('user');
  });
});
