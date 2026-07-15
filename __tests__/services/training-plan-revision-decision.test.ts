// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';
import { bindTrainingPlanRevisionDecision } from '../../src/services/training-plan-revision-decision';
import { createTrainingPlanCandidateRevision } from '../../src/services/training-plan-revisions';
import {
  performDecisionAction,
  decisionRefreshSupportedForDecision,
  getDecisionItem,
  reviewDecision,
  runDecisionExpiryJob,
} from '../../src/services/decision-center';

const request: TrainingPlanCandidateRequest = {
  planMode: 'continuous', goal: 'general_fitness', discipline: 'strength', horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice', sessionsPerWeek: 3, sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'friday'], equipmentIds: [], location: 'home',
  },
};

describe('training-plan-revision Decision Center binding', () => {
  let db: Database.Database;
  const priorMode = process.env.TRAINING_PLAN_REVISION_V1_MODE;
  const priorEnrollment = process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7;
  const priorFlow = process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
  const priorTrainingFlow = process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7;
  const priorSnapshotKey = process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'false';
    process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7 = 'true';
    process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-revision-test-encryption-key-0001';
  });

  afterEach(() => {
    if (priorMode === undefined) delete process.env.TRAINING_PLAN_REVISION_V1_MODE;
    else process.env.TRAINING_PLAN_REVISION_V1_MODE = priorMode;
    if (priorEnrollment === undefined) delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7;
    else process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = priorEnrollment;
    if (priorFlow === undefined) delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    else process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = priorFlow;
    if (priorTrainingFlow === undefined) delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7;
    else process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7 = priorTrainingFlow;
    if (priorSnapshotKey === undefined) delete process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
    else process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = priorSnapshotKey;
    db.close();
  });

  it('binds the exact immutable revision and activates only after strong approval', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'decision-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      expect(bound).toMatchObject({
        lifecycleState: 'PENDING_REVIEW', approvalState: 'PENDING', decisionId: expect.any(String),
      });
      expect(decisionRefreshSupportedForDecision(bound.decisionId!, 7, 7)).toBe(true);
      const stored = db.prepare(`
        SELECT items.record_version AS recordVersion, items.decision_state AS decisionState,
               items.actions_json AS actionsJson, items.deeplink AS deeplink,
               intents.related_entity_type AS relatedEntityType,
               intents.related_entity_id AS relatedEntityId,
               intents.normalized_action_json AS normalizedActionJson
          FROM notification_center_items items
          JOIN notification_intents intents ON intents.intent_id = items.intent_id
         WHERE items.item_id = ?
      `).get(bound.decisionId) as any;
      expect(stored).toMatchObject({
        decisionState: 'ready_for_review', relatedEntityType: 'training_plan_revision', relatedEntityId: bound.revisionId,
        deeplink: `nexus://training/revision/${bound.revisionId}`,
      });
      expect(JSON.parse(stored.actionsJson)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'activate_training_plan_revision' }),
      ]));
      const normalized = JSON.parse(stored.normalizedActionJson);
      expect(normalized).toMatchObject({
        intent: 'training.activate_plan_revision',
        contextVersion: bound.creationContextVersion,
        targetEntities: [expect.objectContaining({ id: bound.revisionId, version: bound.contentHash })],
      });
      expect(db.prepare(`
        SELECT operation_type AS operationType, status
          FROM training_plan_revision_operations ORDER BY operation_type
      `).all()).toEqual([
        { operationType: 'BIND_DECISION', status: 'SUCCEEDED' },
        { operationType: 'CREATE_CANDIDATE', status: 'SUCCEEDED' },
      ]);

      expect(() => reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: stored.recordVersion,
        idempotencyKey: 'review-training-revision-without-strong-confirmation',
      })).toThrow(expect.objectContaining({ code: 'DECISION_STRONG_CONFIRMATION_REQUIRED' }));

      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: stored.recordVersion,
        idempotencyKey: 'review-training-revision', strongConfirmationText: 'CONFIRM',
      });
      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-training-revision-without-version',
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'DECISION_VERSION_REQUIRED', status: 428 });
      const action = await performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-training-revision',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      );
      expect(action.status).toBe('succeeded');
      expect(db.prepare('SELECT lifecycle_state, approval_state FROM training_plan_revisions').get()).toEqual({
        lifecycle_state: 'ACTIVE', approval_state: 'APPROVED',
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 1 });
    });
  });

  it('preserves an existing exact scoped legacy Decision enrollment', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7 = 'false';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7 = 'true';
      try {
        const created = createTrainingPlanCandidateRevision({
          scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'legacy-scoped-decision-candidate', request,
        });
        const bound = await bindTrainingPlanRevisionDecision({
          scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
        });
        expect(bound.decisionId).toEqual(expect.any(String));
        expect(getDecisionItem(bound.decisionId!, 7, 7)).toMatchObject({ reviewSupported: true });
      } finally {
        delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7;
      }
    });
  });

  it('reconciles a crash after activation commit without duplicating the projection or outbox', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'crash-activation-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const stored = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: stored.recordVersion,
        idempotencyKey: 'crash-activation-review', strongConfirmationText: 'CONFIRM',
      });
      const escapedDecisionId = bound.decisionId!.replace(/'/g, "''");
      db.exec(`
        CREATE TRIGGER ignore_training_actioned_projection
        BEFORE UPDATE OF status ON notification_center_items
        WHEN NEW.item_id = '${escapedDecisionId}' AND NEW.status = 'actioned'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'crash-activation-action',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_approvals').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get()).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 1 });

      db.exec('DROP TRIGGER ignore_training_actioned_projection');
      expect(() => getDecisionItem(bound.decisionId!, 7, 7)).not.toThrow();
      expect(getDecisionItem(bound.decisionId!, 7, 7)).toMatchObject({
        status: 'failed',
        execution: { status: 'partially_failed' },
      });
      const replay = await performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'crash-activation-action',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      );
      expect(replay).toMatchObject({ status: 'idempotent', idempotent: true });
      expect(replay.item).toMatchObject({ status: 'actioned', execution: { status: 'succeeded' } });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_approvals').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get()).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 1 });
    });
  });

  it('records rejection without activating or mutating an active plan', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'rejected-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const item = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'reject', expectedVersion: item.recordVersion,
        idempotencyKey: 'reject-training-revision', reasonCode: 'not_relevant',
      });
      expect(db.prepare(`
        SELECT lifecycle_state, approval_state FROM training_plan_revisions WHERE revision_id = ?
      `).get(bound.revisionId)).toEqual({ lifecycle_state: 'EXPIRED', approval_state: 'REJECTED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 0 });
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'unchanged-after-reject', request,
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_UNCHANGED_CANDIDATE_SUPPRESSED' }));
      const changed = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'changed-after-reject',
        request: { ...request, profile: { ...request.profile, sessionDurationMinutes: 45 } },
      });
      expect(changed.candidates[0].revisionId).not.toBe(bound.revisionId);
    });
  });

  it('expires the bound revision with its Decision and requires a changed candidate', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'expiry-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      db.prepare(`
        UPDATE notification_center_items SET expires_at = '2020-01-01T00:00:00.000Z'
         WHERE item_id = ?
      `).run(bound.decisionId);

      expect(runDecisionExpiryJob()).toMatchObject({ expired: 1, remaining: 0 });
      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycleState, approval_state AS approvalState
          FROM training_plan_revisions WHERE revision_id = ?
      `).get(bound.revisionId)).toEqual({ lifecycleState: 'EXPIRED', approvalState: 'EXPIRED' });
      const renewed = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'expiry-unchanged', request,
      });
      expect(renewed.candidates[0]).toMatchObject({
        revisionSequence: 2,
        contentHash: bound.contentHash,
        creationContextVersion: bound.creationContextVersion,
      });
      expect(renewed.candidates[0].revisionId).not.toBe(bound.revisionId);
    });
  });

  it('fails activation when the authoritative user profile changes after review creation', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'profile-freshness-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const item = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: item.recordVersion,
        idempotencyKey: 'approve-before-profile-change', strongConfirmationText: 'CONFIRM',
      });
      db.prepare(`
        INSERT INTO user_profiles (user_id, profile_type, data)
        VALUES (7, 'fitness', '{"schedule":"changed"}')
      `).run();

      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-after-profile-change',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_approvals').get()).toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 0 });
    });
  });

  it('fails activation when authoritative calendar commitments change after review creation', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'calendar-freshness-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const item = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: item.recordVersion,
        idempotencyKey: 'approve-before-calendar-change', strongConfirmationText: 'CONFIRM',
      });
      db.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id, source_intent_id, source_skill, intent_action,
          owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
          version, title, start_at, end_at, decision_action, source_shape_hash,
          scheduled_segments_json, created_at, updated_at
        ) VALUES (
          'agenda-after-review', 'intent-after-review', 'secretary', 'schedule_this',
          7, '7', 'scheduled', 'not_synced', 1, 'Private commitment',
          '2026-07-14T09:00:00Z', '2026-07-14T10:00:00Z', 'schedule',
          'shape-after-review', '[]', datetime('now'), datetime('now')
        )
      `).run();

      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-after-calendar-change',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_approvals').get()).toEqual({ count: 0 });
    });
  });

  it('fails activation when another authoritative Decision conflict appears after review creation', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'conflict-freshness-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const item = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: item.recordVersion,
        idempotencyKey: 'approve-before-conflict-change', strongConfirmationText: 'CONFIRM',
      });
      db.prepare(`
        INSERT INTO notification_intents (
          intent_id, user_id, tenant_id, source_skill, type, priority,
          related_entity_id, related_entity_type, title, body, normalized_action_json
        ) VALUES (
          'other-conflict-intent', 7, 7, 'secretary', 'approval_required', 'active',
          'other-resource', 'secretary_agenda_item', 'Other review', 'Other review', '{}'
        )
      `).run();
      db.prepare(`
        INSERT INTO notification_center_items (
          item_id, intent_id, user_id, tenant_id, title, body, safe_body,
          source_skill, type, priority, status, decision_state, record_version
        ) VALUES (
          'other-conflict-decision', 'other-conflict-intent', 7, 7,
          'Other review', 'Other review', 'Other review', 'secretary',
          'approval_required', 'active', 'unread', 'ready_for_review', 1
        )
      `).run();

      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-after-conflict-change',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'DECISION_CONTEXT_CHANGED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_approvals').get()).toEqual({ count: 0 });
    });
  });

  it('does not invalidate approval when an existing unrelated Decision is merely marked read', async () => {
    await withDatabaseForTestAsync(db, async () => {
      db.prepare(`
        INSERT INTO notification_intents (
          intent_id, user_id, tenant_id, source_skill, type, priority,
          related_entity_id, related_entity_type, title, body, normalized_action_json
        ) VALUES (
          'existing-read-intent', 7, 7, 'secretary', 'approval_required', 'active',
          'existing-resource', 'secretary_agenda_item', 'Existing review', 'Existing review', '{}'
        )
      `).run();
      db.prepare(`
        INSERT INTO notification_center_items (
          item_id, intent_id, user_id, tenant_id, title, body, safe_body,
          source_skill, type, priority, status, decision_state, record_version
        ) VALUES (
          'existing-read-decision', 'existing-read-intent', 7, 7,
          'Existing review', 'Existing review', 'Existing review', 'secretary',
          'approval_required', 'active', 'unread', 'ready_for_review', 1
        )
      `).run();
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'read-state-candidate', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const item = db.prepare('SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?')
        .get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: item.recordVersion,
        idempotencyKey: 'approve-before-read-state-change', strongConfirmationText: 'CONFIRM',
      });
      db.prepare(`
        UPDATE notification_center_items
           SET status = 'read', record_version = record_version + 1
         WHERE item_id = 'existing-read-decision'
      `).run();

      const action = await performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-after-read-state-change',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      );
      expect(action.status).toBe('succeeded');
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
    });
  });

  it('resumes Decision binding operation completion after a post-binding crash without regenerating', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'resume-candidate', request,
      });
      const first = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      db.prepare(`
        UPDATE training_plan_revision_operations
           SET status = 'FAILED_RETRYABLE', response_json = NULL,
               result_decision_id = NULL, completed_at = NULL
         WHERE operation_type = 'BIND_DECISION' AND result_revision_id = ?
      `).run(first.revisionId);

      const resumed = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: first.revisionId,
      });
      expect(resumed.decisionId).toBe(first.decisionId);
      expect(resumed).toMatchObject({ lifecycleState: 'PENDING_REVIEW', approvalState: 'PENDING' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT status, attempt_count AS attemptCount FROM training_plan_revision_operations
         WHERE operation_type = 'BIND_DECISION'
      `).get()).toEqual({ status: 'SUCCEEDED', attemptCount: 2 });
    });
  });
});
