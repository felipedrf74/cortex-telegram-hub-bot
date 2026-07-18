import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { assertContentEditorialWorkspaceExitReady } from '../../src/services/content-editorial-workspace-exit';

const UP = readFileSync(resolve(process.cwd(), 'migrations/249_content_editorial_workspace_exit.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/249_content_editorial_workspace_exit.sql'), 'utf8');

describe('migration 249 pre-workspace editorial exit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase({ stopBefore: '249_content_editorial_workspace_exit.sql' });
  });

  afterEach(() => db.close());

  it.each(['approved', 'scheduled', 'published'] as const)(
    'preserves a legacy %s claim as review-required evidence without manufacturing release truth',
    (legacyState) => {
      const itemId = seedLegacyEditorialRoot(db, legacyState);
      db.exec(UP);
      assertContentEditorialWorkspaceExitReady(db);

      const item = db.prepare(`
        SELECT object_type, lifecycle_state, production_state, artifact_phase,
               editorial_state, approval_state, review_required,
               review_reason_codes_json, current_artifact_id,
               scheduled_for, secretary_intent_id, secretary_agenda_item_id,
               approved_by, approved_at
          FROM content_domain_objects
         WHERE id = ?
      `).get(itemId) as any;
      expect(item).toMatchObject({
        object_type: 'content_item',
        lifecycle_state: 'review',
        production_state: 'review',
        artifact_phase: 'idea',
        editorial_state: 'reviewed',
        approval_state: 'required',
        review_required: 1,
        current_artifact_id: null,
        scheduled_for: null,
        secretary_intent_id: null,
        secretary_agenda_item_id: null,
        approved_by: null,
        approved_at: null,
      });
      const expectedTrustCode = {
        approved: 'legacy_approval_claim_requires_canonical_revision_and_lineage',
        scheduled: 'legacy_schedule_claim_requires_canonical_schedule_binding',
        published: 'legacy_publication_claim_requires_external_verification',
      }[legacyState];
      expect(JSON.parse(item.review_reason_codes_json)).toEqual(expect.arrayContaining([
        'legacy_content_parity_pending',
        expectedTrustCode,
      ]));
      expect(db.prepare(`
        SELECT legacy_object_type, legacy_editorial_state,
               legacy_secretary_intent_id, legacy_secretary_agenda_item_id
          FROM content_editorial_workspace_exit_bindings
         WHERE item_id = ?
      `).get(itemId)).toEqual({
        legacy_object_type: 'script',
        legacy_editorial_state: legacyState,
        legacy_secretary_intent_id: `legacy-intent-${legacyState}`,
        legacy_secretary_agenda_item_id: `legacy-agenda-${legacyState}`,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE item_id = ?').get(itemId)).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings WHERE item_id = ?').get(itemId)).toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM content_workflow_events
         WHERE object_id = ? AND action = 'legacy_editorial_migrated'
      `).get(String(itemId))).toEqual({ count: 1 });
    },
  );

  it('normalizes an ordinary draft to active metadata-only truth and blocks every old writer', () => {
    const itemId = seedLegacyEditorialRoot(db, 'drafted');
    db.exec(UP);

    expect(db.prepare(`
      SELECT object_type, production_state, artifact_phase, editorial_state,
             approval_state, review_required
        FROM content_domain_objects WHERE id = ?
    `).get(itemId)).toEqual({
      object_type: 'content_item',
      production_state: 'active',
      artifact_phase: 'idea',
      editorial_state: 'idea',
      approval_state: 'not_required',
      review_required: 0,
    });
    expect(() => seedLegacyEditorialRoot(db, 'drafted'))
      .toThrow(/legacy editorial content roots are read-only after migration 249/i);
    expect(() => db.prepare(`
      INSERT INTO content_approval_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, approval_type, approval_state, requested_by
      ) VALUES (501, 501, 'user_private', 'active', 'content_item', ?, 'publish', 'required', 501)
    `).run(String(itemId))).toThrow(/historical after migration 249/i);
    expect(() => db.prepare(`
      INSERT INTO content_source_review_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, review_state, reviewed_by
      ) VALUES (501, 501, 'user_private', 'active', 'content_item', ?, 'reviewed', 501)
    `).run(String(itemId))).toThrow(/historical after migration 249/i);
  });

  it('aborts before cutover when a shared legacy root needs an explicit collaboration-role decision', () => {
    const itemId = seedLegacyEditorialRoot(db, 'drafted');
    db.prepare(`
      UPDATE content_domain_objects
         SET visibility_scope = 'tenant_shared'
       WHERE id = ?
    `).run(itemId);

    expect(() => db.exec(UP)).toThrow(/CHECK constraint failed/i);
    expect(db.prepare('SELECT object_type, visibility_scope FROM content_domain_objects WHERE id = ?').get(itemId))
      .toEqual({ object_type: 'script', visibility_scope: 'tenant_shared' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM sqlite_master
       WHERE type = 'table' AND name = 'content_editorial_workspace_exit_bindings'
    `).get()).toEqual({ count: 0 });
  });

  it('keeps historical approval/source-review evidence readable and permits only scoped legal erasure', () => {
    ensureLegacySourceReviewTable(db);
    const itemId = seedLegacyEditorialRoot(db, 'reviewed');
    db.prepare(`
      INSERT INTO content_approval_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, approval_type, approval_state, requested_by
      ) VALUES (501, 501, 'user_private', 'active', 'script', ?, 'unsupported_claims', 'required', 501)
    `).run(String(itemId));
    db.prepare(`
      INSERT INTO content_source_review_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, review_state, reviewed_by
      ) VALUES (501, 501, 'user_private', 'active', 'script', ?, 'approval_required', 501)
    `).run(String(itemId));
    db.exec(UP);

    expect(db.prepare('SELECT COUNT(*) AS count FROM content_approval_records WHERE object_id = ?').get(String(itemId)))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_source_review_records WHERE object_id = ?').get(String(itemId)))
      .toEqual({ count: 1 });
    expect(() => db.prepare('DELETE FROM content_approval_records WHERE object_id = ?').run(String(itemId)))
      .toThrow(/historical after migration 249/i);

    db.prepare(`
      INSERT INTO training_revision_erasure_authorizations (
        erasure_id, subject_user_id, reason, expires_at
      ) VALUES ('editorial-exit-erasure', 501, 'LEGAL_ERASURE', datetime('now', '+5 minutes'))
    `).run();
    expect(db.prepare('DELETE FROM content_approval_records WHERE object_id = ?').run(String(itemId)).changes).toBe(1);
    expect(db.prepare('DELETE FROM content_source_review_records WHERE object_id = ?').run(String(itemId)).changes).toBe(1);
  });

  it('adds privacy-bounded compatibility counters and requires snapshot rollback after any normalized root', () => {
    seedLegacyEditorialRoot(db, 'drafted');
    db.exec(UP);
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'content_workspace_product_metrics'
    `).get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining('legacy_editorial_compatibility_mutation'),
    }));
    expect(() => db.exec(DOWN)).toThrow(/CHECK constraint failed/i);

    const empty = createMigratedTestDatabase({ stopBefore: '249_content_editorial_workspace_exit.sql' });
    try {
      empty.exec(UP);
      empty.exec(DOWN);
      expect(empty.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'content_editorial_workspace_exit_bindings'
      `).get()).toEqual({ count: 0 });
    } finally {
      empty.close();
    }
  });
});

function seedLegacyEditorialRoot(
  db: Database.Database,
  editorialState: 'drafted' | 'reviewed' | 'approved' | 'scheduled' | 'published',
): number {
  const result = db.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, editorial_state, approval_state,
      review_required, review_reason_codes_json, title, summary,
      ontology_metadata_json, ontology_schema_version,
      production_state, artifact_phase, workspace_schema_version,
      approved_by, approved_at, scheduled_for,
      secretary_intent_id, secretary_agenda_item_id,
      workflow_version, created_by, updated_by, audit_metadata_json
    ) VALUES (
      501, 501, 'user_private', 'active',
      'script', ?, ?, ?,
      ?, ?, ?, 'Historical metadata only',
      '{}', 'content-ontology-v1',
      'inbox', 'idea', 'content-workspace-v1',
      ?, ?, '2031-01-02T10:00:00.000Z',
      ?, ?,
      3, 501, 501, '{}'
    )
  `).run(
    editorialState,
    editorialState,
    ['reviewed', 'approved', 'scheduled', 'published'].includes(editorialState) ? 'approved' : 'not_required',
    editorialState === 'reviewed' ? 1 : 0,
    editorialState === 'reviewed' ? JSON.stringify(['legacy_source_review']) : '[]',
    `Legacy ${editorialState} ${Date.now()} ${Math.random()}`,
    ['approved', 'scheduled', 'published'].includes(editorialState) ? 501 : null,
    ['approved', 'scheduled', 'published'].includes(editorialState) ? '2031-01-01T10:00:00.000Z' : null,
    `legacy-intent-${editorialState}`,
    `legacy-agenda-${editorialState}`,
  );
  return Number(result.lastInsertRowid);
}

function ensureLegacySourceReviewTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_source_review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      review_state TEXT NOT NULL,
      grounding_status TEXT,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      reviewed_by INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
}
