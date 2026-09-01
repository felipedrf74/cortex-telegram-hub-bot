// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CoachAction } from './coach-kernel/scenario-classifier';
import type { DayOfWeek, IntensityZone } from './coach-kernel/types';
import {
  stableTrainingRevisionHash,
  validateTrainingPlanRevisionDocument,
  type TrainingPlanRevisionDocument,
  type TrainingPlanRevisionWorkout,
} from './training-plan-revision-candidate-builder';
import {
  getActiveTrainingPlanReference,
  getScopedTrainingPlanRevision,
  type TrainingPlanRevisionResource,
} from './training-plan-revisions';

const REVISION_POLICY_VERSION = 'training-coach-v2-revision-proposal.v1';

export interface StagedCoachV2RevisionProposal {
  revisionId: string;
  contentHash: string;
  contextVersion: string;
  familyId: string;
  adaptationId: string;
  adaptationProposalId: string;
}

/**
 * Materialize a Coach V2 proposal as an immutable child revision while the
 * active projection remains untouched. The generic proposal and this graph
 * are committed by the caller's transaction; Decision Center binding happens
 * separately and is the only transition to PENDING_REVIEW.
 */
export function stageCoachV2ImmutableRevisionProposal(input: {
  db: Database.Database;
  tenantId: number;
  userId: number;
  proposalId: string;
  planId: number;
  weekId: number | null;
  kind: 'week_reflow' | 'coach_policy';
  request: Record<string, unknown>;
  evidence: Record<string, unknown>;
  requestHash: string;
  expiresAt: string;
}): StagedCoachV2RevisionProposal | null {
  const plan = input.db.prepare(`
    SELECT source_revision_id AS sourceRevisionId
      FROM fitness_training_plans
     WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(input.planId, input.tenantId, input.userId) as { sourceRevisionId: string | null } | undefined;
  if (!plan?.sourceRevisionId) return null;
  const scope = { tenantId: input.tenantId, userId: input.userId };
  const source = getScopedTrainingPlanRevision(scope, plan.sourceRevisionId, input.db);
  if (!source || source.lifecycleState !== 'ACTIVE' || source.approvalState !== 'APPROVED'
      || source.origin !== 'GENERATED'
      || stableTrainingRevisionHash(source.document) !== source.contentHash) {
    throw new Error('TRAINING_COACH_V2_REVISION_SOURCE_STALE');
  }
  const active = getActiveTrainingPlanReference(scope, source.familyId, input.db);
  if (!active || active.activeRevisionId !== source.revisionId || active.projectionPlanId !== input.planId) {
    throw new Error('TRAINING_COACH_V2_REVISION_POINTER_STALE');
  }
  const staged = buildChildDocument(input.db, source, input);
  validateTrainingPlanRevisionDocument(staged.document, { typedWorkoutValidationEnabled: true });
  const sequence = (input.db.prepare(`
    SELECT COALESCE(MAX(revision_sequence), 0) AS sequence
      FROM training_plan_revisions
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
  `).get(input.tenantId, input.userId, source.familyId) as { sequence: number }).sequence + 1;
  const suffix = stableTrainingRevisionHash({
    proposalId: input.proposalId,
    requestHash: input.requestHash,
    sourceRevisionId: source.revisionId,
  }).slice(0, 32);
  const revisionId = `trpr_coachv2_${suffix}`;
  const adaptationId = `tadp_coachv2_${suffix}`;
  const adaptationProposalId = `tapr_coachv2_${suffix}`;
  const optionId = `taopt_coachv2_${suffix}`;
  const contentHash = stableTrainingRevisionHash(staged.document);
  const optionHash = stableTrainingRevisionHash({
    kind: input.kind,
    documentHash: contentHash,
    differences: staged.differences,
  });
  const previewHash = stableTrainingRevisionHash({
    adaptationId,
    sourceRevisionId: source.revisionId,
    optionId,
    optionHash,
  });
  const target = { workoutKey: staged.targetWorkoutKey };
  const explicitInput = { kind: 'REFLOW', coachV2ProposalId: input.proposalId };
  const option = {
    optionId,
    optionKind: input.kind === 'coach_policy' ? 'COACH_POLICY' : 'REFLOW',
    scope: staged.scope,
    eligible: true,
    suppressionReason: null,
    currentState: staged.currentState,
    proposedState: staged.proposedState,
    exactDifferences: staged.differences,
    rationale: 'Apply the reviewed Coach V2 change as an immutable child revision.',
    evidence: ['coach_v2_proposal', 'immutable_child_revision'],
    expectedBenefit: 'Keep the reviewed plan and its compatibility projection consistent.',
    possibleDownside: 'The change affects future training only.',
    reversibility: 'A later reviewed revision can compensate this change.',
    futureSessionEffect: input.kind === 'coach_policy'
      ? 'Future coaching decisions use the reviewed policy.'
      : 'Only future sessions inside the reviewed scope may change.',
    approvalRequired: true,
    objectivePreserved: true,
  };

  input.db.prepare(`
    INSERT INTO training_adaptation_previews (
      adaptation_id, tenant_id, user_id, family_id, source_revision_id,
      event_id, trigger_kind, scope, target_json, explicit_input_json, options_json,
      preview_hash, request_hash, expected_source_content_hash, expected_context_version,
      expected_active_pointer_version, policy_version, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'REFLOW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    adaptationId, input.tenantId, input.userId, source.familyId, source.revisionId,
    `coach-v2:${input.proposalId}`, staged.scope, JSON.stringify(target), JSON.stringify(explicitInput),
    JSON.stringify([option]), previewHash, input.requestHash, source.contentHash,
    source.creationContextVersion, active.pointerVersion, REVISION_POLICY_VERSION, input.expiresAt,
  );
  input.db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      parent_revision_id, profile_snapshot_id, origin, lifecycle_state, approval_state,
      creation_context_version, policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version, revision_document_json,
      content_hash, quality_report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GENERATED', 'CANDIDATE', 'UNREVIEWED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revisionId, input.tenantId, input.userId, source.familyId, sequence,
    source.revisionId, source.profileSnapshotId, source.creationContextVersion,
    REVISION_POLICY_VERSION, source.catalog.version, source.catalog.sourceHash,
    source.capabilityRegistryVersion, source.documentSchemaVersion,
    JSON.stringify(staged.document), contentHash,
    JSON.stringify({
      qualityReport: {
        status: 'PASS',
        checks: [{
          code: 'COACH_V2_IMMUTABLE_CHILD',
          status: 'PASS',
          evidence: `Bound to Coach V2 request ${input.requestHash}`,
        }],
      },
      causalFactors: source.causalFactors,
      coachV2: { proposalId: input.proposalId, kind: input.kind },
    }),
  );
  input.db.prepare(`
    INSERT INTO training_adaptation_proposals (
      proposal_id, adaptation_id, tenant_id, user_id, family_id,
      source_revision_id, proposed_revision_id, scope, trigger_kind, option_kind,
      selected_option_id, option_hash, material_fingerprint,
      explicit_input_json, current_state_json, proposed_state_json, differences_json, evidence_json,
      rationale, expected_benefit, possible_downside, reversibility, future_session_effect,
      expected_source_content_hash, expected_context_version, expected_active_pointer_version,
      policy_version, preview_hash, idempotency_key, request_hash, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REFLOW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    adaptationProposalId, adaptationId, input.tenantId, input.userId, source.familyId,
    source.revisionId, revisionId, staged.scope, option.optionKind, optionId, optionHash,
    stableTrainingRevisionHash({ sourceRevisionId: source.revisionId, kind: input.kind, target }),
    JSON.stringify(explicitInput), JSON.stringify(staged.currentState), JSON.stringify(staged.proposedState),
    JSON.stringify(staged.differences), JSON.stringify(input.evidence), option.rationale,
    option.expectedBenefit, option.possibleDownside, option.reversibility, option.futureSessionEffect,
    source.contentHash, source.creationContextVersion, active.pointerVersion,
    REVISION_POLICY_VERSION, previewHash, `coach-v2-revision:${input.proposalId}`,
    input.requestHash, input.expiresAt,
  );
  input.db.prepare(`
    INSERT INTO training_adaptation_lifecycle_events (
      event_id, proposal_id, tenant_id, user_id, event_type, reason_code, metadata_json
    ) VALUES (?, ?, ?, ?, 'PREVIEWED', 'COACH_V2_IMMUTABLE_CHILD', '{}')
  `).run(`tale_${digest(`previewed:${adaptationProposalId}`).slice(0, 32)}`,
    adaptationProposalId, input.tenantId, input.userId);
  return {
    revisionId,
    contentHash,
    contextVersion: source.creationContextVersion,
    familyId: source.familyId,
    adaptationId,
    adaptationProposalId,
  };
}

export function bindCoachV2ImmutableRevisionDecision(input: {
  db: Database.Database;
  tenantId: number;
  userId: number;
  revisionId: string;
  decisionId: string;
}): void {
  const revision = input.db.prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'PENDING_REVIEW', approval_state = 'PENDING',
           decision_id = ?, review_requested_at = datetime('now')
     WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
       AND lifecycle_state = 'CANDIDATE' AND approval_state = 'UNREVIEWED'
       AND decision_id IS NULL
  `).run(input.decisionId, input.revisionId, input.tenantId, input.userId);
  const proposal = input.db.prepare(`
    UPDATE training_adaptation_proposals
       SET decision_id = ?, status = 'PENDING_REVIEW', review_requested_at = datetime('now')
     WHERE proposed_revision_id = ? AND tenant_id = ? AND user_id = ?
       AND status = 'CANDIDATE' AND decision_id IS NULL
  `).run(input.decisionId, input.revisionId, input.tenantId, input.userId);
  if (revision.changes !== 1 || proposal.changes !== 1) {
    throw new Error('TRAINING_COACH_V2_REVISION_BINDING_CONFLICT');
  }
  const row = input.db.prepare(`
    SELECT proposal_id AS proposalId FROM training_adaptation_proposals
     WHERE proposed_revision_id = ? AND tenant_id = ? AND user_id = ?
  `).get(input.revisionId, input.tenantId, input.userId) as { proposalId: string };
  input.db.prepare(`
    INSERT INTO training_adaptation_lifecycle_events (
      event_id, proposal_id, tenant_id, user_id, event_type, reason_code, metadata_json
    ) VALUES (?, ?, ?, ?, 'REVIEW_REQUESTED', 'COACH_V2_DECISION_BOUND', '{}')
  `).run(`tale_${digest(`review:${row.proposalId}`).slice(0, 32)}`,
    row.proposalId, input.tenantId, input.userId);
}

export function getStagedCoachV2Revision(input: {
  db: Database.Database;
  tenantId: number;
  userId: number;
  revisionId: string;
}): { revisionId: string; contentHash: string; contextVersion: string } | null {
  const row = input.db.prepare(`
    SELECT revision_id AS revisionId, content_hash AS contentHash,
           creation_context_version AS contextVersion
      FROM training_plan_revisions
     WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
  `).get(input.revisionId, input.tenantId, input.userId) as {
    revisionId: string;
    contentHash: string;
    contextVersion: string;
  } | undefined;
  return row ?? null;
}

function buildChildDocument(
  db: Database.Database,
  source: TrainingPlanRevisionResource,
  input: {
    tenantId: number;
    userId: number;
    planId: number;
    weekId: number | null;
    kind: 'week_reflow' | 'coach_policy';
    request: Record<string, unknown>;
  },
): {
  document: TrainingPlanRevisionDocument;
  targetWorkoutKey: string;
  scope: 'SESSION' | 'WEEK';
  currentState: unknown;
  proposedState: unknown;
  differences: Array<{ path: string; before: unknown; after: unknown }>;
} {
  const document = JSON.parse(JSON.stringify(source.document)) as TrainingPlanRevisionDocument & {
    coachPolicy?: Record<string, unknown>;
    coachWeekAdjustments?: Record<string, { intensityPct: number; reason: string }>;
  };
  const week = resolveDocumentWeek(db, document, input.planId, input.weekId);
  const targetWorkoutKey = week.workouts[0]?.workoutKey;
  if (!targetWorkoutKey) throw new Error('TRAINING_COACH_V2_REVISION_WEEK_EMPTY');
  if (input.kind === 'coach_policy') {
    const proposed = requireObject(input.request.proposedPolicy, 'TRAINING_COACH_V2_POLICY_INVALID');
    const before = document.coachPolicy ?? null;
    document.coachPolicy = proposed;
    return {
      document,
      targetWorkoutKey,
      scope: 'WEEK',
      currentState: { coachPolicyHash: stableTrainingRevisionHash(before) },
      proposedState: { coachPolicyHash: stableTrainingRevisionHash(proposed) },
      differences: [{ path: 'coachPolicy', before: stableTrainingRevisionHash(before), after: stableTrainingRevisionHash(proposed) }],
    };
  }
  const scheduledAdjustment = input.request.scheduledAdjustment === undefined
    ? null
    : requireScheduledAdjustment(input.request.scheduledAdjustment);
  if (scheduledAdjustment) {
    const before = document.coachWeekAdjustments?.[week.weekKey] ?? null;
    document.coachWeekAdjustments = {
      ...(document.coachWeekAdjustments ?? {}),
      [week.weekKey]: scheduledAdjustment,
    };
    return {
      document,
      targetWorkoutKey,
      scope: 'WEEK',
      currentState: { weekKey: week.weekKey, adjustment: before },
      proposedState: { weekKey: week.weekKey, adjustment: scheduledAdjustment },
      differences: [{ path: `coachWeekAdjustments.${week.weekKey}`, before, after: scheduledAdjustment }],
    };
  }
  const actions = requireCoachActions(input.request.actions);
  const identities = new Map((db.prepare(`
    SELECT id, revision_session_key AS workoutKey
      FROM training_sessions
     WHERE plan_id = ? AND week_id = ? AND tenant_id = ?
  `).all(input.planId, input.weekId, input.tenantId) as Array<{ id: number; workoutKey: string | null }>)
    .flatMap((row) => row.workoutKey ? [[String(row.id), row.workoutKey] as const] : []));
  const before = stableTrainingRevisionHash(week);
  const changedKeys = new Set<string>();
  for (const action of actions) {
    if (!('sessionId' in action)) {
      throw new Error(`TRAINING_COACH_V2_REVISION_ACTION_UNSUPPORTED:${action.type}`);
    }
    const workoutKey = identities.get(String(action.sessionId));
    const workout = workoutKey
      ? document.weeks.flatMap((entry) => entry.workouts).find((entry) => entry.workoutKey === workoutKey)
      : undefined;
    if (!workout || !workoutKey) throw new Error('TRAINING_COACH_V2_REVISION_SESSION_IDENTITY_MISSING');
    if (action.type === 'scale_volume') {
      scaleWorkout(workout, action.multiplier);
    } else if (action.type === 'downgrade_intensity') {
      downgradeWorkout(workout, action.targetCeiling);
    } else if (action.type === 'drop_session') {
      dropWorkout(workout, action.reasonCode);
    } else if (action.type === 'move_session') {
      if (document.m4) throw new Error('TRAINING_COACH_V2_REVISION_M4_MOVE_REQUIRES_CAPACITY_REVIEW');
      moveWorkout(workout, action.toDate);
    } else {
      throw new Error(`TRAINING_COACH_V2_REVISION_ACTION_UNSUPPORTED:${action.type}`);
    }
    recordWorkoutAdaptation(workout, action.type, action.reasonCode);
    changedKeys.add(workoutKey);
  }
  return {
    document,
    targetWorkoutKey: [...changedKeys][0] ?? targetWorkoutKey,
    scope: changedKeys.size > 1 ? 'WEEK' : 'SESSION',
    currentState: { weekKey: week.weekKey, stateHash: before },
    proposedState: { weekKey: week.weekKey, stateHash: stableTrainingRevisionHash(week) },
    differences: [{ path: `weeks.${week.weekKey}`, before, after: stableTrainingRevisionHash(week) }],
  };
}

function resolveDocumentWeek(
  db: Database.Database,
  document: TrainingPlanRevisionDocument,
  planId: number,
  weekId: number | null,
): TrainingPlanRevisionDocument['weeks'][number] {
  if (weekId == null) return document.weeks[0];
  const row = db.prepare(`
    SELECT revision_week_key AS weekKey, week_number AS weekNumber
      FROM training_weeks WHERE id = ? AND plan_id = ?
  `).get(weekId, planId) as { weekKey: string | null; weekNumber: number } | undefined;
  const week = document.weeks.find((entry) =>
    (row?.weekKey && entry.weekKey === row.weekKey) || entry.weekNumber === row?.weekNumber);
  if (!week) throw new Error('TRAINING_COACH_V2_REVISION_WEEK_MISSING');
  return week;
}

function recordWorkoutAdaptation(
  workout: TrainingPlanRevisionWorkout,
  actionType: 'drop_session' | 'move_session' | 'scale_volume' | 'downgrade_intensity',
  reasonCode: string,
): void {
  const normalizedReason = reasonCode.trim();
  if (!normalizedReason || normalizedReason.length > 200) {
    throw new Error('TRAINING_COACH_V2_REVISION_ACTION_REASON_INVALID');
  }
  workout.executionAdaptations = [
    ...(workout.executionAdaptations ?? []),
    { actionType, reasonCode: normalizedReason },
  ];
}

function dropWorkout(workout: TrainingPlanRevisionWorkout, reasonCode: string): void {
  const normalizedReason = reasonCode.trim();
  if (!normalizedReason || normalizedReason.length > 200) {
    throw new Error('TRAINING_COACH_V2_REVISION_DROP_REASON_INVALID');
  }
  workout.executionDisposition = {
    state: 'DROPPED',
    reasonCode: normalizedReason,
  };
}

function scaleWorkout(workout: TrainingPlanRevisionWorkout, multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier < 0.25 || multiplier > 1.5) {
    throw new Error('TRAINING_COACH_V2_REVISION_VOLUME_INVALID');
  }
  const minimum = workout.blocks.reduce((sum, block) => sum + block.minimumDurationMinutes, 0);
  const target = Math.max(minimum, Math.round(workout.plannedDurationMinutes * multiplier));
  const flexible = workout.blocks.map((block) => Math.max(0, block.plannedDurationMinutes - block.minimumDurationMinutes));
  const totalFlexible = flexible.reduce((sum, value) => sum + value, 0);
  let remaining = target - minimum;
  workout.blocks = workout.blocks.map((block, index) => {
    const isLast = index === workout.blocks.length - 1;
    const extra = isLast
      ? remaining
      : totalFlexible === 0 ? 0 : Math.min(remaining, Math.round((target - minimum) * flexible[index] / totalFlexible));
    remaining -= extra;
    return { ...block, plannedDurationMinutes: block.minimumDurationMinutes + extra };
  });
  workout.plannedDurationMinutes = workout.blocks.reduce((sum, block) => sum + block.plannedDurationMinutes, 0);
  if (workout.scheduledStartAt) {
    const start = Date.parse(workout.scheduledStartAt);
    if (Number.isFinite(start)) workout.scheduledEndAt = new Date(start + workout.plannedDurationMinutes * 60_000).toISOString();
  }
}

function downgradeWorkout(workout: TrainingPlanRevisionWorkout, ceiling: IntensityZone): void {
  const rpeCap: Record<IntensityZone, number> = {
    recovery: 3, aerobic: 5, tempo: 6, threshold: 7, vo2: 8, neuromuscular: 9,
  };
  const lower = (prescription: Record<string, unknown>): Record<string, unknown> => {
    if (prescription.kind === 'strength') {
      return {
        ...prescription,
        targetRpe: Math.min(Number(prescription.targetRpe) || rpeCap[ceiling], rpeCap[ceiling]),
        targetRir: Math.max(Number(prescription.targetRir) || 0, Math.max(0, 10 - rpeCap[ceiling])),
      };
    }
    if (prescription.kind === 'mixed_session' && Array.isArray(prescription.segments)) {
      return {
        ...prescription,
        segments: prescription.segments.map((segment) => {
          const value = requireObject(segment, 'TRAINING_COACH_V2_REVISION_PRESCRIPTION_INVALID');
          return { ...value, prescription: lower(requireObject(value.prescription, 'TRAINING_COACH_V2_REVISION_PRESCRIPTION_INVALID')) };
        }),
      };
    }
    if ('effortZone' in prescription) return { ...prescription, effortZone: ceiling };
    if ('targetIntensity' in prescription) return { ...prescription, targetIntensity: ceiling };
    if ('effortGuidance' in prescription) return { ...prescription, effortGuidance: ceiling };
    return prescription;
  };
  workout.blocks = workout.blocks.map((block) => ({
    ...block,
    prescription: lower(block.prescription as unknown as Record<string, unknown>) as unknown as typeof block.prescription,
  }));
}

function moveWorkout(workout: TrainingPlanRevisionWorkout, toDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || !Number.isFinite(Date.parse(`${toDate}T12:00:00Z`))) {
    throw new Error('TRAINING_COACH_V2_REVISION_MOVE_DATE_INVALID');
  }
  const days: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  workout.dayOfWeek = days[new Date(`${toDate}T12:00:00Z`).getUTCDay()];
  workout.scheduledDate = toDate;
  if (workout.scheduledStartAt) {
    const time = workout.scheduledStartAt.match(/T(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)(Z|[+-]\d{2}:\d{2})$/);
    if (time) {
      workout.scheduledStartAt = `${toDate}T${time[1]}${time[2]}`;
      workout.scheduledEndAt = new Date(Date.parse(workout.scheduledStartAt) + workout.plannedDurationMinutes * 60_000).toISOString();
    }
  }
}

function requireCoachActions(value: unknown): CoachAction[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('TRAINING_COACH_V2_REVISION_ACTIONS_INVALID');
  }
  return value as CoachAction[];
}

function requireScheduledAdjustment(value: unknown): { intensityPct: number; reason: string } {
  const adjustment = requireObject(value, 'TRAINING_COACH_V2_SCHEDULED_ADJUSTMENT_INVALID');
  const intensityPct = Number(adjustment.intensityPct);
  const reason = typeof adjustment.reason === 'string' ? adjustment.reason.trim() : '';
  if (!Number.isSafeInteger(intensityPct) || intensityPct < 60 || intensityPct > 110
      || !reason || reason.length > 500) {
    throw new Error('TRAINING_COACH_V2_SCHEDULED_ADJUSTMENT_INVALID');
  }
  return { intensityPct, reason };
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
