import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';

const UP = readFileSync(resolve(process.cwd(), 'migrations/240_content_workspace_domain.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/240_content_workspace_domain.sql'), 'utf8');

describe('migration 240 content workspace domain', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createDomainObjectTable(db);
  });

  afterEach(() => db.close());

  it('adds lifecycle/read-model fields and canonical child tables without a parallel item root', () => {
    db.exec(UP);

    const columns = db.prepare('PRAGMA table_info(content_domain_objects)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'artifact_phase',
      'production_state',
      'workspace_priority',
      'deadline_at',
      'current_artifact_id',
      'workspace_schema_version',
    ]));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'content_domain_objects',
      'content_artifacts',
      'content_revisions',
      'content_mutation_receipts',
      'content_item_relationships',
    ]));
    expect(tables.map((table) => table.name)).not.toContain('content_items');
  });

  it('enforces scoped artifact ownership and immutable revision content at the database boundary', () => {
    db.exec(UP);
    db.prepare(`
      INSERT INTO content_domain_objects (
        id, tenant_id, owner_user_id, object_type, title, created_by, updated_by
      ) VALUES (1, 101, 501, 'content_item', 'Scoped item', 501, 501)
    `).run();

    expect(() => db.prepare(`
      INSERT INTO content_artifacts (
        tenant_id, owner_user_id, item_id, artifact_type, created_by, updated_by
      ) VALUES (202, 501, 1, 'script', 501, 501)
    `).run()).toThrow();

    const artifact = db.prepare(`
      INSERT INTO content_artifacts (
        tenant_id, owner_user_id, item_id, artifact_type, created_by, updated_by
      ) VALUES (101, 501, 1, 'script', 501, 501)
    `).run();
    const revision = db.prepare(`
      INSERT INTO content_revisions (
        tenant_id, owner_user_id, artifact_id, revision_number,
        content_format, content_text, content_hash, created_by
      ) VALUES (?, ?, ?, 1, 'plain_text', 'Original', ?, ?)
    `).run(101, 501, artifact.lastInsertRowid, 'a'.repeat(64), 501);

    expect(() => db.prepare('UPDATE content_revisions SET content_text = ? WHERE id = ?')
      .run('Overwritten', revision.lastInsertRowid)).toThrow('content revisions are immutable');
  });

  it('fails a down attempt before mutation because the migration is explicitly forward-only', () => {
    db.exec(UP);
    db.prepare(`
      INSERT INTO content_domain_objects (
        id, tenant_id, owner_user_id, object_type, title, artifact_phase,
        production_state, created_by, updated_by
      ) VALUES (1, 101, 501, 'content_item', 'Keep me', 'brief', 'active', 501, 501)
    `).run();

    expect(() => db.exec(DOWN)).toThrow(/content_workspace_240_forward_only_rollback_is_not_supported/);

    expect(db.prepare('SELECT title, artifact_phase, production_state FROM content_domain_objects WHERE id = 1').get())
      .toEqual({ title: 'Keep me', artifact_phase: 'brief', production_state: 'active' });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'content_artifacts',
      'content_revisions',
      'content_mutation_receipts',
      'content_item_relationships',
    ]));
    expect(() => db.exec(UP)).toThrow(/duplicate column name/i);
  });
});

describe('migration 240 in the production migration chain', () => {
  it('applies to the fully migrated schema and executes a real workspace transition', () => {
    const db = createMigratedTestDatabase();
    try {
      const item = createContentWorkspaceItem({
        scope: { tenantId: 101, userId: 501 },
        itemType: 'content_item',
        title: 'Production-chain item',
        idempotencyKey: 'full-chain-item-001',
      }, db).value;
      const artifact = createContentArtifact({
        scope: { tenantId: 101, userId: 501 },
        itemId: item.id,
        expectedWorkflowVersion: item.workflowVersion,
        artifactType: 'script',
        initialContent: { format: 'plain_text', text: 'Saved before review.' },
        idempotencyKey: 'full-chain-artifact-001',
      }, db).value;
      const active = db.prepare('SELECT workflow_version AS version FROM content_domain_objects WHERE id = ?')
        .get(item.id) as { version: number };
      const review = transitionContentWorkspaceItem({
        scope: { tenantId: 101, userId: 501 },
        itemId: item.id,
        targetState: 'review',
        expectedWorkflowVersion: active.version,
        idempotencyKey: 'full-chain-review-001',
      }, db);

      expect(artifact.currentRevision?.revisionNumber).toBe(1);
      expect(review.value).toMatchObject({ productionState: 'review', workflowVersion: active.version + 1 });
      expect(db.prepare("SELECT action, approval_state, review_required FROM content_workflow_events WHERE object_id = ? AND action = 'workspace_state_changed'")
        .get(String(item.id))).toEqual({ action: 'workspace_state_changed', approval_state: 'required', review_required: 1 });
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
  `);
}
