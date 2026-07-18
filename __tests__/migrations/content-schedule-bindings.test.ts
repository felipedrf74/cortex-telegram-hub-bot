// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContentArtifact, createContentWorkspaceItem } from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/244_content_schedule_bindings.sql'), 'utf8');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const START_AT = '2032-07-18T09:00:00.000Z';
const END_AT = '2032-07-18T10:00:00.000Z';

describe('migration 244 canonical Content schedule bindings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('persists one explicitly confirmed, immutable, Secretary-backed schedule', () => {
    const parent = seedParent(db, 501, 501, 'valid');
    const preview = insertPreview(db, parent, 'valid');
    beginConfirmation(db, preview.id, 'valid');
    insertSecretaryAgenda(db, parent, preview, 'content');
    const bindingId = insertBinding(db, parent, preview);

    db.prepare(`
      UPDATE content_schedule_previews
         SET status = 'confirmed', confirmed_at = ?, updated_at = ?
       WHERE id = ?
    `).run('2032-07-17T10:02:00.000Z', '2032-07-17T10:02:00.000Z', preview.id);

    expect(db.prepare(`
      SELECT state, provider_sync_state, publication_execution
        FROM content_schedule_bindings
       WHERE id = ?
    `).get(bindingId)).toEqual({
      state: 'scheduled',
      provider_sync_state: 'not_synced',
      publication_execution: 'not_performed',
    });
    expect(db.prepare('SELECT status FROM content_schedule_previews WHERE id = ?').get(preview.id))
      .toEqual({ status: 'confirmed' });

    expect(() => db.prepare('UPDATE content_schedule_bindings SET visible_title = ? WHERE id = ?')
      .run('Leaked private title', bindingId)).toThrow('content schedule binding inputs are immutable');
    expect(() => db.prepare('UPDATE content_schedule_bindings SET publication_execution = ? WHERE id = ?')
      .run('published', bindingId)).toThrow();
    expect(() => db.prepare('UPDATE content_schedule_previews SET expires_at = ? WHERE id = ?')
      .run('2033-01-01T00:00:00.000Z', preview.id)).toThrow('content schedule preview inputs are immutable');
  });

  it('rejects stale revision/workflow pins and cross-scope preview stitching', () => {
    const owner = seedParent(db, 501, 501, 'owner');
    const sameOwnerOther = seedParent(db, 501, 501, 'same-owner-other');
    const other = seedParent(db, 777, 777, 'other');

    expect(() => insertPreview(db, owner, 'bad-hash', { baseContentHash: HASH_B }))
      .toThrow('content schedule preview pin is stale or out of scope');
    expect(() => insertPreview(db, owner, 'bad-workflow', { baseWorkflowVersion: owner.workflowVersion + 1 }))
      .toThrow('content schedule preview pin is stale or out of scope');
    expect(() => insertPreview(db, owner, 'cross-tenant', {
      tenantId: other.tenantId,
      ownerUserId: other.ownerUserId,
    })).toThrow('content schedule preview pin is stale or out of scope');

    const ownerPreview = insertPreview(db, owner, 'owner-link');
    beginConfirmation(db, ownerPreview.id, 'owner-link');
    insertSecretaryAgenda(db, sameOwnerOther, ownerPreview, 'content');

    expect(() => insertBinding(db, sameOwnerOther, {
      ...ownerPreview,
    })).toThrow(/FOREIGN KEY constraint failed|preview is not being confirmed/i);
  });

  it('rejects malformed payloads, terminal-state bypass, and partial idempotency identities', () => {
    const parent = seedParent(db, 501, 501, 'shape');

    expect(() => insertPreview(db, parent, 'bad-json', { preferredWindowsJson: '{}' }))
      .toThrow(/CHECK constraint failed/i);
    expect(() => insertPreview(db, parent, 'bad-status', { status: 'failed' }))
      .toThrow('invalid initial content schedule preview status');

    const preview = insertPreview(db, parent, 'identity');
    expect(() => db.prepare("UPDATE content_schedule_previews SET status = 'submitting' WHERE id = ?")
      .run(preview.id)).toThrow('content schedule confirmation identity is required');
    expect(() => db.prepare(`
      UPDATE content_schedule_previews
         SET confirmation_request_hash = ?
       WHERE id = ?
    `).run(HASH_A, preview.id)).toThrow(/CHECK constraint failed/i);

    beginConfirmation(db, preview.id, 'identity');
    expect(() => db.prepare(`
      UPDATE content_schedule_previews
         SET status = 'confirmed', confirmed_at = ?
       WHERE id = ?
    `).run('2032-07-17T10:02:00.000Z', preview.id))
      .toThrow('content schedule preview cannot confirm without its binding');
    expect(() => db.prepare(`
      UPDATE content_schedule_previews
         SET confirmation_idempotency_key = ?, confirmation_request_hash = ?
       WHERE id = ?
    `).run('replacement', HASH_B, preview.id))
      .toThrow('content schedule preview confirmation is immutable once recorded');
  });

  it('requires an exact Content-owned Secretary agenda and preview disclosure', () => {
    const parent = seedParent(db, 501, 501, 'secretary');
    const preview = insertPreview(db, parent, 'secretary');
    beginConfirmation(db, preview.id, 'secretary');

    expect(() => insertBinding(db, parent, preview))
      .toThrow('content schedule binding Secretary scope mismatch');

    insertSecretaryAgenda(db, parent, preview, 'training');
    expect(() => insertBinding(db, parent, preview))
      .toThrow('content schedule binding Secretary scope mismatch');

    db.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?').run(preview.agendaItemId);
    insertSecretaryAgenda(db, parent, preview, 'content');
    expect(() => insertBinding(db, parent, preview, { visibleTitle: 'Private script title' }))
      .toThrow(/preview is not being confirmed|Secretary scope mismatch/i);
    expect(() => insertBinding(db, parent, preview, { scheduledEndAt: START_AT }))
      .toThrow();
    expect(() => insertBinding(db, parent, preview, { providerSyncState: 'unknown' }))
      .toThrow();
  });

  it('enforces one active schedule and legal, immutable cancellation state', () => {
    const parent = seedParent(db, 501, 501, 'lifecycle');
    const first = insertPreview(db, parent, 'lifecycle-first');
    beginConfirmation(db, first.id, 'lifecycle-first');
    insertSecretaryAgenda(db, parent, first, 'content');
    const bindingId = insertBinding(db, parent, first);

    const second = insertPreview(db, parent, 'lifecycle-second');
    beginConfirmation(db, second.id, 'lifecycle-second');
    insertSecretaryAgenda(db, parent, second, 'content');
    expect(() => insertBinding(db, parent, second)).toThrow(/UNIQUE constraint failed/i);

    expect(() => db.prepare("UPDATE content_schedule_bindings SET state = 'cancel_failed' WHERE id = ?")
      .run(bindingId)).toThrow();
    db.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancel_pending', cancellation_idempotency_key = ?,
             cancellation_request_hash = ?, updated_at = ?
       WHERE id = ?
    `).run('cancel-lifecycle-001', HASH_A, '2032-07-17T11:00:00.000Z', bindingId);
    expect(() => insertBinding(db, parent, second)).toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare(`
      UPDATE content_schedule_bindings
         SET cancellation_idempotency_key = ?, cancellation_request_hash = ?
       WHERE id = ?
    `).run('cancel-replacement', HASH_B, bindingId))
      .toThrow('content schedule binding cancellation is immutable once recorded');
    db.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ?
    `).run('2032-07-17T11:01:00.000Z', '2032-07-17T11:01:00.000Z', bindingId);
    expect(db.prepare('SELECT state, cancelled_at FROM content_schedule_bindings WHERE id = ?').get(bindingId))
      .toEqual({ state: 'cancelled', cancelled_at: '2032-07-17T11:01:00.000Z' });
    expect(insertBinding(db, parent, second)).toBeGreaterThan(bindingId);
  });

  it('refuses rollback while schedule evidence still exists', () => {
    const parent = seedParent(db, 501, 501, 'rollback-guard');
    const preview = insertPreview(db, parent, 'rollback-guard');
    beginConfirmation(db, preview.id, 'rollback-guard');
    insertSecretaryAgenda(db, parent, preview, 'content');
    insertBinding(db, parent, preview);

    expect(() => db.exec(DOWN)).toThrow(/CHECK constraint failed/i);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_schedule_bindings'").get())
      .toBeTruthy();
  });

  it('cascades account erasure and rolls back only its additive schema', () => {
    const parent = seedParent(db, 501, 501, 'erasure');
    const preview = insertPreview(db, parent, 'erasure');
    beginConfirmation(db, preview.id, 'erasure');
    insertSecretaryAgenda(db, parent, preview, 'content');
    insertBinding(db, parent, preview);

    db.prepare('DELETE FROM content_domain_objects WHERE id = ?').run(parent.itemId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_schedule_previews').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get()).toEqual({ count: 0 });

    db.exec(DOWN);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).not.toContain('content_schedule_previews');
    expect(names).not.toContain('content_schedule_bindings');
    expect(names).not.toContain('idx_content_revisions_schedule_scope');
    expect(names).not.toContain('idx_content_artifacts_schedule_scope');
    expect(names).toContain('content_artifacts');
    expect(names).toContain('content_revisions');
    expect(names).toContain('idx_content_revisions_agent_job_scope');
  });
});

interface ParentFixture {
  tenantId: number;
  ownerUserId: number;
  itemId: number;
  artifactId: number;
  revisionId: number;
  revisionNumber: number;
  contentHash: string;
  workflowVersion: number;
}

interface PreviewFixture {
  id: number;
  previewKey: string;
  sourceIntentId: string;
  agendaItemId: string;
  visibleTitle: string;
}

interface PreviewOverrides {
  tenantId?: number;
  ownerUserId?: number;
  baseContentHash?: string;
  baseWorkflowVersion?: number;
  preferredWindowsJson?: string;
  status?: string;
}

interface BindingOverrides {
  visibleTitle?: string;
  scheduledEndAt?: string;
  providerSyncState?: string;
}

function seedParent(
  db: Database.Database,
  tenantId: number,
  ownerUserId: number,
  suffix: string,
): ParentFixture {
  const scope = { tenantId, userId: ownerUserId };
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Schedule migration ${suffix}`,
    idempotencyKey: `schedule-migration-item-${suffix}-001`,
  }, db).value;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `Schedule script ${suffix}` },
    idempotencyKey: `schedule-migration-artifact-${suffix}-001`,
  }, db).value;
  const row = db.prepare('SELECT workflow_version FROM content_domain_objects WHERE id = ?').get(item.id) as { workflow_version: number };
  return {
    tenantId,
    ownerUserId,
    itemId: item.id,
    artifactId: artifact.id,
    revisionId: artifact.currentRevision!.id,
    revisionNumber: artifact.currentRevision!.revisionNumber,
    contentHash: artifact.currentRevision!.contentHash,
    workflowVersion: Number(row.workflow_version),
  };
}

function previewIdentity(suffix: string): PreviewFixture {
  return {
    id: 0,
    previewKey: `csp_${suffix}`,
    sourceIntentId: `content-schedule-intent-${suffix}`,
    agendaItemId: `sai_content_${suffix}`,
    visibleTitle: 'Content work: Record',
  };
}

function insertPreview(
  db: Database.Database,
  parent: ParentFixture,
  suffix: string,
  overrides: PreviewOverrides = {},
): PreviewFixture {
  const identity = previewIdentity(suffix);
  const result = db.prepare(`
    INSERT INTO content_schedule_previews (
      preview_key, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
      base_revision_number, base_content_hash, base_workflow_version,
      work_kind, duration_minutes, preferred_windows_json, deadline_at,
      priority, title_disclosure, visible_title, context_shared_json,
      intent_json, preview_result_json, preview_fingerprint, status,
      create_idempotency_key, create_request_hash, secretary_source_intent_id,
      expires_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'record', 60, ?, NULL,
              'normal', 'generic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.previewKey,
    overrides.tenantId ?? parent.tenantId,
    overrides.ownerUserId ?? parent.ownerUserId,
    parent.itemId,
    parent.artifactId,
    parent.revisionId,
    parent.revisionNumber,
    overrides.baseContentHash ?? parent.contentHash,
    overrides.baseWorkflowVersion ?? parent.workflowVersion,
    overrides.preferredWindowsJson ?? JSON.stringify([{ start: START_AT, end: END_AT }]),
    identity.visibleTitle,
    JSON.stringify(['content_item_reference', 'work_kind', 'duration', 'preferred_windows']),
    JSON.stringify({ intentId: identity.sourceIntentId, sourceSkill: 'content' }),
    JSON.stringify({ status: 'scheduled', selectedSlot: { start: START_AT, end: END_AT } }),
    HASH_A,
    overrides.status ?? 'previewed',
    `create-${suffix}-001`,
    HASH_A,
    identity.sourceIntentId,
    '2032-07-17T10:15:00.000Z',
    parent.ownerUserId,
  );
  return { ...identity, id: Number(result.lastInsertRowid) };
}

function beginConfirmation(db: Database.Database, previewId: number, suffix: string): void {
  const identity = previewIdentity(suffix);
  db.prepare(`
    UPDATE content_schedule_previews
       SET status = 'submitting', confirmation_idempotency_key = ?,
           confirmation_request_hash = ?, secretary_agenda_item_id = ?,
           updated_at = ?
     WHERE id = ?
  `).run(
    `confirm-${suffix}-001`,
    HASH_A,
    identity.agendaItemId,
    '2032-07-17T10:01:00.000Z',
    previewId,
  );
}

function insertSecretaryAgenda(
  db: Database.Database,
  parent: ParentFixture,
  preview: PreviewFixture,
  sourceSkill: string,
): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, intent_action,
      owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, source_shape_hash, scheduled_segments_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'schedule_this', ?, ?, 'scheduled', 'not_synced',
              1, ?, ?, ?, 60, 'scheduled', '[]', ?, '[]', ?, ?)
  `).run(
    preview.agendaItemId,
    preview.sourceIntentId,
    sourceSkill,
    parent.ownerUserId,
    String(parent.tenantId),
    preview.visibleTitle,
    START_AT,
    END_AT,
    HASH_A,
    '2032-07-17T10:01:30.000Z',
    '2032-07-17T10:01:30.000Z',
  );
}

function insertBinding(
  db: Database.Database,
  parent: ParentFixture,
  preview: PreviewFixture,
  overrides: BindingOverrides = {},
): number {
  const result = db.prepare(`
    INSERT INTO content_schedule_bindings (
      tenant_id, owner_user_id, item_id, artifact_id, revision_id,
      base_revision_number, base_workflow_version, preview_id,
      secretary_agenda_item_id, secretary_source_intent_id, state,
      scheduled_start_at, scheduled_end_at, visible_title, title_disclosure,
      context_shared_json, provider_sync_state, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, 'generic', ?, ?, ?)
  `).run(
    parent.tenantId,
    parent.ownerUserId,
    parent.itemId,
    parent.artifactId,
    parent.revisionId,
    parent.revisionNumber,
    parent.workflowVersion,
    preview.id,
    preview.agendaItemId,
    preview.sourceIntentId,
    START_AT,
    overrides.scheduledEndAt ?? END_AT,
    overrides.visibleTitle ?? preview.visibleTitle,
    JSON.stringify(['content_item_reference', 'work_kind', 'duration', 'preferred_windows']),
    overrides.providerSyncState ?? 'not_synced',
    parent.ownerUserId,
  );
  return Number(result.lastInsertRowid);
}
