// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import { activateApprovedTrainingPlanRevision as activateApprovedTrainingPlanRevisionAtRuntime } from '../../src/services/training-plan-revision-activation';
import {
  createTrainingPlanCandidateRevision as createTrainingPlanCandidateRevisionAtRuntime,
  getScopedTrainingPlanRevision,
} from '../../src/services/training-plan-revisions';
import {
  getTrainingAdaptationOptionEnvelope,
  getTrainingAdaptationProposal,
  previewTrainingAdaptation,
  requestTrainingAdaptationReview,
  selectTrainingAdaptationOption,
} from '../../src/services/training-adaptation-proposals';
import type { TrainingPlanRevisionDocument } from '../../src/services/training-plan-revision-candidate-builder';
import { dismissDecision, reviewDecision } from '../../src/services/decision-center';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
} from '../../src/services/training-exercise-identity';

const activeEnv = {
  TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
  TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
  TRAINING_ADAPTATION_V1_MODE_USER_7: 'active',
  TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7: 'true',
  DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
  TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
  DECISION_FEEDBACK_SUPPRESSION_ENABLED: 'true',
  DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS: '7',
};
const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');

function createTrainingPlanCandidateRevision(
  input: Parameters<typeof createTrainingPlanCandidateRevisionAtRuntime>[0],
) {
  return createTrainingPlanCandidateRevisionAtRuntime({
    ...input,
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

function activateApprovedTrainingPlanRevision(
  input: Parameters<typeof activateApprovedTrainingPlanRevisionAtRuntime>[0],
) {
  return activateApprovedTrainingPlanRevisionAtRuntime({
    ...input,
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

describe('Training adaptation proposal service', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  it('persists one active preview, returns exact iOS presentation, and keeps duplicate events idempotent', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const request = busyPreviewInput(source, target.workoutKey, 'event-busy-1');
      const preview = previewTrainingAdaptation(request);
      expect(preview).toMatchObject({
        schemaVersion: 'training_adaptation_api.v1', mode: 'active',
        preview: {
          proposalSetId: expect.stringMatching(/^tadp_/), eventId: 'event-busy-1', trigger: 'BUSY_DAY',
          currentRevision: { revisionId: source.revisionId }, target: { workoutKey: target.workoutKey },
          options: expect.arrayContaining([expect.objectContaining({
            action: 'SHORTEN', adaptationId: expect.stringMatching(/^tadp_/),
            proposedRevision: expect.objectContaining({ parentRevisionId: source.revisionId }),
            approvalRequirement: 'DECISION_CENTER', reversible: true,
          }), expect.objectContaining({ action: 'KEEP_ORIGINAL', proposedRevision: null, approvalRequirement: 'NONE' })]),
          suppressedOptions: expect.arrayContaining([expect.objectContaining({ action: 'RESCHEDULE' })]),
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 0 });

      const replay = previewTrainingAdaptation(request);
      expect(replay).toEqual(preview);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 1 });
      expect(() => previewTrainingAdaptation({
        ...request,
        explicitInput: { kind: 'BUSY_DAY', availableMinutes: request.explicitInput.kind === 'BUSY_DAY'
          ? request.explicitInput.availableMinutes + 1 : 20 },
      })).toThrow(expect.objectContaining({ code: 'TRAINING_ADAPTATION_EVENT_ID_CONFLICT' }));
    });
  });

  it('does zero adaptation writes in shadow and blocks completed-session targets', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const shadow = previewTrainingAdaptation({
        ...busyPreviewInput(source, target.workoutKey, 'event-shadow-1'),
        env: { ...activeEnv, TRAINING_ADAPTATION_V1_MODE_USER_7: 'shadow' },
      });
      expect(shadow.mode).toBe('shadow');
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 0 });

      db.prepare(`
        UPDATE training_sessions SET status = 'completed'
         WHERE tenant_id = 7 AND revision_session_key = ?
      `).run(target.workoutKey);
      expect(() => previewTrainingAdaptation(busyPreviewInput(source, target.workoutKey, 'event-completed-1')))
        .toThrow(expect.objectContaining({ code: 'TRAINING_ADAPTATION_COMPLETED_SESSION_IMMUTABLE' }));
    });
  });

  it('records keep-original idempotently without a child revision, Decision, or active-plan mutation', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const preview = previewTrainingAdaptation(busyPreviewInput(source, target.workoutKey, 'event-keep-1'));
      const keep = preview.preview.options.find((entry) => entry.action === 'KEEP_ORIGINAL')!;
      const input = {
        scope: { userId: 7, tenantId: 7 }, adaptationId: keep.adaptationId,
        optionId: keep.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-selection:event-keep-1:${keep.optionId}`,
        env: activeEnv, db,
      };
      const first = selectTrainingAdaptationOption(input);
      expect(selectTrainingAdaptationOption(input)).toEqual(first);
      expect(first).toEqual({
        schemaVersion: 'training_adaptation_api.v1', adaptationId: keep.adaptationId,
        optionId: keep.optionId, decisionId: null, status: 'KEPT_ORIGINAL',
      });
      expect(db.prepare(`
        SELECT status, proposed_revision_id AS proposedRevisionId, decision_id AS decisionId,
               approval_required AS approvalRequired
          FROM training_adaptation_proposals
      `).get()).toEqual({
        status: 'KEPT_ORIGINAL', proposedRevisionId: null, decisionId: null, approvalRequired: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM training_adaptation_lifecycle_events WHERE event_type = 'KEPT_ORIGINAL'").get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions WHERE parent_revision_id = ?').get(source.revisionId))
        .toEqual({ count: 0 });
      expect(db.prepare('SELECT active_revision_id AS revisionId FROM training_active_plan_references').get())
        .toEqual({ revisionId: source.revisionId });
      expect(getTrainingAdaptationOptionEnvelope({ userId: 7, tenantId: 7 }, keep.adaptationId, db))
        .toMatchObject({ option: { action: 'KEEP_ORIGINAL', proposedRevision: null, decisionId: null } });
      const shorten = preview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      await expect(requestTrainingAdaptationReview({
        scope: { userId: 7, tenantId: 7 }, adaptationId: shorten.adaptationId,
        optionId: shorten.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-keep-1:${shorten.optionId}`,
        env: activeEnv, db,
      })).rejects.toMatchObject({ code: 'TRAINING_ADAPTATION_ALREADY_SELECTED' });
    });
  });

  it('rejects a tampered active source before creating any adaptation state', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      db.exec('DROP TRIGGER trg_training_plan_revisions_content_immutable');
      db.prepare(`
        UPDATE training_plan_revisions
           SET revision_document_json = json_set(revision_document_json, '$.title', 'tampered source')
         WHERE revision_id = ?
      `).run(source.revisionId);
      expect(() => previewTrainingAdaptation(
        busyPreviewInput(source, target.workoutKey, 'event-tampered-source-preview'),
      )).toThrow(expect.objectContaining({ code: 'TRAINING_ADAPTATION_SOURCE_INTEGRITY_FAILED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 0 });
    });
  });

  it('escalates tired scope only from persisted fresh explicit reports', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const tired = (eventId: string, adaptationScope: 'SESSION' | 'WEEK' | 'PHASE') => ({
        scope: { userId: 7, tenantId: 7 }, eventId,
        idempotencyKey: `training-adaptation:${eventId}`,
        currentRevisionId: source.revisionId, expectedContentHash: source.contentHash,
        contextVersion: source.creationContextVersion, adaptationScope,
        target: { workoutKey: target.workoutKey },
        explicitInput: {
          kind: 'TIRED_DAY' as const, selfReport: 'MORE_TIRED_THAN_EXPECTED' as const,
          reportedLevel: 'MORE_THAN_EXPECTED' as const,
        },
        env: activeEnv, db,
      });
      expect(() => previewTrainingAdaptation(tired('tired-broad-too-soon', 'WEEK')))
        .toThrow(/TRAINING_TIRED_DAY_SCOPE_EVIDENCE_INSUFFICIENT/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 0 });
      expect(previewTrainingAdaptation(tired('tired-session-1', 'SESSION')).preview.options)
        .toEqual(expect.arrayContaining([expect.objectContaining({ action: 'REDUCE_VOLUME', scope: 'SESSION' })]));
      expect(previewTrainingAdaptation(tired('tired-week-2', 'WEEK')).preview.options)
        .toEqual(expect.arrayContaining([expect.objectContaining({ action: 'REDUCE_VOLUME', scope: 'WEEK' })]));
      expect(previewTrainingAdaptation(tired('tired-phase-3', 'PHASE')).preview.options)
        .toEqual(expect.arrayContaining([expect.objectContaining({ action: 'REDUCE_VOLUME', scope: 'PHASE' })]));
      expect(db.prepare("SELECT COUNT(*) AS count FROM training_adaptation_previews WHERE trigger_kind = 'TIRED_DAY'").get())
        .toEqual({ count: 3 });
    });
  });

  it('binds concurrent idempotent review retries to one child and one Decision, then suppresses a rejected duplicate', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const preview = previewTrainingAdaptation(busyPreviewInput(source, target.workoutKey, 'event-review-1'));
      const option = preview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      const reviewInput = {
        scope: { userId: 7, tenantId: 7 }, adaptationId: option.adaptationId,
        optionId: option.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-review-1:${option.optionId}`,
        env: activeEnv, db,
      };
      const [first, replay] = await Promise.all([
        requestTrainingAdaptationReview(reviewInput), requestTrainingAdaptationReview(reviewInput),
      ]);
      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        schemaVersion: 'training_adaptation_api.v1', adaptationId: option.adaptationId,
        optionId: option.optionId, decisionId: expect.any(String), status: 'PENDING_REVIEW',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM training_plan_revisions WHERE parent_revision_id = ?").get(source.revisionId))
        .toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM notification_intents
         WHERE related_entity_type = 'training_plan_revision' AND related_entity_id = ?
      `).get(option.proposedRevision!.revisionId)).toEqual({ count: 1 });
      expect(db.prepare('SELECT current_revision_id AS revisionId FROM training_plan_current_contexts').get())
        .toEqual({ revisionId: source.revisionId });
      expect(getTrainingAdaptationOptionEnvelope({ userId: 7, tenantId: 7 }, option.adaptationId, db))
        .toMatchObject({ mode: 'active', option: { optionId: option.optionId, decisionId: first.decisionId } });

      const decisionVersion = (db.prepare('SELECT record_version AS version FROM notification_center_items WHERE item_id = ?')
        .get(first.decisionId) as { version: number }).version;
      reviewDecision(first.decisionId, 7, 7, {
        outcome: 'defer', expectedVersion: decisionVersion, idempotencyKey: 'defer-adaptation-1',
      });
      expect(db.prepare('SELECT status FROM training_adaptation_proposals').get()).toEqual({ status: 'DEFERRED' });
      dismissDecision(first.decisionId, 7, 7, 'not_relevant', decisionVersion + 1);
      expect(db.prepare('SELECT lifecycle_state AS lifecycleState, approval_state AS approvalState FROM training_plan_revisions WHERE revision_id = ?')
        .get(option.proposedRevision!.revisionId)).toEqual({ lifecycleState: 'EXPIRED', approvalState: 'REJECTED' });
      expect(getTrainingAdaptationProposal({ userId: 7, tenantId: 7 }, option.adaptationId, db)?.status).toBe('REJECTED');
      expect(db.prepare(`
        SELECT event_type AS eventType, entity_id AS entityId, payload_json AS payloadJson
          FROM event_outbox WHERE event_type = 'training.adaptation.rejected.v1'
      `).all()).toEqual([expect.objectContaining({
        eventType: 'training.adaptation.rejected.v1',
        entityId: expect.any(String),
        payloadJson: expect.stringContaining('materialFingerprint'),
      })]);

      const duplicatePreview = previewTrainingAdaptation(busyPreviewInput(source, target.workoutKey, 'event-review-2'));
      const duplicate = duplicatePreview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      await expect(requestTrainingAdaptationReview({
        ...reviewInput,
        adaptationId: duplicate.adaptationId,
        optionId: duplicate.optionId,
        idempotencyKey: `training-adaptation-review:event-review-2:${duplicate.optionId}`,
      })).rejects.toMatchObject({ code: 'TRAINING_ADAPTATION_REJECTION_COOLDOWN' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_proposals').get()).toEqual({ count: 1 });
    });
  });

  it('activates an approved child with CAS, preserves completed history, and replays without duplicate effects', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const document = source.document as TrainingPlanRevisionDocument;
      const target = targetWorkout(document);
      const completedWorkout = document.weeks.flatMap((week) => week.workouts)
        .find((workout) => workout.workoutKey !== target.workoutKey)!;
      db.prepare(`
        UPDATE training_sessions SET status = 'completed'
         WHERE tenant_id = 7 AND revision_session_key = ?
      `).run(completedWorkout.workoutKey);
      const completedBefore = db.prepare(`
        SELECT id, status, source_revision_id AS sourceRevisionId, title
          FROM training_sessions WHERE tenant_id = 7 AND revision_session_key = ?
      `).get(completedWorkout.workoutKey);

      const preview = previewTrainingAdaptation(busyPreviewInput(source, target.workoutKey, 'event-activate-1'));
      const option = preview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      const review = await requestTrainingAdaptationReview({
        scope: { userId: 7, tenantId: 7 }, adaptationId: option.adaptationId,
        optionId: option.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-activate-1:${option.optionId}`,
        env: activeEnv, db,
      });
      const child = getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, option.proposedRevision!.revisionId, db)!;
      const decisionVersion = (db.prepare(`
        SELECT record_version AS version FROM notification_center_items WHERE item_id = ?
      `).get(review.decisionId) as { version: number }).version;
      db.prepare(`
        UPDATE notification_center_items
           SET decision_state = 'approved', record_version = record_version + 1, updated_at = datetime('now')
         WHERE item_id = ? AND record_version = ?
      `).run(review.decisionId, decisionVersion);
      db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, expected_record_version, context_version
        ) VALUES ('adaptation-execution', ?, 'activate_training_plan_revision', 7, 7,
          'adaptation-execution-key', 'training', 'started', ?, ?)
      `).run(review.decisionId, decisionVersion, child.creationContextVersion);

      const result = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'adaptation-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: activeEnv,
      });
      expect(result).toMatchObject({
        revisionId: child.revisionId, idempotent: false,
        activeReference: { activeRevisionId: child.revisionId, pointerVersion: 2 },
      });
      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycleState FROM training_plan_revisions WHERE revision_id = ?
      `).get(source.revisionId)).toEqual({ lifecycleState: 'SUPERSEDED' });
      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycleState, approval_state AS approvalState
          FROM training_plan_revisions WHERE revision_id = ?
      `).get(child.revisionId)).toEqual({ lifecycleState: 'ACTIVE', approvalState: 'APPROVED' });
      expect(db.prepare('SELECT status FROM training_adaptation_proposals').get()).toEqual({ status: 'ACTIVATED' });
      expect(db.prepare(`
        SELECT current_revision_id AS revisionId, current_context_version AS contextVersion,
               pointer_version AS pointerVersion
          FROM training_plan_current_contexts
      `).get()).toEqual({
        revisionId: child.revisionId, contextVersion: child.creationContextVersion, pointerVersion: 2,
      });
      expect(db.prepare(`
        SELECT id, status, source_revision_id AS sourceRevisionId, title
          FROM training_sessions WHERE tenant_id = 7 AND revision_session_key = ?
      `).get(completedWorkout.workoutKey)).toEqual(completedBefore);
      expect(db.prepare(`
        SELECT source_revision_id AS sourceRevisionId, duration_minutes AS duration
          FROM training_sessions WHERE tenant_id = 7 AND revision_session_key = ?
      `).get(target.workoutKey)).toMatchObject({ sourceRevisionId: child.revisionId });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM event_outbox
         WHERE event_type = 'training.plan_revision.activated.v1'
      `).get()).toEqual({ count: 2 });
      const outboxBeforeReplay = db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get();

      const replay = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'adaptation-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: activeEnv,
      });
      expect(replay.idempotent).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual(outboxBeforeReplay);
    });
  });

  it('reconciles M4 schedule identity and blocks preview or child activation after allowlist rollback', async () => {
    await withDb(async () => {
      const m4Env = {
        ...activeEnv,
        TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
      };
      const source = await createActiveRevision(m4Env, 'candidate-active-m4', {
        planMode: 'event_based', goal: 'event_performance', discipline: 'triathlon', horizonWeeks: 12,
        planStartDate: '2026-08-17',
        event: { name: 'Reviewed triathlon', date: '2026-11-08', priority: 'A', subtype: 'triathlon' },
        resourceAccess: {
          pool: true, bicycle: true, indoorTrainer: true,
          safeRunEnvironment: true, outdoorRideEnvironment: true,
        },
        capacity: {
          source: 'EXPLICIT_USER',
          windows: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'].map((dayOfWeek) => ({
            dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
            allowedDisciplines: ['running' as const, 'cycling' as const, 'swimming' as const, 'strength' as const],
          })),
        },
        goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['cycling', 'swimming'] },
        profile: {
          experienceLevel: 'intermediate', sessionsPerWeek: 5, sessionDurationMinutes: 60,
          availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
          equipmentIds: [], location: 'home',
        },
      });
      const sourceDocument = source.document as TrainingPlanRevisionDocument;
      const target = targetWorkout(sourceDocument);
      const revokedEnv = { ...m4Env, TRAINING_PLAN_M4_ALLOWLIST_USER_7: '' };
      expect(() => previewTrainingAdaptation(
        busyPreviewInput(source, target.workoutKey, 'event-m4-revoked-before-preview', revokedEnv),
      )).toThrow(expect.objectContaining({ code: 'TRAINING_M4_ALLOWLIST_REQUIRED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_adaptation_previews').get()).toEqual({ count: 0 });

      const preview = previewTrainingAdaptation(
        busyPreviewInput(source, target.workoutKey, 'event-m4-shorten', m4Env),
      );
      const option = preview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      const proposedDocument = option.proposedRevision!.document as TrainingPlanRevisionDocument;
      const proposedWorkout = targetWorkout(proposedDocument, target.workoutKey);
      const ongoingReferenceTime = new Date(Date.parse(target.scheduledStartAt!) - 1);
      expect(sourceDocument.weeks.flatMap((week) => week.workouts)
        .some((workout) => workout.sessionType !== 'rest'
          && Date.parse(workout.scheduledStartAt!) < ongoingReferenceTime.getTime())).toBe(true);
      expect(proposedWorkout.scheduledStartAt).toBe(target.scheduledStartAt);
      expect(proposedWorkout.scheduledEndAt).not.toBe(target.scheduledEndAt);
      expect(Date.parse(proposedWorkout.scheduledEndAt!) - Date.parse(proposedWorkout.scheduledStartAt!))
        .toBe(proposedWorkout.plannedDurationMinutes * 60_000);
      expect(proposedDocument.m4?.conflictSetHash).not.toBe(sourceDocument.m4?.conflictSetHash);
      expect(option.differences).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: `workouts.${target.workoutKey}.scheduledEndAt` }),
      ]));
      expect(option.currentScheduledStart).toBe(target.scheduledStartAt);
      expect(option.proposedScheduledStart).toBe(target.scheduledStartAt);

      const review = await requestTrainingAdaptationReview({
        scope: { userId: 7, tenantId: 7 }, adaptationId: option.adaptationId,
        optionId: option.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-m4-shorten:${option.optionId}`,
        env: m4Env, db,
      });
      const child = getScopedTrainingPlanRevision(
        { userId: 7, tenantId: 7 }, option.proposedRevision!.revisionId, db,
      )!;
      const normalizedAction = JSON.parse((db.prepare(`
        SELECT normalized_action_json AS action FROM notification_intents
         WHERE related_entity_id = ?
      `).get(child.revisionId) as { action: string }).action) as any;
      expect(normalizedAction.affectedResources).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'training_schedule', id: child.revisionId }),
      ]));
      expect(normalizedAction.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'training_revision_conflict_set',
          expectedVersion: (child.document as TrainingPlanRevisionDocument).m4?.conflictSetHash,
        }),
      ]));
      expect(normalizedAction.exclusivityKeys).toContain(`training_schedule:7:${child.familyId}`);

      const decisionVersion = (db.prepare(`
        SELECT record_version AS version FROM notification_center_items WHERE item_id = ?
      `).get(review.decisionId) as { version: number }).version;
      db.prepare(`
        UPDATE notification_center_items
           SET decision_state = 'approved', record_version = record_version + 1
         WHERE item_id = ?
      `).run(review.decisionId);
      db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, expected_record_version, context_version
        ) VALUES ('m4-adaptation-execution', ?, 'activate_training_plan_revision', 7, 7,
          'm4-adaptation-key', 'training', 'started', ?, ?)
      `).run(review.decisionId, decisionVersion, child.creationContextVersion);
      const outboxBefore = db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get();
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'm4-adaptation-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: revokedEnv,
        referenceTime: ongoingReferenceTime,
      })).rejects.toMatchObject({ code: 'TRAINING_M4_ALLOWLIST_REQUIRED' });
      expect(db.prepare('SELECT active_revision_id AS revisionId FROM training_active_plan_references').get())
        .toEqual({ revisionId: source.revisionId });
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual(outboxBefore);

      const activated = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'm4-adaptation-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: m4Env,
        referenceTime: ongoingReferenceTime,
      });
      expect(activated.activeReference).toMatchObject({ activeRevisionId: child.revisionId, pointerVersion: 2 });
    });
  });

  it('revalidates every changed workout in a broader scope immediately before adaptation activation', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const tiredInput = (eventId: string, adaptationScope: 'SESSION' | 'WEEK') => ({
        scope: { userId: 7, tenantId: 7 }, eventId, idempotencyKey: `training-adaptation:${eventId}`,
        currentRevisionId: source.revisionId, expectedContentHash: source.contentHash,
        contextVersion: source.creationContextVersion, adaptationScope,
        target: { workoutKey: target.workoutKey },
        explicitInput: {
          kind: 'TIRED_DAY' as const, selfReport: 'MORE_TIRED_THAN_EXPECTED' as const,
          reportedLevel: 'MORE_THAN_EXPECTED' as const,
        },
        env: activeEnv, db,
      });
      previewTrainingAdaptation(tiredInput('event-tired-evidence', 'SESSION'));
      const preview = previewTrainingAdaptation(tiredInput('event-stale-completion', 'WEEK'));
      const option = preview.preview.options.find((entry) => entry.action === 'REDUCE_VOLUME' && entry.scope === 'WEEK')!;
      const changedWorkoutKeys = option.differences
        .map((difference: any) => /^workouts\.([^.]+)\./.exec(difference.path)?.[1])
        .filter((value: string | undefined): value is string => !!value);
      const newlyHistoricalKey = changedWorkoutKeys.find((key: string) => key !== target.workoutKey)
        ?? changedWorkoutKeys[0];
      expect(newlyHistoricalKey).toBeDefined();
      const review = await requestTrainingAdaptationReview({
        scope: { userId: 7, tenantId: 7 }, adaptationId: option.adaptationId,
        optionId: option.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-stale-completion:${option.optionId}`,
        env: activeEnv, db,
      });
      const child = getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, option.proposedRevision!.revisionId, db)!;
      const decisionVersion = (db.prepare('SELECT record_version AS version FROM notification_center_items WHERE item_id = ?')
        .get(review.decisionId) as { version: number }).version;
      db.prepare("UPDATE notification_center_items SET decision_state = 'approved', record_version = record_version + 1 WHERE item_id = ?")
        .run(review.decisionId);
      db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, expected_record_version, context_version
        ) VALUES ('stale-completion-execution', ?, 'activate_training_plan_revision', 7, 7,
          'stale-completion-key', 'training', 'started', ?, ?)
      `).run(review.decisionId, decisionVersion, child.creationContextVersion);
      db.prepare("UPDATE training_sessions SET status = 'completed' WHERE tenant_id = 7 AND revision_session_key = ?")
        .run(newlyHistoricalKey);
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'stale-completion-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: activeEnv,
      })).rejects.toMatchObject({ code: 'TRAINING_ADAPTATION_COMPLETED_SESSION_IMMUTABLE' });
      expect(db.prepare('SELECT active_revision_id AS revisionId, pointer_version AS pointerVersion FROM training_active_plan_references').get())
        .toEqual({ revisionId: source.revisionId, pointerVersion: 1 });
    });
  });

  it('rejects source tampering after review without changing pointer, projection or outbox', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const target = targetWorkout(source.document as TrainingPlanRevisionDocument);
      const preview = previewTrainingAdaptation(
        busyPreviewInput(source, target.workoutKey, 'event-source-tamper-after-review'),
      );
      const option = preview.preview.options.find((entry) => entry.action === 'SHORTEN')!;
      const review = await requestTrainingAdaptationReview({
        scope: { userId: 7, tenantId: 7 }, adaptationId: option.adaptationId,
        optionId: option.optionId, expectedCurrentRevisionId: source.revisionId,
        expectedContextVersion: source.creationContextVersion,
        idempotencyKey: `training-adaptation-review:event-source-tamper-after-review:${option.optionId}`,
        env: activeEnv, db,
      });
      const child = getScopedTrainingPlanRevision(
        { userId: 7, tenantId: 7 }, option.proposedRevision!.revisionId, db,
      )!;
      const decisionVersion = (db.prepare(`
        SELECT record_version AS version FROM notification_center_items WHERE item_id = ?
      `).get(review.decisionId) as { version: number }).version;
      db.prepare(`
        UPDATE notification_center_items
           SET decision_state = 'approved', record_version = record_version + 1
         WHERE item_id = ?
      `).run(review.decisionId);
      db.prepare(`
        INSERT INTO decision_action_executions (
          action_execution_id, decision_id, action_id, user_id, tenant_id,
          idempotency_key, executor_skill, status, expected_record_version, context_version
        ) VALUES ('source-tamper-execution', ?, 'activate_training_plan_revision', 7, 7,
          'source-tamper-key', 'training', 'started', ?, ?)
      `).run(review.decisionId, decisionVersion, child.creationContextVersion);
      db.exec('DROP TRIGGER trg_training_plan_revisions_content_immutable');
      db.prepare(`
        UPDATE training_plan_revisions
           SET revision_document_json = json_set(revision_document_json, '$.title', 'tampered after review')
         WHERE revision_id = ?
      `).run(source.revisionId);
      const pointerBefore = db.prepare(`
        SELECT active_revision_id AS revisionId, pointer_version AS pointerVersion
          FROM training_active_plan_references
      `).get();
      const projectionBefore = db.prepare('SELECT COUNT(*) AS count FROM training_sessions').get();
      const outboxBefore = db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get();
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: child.revisionId,
        approval: {
          decisionId: review.decisionId, decisionRecordVersion: decisionVersion,
          actionExecutionId: 'source-tamper-execution', approvedContentHash: child.contentHash,
          approvedContextVersion: child.creationContextVersion,
        },
        env: activeEnv,
        referenceTime: new Date('2026-07-13T12:00:00.000Z'),
      })).rejects.toMatchObject({ code: 'TRAINING_ADAPTATION_SOURCE_INTEGRITY_FAILED' });
      expect(db.prepare(`
        SELECT active_revision_id AS revisionId, pointer_version AS pointerVersion
          FROM training_active_plan_references
      `).get()).toEqual(pointerBefore);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_sessions').get()).toEqual(projectionBefore);
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual(outboxBefore);
    });
  });

  it('accepts the exact base catalog for purposeful substitutions', async () => {
    await withDb(async () => {
      const source = await createActiveRevision();
      const substitution = findEligibleSubstitutionPreview(source, activeEnv, 'base-catalog-substitution');
      expect(substitution.preview.options).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'SUBSTITUTE_EXERCISE',
          approvalRequirement: 'DECISION_CENTER',
          substitution: expect.objectContaining({ equipmentCompatible: true }),
        }),
      ]));
    });
  });

  it('accepts only an integrity-verified identity catalog and rejects forged pins', async () => {
    await withDb(async () => {
      const identityEnv = {
        ...activeEnv,
        TRAINING_EXERCISE_IDENTITY_V1_MODE_USER_7: 'active',
      };
      const source = await createActiveRevision(identityEnv, 'candidate-active-identity');
      expect(source.catalog).toMatchObject({
        version: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
        sourceHash: TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
      });
      expect(findEligibleSubstitutionPreview(source, identityEnv, 'identity-catalog-substitution').preview.options)
        .toEqual(expect.arrayContaining([expect.objectContaining({ action: 'SUBSTITUTE_EXERCISE' })]));

      db.exec('DROP TRIGGER trg_training_plan_revisions_content_immutable');
      db.prepare(`
        UPDATE training_plan_revisions
           SET catalog_version = 'forged-catalog', catalog_source_hash = ?
         WHERE revision_id = ?
      `).run('f'.repeat(64), source.revisionId);
      expect(() => findEligibleSubstitutionPreview(source, identityEnv, 'forged-catalog-substitution'))
        .toThrow(expect.objectContaining({ code: 'TRAINING_ADAPTATION_CATALOG_STALE' }));
    });
  });

  async function createActiveRevision(
    env: NodeJS.ProcessEnv = activeEnv,
    idempotencyKey = 'candidate-active',
    candidateRequest: Parameters<typeof createTrainingPlanCandidateRevision>[0]['request'] = {
      planMode: 'continuous', goal: 'general_fitness', discipline: 'strength', horizonWeeks: 4,
      profile: {
        experienceLevel: 'intermediate', sessionsPerWeek: 3, sessionDurationMinutes: 60,
        availableDays: ['monday', 'wednesday', 'friday'],
        equipmentIds: ['dumbbell', 'resistance_band', 'bench'], location: 'gym',
      },
    },
  ) {
    const created = createTrainingPlanCandidateRevision({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey, env,
      request: candidateRequest,
    });
    const revision = created.candidates[0];
    db.prepare(`
      UPDATE training_plan_revisions
         SET lifecycle_state = 'PENDING_REVIEW', approval_state = 'PENDING',
             decision_id = 'source-decision', review_requested_at = datetime('now')
       WHERE revision_id = ?
    `).run(revision.revisionId);
    seedApprovalEvidence(revision.revisionId, revision.contentHash, revision.creationContextVersion);
    await activateApprovedTrainingPlanRevision({
      scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
      approval: {
        decisionId: 'source-decision', decisionRecordVersion: 3, actionExecutionId: 'source-execution',
        approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
      },
      activationDate: '2026-07-13', env,
    });
    return getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, revision.revisionId, db)!;
  }

  function seedApprovalEvidence(revisionId: string, contentHash: string, contextVersion: string): void {
    db.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority,
        related_entity_id, related_entity_type, title, body, normalized_action_json
      ) VALUES ('source-intent', 7, 7, 'training', 'approval_required', 'active', ?,
        'training_plan_revision', 'Review plan', 'Review plan', ?)
    `).run(revisionId, JSON.stringify({
      contextVersion,
      targetEntities: [{ type: 'training_plan_revision', id: revisionId, version: contentHash }],
      authorizationScope: ['decision_center:write', 'training:plan:write'],
    }));
    db.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, decision_state, record_version
      ) VALUES ('source-decision', 'source-intent', 7, 7, 'Review plan', 'Review plan',
        'Review plan', 'training', 'approval_required', 'active', 'approved', 4)
    `).run();
    db.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_record_version, context_version
      ) VALUES ('source-execution', 'source-decision', 'activate_training_plan_revision', 7, 7,
        'source-idempotency', 'training', 'started', 3, ?)
    `).run(contextVersion);
  }

  function busyPreviewInput(
    source: ReturnType<typeof getScopedTrainingPlanRevision> & {},
    workoutKey: string,
    eventId: string,
    env: NodeJS.ProcessEnv = activeEnv,
  ) {
    const workout = targetWorkout(source.document as TrainingPlanRevisionDocument, workoutKey);
    const essentialMinimum = workout.blocks.filter((block) => block.priority === 'ESSENTIAL')
      .reduce((sum, block) => sum + block.minimumDurationMinutes, 0);
    return {
      scope: { userId: 7, tenantId: 7 }, eventId, idempotencyKey: `training-adaptation:${eventId}`,
      currentRevisionId: source.revisionId, expectedContentHash: source.contentHash,
      contextVersion: source.creationContextVersion, adaptationScope: 'SESSION' as const,
      target: { workoutKey }, explicitInput: { kind: 'BUSY_DAY' as const, availableMinutes: essentialMinimum + 5 },
      env, db,
    };
  }

  function findEligibleSubstitutionPreview(
    source: ReturnType<typeof getScopedTrainingPlanRevision> & {},
    env: NodeJS.ProcessEnv,
    eventPrefix: string,
  ) {
    const candidates = (source.document as TrainingPlanRevisionDocument).weeks
      .flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks.flatMap((block) => (block.exercises ?? []).map((exercise) => ({
        workoutKey: workout.workoutKey,
        blockId: block.blockId,
        exerciseId: exercise.exerciseId,
      }))));
    for (const [index, candidate] of candidates.entries()) {
      const eventId = `${eventPrefix}-${index + 1}`;
      const preview = previewTrainingAdaptation({
        scope: { userId: 7, tenantId: 7 }, eventId,
        idempotencyKey: `training-adaptation:${eventId}`,
        currentRevisionId: source.revisionId,
        expectedContentHash: source.contentHash,
        contextVersion: source.creationContextVersion,
        adaptationScope: 'SESSION',
        target: candidate,
        explicitInput: {
          kind: 'SUBSTITUTION', reason: 'EXCLUSION', originalExerciseId: candidate.exerciseId,
          unavailableEquipmentIds: [], exclusions: [candidate.exerciseId],
        },
        env, db,
      });
      if (preview.preview.options.some((option) => option.action === 'SUBSTITUTE_EXERCISE')) return preview;
    }
    throw new Error('No eligible purposeful substitution fixture was found.');
  }

  async function withDb<T>(operation: () => Promise<T>): Promise<T> {
    const previous = { ...process.env };
    Object.assign(process.env, activeEnv, { VITEST: 'true' });
    try {
      return await withDatabaseForTestAsync(db, operation);
    } finally {
      process.env = previous;
    }
  }
});

function targetWorkout(document: TrainingPlanRevisionDocument, workoutKey?: string) {
  return document.weeks.flatMap((week) => week.workouts)
    .find((workout) => workout.workoutKey === workoutKey)
    ?? document.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.sessionType.startsWith('strength_'))!;
}
