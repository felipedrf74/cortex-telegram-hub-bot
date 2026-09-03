import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let db: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => db,
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
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  saveContentRevision,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import {
  decideContentWorkspaceReview,
  getContentDecisionWorkspaceObject,
} from '../../src/services/content-workspace-decision-adapter';
import { ensureContentWorkspaceReviewDecision } from '../../src/services/content-workspace-decision-projection';

const SCOPE = { tenantId: 501, userId: 501 };

describe('canonical Content workspace Decision adapter', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('atomically submits a saved user revision for review and approves it without a legacy ledger write', () => {
    const item = createSavedCandidate('User-authored decision candidate', 'user');
    const result = decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      approvalType: 'content_review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'decision-adapter-approve-001',
    }, db);

    expect(result).toMatchObject({ ok: true, status: 'approved', object: { approvalState: 'approved' } });
    expect(getContentWorkspaceItem(SCOPE, item.id, db)).toMatchObject({
      productionState: 'approved',
      artifactPhase: 'final',
      workflowVersion: item.workflowVersion + 2,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_approval_records').get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT action, to_state
        FROM content_workflow_events
       WHERE object_type = 'content_item' AND object_id = ?
         AND action = 'workspace_state_changed'
       ORDER BY id ASC
    `).all(String(item.id))).toEqual([
      { action: 'workspace_state_changed', to_state: 'review' },
      { action: 'workspace_state_changed', to_state: 'approved' },
    ]);
  });

  it('blocks approval of an agent revision until source and claim lineage is recorded', () => {
    const item = createSavedCandidate('Agent decision candidate', 'agent');
    const result = decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      approvalType: 'content_review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'decision-adapter-agent-001',
    }, db);

    expect(result).toMatchObject({
      ok: false,
      status: 'invalid_transition',
      object: { approvalState: 'not_required', productionState: 'active' },
    });
    expect(result.reasonCodes).toContain('CONTENT_LINEAGE_REVIEW_REQUIRED');
    expect(getContentWorkspaceItem(SCOPE, item.id, db)?.productionState).toBe('active');
  });

  it('returns a requested rewrite to active work without rejecting or discarding the saved revision', () => {
    const item = createSavedCandidate('Needs another pass', 'user');
    const reviewed = transitionContentWorkspaceItem({
      scope: SCOPE,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'decision-adapter-rewrite-review-001',
    }, db).value;
    const before = getContentWorkspaceItem(SCOPE, item.id, db)!;

    const result = decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'rewrite_requested',
      approvalType: 'content_review',
      expectedWorkflowVersion: reviewed.workflowVersion,
      idempotencyKey: 'decision-adapter-rewrite-001',
      reason: 'Requested changes from Decision Center',
      metadata: { source: 'decision_center_command_bus', decisionId: 'nc_rewrite_501' },
    }, db);

    expect(result).toMatchObject({
      ok: true,
      status: 'rewrite_requested',
      object: { productionState: 'active', approvalState: 'not_required', reviewRequired: false },
    });
    const after = getContentWorkspaceItem(SCOPE, item.id, db)!;
    expect(after).toMatchObject({
      productionState: 'active',
      currentArtifactId: before.currentArtifactId,
      artifactCount: before.artifactCount,
      nextAction: { action: 'revise_content', label: 'Revise requested changes' },
    });
    expect(db.prepare(`
      SELECT review_reason_codes_json
        FROM content_domain_objects
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).get(item.id, SCOPE.tenantId, SCOPE.userId)).toEqual({
      review_reason_codes_json: '["changes_requested"]',
    });
    const rewriteEvent = db.prepare(`
      SELECT action, reason_codes_json, metadata_json
        FROM content_workflow_events
       WHERE object_type = 'content_item' AND object_id = ?
         AND action = 'workspace_changes_requested'
       ORDER BY id DESC
       LIMIT 1
    `).get(String(item.id)) as {
      action: string;
      reason_codes_json: string;
      metadata_json: string;
    };
    expect(rewriteEvent).toMatchObject({
      action: 'workspace_changes_requested',
      reason_codes_json: '["changes_requested"]',
    });
    expect(JSON.parse(rewriteEvent.metadata_json)).toMatchObject({
      auditContext: {
        source: 'decision_center_command_bus',
        action: 'request_rewrite',
        decisionId: 'nc_rewrite_501',
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions').get())
      .toEqual({ count: 1 });
    expect(decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'rewrite_requested',
      approvalType: 'content_review',
      expectedWorkflowVersion: reviewed.workflowVersion,
      idempotencyKey: 'decision-adapter-rewrite-001',
    }, db)).toMatchObject({ ok: true, status: 'rewrite_requested', object: { productionState: 'active' } });

    saveContentRevision({
      scope: SCOPE,
      artifactId: after.currentArtifactId!,
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Revised after the requested changes.' },
      idempotencyKey: 'decision-adapter-rewrite-save-002',
    }, db);
    expect(getContentWorkspaceItem(SCOPE, item.id, db)).toMatchObject({
      productionState: 'active',
      nextAction: { action: 'submit_for_review', label: 'Submit for review' },
    });
    expect(db.prepare(`
      SELECT review_reason_codes_json
        FROM content_domain_objects
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).get(item.id, SCOPE.tenantId, SCOPE.userId)).toEqual({ review_reason_codes_json: '[]' });
  });

  it('fails closed for an implicit approval type, stale CAS, and another tenant', () => {
    const item = createSavedCandidate('Scoped decision candidate', 'user');
    expect(decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'decision-adapter-no-type-001',
    }, db)).toMatchObject({ ok: false, reasonCodes: ['explicit_content_review_approval_required'] });
    expect(decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      approvalType: 'content_review',
      expectedWorkflowVersion: item.workflowVersion + 20,
      idempotencyKey: 'decision-adapter-stale-001',
    }, db)).toMatchObject({ ok: false, status: 'version_conflict' });
    expect(decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      approvalType: 'content_review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'decision-key\u0085hidden',
    }, db)).toMatchObject({ ok: false, status: 'invalid_transition', reasonCodes: ['idempotency_key_required'] });
    expect(decideContentWorkspaceReview({
      userId: SCOPE.userId,
      tenantId: SCOPE.tenantId,
      objectId: item.id,
      decision: 'approved',
      approvalType: 'content_review',
      expectedWorkflowVersion: Number.MAX_SAFE_INTEGER + 1,
      idempotencyKey: 'decision-unsafe-version-001',
    }, db)).toMatchObject({ ok: false, status: 'version_conflict' });
    expect(getContentDecisionWorkspaceObject(SCOPE.userId, item.id, 999, db)).toBeNull();
    expect(getContentWorkspaceItem(SCOPE, item.id, db)?.productionState).toBe('active');
  });

  it('projects a canonical review into Decision Center once without exposing draft text', async () => {
    const saved = createSavedCandidate('Private launch script', 'user');
    const reviewed = transitionContentWorkspaceItem({
      scope: SCOPE,
      itemId: saved.id,
      targetState: 'review',
      expectedWorkflowVersion: saved.workflowVersion,
      idempotencyKey: 'decision-projection-review-001',
    }, db).value;

    const projected = await ensureContentWorkspaceReviewDecision(SCOPE, reviewed.id, db);
    const replay = await ensureContentWorkspaceReviewDecision(SCOPE, reviewed.id, db);

    expect(projected).toMatchObject({
      status: 'projected',
      itemId: reviewed.id,
      workflowVersion: reviewed.workflowVersion,
      retryable: false,
    });
    expect(projected.decisionId).toMatch(/^nc_/);
    expect(replay).toMatchObject({
      status: 'already_projected',
      decisionId: projected.decisionId,
      retryable: false,
    });
    const rows = db.prepare(`
      SELECT items.item_id, items.source_skill, items.dedupe_key,
             intents.related_entity_id, intents.related_entity_type,
             intents.body, intents.sensitive_body, intents.action_buttons_json,
             intents.delivery_policy, intents.privacy_policy
        FROM notification_center_items items
        JOIN notification_intents intents ON intents.intent_id = items.intent_id
       WHERE items.user_id = ? AND items.tenant_id = ? AND items.source_skill = 'content'
    `).all(SCOPE.userId, SCOPE.tenantId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_id: projected.decisionId,
      related_entity_id: String(reviewed.id),
      related_entity_type: 'content_workflow_object',
      body: 'A saved content version is ready for your approval or change request.',
      delivery_policy: 'in_app_only',
      privacy_policy: 'private_content',
    });
    expect(String(rows[0].body)).not.toContain('Saved content for');
    expect(JSON.parse(String(rows[0].action_buttons_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'approve_script' }),
      expect.objectContaining({ id: 'request_rewrite' }),
    ]));
  });

  it('does not project non-review or cross-tenant workspace state', async () => {
    const saved = createSavedCandidate('Not submitted', 'user');
    expect(await ensureContentWorkspaceReviewDecision(SCOPE, saved.id, db)).toMatchObject({
      status: 'not_in_review',
      decisionId: null,
      retryable: false,
    });
    expect(await ensureContentWorkspaceReviewDecision({ tenantId: 999, userId: 999 }, saved.id, db)).toMatchObject({
      status: 'source_unavailable',
      decisionId: null,
      retryable: true,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_center_items WHERE source_skill = 'content'").get())
      .toEqual({ count: 0 });
  });
});

function createSavedCandidate(title: string, actorType: 'user' | 'agent') {
  const item = createContentWorkspaceItem({
    scope: SCOPE,
    itemType: 'content_item',
    title,
    idempotencyKey: `decision-item:${title}`,
  }, db).value;
  createContentArtifact({
    scope: SCOPE,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'plain_text', text: `Saved content for ${title}.` },
    actorType,
    actorId: actorType === 'user' ? String(SCOPE.userId) : 'scriptwriter-agent',
    idempotencyKey: `decision-artifact:${title}`,
  }, db);
  return getContentWorkspaceItem(SCOPE, item.id, db)!;
}
