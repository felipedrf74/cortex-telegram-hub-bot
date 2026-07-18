import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { assertContentTopicWorkspaceCompatibilityReady } from '../../src/services/content-topic-workspace-compat';
import { ensureContentTenantScopeColumns } from '../../src/services/content-tenant-scope';

const UP = readFileSync(resolve(process.cwd(), 'migrations/247_content_topics_workspace_exit.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/247_content_topics_workspace_exit.sql'), 'utf8');

describe('migration 247 content_topics canonical workspace exit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase({ stopBefore: '247_content_topics_workspace_exit.sql' });
  });

  afterEach(() => db.close());

  it('backfills only active private owner rows with stable compatibility ids and no false schedule/publication state', () => {
    const ownerId = seedLegacyTopic(db, {
      userId: 501,
      title: 'Race recap',
      status: 'planned',
      scheduledDate: '2032-07-20',
      secretaryTaskId: 'legacy-task-1',
    });
    const otherId = seedLegacyTopic(db, {
      userId: 777,
      title: 'Other owner idea',
      status: 'ready',
    });
    const publishedClaimId = seedLegacyTopic(db, {
      userId: 779,
      title: 'Historically marked published',
      status: 'published',
    });
    seedLegacyTopic(db, {
      userId: 888,
      tenantId: 999,
      title: 'Quarantined scope mismatch',
      status: 'drafting',
    });

    db.exec(UP);
    assertContentTopicWorkspaceCompatibilityReady(db);

    expect(db.prepare(`
      SELECT compat_topic_id, legacy_topic_id, tenant_id, owner_user_id, origin
        FROM content_topic_workspace_links
       ORDER BY compat_topic_id
    `).all()).toEqual([
      { compat_topic_id: ownerId, legacy_topic_id: ownerId, tenant_id: 501, owner_user_id: 501, origin: 'legacy_backfill' },
      { compat_topic_id: otherId, legacy_topic_id: otherId, tenant_id: 777, owner_user_id: 777, origin: 'legacy_backfill' },
      { compat_topic_id: publishedClaimId, legacy_topic_id: publishedClaimId, tenant_id: 779, owner_user_id: 779, origin: 'legacy_backfill' },
    ]);

    const owner = db.prepare(`
      SELECT item.production_state, item.artifact_phase, item.deadline_at,
             artifact.revision_count, artifact.current_revision_id
        FROM content_topic_workspace_links link
        JOIN content_domain_objects item ON item.id = link.workspace_item_id
        JOIN content_artifacts artifact ON artifact.id = link.compatibility_artifact_id
       WHERE link.compat_topic_id = ?
    `).get(ownerId);
    expect(owner).toEqual({
      production_state: 'inbox',
      artifact_phase: 'idea',
      deadline_at: '2032-07-20',
      revision_count: 0,
      current_revision_id: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM content_domain_objects WHERE production_state IN ('scheduled', 'published')").get())
      .toEqual({ count: 0 });

    const publishedClaim = db.prepare(`
      SELECT item.production_state,
             item.artifact_phase,
             item.approval_state,
             item.review_required,
             json_extract(link.legacy_snapshot_json, '$.status') AS legacy_status_claim,
             json_extract(link.legacy_snapshot_json, '$.title') AS legacy_title,
             json_extract(link.legacy_snapshot_json, '$.notes') AS legacy_notes,
             json_extract(item.audit_metadata_json, '$.migration.reasonCodes[0]') AS reason_code
        FROM content_topic_workspace_links link
        JOIN content_domain_objects item ON item.id = link.workspace_item_id
       WHERE link.compat_topic_id = ?
    `).get(publishedClaimId);
    expect(publishedClaim).toEqual({
      production_state: 'review',
      artifact_phase: 'final',
      approval_state: 'required',
      review_required: 1,
      legacy_status_claim: 'published',
      legacy_title: 'Historically marked published',
      legacy_notes: 'Historically marked published notes',
      reason_code: 'legacy_publication_claim_requires_verification',
    });
  });

  it('blocks old writers on migrated schema and re-upgrades an exact pre-247 snapshot without duplicates', () => {
    const firstId = seedLegacyTopic(db, {
      userId: 501,
      title: 'Before migration',
      status: 'planned',
      scheduledDate: '2032-07-20',
    });
    const preMigrationSnapshot = Buffer.from(db.serialize());

    db.exec(UP);
    expect(() => seedLegacyTopic(db, {
      userId: 501,
      title: 'Old binary split brain',
      status: 'drafting',
    })).toThrow('content_topics is read-only after canonical workspace migration 247');
    expect(() => db.prepare('UPDATE content_topics SET title = ? WHERE id = ?').run('Old update', firstId))
      .toThrow('content_topics is read-only after canonical workspace migration 247');
    expect(() => db.prepare('DELETE FROM content_topics WHERE id = ?').run(firstId))
      .toThrow('content_topics is read-only after canonical workspace migration 247');

    const restored = new Database(preMigrationSnapshot);
    restored.pragma('foreign_keys = ON');
    try {
      restored.prepare('UPDATE content_topics SET title = ?, status = ? WHERE id = ?')
        .run('Updated while exactly rolled back', 'drafting', firstId);
      const secondId = seedLegacyTopic(restored, {
        userId: 501,
        title: 'Created while exactly rolled back',
        status: 'planned',
        scheduledDate: '2032-07-21',
      });

      restored.exec(UP);
      restored.exec(UP);
      assertContentTopicWorkspaceCompatibilityReady(restored);

      expect(restored.prepare('SELECT legacy_topic_id, COUNT(*) AS count FROM content_topic_workspace_links GROUP BY legacy_topic_id ORDER BY legacy_topic_id').all())
        .toEqual([
          { legacy_topic_id: firstId, count: 1 },
          { legacy_topic_id: secondId, count: 1 },
        ]);
      expect(restored.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get()).toEqual({ count: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS count FROM content_domain_objects WHERE production_state IN ('scheduled', 'published')").get())
        .toEqual({ count: 0 });
    } finally {
      restored.close();
    }
  });

  it('allows only the existing short-lived legal-erasure gate to remove retired rows', () => {
    const ownerId = seedLegacyTopic(db, {
      userId: 901,
      title: 'Erase with the account',
      status: 'planned',
    });
    const otherId = seedLegacyTopic(db, {
      userId: 902,
      title: 'Different account',
      status: 'planned',
    });
    db.exec(UP);

    db.prepare(`
      INSERT INTO training_revision_erasure_authorizations (
        erasure_id, subject_user_id, reason, expires_at
      ) VALUES ('content-topic-erasure-test', 901, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
    `).run();

    expect(db.prepare('DELETE FROM content_topics WHERE id = ?').run(ownerId).changes).toBe(1);
    expect(() => db.prepare('DELETE FROM content_topics WHERE id = ?').run(otherId))
      .toThrow('content_topics is read-only after canonical workspace migration 247');
    expect(() => db.exec(DOWN)).toThrow(/CHECK constraint failed/i);
  });

  it('keeps dynamic tenant-scope repair away from the retired topic archive', () => {
    const quarantinedId = Number(db.prepare(`
      INSERT INTO content_topics (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
        scope_status, created_by, updated_by, title, status, audit_metadata_json
      ) VALUES (903, NULL, NULL, NULL, 'planned', NULL, 903, 903, 'Needs operator review', 'planned', '{}')
    `).run().lastInsertRowid);
    db.exec(UP);

    expect(() => ensureContentTenantScopeColumns(db)).not.toThrow();
    expect(db.prepare(`
      SELECT tenant_id, owner_user_id, visibility_scope, scope_status
        FROM content_topics
       WHERE id = ?
    `).get(quarantinedId)).toEqual({
      tenant_id: null,
      owner_user_id: null,
      visibility_scope: null,
      scope_status: null,
    });
  });

  it('allows an untouched rehearsal rollback but refuses rollback after canonical use', () => {
    seedLegacyTopic(db, { userId: 501, title: 'Untouched', status: 'planned' });
    db.exec(UP);
    db.exec(DOWN);

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_topic_workspace_links'").get())
      .toBeUndefined();
    expect(() => seedLegacyTopic(db, { userId: 501, title: 'Legacy writer restored', status: 'planned' }))
      .not.toThrow();

    const used = createMigratedTestDatabase({ stopBefore: '247_content_topics_workspace_exit.sql' });
    try {
      seedLegacyTopic(used, { userId: 777, title: 'Will change', status: 'planned' });
      used.exec(UP);
      used.prepare('UPDATE content_domain_objects SET workflow_version = workflow_version + 1 WHERE id IN (SELECT workspace_item_id FROM content_topic_workspace_links)')
        .run();
      expect(() => used.exec(DOWN)).toThrow(/CHECK constraint failed/i);
      expect(used.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_content_topics_canonical_exit_insert'").get())
        .toBeTruthy();
    } finally {
      used.close();
    }
  });
});

function seedLegacyTopic(
  db: Database.Database,
  input: {
    userId: number;
    tenantId?: number;
    title: string;
    status: 'planned' | 'drafting' | 'ready' | 'published' | 'cancelled';
    scheduledDate?: string | null;
    scheduledAt?: string | null;
    secretaryTaskId?: string | null;
  },
): number {
  const tenantId = input.tenantId ?? input.userId;
  const result = db.prepare(`
    INSERT INTO content_topics (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, title, notes,
      scheduled_date, scheduled_at, status,
      secretary_task_list_id, secretary_task_list_name,
      secretary_task_external_id, secretary_sync_status,
      audit_metadata_json
    ) VALUES (
      ?, ?, ?, 'user_private', ?,
      'active', ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, '{}'
    )
  `).run(
    input.userId,
    tenantId,
    input.userId,
    input.status,
    input.userId,
    input.userId,
    input.title,
    `${input.title} notes`,
    input.scheduledDate ?? null,
    input.scheduledAt ?? null,
    input.status,
    input.secretaryTaskId ? 'legacy-list' : null,
    input.secretaryTaskId ? 'Content' : null,
    input.secretaryTaskId ?? null,
    input.secretaryTaskId ? 'task_synced' : null,
  );
  return Number(result.lastInsertRowid);
}
