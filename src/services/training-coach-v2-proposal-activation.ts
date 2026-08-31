// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import type { CoachAction } from './coach-kernel/scenario-classifier';
import { executeCoachActions } from './coach-kernel/coach-action-executor';
import { setCoachPlanPolicyCas } from './coach-plan-policy';
import {
  activateApprovedTrainingPlanRevisionUnderExistingLock,
  TrainingPlanRevisionError,
} from './training-plan-revision-activation';
import {
  TrainingCoachV2ProposalStateError,
  executeApprovedTrainingCoachV2Proposal,
  type TrainingCoachV2ProposalActivationInput,
} from './training-coach-v2-proposals';
import { executeWeekReflowUnderExistingAdaptLock } from './training-week-reflow-propagation';

export interface TrainingCoachV2DecisionActivationReadback {
  kind: 'week_reflow' | 'coach_policy';
  planId: number;
  weekId: number | null;
  adaptationRevision?: number;
  adaptationId?: number;
  affectedSessionIds?: number[];
  mutatedRows?: number;
  policyVersion?: number;
  policy?: Record<string, unknown>;
  propagation?: { state: 'not_synced'; pending: boolean };
  revisionId?: string;
  pointerVersion?: number;
}

/** Deterministic executor called only by the bound Decision Center action. */
export async function executeTrainingCoachV2ProposalDecision(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  decisionId: string;
  expectedRequestHash?: string;
  decisionRecordVersion?: number;
  actionExecutionId?: string;
  approvedRevisionContentHash?: string;
  approvedContextVersion?: string;
  db?: Database.Database;
}) {
  return executeApprovedTrainingCoachV2Proposal<TrainingCoachV2DecisionActivationReadback>({
    ...input,
    apply: (db, activation) => activation.proposal.proposed_revision_id
      ? applyRevisionManagedProposal(db, input, activation)
      : activation.proposal.kind === 'coach_policy'
        ? applyCoachPolicy(db, input, activation)
        : applyCompatibilityWeekReflow(db, input, activation),
  });
}

function applyRevisionManagedProposal(
  db: Database.Database,
  input: Parameters<typeof executeTrainingCoachV2ProposalDecision>[0],
  activation: TrainingCoachV2ProposalActivationInput,
): TrainingCoachV2DecisionActivationReadback {
  const revisionId = activation.proposal.proposed_revision_id;
  if (!revisionId
      || !Number.isSafeInteger(input.decisionRecordVersion) || Number(input.decisionRecordVersion) <= 0
      || !input.actionExecutionId?.trim()
      || !input.approvedRevisionContentHash?.trim()
      || !input.approvedContextVersion?.trim()) {
    throw stateError(
      'TRAINING_COACH_V2_REVISION_APPROVAL_INVALID',
      'Immutable revision approval evidence is incomplete.',
    );
  }
  const plan = db.prepare(`
    SELECT COALESCE(adaptation_revision, 0) AS adaptationRevision,
           COALESCE(coach_plan_policy_version, 1) AS policyVersion
      FROM fitness_training_plans
     WHERE id = ? AND tenant_id = ? AND user_id = ?
       AND source_revision_id IS NOT NULL
  `).get(
    activation.proposal.plan_id,
    input.tenantId,
    input.userId,
  ) as { adaptationRevision: number; policyVersion: number } | undefined;
  if (!plan) throw stateError('PLAN_NOT_FOUND', 'Revision-managed training plan not found.');
  const liveVersion = activation.proposal.kind === 'coach_policy'
    ? plan.policyVersion
    : plan.adaptationRevision;
  if (liveVersion !== activation.proposal.expected_version) {
    throw stateError('DECISION_CONTEXT_CHANGED', 'Training plan changed after this proposal was reviewed.');
  }
  let result;
  try {
    result = activateApprovedTrainingPlanRevisionUnderExistingLock({
      scope: { tenantId: input.tenantId, userId: input.userId },
      revisionId,
      approval: {
        decisionId: input.decisionId,
        decisionRecordVersion: input.decisionRecordVersion!,
        actionExecutionId: input.actionExecutionId!,
        approvedContentHash: input.approvedRevisionContentHash!,
        approvedContextVersion: input.approvedContextVersion!,
      },
    }, activation.lease);
  } catch (error) {
    if (error instanceof TrainingPlanRevisionError) {
      throw stateError(error.code, error.message);
    }
    throw error;
  }
  if (result.revisionId !== revisionId
      || result.activeReference.activeRevisionId !== revisionId
      || result.projection.planId !== activation.proposal.plan_id) {
    throw stateError('PROPOSAL_READBACK_MISMATCH', 'Immutable revision activation readback did not match the proposal.');
  }
  if (activation.proposal.kind === 'coach_policy') {
    const patch = requireObject(activation.request.patch, 'PROPOSAL_REQUEST_INVALID');
    const snapshot = setCoachPlanPolicyCas(
      result.projection.planId,
      patch,
      activation.proposal.expected_version,
      db,
    );
    return {
      kind: 'coach_policy',
      planId: result.projection.planId,
      weekId: null,
      policyVersion: snapshot.version,
      policy: snapshot.policy as unknown as Record<string, unknown>,
      revisionId,
      pointerVersion: result.activeReference.pointerVersion,
    };
  }
  const nextRevision = activation.proposal.expected_version + 1;
  const revisionUpdate = db.prepare(`
    UPDATE fitness_training_plans
       SET adaptation_revision = ?, updated_at = datetime('now')
     WHERE id = ? AND tenant_id = ? AND user_id = ?
       AND adaptation_revision = ? AND source_revision_id = ?
  `).run(
    nextRevision,
    result.projection.planId,
    input.tenantId,
    input.userId,
    activation.proposal.expected_version,
    revisionId,
  );
  if (revisionUpdate.changes !== 1) {
    throw stateError('PROPOSAL_READBACK_MISMATCH', 'Immutable reflow revision CAS did not advance exactly once.');
  }
  const scheduledAdjustment = activation.request.scheduledAdjustment === undefined
    ? null
    : requireScheduledAdjustment(activation.request.scheduledAdjustment);
  if (scheduledAdjustment && activation.proposal.week_id != null) {
    const changed = db.prepare(`
      UPDATE training_weeks
         SET intensity_pct = ?, auto_adjusted = 1, adjustment_reason = ?
       WHERE id = ? AND plan_id = ? AND source_revision_id = ?
    `).run(
      scheduledAdjustment.intensityPct,
      scheduledAdjustment.reason,
      activation.proposal.week_id,
      result.projection.planId,
      revisionId,
    );
    if (changed.changes !== 1) {
      throw stateError('PROPOSAL_READBACK_MISMATCH', 'Immutable weekly adjustment readback did not match the proposal.');
    }
  }
  return {
    kind: 'week_reflow',
    planId: result.projection.planId,
    weekId: activation.proposal.week_id,
    adaptationRevision: nextRevision,
    mutatedRows: scheduledAdjustment ? 1 : result.projection.sessionCount,
    affectedSessionIds: [],
    propagation: { state: 'not_synced', pending: true },
    revisionId,
    pointerVersion: result.activeReference.pointerVersion,
  };
}

function applyCoachPolicy(
  db: Database.Database,
  scope: Pick<Parameters<typeof executeTrainingCoachV2ProposalDecision>[0], 'tenantId' | 'userId'>,
  activation: TrainingCoachV2ProposalActivationInput,
): TrainingCoachV2DecisionActivationReadback {
  const owned = db.prepare(`
    SELECT id FROM fitness_training_plans
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(activation.proposal.plan_id, scope.tenantId, scope.userId);
  if (!owned) throw stateError('PLAN_NOT_FOUND', 'Training plan not found.');
  const patch = requireObject(activation.request.patch, 'PROPOSAL_REQUEST_INVALID');
  const snapshot = setCoachPlanPolicyCas(
    activation.proposal.plan_id,
    patch,
    activation.proposal.expected_version,
    db,
  );
  if (snapshot.version !== activation.proposal.expected_version + 1) {
    throw stateError('PROPOSAL_READBACK_MISMATCH', 'Coach policy CAS readback did not advance exactly once.');
  }
  return {
    kind: 'coach_policy',
    planId: activation.proposal.plan_id,
    weekId: null,
    policyVersion: snapshot.version,
    policy: snapshot.policy as unknown as Record<string, unknown>,
  };
}

function applyCompatibilityWeekReflow(
  db: Database.Database,
  scope: Pick<Parameters<typeof executeTrainingCoachV2ProposalDecision>[0], 'tenantId' | 'userId' | 'proposalId'>,
  activation: TrainingCoachV2ProposalActivationInput,
): TrainingCoachV2DecisionActivationReadback {
  const proposal = activation.proposal;
  if (proposal.week_id == null) throw stateError('WEEK_NOT_FOUND', 'Training week not found.');
  const plan = db.prepare(`
    SELECT id, COALESCE(plan_version, 1) AS plan_version,
           COALESCE(adaptation_revision, 0) AS adaptation_revision,
           source_revision_id
    FROM fitness_training_plans
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(proposal.plan_id, scope.tenantId, scope.userId) as {
    id: number;
    plan_version: number;
    adaptation_revision: number;
    source_revision_id: string | null;
  } | undefined;
  if (!plan) throw stateError('PLAN_NOT_FOUND', 'Training plan not found.');
  if (plan.source_revision_id) {
    throw stateError(
      'TRAINING_REVISION_MANAGED_PROPOSAL_REQUIRES_IMMUTABLE_ACTIVATION',
      'Revision-managed plans must activate an approved immutable Training revision.',
    );
  }
  if (plan.adaptation_revision !== proposal.expected_version) {
    throw stateError('DECISION_CONTEXT_CHANGED', 'Training plan changed after this proposal was reviewed.');
  }
  const week = db.prepare('SELECT id FROM training_weeks WHERE id = ? AND plan_id = ?')
    .get(proposal.week_id, proposal.plan_id);
  if (!week) throw stateError('WEEK_NOT_FOUND', 'Training week not found.');
  const scheduledAdjustment = activation.request.scheduledAdjustment === undefined
    ? null
    : requireScheduledAdjustment(activation.request.scheduledAdjustment);
  const actions = scheduledAdjustment ? [] : requireCoachActions(activation.request.actions);
  const preserved = new Set(requirePositiveIds(activation.request.sessionsToPreserve));
  const executableActions = actions.filter((action) => {
    const sessionId = 'sessionId' in action ? Number(action.sessionId) : null;
    return sessionId == null || !Number.isSafeInteger(sessionId) || !preserved.has(sessionId);
  });
  if (!scheduledAdjustment && executableActions.length === 0) {
    throw stateError('PROPOSAL_NO_EXECUTABLE_CHANGES', 'No approved session changes remain executable.');
  }
  const sciencePolicyVersion = typeof activation.evidence.sciencePolicyVersion === 'string'
    ? activation.evidence.sciencePolicyVersion
    : '';
  if (!sciencePolicyVersion) throw stateError('PROPOSAL_EVIDENCE_INVALID', 'Science policy evidence is missing.');
  const schedulingTimezone = typeof activation.request.schedulingTimezone === 'string'
    ? activation.request.schedulingTimezone
    : 'UTC';
  const syncTarget = normalizeSyncTarget(activation.request.syncTarget);
  const result = executeWeekReflowUnderExistingAdaptLock({
    userId: scope.userId,
    tenantId: scope.tenantId,
    planId: proposal.plan_id,
    weekId: proposal.week_id,
    planVersion: plan.plan_version,
    syncTarget,
    mode: 'apply',
    trigger: typeof activation.request.trigger === 'string'
      ? activation.request.trigger
      : 'decision_center_approved_reflow',
    sessionsToPreserve: [...preserved],
    idempotencyKey: `coach-v2-activation:${scope.proposalId}`,
    sciencePolicyVersion,
    beforePatch: { adaptationRevision: proposal.expected_version },
    afterPatch: scheduledAdjustment
      ? { scheduledAdjustment: { intensityPct: scheduledAdjustment.intensityPct } }
      : { actions: executableActions },
    decisionReasonCodes: scheduledAdjustment
      ? ['scheduled_weekly_adjustment']
      : executableActions.map((action) => action.reasonCode),
    actor: 'user',
    applyMutation: (transactionDb) => scheduledAdjustment
      ? transactionDb.prepare(`
          UPDATE training_weeks
             SET intensity_pct = ?, auto_adjusted = 1, adjustment_reason = ?
           WHERE id = ? AND plan_id = ?
             AND (COALESCE(intensity_pct, 100) <> ?
               OR COALESCE(auto_adjusted, 0) <> 1
               OR COALESCE(adjustment_reason, '') <> ?)
        `).run(
          scheduledAdjustment.intensityPct,
          scheduledAdjustment.reason,
          proposal.week_id,
          proposal.plan_id,
          scheduledAdjustment.intensityPct,
          scheduledAdjustment.reason,
        ).changes
      : executeCoachActions(transactionDb, {
          planId: proposal.plan_id,
          actions: executableActions,
          schedulingTimezone,
        }),
  }, activation.lease, db);
  if (!result.mutated || result.adaptationRevision !== proposal.expected_version + 1) {
    throw stateError('PROPOSAL_READBACK_MISMATCH', 'Approved week reflow did not produce the exact expected plan revision.');
  }
  return {
    kind: 'week_reflow',
    planId: proposal.plan_id,
    weekId: proposal.week_id,
    adaptationRevision: result.adaptationRevision,
    adaptationId: result.adaptationId,
    affectedSessionIds: result.affectedSessionIds,
    mutatedRows: result.mutatedRows,
    propagation: { state: 'not_synced', pending: result.affectedSessionIds.length > 0 },
  };
}

function requireScheduledAdjustment(value: unknown): { intensityPct: number; reason: string } {
  const adjustment = requireObject(value, 'PROPOSAL_REQUEST_INVALID');
  const intensityPct = Number(adjustment.intensityPct);
  const reason = typeof adjustment.reason === 'string' ? adjustment.reason.trim() : '';
  if (!Number.isSafeInteger(intensityPct) || intensityPct < 60 || intensityPct > 110
      || !reason || reason.length > 500) {
    throw stateError(
      'PROPOSAL_REQUEST_INVALID',
      'scheduledAdjustment requires an integer intensityPct from 60 to 110 and a bounded reason.',
    );
  }
  return { intensityPct, reason };
}

function requireCoachActions(value: unknown): CoachAction[] {
  const allowed = new Set([
    'drop_session', 'move_session', 'scale_volume', 'downgrade_intensity',
    'pause_training', 'swap_exercise', 'insert_recovery_day',
  ]);
  if (!Array.isArray(value) || value.length === 0 || value.length > 64
      || value.some((entry) => !entry || typeof entry !== 'object'
        || typeof (entry as Record<string, unknown>).type !== 'string'
        || !allowed.has(String((entry as Record<string, unknown>).type))
        || typeof (entry as Record<string, unknown>).reasonCode !== 'string')) {
    throw stateError('PROPOSAL_REQUEST_INVALID', 'Approved week reflow actions are invalid.');
  }
  return value as CoachAction[];
}

function requirePositiveIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw stateError('PROPOSAL_REQUEST_INVALID', 'sessionsToPreserve is invalid.');
  }
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw stateError('PROPOSAL_REQUEST_INVALID', 'sessionsToPreserve is invalid.');
  }
  return [...new Set(ids)];
}

function normalizeSyncTarget(value: unknown): 'auto' | 'none' | 'google' | 'outlook' | 'apple' {
  return value === 'none' || value === 'google' || value === 'outlook' || value === 'apple'
    ? value
    : 'auto';
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw stateError(code, 'Stored Coach V2 proposal material is invalid.');
  }
  return value as Record<string, unknown>;
}

function stateError(code: string, message: string): TrainingCoachV2ProposalStateError {
  return new TrainingCoachV2ProposalStateError(code, message);
}

export { TrainingCoachV2ProposalStateError };
