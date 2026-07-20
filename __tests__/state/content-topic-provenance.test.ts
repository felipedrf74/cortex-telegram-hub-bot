/**
 * BE-2/BE-3 (Content Studio, 2026-06-10): topic creation provenance +
 * idempotent-replay lookup against a real migrated database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  addTopic,
  deleteTopic,
  findTopicByClientRequestId,
  getTopicById,
  getTopics,
  updateTopic,
} from '../../src/services/content-scheduler';


const USER = 4101;

describe('content topic provenance (BE-2/BE-3)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('records capture provenance on the immutable canonical idea revision', () => {
    const topic = addTopic(USER, 'Open water fear', {
      status: 'planned',
      tenantId: USER,
      provenance: { source: 'capture', clientRequestId: 'cap-001' },
    });

    const row = testDb.prepare(`
      SELECT revision.provenance_json
        FROM content_topic_workspace_links link
        JOIN content_artifacts artifact ON artifact.id = link.compatibility_artifact_id
        JOIN content_revisions revision ON revision.id = artifact.current_revision_id
       WHERE link.compat_topic_id = ?
    `).get(topic.id) as { provenance_json: string };
    expect(JSON.parse(row.provenance_json)).toMatchObject({
      compatibilitySchemaVersion: 'content-topic-compatibility-v1',
      source: 'capture',
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_topics').get()).toEqual({ count: 0 });
  });

  it('uses neutral compatibility provenance when no source is supplied', () => {
    const topic = addTopic(USER, 'Plain create', { status: 'planned', tenantId: USER });

    const row = testDb.prepare(`
      SELECT revision.provenance_json
        FROM content_topic_workspace_links link
        JOIN content_artifacts artifact ON artifact.id = link.compatibility_artifact_id
        JOIN content_revisions revision ON revision.id = artifact.current_revision_id
       WHERE link.compat_topic_id = ?
    `).get(topic.id) as { provenance_json: string };
    expect(JSON.parse(row.provenance_json)).toMatchObject({ source: 'legacy_topic_route' });
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

  it('keeps reads, replay, updates, and deletes inside the active private tenant-owner scope', () => {
    const tenantId = USER;
    const created = addTopic(USER, 'Tenant-private topic', {
      tenantId,
      status: 'planned',
      provenance: { source: 'capture', clientRequestId: 'tenant-private-replay' },
    });

    expect(getTopicById(USER, created.id, tenantId)?.id).toBe(created.id);
    expect(() => getTopicById(USER, created.id, tenantId + 1)).toThrow('authenticated owner scope');
    expect(findTopicByClientRequestId(USER, 'tenant-private-replay', tenantId)?.id).toBe(created.id);
    expect(() => findTopicByClientRequestId(USER, 'tenant-private-replay', tenantId + 1)).toThrow('authenticated owner scope');
    expect(getTopics(USER, { tenantId }).map((topic) => topic.id)).toContain(created.id);
    expect(() => getTopics(USER, { tenantId: tenantId + 1 })).toThrow('authenticated owner scope');

    expect(() => updateTopic(USER, created.id, { title: 'Cross-tenant overwrite' }, tenantId + 1)).toThrow('authenticated owner scope');
    expect(() => deleteTopic(USER, created.id, tenantId + 1)).toThrow('authenticated owner scope');
    expect(getTopicById(USER, created.id, tenantId)?.title).toBe('Tenant-private topic');

    testDb.prepare(`
      UPDATE content_domain_objects
      SET visibility_scope = 'tenant_shared', scope_status = 'archived'
      WHERE id = ?
    `).run(created.workspace_item_id!);

    expect(getTopicById(USER, created.id, tenantId)).toBeNull();
    expect(findTopicByClientRequestId(USER, 'tenant-private-replay', tenantId)).toBeNull();
    expect(getTopics(USER, { tenantId }).map((topic) => topic.id)).not.toContain(created.id);
    expect(updateTopic(USER, created.id, { title: 'Quarantined overwrite' }, tenantId)).toBeNull();
    expect(deleteTopic(USER, created.id, tenantId)).toBe(false);
  });
});
