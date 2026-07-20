import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

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

import {
  getContentWorkspacePipelineOperationalMetrics,
  getContentWorkspacePipelineStats,
  getContentWorkspaceRecentItems,
  getContentWorkspaceSummaryCounts,
  getContentWorkspaceTodaySummary,
  getRecentContentWorkspaceScripts,
  resolveContentWorkspaceIdentifier,
} from '../../src/services/content-workspace-read-models';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  saveContentRevision,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import {
  confirmContentSchedulePreview,
  createContentSchedulePreview,
} from '../../src/services/content-workspace-scheduling';

const SCOPE_A = { tenantId: 101, userId: 501 };
const SCOPE_B = { tenantId: 202, userId: 502 };

describe('content workspace operational read models', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb?.close());

  it('derives scoped pipeline inventory without reading frozen legacy roots', () => {
    seedItem(SCOPE_A, 'Tenant A idea', 'active', 'idea', '-5 days');
    seedItem(SCOPE_A, 'Tenant A script', 'active', 'draft', '-9 days');
    seedItem(SCOPE_B, 'Tenant B private item', 'active', 'draft', '-20 days');

    const stats = getContentWorkspacePipelineStats(SCOPE_A, testDb);
    const recent = getContentWorkspaceRecentItems(SCOPE_A, 20, testDb);

    expect(stats).toMatchObject({
      availability: 'available',
      source: 'content_workspace',
      stages: { approved: 1, scripted: 1, filming: 0, editing: 0, published: 0 },
      totalActive: 2,
    });
    expect(stats.stageTracking.filming).toMatchObject({
      tracking: 'not_modeled',
      reasonCode: 'CONTENT_FILMING_STATE_NOT_MODELED',
    });
    expect(recent.map((item) => item.topicTitle)).toEqual(['Tenant A idea', 'Tenant A script']);
    expect(JSON.stringify({ stats, recent })).not.toContain('Tenant B private item');
  });

  it('counts publication only from canonical workflow events', () => {
    const verified = seedItem(SCOPE_A, 'Verified publication', 'published', 'final', '-2 days');
    seedWorkflowEvent(SCOPE_A, verified, 'approved', 'published', '-2 days');
    seedItem(SCOPE_A, 'Unverified state only', 'published', 'final', '-1 day');

    const stats = getContentWorkspacePipelineStats(SCOPE_A, testDb);
    const metrics = getContentWorkspacePipelineOperationalMetrics(SCOPE_A, testDb);

    expect(stats.stages.published).toBe(2);
    expect(stats.publishedThisWeek).toBe(1);
    expect(metrics.totalPublished).toBe(1);
    expect(metrics.weeklyThroughput[3]).toBe(1);
  });

  it('returns complete Today counts beyond the bounded library page and stays tenant scoped', () => {
    for (let index = 0; index < 125; index += 1) {
      seedItem(
        SCOPE_A,
        `Inventory ${index}`,
        index < 40 ? 'inbox' : index < 90 ? 'active' : index < 110 ? 'review' : 'approved',
        'idea',
      );
    }
    seedItem(SCOPE_A, 'Published item', 'published', 'final');
    seedItem(SCOPE_B, 'Private other-tenant item', 'active', 'idea');

    expect(getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-18T12:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      schemaVersion: 'content-workspace-today-summary-v1',
      source: 'content_workspace_and_secretary',
      complete: true,
      itemCount: 126,
      inboxCount: 40,
      activeCount: 50,
      reviewCount: 20,
      approvedCount: 15,
      publishedCount: 1,
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
      scheduleAuthorityStatus: 'current',
      scheduleSemantics: 'private_work_session',
      publicationExecution: 'not_performed',
    });
    expect(getContentWorkspaceSummaryCounts(
      SCOPE_A,
      testDb,
      new Date('2032-07-17T08:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      scheduledThisWeek: 0,
      scheduleAttentionThisWeek: 0,
      scheduleAuthorityStatus: 'current',
    });
  });

  it('counts only current confirmed work blocks and exposes unavailable authority as incomplete attention', () => {
    const currentItemId = seedConfirmedSchedule('today-current');
    const staleItemId = seedConfirmedSchedule('today-stale');
    const staleAgenda = testDb.prepare(`
      SELECT secretary_agenda_item_id
        FROM content_schedule_bindings
       WHERE item_id = ?
    `).get(staleItemId) as { secretary_agenda_item_id: string };
    testDb.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?')
      .run(staleAgenda.secretary_agenda_item_id);

    expect(getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-18T12:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      complete: false,
      itemCount: 2,
      privateWorkBlockCount: 1,
      scheduleAttentionCount: 1,
      scheduleAuthorityStatus: 'partially_unavailable',
    });
    expect(getContentWorkspaceSummaryCounts(
      SCOPE_A,
      testDb,
      new Date('2032-07-17T08:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      scheduledThisWeek: 1,
      scheduleAttentionThisWeek: 1,
      scheduleAuthorityStatus: 'partially_unavailable',
    });
    expect(currentItemId).not.toBe(staleItemId);
  });

  it('does not misreport provider or cancellation failures as confirmed work blocks', () => {
    const syncFailedItemId = seedConfirmedSchedule('today-sync-failed');
    const cancelFailedItemId = seedConfirmedSchedule('today-cancel-failed');
    const syncFailedAgenda = scheduleAgendaId(syncFailedItemId);
    const cancelFailedAgenda = scheduleAgendaId(cancelFailedItemId);
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_state = 'create_failed'
       WHERE agenda_item_id = ?
    `).run(syncFailedAgenda);
    testDb.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancel_pending',
             cancellation_idempotency_key = 'today-cancel-failed-key',
             cancellation_request_hash = '0000000000000000000000000000000000000000000000000000000000000000',
             provider_sync_state = 'delete_failed'
       WHERE item_id = ?
    `).run(cancelFailedItemId);
    testDb.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancel_failed'
       WHERE item_id = ?
    `).run(cancelFailedItemId);
    testDb.prepare(`
      UPDATE secretary_agenda_items SET provider_sync_state = 'delete_failed'
       WHERE agenda_item_id = ?
    `).run(cancelFailedAgenda);
    testDb.prepare(`
      UPDATE secretary_agenda_items SET lifecycle_state = 'completed'
       WHERE agenda_item_id = ?
    `).run(cancelFailedAgenda);

    expect(getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-18T12:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      complete: true,
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 2,
      scheduleAuthorityStatus: 'current',
    });
    expect(getContentWorkspaceSummaryCounts(
      SCOPE_A,
      testDb,
      new Date('2032-07-17T08:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      scheduledThisWeek: 0,
      scheduleAttentionThisWeek: 2,
      scheduleAuthorityStatus: 'current',
    });
  });

  it('limits Today work-block counts to the caller timezone day', () => {
    seedConfirmedSchedule('today-window');

    expect(getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-17T12:00:00.000Z'),
      'UTC',
    )).toMatchObject({
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
      scheduleAuthorityStatus: 'current',
    });
    expect(getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-18T00:15:00.000Z'),
      'America/Los_Angeles',
    )).toMatchObject({
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
    });
  });

  it('rejects invalid caller timezones instead of returning misleading schedule totals', () => {
    expect(() => getContentWorkspaceTodaySummary(
      SCOPE_A,
      testDb,
      new Date('2032-07-18T12:00:00.000Z'),
      'Invalid/Content-Zone',
    )).toThrow(/timezone is invalid/i);
  });

  it('reports schedule authority unavailable when its projection tables are missing', () => {
    testDb.exec('DROP TABLE secretary_agenda_items');
    seedItem(SCOPE_A, 'Unschedulable item', 'active', 'idea');

    expect(getContentWorkspaceTodaySummary(SCOPE_A, testDb)).toMatchObject({
      complete: false,
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
      scheduleAuthorityStatus: 'unavailable',
    });
    expect(getContentWorkspaceSummaryCounts(SCOPE_A, testDb)).toMatchObject({
      scheduledThisWeek: 0,
      scheduleAttentionThisWeek: 0,
      scheduleAuthorityStatus: 'unavailable',
    });
  });

  it('removes a terminally cancelled schedule from both confirmed and attention totals', () => {
    const itemId = seedConfirmedSchedule('today-cancelled');
    testDb.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancel_pending',
             cancellation_idempotency_key = 'today-cancelled-key',
             cancellation_request_hash = '1111111111111111111111111111111111111111111111111111111111111111',
             provider_sync_state = 'deleted'
       WHERE item_id = ?
    `).run(itemId);
    testDb.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancelled', cancelled_at = '2032-07-17T08:01:00.000Z'
       WHERE item_id = ?
    `).run(itemId);

    expect(getContentWorkspaceTodaySummary(SCOPE_A, testDb)).toMatchObject({
      complete: true,
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
      scheduleAuthorityStatus: 'current',
    });
  });

  it('counts a canonical publication earlier in the current SQLite second', () => {
    const itemId = seedItem(SCOPE_A, 'Same-second publication', 'published', 'final');
    testDb.prepare(`
      INSERT INTO content_workflow_events (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, action, from_state, to_state,
        actor_user_id, created_at
      ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
        'workspace_state_changed', 'approved', 'published', ?, '2026-07-17 12:00:00')
    `).run(SCOPE_A.tenantId, SCOPE_A.userId, String(itemId), SCOPE_A.userId);

    const stats = getContentWorkspacePipelineStats(
      SCOPE_A,
      testDb,
      new Date('2026-07-17T12:00:00.250Z'),
    );

    expect(stats.publishedThisWeek).toBe(1);
  });

  it('resolves a scoped legacy ID through immutable ingress metadata only', () => {
    const itemId = seedItem(SCOPE_A, 'Imported item', 'review', 'idea');
    testDb.prepare(`
      INSERT INTO content_workspace_ingress_bindings (
        tenant_id, owner_user_id, source_kind, source_id, item_id,
        content_parity_status, ingress_origin
      ) VALUES (?, ?, 'legacy_pipeline', '77', ?, 'metadata_only', 'legacy_pipeline_backfill')
    `).run(SCOPE_A.tenantId, SCOPE_A.userId, itemId);

    expect(resolveContentWorkspaceIdentifier(SCOPE_A, 77, testDb)).toEqual({
      requestedId: 77,
      itemId,
      resolvedAs: 'legacy_pipeline_binding',
    });
    expect(resolveContentWorkspaceIdentifier(SCOPE_B, 77, testDb)).toBeNull();
  });

  it('requires explicit valid tenant and user scope', () => {
    expect(() => getContentWorkspacePipelineStats({ tenantId: 0, userId: 501 }, testDb))
      .toThrow(/valid tenant and user scope/i);
  });

  it('feeds learning agents only scoped current script revisions', () => {
    const item = createContentWorkspaceItem({
      scope: SCOPE_A,
      itemType: 'content_item',
      title: 'Canonical voice sample',
      idempotencyKey: 'read-model-voice-item-a-001',
    }, testDb).value;
    const artifact = createContentArtifact({
      scope: SCOPE_A,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Superseded voice phrase.' },
      idempotencyKey: 'read-model-voice-artifact-a-001',
    }, testDb).value;
    saveContentRevision({
      scope: SCOPE_A,
      artifactId: artifact.id,
      baseRevision: 1,
      content: {
        format: 'structured_json',
        document: { hook: 'Current hook', sections: [{ spoken: 'Current voice phrase.' }] },
      },
      actorType: 'user',
      idempotencyKey: 'read-model-voice-revision-a-002',
    }, testDb);

    const privateItem = createContentWorkspaceItem({
      scope: SCOPE_B,
      itemType: 'content_item',
      title: 'Other tenant voice sample',
      idempotencyKey: 'read-model-voice-item-b-001',
    }, testDb).value;
    createContentArtifact({
      scope: SCOPE_B,
      itemId: privateItem.id,
      expectedWorkflowVersion: privateItem.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Private tenant voice phrase.' },
      idempotencyKey: 'read-model-voice-artifact-b-001',
    }, testDb);

    const scripts = getRecentContentWorkspaceScripts(SCOPE_A, 30, 10, testDb);
    expect(getContentWorkspaceItem(SCOPE_A, item.id, testDb)).not.toBeNull();
    expect(scripts).toEqual([
      expect.objectContaining({
        itemId: item.id,
        artifactId: artifact.id,
        revisionNumber: 2,
        topic: 'Canonical voice sample',
        text: 'Current hook\nCurrent voice phrase.',
      }),
    ]);
    expect(JSON.stringify(scripts)).not.toContain('Superseded voice phrase');
    expect(JSON.stringify(scripts)).not.toContain('Private tenant voice phrase');
  });
});

function seedItem(
  scope: { tenantId: number; userId: number },
  title: string,
  productionState: string,
  artifactPhase: string,
  updatedOffset = '0 days',
): number {
  const result = testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(
    scope.tenantId,
    scope.userId,
    productionState,
    title,
    productionState,
    artifactPhase,
    scope.userId,
    scope.userId,
    updatedOffset,
    updatedOffset,
  );
  return Number(result.lastInsertRowid);
}

function seedWorkflowEvent(
  scope: { tenantId: number; userId: number },
  itemId: number,
  fromState: string,
  toState: string,
  offset: string,
): void {
  testDb.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      actor_user_id, created_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
      'workspace_state_changed', ?, ?, ?, datetime('now', ?))
  `).run(scope.tenantId, scope.userId, String(itemId), fromState, toState, scope.userId, offset);
}

function seedConfirmedSchedule(suffix: string): number {
  const created = createContentWorkspaceItem({
    scope: SCOPE_A,
    itemType: 'content_item',
    title: `Scheduled ${suffix}`,
    idempotencyKey: `today-item-${suffix}`,
  }, testDb).value;
  createContentArtifact({
    scope: SCOPE_A,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'plain_text', text: `Script ${suffix}` },
    idempotencyKey: `today-artifact-${suffix}`,
  }, testDb);
  let item = getContentWorkspaceItem(SCOPE_A, created.id, testDb)!;
  item = transitionContentWorkspaceItem({
    scope: SCOPE_A,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `today-review-${suffix}`,
  }, testDb).value;
  item = transitionContentWorkspaceItem({
    scope: SCOPE_A,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `today-approve-${suffix}`,
  }, testDb).value;
  const preview = createContentSchedulePreview({
    scope: SCOPE_A,
    itemId: item.id,
    workKind: 'review',
    durationMinutes: 30,
    preferredWindows: [{
      start: '2032-07-18T09:00:00.000Z',
      end: '2032-07-18T10:00:00.000Z',
    }],
    idempotencyKey: `today-preview-${suffix}`,
    now: '2032-07-17T08:00:00.000Z',
  }, testDb);
  confirmContentSchedulePreview({
    scope: SCOPE_A,
    previewKey: preview.value.previewKey,
    idempotencyKey: `today-confirm-${suffix}`,
    now: '2032-07-17T08:00:00.000Z',
  }, testDb);
  return item.id;
}

function scheduleAgendaId(itemId: number): string {
  return (testDb.prepare(`
    SELECT secretary_agenda_item_id
      FROM content_schedule_bindings
     WHERE item_id = ?
  `).get(itemId) as { secretary_agenda_item_id: string }).secretary_agenda_item_id;
}
