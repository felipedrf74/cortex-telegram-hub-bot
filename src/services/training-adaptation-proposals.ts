// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import { createDecisionIntent, supersedeDecisionSourceStateForEntity } from './decision-center';
import { getDb } from './database';
import { buildBusyDayOptions } from './training-busy-day-policy';
import { buildRepoTrainingCatalogSnapshot } from './coach-kernel/training-catalog';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import {
  assertTrainingExerciseIdentityCatalogIntegrity,
  buildTrainingExerciseIdentityCatalogSnapshot,
} from './training-exercise-identity';
import {
  getTrainingAdaptationV1Mode,
  getTrainingPlanRevisionV1Mode,
  isDecisionFlowV1EnforceEnabled,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  isTrainingTypedWorkoutV1Enabled,
} from './runtime-flags';
import {
  stableTrainingRevisionHash,
  validateTrainingPlanRevisionDocument,
  type TrainingPlanRevisionDocument,
} from './training-plan-revision-candidate-builder';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';
import {
  computeTrainingRevisionAuthoritativeContext,
  deriveTrainingRevisionCreationContextVersion,
  getActiveTrainingPlanReference,
  getScopedTrainingProfileSnapshot,
  getScopedTrainingPlanRevision,
  requirePersonalTrainingRevisionScope,
  type TrainingPlanRevisionResource,
  type TrainingPlanRevisionScope,
} from './training-plan-revisions';
import { buildPurposefulSubstitutionOptions } from './training-substitution-service';
import { buildTiredDayOptions } from './training-tired-day-policy';
import {
  TRAINING_ADAPTATION_API_SCHEMA,
  TRAINING_ADAPTATION_POLICY_VERSION,
  findTargetWorkout,
  type InternalTrainingAdaptationOption,
  type TrainingAdaptationExplicitInput,
  type TrainingAdaptationOption,
  type TrainingAdaptationScope,
  type TrainingAdaptationTarget,
  type TrainingAdaptationTriggerKind,
} from './training-adaptation-types';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

const PREVIEW_TTL_MINUTES = 30;
const TIRED_EVIDENCE_WINDOW_DAYS = 7;

export interface TrainingAdaptationPreviewResource {
  schemaVersion: typeof TRAINING_ADAPTATION_API_SCHEMA;
  mode: 'shadow' | 'active';
  preview: {
    proposalSetId: string;
    eventId: string;
    trigger: 'BUSY_DAY' | 'TIRED_DAY' | 'EXERCISE_SUBSTITUTION' | 'REFLOW';
    currentRevision: TrainingPlanRevisionResource;
    target: TrainingAdaptationTarget;
    options: TrainingAdaptationApiOption[];
    suppressedOptions: Array<{ action: string; reasonCode: string; explanation: string }>;
    createdAt: string;
    expiresAt: string;
  };
}

export interface TrainingAdaptationApiOption {
  optionId: string;
  adaptationId: string;
  action: string;
  scope: TrainingAdaptationScope;
  title: string;
  summary: string;
  proposedRevision: TrainingPlanRevisionResource | null;
  currentSummary: string;
  proposedSummary: string;
  currentScheduledStart: string | null;
  proposedScheduledStart: string | null;
  differences: unknown[];
  rationale: string;
  evidence: string[];
  expectedBenefit: string;
  possibleDownside: string;
  reversible: boolean;
  reversibilityExplanation: string;
  futureSessionEffect: string;
  approvalRequirement: 'NONE' | 'DECISION_CENTER';
  decisionId: string | null;
  expiresAt: string;
  originalDurationMinutes: number | null;
  resultingDurationMinutes: number | null;
  splitFeasible: boolean | null;
  substitution: Record<string, unknown> | null;
}

export interface TrainingAdaptationProposalResource {
  proposalId: string;
  adaptationId: string;
  sourceRevisionId: string;
  proposedRevision: TrainingPlanRevisionResource | null;
  decisionId: string | null;
  scope: TrainingAdaptationScope;
  triggerKind: TrainingAdaptationTriggerKind;
  optionKind: string;
  selectedOptionId: string;
  status: string;
  currentState: unknown;
  proposedState: unknown;
  exactDifferences: unknown[];
  evidence: string[];
  rationale: string;
  expectedBenefit: string;
  possibleDownside: string;
  reversibility: string;
  futureSessionEffect: string;
  approvalRequired: boolean;
  expectedSourceContentHash: string;
  expectedContextVersion: string;
  expectedActivePointerVersion: number;
  expiresAt: string;
  createdAt: string;
}

export interface TrainingAdaptationReviewResource {
  schemaVersion: typeof TRAINING_ADAPTATION_API_SCHEMA;
  adaptationId: string;
  optionId: string;
  decisionId: string;
  status: string;
}

export interface TrainingAdaptationSelectionResource {
  schemaVersion: typeof TRAINING_ADAPTATION_API_SCHEMA;
  adaptationId: string;
  optionId: string;
  decisionId: null;
  status: 'KEPT_ORIGINAL';
}

export function previewTrainingAdaptation(input: {
  scope: TrainingPlanRevisionScope;
  eventId: string;
  idempotencyKey: string;
  currentRevisionId: string;
  expectedContentHash: string;
  contextVersion: string;
  adaptationScope: TrainingAdaptationScope;
  target: TrainingAdaptationTarget;
  explicitInput: TrainingAdaptationExplicitInput;
  env?: NodeJS.ProcessEnv;
  db?: Database.Database;
}): TrainingAdaptationPreviewResource {
  const db = input.db ?? getDb();
  const mode = requirePreviewMode(input.scope, input.env);
  validateToken(input.eventId, 'TRAINING_ADAPTATION_EVENT_ID_REQUIRED');
  if (input.idempotencyKey !== `training-adaptation:${input.eventId}`) {
    throw error('TRAINING_ADAPTATION_IDEMPOTENCY_KEY_INVALID', 'The preview Idempotency-Key is not bound to this event.', 428);
  }
  validatePreviewInput(input);
  const source = requireFreshActiveSource(db, input);
  const triggerKind = input.explicitInput.kind;
  if ((triggerKind === 'BUSY_DAY' || triggerKind === 'SUBSTITUTION')
      && input.adaptationScope !== 'SESSION') {
    throw error('TRAINING_ADAPTATION_SCOPE_INVALID', 'One-day busy and substitution inputs start at SESSION scope.');
  }
  if (triggerKind === 'SUBSTITUTION') assertPinnedCatalog(source);
  const requestHash = stableTrainingRevisionHash({
    eventId: input.eventId,
    sourceRevisionId: source.revisionId,
    expectedContentHash: input.expectedContentHash,
    contextVersion: input.contextVersion,
    adaptationScope: input.adaptationScope,
    target: input.target,
    explicitInput: input.explicitInput,
    policyVersion: TRAINING_ADAPTATION_POLICY_VERSION,
  });
  if (mode === 'active') {
    const replay = readPreviewByEvent(db, input.scope, input.eventId);
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw error('TRAINING_ADAPTATION_EVENT_ID_CONFLICT', 'The event ID belongs to different explicit input.', 409);
      }
      if (Date.parse(replay.expires_at) <= Date.now()) {
        throw error('TRAINING_ADAPTATION_PREVIEW_EXPIRED', 'The adaptation preview expired; submit a new event.', 409);
      }
      return mapPreviewReplay(db, input.scope, source, replay, input.env);
    }
  }
  const immutableWorkoutKeys = immutableWorkoutKeysForSource(db, input.scope, source.revisionId);
  if (immutableWorkoutKeys.has(input.target.workoutKey)) {
    throw error('TRAINING_ADAPTATION_COMPLETED_SESSION_IMMUTABLE', 'Completed or historical sessions cannot be adapted.');
  }
  const authoritativeFreshTiredReportCount = triggerKind === 'TIRED_DAY'
    ? countFreshTiredReports(db, input.scope, source.familyId) + 1 : 0;
  const policyContext = {
    document: source.document as TrainingPlanRevisionDocument,
    target: input.target,
    requestedScope: input.adaptationScope,
    input: input.explicitInput,
    authoritativeFreshTiredReportCount,
    tiredWeekThreshold: configuredThreshold(input.env, 'TRAINING_ADAPTATION_TIRED_WEEK_THRESHOLD', 2),
    tiredPhaseThreshold: configuredThreshold(input.env, 'TRAINING_ADAPTATION_TIRED_PHASE_THRESHOLD', 3),
    immutableWorkoutKeys: [...immutableWorkoutKeys],
    ...authoritativeProfileContext(db, input.scope, source, input.env),
  };
  const rawOptions = triggerKind === 'BUSY_DAY'
    ? buildBusyDayOptions(policyContext)
    : triggerKind === 'TIRED_DAY'
      ? buildTiredDayOptions(policyContext)
      : triggerKind === 'SUBSTITUTION'
        ? buildPurposefulSubstitutionOptions(policyContext)
        : buildReflowOptions(policyContext);
  const adaptationId = `tadp_${stableTrainingRevisionHash({
    tenantId: input.scope.tenantId, userId: input.scope.userId, eventId: input.eventId, requestHash,
  }).slice(0, 32)}`;
  const internalOptions = rawOptions.map((option) => finalizeOption(adaptationId, source, option));
  const options = internalOptions.map(publicOption);
  const previewHash = stableTrainingRevisionHash({
    schemaVersion: TRAINING_ADAPTATION_API_SCHEMA,
    adaptationId,
    sourceRevisionId: source.revisionId,
    options,
  });
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + PREVIEW_TTL_MINUTES * 60_000).toISOString();
  if (mode === 'active') {
    persistPreview(db, {
      adaptationId, scope: input.scope, familyId: source.familyId, sourceRevisionId: source.revisionId,
      eventId: input.eventId, triggerKind, adaptationScope: input.adaptationScope,
      target: input.target, explicitInput: input.explicitInput, options, previewHash, requestHash,
      expectedSourceContentHash: source.contentHash, expectedContextVersion: source.creationContextVersion,
      expectedActivePointerVersion: getActiveTrainingPlanReference(input.scope, source.familyId, db)!.pointerVersion,
      createdAt, expiresAt,
    });
  }
  incrementTrainingGenerationCounter('adaptation_options_eligible_total', options.filter((entry) => entry.eligible).length);
  incrementTrainingGenerationCounter('adaptation_options_shown_total', options.length);
  incrementTrainingGenerationCounter('adaptation_options_suppressed_total', options.filter((entry) => !entry.eligible).length);
  if (triggerKind === 'TIRED_DAY' && authoritativeFreshTiredReportCount > 1) {
    incrementTrainingGenerationCounter('adaptation_repeated_tired_input_total');
  }
  if (triggerKind === 'SUBSTITUTION' && options.some((entry) => entry.eligible && entry.objectivePreserved)) {
    incrementTrainingGenerationCounter('adaptation_substitution_objective_match_total');
  }
  return presentPreview({
    mode, adaptationId, eventId: input.eventId, triggerKind, source, target: input.target,
    internalOptions, createdAt, expiresAt,
  });
}

export async function requestTrainingAdaptationReview(input: {
  scope: TrainingPlanRevisionScope;
  adaptationId: string;
  optionId: string;
  expectedCurrentRevisionId: string;
  expectedContextVersion: string;
  idempotencyKey: string;
  env?: NodeJS.ProcessEnv;
  db?: Database.Database;
}): Promise<TrainingAdaptationReviewResource> {
  const db = input.db ?? getDb();
  requireActiveMode(input.scope, input.env);
  validateToken(input.idempotencyKey, 'TRAINING_IDEMPOTENCY_KEY_REQUIRED');
  const preview = readPreviewRow(db, input.scope, input.adaptationId);
  if (!preview) throw error('TRAINING_ADAPTATION_NOT_FOUND', 'Training adaptation preview not found.', 404);
  if (input.idempotencyKey !== `training-adaptation-review:${preview.event_id}:${input.optionId}`) {
    throw error('TRAINING_ADAPTATION_IDEMPOTENCY_KEY_INVALID', 'The review Idempotency-Key is not bound to this event and option.', 428);
  }
  if (Date.parse(preview.expires_at) <= Date.now()) {
    incrementTrainingGenerationCounter('adaptation_expired_total');
    throw error('TRAINING_ADAPTATION_PREVIEW_EXPIRED', 'The adaptation preview expired; refresh options.', 409);
  }
  if (preview.source_revision_id !== input.expectedCurrentRevisionId
      || preview.expected_context_version !== input.expectedContextVersion) {
    throw error('TRAINING_ADAPTATION_PREVIEW_STALE', 'The adaptation preview no longer matches the expected revision context.', 409);
  }
  const requestHash = stableTrainingRevisionHash({
    adaptationId: input.adaptationId,
    optionId: input.optionId,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    expectedContextVersion: input.expectedContextVersion,
  });
  const replay = findProposalByIdempotency(db, input.scope, input.idempotencyKey);
  if (replay) {
    if (replay.request_hash !== requestHash) {
      throw error('TRAINING_ADAPTATION_IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to another adaptation request.', 409);
    }
    const proposal = syncProposalDecisionState(db, input.scope, replay.proposal_id);
    if (!proposal?.decisionId) return bindPendingProposalDecision(db, input, replay.proposal_id, true);
    return reviewResource(replay, proposal.decisionId);
  }
  if (findProposalByAdaptation(db, input.scope, input.adaptationId)) {
    throw error('TRAINING_ADAPTATION_ALREADY_SELECTED', 'This preview already has a selected disposition.', 409);
  }
  syncFamilyPendingProposals(db, input.scope, preview.family_id);
  if (db.prepare(`
    SELECT 1 FROM training_adaptation_proposals
     WHERE tenant_id = ? AND user_id = ? AND family_id = ? AND status IN ('CANDIDATE', 'PENDING_REVIEW', 'DEFERRED')
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId, preview.family_id)) {
    throw error('TRAINING_ADAPTATION_REVIEW_ALREADY_PENDING', 'Resolve the current adaptation review before requesting another.', 409);
  }

  const source = requireFreshActiveSource(db, {
    scope: input.scope,
    currentRevisionId: preview.source_revision_id,
    expectedContentHash: preview.expected_source_content_hash,
    contextVersion: preview.expected_context_version,
    target: parseJson(preview.target_json, { workoutKey: '' }),
    env: input.env,
  });
  const internalOptions = recomputePreviewOptions(db, input.scope, source, preview, input.env);
  const selected = internalOptions.find((entry) => entry.optionId === input.optionId);
  if (!selected || !selected.eligible || !selected.approvalRequired || !selected.proposedDocument) {
    throw error('TRAINING_ADAPTATION_OPTION_NOT_REVIEWABLE', 'The selected option is unavailable or does not require review.', 409);
  }
  const storedOptions = parseJson<TrainingAdaptationOption[]>(preview.options_json, []);
  const storedSelected = storedOptions.find((entry) => entry.optionId === selected.optionId);
  if (!storedSelected || stableTrainingRevisionHash(storedSelected) !== stableTrainingRevisionHash(publicOption(selected))) {
    throw error('TRAINING_ADAPTATION_PREVIEW_INTEGRITY_FAILED', 'The stored adaptation option no longer matches deterministic policy output.', 409);
  }
  const materialFingerprint = stableTrainingRevisionHash({
    triggerKind: preview.trigger_kind,
    optionKind: selected.optionKind,
    scope: selected.scope,
    target: parseJson(preview.target_json, {}),
    materialKey: selected.materialKey,
  });
  enforceRejectionCooldown(db, input.scope, materialFingerprint, input.env);
  const proposalId = `tapr_${randomUUID()}`;
  let proposedRevisionId: string;
  try {
    proposedRevisionId = db.transaction(() => {
    const child = insertDerivedRevision(
      db, input.scope, source, selected.proposedDocument!, selected, preview.adaptation_id,
    );
    db.prepare(`
      INSERT INTO training_adaptation_proposals (
        proposal_id, adaptation_id, tenant_id, user_id, family_id,
        source_revision_id, proposed_revision_id, scope, trigger_kind, option_kind,
        selected_option_id, option_hash, material_fingerprint,
        explicit_input_json, current_state_json, proposed_state_json, differences_json, evidence_json,
        rationale, expected_benefit, possible_downside, reversibility, future_session_effect,
        expected_source_content_hash, expected_context_version, expected_active_pointer_version,
        policy_version, preview_hash, idempotency_key, request_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId, preview.adaptation_id, input.scope.tenantId, input.scope.userId, source.familyId,
      source.revisionId, child.revisionId, selected.scope, preview.trigger_kind, selected.optionKind,
      selected.optionId, stableTrainingRevisionHash(publicOption(selected)), materialFingerprint,
      preview.explicit_input_json, JSON.stringify(selected.currentState), JSON.stringify(selected.proposedState),
      JSON.stringify(selected.exactDifferences), JSON.stringify(selected.evidence), selected.rationale, selected.expectedBenefit,
      selected.possibleDownside, selected.reversibility, selected.futureSessionEffect,
      source.contentHash, source.creationContextVersion, preview.expected_active_pointer_version,
      TRAINING_ADAPTATION_POLICY_VERSION, preview.preview_hash, input.idempotencyKey,
      requestHash, preview.expires_at,
    );
    return child.revisionId;
    })();
  } catch (transactionError) {
    if (isAdaptationSelectionUniquenessConflict(transactionError)) {
      throw error('TRAINING_ADAPTATION_ALREADY_SELECTED', 'This preview already has a selected disposition.', 409);
    }
    if (isOpenProposalUniquenessConflict(transactionError)) {
      throw error(
        'TRAINING_ADAPTATION_REVIEW_ALREADY_PENDING',
        'Resolve the current adaptation review before requesting another.',
        409,
      );
    }
    throw transactionError;
  }
  incrementTrainingGenerationCounter('adaptation_option_selected_total');
  recordAdaptationScopeSelection(selected.scope);
  return bindPendingProposalDecision(db, { ...input, proposedRevisionId }, proposalId, false);
}

export function selectTrainingAdaptationOption(input: {
  scope: TrainingPlanRevisionScope;
  adaptationId: string;
  optionId: string;
  expectedCurrentRevisionId: string;
  expectedContextVersion: string;
  idempotencyKey: string;
  env?: NodeJS.ProcessEnv;
  db?: Database.Database;
}): TrainingAdaptationSelectionResource {
  const db = input.db ?? getDb();
  requireActiveMode(input.scope, input.env);
  validateToken(input.idempotencyKey, 'TRAINING_IDEMPOTENCY_KEY_REQUIRED');
  const preview = readPreviewRow(db, input.scope, input.adaptationId);
  if (!preview) throw error('TRAINING_ADAPTATION_NOT_FOUND', 'Training adaptation preview not found.', 404);
  if (input.idempotencyKey !== `training-adaptation-selection:${preview.event_id}:${input.optionId}`) {
    throw error('TRAINING_ADAPTATION_IDEMPOTENCY_KEY_INVALID', 'The selection Idempotency-Key is not bound to this event and option.', 428);
  }
  if (Date.parse(preview.expires_at) <= Date.now()) {
    throw error('TRAINING_ADAPTATION_PREVIEW_EXPIRED', 'The adaptation preview expired; refresh options.', 409);
  }
  if (preview.source_revision_id !== input.expectedCurrentRevisionId
      || preview.expected_context_version !== input.expectedContextVersion) {
    throw error('TRAINING_ADAPTATION_PREVIEW_STALE', 'The adaptation preview no longer matches the expected revision context.', 409);
  }
  const requestHash = stableTrainingRevisionHash({
    adaptationId: input.adaptationId,
    optionId: input.optionId,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    expectedContextVersion: input.expectedContextVersion,
    disposition: 'KEEP_ORIGINAL',
  });
  const replay = findProposalByIdempotency(db, input.scope, input.idempotencyKey);
  if (replay) {
    if (replay.request_hash !== requestHash || replay.status !== 'KEPT_ORIGINAL') {
      throw error('TRAINING_ADAPTATION_IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to another adaptation request.', 409);
    }
    return keepOriginalResource(replay);
  }
  if (findProposalByAdaptation(db, input.scope, input.adaptationId)) {
    throw error('TRAINING_ADAPTATION_ALREADY_SELECTED', 'This preview already has a selected disposition.', 409);
  }
  const source = requireFreshActiveSource(db, {
    scope: input.scope,
    currentRevisionId: preview.source_revision_id,
    expectedContentHash: preview.expected_source_content_hash,
    contextVersion: preview.expected_context_version,
    target: parseJson(preview.target_json, { workoutKey: '' }),
    env: input.env,
  });
  const options = recomputePreviewOptions(db, input.scope, source, preview, input.env);
  const selected = options.find((entry) => entry.optionId === input.optionId);
  if (!selected || !selected.eligible || selected.optionKind !== 'KEEP_ORIGINAL'
      || selected.approvalRequired || selected.proposedDocument) {
    throw error('TRAINING_ADAPTATION_OPTION_NOT_SELECTABLE', 'Only the explicit keep-original option can use this no-change selection.', 409);
  }
  const stored = parseJson<TrainingAdaptationOption[]>(preview.options_json, [])
    .find((entry) => entry.optionId === selected.optionId);
  if (!stored || stableTrainingRevisionHash(stored) !== stableTrainingRevisionHash(publicOption(selected))) {
    throw error('TRAINING_ADAPTATION_PREVIEW_INTEGRITY_FAILED', 'The stored adaptation option no longer matches deterministic policy output.', 409);
  }
  const proposalId = `tapr_${randomUUID()}`;
  const materialFingerprint = stableTrainingRevisionHash({
    triggerKind: preview.trigger_kind,
    optionKind: selected.optionKind,
    scope: selected.scope,
    target: parseJson(preview.target_json, {}),
    materialKey: selected.materialKey,
  });
  try {
    db.transaction(() => {
      db.prepare(`
      INSERT INTO training_adaptation_proposals (
        proposal_id, adaptation_id, tenant_id, user_id, family_id,
        source_revision_id, proposed_revision_id, scope, trigger_kind, option_kind,
        selected_option_id, option_hash, material_fingerprint,
        explicit_input_json, current_state_json, proposed_state_json, differences_json, evidence_json,
        rationale, expected_benefit, possible_downside, reversibility, future_session_effect,
        approval_required, expected_source_content_hash, expected_context_version,
        expected_active_pointer_version, policy_version, preview_hash, idempotency_key,
        request_hash, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'KEPT_ORIGINAL', ?)
      `).run(
        proposalId, preview.adaptation_id, input.scope.tenantId, input.scope.userId, source.familyId,
        source.revisionId, selected.scope, preview.trigger_kind, selected.optionKind,
        selected.optionId, stableTrainingRevisionHash(publicOption(selected)), materialFingerprint,
        preview.explicit_input_json, JSON.stringify(selected.currentState), JSON.stringify(selected.proposedState),
        JSON.stringify(selected.exactDifferences), JSON.stringify(selected.evidence), selected.rationale,
        selected.expectedBenefit, selected.possibleDownside, selected.reversibility,
        selected.futureSessionEffect, source.contentHash, source.creationContextVersion,
        preview.expected_active_pointer_version, TRAINING_ADAPTATION_POLICY_VERSION, preview.preview_hash,
        input.idempotencyKey, requestHash, preview.expires_at,
      );
      insertLifecycleEvent(db, input.scope, proposalId, 'KEPT_ORIGINAL', 'USER_KEPT_ORIGINAL');
    })();
  } catch (transactionError) {
    if (isAdaptationSelectionUniquenessConflict(transactionError)) {
      throw error('TRAINING_ADAPTATION_ALREADY_SELECTED', 'This preview already has a selected disposition.', 409);
    }
    throw transactionError;
  }
  incrementTrainingGenerationCounter('adaptation_option_selected_total');
  return keepOriginalResource(proposalRow(db, input.scope, proposalId)!);
}

export function getTrainingAdaptationProposal(
  scope: TrainingPlanRevisionScope,
  adaptationOrProposalId: string,
  db: Database.Database = getDb(),
): TrainingAdaptationProposalResource | null {
  const row = db.prepare(`
    SELECT proposal_id FROM training_adaptation_proposals
     WHERE tenant_id = ? AND user_id = ?
       AND (proposal_id = ? OR adaptation_id = ?)
     LIMIT 1
  `).get(scope.tenantId, scope.userId, adaptationOrProposalId, adaptationOrProposalId) as { proposal_id: string } | undefined;
  return row ? mapProposal(db, scope, proposalRow(db, scope, row.proposal_id)!) : null;
}

export function getTrainingAdaptationOptionEnvelope(
  scope: TrainingPlanRevisionScope,
  adaptationOrProposalId: string,
  db: Database.Database = getDb(),
): { schemaVersion: typeof TRAINING_ADAPTATION_API_SCHEMA; mode: 'active'; option: TrainingAdaptationApiOption } | null {
  const proposal = getTrainingAdaptationProposal(scope, adaptationOrProposalId, db);
  if (!proposal) return null;
  const row = proposalRow(db, scope, proposal.proposalId);
  const source = getScopedTrainingPlanRevision(scope, proposal.sourceRevisionId, db);
  if (!row || !source) throw error('TRAINING_ADAPTATION_SOURCE_MISSING', 'The adaptation source revision is unavailable.', 409);
  const internal: InternalTrainingAdaptationOption = {
    optionId: row.selected_option_id,
    optionKind: row.option_kind as InternalTrainingAdaptationOption['optionKind'],
    scope: row.scope,
    eligible: true,
    suppressionReason: null,
    currentState: parseJson(row.current_state_json, null),
    proposedState: parseJson(row.proposed_state_json, null),
    exactDifferences: parseJson(row.differences_json, []),
    rationale: row.rationale,
    evidence: parseJson(row.evidence_json, []),
    expectedBenefit: row.expected_benefit,
    possibleDownside: row.possible_downside,
    reversibility: row.reversibility,
    futureSessionEffect: row.future_session_effect,
    approvalRequired: row.approval_required === 1,
    objectivePreserved: true,
    proposedDocument: proposal.proposedRevision
      ? proposal.proposedRevision.document as TrainingPlanRevisionDocument
      : null,
    materialKey: row.material_fingerprint,
  };
  const option = presentApiOption({
    mode: 'active', adaptationId: proposal.adaptationId, eventId: '', triggerKind: proposal.triggerKind,
    source, target: { workoutKey: '' }, internalOptions: [internal], createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  }, internal);
  option.proposedRevision = proposal.proposedRevision;
  option.decisionId = proposal.decisionId;
  return { schemaVersion: TRAINING_ADAPTATION_API_SCHEMA, mode: 'active', option };
}

async function bindPendingProposalDecision(
  db: Database.Database,
  input: {
    scope: TrainingPlanRevisionScope;
    adaptationId: string;
    expectedContextVersion: string;
    env?: NodeJS.ProcessEnv;
    proposedRevisionId?: string;
  },
  proposalId: string,
  idempotent: boolean,
): Promise<TrainingAdaptationReviewResource> {
  const row = proposalRow(db, input.scope, proposalId);
  if (!row) throw error('TRAINING_ADAPTATION_NOT_FOUND', 'Training adaptation proposal not found.', 404);
  if (row.decision_id) {
    return reviewResource(row, row.decision_id);
  }
  if (row.status !== 'CANDIDATE') {
    throw error(
      'TRAINING_ADAPTATION_REVIEW_TERMINAL',
      'This adaptation is no longer eligible to create a Decision Center review.',
      409,
    );
  }
  if (!row.proposed_revision_id) {
    throw error('TRAINING_ADAPTATION_CHILD_MISSING', 'This no-change disposition has no child revision.', 409);
  }
  const child = getScopedTrainingPlanRevision(input.scope, row.proposed_revision_id, db);
  if (!child) throw error('TRAINING_ADAPTATION_CHILD_MISSING', 'The immutable adaptation revision is missing.', 409);
  const normalizedAction = buildNormalizedDecisionAction({
    intent: 'training.activate_adaptation_revision',
    targetEntities: [{ type: 'training_plan_revision', id: child.revisionId, version: child.contentHash }],
    affectedResources: [
      { type: 'training_plan_family', id: child.familyId },
      { type: 'training_adaptation_material', id: row.material_fingerprint },
    ],
    preconditions: [
      { type: 'training_revision_content', ref: row.source_revision_id, expectedVersion: row.expected_source_content_hash, required: true },
      { type: 'training_active_pointer', ref: child.familyId, expectedVersion: `pointer:${row.expected_active_pointer_version}:revision:${row.source_revision_id}`, required: true },
      { type: 'training_adaptation_option', ref: row.selected_option_id, expectedVersion: row.option_hash, required: true },
    ],
    expectedEffects: [{ type: 'activate_training_plan_revision', targetRef: `training_plan_revision:${child.revisionId}` }],
    prohibitedEffects: [
      { type: 'modify_completed_training_session', targetRef: `training_plan_family:${child.familyId}` },
      { type: 'provider_calendar_write', targetRef: `training_plan_family:${child.familyId}` },
    ],
    dependencies: [],
    exclusivityKeys: [`training_plan_family:${input.scope.tenantId}:${child.familyId}`],
    authorizationScope: ['decision_center:write', 'training:plan:write'],
    risk: row.scope === 'SESSION' ? 'medium' : 'high',
    reversibility: 'compensatable',
    contextVersion: row.expected_context_version,
  });
  const created = await createDecisionIntent({
    userId: input.scope.userId,
    tenantId: input.scope.tenantId,
    sourceSkill: 'training',
    type: 'approval_required',
    priority: row.scope === 'SESSION' ? 'passive' : 'active',
    relatedEntityId: child.revisionId,
    relatedEntityType: 'training_plan_revision',
    title: 'Review your training adaptation',
    body: `${row.rationale} Nothing changes until you explicitly approve.`,
    actionButtons: [
      { id: 'activate_training_plan_revision', label: 'Approve and apply', style: 'primary', mutating: true },
      { id: 'open_detail', label: 'Review differences', style: 'secondary' },
    ],
    deeplink: `nexus://training/adaptation/${row.adaptation_id}`,
    expiresAt: row.expires_at,
    dedupeKey: `training-adaptation:${row.proposal_id}`,
    requiresUserAction: true,
    decisionDeadline: row.expires_at,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'health',
    visibilityScope: 'user_private',
    decisionContext: {
      entityTitle: 'Training adaptation',
      reasonCodes: ['explicit_user_input', `scope_${row.scope.toLowerCase()}`, 'immutable_child_revision'],
      sourceState: 'adaptation_candidate',
      contextObservedAt: new Date().toISOString(),
      contextExpiresAt: row.expires_at,
      evidenceConfidence: 1,
      candidateConfidence: 'high',
      evidenceReferences: [{
        evidenceId: `adaptation:${row.material_fingerprint}`,
        source: 'training_adaptation_store',
        observedAt: new Date().toISOString(),
        freshness: 'current',
        reliability: 'authoritative',
        entityVersion: row.option_hash,
        expiresAt: row.expires_at,
      }],
      sourceHealthSnapshot: [{
        source: 'training_adaptation_store', status: 'available', observedAt: new Date().toISOString(), staleAfter: row.expires_at,
      }],
      normalizedAction,
    },
  });
  const decisionId = created.item?.itemId ?? null;
  if (!decisionId) {
    db.transaction(() => {
      db.prepare(`UPDATE training_adaptation_proposals SET status = 'SUPERSEDED', superseded_at = datetime('now') WHERE proposal_id = ? AND status = 'CANDIDATE'`).run(proposalId);
      db.prepare(`UPDATE training_plan_revisions SET lifecycle_state = 'EXPIRED', approval_state = 'EXPIRED', expired_at = datetime('now') WHERE revision_id = ? AND lifecycle_state = 'CANDIDATE'`).run(child.revisionId);
      insertLifecycleEvent(db, input.scope, proposalId, 'SUPPRESSED', 'DECISION_CENTER_SUPPRESSED');
    })();
    incrementTrainingGenerationCounter('adaptation_suppressed_total');
    throw error('TRAINING_ADAPTATION_DECISION_SUPPRESSED', 'A duplicate or recently rejected adaptation is currently suppressed.', 409);
  }
  try {
    db.transaction(() => {
      const revisionUpdate = db.prepare(`
        UPDATE training_plan_revisions
           SET lifecycle_state = 'PENDING_REVIEW', approval_state = 'PENDING',
               decision_id = ?, review_requested_at = datetime('now')
         WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
           AND lifecycle_state = 'CANDIDATE' AND approval_state = 'UNREVIEWED' AND decision_id IS NULL
      `).run(decisionId, child.revisionId, input.scope.tenantId, input.scope.userId);
      const proposalUpdate = db.prepare(`
        UPDATE training_adaptation_proposals
           SET decision_id = ?, status = 'PENDING_REVIEW', review_requested_at = datetime('now')
         WHERE proposal_id = ? AND tenant_id = ? AND user_id = ? AND status = 'CANDIDATE' AND decision_id IS NULL
      `).run(decisionId, proposalId, input.scope.tenantId, input.scope.userId);
      if (revisionUpdate.changes !== 1 || proposalUpdate.changes !== 1) {
        throw error('TRAINING_ADAPTATION_DECISION_BINDING_CONFLICT', 'The adaptation review state changed concurrently.', 409);
      }
      insertLifecycleEvent(db, input.scope, proposalId, 'REVIEW_REQUESTED', null);
    })();
  } catch (bindingError) {
    const concurrent = proposalRow(db, input.scope, proposalId);
    const concurrentChild = getScopedTrainingPlanRevision(input.scope, child.revisionId, db);
    if (concurrent?.decision_id === decisionId
        && concurrent.status === 'PENDING_REVIEW'
        && concurrentChild?.decisionId === decisionId
        && concurrentChild.lifecycleState === 'PENDING_REVIEW') {
      return reviewResource(concurrent, decisionId);
    }
    if (concurrent?.status === 'CANDIDATE' && concurrent.decision_id == null
        && concurrentChild?.lifecycleState === 'CANDIDATE' && concurrentChild.decisionId == null) {
      db.transaction(() => {
        db.prepare(`
          UPDATE training_adaptation_proposals
             SET status = 'SUPERSEDED', superseded_at = datetime('now')
           WHERE proposal_id = ? AND tenant_id = ? AND user_id = ?
             AND status = 'CANDIDATE' AND decision_id IS NULL
        `).run(proposalId, input.scope.tenantId, input.scope.userId);
        db.prepare(`
          UPDATE training_plan_revisions
             SET lifecycle_state = 'EXPIRED', approval_state = 'EXPIRED', expired_at = datetime('now')
           WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
             AND lifecycle_state = 'CANDIDATE' AND approval_state = 'UNREVIEWED' AND decision_id IS NULL
        `).run(child.revisionId, input.scope.tenantId, input.scope.userId);
        insertLifecycleEvent(db, input.scope, proposalId, 'SUPERSEDED', 'DECISION_BINDING_CONFLICT');
      })();
      // Decision Center remains the only authority that closes its item. Once
      // the child is terminal, its source-state verifier deterministically
      // supersedes the orphaned item without a direct Training table write.
      supersedeDecisionSourceStateForEntity({
        userId: input.scope.userId,
        tenantId: input.scope.tenantId,
        sourceSkill: 'training',
        relatedEntityType: 'training_plan_revision',
        relatedEntityId: child.revisionId,
      });
    }
    throw bindingError;
  }
  const proposal = proposalRow(db, input.scope, proposalId)!;
  return reviewResource(proposal, decisionId);
}

function reviewResource(row: ProposalRow, decisionId: string): TrainingAdaptationReviewResource {
  return {
    schemaVersion: TRAINING_ADAPTATION_API_SCHEMA,
    adaptationId: row.adaptation_id,
    optionId: row.selected_option_id,
    decisionId,
    status: row.status === 'CANDIDATE' ? 'PENDING_REVIEW' : row.status,
  };
}

function keepOriginalResource(row: ProposalRow): TrainingAdaptationSelectionResource {
  return {
    schemaVersion: TRAINING_ADAPTATION_API_SCHEMA,
    adaptationId: row.adaptation_id,
    optionId: row.selected_option_id,
    decisionId: null,
    status: 'KEPT_ORIGINAL',
  };
}

function insertDerivedRevision(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  source: TrainingPlanRevisionResource,
  document: TrainingPlanRevisionDocument,
  option: InternalTrainingAdaptationOption,
  adaptationId: string,
): TrainingPlanRevisionResource {
  const checks = validateTrainingPlanRevisionDocument(document, { typedWorkoutValidationEnabled: true });
  const revisionId = proposedRevisionId(adaptationId, option);
  const sequence = (db.prepare(`
    SELECT COALESCE(MAX(revision_sequence), 0) AS sequence FROM training_plan_revisions
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
  `).get(scope.tenantId, scope.userId, source.familyId) as { sequence: number }).sequence + 1;
  const contentHash = stableTrainingRevisionHash(document);
  db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      parent_revision_id, profile_snapshot_id, origin, lifecycle_state, approval_state,
      creation_context_version, policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version, revision_document_json,
      content_hash, quality_report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GENERATED', 'CANDIDATE', 'UNREVIEWED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revisionId, scope.tenantId, scope.userId, source.familyId, sequence,
    source.revisionId, source.profileSnapshotId, source.creationContextVersion,
    TRAINING_ADAPTATION_POLICY_VERSION, source.catalog.version, source.catalog.sourceHash,
    source.capabilityRegistryVersion, source.documentSchemaVersion, JSON.stringify(document), contentHash,
    JSON.stringify({
      qualityReport: { status: 'PASS', checks },
      causalFactors: source.causalFactors,
      adaptation: { optionKind: option.optionKind, scope: option.scope, objectivePreserved: option.objectivePreserved },
    }),
  );
  return getScopedTrainingPlanRevision(scope, revisionId, db)!;
}

function recomputePreviewOptions(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  source: TrainingPlanRevisionResource,
  preview: PreviewRow,
  env?: NodeJS.ProcessEnv,
): InternalTrainingAdaptationOption[] {
  const explicitInput = parseJson<TrainingAdaptationExplicitInput>(preview.explicit_input_json, null as never);
  const target = parseJson<TrainingAdaptationTarget>(preview.target_json, { workoutKey: '' });
  if (!explicitInput || explicitInput.kind !== preview.trigger_kind) {
    throw error('TRAINING_ADAPTATION_PREVIEW_INTEGRITY_FAILED', 'The preview input is invalid.', 409);
  }
  if (explicitInput.kind === 'SUBSTITUTION') assertPinnedCatalog(source);
  const authoritativeFreshTiredReportCount = explicitInput.kind === 'TIRED_DAY'
    ? countFreshTiredReports(db, scope, source.familyId, preview.adaptation_id) + 1 : 0;
  const context = {
    document: source.document as TrainingPlanRevisionDocument,
    target,
    requestedScope: preview.scope,
    input: explicitInput,
    authoritativeFreshTiredReportCount,
    tiredWeekThreshold: configuredThreshold(env, 'TRAINING_ADAPTATION_TIRED_WEEK_THRESHOLD', 2),
    tiredPhaseThreshold: configuredThreshold(env, 'TRAINING_ADAPTATION_TIRED_PHASE_THRESHOLD', 3),
    immutableWorkoutKeys: [...immutableWorkoutKeysForSource(db, scope, source.revisionId)],
    ...authoritativeProfileContext(db, scope, source, env),
  };
  const options = explicitInput.kind === 'BUSY_DAY'
    ? buildBusyDayOptions(context)
    : explicitInput.kind === 'TIRED_DAY'
      ? buildTiredDayOptions(context)
      : explicitInput.kind === 'SUBSTITUTION'
        ? buildPurposefulSubstitutionOptions(context)
        : buildReflowOptions(context);
  return options.map((entry) => finalizeOption(preview.adaptation_id, source, entry));
}

function requireFreshActiveSource(
  db: Database.Database,
  input: {
    scope: TrainingPlanRevisionScope;
    currentRevisionId: string;
    expectedContentHash: string;
    contextVersion: string;
    target: TrainingAdaptationTarget;
    env?: NodeJS.ProcessEnv;
  },
): TrainingPlanRevisionResource {
  const source = getScopedTrainingPlanRevision(input.scope, input.currentRevisionId, db);
  if (!source) throw error('TRAINING_REVISION_NOT_FOUND', 'Training plan revision not found.', 404);
  if (source.origin !== 'GENERATED' || source.documentSchemaVersion !== 'training-plan-revision.v2'
      || source.lifecycleState !== 'ACTIVE' || source.approvalState !== 'APPROVED') {
    throw error('TRAINING_ADAPTATION_TYPED_ACTIVE_REQUIRED', 'Only an active typed generated revision can be adapted.', 409);
  }
  if (source.contentHash !== input.expectedContentHash || source.creationContextVersion !== input.contextVersion) {
    throw error('TRAINING_ADAPTATION_SOURCE_STALE', 'The active revision content or context changed.', 409);
  }
  const active = getActiveTrainingPlanReference(input.scope, source.familyId, db);
  if (!active || active.activeRevisionId !== source.revisionId) {
    throw error('TRAINING_ADAPTATION_ACTIVE_POINTER_STALE', 'The active revision pointer changed.', 409);
  }
  if (!findTargetWorkout(source.document as TrainingPlanRevisionDocument, input.target.workoutKey)) {
    throw error('TRAINING_ADAPTATION_WORKOUT_NOT_FOUND', 'The target workout is not in the active revision.', 404);
  }
  const currentContext = db.prepare(`
    SELECT base_context_version, current_context_version,
           profile_source_version, calendar_source_version, conflict_source_version
      FROM training_plan_current_contexts
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
  `).get(input.scope.tenantId, input.scope.userId, source.familyId) as {
    base_context_version: string;
    current_context_version: string;
    profile_source_version: string;
    calendar_source_version: string;
    conflict_source_version: string;
  } | undefined;
  const live = computeTrainingRevisionAuthoritativeContext(db, input.scope);
  const liveVersion = currentContext
    ? deriveTrainingRevisionCreationContextVersion(currentContext.base_context_version, live) : null;
  if (!currentContext || liveVersion !== source.creationContextVersion
      || currentContext.current_context_version !== source.creationContextVersion
      || currentContext.profile_source_version !== live.profileSourceVersion
      || currentContext.calendar_source_version !== live.calendarSourceVersion
      || currentContext.conflict_source_version !== live.conflictSourceVersion) {
    throw error('TRAINING_ADAPTATION_CONTEXT_STALE', 'Training context changed; refresh the active revision before adapting.', 409);
  }
  return source;
}

function requirePreviewMode(scope: TrainingPlanRevisionScope, env?: NodeJS.ProcessEnv): 'shadow' | 'active' {
  requirePersonalTrainingRevisionScope(scope);
  const effective = env ?? process.env;
  const mode = getTrainingAdaptationV1Mode(effective, scope);
  if (mode === 'off') throw error('TRAINING_ADAPTATION_V1_NOT_ACTIVE', 'Training adaptation is unavailable.', 404);
  if (getTrainingPlanRevisionV1Mode(effective, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(effective, scope)
      || !isTrainingTypedWorkoutV1Enabled(effective, scope)) {
    throw error('TRAINING_ADAPTATION_DEPENDENCY_DISABLED', 'Typed Training revision dependencies are unavailable.', 409);
  }
  if (mode === 'active' && !isDecisionFlowV1EnforceEnabled(effective, scope)) {
    throw error('TRAINING_ADAPTATION_DECISION_FLOW_REQUIRED', 'Active adaptations require Decision Flow enforcement.', 409);
  }
  return mode;
}

function requireActiveMode(scope: TrainingPlanRevisionScope, env?: NodeJS.ProcessEnv): void {
  if (requirePreviewMode(scope, env) !== 'active') {
    throw error('TRAINING_ADAPTATION_V1_NOT_ACTIVE', 'Adaptation writes require active mode.', 404);
  }
}

function finalizeOption(
  adaptationId: string,
  source: TrainingPlanRevisionResource,
  option: InternalTrainingAdaptationOption,
): InternalTrainingAdaptationOption {
  if (option.eligible && option.proposedDocument) {
    validateTrainingPlanRevisionDocument(option.proposedDocument, { typedWorkoutValidationEnabled: true });
  }
  return {
    ...option,
    optionId: `taopt_${stableTrainingRevisionHash({
      adaptationId, sourceRevisionId: source.revisionId, materialKey: option.materialKey,
      proposedHash: option.proposedDocument ? stableTrainingRevisionHash(option.proposedDocument) : null,
    }).slice(0, 32)}`,
  };
}

function publicOption(option: InternalTrainingAdaptationOption): TrainingAdaptationOption {
  const { proposedDocument: _document, materialKey: _materialKey, ...publicValue } = option;
  return publicValue;
}

function proposedRevisionId(
  adaptationId: string,
  option: Pick<InternalTrainingAdaptationOption, 'optionId' | 'materialKey'>,
): string {
  return `trpr_${stableTrainingRevisionHash({ adaptationId, optionId: option.optionId, materialKey: option.materialKey }).slice(0, 32)}`;
}

function presentPreview(input: {
  mode: 'shadow' | 'active';
  adaptationId: string;
  eventId: string;
  triggerKind: TrainingAdaptationTriggerKind;
  source: TrainingPlanRevisionResource;
  target: TrainingAdaptationTarget;
  internalOptions: InternalTrainingAdaptationOption[];
  createdAt: string;
  expiresAt: string;
}): TrainingAdaptationPreviewResource {
  return {
    schemaVersion: TRAINING_ADAPTATION_API_SCHEMA,
    mode: input.mode,
    preview: {
      proposalSetId: input.adaptationId,
      eventId: input.eventId,
      trigger: apiTrigger(input.triggerKind),
      currentRevision: input.source,
      target: input.target,
      options: input.internalOptions
        .filter((option) => option.eligible)
        .map((option) => presentApiOption(input, option)),
      suppressedOptions: input.internalOptions
        .filter((option) => !option.eligible)
        .map((option) => ({
          action: apiAction(option.optionKind),
          reasonCode: suppressionReasonCode(option),
          explanation: option.suppressionReason ?? option.rationale,
        })),
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    },
  };
}

function presentApiOption(
  input: Parameters<typeof presentPreview>[0],
  option: InternalTrainingAdaptationOption,
): TrainingAdaptationApiOption {
  const current = asSummary(option.currentState);
  const proposed = asSummary(option.proposedState);
  const proposedRevision = option.proposedDocument ? {
    ...input.source,
    revisionId: proposedRevisionId(input.adaptationId, option),
    revisionSequence: input.source.revisionSequence + 1,
    parentRevisionId: input.source.revisionId,
    lifecycleState: 'CANDIDATE' as const,
    approvalState: 'UNREVIEWED' as const,
    decisionId: null,
    contentHash: stableTrainingRevisionHash(option.proposedDocument),
    policyVersion: TRAINING_ADAPTATION_POLICY_VERSION,
    document: option.proposedDocument,
    qualityReport: {
      status: 'PASS' as const,
      checks: validateTrainingPlanRevisionDocument(
        option.proposedDocument,
        { typedWorkoutValidationEnabled: true },
      ),
    },
    createdAt: input.createdAt,
    reviewRequestedAt: null,
    activatedAt: null,
  } : null;
  const substitution = proposed && typeof proposed.substitution === 'object'
    ? proposed.substitution as Record<string, unknown> : null;
  return {
    optionId: option.optionId,
    adaptationId: input.adaptationId,
    action: apiAction(option.optionKind),
    scope: option.scope,
    title: optionTitle(option.optionKind),
    summary: option.rationale,
    proposedRevision,
    currentSummary: summaryText(current),
    proposedSummary: summaryText(proposed),
    currentScheduledStart: null,
    proposedScheduledStart: null,
    differences: option.exactDifferences,
    rationale: option.rationale,
    evidence: option.evidence,
    expectedBenefit: option.expectedBenefit,
    possibleDownside: option.possibleDownside,
    reversible: true,
    reversibilityExplanation: option.reversibility,
    futureSessionEffect: option.futureSessionEffect,
    approvalRequirement: option.approvalRequired ? 'DECISION_CENTER' : 'NONE',
    decisionId: null,
    expiresAt: input.expiresAt,
    originalDurationMinutes: numericSummaryValue(current, 'plannedDurationMinutes'),
    resultingDurationMinutes: numericSummaryValue(proposed, 'plannedDurationMinutes'),
    splitFeasible: option.optionKind === 'SPLIT_SESSION' ? true : null,
    substitution,
  };
}

function apiTrigger(kind: TrainingAdaptationTriggerKind): TrainingAdaptationPreviewResource['preview']['trigger'] {
  return kind === 'SUBSTITUTION' ? 'EXERCISE_SUBSTITUTION' : kind;
}

function apiAction(kind: InternalTrainingAdaptationOption['optionKind']): string {
  switch (kind) {
    case 'SHORTEN_MINIMUM_EFFECTIVE': return 'SHORTEN';
    case 'SPLIT_SESSION': return 'SPLIT';
    case 'LOWER_COMPLEXITY_SUBSTITUTION': return 'LOWER_COMPLEXITY';
    case 'PURPOSEFUL_SUBSTITUTION': return 'SUBSTITUTE_EXERCISE';
    default: return kind;
  }
}

function optionTitle(kind: InternalTrainingAdaptationOption['optionKind']): string {
  switch (kind) {
    case 'SHORTEN_MINIMUM_EFFECTIVE': return 'Shortened minimum-effective session';
    case 'RESCHEDULE': return 'Reschedule';
    case 'SPLIT_SESSION': return 'Split the session';
    case 'KEEP_ORIGINAL': return 'Keep the original workout';
    case 'REDUCE_VOLUME': return 'Reduce volume';
    case 'REDUCE_INTENSITY': return 'Reduce intensity';
    case 'LOWER_COMPLEXITY_SUBSTITUTION': return 'Use a lower-complexity alternative';
    case 'PURPOSEFUL_SUBSTITUTION': return 'Substitute the exercise';
  }
}

function suppressionReasonCode(option: InternalTrainingAdaptationOption): string {
  if (option.optionKind === 'SHORTEN_MINIMUM_EFFECTIVE') return 'ESSENTIAL_MINIMUM_EXCEEDS_AVAILABLE_TIME';
  if (option.optionKind === 'PURPOSEFUL_SUBSTITUTION') return 'NO_SAFE_OBJECTIVE_EQUIVALENT';
  if (option.optionKind === 'SPLIT_SESSION') return 'SPLIT_WINDOW_NOT_FEASIBLE';
  if (option.optionKind === 'RESCHEDULE') return 'AUTHORITATIVE_WINDOW_UNAVAILABLE';
  return 'OPTION_NOT_FEASIBLE';
}

function asSummary(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function numericSummaryValue(value: Record<string, unknown> | null, key: string): number | null {
  return typeof value?.[key] === 'number' ? value[key] as number : null;
}

function summaryText(value: Record<string, unknown> | null): string {
  if (!value) return 'No material change is proposed.';
  const title = typeof value.title === 'string' ? value.title : 'Workout';
  const duration = numericSummaryValue(value, 'plannedDurationMinutes');
  return duration == null ? title : `${title} · ${duration} minutes`;
}

function buildReflowOptions(context: {
  document: TrainingPlanRevisionDocument;
  target: TrainingAdaptationTarget;
}): InternalTrainingAdaptationOption[] {
  const workout = findTargetWorkout(context.document, context.target.workoutKey)?.workout;
  if (!workout) throw error('TRAINING_ADAPTATION_WORKOUT_NOT_FOUND', 'The target workout is unavailable.', 404);
  const currentState = {
    workoutKey: workout.workoutKey,
    title: workout.title,
    plannedDurationMinutes: workout.plannedDurationMinutes,
    dayOfWeek: workout.dayOfWeek,
  };
  return [{
    optionId: '', optionKind: 'RESCHEDULE', scope: 'SESSION', eligible: false,
    suppressionReason: 'No authoritative replacement window was supplied by the current schedule.',
    currentState, proposedState: null, exactDifferences: [],
    rationale: 'Reflow requires a fresh authoritative schedule window before a material proposal can be reviewed.',
    evidence: [], expectedBenefit: 'No speculative schedule change is proposed.',
    possibleDownside: 'The existing legacy reflow flow remains available.', reversibility: 'No change is made.',
    futureSessionEffect: 'No future session changes.', approvalRequired: false, objectivePreserved: true,
    proposedDocument: null, materialKey: `reflow:unavailable:${workout.workoutKey}`,
  }, {
    optionId: '', optionKind: 'KEEP_ORIGINAL', scope: 'SESSION', eligible: true,
    suppressionReason: null, currentState, proposedState: currentState, exactDifferences: [],
    rationale: 'Keep the currently approved schedule while no verified replacement window exists.',
    evidence: ['explicit_trigger:REFLOW'], expectedBenefit: 'Avoids a speculative schedule mutation.',
    possibleDownside: 'The current timing remains unchanged.', reversibility: 'No change is made.',
    futureSessionEffect: 'No future session changes.', approvalRequired: false, objectivePreserved: true,
    proposedDocument: null, materialKey: `reflow:keep:${workout.workoutKey}`,
  }];
}

function persistPreview(db: Database.Database, value: {
  adaptationId: string; scope: TrainingPlanRevisionScope; familyId: string; sourceRevisionId: string;
  eventId: string; triggerKind: TrainingAdaptationTriggerKind; adaptationScope: TrainingAdaptationScope;
  target: TrainingAdaptationTarget; explicitInput: TrainingAdaptationExplicitInput;
  options: TrainingAdaptationOption[]; previewHash: string; requestHash: string;
  expectedSourceContentHash: string; expectedContextVersion: string;
  expectedActivePointerVersion: number; createdAt: string; expiresAt: string;
}): void {
  const prior = db.prepare(`
    SELECT adaptation_id, request_hash FROM training_adaptation_previews
     WHERE tenant_id = ? AND user_id = ? AND event_id = ?
  `).get(value.scope.tenantId, value.scope.userId, value.eventId) as {
    adaptation_id: string; request_hash: string;
  } | undefined;
  if (prior) {
    if (prior.adaptation_id !== value.adaptationId || prior.request_hash !== value.requestHash) {
      throw error('TRAINING_ADAPTATION_EVENT_ID_CONFLICT', 'The event ID belongs to different explicit input.', 409);
    }
    return;
  }
  db.prepare(`
    INSERT INTO training_adaptation_previews (
      adaptation_id, tenant_id, user_id, family_id, source_revision_id,
      event_id, trigger_kind, scope, target_json, explicit_input_json, options_json,
      preview_hash, request_hash, expected_source_content_hash, expected_context_version,
      expected_active_pointer_version, policy_version, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.adaptationId, value.scope.tenantId, value.scope.userId, value.familyId,
    value.sourceRevisionId, value.eventId, value.triggerKind, value.adaptationScope,
    JSON.stringify(value.target), JSON.stringify(value.explicitInput), JSON.stringify(value.options),
    value.previewHash, value.requestHash, value.expectedSourceContentHash,
    value.expectedContextVersion, value.expectedActivePointerVersion,
    TRAINING_ADAPTATION_POLICY_VERSION, value.expiresAt, value.createdAt,
  );
}

function immutableWorkoutKeysForSource(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  revisionId: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT revision_session_key AS workoutKey
      FROM training_sessions
     WHERE tenant_id = ? AND source_revision_id = ?
       AND lower(status) IN ('completed', 'partial', 'skipped', 'cancelled', 'canceled')
  `).all(scope.tenantId, revisionId) as Array<{ workoutKey: string | null }>;
  return new Set(rows.flatMap((row) => row.workoutKey ? [row.workoutKey] : []));
}

function assertPinnedCatalog(source: TrainingPlanRevisionResource): void {
  const baseCatalog = buildRepoTrainingCatalogSnapshot(loadCoachKnowledge());
  if (baseCatalog.catalogVersion === source.catalog.version
      && baseCatalog.sourceHash === source.catalog.sourceHash) return;

  try {
    const identityCatalog = buildTrainingExerciseIdentityCatalogSnapshot();
    assertTrainingExerciseIdentityCatalogIntegrity(identityCatalog);
    if (identityCatalog.catalogVersion === source.catalog.version
        && identityCatalog.sourceHash === source.catalog.sourceHash) return;
  } catch {
    // Identity authority is optional for base-catalog revisions but must remain
    // integrity-verified before it can authorize an identity-backed source.
  }

  throw error(
    'TRAINING_ADAPTATION_CATALOG_STALE',
    'The source revision catalog is no longer an integrity-verified active catalog.',
    409,
  );
}

function authoritativeProfileContext(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  source: TrainingPlanRevisionResource,
  env?: NodeJS.ProcessEnv,
): {
  authoritativeEquipmentIds: string[];
  authoritativeExclusions: string[];
  authoritativePreferences: string[];
} {
  const snapshot = getScopedTrainingProfileSnapshot(scope, source.profileSnapshotId, env, db);
  const profile = snapshot?.body.profileKind === 'generated' ? snapshot.body.request?.profile : null;
  if (!snapshot || !profile) {
    throw error('TRAINING_ADAPTATION_PROFILE_SNAPSHOT_STALE', 'The immutable profile snapshot is unavailable.', 409);
  }
  return {
    authoritativeEquipmentIds: [...new Set(['bodyweight', ...profile.equipmentIds])].sort(),
    authoritativeExclusions: [...new Set(profile.exclusions ?? [])].sort(),
    authoritativePreferences: [...new Set(profile.preferences ?? [])].sort(),
  };
}

function countFreshTiredReports(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  familyId: string,
  excludingAdaptationId?: string,
): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM training_adaptation_previews
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
       AND trigger_kind = 'TIRED_DAY' AND adaptation_id <> ?
       AND datetime(created_at) >= datetime('now', ?)
  `).get(
    scope.tenantId, scope.userId, familyId, excludingAdaptationId ?? '', `-${TIRED_EVIDENCE_WINDOW_DAYS} days`,
  ) as { count: number }).count;
}

function enforceRejectionCooldown(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  materialFingerprint: string,
  env?: NodeJS.ProcessEnv,
): void {
  const days = configuredThreshold(env, 'TRAINING_ADAPTATION_REJECTION_COOLDOWN_DAYS', 7, 1, 90);
  const rejected = db.prepare(`
    SELECT proposals.proposal_id
      FROM training_adaptation_proposals proposals
      LEFT JOIN notification_center_items decisions
        ON decisions.item_id = proposals.decision_id
       AND decisions.user_id = proposals.user_id
       AND decisions.tenant_id = proposals.tenant_id
     WHERE proposals.tenant_id = ? AND proposals.user_id = ?
       AND proposals.material_fingerprint = ?
       AND (proposals.status = 'REJECTED' OR decisions.decision_state = 'rejected' OR decisions.status = 'dismissed')
       AND datetime(COALESCE(proposals.rejected_at, decisions.updated_at, proposals.created_at)) >= datetime('now', ?)
     LIMIT 1
  `).get(scope.tenantId, scope.userId, materialFingerprint, `-${days} days`);
  if (rejected) {
    incrementTrainingGenerationCounter('adaptation_suppressed_total');
    throw error('TRAINING_ADAPTATION_REJECTION_COOLDOWN', 'This materially unchanged adaptation is in rejection cooldown.', 409);
  }
}

function syncProposalDecisionState(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  proposalId: string,
): TrainingAdaptationProposalResource | null {
  const row = proposalRow(db, scope, proposalId);
  if (!row) return null;
  if (row.decision_id && ['PENDING_REVIEW', 'DEFERRED'].includes(row.status)) {
    const decision = db.prepare(`
      SELECT decision_state, status, expires_at FROM notification_center_items
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).get(row.decision_id, scope.userId, scope.tenantId) as {
      decision_state: string | null; status: string; expires_at: string | null;
    } | undefined;
    const expired = decision?.status === 'expired'
      || (!!decision?.expires_at && Date.parse(decision.expires_at) <= Date.now())
      || Date.parse(row.expires_at) <= Date.now();
    if (decision?.decision_state === 'rejected' || decision?.status === 'dismissed') {
      db.prepare(`UPDATE training_adaptation_proposals SET status = 'REJECTED', rejected_at = datetime('now') WHERE proposal_id = ? AND status IN ('PENDING_REVIEW', 'DEFERRED')`).run(row.proposal_id);
      insertLifecycleEvent(db, scope, row.proposal_id, 'REJECTED', 'DECISION_REJECTED');
      incrementTrainingGenerationCounter('adaptation_rejected_total');
    } else if (expired) {
      db.prepare(`UPDATE training_adaptation_proposals SET status = 'EXPIRED', expired_at = datetime('now') WHERE proposal_id = ? AND status IN ('PENDING_REVIEW', 'DEFERRED')`).run(row.proposal_id);
      insertLifecycleEvent(db, scope, row.proposal_id, 'EXPIRED', 'REVIEW_EXPIRED');
      incrementTrainingGenerationCounter('adaptation_expired_total');
    } else if (decision?.decision_state === 'deferred' && row.status === 'PENDING_REVIEW') {
      db.prepare(`UPDATE training_adaptation_proposals SET status = 'DEFERRED', deferred_at = datetime('now') WHERE proposal_id = ? AND status = 'PENDING_REVIEW'`).run(row.proposal_id);
      insertLifecycleEvent(db, scope, row.proposal_id, 'DEFERRED', 'DECISION_DEFERRED');
    }
  }
  return mapProposal(db, scope, proposalRow(db, scope, proposalId)!);
}

function syncFamilyPendingProposals(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  familyId: string,
): void {
  const rows = db.prepare(`
    SELECT proposal_id FROM training_adaptation_proposals
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
       AND status IN ('PENDING_REVIEW', 'DEFERRED')
  `).all(scope.tenantId, scope.userId, familyId) as Array<{ proposal_id: string }>;
  for (const row of rows) syncProposalDecisionState(db, scope, row.proposal_id);
}

interface PreviewRow {
  adaptation_id: string; family_id: string; source_revision_id: string; trigger_kind: TrainingAdaptationTriggerKind;
  event_id: string; scope: TrainingAdaptationScope; target_json: string; explicit_input_json: string; options_json: string;
  preview_hash: string; expected_source_content_hash: string; expected_context_version: string;
  request_hash: string; expected_active_pointer_version: number; created_at: string; expires_at: string;
}

interface ProposalRow {
  proposal_id: string; adaptation_id: string; family_id: string; source_revision_id: string;
  proposed_revision_id: string | null; decision_id: string | null; scope: TrainingAdaptationScope;
  trigger_kind: TrainingAdaptationTriggerKind; option_kind: string; selected_option_id: string;
  option_hash: string; material_fingerprint: string; current_state_json: string; proposed_state_json: string;
  differences_json: string; evidence_json: string; rationale: string; expected_benefit: string; possible_downside: string;
  reversibility: string; future_session_effect: string; expected_source_content_hash: string;
  expected_context_version: string; expected_active_pointer_version: number; request_hash: string;
  approval_required: number; status: string; expires_at: string; created_at: string;
}

function readPreviewRow(db: Database.Database, scope: TrainingPlanRevisionScope, adaptationId: string): PreviewRow | null {
  return (db.prepare(`
    SELECT * FROM training_adaptation_previews
     WHERE adaptation_id = ? AND tenant_id = ? AND user_id = ?
  `).get(adaptationId, scope.tenantId, scope.userId) as PreviewRow | undefined) ?? null;
}

function readPreviewByEvent(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  eventId: string,
): PreviewRow | null {
  return (db.prepare(`
    SELECT * FROM training_adaptation_previews
     WHERE event_id = ? AND tenant_id = ? AND user_id = ?
  `).get(eventId, scope.tenantId, scope.userId) as PreviewRow | undefined) ?? null;
}

function mapPreviewReplay(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  source: TrainingPlanRevisionResource,
  row: PreviewRow,
  env?: NodeJS.ProcessEnv,
): TrainingAdaptationPreviewResource {
  return presentPreview({
    mode: 'active',
    adaptationId: row.adaptation_id,
    eventId: row.event_id,
    triggerKind: row.trigger_kind,
    source,
    target: parseJson<TrainingAdaptationTarget>(row.target_json, { workoutKey: '' }),
    internalOptions: recomputePreviewOptions(db, scope, source, row, env),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

function proposalRow(db: Database.Database, scope: TrainingPlanRevisionScope, proposalId: string): ProposalRow | null {
  return (db.prepare(`
    SELECT * FROM training_adaptation_proposals
     WHERE proposal_id = ? AND tenant_id = ? AND user_id = ?
  `).get(proposalId, scope.tenantId, scope.userId) as ProposalRow | undefined) ?? null;
}

function findProposalByIdempotency(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  idempotencyKey: string,
): ProposalRow | null {
  return (db.prepare(`
    SELECT * FROM training_adaptation_proposals
     WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(scope.tenantId, scope.userId, idempotencyKey) as ProposalRow | undefined) ?? null;
}

function findProposalByAdaptation(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  adaptationId: string,
): ProposalRow | null {
  return (db.prepare(`
    SELECT * FROM training_adaptation_proposals
     WHERE tenant_id = ? AND user_id = ? AND adaptation_id = ?
  `).get(scope.tenantId, scope.userId, adaptationId) as ProposalRow | undefined) ?? null;
}

function mapProposal(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  row: ProposalRow,
): TrainingAdaptationProposalResource {
  const revision = row.proposed_revision_id
    ? getScopedTrainingPlanRevision(scope, row.proposed_revision_id, db)
    : null;
  if (row.proposed_revision_id && !revision) {
    throw error('TRAINING_ADAPTATION_CHILD_MISSING', 'The immutable adaptation revision is missing.', 409);
  }
  return {
    proposalId: row.proposal_id, adaptationId: row.adaptation_id, sourceRevisionId: row.source_revision_id,
    proposedRevision: revision, decisionId: row.decision_id, scope: row.scope, triggerKind: row.trigger_kind,
    optionKind: row.option_kind, selectedOptionId: row.selected_option_id, status: row.status,
    currentState: parseJson(row.current_state_json, null), proposedState: parseJson(row.proposed_state_json, null),
    exactDifferences: parseJson(row.differences_json, []), rationale: row.rationale,
    evidence: parseJson(row.evidence_json, []),
    expectedBenefit: row.expected_benefit, possibleDownside: row.possible_downside,
    reversibility: row.reversibility, futureSessionEffect: row.future_session_effect,
    approvalRequired: row.approval_required === 1, expectedSourceContentHash: row.expected_source_content_hash,
    expectedContextVersion: row.expected_context_version,
    expectedActivePointerVersion: row.expected_active_pointer_version,
    expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

function insertLifecycleEvent(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  proposalId: string,
  eventType: string,
  reasonCode: string | null,
): void {
  db.prepare(`
    INSERT INTO training_adaptation_lifecycle_events (
      event_id, proposal_id, tenant_id, user_id, event_type, reason_code, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, '{}')
  `).run(`tale_${randomUUID()}`, proposalId, scope.tenantId, scope.userId, eventType, reasonCode);
}

function configuredThreshold(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  fallback: number,
  minimum = 2,
  maximum = 20,
): number {
  const value = Number.parseInt((env ?? process.env)[key] ?? '', 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function recordAdaptationScopeSelection(scope: TrainingAdaptationScope): void {
  incrementTrainingGenerationCounter(
    scope === 'SESSION' ? 'adaptation_scope_session_total'
      : scope === 'WEEK' ? 'adaptation_scope_week_total'
        : scope === 'PHASE' ? 'adaptation_scope_phase_total'
          : 'adaptation_scope_full_plan_total',
  );
}

function validateToken(value: string, code: string): void {
  if (!value?.trim() || value.length > 200) throw error(code, 'A valid bounded identifier is required.', 428);
}

function validatePreviewInput(input: {
  currentRevisionId: string;
  expectedContentHash: string;
  contextVersion: string;
  adaptationScope: TrainingAdaptationScope;
  target: TrainingAdaptationTarget;
  explicitInput: TrainingAdaptationExplicitInput;
}): void {
  validateToken(input.currentRevisionId, 'TRAINING_REVISION_ID_REQUIRED');
  validateToken(input.contextVersion, 'TRAINING_CONTEXT_VERSION_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(input.expectedContentHash)) {
    throw error('TRAINING_CONTENT_HASH_INVALID', 'A valid expected content hash is required.', 400);
  }
  if (!['SESSION', 'WEEK', 'PHASE', 'FULL_PLAN'].includes(input.adaptationScope)) {
    throw error('TRAINING_ADAPTATION_SCOPE_INVALID', 'A canonical adaptation scope is required.', 400);
  }
  if (!input.target || typeof input.target !== 'object') {
    throw error('TRAINING_ADAPTATION_TARGET_INVALID', 'A bounded Training target is required.', 400);
  }
  validateToken(input.target.workoutKey, 'TRAINING_ADAPTATION_WORKOUT_KEY_REQUIRED');
  if (input.target.sessionId != null
      && (typeof input.target.sessionId !== 'string'
        || !input.target.sessionId.trim() || input.target.sessionId.length > 200)) {
    throw error('TRAINING_ADAPTATION_SESSION_ID_INVALID', 'The target session ID is invalid.', 400);
  }
  for (const value of [input.target.blockId, input.target.exerciseId]) {
    if (value != null && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw error('TRAINING_ADAPTATION_TARGET_INVALID', 'The block or exercise target is invalid.', 400);
    }
  }
  if (!input.explicitInput || typeof input.explicitInput !== 'object') {
    throw error('TRAINING_ADAPTATION_EXPLICIT_INPUT_REQUIRED', 'Explicit adaptation input is required.', 400);
  }
  const explicit = input.explicitInput;
  if (explicit.kind === 'BUSY_DAY') {
    if (!Number.isSafeInteger(explicit.availableMinutes)
        || explicit.availableMinutes < 5 || explicit.availableMinutes > 1_440
        || (explicit.secondWindowMinutes != null
          && (!Number.isSafeInteger(explicit.secondWindowMinutes)
            || explicit.secondWindowMinutes < 5 || explicit.secondWindowMinutes > 1_440))
        || (explicit.secondWindowGapMinutes != null
          && (!Number.isSafeInteger(explicit.secondWindowGapMinutes)
            || explicit.secondWindowGapMinutes < 1 || explicit.secondWindowGapMinutes > 1_440))) {
      throw error('TRAINING_BUSY_DAY_AVAILABLE_MINUTES_INVALID', 'Busy-day time windows are invalid.', 400);
    }
    validateScheduleFields(explicit.rescheduleDay, explicit.authoritativeScheduleVersion);
    return;
  }
  if (explicit.kind === 'TIRED_DAY') {
    if (explicit.selfReport !== 'MORE_TIRED_THAN_EXPECTED') {
      throw error('TRAINING_TIRED_DAY_EXPLICIT_INPUT_REQUIRED', 'An explicit tiredness self-report is required.', 400);
    }
    if (explicit.reportedLevel != null
        && !['SLIGHTLY', 'MORE_THAN_EXPECTED', 'VERY_TIRED'].includes(explicit.reportedLevel)) {
      throw error('TRAINING_TIRED_DAY_LEVEL_INVALID', 'The explicit tiredness level is invalid.', 400);
    }
    validateStringList(explicit.availableEquipmentIds ?? [], 'TRAINING_ADAPTATION_EQUIPMENT_INVALID');
    validateStringList(explicit.exclusions ?? [], 'TRAINING_ADAPTATION_EXCLUSIONS_INVALID');
    validateScheduleFields(explicit.rescheduleDay, explicit.authoritativeScheduleVersion);
    return;
  }
  if (explicit.kind === 'SUBSTITUTION') {
    if (!['EQUIPMENT', 'EXCLUSION'].includes(explicit.reason)) {
      throw error('TRAINING_SUBSTITUTION_REASON_INVALID', 'A supported substitution reason is required.', 400);
    }
    validateToken(explicit.originalExerciseId, 'TRAINING_SUBSTITUTION_EXERCISE_INVALID');
    if (explicit.originalExerciseId !== input.target.exerciseId) {
      throw error('TRAINING_SUBSTITUTION_TARGET_MISMATCH', 'The original exercise must match the scoped target.', 400);
    }
    validateStringList(explicit.unavailableEquipmentIds, 'TRAINING_ADAPTATION_EQUIPMENT_INVALID');
    validateStringList(explicit.exclusions, 'TRAINING_ADAPTATION_EXCLUSIONS_INVALID');
    if (explicit.proposedExerciseId != null) validateToken(explicit.proposedExerciseId, 'TRAINING_SUBSTITUTION_EXERCISE_INVALID');
    return;
  }
  if (explicit.kind === 'REFLOW') return;
  throw error('TRAINING_ADAPTATION_EXPLICIT_INPUT_REQUIRED', 'A supported explicit adaptation input is required.', 400);
}

function validateStringList(values: unknown, code: string): void {
  if (!Array.isArray(values) || values.length > 100
      || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 128)) {
    throw error(code, 'A bounded list of identifiers is required.', 400);
  }
}

function validateScheduleFields(day: unknown, version: unknown): void {
  if (day != null && !['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(String(day))) {
    throw error('TRAINING_ADAPTATION_RESCHEDULE_DAY_INVALID', 'The reschedule day is invalid.', 400);
  }
  if (version != null && (typeof version !== 'string' || !version.trim() || version.length > 200)) {
    throw error('TRAINING_ADAPTATION_SCHEDULE_VERSION_INVALID', 'The authoritative schedule version is invalid.', 400);
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function error(code: string, message: string, statusCode = 400): TrainingPlanRevisionError {
  return new TrainingPlanRevisionError(code, message, statusCode);
}

function isOpenProposalUniquenessConflict(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return value.message.includes('uq_training_adaptation_family_open_proposal')
    || value.message.includes('training_adaptation_proposals.tenant_id, training_adaptation_proposals.user_id, training_adaptation_proposals.family_id');
}

function isAdaptationSelectionUniquenessConflict(value: unknown): boolean {
  return value instanceof Error
    && value.message.includes('training_adaptation_proposals.tenant_id, training_adaptation_proposals.user_id, training_adaptation_proposals.adaptation_id');
}
