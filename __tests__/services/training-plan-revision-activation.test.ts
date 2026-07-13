// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';
import { activateApprovedTrainingPlanRevision } from '../../src/services/training-plan-revision-activation';
import { createTrainingPlanCandidateRevision } from '../../src/services/training-plan-revisions';
import { runLegacyActivePlanBackfill } from '../../src/services/training-plan-revision-legacy-backfill';

const activeEnv = {
  TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
  DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
  TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
};

const request: TrainingPlanCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice',
    sessionsPerWeek: 3,
    sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: [],
    location: 'home',
  },
};

describe('training-plan-revision-activation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrationsForTest(db);
  });

  it('atomically materializes a new projection, receipt, active pointer and outbox event', async () => {
    await withDb(async () => {
      const revision = createBoundRevision();
      seedApprovalEvidence(revision.revisionId, revision.contentHash, revision.creationContextVersion, 'execution-1');
      const result = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 },
        revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1',
          decisionRecordVersion: 3,
          actionExecutionId: 'execution-1',
          approvedContentHash: revision.contentHash,
          approvedContextVersion: revision.creationContextVersion,
        },
        activationDate: '2026-07-13',
        env: activeEnv,
      });

      expect(result).toMatchObject({
        revisionId: revision.revisionId,
        projection: { planId: expect.any(Number), weekCount: 4 },
        activeReference: { activeRevisionId: revision.revisionId, pointerVersion: 1 },
        idempotent: false,
      });
      expect(result.projection.sessionCount).toBeGreaterThan(12);
      expect(db.prepare('SELECT status, source_revision_id FROM fitness_training_plans').get()).toEqual({
        status: 'active', source_revision_id: revision.revisionId,
      });
      expect(db.prepare('SELECT lifecycle_state, approval_state FROM training_plan_revisions').get()).toEqual({
        lifecycle_state: 'ACTIVE', approval_state: 'APPROVED',
      });
      expect(db.prepare('SELECT approved_content_hash FROM training_plan_revision_approvals').get()).toEqual({
        approved_content_hash: revision.contentHash,
      });
      expect(db.prepare('SELECT event_type, entity_id, idempotency_key FROM event_outbox').get()).toEqual({
        event_type: 'training.plan_revision.activated.v1', entity_id: revision.revisionId,
        idempotency_key: `training.plan_revision.activated:${revision.revisionId}`,
      });

      const replay = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 },
        revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-1',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        activationDate: '2026-07-13', env: activeEnv,
      });
      expect(replay.idempotent).toBe(true);
      expect(replay.projection.planId).toBe(result.projection.planId);
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });

      db.prepare(`
        INSERT INTO user_profiles (user_id, profile_type, data)
        VALUES (7, 'fitness', '{"later":"profile change"}')
      `).run();
      const committedReplayAfterContextChange = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-1',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        activationDate: '2026-07-13', env: activeEnv,
      });
      expect(committedReplayAfterContextChange).toMatchObject({ idempotent: true, revisionId: revision.revisionId });

      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 },
        revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-other',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        activationDate: '2026-07-13', env: activeEnv,
      })).rejects.toMatchObject({ code: 'TRAINING_REVISION_ACTIVATION_REPLAY_EVIDENCE_MISMATCH' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual({ count: 1 });
    });
  });

  it('fails before writes when approval content or context is stale', async () => {
    await withDb(async () => {
      const revision = createBoundRevision();
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-stale',
          approvedContentHash: 'stale', approvedContextVersion: revision.creationContextVersion,
        },
        env: activeEnv,
      })).rejects.toMatchObject({ code: 'TRAINING_REVISION_APPROVAL_STALE' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual({ count: 0 });
    });
  });

  it('materializes typed event blocks and modality prescriptions without changing flag-off projection behavior', async () => {
    await withDb(async () => {
      const typedRequest: TrainingPlanCandidateRequest = {
        planMode: 'event_based', goal: 'event_performance', discipline: 'triathlon', horizonWeeks: 8,
        event: { name: 'Target triathlon', date: '2026-10-18', priority: 'A' },
        profile: {
          experienceLevel: 'intermediate', sessionsPerWeek: 4, sessionDurationMinutes: 45,
          availableDays: ['monday', 'wednesday', 'friday', 'sunday'],
          equipmentIds: [], location: 'home',
        },
      };
      const typedEnv = { ...activeEnv, TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true' };
      const revision = createBoundRevision(typedRequest, typedEnv);
      seedApprovalEvidence(revision.revisionId, revision.contentHash, revision.creationContextVersion, 'execution-typed');
      const result = await activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-typed',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        activationDate: '2026-07-13', env: typedEnv,
      });
      expect(result.projection).toMatchObject({ weekCount: 8, sessionCount: 56 });
      expect(db.prepare(`
        SELECT sport, goal, periodization, source_revision_id AS sourceRevisionId
          FROM fitness_training_plans
      `).get()).toEqual({
        sport: 'triathlon', goal: 'event_performance', periodization: 'block', sourceRevisionId: revision.revisionId,
      });
      const structured = db.prepare(`
        SELECT description_json AS descriptionJson, intensity_text AS intensityText
          FROM training_sessions WHERE session_type = 'brick' LIMIT 1
      `).get() as { descriptionJson: string; intensityText: string };
      const parsedDescription = JSON.parse(structured.descriptionJson) as {
        schemaVersion: string;
        blocks: Array<{ blockType: string; prescription: { kind: string } }>;
      };
      expect(parsedDescription.schemaVersion).toBe('training-workout-blocks.v1');
      expect(parsedDescription.blocks.find((block) => block.blockType === 'PRIMARY_WORK'))
        .toMatchObject({ prescription: { kind: 'mixed_session' } });
      expect(structured.intensityText).toMatch(/ordered modality segments/);
    });
  });

  it('never replaces an existing legacy active plan in Milestone 1', async () => {
    await withDb(async () => {
      const revision = createBoundRevision();
      seedApprovalEvidence(revision.revisionId, revision.contentHash, revision.creationContextVersion, 'execution-legacy');
      db.prepare(`
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status
        ) VALUES (7, 7, 'Legacy active', 'strength', 4, '2026-07-01', '2026-07-28', 'active')
      `).run();
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-legacy',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        env: activeEnv,
      })).rejects.toMatchObject({ code: 'TRAINING_EXISTING_ACTIVE_PLAN_NOT_REPLACEABLE_IN_M1' });
      expect(db.prepare('SELECT name, status, source_revision_id FROM fitness_training_plans').get()).toEqual({
        name: 'Legacy active', status: 'active', source_revision_id: null,
      });
    });
  });

  it('never creates a second active plan beside a backfilled LEGACY_ACTIVE reference', async () => {
    await withDb(async () => {
      const revision = createBoundRevision();
      db.prepare(`
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status
        ) VALUES (7, 7, 'Backfilled legacy', 'strength', 4, '2026-07-01', '2026-07-28', 'active')
      `).run();
      const rehearsal = runLegacyActivePlanBackfill({
        mode: 'dry_run', scope: { userId: 7, tenantId: 7 }, db,
      });
      runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 7 }, db, env: activeEnv,
        expectedDigest: rehearsal.digest,
      });
      seedApprovalEvidence(revision.revisionId, revision.contentHash, revision.creationContextVersion, 'execution-backfilled');
      await expect(activateApprovedTrainingPlanRevision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
        approval: {
          decisionId: 'decision-1', decisionRecordVersion: 3, actionExecutionId: 'execution-backfilled',
          approvedContentHash: revision.contentHash, approvedContextVersion: revision.creationContextVersion,
        },
        env: activeEnv,
      })).rejects.toMatchObject({ code: 'TRAINING_LEGACY_ACTIVE_REPLACEMENT_NOT_IN_M1' });
      expect(db.prepare("SELECT COUNT(*) AS count FROM fitness_training_plans WHERE status = 'active'").get())
        .toEqual({ count: 1 });
    });
  });

  function createBoundRevision(
    candidateRequest: TrainingPlanCandidateRequest = request,
    env: NodeJS.ProcessEnv = activeEnv,
  ) {
    const created = createTrainingPlanCandidateRevision({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: `candidate-${Math.random()}`,
      request: candidateRequest, env,
    });
    const revision = created.candidates[0];
    db.prepare(`
      UPDATE training_plan_revisions
         SET lifecycle_state = 'PENDING_REVIEW', approval_state = 'PENDING',
             decision_id = 'decision-1', review_requested_at = '2026-07-12T10:00:00.000Z'
       WHERE revision_id = ?
    `).run(revision.revisionId);
    return revision;
  }

  function seedApprovalEvidence(
    revisionId: string,
    contentHash: string,
    contextVersion: string,
    executionId: string,
  ): void {
    db.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority,
        related_entity_id, related_entity_type, title, body, normalized_action_json
      ) VALUES ('intent-1', 7, 7, 'training', 'approval_required', 'active', ?,
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
      ) VALUES ('decision-1', 'intent-1', 7, 7, 'Review plan', 'Review plan',
        'Review plan', 'training', 'approval_required', 'active', 'approved', 4)
    `).run();
    db.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_record_version, context_version
      ) VALUES (?, 'decision-1', 'activate_training_plan_revision', 7, 7,
        ?, 'training', 'started', 3, ?)
    `).run(executionId, `idempotency-${executionId}`, contextVersion);
  }

  async function withDb<T>(operation: () => Promise<T>): Promise<T> {
    const previous = process.env.VITEST;
    process.env.VITEST = 'true';
    try {
      return await withDatabaseForTestAsync(db, operation);
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  }
});
