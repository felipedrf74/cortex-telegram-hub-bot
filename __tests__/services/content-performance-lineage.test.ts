import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import {
  ContentPerformanceLineageError,
  assertContentPerformanceWorkspaceLineageReady,
  listContentPerformanceOutcomesForItem,
  recordContentPerformanceOutcome,
} from '../../src/services/content-performance-lineage';

const OWNER: ContentWorkspaceScope = { tenantId: 101, userId: 501 };
const OTHER_TENANT: ContentWorkspaceScope = { tenantId: 202, userId: 501 };

describe('canonical Content performance lineage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('atomically stores one outcome, immutable revision link, and mutation receipt with no pipeline alias', () => {
    const target = seedTarget(db, OWNER, 'atomic');
    const mutation = recordContentPerformanceOutcome({
      scope: OWNER,
      itemId: target.itemId,
      artifactId: target.artifactId,
      revisionId: target.revisionId,
      idempotencyKey: 'performance-atomic-001',
      videoUrl: 'https://video.example.invalid/watch/atomic',
      views: 1200,
      retentionPct: 43.5,
      likes: 100,
      publishedHashtags: ['#creator'],
      notes: 'User-reported after 48 hours.',
    }, db);

    expect(mutation).toMatchObject({ replayed: false, created: true });
    expect(mutation.value).toMatchObject({
      workspaceItemId: target.itemId,
      artifactId: target.artifactId,
      revisionId: target.revisionId,
      association: 'canonical_revision',
      linkOrigin: 'canonical_api',
      pipelineId: null,
      views: 1200,
      retentionPct: 43.5,
    });
    expect(db.prepare(`
      SELECT pipeline_id, tenant_id, owner_user_id,
             json_extract(audit_metadata_json, '$.origin') AS origin
        FROM content_performance WHERE id = ?
    `).get(mutation.value.id)).toEqual({
      pipeline_id: null,
      tenant_id: OWNER.tenantId,
      owner_user_id: OWNER.userId,
      origin: 'canonical_api',
    });
    expect(db.prepare(`
      SELECT item_id, artifact_id, revision_id, origin
        FROM content_performance_workspace_links WHERE performance_id = ?
    `).get(mutation.value.id)).toEqual({
      item_id: target.itemId,
      artifact_id: target.artifactId,
      revision_id: target.revisionId,
      origin: 'canonical_api',
    });
    expect(db.prepare(`
      SELECT operation, resource_type, resource_id
        FROM content_mutation_receipts
       WHERE tenant_id = ? AND owner_user_id = ? AND idempotency_key = ?
    `).get(OWNER.tenantId, OWNER.userId, 'performance-atomic-001')).toEqual({
      operation: 'record_content_performance',
      resource_type: 'content_performance',
      resource_id: String(mutation.value.id),
    });
    expect(listContentPerformanceOutcomesForItem(OWNER, target.itemId, db))
      .toEqual([mutation.value]);
    expect(() => assertContentPerformanceWorkspaceLineageReady(db)).not.toThrow();
  });

  it('replays the same request and rejects changed input under the same key', () => {
    const target = seedTarget(db, OWNER, 'replay');
    const input = {
      scope: OWNER,
      ...target,
      idempotencyKey: 'performance-replay-001',
      views: 800,
      retentionPct: 38,
    };
    const first = recordContentPerformanceOutcome(input, db);
    const replay = recordContentPerformanceOutcome(input, db);

    expect(replay).toMatchObject({ replayed: true, created: false });
    expect(replay.value.id).toBe(first.value.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance_workspace_links').get()).toEqual({ count: 1 });

    expect(() => recordContentPerformanceOutcome({ ...input, views: 801 }, db))
      .toThrowError(expect.objectContaining<Partial<ContentPerformanceLineageError>>({
        code: 'CONTENT_PERFORMANCE_IDEMPOTENCY_KEY_REUSED',
        status: 409,
      }));
  });

  it('makes foreign, stale, and cross-tenant target combinations indistinguishable', () => {
    const owner = seedTarget(db, OWNER, 'owner');
    const otherTenant = seedTarget(db, OTHER_TENANT, 'other-tenant');

    expect(() => recordContentPerformanceOutcome({
      scope: OWNER,
      itemId: owner.itemId,
      artifactId: otherTenant.artifactId,
      revisionId: otherTenant.revisionId,
      idempotencyKey: 'performance-cross-scope-001',
      views: 100,
      retentionPct: 40,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentPerformanceLineageError>>({
      code: 'CONTENT_PERFORMANCE_TARGET_NOT_FOUND',
      status: 404,
    }));

    expect(() => recordContentPerformanceOutcome({
      scope: OWNER,
      itemId: owner.itemId,
      artifactId: owner.artifactId,
      revisionId: 999_999,
      idempotencyKey: 'performance-missing-revision-001',
      views: 100,
      retentionPct: 40,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentPerformanceLineageError>>({
      code: 'CONTENT_PERFORMANCE_TARGET_NOT_FOUND',
      status: 404,
    }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance').get()).toEqual({ count: 0 });
  });

  it('rolls back the outcome when lineage insertion fails', () => {
    const target = seedTarget(db, OWNER, 'rollback');
    db.exec(`
      CREATE TRIGGER test_block_performance_link
      BEFORE INSERT ON content_performance_workspace_links
      BEGIN
        SELECT RAISE(ABORT, 'injected lineage failure');
      END;
    `);

    expect(() => recordContentPerformanceOutcome({
      scope: OWNER,
      ...target,
      idempotencyKey: 'performance-rollback-001',
      views: 100,
      retentionPct: 40,
    }, db)).toThrow(/injected lineage failure/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance').get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_mutation_receipts
       WHERE operation = 'record_content_performance'
    `).get()).toEqual({ count: 0 });
  });

  it('rejects malformed metrics and unsafe legacy-shaped identifiers before writing', () => {
    const target = seedTarget(db, OWNER, 'validation');
    expect(() => recordContentPerformanceOutcome({
      scope: OWNER,
      ...target,
      idempotencyKey: 'performance-validation-001',
      views: -1,
      retentionPct: 101,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentPerformanceLineageError>>({
      code: 'CONTENT_PERFORMANCE_VALIDATION_FAILED',
      status: 400,
    }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_performance').get()).toEqual({ count: 0 });
  });
});

function seedTarget(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  suffix: string,
): { itemId: number; artifactId: number; revisionId: number } {
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Performance ${suffix}`,
    idempotencyKey: `performance-item-${suffix}-001`,
  }, db).value;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `Immutable script ${suffix}` },
    idempotencyKey: `performance-artifact-${suffix}-001`,
  }, db).value;
  return {
    itemId: item.id,
    artifactId: artifact.id,
    revisionId: artifact.currentRevisionId!,
  };
}
