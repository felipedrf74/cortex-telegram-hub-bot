// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import { createDecisionIntent } from './decision-center';
import {
  getScopedTrainingPlanRevision,
  requirePersonalTrainingRevisionScope,
  TrainingPlanRevisionError,
  type TrainingPlanRevisionResource,
  type TrainingPlanRevisionScope,
} from './training-plan-revisions';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';
import {
  getTrainingPlanRevisionV1Mode,
  isDecisionFlowV1EnforceEnabled,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
} from './runtime-flags';
import { getDb } from './database';

export const ACTIVATE_TRAINING_PLAN_REVISION_ACTION = 'activate_training_plan_revision' as const;

export async function bindTrainingPlanRevisionDecision(input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TrainingPlanRevisionResource> {
  requireDecisionBindingFlags(input.scope, input.env);
  const revision = getScopedTrainingPlanRevision(input.scope, input.revisionId);
  if (!revision) throw new TrainingPlanRevisionError('TRAINING_REVISION_NOT_FOUND', 'Training plan revision not found.', 404);
  if (revision.origin !== 'GENERATED' || revision.lifecycleState === 'LEGACY_ACTIVE') {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_REVISION_REVIEW_NOT_IN_M1', 'Legacy revisions cannot enter the Milestone 1 approval flow.', 409);
  }
  requireRevisionIsCurrentContext(input.scope, revision);
  expireRevisionIfDecisionIsNoLongerLive(input.scope, revision);
  const operationId = claimDecisionBindingOperation(input.scope, revision.revisionId, revision.contentHash);
  if (revision.decisionId
      && revision.lifecycleState === 'PENDING_REVIEW'
      && revision.approvalState === 'PENDING') {
    completeDecisionBindingOperation(operationId, revision);
    return revision;
  }
  if (revision.lifecycleState !== 'CANDIDATE' || revision.approvalState !== 'UNREVIEWED') {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_REVIEW_STATE_INVALID', 'Revision is not ready to bind for review.', 409);
  }

  const normalizedAction = buildNormalizedDecisionAction({
    intent: 'training.activate_plan_revision',
    targetEntities: [{
      type: 'training_plan_revision',
      id: revision.revisionId,
      version: revision.contentHash,
    }],
    affectedResources: [{ type: 'training_plan_family', id: revision.familyId }],
    preconditions: [
      {
        type: 'training_revision_content',
        ref: revision.revisionId,
        expectedVersion: revision.contentHash,
        required: true,
      },
      {
        type: 'training_revision_context',
        ref: revision.revisionId,
        expectedVersion: revision.creationContextVersion,
        required: true,
      },
      {
        type: 'training_revision_policy',
        ref: revision.revisionId,
        expectedVersion: revision.policyVersion,
        required: true,
      },
      {
        type: 'training_revision_catalog',
        ref: revision.revisionId,
        expectedVersion: `${revision.catalog.version}:${revision.catalog.sourceHash}`,
        required: true,
      },
      {
        type: 'training_active_pointer',
        ref: revision.familyId,
        expectedVersion: 'none',
        required: true,
      },
    ],
    expectedEffects: [{
      type: 'activate_training_plan_revision',
      targetRef: `training_plan_revision:${revision.revisionId}`,
    }],
    prohibitedEffects: [
      { type: 'modify_existing_active_plan', targetRef: `training_plan_family:${revision.familyId}` },
      { type: 'reschedule_existing_training_session', targetRef: `training_plan_family:${revision.familyId}` },
      { type: 'provider_calendar_write', targetRef: `training_plan_family:${revision.familyId}` },
    ],
    dependencies: [],
    exclusivityKeys: [`training_plan_family:${input.scope.tenantId}:${revision.familyId}`],
    authorizationScope: ['decision_center:write', 'training:plan:write'],
    risk: 'high',
    reversibility: 'compensatable',
    contextVersion: revision.creationContextVersion,
  });
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  let created: Awaited<ReturnType<typeof createDecisionIntent>>;
  try {
    created = await createDecisionIntent({
    userId: input.scope.userId,
    tenantId: input.scope.tenantId,
    sourceSkill: 'training',
    type: 'approval_required',
    priority: 'active',
    relatedEntityId: revision.revisionId,
    relatedEntityType: 'training_plan_revision',
    title: 'Review your proposed training plan',
    body: 'A versioned training plan candidate is ready. Nothing changes until you explicitly approve and activate it.',
    actionButtons: [
      {
        id: ACTIVATE_TRAINING_PLAN_REVISION_ACTION,
        label: 'Approve and activate',
        style: 'primary',
        mutating: true,
      },
      {
        id: 'open_detail',
        label: 'Review details',
        style: 'secondary',
      },
    ],
    deeplink: `nexus://training/revision/${revision.revisionId}`,
    expiresAt,
    dedupeKey: `training-plan-revision:${revision.revisionId}`,
    requiresUserAction: true,
    decisionDeadline: expiresAt,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'health',
    visibilityScope: 'user_private',
    decisionContext: {
      entityTitle: 'Proposed training plan',
      reasonCodes: [
        'immutable_revision_ready',
        'explicit_approval_required',
        'no_existing_plan_replacement_in_m1',
      ],
      sourceState: 'candidate_revision',
      contextObservedAt: observedAt,
      contextExpiresAt: expiresAt,
      evidenceConfidence: 1,
      candidateConfidence: 'high',
      evidenceReferences: [{
        evidenceId: `revision:${revision.revisionId}`,
        source: 'training_plan_revision_store',
        observedAt,
        freshness: 'current',
        reliability: 'authoritative',
        entityVersion: revision.contentHash,
        expiresAt,
      }],
      sourceHealthSnapshot: [{
        source: 'training_plan_revision_store',
        status: 'available',
        observedAt,
        staleAfter: expiresAt,
      }],
      normalizedAction,
    },
    });
  } catch (error) {
    failDecisionBindingOperation(operationId, error);
    throw error;
  }
  const decisionId = created.item?.itemId ?? findExistingRevisionDecisionId(input.scope, revision.revisionId);
  if (!decisionId) {
    failDecisionBindingOperation(operationId, new Error('Decision Center returned no item ID.'));
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_DECISION_BINDING_FAILED',
      'The plan candidate could not be bound to Decision Center.',
      409,
    );
  }
  const updated = getDb().prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'PENDING_REVIEW', approval_state = 'PENDING',
           decision_id = ?, review_requested_at = datetime('now')
     WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
       AND lifecycle_state = 'CANDIDATE' AND approval_state = 'UNREVIEWED'
       AND decision_id IS NULL
  `).run(decisionId, revision.revisionId, input.scope.userId, input.scope.tenantId);
  if (updated.changes !== 1) {
    const concurrent = getScopedTrainingPlanRevision(input.scope, revision.revisionId);
    if (concurrent?.decisionId === decisionId) {
      completeDecisionBindingOperation(operationId, concurrent);
      return concurrent;
    }
    failDecisionBindingOperation(operationId, new Error('Revision review state changed during binding.'));
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_DECISION_BINDING_CONFLICT',
      'The plan revision review state changed while binding Decision Center.',
      409,
    );
  }
  const bound = getScopedTrainingPlanRevision(input.scope, revision.revisionId)!;
  completeDecisionBindingOperation(operationId, bound);
  return bound;
}

function expireRevisionIfDecisionIsNoLongerLive(
  scope: TrainingPlanRevisionScope,
  revision: TrainingPlanRevisionResource,
): void {
  if (!revision.decisionId
      || revision.lifecycleState !== 'PENDING_REVIEW'
      || revision.approvalState !== 'PENDING') return;
  const decision = getDb().prepare(`
    SELECT status, expires_at AS expiresAt
      FROM notification_center_items
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(revision.decisionId, scope.userId, scope.tenantId) as {
    status: string;
    expiresAt: string | null;
  } | undefined;
  const expiredByTime = !!decision?.expiresAt
    && Number.isFinite(Date.parse(decision.expiresAt))
    && Date.parse(decision.expiresAt) <= Date.now();
  if (decision && !expiredByTime && !['expired', 'superseded', 'dismissed'].includes(decision.status)) return;
  getDb().prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'EXPIRED', approval_state = 'EXPIRED',
           expired_at = datetime('now')
     WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
       AND decision_id = ? AND lifecycle_state = 'PENDING_REVIEW'
       AND approval_state = 'PENDING'
  `).run(revision.revisionId, scope.userId, scope.tenantId, revision.decisionId);
  throw new TrainingPlanRevisionError(
    'TRAINING_REVISION_DECISION_EXPIRED',
    'The plan review expired; create a new candidate from current inputs.',
    409,
  );
}

function requireRevisionIsCurrentContext(
  scope: TrainingPlanRevisionScope,
  revision: TrainingPlanRevisionResource,
): void {
  const row = getDb().prepare(`
    SELECT current_revision_id AS currentRevisionId,
           current_profile_snapshot_id AS currentProfileSnapshotId,
           current_context_version AS currentContextVersion
      FROM training_plan_current_contexts
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, revision.familyId) as {
    currentRevisionId: string;
    currentProfileSnapshotId: string;
    currentContextVersion: string;
  } | undefined;
  if (!row
      || row.currentRevisionId !== revision.revisionId
      || row.currentProfileSnapshotId !== revision.profileSnapshotId
      || row.currentContextVersion !== revision.creationContextVersion) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_CURRENT_CONTEXT_STALE',
      'A newer explicit Training context exists for this plan family.',
      409,
    );
  }
}

function findExistingRevisionDecisionId(
  scope: TrainingPlanRevisionScope,
  revisionId: string,
): string | null {
  const row = getDb().prepare(`
    SELECT item_id AS itemId
      FROM notification_center_items
     WHERE user_id = ? AND tenant_id = ? AND dedupe_key = ?
       AND status NOT IN ('expired', 'superseded')
     ORDER BY created_at DESC, item_id ASC
     LIMIT 1
  `).get(scope.userId, scope.tenantId, `training-plan-revision:${revisionId}`) as {
    itemId: string;
  } | undefined;
  return row?.itemId ?? null;
}

function requireDecisionBindingFlags(scope: TrainingPlanRevisionScope, env: NodeJS.ProcessEnv | undefined): void {
  const runtime = env ?? process.env;
  if (getTrainingPlanRevisionV1Mode(runtime, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(runtime, scope)
      || !isDecisionFlowV1EnforceEnabled(runtime, scope)) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_DECISION_BINDING_DISABLED', 'Training plan review binding is disabled.', 404);
  }
  requirePersonalTrainingRevisionScope(scope);
}

function claimDecisionBindingOperation(
  scope: TrainingPlanRevisionScope,
  revisionId: string,
  contentHash: string,
): string {
  const db = getDb();
  const idempotencyKey = `training-plan-revision:${revisionId}`;
  const requestHash = stableTrainingRevisionHash({ operation: 'BIND_DECISION', revisionId, contentHash });
  const existing = db.prepare(`
    SELECT operation_id, request_hash, status
      FROM training_plan_revision_operations
     WHERE tenant_id = ? AND user_id = ? AND operation_type = 'BIND_DECISION'
       AND idempotency_key = ?
  `).get(scope.tenantId, scope.userId, idempotencyKey) as {
    operation_id: string;
    request_hash: string;
    status: string;
  } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new TrainingPlanRevisionError(
        'TRAINING_IDEMPOTENCY_KEY_REUSED',
        'Decision binding key was already used for different revision content.',
        409,
      );
    }
    if (existing.status !== 'SUCCEEDED') {
      db.prepare(`
        UPDATE training_plan_revision_operations
           SET status = 'IN_PROGRESS', attempt_count = attempt_count + 1,
               lease_owner = operation_id, lease_expires_at = datetime('now', '+2 minutes'),
               last_error_code = NULL, updated_at = datetime('now')
         WHERE operation_id = ?
      `).run(existing.operation_id);
    }
    return existing.operation_id;
  }
  const operationId = `trpop_${randomUUID()}`;
  db.prepare(`
    INSERT INTO training_plan_revision_operations (
      operation_id, tenant_id, user_id, operation_type, idempotency_key,
      request_hash, status, lease_owner, lease_expires_at
    ) VALUES (?, ?, ?, 'BIND_DECISION', ?, ?, 'IN_PROGRESS', ?, datetime('now', '+2 minutes'))
  `).run(operationId, scope.tenantId, scope.userId, idempotencyKey, requestHash, operationId);
  return operationId;
}

function completeDecisionBindingOperation(operationId: string, revision: TrainingPlanRevisionResource): void {
  getDb().prepare(`
    UPDATE training_plan_revision_operations
       SET status = 'SUCCEEDED', result_family_id = ?, result_revision_id = ?,
           result_decision_id = ?, response_json = ?, updated_at = datetime('now'),
           completed_at = datetime('now'), lease_owner = NULL, lease_expires_at = NULL
     WHERE operation_id = ?
  `).run(
    revision.familyId,
    revision.revisionId,
    revision.decisionId,
    JSON.stringify({ revisionId: revision.revisionId, decisionId: revision.decisionId }),
    operationId,
  );
}

function failDecisionBindingOperation(operationId: string, error: unknown): void {
  const code = error instanceof TrainingPlanRevisionError
    ? error.code
    : 'TRAINING_REVISION_DECISION_BINDING_RETRYABLE';
  getDb().prepare(`
    UPDATE training_plan_revision_operations
       SET status = ?, last_error_code = ?, updated_at = datetime('now')
           , lease_owner = NULL, lease_expires_at = NULL
     WHERE operation_id = ?
  `).run(
    error instanceof TrainingPlanRevisionError && error.statusCode < 500
      ? 'FAILED_TERMINAL'
      : 'FAILED_RETRYABLE',
    code,
    operationId,
  );
}
