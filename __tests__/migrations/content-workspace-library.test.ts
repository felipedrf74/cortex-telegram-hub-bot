import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  attachContentTag,
  createContentTag,
  createContentWorkspaceItem,
  queryContentWorkspaceItems,
} from '../../src/services/content-workspace';

const WORKSPACE_UP = readFileSync(resolve(process.cwd(), 'migrations/240_content_workspace_domain.sql'), 'utf8');
const LIBRARY_UP = readFileSync(resolve(process.cwd(), 'migrations/241_content_workspace_library.sql'), 'utf8');
const LIBRARY_DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/241_content_workspace_library.sql'), 'utf8');

describe('migration 241 content workspace library', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createDomainObjectTable(db);
    db.exec(WORKSPACE_UP);
  });

  afterEach(() => db.close());

  it('adds scoped tag children without adding a folder or parallel content root', () => {
    db.exec(LIBRARY_UP);
    expect(() => db.exec(LIBRARY_UP)).not.toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'content_domain_objects',
      'content_tags',
      'content_item_tags',
      'content_item_relationships',
    ]));
    expect(tables.map((row) => row.name)).not.toEqual(expect.arrayContaining(['content_items', 'content_folders']));

    db.prepare(`
      INSERT INTO content_domain_objects (
        id, tenant_id, owner_user_id, object_type, title, created_by, updated_by
      ) VALUES (1, 101, 501, 'content_item', 'Scoped item', 501, 501)
    `).run();
    const ownerTag = db.prepare(`
      INSERT INTO content_tags (
        tenant_id, owner_user_id, display_name, normalized_name, created_by, updated_by
      ) VALUES (101, 501, 'Launch', 'launch', 501, 501)
    `).run();
    const otherTenantTag = db.prepare(`
      INSERT INTO content_tags (
        tenant_id, owner_user_id, display_name, normalized_name, created_by, updated_by
      ) VALUES (202, 501, 'Launch', 'launch', 501, 501)
    `).run();

    expect(() => db.prepare(`
      INSERT INTO content_item_tags (
        tenant_id, owner_user_id, item_id, tag_id, created_by
      ) VALUES (101, 501, 1, ?, 501)
    `).run(otherTenantTag.lastInsertRowid)).toThrow();
    expect(() => db.prepare(`
      INSERT INTO content_item_tags (
        tenant_id, owner_user_id, item_id, tag_id, created_by
      ) VALUES (101, 501, 1, ?, 501)
    `).run(ownerTag.lastInsertRowid)).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO content_tags (
        tenant_id, owner_user_id, display_name, normalized_name, created_by, updated_by
      ) VALUES (101, 501, 'LAUNCH', 'launch', 501, 501)
    `).run()).toThrow();
  });

  it('fails a down attempt before destroying user-authored tag organization', () => {
    db.exec(LIBRARY_UP);
    db.prepare(`
      INSERT INTO content_tags (
        tenant_id, owner_user_id, display_name, normalized_name, created_by, updated_by
      ) VALUES (101, 501, 'Keep me', 'keep me', 501, 501)
    `).run();

    expect(() => db.exec(LIBRARY_DOWN)).toThrow(/content_workspace_241_forward_only_rollback_is_not_supported/);
    expect(db.prepare('SELECT display_name FROM content_tags').all()).toEqual([{ display_name: 'Keep me' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_item_tags'").get())
      .toEqual({ name: 'content_item_tags' });
  });
});

describe('migration 241 in the production migration chain', () => {
  it('supports a scoped item, tag association, and canonical library read model', () => {
    const db = createMigratedTestDatabase();
    try {
      const scope = { tenantId: 101, userId: 501 };
      const item = createContentWorkspaceItem({
        scope,
        itemType: 'content_item',
        title: 'Fully migrated library item',
        idempotencyKey: 'migration-241-item-001',
      }, db).value;
      const tag = createContentTag({
        scope,
        name: 'Launch Week',
        idempotencyKey: 'migration-241-tag-001',
      }, db).value;
      const tagged = attachContentTag({
        scope,
        itemId: item.id,
        tagId: tag.id,
        expectedWorkflowVersion: item.workflowVersion,
        idempotencyKey: 'migration-241-attach-001',
      }, db).value;

      expect(tagged.tags).toEqual([expect.objectContaining({ name: 'Launch Week', normalizedName: 'launch week' })]);
      expect(queryContentWorkspaceItems({ scope, tag: 'LAUNCH  WEEK' }, db).items.map((row) => row.id)).toEqual([item.id]);
    } finally {
      db.close();
    }
  });
});

function createDomainObjectTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE content_domain_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'captured',
      title TEXT NOT NULL,
      summary TEXT,
      platform_id TEXT,
      format_id TEXT,
      ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
      ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
      editorial_state TEXT DEFAULT 'idea',
      approval_state TEXT DEFAULT 'not_required',
      review_required INTEGER NOT NULL DEFAULT 0,
      review_reason_codes_json TEXT DEFAULT '[]',
      approved_by INTEGER,
      approved_at TEXT,
      archived_at TEXT,
      workflow_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE content_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL,
      scope_status TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      approval_state TEXT NOT NULL,
      review_required INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);
}
