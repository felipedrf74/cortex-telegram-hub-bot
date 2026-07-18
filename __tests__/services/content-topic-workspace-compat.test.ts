import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  assertContentTopicWorkspaceCompatibilityReady,
  createContentTopicCompatibility,
  deleteContentTopicCompatibility,
  findContentTopicCompatibilityByClientRequestId,
  findContentTopicCompatibilityUpdateReplay,
  getContentTopicCompatibility,
  hasContentTopicCompatibilityDeleteReplay,
  listContentTopicCompatibility,
  updateContentTopicCompatibility,
} from '../../src/services/content-topic-workspace-compat';
import { createContentArtifact, getContentWorkspaceItem } from '../../src/services/content-workspace';

const UP = readFileSync(resolve(process.cwd(), 'migrations/247_content_topics_workspace_exit.sql'), 'utf8');
const SCOPE = { tenantId: 501, userId: 501 };

describe('content topic canonical workspace compatibility', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('creates and replays one canonical idea, artifact, and revision without writing content_topics', () => {
    const created = createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Open water confidence',
      notes: 'Make the first step practical.',
      source: 'capture',
      idempotencyKey: 'topic-create-001',
    }, db);
    const replay = createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Open water confidence',
      notes: 'Make the first step practical.',
      source: 'capture',
      idempotencyKey: 'topic-create-001',
    }, db);

    expect(created).toMatchObject({ created: true, replayed: false });
    expect(replay).toMatchObject({ created: false, replayed: true });
    expect(replay.topic.id).toBe(created.topic.id);
    expect(replay.topic.workspace_item_id).toBe(created.topic.workspace_item_id);
    expect(findContentTopicCompatibilityByClientRequestId(SCOPE, 'topic-create-001', db)?.id)
      .toBe(created.topic.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_topics').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE id = ?').get(created.topic.workspace_item_id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT revision_count FROM content_artifacts WHERE id = ?').get(created.topic.compatibility_artifact_id))
      .toEqual({ revision_count: 1 });

    expect(() => createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Different request',
      idempotencyKey: 'topic-create-001',
    }, db)).toThrow('already used for a different request');
    expect(() => createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Open water confidence',
      notes: 'Make the first step practical.',
      source: 'capture',
      status: 'drafting',
      idempotencyKey: 'topic-create-001',
    }, db)).toThrow('already used for a different request');
  });

  it('updates content through immutable revisions, maps legacy state safely, and never infers scheduling or publication', () => {
    const created = createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Race recap',
      idempotencyKey: 'topic-update-create-001',
    }, db).topic;
    const updated = updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: created.id,
      title: 'Race recap: three lessons',
      notes: 'Keep the final takeaway concise.',
      scheduledDate: '2032-07-20',
      status: 'ready',
      idempotencyKey: 'topic-update-001',
    }, db)!;

    expect(updated).toMatchObject({
      title: 'Race recap: three lessons',
      notes: 'Keep the final takeaway concise.',
      scheduled_date: '2032-07-20',
      scheduled_at: null,
      status: 'ready',
      secretary_task_external_id: null,
      calendar_event_id: null,
      secretary_sync_status: 'workspace_confirmation_required',
      schedule_semantics: 'workspace_deadline',
    });
    expect(db.prepare('SELECT production_state, deadline_at FROM content_domain_objects WHERE id = ?').get(updated.workspace_item_id))
      .toEqual({ production_state: 'review', deadline_at: '2032-07-20T00:00:00.000Z' });
    expect(db.prepare('SELECT revision_count FROM content_artifacts WHERE id = ?').get(updated.compatibility_artifact_id))
      .toEqual({ revision_count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings WHERE item_id = ?').get(updated.workspace_item_id))
      .toEqual({ count: 0 });

    const replay = updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: created.id,
      title: 'Race recap: three lessons',
      notes: 'Keep the final takeaway concise.',
      scheduledDate: '2032-07-20',
      status: 'ready',
      idempotencyKey: 'topic-update-001',
    }, db)!;
    expect(replay.workspace_item_id).toBe(updated.workspace_item_id);
    expect(findContentTopicCompatibilityUpdateReplay({
      scope: SCOPE,
      compatTopicId: created.id,
      title: 'Race recap: three lessons',
      notes: 'Keep the final takeaway concise.',
      scheduledDate: '2032-07-20',
      status: 'ready',
      idempotencyKey: 'topic-update-001',
    }, db)?.workspace_item_id).toBe(updated.workspace_item_id);
    expect(db.prepare('SELECT revision_count FROM content_artifacts WHERE id = ?').get(updated.compatibility_artifact_id))
      .toEqual({ revision_count: 2 });
    expect(() => updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: created.id,
      notes: 'Different retry payload.',
      idempotencyKey: 'topic-update-001',
    }, db)).toThrow('already used for a different request');

    expect(() => updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: created.id,
      status: 'published',
      idempotencyKey: 'topic-false-publish-001',
    }, db)).toThrow('Publication cannot be inferred');
    expect(db.prepare('SELECT production_state FROM content_domain_objects WHERE id = ?').get(updated.workspace_item_id))
      .toEqual({ production_state: 'review' });
  });

  it('soft deletes canonically, isolates tenants, and keeps the retired table untouched', () => {
    const created = createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Private idea',
      idempotencyKey: 'topic-delete-create-001',
    }, db).topic;

    expect(getContentTopicCompatibility({ tenantId: 777, userId: 777 }, created.id, db)).toBeNull();
    expect(listContentTopicCompatibility({ scope: { tenantId: 777, userId: 777 } }, db)).toEqual([]);
    expect(deleteContentTopicCompatibility(SCOPE, created.id, { idempotencyKey: 'topic-delete-001' }, db)).toBe(true);
    expect(deleteContentTopicCompatibility(SCOPE, created.id, { idempotencyKey: 'topic-delete-001' }, db)).toBe(true);
    expect(hasContentTopicCompatibilityDeleteReplay(
      SCOPE,
      created.id,
      { idempotencyKey: 'topic-delete-001' },
      db,
    )).toBe(true);
    expect(getContentTopicCompatibility(SCOPE, created.id, db)).toBeNull();
    expect(db.prepare('SELECT scope_status, deleted_at IS NOT NULL AS deleted FROM content_domain_objects WHERE id = ?').get(created.workspace_item_id))
      .toEqual({ scope_status: 'deleted', deleted: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_topics').get()).toEqual({ count: 0 });
  });

  it('refuses the legacy editor after another canonical artifact becomes current', () => {
    const created = createContentTopicCompatibility({
      scope: SCOPE,
      title: 'Develop this idea',
      idempotencyKey: 'topic-evolved-create-001',
    }, db).topic;
    const current = getContentWorkspaceItem(SCOPE, created.workspace_item_id, db)!;
    createContentArtifact({
      scope: SCOPE,
      itemId: created.workspace_item_id,
      expectedWorkflowVersion: current.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'User-authored script.' },
      idempotencyKey: 'topic-evolved-script-001',
    }, db);

    expect(() => updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: created.id,
      notes: 'This must not overwrite or replace the script.',
      idempotencyKey: 'topic-evolved-edit-001',
    }, db)).toThrow('Continue editing it in the Content workspace');
    expect(db.prepare('SELECT current_artifact_id FROM content_domain_objects WHERE id = ?').get(created.workspace_item_id))
      .not.toEqual({ current_artifact_id: created.compatibility_artifact_id });
  });

  it('keeps imported Secretary references read-only and suppresses them after explicit cleanup retirement', () => {
    db.close();
    db = createMigratedTestDatabase({ stopBefore: '247_content_topics_workspace_exit.sql' });
    const result = db.prepare(`
      INSERT INTO content_topics (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
        scope_status, created_by, updated_by, title, notes, scheduled_date,
        status, secretary_task_list_id, secretary_task_list_name,
        secretary_task_external_id, secretary_sync_status, audit_metadata_json
      ) VALUES (501, 501, 501, 'user_private', 'planned', 'active', 501, 501,
        'Imported schedule', 'Private notes', '2032-07-20', 'planned',
        'legacy-list', 'Content', 'legacy-task', 'task_synced', '{}')
    `).run();
    db.exec(UP);

    const imported = getContentTopicCompatibility(SCOPE, Number(result.lastInsertRowid), db)!;
    expect(imported).toMatchObject({
      secretary_task_external_id: 'legacy-task',
      schedule_semantics: 'legacy_external_reference',
    });
    const retired = updateContentTopicCompatibility({
      scope: SCOPE,
      compatTopicId: imported.id,
      scheduledDate: null,
      scheduledAt: null,
      retireLegacySchedule: true,
      idempotencyKey: 'retire-legacy-schedule-001',
    }, db)!;
    expect(retired).toMatchObject({
      scheduled_date: null,
      scheduled_at: null,
      secretary_task_external_id: null,
      schedule_semantics: 'none',
    });
    expect(db.prepare('SELECT secretary_task_external_id FROM content_topics WHERE id = ?').get(imported.id))
      .toEqual({ secretary_task_external_id: 'legacy-task' });
  });

  it('fails readiness when a migration writer guard is missing', () => {
    expect(() => assertContentTopicWorkspaceCompatibilityReady(db)).not.toThrow();
    db.exec('DROP TRIGGER trg_content_topics_canonical_exit_insert');
    expect(() => assertContentTopicWorkspaceCompatibilityReady(db))
      .toThrow('content_topic_workspace_compatibility_schema_not_ready');
  });
});
