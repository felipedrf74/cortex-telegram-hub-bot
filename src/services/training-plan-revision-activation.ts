// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';
import {
  isTrainingDecisionFlowV1EnforceEnabled,
  getTrainingAdaptationV1Mode,
  getTrainingPlanRevisionV1Mode,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  isTrainingTypedWorkoutV1Enabled,
  isTrainingM4PlanCombinationAllowed,
  isTrainingM4OwnedCombination,
} from './runtime-flags';
import {
  withTrainingCalendarOperationLock,
  type TrainingOperationLockLease,
} from './training-operation-locks';
import {
  getActiveTrainingPlanReference,
  computeTrainingRevisionAuthoritativeContext,
  deriveTrainingRevisionCreationContextVersion,
  getScopedTrainingProfileSnapshot,
  getScopedTrainingPlanRevision,
  requirePersonalTrainingRevisionScope,
  TrainingPlanRevisionError,
  type TrainingActivePlanReferenceResource,
  type TrainingPlanRevisionScope,
} from './training-plan-revisions';
export { TrainingPlanRevisionError } from './training-plan-revisions';
import type {
  TrainingPlanRevisionDocument,
  TrainingPlanRevisionWorkout,
} from './training-plan-revision-candidate-builder';
import {
  buildTrainingPlanRevisionCandidate,
  countActiveWorkouts,
  stableTrainingRevisionHash,
  validateTrainingPlanRevisionDocument,
} from './training-plan-revision-candidate-builder';
import { incrementTrainingGenerationCounter } from './training-generation-observability';
import { findTargetWorkout, targetWorkoutKeysForScope, type TrainingAdaptationScope } from './training-adaptation-types';
import { getTrainingM4AuthoritativeCapacityContext } from './training-m4-capacity-context';
import {
  contractTrainingM4ScheduledWindow,
  validateTrainingM4AdaptationFreshness,
  validateTrainingM4InitialScheduleFreshness,
} from './training-m4-plan-strategies';

export interface TrainingPlanRevisionApprovalEvidence {
  decisionId: string;
  decisionRecordVersion: number;
  actionExecutionId: string;
  approvedContentHash: string;
  approvedContextVersion: string;
}

export interface TrainingPlanRevisionActivationResult {
  revisionId: string;
  familyId: string;
  projection: {
    planId: number;
    weekCount: number;
    sessionCount: number;
  };
  activeReference: TrainingActivePlanReferenceResource;
  idempotent: boolean;
}

interface AdaptationActivationRow {
  proposal_id: string;
  source_revision_id: string;
  proposed_revision_id: string;
  decision_id: string | null;
  status: string;
  expected_source_content_hash: string;
  expected_context_version: string;
  expected_active_pointer_version: number;
  option_hash: string;
  selected_option_id: string;
  target_json: string;
  scope: TrainingAdaptationScope;
  expires_at: string;
}

export async function activateApprovedTrainingPlanRevision(input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  approval: TrainingPlanRevisionApprovalEvidence;
  activationDate?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal deterministic clock seam. HTTP callers cannot supply it. */
  referenceTime?: Date;
}): Promise<TrainingPlanRevisionActivationResult> {
  try {
    requireActivationFlags(input.scope, input.env);
    const resolvedInput = { ...input, referenceTime: input.referenceTime ?? new Date() };
    return await withTrainingCalendarOperationLock({
      ...input.scope,
      operation: 'plan_activate',
    }, async (lease) => activateUnderLock(resolvedInput, lease));
  } catch (error) {
    if (error instanceof TrainingPlanRevisionError && error.statusCode === 409) {
      incrementTrainingGenerationCounter('revision_activation_conflict_total');
    }
    throw error;
  }
}

function activateUnderLock(input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  approval: TrainingPlanRevisionApprovalEvidence;
  activationDate?: string;
  env?: NodeJS.ProcessEnv;
  referenceTime: Date;
}, lease: TrainingOperationLockLease): TrainingPlanRevisionActivationResult {
  lease.assertActive();
  const db = getDb();
  const before = validateActivationInput(db, input);
  const adaptation = findAdaptationForRevision(db, input.scope, input.revisionId);
  const active = getActiveTrainingPlanReference(input.scope, before.familyId, db);
  if (active?.activeRevisionId === input.revisionId) {
    return readActivationResult(db, input.scope, before.familyId, input.revisionId, true);
  }
  if (adaptation) {
    requireAdaptationActivationFlags(input.scope, input.env);
    return activateAdaptationUnderLock(db, input, before, adaptation, lease);
  }
  if (active) {
    const current = getScopedTrainingPlanRevision(input.scope, active.activeRevisionId, db);
    if (current?.lifecycleState === 'LEGACY_ACTIVE') {
      throw new TrainingPlanRevisionError(
        'TRAINING_LEGACY_ACTIVE_REPLACEMENT_NOT_IN_M1',
        'Replacing a legacy active plan is outside Milestone 1.',
        409,
      );
    }
    throw new TrainingPlanRevisionError(
      'TRAINING_ACTIVE_REVISION_REPLACEMENT_NOT_IN_M1',
      'Replacing an active revision is outside Milestone 1.',
      409,
    );
  }

  assertNoExistingActivePlan(db, input.scope);

  return db.transaction(() => {
    lease.assertActive();
    // Revalidate inside the write transaction so no pointer/content state can
    // change between the preflight and projection insert.
    const revision = validateActivationInput(db, input);
    const concurrentActive = getActiveTrainingPlanReference(input.scope, revision.familyId, db);
    if (concurrentActive) {
      if (concurrentActive.activeRevisionId === input.revisionId) {
        return readActivationResult(db, input.scope, revision.familyId, input.revisionId, true);
      }
      throw new TrainingPlanRevisionError('TRAINING_ACTIVE_POINTER_CONFLICT', 'The active plan pointer changed.', 409);
    }
    assertNoExistingActivePlan(db, input.scope);

    const document = revision.document as TrainingPlanRevisionDocument;
    const activationDate = document.m4 && document.planStartDate
      ? normalizeIsoDate(document.planStartDate)
      : normalizeIsoDate(input.activationDate);
    const projection = materializeCompatibilityProjection(
      db,
      input.scope,
      document,
      input.revisionId,
      activationDate,
    );
    db.prepare(`
      INSERT INTO training_plan_revision_approvals (
        approval_id, tenant_id, user_id, family_id, revision_id, decision_id,
        decision_record_version, action_execution_id, approved_content_hash,
        approved_context_version, actor_type, approval_source, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 'DECISION_CENTER', ?)
    `).run(
      `trpa_${input.approval.actionExecutionId}`,
      input.scope.tenantId,
      input.scope.userId,
      revision.familyId,
      input.revisionId,
      input.approval.decisionId,
      input.approval.decisionRecordVersion,
      input.approval.actionExecutionId,
      input.approval.approvedContentHash,
      input.approval.approvedContextVersion,
      new Date().toISOString(),
    );
    db.prepare(`
      INSERT INTO training_active_plan_references (
        tenant_id, user_id, family_id, active_revision_id, projection_plan_id,
        pointer_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).run(
      input.scope.tenantId,
      input.scope.userId,
      revision.familyId,
      input.revisionId,
      projection.planId,
    );
    db.prepare(`
      UPDATE training_plan_revisions
         SET lifecycle_state = 'ACTIVE', approval_state = 'APPROVED', activated_at = datetime('now')
       WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
         AND lifecycle_state = 'PENDING_REVIEW' AND approval_state = 'PENDING'
    `).run(input.revisionId, input.scope.tenantId, input.scope.userId);
    emitDomainEvent({
      tenantId: input.scope.tenantId,
      userId: input.scope.userId,
      sourceSkill: 'training',
      eventType: 'training.plan_revision.activated.v1',
      entityType: 'training_plan_revision',
      entityId: input.revisionId,
      entityVersion: revision.revisionSequence,
      schemaVersion: 'training-plan-revision-activation.v1',
      payload: {
        action: 'ACTIVATE',
        schemaVersion: 'training-plan-revision-activation.v1',
        revisionId: input.revisionId,
        familyId: revision.familyId,
        contentHash: revision.contentHash,
        creationContextVersion: revision.creationContextVersion,
        catalogSourceHash: revision.catalog.sourceHash,
        projectionPlanId: projection.planId,
        pointerVersion: 1,
        ...capacityLearningPayload(input.scope, document),
      },
      privacyClassification: 'health',
      idempotencyKey: `training.plan_revision.activated:${input.revisionId}`,
      causationId: input.approval.actionExecutionId,
    }, db);
    const result = readActivationResult(db, input.scope, revision.familyId, input.revisionId, false);
    // Keep the ownership check inside the same transaction as projection,
    // active-pointer, approval, and outbox writes so a stale holder rolls the
    // entire activation graph back instead of merely failing after commit.
    lease.assertActive();
    return result;
  })();
}

function assertNoExistingActivePlan(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
): void {
  const existingActivePlan = db.prepare(`
    SELECT plans.id, revisions.lifecycle_state AS revisionLifecycleState
      FROM fitness_training_plans plans
      LEFT JOIN training_plan_revisions revisions
        ON revisions.revision_id = plans.source_revision_id
       AND revisions.user_id = plans.user_id
       AND revisions.tenant_id = plans.tenant_id
     WHERE plans.user_id = ? AND plans.tenant_id = ? AND plans.status = 'active'
     ORDER BY plans.id ASC
     LIMIT 1
  `).get(scope.userId, scope.tenantId) as {
    id: number;
    revisionLifecycleState: string | null;
  } | undefined;
  if (existingActivePlan?.revisionLifecycleState === 'LEGACY_ACTIVE') {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_ACTIVE_REPLACEMENT_NOT_IN_M1',
      'Replacing a legacy active plan is outside Milestone 1.',
      409,
    );
  }
  if (existingActivePlan) {
    throw new TrainingPlanRevisionError(
      'TRAINING_EXISTING_ACTIVE_PLAN_NOT_REPLACEABLE_IN_M1',
      'An existing active plan must remain unchanged in Milestone 1.',
      409,
    );
  }
}

function activateAdaptationUnderLock(
  db: Database.Database,
  input: {
    scope: TrainingPlanRevisionScope;
    revisionId: string;
    approval: TrainingPlanRevisionApprovalEvidence;
    env?: NodeJS.ProcessEnv;
    referenceTime: Date;
  },
  before: NonNullable<ReturnType<typeof getScopedTrainingPlanRevision>>,
  adaptation: AdaptationActivationRow,
  lease: TrainingOperationLockLease,
): TrainingPlanRevisionActivationResult {
  lease.assertActive();
  const active = getActiveTrainingPlanReference(input.scope, before.familyId, db);
  if (!active || active.activeRevisionId !== adaptation.source_revision_id
      || active.pointerVersion !== adaptation.expected_active_pointer_version
      || active.projectionPlanId == null) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_ACTIVE_POINTER_CONFLICT',
      'The active Training revision changed before the approved adaptation could apply.',
      409,
    );
  }
  const source = getScopedTrainingPlanRevision(input.scope, adaptation.source_revision_id, db);
  if (!source || source.lifecycleState === 'LEGACY_ACTIVE' || source.origin !== 'GENERATED') {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_ACTIVE_REPLACEMENT_NOT_IN_M1',
      'Legacy active revisions cannot be replaced by the Milestone 3 adaptation flow.',
      409,
    );
  }

  return db.transaction(() => {
    lease.assertActive();
    const revision = validateActivationInput(db, input);
    const proposal = findAdaptationForRevision(db, input.scope, revision.revisionId);
    const current = getActiveTrainingPlanReference(input.scope, revision.familyId, db);
    if (!proposal || proposal.proposal_id !== adaptation.proposal_id
        || !current || current.activeRevisionId !== proposal.source_revision_id
        || current.pointerVersion !== proposal.expected_active_pointer_version
        || current.projectionPlanId == null) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_ACTIVE_POINTER_CONFLICT',
        'The active Training revision changed during adaptation activation.',
        409,
      );
    }
    const projection = applyAdaptationCompatibilityProjection(
      db,
      input.scope,
      current.projectionPlanId,
      proposal.source_revision_id,
      revision.revisionId,
      revision.document as TrainingPlanRevisionDocument,
    );
    db.prepare(`
      INSERT INTO training_plan_revision_approvals (
        approval_id, tenant_id, user_id, family_id, revision_id, decision_id,
        decision_record_version, action_execution_id, approved_content_hash,
        approved_context_version, actor_type, approval_source, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 'DECISION_CENTER', ?)
    `).run(
      `trpa_${input.approval.actionExecutionId}`,
      input.scope.tenantId,
      input.scope.userId,
      revision.familyId,
      revision.revisionId,
      input.approval.decisionId,
      input.approval.decisionRecordVersion,
      input.approval.actionExecutionId,
      input.approval.approvedContentHash,
      input.approval.approvedContextVersion,
      new Date().toISOString(),
    );
    const pointer = db.prepare(`
      UPDATE training_active_plan_references
         SET active_revision_id = ?, pointer_version = pointer_version + 1,
             updated_at = datetime('now')
       WHERE tenant_id = ? AND user_id = ? AND family_id = ?
         AND active_revision_id = ? AND pointer_version = ?
    `).run(
      revision.revisionId,
      input.scope.tenantId,
      input.scope.userId,
      revision.familyId,
      proposal.source_revision_id,
      proposal.expected_active_pointer_version,
    );
    if (pointer.changes !== 1) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_ACTIVE_POINTER_CONFLICT',
        'The active Training revision changed during compare-and-swap.',
        409,
      );
    }
    const currentContext = db.prepare(`
      UPDATE training_plan_current_contexts
         SET current_revision_id = ?, current_profile_snapshot_id = ?,
             current_context_version = ?, pointer_version = pointer_version + 1,
             updated_at = datetime('now')
       WHERE tenant_id = ? AND user_id = ? AND family_id = ?
         AND current_revision_id = ? AND current_context_version = ?
         AND pointer_version = ?
    `).run(
      revision.revisionId,
      revision.profileSnapshotId,
      revision.creationContextVersion,
      input.scope.tenantId,
      input.scope.userId,
      revision.familyId,
      proposal.source_revision_id,
      proposal.expected_context_version,
      proposal.expected_active_pointer_version,
    );
    if (currentContext.changes !== 1) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_CONTEXT_CAS_CONFLICT',
        'The current Training context changed during compare-and-swap.',
        409,
      );
    }
    const sourceUpdate = db.prepare(`
      UPDATE training_plan_revisions
         SET lifecycle_state = 'SUPERSEDED', superseded_at = datetime('now')
       WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
         AND lifecycle_state = 'ACTIVE' AND approval_state = 'APPROVED'
    `).run(proposal.source_revision_id, input.scope.tenantId, input.scope.userId);
    const childUpdate = db.prepare(`
      UPDATE training_plan_revisions
         SET lifecycle_state = 'ACTIVE', approval_state = 'APPROVED', activated_at = datetime('now')
       WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
         AND lifecycle_state = 'PENDING_REVIEW' AND approval_state = 'PENDING'
    `).run(revision.revisionId, input.scope.tenantId, input.scope.userId);
    const proposalUpdate = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'ACTIVATED', activated_at = datetime('now')
       WHERE proposal_id = ? AND tenant_id = ? AND user_id = ?
         AND proposed_revision_id = ? AND decision_id = ? AND status IN ('PENDING_REVIEW', 'DEFERRED')
    `).run(
      proposal.proposal_id,
      input.scope.tenantId,
      input.scope.userId,
      revision.revisionId,
      input.approval.decisionId,
    );
    if (sourceUpdate.changes !== 1 || childUpdate.changes !== 1 || proposalUpdate.changes !== 1) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_ACTIVATION_STATE_CONFLICT',
        'The adaptation lifecycle changed before activation completed.',
        409,
      );
    }
    db.prepare(`
      INSERT INTO training_adaptation_lifecycle_events (
        event_id, proposal_id, tenant_id, user_id, event_type, metadata_json
      ) VALUES (?, ?, ?, ?, 'ACTIVATED', ?)
    `).run(
      `tale_${createHash('sha256').update(`activated:${proposal.proposal_id}`).digest('hex').slice(0, 32)}`,
      proposal.proposal_id,
      input.scope.tenantId,
      input.scope.userId,
      JSON.stringify({ sourceRevisionId: proposal.source_revision_id, proposedRevisionId: revision.revisionId }),
    );
    emitDomainEvent({
      tenantId: input.scope.tenantId,
      userId: input.scope.userId,
      sourceSkill: 'training',
      eventType: 'training.plan_revision.activated.v1',
      entityType: 'training_plan_revision',
      entityId: revision.revisionId,
      entityVersion: revision.revisionSequence,
      schemaVersion: 'training-plan-revision-activation.v1',
      payload: {
        action: 'ADAPT',
        schemaVersion: 'training-plan-revision-activation.v1',
        adaptationProposalId: proposal.proposal_id,
        sourceRevisionId: proposal.source_revision_id,
        revisionId: revision.revisionId,
        familyId: revision.familyId,
        contentHash: revision.contentHash,
        creationContextVersion: revision.creationContextVersion,
        catalogSourceHash: revision.catalog.sourceHash,
        projectionPlanId: projection.planId,
        pointerVersion: proposal.expected_active_pointer_version + 1,
        ...capacityLearningPayload(input.scope, revision.document as TrainingPlanRevisionDocument),
      },
      privacyClassification: 'health',
      idempotencyKey: `training.plan_revision.activated:${revision.revisionId}`,
      causationId: input.approval.actionExecutionId,
    }, db);
    incrementTrainingGenerationCounter('adaptation_activated_total');
    const result = readActivationResult(db, input.scope, revision.familyId, revision.revisionId, false);
    lease.assertActive();
    return result;
  })();
}

function capacityLearningPayload(
  scope: TrainingPlanRevisionScope,
  document: TrainingPlanRevisionDocument,
): Record<string, string> {
  const conflictSetHash = document.m4?.conflictSetHash;
  if (document.capacityContext?.calendarConflictCoverage !== 'AUTHORITATIVE'
      || typeof conflictSetHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(conflictSetHash)) return {};
  return {
    capacityCoverage: 'AUTHORITATIVE',
    capacitySubjectFingerprint: createHash('sha256').update(JSON.stringify([
      scope.tenantId,
      scope.userId,
      document.capacityContextVersion ?? null,
      conflictSetHash,
    ])).digest('hex'),
  };
}

function applyAdaptationCompatibilityProjection(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  planId: number,
  sourceRevisionId: string,
  proposedRevisionId: string,
  document: TrainingPlanRevisionDocument,
): { planId: number; weekCount: number; sessionCount: number } {
  const workouts = new Map(document.weeks.flatMap((week) => week.workouts).map((workout) => [workout.workoutKey, workout]));
  const sessions = db.prepare(`
    SELECT id, revision_session_key AS workoutKey, status
      FROM training_sessions
     WHERE plan_id = ? AND tenant_id = ?
     ORDER BY id
  `).all(planId, scope.tenantId) as Array<{ id: number; workoutKey: string | null; status: string }>;
  const immutableStatuses = new Set(['completed', 'partial', 'skipped', 'cancelled', 'canceled']);
  for (const session of sessions) {
    if (immutableStatuses.has(session.status.toLowerCase())) continue;
    if (!session.workoutKey) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_PROJECTION_IDENTITY_MISSING',
        'A future projection session has no immutable workout identity.',
        409,
      );
    }
    const workout = workouts.get(session.workoutKey);
    if (!workout) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_PROJECTION_WORKOUT_MISSING',
        'The adapted revision omitted a future projection workout.',
        409,
      );
    }
    const exercises = workout.blocks.flatMap((block) => block.exercises ?? []).map((exercise) => ({
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      sets: exercise.prescription.sets,
      reps: exercise.prescription.repetitions,
      rpe: exercise.prescription.targetRpe,
      rir: exercise.prescription.targetRir,
      tempo: exercise.prescription.tempo,
      restSec: exercise.prescription.restSeconds,
    }));
    const primaryPrescription = workout.blocks.find((block) => block.blockType === 'PRIMARY_WORK')?.prescription
      ?? workout.blocks[0]?.prescription;
    const sessionUpdate = db.prepare(`
      UPDATE training_sessions
         SET day_of_week = ?, session_type = ?, title = ?, description = ?,
             description_json = ?, exercises_json = ?, duration_minutes = ?,
             intensity_text = ?, session_shape_hash = ?, source_revision_id = ?
       WHERE id = ? AND plan_id = ? AND tenant_id = ?
         AND source_revision_id = ?
         AND lower(status) NOT IN ('completed', 'partial', 'skipped', 'cancelled', 'canceled')
    `).run(
      capitalize(workout.dayOfWeek), workout.sessionType, workout.title, workout.objective,
      JSON.stringify({ schemaVersion: 'training-workout-blocks.v1', blocks: workout.blocks }),
      JSON.stringify(exercises), workout.plannedDurationMinutes,
      intensityText(primaryPrescription, workout.sessionType), stableSessionShape(workout),
      proposedRevisionId, session.id, planId, scope.tenantId, sourceRevisionId,
    );
    if (sessionUpdate.changes !== 1) {
      throw new TrainingPlanRevisionError(
        'TRAINING_ADAPTATION_PROJECTION_SESSION_CONFLICT',
        'A future projection session changed during adaptation activation.',
        409,
      );
    }
  }
  const planUpdate = db.prepare(`
    UPDATE fitness_training_plans
       SET source_revision_id = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND tenant_id = ?
       AND source_revision_id = ? AND status = 'active'
  `).run(proposedRevisionId, planId, scope.userId, scope.tenantId, sourceRevisionId);
  const weekCount = (db.prepare(`
    SELECT COUNT(*) AS count FROM training_weeks
     WHERE plan_id = ? AND source_revision_id = ?
  `).get(planId, sourceRevisionId) as { count: number }).count;
  const weekUpdate = db.prepare(`
    UPDATE training_weeks SET source_revision_id = ?
     WHERE plan_id = ? AND source_revision_id = ?
  `).run(proposedRevisionId, planId, sourceRevisionId);
  if (planUpdate.changes !== 1
      || weekCount !== document.weeks.length
      || weekUpdate.changes !== weekCount) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_PROJECTION_CONFLICT',
      'The active compatibility projection changed during adaptation activation.',
      409,
    );
  }
  const counts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM training_weeks WHERE plan_id = ?) AS weekCount,
           (SELECT COUNT(*) FROM training_sessions WHERE plan_id = ?) AS sessionCount
  `).get(planId, planId) as { weekCount: number; sessionCount: number };
  return { planId, ...counts };
}

function findAdaptationForRevision(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  revisionId: string,
): AdaptationActivationRow | null {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_proposals'
  `).get();
  if (!table) return null;
  return (db.prepare(`
    SELECT proposals.proposal_id, proposals.source_revision_id, proposals.proposed_revision_id,
           proposals.decision_id, proposals.status, proposals.expected_source_content_hash,
           proposals.expected_context_version, proposals.expected_active_pointer_version,
           proposals.option_hash, proposals.selected_option_id, proposals.expires_at,
           proposals.scope, previews.target_json
      FROM training_adaptation_proposals proposals
      JOIN training_adaptation_previews previews
        ON previews.adaptation_id = proposals.adaptation_id
       AND previews.tenant_id = proposals.tenant_id
       AND previews.user_id = proposals.user_id
     WHERE proposals.proposed_revision_id = ? AND proposals.tenant_id = ? AND proposals.user_id = ?
     LIMIT 1
  `).get(revisionId, scope.tenantId, scope.userId) as AdaptationActivationRow | undefined) ?? null;
}

function validateActivationInput(db: Database.Database, input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  approval: TrainingPlanRevisionApprovalEvidence;
  activationDate?: string;
  env?: NodeJS.ProcessEnv;
  referenceTime: Date;
}): NonNullable<ReturnType<typeof getScopedTrainingPlanRevision>> {
  const revision = getScopedTrainingPlanRevision(input.scope, input.revisionId, db);
  if (!revision) throw new TrainingPlanRevisionError('TRAINING_REVISION_NOT_FOUND', 'Training plan revision not found.', 404);
  if (stableTrainingRevisionHash(revision.document) !== revision.contentHash) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_DOCUMENT_HASH_MISMATCH',
      'The immutable Training revision failed integrity validation.',
      409,
    );
  }
  if (revision.origin !== 'GENERATED'
      || !['training-plan-revision.v1', 'training-plan-revision.v2'].includes(revision.documentSchemaVersion)) {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_ACTIVE_REPLACEMENT_NOT_IN_M1', 'Legacy revisions cannot be activated through the Milestone 1 generator.', 409);
  }
  // F3 (Phase 1A-1): whole-candidate volume floor.
  //
  // Runs AFTER the content-hash integrity check above, so the document being
  // counted is provably the reviewed one, and after the legacy gate, so
  // `LEGACY_COMPATIBILITY` backfills never reach here. Two independent
  // conditions, because the stored report and the document could disagree if
  // a future builder path forgot the floor check: the report is the
  // attestation, the count is the ground truth.
  const activeWorkoutCount = countActiveWorkouts(revision.document as TrainingPlanRevisionDocument);
  if (activeWorkoutCount === 0 || revision.qualityReport?.status === 'FAIL') {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_QUALITY_GATE_FAILED',
      'The reviewed plan has no active training sessions and cannot be activated. The current plan is unchanged.',
      409,
    );
  }
  if (revision.decisionId !== input.approval.decisionId) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_DECISION_MISMATCH', 'The approval does not belong to this revision.', 409);
  }
  if (revision.contentHash !== input.approval.approvedContentHash
      || revision.creationContextVersion !== input.approval.approvedContextVersion) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_APPROVAL_STALE', 'The approved revision content or context is stale.', 409);
  }
  const alreadyActive = revision.lifecycleState === 'ACTIVE' && revision.approvalState === 'APPROVED';
  if (!alreadyActive
      && (revision.lifecycleState !== 'PENDING_REVIEW' || revision.approvalState !== 'PENDING')) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_NOT_APPROVED_FOR_ACTIVATION', 'The revision is not pending an approved Decision Center action.', 409);
  }
  if (!Number.isSafeInteger(input.approval.decisionRecordVersion) || input.approval.decisionRecordVersion <= 0
      || !input.approval.actionExecutionId.trim()) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_APPROVAL_EVIDENCE_INVALID', 'Approval evidence is invalid.', 409);
  }
  if (alreadyActive) {
    validateExistingActivationReceipt(db, input);
    return revision;
  }
  validateDecisionApprovalBinding(db, input);
  validatePendingM4ActivationContract(
    revision.document as TrainingPlanRevisionDocument,
    input.env,
    input.scope,
  );
  const adaptation = findAdaptationForRevision(db, input.scope, input.revisionId);
  if (adaptation) {
    validateAdaptationActivationInput(db, input, revision, adaptation);
    return revision;
  }
  const currentContext = db.prepare(`
    SELECT current_revision_id AS currentRevisionId,
           current_profile_snapshot_id AS currentProfileSnapshotId,
           current_context_version AS currentContextVersion,
           base_context_version AS baseContextVersion,
           profile_source_version AS profileSourceVersion,
           calendar_source_version AS calendarSourceVersion,
           conflict_source_version AS conflictSourceVersion
      FROM training_plan_current_contexts
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId, revision.familyId) as {
    currentRevisionId: string;
    currentProfileSnapshotId: string;
    currentContextVersion: string;
    baseContextVersion: string;
    profileSourceVersion: string;
    calendarSourceVersion: string;
    conflictSourceVersion: string;
  } | undefined;
  const liveAuthoritativeContext = computeTrainingRevisionAuthoritativeContext(db, input.scope);
  const liveContextVersion = currentContext
    ? deriveTrainingRevisionCreationContextVersion(
      currentContext.baseContextVersion,
      liveAuthoritativeContext,
    )
    : null;
  if (!currentContext
      || currentContext.currentRevisionId !== revision.revisionId
      || currentContext.currentProfileSnapshotId !== revision.profileSnapshotId
      || currentContext.currentContextVersion !== revision.creationContextVersion
      || liveContextVersion !== revision.creationContextVersion
      || currentContext.profileSourceVersion !== liveAuthoritativeContext.profileSourceVersion
      || currentContext.calendarSourceVersion !== liveAuthoritativeContext.calendarSourceVersion
      || currentContext.conflictSourceVersion !== liveAuthoritativeContext.conflictSourceVersion) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_CURRENT_CONTEXT_STALE',
      'The approved plan no longer matches the latest explicitly submitted Training context.',
      409,
    );
  }
  const snapshot = getScopedTrainingProfileSnapshot(
    input.scope,
    revision.profileSnapshotId,
    input.env,
    db,
  );
  if (!snapshot) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_NOT_FOUND',
      'The approved profile snapshot no longer exists.',
      409,
    );
  }
  if (snapshot.body.profileKind !== 'generated' || !snapshot.body.request) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_KIND_INVALID',
      'The approved revision is not backed by a generated profile snapshot.',
      409,
    );
  }
  const typedWorkoutEnabled = isTrainingTypedWorkoutV1Enabled(input.env, input.scope);
  if (revision.documentSchemaVersion === 'training-plan-revision.v2' && !typedWorkoutEnabled) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_REVALIDATION_STALE',
      'The approved typed plan is no longer enabled for this scope.',
      409,
    );
  }
  const revisionDocument = revision.document as TrainingPlanRevisionDocument;
  const m4StrategyAllowed = isTrainingM4PlanCombinationAllowed(
    snapshot.body.request.planMode,
    snapshot.body.request.discipline,
    input.env ?? process.env,
    input.scope,
  );
  if (isTrainingM4OwnedCombination(snapshot.body.request.planMode, snapshot.body.request.discipline)
      && !revisionDocument.m4) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_REVISION_CONTRACT_REQUIRED',
      'This plan mode or discipline requires an M4-reviewed revision.',
      409,
    );
  }
  if (revisionDocument.m4 && !m4StrategyAllowed) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_ALLOWLIST_REQUIRED',
      'The approved mode and discipline are no longer enrolled for activation.',
      404,
    );
  }
  if (revisionDocument.m4) {
    try {
      validateTrainingM4InitialScheduleFreshness(
        revisionDocument,
        input.referenceTime,
      );
    } catch (freshnessError) {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_INITIAL_SCHEDULE_STALE',
        freshnessError instanceof Error ? freshnessError.message : 'The M4 schedule is stale.',
        409,
      );
    }
  }
  const m4StrategyEnabled = revisionDocument.m4 != null;
  const rebuilt = buildTrainingPlanRevisionCandidate(snapshot.body.request, {
    env: input.env,
    scope: input.scope,
    typedWorkoutValidationEnabled: typedWorkoutEnabled,
    m4StrategyEnabled,
    referenceTime: input.referenceTime,
    ...(snapshot.body.request.capacity?.source === 'AUTHORITATIVE'
      ? { authoritativeCapacityContext: getTrainingM4AuthoritativeCapacityContext(input.scope) }
      : {}),
  });
  const rebuiltContextVersion = deriveTrainingRevisionCreationContextVersion(
    rebuilt.creationContextVersion,
    liveAuthoritativeContext,
  );
  if (rebuilt.contentHash !== revision.contentHash
      || rebuiltContextVersion !== revision.creationContextVersion
      || stableContextHash(snapshot.body.authoritativeSourceVersions) !== stableContextHash(liveAuthoritativeContext)
      || rebuilt.policyVersion !== revision.policyVersion
      || rebuilt.catalogVersion !== revision.catalog.version
      || rebuilt.catalogSourceHash !== revision.catalog.sourceHash
      || rebuilt.capabilityRegistryVersion !== revision.capabilityRegistryVersion) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_REVALIDATION_STALE',
      'The approved plan no longer matches the current validated generation context.',
      409,
    );
  }
  return revision;
}

function validatePendingM4ActivationContract(
  document: TrainingPlanRevisionDocument,
  env: NodeJS.ProcessEnv | undefined,
  scope: TrainingPlanRevisionScope,
): void {
  if (isTrainingM4OwnedCombination(document.planMode, document.discipline) && !document.m4) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_REVISION_CONTRACT_REQUIRED',
      'This plan mode or discipline requires an M4-reviewed revision.',
      409,
    );
  }
  if (!document.m4) return;
  if (!isTrainingM4PlanCombinationAllowed(
    document.planMode,
    document.discipline,
    env ?? process.env,
    scope,
  )) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_ALLOWLIST_REQUIRED',
      'The approved mode and discipline are no longer enrolled for activation.',
      404,
    );
  }
  try {
    validateTrainingPlanRevisionDocument(document, { typedWorkoutValidationEnabled: true });
  } catch (validationError) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_REVISION_VALIDATION_FAILED',
      validationError instanceof Error ? validationError.message : 'The M4 revision failed validation.',
      409,
    );
  }
}

function validateTrainingM4AdaptationDelta(
  source: TrainingPlanRevisionDocument,
  child: TrainingPlanRevisionDocument,
  scopedWorkoutKeys: readonly string[],
): void {
  if (!source.m4 || !child.m4) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_ADAPTATION_CONTRACT_MISMATCH',
      'An M4 adaptation cannot add or remove the reviewed plan contract.',
      409,
    );
  }
  const immutableContext = (document: TrainingPlanRevisionDocument) => ({
    schemaVersion: document.schemaVersion,
    planMode: document.planMode,
    goal: document.goal,
    discipline: document.discipline,
    planStartDate: document.planStartDate,
    event: document.event,
    resourceAccess: document.resourceAccess,
    capacityContextVersion: document.capacityContextVersion,
    capacityContext: document.capacityContext,
    goalPriority: document.goalPriority,
    title: document.title,
    horizonWeeks: document.horizonWeeks,
    weeklyStructure: document.weeklyStructure,
    phases: document.phases,
    progression: document.progression,
    recovery: document.recovery,
    assumptions: document.assumptions,
    missingInputs: document.missingInputs,
    m4: {
      strategyVersion: document.m4?.strategyVersion,
      validationScope: document.m4?.validationScope,
      eventPriorityTreatment: document.m4?.eventPriorityTreatment,
    },
    weeks: document.weeks.map((week) => ({
      weekKey: week.weekKey,
      weekNumber: week.weekNumber,
      phaseKey: week.phaseKey,
      loadDirection: week.loadDirection,
      workoutKeys: week.workouts.map((workout) => workout.workoutKey),
    })),
  });
  if (stableTrainingRevisionHash(immutableContext(source))
      !== stableTrainingRevisionHash(immutableContext(child))) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_ADAPTATION_PLAN_CONTEXT_CHANGE_FORBIDDEN',
      'The adapted revision changed immutable M4 plan context.',
      409,
    );
  }
  const allowed = new Set(scopedWorkoutKeys);
  const sourceWorkouts = new Map(source.weeks.flatMap((week) => week.workouts)
    .map((workout) => [workout.workoutKey, workout]));
  const childWorkouts = child.weeks.flatMap((week) => week.workouts);
  if (sourceWorkouts.size !== childWorkouts.length) {
    throw new TrainingPlanRevisionError(
      'TRAINING_M4_ADAPTATION_WORKOUT_SET_CHANGE_FORBIDDEN',
      'The adapted revision changed the reviewed M4 workout set.',
      409,
    );
  }
  for (const childWorkout of childWorkouts) {
    const sourceWorkout = sourceWorkouts.get(childWorkout.workoutKey);
    if (!sourceWorkout) {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_ADAPTATION_WORKOUT_SET_CHANGE_FORBIDDEN',
        'The adapted revision changed the reviewed M4 workout set.',
        409,
      );
    }
    if (!allowed.has(childWorkout.workoutKey)) {
      if (stableTrainingRevisionHash(sourceWorkout) !== stableTrainingRevisionHash(childWorkout)) {
        throw new TrainingPlanRevisionError(
          'TRAINING_M4_ADAPTATION_SCOPE_VIOLATION',
          'The adapted revision changed a workout outside its approved scope.',
          409,
        );
      }
      continue;
    }
    const immutableWorkout = (workout: TrainingPlanRevisionWorkout) => ({
      workoutKey: workout.workoutKey,
      dayOfWeek: workout.dayOfWeek,
      sessionType: workout.sessionType,
      scheduledDate: workout.scheduledDate,
      scheduledStartAt: workout.scheduledStartAt,
      scheduleTimeZone: workout.scheduleTimeZone,
      eventRole: workout.eventRole,
      phaseKey: workout.phaseKey,
      isStandalone: workout.isStandalone,
    });
    if (stableTrainingRevisionHash(immutableWorkout(sourceWorkout))
        !== stableTrainingRevisionHash(immutableWorkout(childWorkout))) {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_ADAPTATION_WORKOUT_CONTEXT_CHANGE_FORBIDDEN',
        'The adapted revision changed reviewed M4 schedule or workout identity.',
        409,
      );
    }
    const expected = JSON.parse(JSON.stringify(childWorkout)) as TrainingPlanRevisionWorkout;
    try {
      contractTrainingM4ScheduledWindow(sourceWorkout, expected);
    } catch {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_ADAPTATION_SCHEDULE_CHANGE_FORBIDDEN',
        'The adapted revision expanded or moved a reviewed M4 schedule window.',
        409,
      );
    }
    if (expected.scheduledEndAt !== childWorkout.scheduledEndAt) {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_ADAPTATION_SCHEDULE_CHANGE_FORBIDDEN',
        'The adapted revision schedule no longer matches its planned duration.',
        409,
      );
    }
  }
}

function validateAdaptationActivationInput(
  db: Database.Database,
  input: {
    scope: TrainingPlanRevisionScope;
    revisionId: string;
    approval: TrainingPlanRevisionApprovalEvidence;
    env?: NodeJS.ProcessEnv;
    referenceTime: Date;
  },
  revision: NonNullable<ReturnType<typeof getScopedTrainingPlanRevision>>,
  adaptation: AdaptationActivationRow,
): void {
  requireAdaptationActivationFlags(input.scope, input.env);
  if (!['PENDING_REVIEW', 'DEFERRED'].includes(adaptation.status)
      || adaptation.proposed_revision_id !== revision.revisionId
      || adaptation.decision_id !== input.approval.decisionId
      || Date.parse(adaptation.expires_at) <= Date.now()) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_REVIEW_STATE_STALE',
      'The approved adaptation is no longer pending with fresh review evidence.',
      409,
    );
  }
  if (revision.documentSchemaVersion !== 'training-plan-revision.v2'
      || stableTrainingRevisionHash(revision.document) !== revision.contentHash) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_REVISION_INTEGRITY_FAILED',
      'The adapted revision no longer matches its immutable typed content hash.',
      409,
    );
  }
  validateTrainingPlanRevisionDocument(
    revision.document as TrainingPlanRevisionDocument,
    { typedWorkoutValidationEnabled: true },
  );
  const target = parseAdaptationTarget(adaptation.target_json);
  if (!target?.workoutKey) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_TARGET_INVALID',
      'The adaptation target is unavailable for activation revalidation.',
      409,
    );
  }
  const source = getScopedTrainingPlanRevision(input.scope, adaptation.source_revision_id, db);
  if (!source) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_SOURCE_STALE',
      'The source revision is unavailable for completion revalidation.',
      409,
    );
  }
  if (stableTrainingRevisionHash(source.document) !== source.contentHash) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_SOURCE_INTEGRITY_FAILED',
      'The active source revision failed immutable content verification.',
      409,
    );
  }
  const sourceDocument = source.document as TrainingPlanRevisionDocument;
  const childDocument = revision.document as TrainingPlanRevisionDocument;
  const scopedWorkoutKeys = targetWorkoutKeysForScope(sourceDocument, target.workoutKey, adaptation.scope);
  const changedWorkoutKeys = scopedWorkoutKeys.filter((workoutKey) => {
    const sourceWorkout = findTargetWorkout(sourceDocument, workoutKey)?.workout;
    const childWorkout = findTargetWorkout(childDocument, workoutKey)?.workout;
    return !!sourceWorkout && !!childWorkout
      && stableTrainingRevisionHash(sourceWorkout) !== stableTrainingRevisionHash(childWorkout);
  });
  if (sourceDocument.m4 || childDocument.m4) {
    validateTrainingM4AdaptationDelta(sourceDocument, childDocument, scopedWorkoutKeys);
    try {
      validateTrainingM4AdaptationFreshness(childDocument, changedWorkoutKeys, input.referenceTime);
    } catch (freshnessError) {
      throw new TrainingPlanRevisionError(
        'TRAINING_M4_ADAPTATION_TARGET_STALE',
        freshnessError instanceof Error ? freshnessError.message : 'The M4 adaptation target is stale.',
        409,
      );
    }
  }
  const changedTerminalWorkout = changedWorkoutKeys
    .find((workoutKey) => {
      const sourceWorkout = findTargetWorkout(sourceDocument, workoutKey)?.workout;
      const childWorkout = findTargetWorkout(childDocument, workoutKey)?.workout;
      if (!sourceWorkout || !childWorkout
          || stableTrainingRevisionHash(sourceWorkout) === stableTrainingRevisionHash(childWorkout)) {
        return false;
      }
      return !!db.prepare(`
        SELECT 1 FROM training_sessions
         WHERE tenant_id = ? AND source_revision_id = ? AND revision_session_key = ?
           AND lower(status) IN ('completed', 'partial', 'skipped', 'cancelled', 'canceled')
         LIMIT 1
      `).get(input.scope.tenantId, adaptation.source_revision_id, workoutKey);
    });
  if (changedTerminalWorkout) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_COMPLETED_SESSION_IMMUTABLE',
      'An in-scope changed session became historical before activation.',
      409,
    );
  }
  const active = getActiveTrainingPlanReference(input.scope, revision.familyId, db);
  if (!source
      || source.origin !== 'GENERATED'
      || source.documentSchemaVersion !== 'training-plan-revision.v2'
      || source.lifecycleState !== 'ACTIVE'
      || source.approvalState !== 'APPROVED'
      || source.contentHash !== adaptation.expected_source_content_hash
      || source.creationContextVersion !== adaptation.expected_context_version
      || revision.parentRevisionId !== source.revisionId
      || revision.creationContextVersion !== source.creationContextVersion
      || revision.profileSnapshotId !== source.profileSnapshotId
      || revision.catalog.version !== source.catalog.version
      || revision.catalog.sourceHash !== source.catalog.sourceHash
      || revision.capabilityRegistryVersion !== source.capabilityRegistryVersion
      || !active
      || active.activeRevisionId !== source.revisionId
      || active.pointerVersion !== adaptation.expected_active_pointer_version
      || active.projectionPlanId == null) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_SOURCE_STALE',
      'The source revision, active pointer, or pinned generation context changed.',
      409,
    );
  }
  const currentContext = db.prepare(`
    SELECT current_revision_id AS currentRevisionId,
           current_profile_snapshot_id AS currentProfileSnapshotId,
           current_context_version AS currentContextVersion,
           base_context_version AS baseContextVersion,
           profile_source_version AS profileSourceVersion,
           calendar_source_version AS calendarSourceVersion,
           conflict_source_version AS conflictSourceVersion
      FROM training_plan_current_contexts
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId, revision.familyId) as {
    currentRevisionId: string;
    currentProfileSnapshotId: string;
    currentContextVersion: string;
    baseContextVersion: string;
    profileSourceVersion: string;
    calendarSourceVersion: string;
    conflictSourceVersion: string;
  } | undefined;
  const live = computeTrainingRevisionAuthoritativeContext(db, input.scope);
  const liveContextVersion = currentContext
    ? deriveTrainingRevisionCreationContextVersion(currentContext.baseContextVersion, live)
    : null;
  if (!currentContext
      || currentContext.currentRevisionId !== source.revisionId
      || currentContext.currentProfileSnapshotId !== revision.profileSnapshotId
      || currentContext.currentContextVersion !== revision.creationContextVersion
      || liveContextVersion !== revision.creationContextVersion
      || currentContext.profileSourceVersion !== live.profileSourceVersion
      || currentContext.calendarSourceVersion !== live.calendarSourceVersion
      || currentContext.conflictSourceVersion !== live.conflictSourceVersion) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_CONTEXT_STALE',
      'The adapted revision no longer matches the latest authoritative Training context.',
      409,
    );
  }
}

function parseAdaptationTarget(raw: string): { workoutKey?: string } | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stableContextHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function validateExistingActivationReceipt(db: Database.Database, input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  approval: TrainingPlanRevisionApprovalEvidence;
}): void {
  const receipt = db.prepare(`
    SELECT decision_id AS decisionId,
           decision_record_version AS decisionRecordVersion,
           action_execution_id AS actionExecutionId,
           approved_content_hash AS approvedContentHash,
           approved_context_version AS approvedContextVersion
      FROM training_plan_revision_approvals
     WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
       AND approval_source = 'DECISION_CENTER'
     LIMIT 1
  `).get(input.revisionId, input.scope.tenantId, input.scope.userId) as {
    decisionId: string;
    decisionRecordVersion: number;
    actionExecutionId: string;
    approvedContentHash: string;
    approvedContextVersion: string;
  } | undefined;
  if (!receipt
      || receipt.decisionId !== input.approval.decisionId
      || Number(receipt.decisionRecordVersion) !== input.approval.decisionRecordVersion
      || receipt.actionExecutionId !== input.approval.actionExecutionId
      || receipt.approvedContentHash !== input.approval.approvedContentHash
      || receipt.approvedContextVersion !== input.approval.approvedContextVersion) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_ACTIVATION_REPLAY_EVIDENCE_MISMATCH',
      'The activation replay does not match the immutable approval receipt.',
      409,
    );
  }
}

function validateDecisionApprovalBinding(db: Database.Database, input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  approval: TrainingPlanRevisionApprovalEvidence;
}): void {
  const row = db.prepare(`
    SELECT items.record_version AS decision_record_version,
           items.decision_state AS decision_state,
           intents.related_entity_id AS related_entity_id,
           intents.related_entity_type AS related_entity_type,
           executions.status AS execution_status,
           executions.expected_record_version AS expected_record_version,
           executions.context_version AS execution_context_version,
           intents.normalized_action_json AS normalized_action_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      JOIN decision_action_executions executions
        ON executions.decision_id = items.item_id
       AND executions.user_id = items.user_id
       AND executions.tenant_id = items.tenant_id
     WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
       AND executions.action_execution_id = ?
       AND executions.action_id = 'activate_training_plan_revision'
     LIMIT 1
  `).get(
    input.approval.decisionId,
    input.scope.userId,
    input.scope.tenantId,
    input.approval.actionExecutionId,
  ) as {
    decision_record_version: number;
    decision_state: string | null;
    related_entity_id: string | null;
    related_entity_type: string | null;
    execution_status: string;
    expected_record_version: number | null;
    execution_context_version: string | null;
    normalized_action_json: string | null;
  } | undefined;
  const normalized = parseNormalizedApprovalAction(row?.normalized_action_json);
  const target = normalized?.targetEntities?.find((entry) =>
    entry.type === 'training_plan_revision' && entry.id === input.revisionId);
  const requiredScopes = new Set(normalized?.authorizationScope ?? []);
  if (!row
      || row.decision_state !== 'approved'
      || row.related_entity_type !== 'training_plan_revision'
      || row.related_entity_id !== input.revisionId
      || row.execution_status !== 'started'
      || Number(row.decision_record_version) !== input.approval.decisionRecordVersion + 1
      || Number(row.expected_record_version) !== input.approval.decisionRecordVersion
      || row.execution_context_version !== input.approval.approvedContextVersion
      || normalized?.contextVersion !== input.approval.approvedContextVersion
      || target?.version !== input.approval.approvedContentHash
      || !requiredScopes.has('decision_center:write')
      || !requiredScopes.has('training:plan:write')) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_DECISION_APPROVAL_INVALID',
      'Decision Center approval evidence is missing, stale, or belongs to another revision.',
      409,
    );
  }
}

function parseNormalizedApprovalAction(raw: string | null | undefined): {
  contextVersion?: string;
  targetEntities?: Array<{ type?: string; id?: string; version?: string }>;
  authorizationScope?: string[];
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function materializeCompatibilityProjection(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  document: TrainingPlanRevisionDocument,
  revisionId: string,
  activationDate: string,
): { planId: number; weekCount: number; sessionCount: number } {
  const endDate = addDays(activationDate, document.horizonWeeks * 7 - 1);
  const plan = db.prepare(`
    INSERT INTO fitness_training_plans (
      user_id, tenant_id, name, sport, goal, duration_weeks, periodization,
      status, start_date, end_date, preferences_json, source_revision_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    scope.userId,
    scope.tenantId,
    document.title,
    document.discipline === 'marathon' ? 'running' : document.discipline,
    document.goal,
    document.horizonWeeks,
    document.periodization === 'NON_PERIODIZED' ? 'continuous' : 'block',
    activationDate,
    endDate,
    JSON.stringify({
      source: 'training_plan_revision_v1',
      revisionId,
      revisionSchemaVersion: document.schemaVersion,
      goalMode: document.planMode,
      raceDate: document.event?.date ?? null,
      trainingPriority: document.event?.priority ?? null,
      event: document.event ?? null,
    }),
    revisionId,
  );
  const planId = Number(plan.lastInsertRowid);
  let sessionCount = 0;
  for (const week of document.weeks) {
    const phase = document.phases.find((entry) => entry.phaseKey === week.phaseKey);
    const weekInsert = db.prepare(`
      INSERT INTO training_weeks (
        plan_id, week_number, focus, intensity_pct, volume_sessions, notes,
        source_revision_id, revision_week_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      week.weekNumber,
      phase?.phaseType.toLowerCase() ?? 'general',
      week.loadDirection === 'REDUCE' ? 60 : week.loadDirection === 'INCREASE' ? 80 : 70,
      week.workouts.filter((workout) => workout.sessionType !== 'rest').length,
      phase?.purpose ?? null,
      revisionId,
      week.weekKey,
    );
    const weekId = Number(weekInsert.lastInsertRowid);
    for (const workout of week.workouts) {
      insertProjectionSession(db, {
        scope,
        planId,
        weekId,
        revisionId,
        workout,
      });
      sessionCount += 1;
    }
  }
  return { planId, weekCount: document.weeks.length, sessionCount };
}

function insertProjectionSession(db: Database.Database, input: {
  scope: TrainingPlanRevisionScope;
  planId: number;
  weekId: number;
  revisionId: string;
  workout: TrainingPlanRevisionWorkout;
}): void {
  const exercises = input.workout.blocks.flatMap((block) => block.exercises ?? []).map((exercise) => ({
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    sets: exercise.prescription.sets,
    reps: exercise.prescription.repetitions,
    rpe: exercise.prescription.targetRpe,
    rir: exercise.prescription.targetRir,
    tempo: exercise.prescription.tempo,
    restSec: exercise.prescription.restSeconds,
  }));
  const primaryPrescription = input.workout.blocks
    .find((block) => block.blockType === 'PRIMARY_WORK')?.prescription
    ?? input.workout.blocks[0]?.prescription;
  db.prepare(`
    INSERT INTO training_sessions (
      week_id, plan_id, tenant_id, day_of_week, session_type, title, description,
      description_json, exercises_json, duration_minutes, intensity_text,
      status, session_identity_key, session_shape_hash,
      source_revision_id, revision_session_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.weekId,
    input.planId,
    input.scope.tenantId,
    capitalize(input.workout.dayOfWeek),
    input.workout.sessionType,
    input.workout.title,
    input.workout.objective,
    JSON.stringify({
      schemaVersion: 'training-workout-blocks.v1',
      blocks: input.workout.blocks,
      ...(input.workout.scheduledDate ? { scheduledDate: input.workout.scheduledDate } : {}),
      ...(input.workout.scheduledStartAt ? { scheduledStartAt: input.workout.scheduledStartAt } : {}),
      ...(input.workout.scheduledEndAt ? { scheduledEndAt: input.workout.scheduledEndAt } : {}),
      ...(input.workout.scheduleTimeZone ? { scheduleTimeZone: input.workout.scheduleTimeZone } : {}),
    }),
    JSON.stringify(exercises),
    input.workout.plannedDurationMinutes,
    intensityText(primaryPrescription, input.workout.sessionType),
    input.workout.sessionType === 'rest' ? 'rest' : 'pending',
    input.workout.workoutKey,
    stableSessionShape(input.workout),
    input.revisionId,
    input.workout.workoutKey,
  );
}

function readActivationResult(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  familyId: string,
  revisionId: string,
  idempotent: boolean,
): TrainingPlanRevisionActivationResult {
  const activeReference = getActiveTrainingPlanReference(scope, familyId, db);
  if (!activeReference || activeReference.activeRevisionId !== revisionId || activeReference.projectionPlanId == null) {
    throw new TrainingPlanRevisionError('TRAINING_ACTIVATION_READBACK_FAILED', 'The activated plan could not be verified.', 500);
  }
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM training_weeks WHERE plan_id = ?) AS weekCount,
      (SELECT COUNT(*) FROM training_sessions WHERE plan_id = ?) AS sessionCount
  `).get(activeReference.projectionPlanId, activeReference.projectionPlanId) as { weekCount: number; sessionCount: number };
  return {
    revisionId,
    familyId,
    projection: {
      planId: activeReference.projectionPlanId,
      weekCount: counts.weekCount,
      sessionCount: counts.sessionCount,
    },
    activeReference,
    idempotent,
  };
}

function requireActivationFlags(scope: TrainingPlanRevisionScope, env: NodeJS.ProcessEnv | undefined): void {
  const runtime = env ?? process.env;
  if (getTrainingPlanRevisionV1Mode(runtime, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(runtime, scope)
      || !isTrainingDecisionFlowV1EnforceEnabled(runtime, scope)) {
    throw new TrainingPlanRevisionError('TRAINING_PLAN_REVISION_ACTIVATION_DISABLED', 'Training plan revision activation is disabled.', 404);
  }
  requirePersonalTrainingRevisionScope(scope);
}

function requireAdaptationActivationFlags(
  scope: TrainingPlanRevisionScope,
  env: NodeJS.ProcessEnv | undefined,
): void {
  const runtime = env ?? process.env;
  if (getTrainingAdaptationV1Mode(runtime, scope) !== 'active'
      || !isTrainingTypedWorkoutV1Enabled(runtime, scope)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ADAPTATION_ACTIVATION_DISABLED',
      'Training adaptation activation is disabled.',
      404,
    );
  }
}

function normalizeIsoDate(value: string | undefined): string {
  const candidate = value ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || Number.isNaN(Date.parse(`${candidate}T00:00:00.000Z`))) {
    throw new TrainingPlanRevisionError('TRAINING_ACTIVATION_DATE_INVALID', 'Activation date is invalid.', 400);
  }
  return candidate;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function stableSessionShape(workout: TrainingPlanRevisionWorkout): string {
  return createHash('sha256').update(JSON.stringify({
    sessionType: workout.sessionType,
    objective: workout.objective,
    blocks: workout.blocks,
  })).digest('hex');
}

function intensityText(
  prescription: TrainingPlanRevisionWorkout['blocks'][number]['prescription'] | undefined,
  sessionType: string,
): string {
  if (!prescription) return sessionType === 'rest' ? 'Rest' : 'See structured prescription';
  switch (prescription.kind) {
    case 'strength': return `RPE ${prescription.targetRpe}, RIR ${prescription.targetRir}`;
    case 'steady_endurance': return prescription.paceGuidance
      ? `${prescription.effortZone} · ${prescription.paceGuidance}`
      : prescription.effortZone;
    case 'intervals': return `${prescription.targetIntensity} · ${prescription.repetitions} repetitions`;
    case 'mobility': return prescription.rangeGuidance;
    case 'swimming': return `${prescription.targetIntensity} · ${prescription.totalDistanceMeters} m`;
    case 'cycling': return prescription.powerGuidance
      ? `${prescription.effortZone} · ${prescription.powerGuidance}`
      : prescription.effortZone;
    case 'mixed_session': return `${prescription.segments.length} ordered modality segments`;
    case 'recovery': return sessionType === 'rest' ? 'Rest' : prescription.effortGuidance;
    case 'unknown': return 'Unknown prescription type';
  }
}
