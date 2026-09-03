import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const upSql = readFileSync(
  resolve(__dirname, '../../migrations/312_content_neutral_legacy_defaults.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/312_content_neutral_legacy_defaults.sql'),
  'utf8',
);

describe('migration 312 neutral Content defaults', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE config_seed_books (
        id INTEGER PRIMARY KEY, title TEXT, author TEXT, enabled INTEGER
      );
      CREATE TABLE config_default_channels (
        id INTEGER PRIMARY KEY, enabled INTEGER, added_via TEXT, url TEXT
      );
      CREATE TABLE content_ref_channels (
        id INTEGER PRIMARY KEY, user_id INTEGER, owner_scope TEXT,
        tenant_id INTEGER, owner_user_id INTEGER, visibility_scope TEXT,
        channel_url TEXT, scope_status TEXT, lifecycle_state TEXT,
        audit_metadata_json TEXT, channel_id TEXT, channel_name TEXT
      );
      CREATE TABLE agent_signals (
        id INTEGER PRIMARY KEY, status TEXT, user_id INTEGER, tenant_id INTEGER,
        payload TEXT, source_agent TEXT, signal_type TEXT
      );
      CREATE TABLE content_knowledge (
        id INTEGER PRIMARY KEY, user_id INTEGER, owner_scope TEXT,
        tenant_id INTEGER, owner_user_id INTEGER, visibility_scope TEXT,
        scope_status TEXT, lifecycle_state TEXT, audit_metadata_json TEXT
      );
      CREATE TABLE content_patterns (
        id INTEGER PRIMARY KEY, user_id INTEGER, tenant_id INTEGER,
        owner_user_id INTEGER, visibility_scope TEXT, channel_id INTEGER,
        scope_status TEXT, lifecycle_state TEXT, audit_metadata_json TEXT
      );
      CREATE TABLE book_library (
        id INTEGER PRIMARY KEY, user_id INTEGER, owner_scope TEXT,
        tenant_id INTEGER, owner_user_id INTEGER, visibility_scope TEXT,
        scope_status TEXT, lifecycle_state TEXT, audit_metadata_json TEXT,
        title TEXT, author TEXT
      );
    `);
    db.prepare(`
      INSERT INTO config_default_channels (id, enabled, added_via, url)
      VALUES (10, 1, 'migration', 'https://www.youtube.com/@danielbarada')
    `).run();
    db.prepare(`
      INSERT INTO content_ref_channels (
        id, user_id, owner_scope, tenant_id, owner_user_id, visibility_scope,
        channel_url, scope_status, lifecycle_state, audit_metadata_json,
        channel_id, channel_name
      ) VALUES (100, 0, 'system', 0, 0, 'platform_internal', ?,
                'active', 'active', 'legacy-audit-bytes', 'UC-legacy', 'Shared Name')
    `).run('https://www.youtube.com/@danielbarada');
    const insertSignal = db.prepare(`
      INSERT INTO agent_signals (
        id, status, user_id, tenant_id, payload, source_agent, signal_type
      ) VALUES (?, 'active', NULL, NULL, ?, 'channel-learner', 'channel_dna')
    `);
    insertSignal.run(1, JSON.stringify({ channel_id: 'UC-legacy', channel_name: 'Shared Name' }));
    insertSignal.run(2, JSON.stringify({ channel_id: 'UC-other', channel_name: 'Shared Name' }));
    insertSignal.run(3, JSON.stringify({ channel_name: 'Shared Name' }));
  });

  afterEach(() => db.close());

  it('uses channel ID as authority and falls back to name only when an ID is absent', () => {
    db.exec(upSql);

    expect(db.prepare('SELECT id, status FROM agent_signals ORDER BY id').all()).toEqual([
      { id: 1, status: 'dismissed' },
      { id: 2, status: 'active' },
      { id: 3, status: 'dismissed' },
    ]);
    expect(db.prepare(`
      SELECT enabled FROM config_default_channels WHERE id = 10
    `).get()).toEqual({ enabled: 0 });
    expect(db.prepare(`
      SELECT scope_status AS scopeStatus, lifecycle_state AS lifecycleState
        FROM content_ref_channels WHERE id = 100
    `).get()).toEqual({ scopeStatus: 'archived', lifecycleState: 'retired' });
  });

  it('restores exact statuses, configuration, lifecycle, and audit bytes on rollback', () => {
    db.exec(upSql);
    db.exec(downSql);

    expect(db.prepare('SELECT id, status FROM agent_signals ORDER BY id').all()).toEqual([
      { id: 1, status: 'active' },
      { id: 2, status: 'active' },
      { id: 3, status: 'active' },
    ]);
    expect(db.prepare(`
      SELECT enabled FROM config_default_channels WHERE id = 10
    `).get()).toEqual({ enabled: 1 });
    expect(db.prepare(`
      SELECT scope_status AS scopeStatus, lifecycle_state AS lifecycleState,
             audit_metadata_json AS auditMetadataJson
        FROM content_ref_channels WHERE id = 100
    `).get()).toEqual({
      scopeStatus: 'active',
      lifecycleState: 'active',
      auditMetadataJson: 'legacy-audit-bytes',
    });
  });
});
