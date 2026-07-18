import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { createContentArtifact } from '../../src/services/content-workspace';
import { assertContentPerformanceWorkspaceLineageReady } from '../../src/services/content-performance-lineage';

const UP_246 = readFileSync(resolve(process.cwd(), 'migrations/246_content_pipeline_workspace_exit.sql'), 'utf8');
const UP_250 = readFileSync(resolve(process.cwd(), 'migrations/250_content_performance_workspace_lineage.sql'), 'utf8');
const DOWN_250 = readFileSync(resolve(process.cwd(), 'migrations/down/250_content_performance_workspace_lineage.sql'), 'utf8');
const EXCLUDE_250 = ['250_content_performance_workspace_lineage.sql'];

describe('migration 250 Content performance workspace lineage', () => {
  const databases: Database.Database[] = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it('backfills only an artifact-pinned migration-246 legacy binding', () => {
    const db = tracked(createMigratedTestDatabase({ excludeFiles: EXCLUDE_250 }));
    db.exec(`
      DROP TRIGGER trg_content_pipeline_legacy_insert_blocked;
      DROP TRIGGER trg_content_pipeline_legacy_update_blocked;
    `);
    const pinnedPipelineId = seedLegacyPipeline(db, 'Pinned historical outcome');
    const metadataOnlyPipelineId = seedLegacyPipeline(db, 'Unpinned historical outcome');
    const pinnedPerformanceId = seedLegacyPerformance(db, pinnedPipelineId, 101, 501);
    const metadataOnlyPerformanceId = seedLegacyPerformance(db, metadataOnlyPipelineId, 101, 501);

    // Re-running the idempotent migration-246 import simulates the predecessor
    // database state while restoring its legacy writer guards.
    db.exec(UP_246);
    const binding = db.prepare(`
      SELECT binding.id, binding.item_id, item.workflow_version
        FROM content_workspace_ingress_bindings AS binding
        JOIN content_domain_objects AS item ON item.id = binding.item_id
       WHERE binding.source_kind = 'legacy_pipeline' AND binding.source_id = ?
    `).get(String(pinnedPipelineId)) as { id: number; item_id: number; workflow_version: number };
    const artifact = createContentArtifact({
      scope: { tenantId: 101, userId: 501 },
      itemId: binding.item_id,
      expectedWorkflowVersion: binding.workflow_version,
      artifactType: 'script',
      initialContent: { format: 'markdown', text: 'Pinned historical script revision.' },
      actorType: 'import',
      idempotencyKey: 'migration-250-pin-artifact-001',
    }, db).value;
    db.prepare(`
      UPDATE content_workspace_ingress_bindings
         SET artifact_id = ?, revision_id = ?, content_parity_status = 'artifact_pinned',
             updated_at = datetime('now')
       WHERE id = ?
    `).run(artifact.id, artifact.currentRevisionId, binding.id);

    db.exec(UP_250);

    expect(db.prepare(`
      SELECT performance_id, item_id, artifact_id, revision_id, origin
        FROM content_performance_workspace_links ORDER BY performance_id
    `).all()).toEqual([{
      performance_id: pinnedPerformanceId,
      item_id: binding.item_id,
      artifact_id: artifact.id,
      revision_id: artifact.currentRevisionId,
      origin: 'legacy_pipeline_backfill',
    }]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_performance_workspace_links
       WHERE performance_id = ?
    `).get(metadataOnlyPerformanceId)).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => assertContentPerformanceWorkspaceLineageReady(db)).not.toThrow();
  });

  it('freezes legacy aliases, enforces scoped immutable links, and leaves DELETE available for erasure', () => {
    const db = tracked(createMigratedTestDatabase());
    const owner = seedCanonicalTarget(db, 101, 501, 'owner');
    const foreign = seedCanonicalTarget(db, 202, 777, 'foreign');
    const ownerPerformanceId = seedUnlinkedCanonicalPerformance(db, 101, 501);

    expect(() => db.prepare(`
      INSERT INTO content_performance (
        pipeline_id, views, user_id, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by
      ) VALUES (99, 1, 501, 101, 501, 'user_private', 'active', 'active', 501, 501)
    `).run()).toThrow(/frozen legacy alias/i);
    expect(() => db.prepare('UPDATE content_performance SET pipeline_id = 99 WHERE id = ?')
      .run(ownerPerformanceId)).toThrow(/frozen legacy alias/i);

    expect(() => db.prepare(`
      INSERT INTO content_performance_workspace_links (
        tenant_id, owner_user_id, performance_id, item_id, artifact_id, revision_id, origin
      ) VALUES (?, ?, ?, ?, ?, ?, 'canonical_api')
    `).run(101, 501, ownerPerformanceId, owner.itemId, foreign.artifactId, foreign.revisionId))
      .toThrow(/scope mismatch|FOREIGN KEY constraint failed/i);

    const linkId = Number(db.prepare(`
      INSERT INTO content_performance_workspace_links (
        tenant_id, owner_user_id, performance_id, item_id, artifact_id, revision_id, origin
      ) VALUES (?, ?, ?, ?, ?, ?, 'canonical_api')
    `).run(101, 501, ownerPerformanceId, owner.itemId, owner.artifactId, owner.revisionId).lastInsertRowid);
    expect(() => db.prepare('UPDATE content_performance_workspace_links SET revision_id = ? WHERE id = ?')
      .run(owner.revisionId, linkId)).toThrow(/lineage is immutable/i);
    expect(() => db.prepare('DELETE FROM content_domain_objects WHERE id = ?').run(owner.itemId))
      .toThrow(/FOREIGN KEY constraint failed/i);

    db.prepare('DELETE FROM content_performance WHERE id = ?').run(ownerPerformanceId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance_workspace_links WHERE id = ?')
      .get(linkId)).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('fails exact-snapshot rollback before mutating migration-250 schema', () => {
    const db = tracked(createMigratedTestDatabase());
    expect(DOWN_250).toMatch(/exact.*snapshot/i);
    expect(() => db.exec(DOWN_250)).toThrow(/requires_exact_snapshot/i);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'content_performance_workspace_links'
    `).get()).toEqual({ name: 'content_performance_workspace_links' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_content_performance_pipeline_alias_insert_blocked'
    `).get()).toEqual({ count: 1 });
  });

  function tracked(db: Database.Database): Database.Database {
    databases.push(db);
    return db;
  }
});

function seedLegacyPipeline(db: Database.Database, title: string): number {
  return Number(db.prepare(`
    INSERT INTO content_pipeline (
      topic_title, niche, stage, stage_history, user_id, tenant_id,
      owner_user_id, visibility_scope, scope_status, created_by, updated_by
    ) VALUES (?, 'creator operations', 'published', '[]', 501, 101, 501,
              'user_private', 'active', 501, 501)
  `).run(title).lastInsertRowid);
}

function seedLegacyPerformance(
  db: Database.Database,
  pipelineId: number,
  tenantId: number,
  userId: number,
): number {
  return Number(db.prepare(`
    INSERT INTO content_performance (
      pipeline_id, views, retention_pct, user_id, tenant_id, owner_user_id,
      visibility_scope, lifecycle_state, scope_status, created_by, updated_by
    ) VALUES (?, 900, 45, ?, ?, ?, 'user_private', 'active', 'active', ?, ?)
  `).run(pipelineId, userId, tenantId, userId, userId, userId).lastInsertRowid);
}

function seedCanonicalTarget(
  db: Database.Database,
  tenantId: number,
  userId: number,
  suffix: string,
): { itemId: number; artifactId: number; revisionId: number } {
  const item = db.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status, object_type,
      lifecycle_state, title, editorial_state, approval_state, review_required,
      review_reason_codes_json, created_by, updated_by
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', 'active', ?,
              'idea', 'not_required', 0, '[]', ?, ?)
  `).run(tenantId, userId, `Migration target ${suffix}`, userId, userId);
  const itemId = Number(item.lastInsertRowid);
  const artifact = db.prepare(`
    INSERT INTO content_artifacts (
      tenant_id, owner_user_id, item_id, artifact_type, created_by, updated_by
    ) VALUES (?, ?, ?, 'script', ?, ?)
  `).run(tenantId, userId, itemId, userId, userId);
  const artifactId = Number(artifact.lastInsertRowid);
  const revision = db.prepare(`
    INSERT INTO content_revisions (
      tenant_id, owner_user_id, artifact_id, revision_number, content_format,
      content_text, content_hash, created_by
    ) VALUES (?, ?, ?, 1, 'plain_text', ?, ?, ?)
  `).run(tenantId, userId, artifactId, `Script ${suffix}`, suffix.padEnd(64, 'a').slice(0, 64), userId);
  const revisionId = Number(revision.lastInsertRowid);
  db.prepare(`
    UPDATE content_artifacts
       SET current_revision_id = ?, revision_count = 1
     WHERE id = ?
  `).run(revisionId, artifactId);
  return { itemId, artifactId, revisionId };
}

function seedUnlinkedCanonicalPerformance(
  db: Database.Database,
  tenantId: number,
  userId: number,
): number {
  return Number(db.prepare(`
    INSERT INTO content_performance (
      pipeline_id, views, retention_pct, user_id, tenant_id, owner_user_id,
      visibility_scope, lifecycle_state, scope_status, created_by, updated_by,
      audit_metadata_json
    ) VALUES (NULL, 100, 40, ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(userId, tenantId, userId, userId, userId).lastInsertRowid);
}
