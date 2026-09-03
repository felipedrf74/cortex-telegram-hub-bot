/**
 * CONTENT-UI-O3 (2026-05-04): Content Performance aggregate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
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
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import { getContentPerformanceAggregate } from '../../src/state/content-performance-aggregate';
import { recordRadarFeedback } from '../../src/state/content-radar-feedback';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import {
  confirmContentSchedulePreview,
  createContentSchedulePreview,
} from '../../src/services/content-workspace-scheduling';


const USER_A = 3001;
const USER_B = 3002;

function insertTopic(
  userId: number,
  tenantId: number,
  status: string,
  scheduledDate: string | null = null,
  daysAgo = 0,
): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  const productionState = status === 'published'
    ? 'published'
    : status === 'drafting'
      ? 'active'
      : 'inbox';
  const artifactPhase = status === 'published'
    ? 'final'
    : status === 'drafting'
      ? 'draft'
      : 'idea';
  const result = testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      deadline_at, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?, ?, ?, ?, ?, ?, ?, ${dateExpr}, ${dateExpr})
  `).run(
    tenantId,
    userId,
    productionState,
    `Topic for ${userId}-${status}-${Math.random()}`,
    productionState,
    artifactPhase,
    scheduledDate,
    userId,
    userId,
  );
  if (status === 'published') {
    testDb.prepare(`
      INSERT INTO content_workflow_events (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, action, from_state, to_state,
        actor_user_id, created_at
      ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
        'workspace_state_changed', 'approved', 'published', ?, ${dateExpr})
    `).run(tenantId, userId, String(result.lastInsertRowid), userId);
  }
}

function insertScript(userId: number, tenantId: number, daysAgo = 0): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  const item = testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', 'active', ?, 'active', 'draft',
      ?, ?, ${dateExpr}, ${dateExpr})
  `).run(tenantId, userId, `Script for ${userId}-${Math.random()}`, userId, userId);
  const artifact = testDb.prepare(`
    INSERT INTO content_artifacts (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      item_id, artifact_type, title, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', ?, 'script', 'Script', ?, ?, ${dateExpr}, ${dateExpr})
  `).run(tenantId, userId, Number(item.lastInsertRowid), userId, userId);
  const revision = testDb.prepare(`
    INSERT INTO content_revisions (
      tenant_id, owner_user_id, artifact_id, revision_number,
      content_format, content_text, content_hash, created_by, created_at
    ) VALUES (?, ?, ?, 1, 'plain_text', 'script body', ?, ?, ${dateExpr})
  `).run(tenantId, userId, Number(artifact.lastInsertRowid), 'a'.repeat(64), userId);
  testDb.prepare(`
    UPDATE content_artifacts
       SET current_revision_id = ?, revision_count = 1
     WHERE id = ?
  `).run(Number(revision.lastInsertRowid), Number(artifact.lastInsertRowid));
}

function insertConfirmedWorkSchedule(suffix: string): number {
  const scope = { tenantId: USER_A, userId: USER_A };
  const created = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Scheduled ${suffix}`,
    idempotencyKey: `performance-item-${suffix}`,
  }, testDb).value;
  createContentArtifact({
    scope,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'plain_text', text: `Script ${suffix}` },
    idempotencyKey: `performance-artifact-${suffix}`,
  }, testDb);
  let item = getContentWorkspaceItem(scope, created.id, testDb)!;
  item = transitionContentWorkspaceItem({
    scope,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `performance-review-${suffix}`,
  }, testDb).value;
  item = transitionContentWorkspaceItem({
    scope,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `performance-approve-${suffix}`,
  }, testDb).value;
  const now = new Date();
  const offsetDays = suffix === 'current' ? 2 : suffix === 'sync-failed' ? 5 : 8;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() + offsetDays);
  while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
    start.setUTCDate(start.getUTCDate() + 1);
  }
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + (60 * 60 * 1000));
  const preview = createContentSchedulePreview({
    scope,
    itemId: item.id,
    workKind: 'record',
    durationMinutes: 60,
    preferredWindows: [{ start: start.toISOString(), end: end.toISOString() }],
    idempotencyKey: `performance-preview-${suffix}`,
    now: now.toISOString(),
  }, testDb);
  confirmContentSchedulePreview({
    scope,
    previewKey: preview.value.previewKey,
    idempotencyKey: `performance-confirm-${suffix}`,
    now: now.toISOString(),
  }, testDb);
  return item.id;
}

function insertPerformance(
  userId: number,
  tenantId: number,
  opts: {
    title: string;
    views: number;
    retentionPct: number;
    likes?: number;
    comments?: number;
    subsGained?: number;
    daysAgo?: number;
    scopeStatus?: string;
  },
): void {
  const dateExpr = opts.daysAgo === undefined || opts.daysAgo === 0
    ? "datetime('now')"
    : `datetime('now', '-${opts.daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_performance (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json, selected_title,
      video_url, views, retention_pct, likes, comments, subs_gained, logged_at
    ) VALUES (
      ?, ?, ?, 'user_private', 'active',
      ?, ?, ?, '{}', ?,
      NULL, ?, ?, ?, ?, ?, ${dateExpr}
    )
  `).run(
    userId,
    tenantId,
    userId,
    opts.scopeStatus ?? 'active',
    userId,
    userId,
    opts.title,
    opts.views,
    opts.retentionPct,
    opts.likes ?? 0,
    opts.comments ?? 0,
    opts.subsGained ?? 0,
  );
}

describe('content-performance-aggregate (CONTENT-UI-O3)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('returns the empty aggregate for a user with no data', () => {
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(0);
    expect(a.topics.publishedLast30d).toBeNull();
    expect(a.topics.publicationTracking).toEqual({
      availability: 'unavailable',
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
      publicationExecution: 'not_supported',
    });
    expect(a.topics.scheduledNext14d).toBe(0);
    expect(a.topics.scheduleAttentionNext14d).toBe(0);
    expect(a.scripts.total).toBe(0);
    expect(a.ideas.total).toBe(0);
    expect(a.radarFeedback.total).toBe(0);
    expect(a.performance.total).toBe(0);
    expect(a.highlights).toEqual([]);
  });

  it('separates current confirmed private work from schedule-attention states', () => {
    insertConfirmedWorkSchedule('current');
    const syncFailedItemId = insertConfirmedWorkSchedule('sync-failed');
    const cancelFailedItemId = insertConfirmedWorkSchedule('cancel-failed');
    const syncFailedAgendaId = (testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(syncFailedItemId) as { secretary_agenda_item_id: string }).secretary_agenda_item_id;
    const cancelFailedAgendaId = (testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(cancelFailedItemId) as { secretary_agenda_item_id: string }).secretary_agenda_item_id;
    testDb.prepare(`
      UPDATE secretary_agenda_items SET provider_sync_state = 'create_failed' WHERE agenda_item_id = ?
    `).run(syncFailedAgendaId);
    testDb.prepare(`
      UPDATE content_schedule_bindings
         SET state = 'cancel_pending',
             cancellation_idempotency_key = 'performance-cancel-failed-key',
             cancellation_request_hash = ?,
             provider_sync_state = 'delete_failed'
       WHERE item_id = ?
    `).run('0'.repeat(64), cancelFailedItemId);
    testDb.prepare(`
      UPDATE content_schedule_bindings SET state = 'cancel_failed' WHERE item_id = ?
    `).run(cancelFailedItemId);
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'completed', provider_sync_state = 'delete_failed'
       WHERE agenda_item_id = ?
    `).run(cancelFailedAgendaId);

    const aggregate = getContentPerformanceAggregate(USER_A, USER_A);

    expect(aggregate.topics.scheduledNext14d).toBe(2);
    expect(aggregate.topics.scheduleAttentionNext14d).toBe(2);
    expect(aggregate.topics.scheduleSemantics).toBe('private_work_session');
  });

  it('counts canonical workspace items by production state', () => {
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'drafting');
    insertTopic(USER_A, USER_A, 'published');
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(4);
    expect(a.topics.byStatus.inbox).toBe(2);
    expect(a.topics.byStatus.active).toBe(1);
    expect(a.topics.byStatus.published).toBe(1);
  });

  it('does not infer external publication tracking from internal published states', () => {
    insertTopic(USER_A, USER_A, 'published', null, 5);   // within 30d
    insertTopic(USER_A, USER_A, 'published', null, 50);  // older — outside window
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.publishedLast30d).toBeNull();
    expect(a.topics.publicationTracking).toMatchObject({
      availability: 'unavailable',
      publicationExecution: 'not_supported',
    });
    expect(a.highlights.some((highlight) => /publishing cadence|publication event/i.test(highlight))).toBe(false);
  });

  it('aggregates radar feedback by action', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 's1', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's2', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's3', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's4', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's5', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's6', action: 'save', signalTopic: 'Saved A' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.radarFeedback.total).toBe(6);
    expect(a.radarFeedback.byAction.accept).toBe(2);
    expect(a.radarFeedback.byAction.reject).toBe(3);
    expect(a.radarFeedback.byAction.save).toBe(1);
    expect(a.radarFeedback.topAcceptedTopics[0].topic).toBe('AI workflows');
    expect(a.radarFeedback.topAcceptedTopics[0].count).toBe(2);
    expect(a.radarFeedback.topRejectedTopics[0].topic).toBe('Crypto trading');
    expect(a.radarFeedback.topRejectedTopics[0].count).toBe(3);
  });

  it('uses signal summary instead of signal id when radar topic is missing', () => {
    recordRadarFeedback(USER_A, USER_A, {
      signalId: 'summary-only-1',
      action: 'accept',
      signalSummary: 'Summary-backed opportunity label',
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.radarFeedback.topAcceptedTopics[0]).toEqual({
      topic: 'Summary-backed opportunity label',
      count: 1,
    });
    expect(a.radarFeedback.topAcceptedTopics[0].topic).not.toBe('summary-only-1');
  });

  it('warning fires when rejects exceed 2x accepts and reject count >= 5', () => {
    for (let i = 0; i < 6; i++) {
      recordRadarFeedback(USER_A, USER_A, { signalId: `r-${i}`, action: 'reject' });
    }
    recordRadarFeedback(USER_A, USER_A, { signalId: 'a-1', action: 'accept' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.some(w => w.toLowerCase().includes('under-fitting'))).toBe(true);
  });

  it('warns about missing script artifacts without inferring publication state', () => {
    for (let i = 0; i < 6; i++) {
      insertTopic(USER_A, USER_A, 'planned');
    }
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.length).toBeGreaterThanOrEqual(1);
    expect(a.warnings.some(w => /no current script artifacts/i.test(w))).toBe(true);
    expect(a.warnings.some(w => /verified publication|publication event/i.test(w))).toBe(false);
  });

  it('counts scripts from canonical artifacts and immutable revisions', () => {
    insertScript(USER_A, USER_A, 2);
    insertScript(USER_A, USER_A, 45);
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.scripts.total).toBe(2);
    expect(a.scripts.last30d).toBe(1);
  });

  it('aggregates live content_performance metrics and excludes inactive or out-of-scope rows', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'High-retention training explainer',
      views: 1000,
      retentionPct: 60,
      likes: 100,
      comments: 20,
      subsGained: 3,
      daysAgo: 3,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Lower-retention calendar clip',
      views: 500,
      retentionPct: 40,
      likes: 20,
      comments: 5,
      subsGained: 1,
      daysAgo: 10,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Old but popular clip',
      views: 9000,
      retentionPct: 70,
      likes: 800,
      comments: 60,
      subsGained: 20,
      daysAgo: 45,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Quarantined row',
      views: 9999,
      retentionPct: 90,
      scopeStatus: 'quarantined',
    });
    insertPerformance(USER_B, USER_B, {
      title: 'Other user row',
      views: 9999,
      retentionPct: 90,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.total).toBe(3);
    expect(a.performance.last30d).toBe(2);
    expect(a.performance.avgViewsLast30d).toBe(750);
    expect(a.performance.avgRetentionLast30d).toBe(50);
    expect(a.performance.totalLikesLast30d).toBe(120);
    expect(a.performance.totalCommentsLast30d).toBe(25);
    expect(a.performance.totalSubsGainedLast30d).toBe(4);
    expect(a.performance.topByViews[0]).toMatchObject({
      title: 'Old but popular clip',
      views: 9000,
      retentionPct: 70,
    });
    expect(a.highlights.some(h => h.includes('User-reported performance is holding attention'))).toBe(true);
  });

  it('warns when recent user-reported performance is under-retaining viewers', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'Weak hook test',
      views: 800,
      retentionPct: 18,
      daysAgo: 1,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Weak pacing test',
      views: 400,
      retentionPct: 20,
      daysAgo: 2,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.last30d).toBe(2);
    expect(a.performance.avgRetentionLast30d).toBe(19);
    expect(a.warnings.some(w => w.includes('under-retaining viewers'))).toBe(true);
  });

  it('warns when recent user-reported performance has true zero retention', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'Zero-retention hook test',
      views: 800,
      retentionPct: 0,
      daysAgo: 1,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.last30d).toBe(1);
    expect(a.performance.avgRetentionLast30d).toBe(0);
    expect(a.warnings.some(w => w.includes('0% average retention'))).toBe(true);
  });

  it('User A aggregate is invisible to User B', () => {
    insertTopic(USER_A, USER_A, 'published');
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sa', action: 'accept' });
    insertPerformance(USER_A, USER_A, {
      title: 'A-only performance row',
      views: 1000,
      retentionPct: 60,
    });
    const b = getContentPerformanceAggregate(USER_B, USER_B);
    expect(b.topics.total).toBe(0);
    expect(b.radarFeedback.total).toBe(0);
    expect(b.performance.total).toBe(0);
  });

  it('returns empty aggregate for invalid userId', () => {
    const a = getContentPerformanceAggregate(0);
    expect(a.topics.total).toBe(0);
    expect(a.tenantId).toBe(0);
    expect(a.availability).toBe('unavailable');
    expect(a.unavailableSections).toHaveLength(5);
  });

  it('marks a failed aggregate section unavailable instead of presenting its zeros as complete', () => {
    testDb.exec('DROP TABLE content_performance');

    const aggregate = getContentPerformanceAggregate(USER_A, USER_A);

    expect(aggregate.availability).toBe('partial');
    expect(aggregate.unavailableSections).toEqual(['performance']);
    expect(aggregate.highlights.some((value) => value.includes('performance'))).toBe(false);
    expect(aggregate.warnings.some((value) => value.includes('performance'))).toBe(false);
  });
});
