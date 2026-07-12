/**
 * BE-2/BE-3 (Content Studio, 2026-06-10): topic creation provenance +
 * idempotent-replay lookup against a real migrated database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import { addTopic, findTopicByClientRequestId } from '../../src/services/content-scheduler';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch (err) { /* skip */ }
    }
  }
}

const USER = 4101;

describe('content topic provenance (BE-2/BE-3)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('records capture provenance inside audit_metadata_json', () => {
    const topic = addTopic(USER, 'Open water fear', {
      status: 'planned',
      tenantId: USER,
      provenance: { source: 'capture', clientRequestId: 'cap-001' },
    });

    const row = testDb
      .prepare('SELECT audit_metadata_json FROM content_topics WHERE id = ?')
      .get(topic.id) as { audit_metadata_json: string };
    const audit = JSON.parse(row.audit_metadata_json);
    expect(audit.provenance).toEqual({ source: 'capture', clientRequestId: 'cap-001' });
  });

  it('keeps audit metadata untouched when no provenance is supplied', () => {
    const topic = addTopic(USER, 'Plain create', { status: 'planned', tenantId: USER });

    const row = testDb
      .prepare('SELECT audit_metadata_json FROM content_topics WHERE id = ?')
      .get(topic.id) as { audit_metadata_json: string };
    const audit = JSON.parse(row.audit_metadata_json || '{}');
    expect(audit.provenance).toBeUndefined();
    expect(findTopicByClientRequestId(USER, 'anything')).toBeNull();
  });

  it('finds a topic by clientRequestId for replay, scoped to the user', () => {
    const created = addTopic(USER, 'Idempotent create', {
      status: 'planned',
      tenantId: USER,
      provenance: { source: 'capture', clientRequestId: 'cap-replay-7' },
    });

    const replay = findTopicByClientRequestId(USER, 'cap-replay-7');
    expect(replay?.id).toBe(created.id);
    expect(replay?.title).toBe('Idempotent create');

    // Another user must never see the topic through the replay lookup.
    expect(findTopicByClientRequestId(USER + 1, 'cap-replay-7')).toBeNull();
    // Blank keys never match.
    expect(findTopicByClientRequestId(USER, '   ')).toBeNull();
  });
});
