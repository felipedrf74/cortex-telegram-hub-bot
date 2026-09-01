// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center command service implementation.
 * Keep persistence, authorization, and projection behavior in its owning module.
 */

import { createHash, randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import { getDb } from '../database';

import { emitDomainEvent } from '../event-outbox';

import { incrementTrainingGenerationCounter } from '../training-generation-observability';

import { trainingOperationLockPublicError } from '../training-operation-locks';

import { isTrainingCoachV2Enabled } from '../training-coach-v2-rollout';

import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  getNotificationProfileIfExists,
  getOrCreateNotificationProfile,
  getNotificationReliabilityDashboard,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  updateNotificationProfile,
  NotificationProposalCommitError,
  type NotificationActionButton,
  type NotificationCenterItem,
  type NotificationEvaluationResult,
  type NotificationIntentInput,
  type NotificationIntentType,
  type NotificationPriority,
  type NotificationPrivacyPolicy,
  type NotificationProfile,
  type NotificationSourceSkill,
} from '../notification-orchestrator';

import { listNotificationApnsActionExposures } from '../notification-contracts';

import {
  decideContentWorkspaceReview as decideContentApproval,
  getContentDecisionWorkspaceObject as getContentWorkflowObject,
} from '../content-workspace-decision-adapter';

import {
  getSecretaryAgendaItemById,
  type ReasoningTrailNode,
  type SecretaryAgendaItem,
} from '../secretary-scheduling-arbitrator';

import { secretaryAgendaStateRevision } from '../secretary-agenda-state-revision';

import {
  getMealPlan,
  setMealPlan,
} from '../cooking-chef';

import {
  getTaxEvents,
  markTaxPaid,
} from '../finance-tracker';

import { listTasksForUser } from '../task-store/task-service';

import { priorityToImportance } from '../task-store/task-priority';

import type { NormalizedTask } from '../task-store/types';

import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from '../chat-pending-confirmations';

import { isValidTenantUserId, recordTenantScopeAnomaly } from '../tenant-scope-observability';

import { logger } from '../../utils/logger';

import { normalizeSupportedLang } from '../../utils/i18n';

import { getDecisionConflictPolicyV1Mode, isDecisionCenterCommandBusEnabled, isDecisionCenterFatigueCapsEnabled, isDecisionCenterGuidanceSkillEnabled, isDecisionCenterGuidanceV1Enabled, isDecisionChoiceOptionsEnabled, isDecisionConflictPolicyV1Enabled, isDecisionEvidenceFreshnessGateEnabled, isDecisionFeedbackSuppressionEnabled, isDecisionFlowV1EnforceEnabled, isDecisionHumanReviewGateEnabled, isDecisionLowRiskAutoResolutionEnabled, isDecisionReconnectAffordanceEnabled, isDecisionRefreshEnabled, isDecisionRollbackSnapshotProtectionEnabled, isDecisionSemanticDedupEnabled, isDecisionSemanticSupersedeEnabled, isDecisionSkillCardsEnabled, isDecisionStreakV1Enabled, isDecisionTypeSuppressionEnabled, isTrainingDecisionFlowV1EnforceEnabled } from '../runtime-flags';

import { buildDecisionConflictSummary, type ConflictEvaluation, type DecisionConflictSummary } from '../decision-conflict-evaluator';

import {
  buildNormalizedDecisionAction,
  logicalActionAttemptHash,
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from '../decision-action-contract';

import { isLowRiskAutoReflowEligible, revalidateNormalizedDecisionAction } from '../decision-preexecution-revalidator';

import { directOwnedContentObjectForDecision } from '../decision-command-effects';

import {
  contentWorkflowStateRevision,
  cookingMealSlotStateRevision,
  financeTaxEventStateRevision,
} from '../decision-domain-state-revision';

import { decisionRelationshipSemantics, type DecisionRelationshipKind, type DecisionRelationshipType } from '../decision-relationship-types';

import { buildDecisionDedupKey, classifyDecisionDedup } from '../decision-center-semantic-dedup';

import type { SecretaryTodaySummaryModel } from '../secretary-orchestrator';

import { secretaryTodayLabels } from '../secretary-today-copy';

import {
  buildDecisionActionTruthTableEntry,
  isDecisionActionAllowedFromApns,
  isDecisionActionExecutable,
  type DecisionActionTruthTableEntry,
} from '../decision-center-action-truth-table';

import {
  getLearningCase,
  learningReviewApprovalReferenceForExecution,
  recordLearningCaseReviewApproval,
} from '../product-learning';

import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  formatDecisionWindow,
  rankDecision,
  type AutomationEligibility,
  type DecisionFrontendActionState,
  type DecisionFrontendDisplayMode,
  type DecisionLogicContext,
  type DecisionLogicV2,
  type DecisionQualityGateResult,
  type SecretaryAvailableSlot,
  type SecretaryDecisionAdvice,
  type DecisionVisibilityScope,
  type DecisionWhatWillChange,
  type DecisionWhy,
} from '../decision-center-logic-v2';

import { resolveDecisionDeferUntil } from './defer-time';

import { ensureDecisionCenterTables } from './repository-readiness';

import {
  createDecisionCenterEngineSelector,
  resolveDecisionCenterRewriteMode,
} from './engine-selector';

import {
  evaluateDecisionApnsActionPolicy,
  type DecisionApnsActionPolicyDecision,
  type DecisionApnsExactFetchResult,
} from './apns-action-policy';

import { findDecisionExecutor, hasDecisionExecutor } from './execution-registry';

import { invalidatePlanningAfterVerifiedDecisionSourceMutation } from './planning-cache-invalidation';

import {
  createDecisionMutationCommand,
  type DecisionMutationApproval,
  type DecisionMutationChannel,
  type DecisionMutationCommand,
} from './contracts';

import {
  DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
  materializeDecisionRankSnapshot,
} from './rank-snapshot-service';

import type { DecisionRankSnapshot } from './rank-snapshot-repository';

import {
  DECISION_RANKING_POLICY,
  DECISION_RANKING_VERSION,
  rankDecisionPriority,
  type DecisionPrioritySnapshot,
  type DecisionPriorityTier,
  type DecisionRankingInputs,
} from './ranking-policy';

import {
  actionOutcomeFromRecord,
  applyDecisionFatigueCaps,
  computeActionEffectiveStatus,
  computeActionability,
  computeConfidenceExplanation,
  computeDecisionKind,
  computeEffectiveStatus,
  gateActionabilityForHumanReview,
  gateActionabilityForStaleEvidence,
  isDecisionItemPolicyFloored,
  isHumanReviewQueueAvailable,
  legacyStatusToLifecycle,
  type DecisionFatiguePolicy,
} from './projection-policy';

import {
  emitDecisionActionPreviewedIfFirst,
  emitDecisionLifecycleEvent,
  emitUnblockedDependentsForBlockers,
  listDecisionDependencies,
  recordDecisionConflictEvaluation,
  recordDecisionOutcome,
  recordVerifiedDecisionAction,
  resolveDecisionConflictAudit,
  supersedeDecision,
} from './lifecycle-preferences-jobs';
import {
  assertDecisionActionReplayFingerprint,
  decisionActionRequestFingerprint,
  decisionStateForConflictEvaluation,
} from './proposal-service';
import {
  approvalLevelForRecord,
  conflictMaterialKey,
  decisionContextForRecord,
  durableDecisionStateForRecord,
  evaluateDecisionApnsActionRequest,
  formatDecisionItemForApi,
  getDecisionItem,
  getDecisionRecord,
  isMissingRaceDateRecipe,
  materializeDecisionRankSnapshotForScope,
  reviewSupportedForRecord,
  secretaryReflowChoiceAdvice,
  userDecisionContextDefaults,
} from './read-projection-ranking-service';
import {
  CONTENT_APPROVAL_ACTION_IDS,
  DECISION_EXECUTION_LEASE_SECONDS,
  FINANCE_PAYMENT_ACTION_IDS,
  MUTATING_ACTIONS,
  SECRETARY_REFLOW_ACTION_IDS,
  VERSIONED_DECISION_ACTIONS,
  appNowIso,
  assertDecisionScopedUpdateApplied,
  assertScope,
  contentWorkflowObjectIdForDecision,
  decisionFlowV1EnforcedForRecord,
  decisionOutcomeFlagsForAction,
  executorSkillForAction,
  isDecisionRecord,
  recordHasAction,
  safeParseJson,
  stringOrDefault,
  stringOrNull,
  tableExists,
  timeToActionMs,
  trainingRaceDatePresent,
} from './repository';
import {
  DecisionActionResult,
  DecisionApiItem,
  DecisionApprovalLevel,
  DecisionDismissReason,
  DecisionEffectResult,
  DecisionExecutionReconciliationOutcome,
  DecisionRecord,
  DecisionRelationship,
  DecisionReplacementChoice,
  DecisionReviewOutcome,
  DurableDecisionState,
} from './types';



/** Frozen pre-rewrite execution path retained only for owner-selected emergency fallback. */
async function performDecisionActionLegacyCore(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
  opts: {
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    /** Internal-only signal set by the two-key, opted-in low-risk resolver. */
    automaticResolution?: boolean;
  } = {},
): Promise<DecisionActionResult> {
  assertScope(userId, tenantId, 'perform_decision_action', { decisionId, actionId });
  ensureDecisionCenterTables();
  reclaimExpiredExecutionLeases(userId, tenantId);
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found for authenticated user', 404);
  const idempotencyKey = opts.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision actions require an idempotency key', 400);
  }
  const requestFingerprint = decisionActionRequestFingerprint({
    decisionId,
    actionId,
    userId,
    tenantId,
    opts,
  });
  // Idempotency short-circuits BEFORE re-validating availability: a key we have already seen is replayed
  // based on its prior outcome regardless of whether the action is still "available" now. This matters for
  // a dynamically-surfaced action whose availability precondition is consumed by its own execution —
  // choose_another_time stops being injected once the agenda is reflowed — so a client retry of a write
  // that already succeeded must return the original result, not a spurious DECISION_ACTION_NOT_ALLOWED.
  const existing = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  const existingForKey = getExistingExecutionForIdempotencyKey(
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  );
  if (!existing && existingForKey) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different decision action.',
      409,
      { priorActionId: existingForKey.action_id },
    );
  }
  if (existing) assertDecisionActionReplayFingerprint(existing, requestFingerprint);
  if (existing && existing.status === 'succeeded') {
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existing);
  }
  if (existing && existing.status === 'started') {
    return waitForExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  }
  if (existing && existing.status === 'partially_failed') {
    const reconciliation = reconcilePartialDecisionExecution(record);
    const reconciled = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (reconciliation === 'applied' && reconciled?.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, reconciled);
    }
    throw executionReplayError(reconciled ?? existing, reconciliation === 'unknown'
      ? 'Prior decision action outcome still requires recovery review'
      : 'Prior decision action attempt was verified as not applied');
  }
  if (existing && existing.status === 'failed') {
    throw executionReplayError(existing, 'Prior decision action attempt failed');
  }
  if (opts.channel === 'apns' && !isDecisionActionAllowedFromApns(actionId)) {
    throw new DecisionActionError(
      'APNS_ACTION_NOT_ALLOWED',
      'This notification action must be confirmed inside Nexus before it can change source data.',
      409,
      { channel: 'apns', actionId },
    );
  }
  if (opts.contextVersion && opts.contextVersion !== decisionContextVersion(record)) {
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      currentContextVersion: decisionContextVersion(record),
    });
  }
  const actionPayload = validatedDecisionActionPayload(record, actionId, opts.payload ?? {});
  const logicalActionHash = logicalActionHashForAttempt(record, actionId, actionPayload);
  const existingLogical = getExistingLogicalExecution(userId, tenantId, logicalActionHash);
  if (existingLogical?.status === 'started') {
    logger.info({
      event: 'decision.logical_duplicate_blocked',
      decisionId,
      canonicalDecisionId: existingLogical.decision_id,
      userId,
      tenantId,
    }, 'Decision logical duplicate joined an active execution');
    return waitForExecutionById(decisionId, actionId, userId, tenantId, existingLogical.action_execution_id);
  }
  if (existingLogical?.status === 'succeeded' && actionId !== 'undo_reflow') {
    guardActionable(record, actionId);
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existingLogical);
  }
  if (existingLogical?.status === 'partially_failed') {
    throw executionReplayError(existingLogical, 'An equivalent decision action requires recovery review');
  }
  guardDecisionLifecycleMutation(record, 'perform_action', {
    allowExecution: { actionId, idempotencyKey },
  });
  // A verified replay is returned above even if the source has since changed.
  // Only genuinely new attempts are evaluated against current state.
  const supersededReason = supersedeIfSourceStateStale(record);
  if (supersededReason) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Decision context changed because the source item is no longer actionable.',
      409,
      { reason: supersededReason },
    );
  }
  // New attempt (unseen key): now validate that the action is actually available + actionable.
  const availableActions = actionsForRecord(record);
  const systemLifecycleAction: NotificationActionButton | null = actionId === 'snooze'
    ? { id: 'snooze', label: 'Snooze', style: 'secondary' }
    : actionId === 'dismiss'
      ? { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
      : null;
  const selectedAction = availableActions.find((candidate) => candidate.id === actionId) ?? systemLifecycleAction;
  if (!selectedAction) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'That action is not available for this decision', 400);
  }
  guardActionable(record, actionId);
  guardDecisionDependencies(record, actionId);
  // Direct API callers may act before the client has posted its card exposure.
  // Keep audit ordering deterministic by recording the selected preview once
  // before the execution claim.
  emitDecisionActionPreviewedIfFirst(record, actionId);

  const action = selectedAction;
  const requiresVersionClaim = MUTATING_ACTIONS.has(actionId);
  const requiresExpectedVersion = VERSIONED_DECISION_ACTIONS.has(actionId);
  if (requiresVersionClaim) {
    const approvalLevel = approvalLevelForRecord(record);
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this action.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This action requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation'
        && !hasStrongApprovalForCurrentVersion(record)) {
      throw new DecisionActionError(
        'DECISION_STRONG_CONFIRMATION_REQUIRED',
        'This high-impact action requires a current strong approval before execution.',
        409,
        { currentItem: formatDecisionItemForApi(record) },
      );
    }
    revalidateDecisionActionForExecution(record, actionId, opts.contextVersion, actionPayload);
  }
  validateExpectedDecisionVersion(record, opts.expectedVersion, requiresExpectedVersion);
  const claimed = claimExecution(
    record,
    actionId,
    idempotencyKey,
    executorSkillForAction(actionId, record),
    {
      logicalActionHash: requiresVersionClaim ? logicalActionHash : null,
      expectedVersion: opts.expectedVersion ?? record.recordVersion,
      contextVersion: decisionContextVersion(record),
      mutateRecordVersion: requiresVersionClaim,
      expectedEffect: {
        ...expectedExecutionStateForAttempt(record, actionId, actionPayload),
        idempotencyRequestFingerprint: requestFingerprint,
      },
    },
  );
  if (!claimed.isNew) {
    if (claimed.execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, claimed.execution);
    }
    if (claimed.execution.status === 'started') {
      return waitForExecutionById(decisionId, actionId, userId, tenantId, claimed.execution.action_execution_id);
    }
    throw executionReplayError(claimed.execution, 'Prior decision action attempt failed');
  }

  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_started', actionId });
  let sourceEffectCompleted = false;
  let completedExecution: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  } | null = null;
  try {
    const claimedRecord = getDecisionRecord(decisionId, userId, tenantId);
    if (!claimedRecord) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing before execution', 404);
    if (requiresVersionClaim) {
      await refreshTrainingCapacityForDecisionExecution(
        claimedRecord,
        actionId,
        claimed.execution.action_execution_id,
      );
      revalidateDecisionActionForExecution(claimedRecord, actionId, opts.contextVersion, actionPayload);
    }
    const changedReason = actionId === 'undo_reflow' ? null : sourceStateSupersessionReason(claimedRecord);
    if (changedReason) {
      throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed before execution and needs review.', 409, {
        reason: changedReason,
        recordVersion: claimedRecord.recordVersion,
      });
    }
    const execution = await executeDecisionAction(
      record,
      action,
      userId,
      tenantId,
      idempotencyKey,
      actionPayload,
      opts.expectedVersion,
      claimed.execution.action_execution_id,
    );
    completedExecution = execution;
    // From this point onward the authoritative domain executor returned after its read-back.
    // Post-success projection/audit errors must never rewrite that completed effect as failed.
    sourceEffectCompleted = true;
    markExecutionSucceeded(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      execution.expectedEffect,
      execution.actualEffect,
    );
    invalidatePlanningAfterVerifiedDecisionSourceMutation({
      actionId,
      userId,
      status: 'succeeded',
      readBackOk: execution.readBackOk,
      idempotent: false,
    });
    if (actionId === 'approve_product_learning_case'
        && record.relatedEntityType === 'product_learning_case'
        && record.relatedEntityId) {
      recordLearningCaseReviewApproval({
        tenantId,
        userId,
        caseId: record.relatedEntityId,
        actionExecutionId: claimed.execution.action_execution_id,
      });
    }
    // Post-action: format the just-actioned decision directly from its record. The active-inbox visibility
    // filter (getDecisionItem → isUserFacingDecision) must NOT apply here — a successfully actioned decision
    // belongs to handled history and must be returned as the action result even when a live re-read would
    // hide it. This matters for actions that mutate their own source state: choose_another_time moves the
    // agenda so the recomputed advice degrades and the filtered read would drop the decision, throwing a
    // spurious "Decision missing" after a write that actually succeeded.
    const updatedRecord = getDecisionRecord(decisionId, userId, tenantId);
    const updated = updatedRecord && isDecisionRecord(updatedRecord) ? formatDecisionItemForApi(updatedRecord) : null;
    if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after action execution', 500);
    try {
      recordVerifiedDecisionAction(record, action, actionId, execution);
      resolveDecisionConflictAudit(
        decisionId,
        userId,
        tenantId,
        opts.automaticResolution === true ? 'automatic_low_risk_reflow' : 'execution_succeeded',
        opts.automaticResolution === true,
      );
      emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_succeeded', actionId, toStatus: updated.status });
      if (execution.readBackOk) emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'verified', actionId });
      if (actionId === 'undo_reflow') emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'rolled_back', actionId, toStatus: updated.status });
      if (opts.automaticResolution === true) {
        emitDecisionLifecycleEvent({
          decisionId,
          userId,
          tenantId,
          event: 'auto_resolved',
          actionId,
          toStatus: updated.status,
          reason: 'persisted_user_opt_in_low_risk_reversible',
        });
      }
      if (actionId !== 'snooze'
          && execution.actualEffect.decisionOutcomeRecorded !== true) {
        recordDecisionOutcome(record, {
          actionShown: action.id,
          actionTaken: actionId,
          ...decisionOutcomeFlagsForAction(actionId, action),
          actionSucceeded: true,
          timeToActionMs: timeToActionMs(record),
        });
      }
      materializeDecisionRankSnapshotForScope(userId, tenantId);
    } catch (postSuccessError) {
      logger.error({
        event: 'decision.post_success_audit_failed',
        err: postSuccessError,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
      }, 'Decision action succeeded but post-success audit projection failed');
    }
    return {
      actionId,
      status: 'succeeded',
      idempotent: false,
      item: updated,
      verification: {
        readBackOk: execution.readBackOk,
        expectedEffect: execution.expectedEffect,
        actualEffect: execution.actualEffect,
        message: execution.message,
      },
    };
  } catch (err) {
    if (sourceEffectCompleted && completedExecution) {
      const reconciliationStatus = reconcileCompletedExecutionAfterResponseFailure(
        claimed.execution.action_execution_id,
        userId,
        tenantId,
        completedExecution,
      );
      logger.error({
        event: 'decision.post_success_response_failed',
        err,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
        reconciliationStatus,
      }, 'Decision action completed but the success response could not be finalized');
      if (reconciliationStatus === 'succeeded') {
        try {
          return idempotentActionResult(decisionId, actionId, userId, tenantId, {
            ...claimed.execution,
            status: 'succeeded',
            expected_effect_json: JSON.stringify(completedExecution.expectedEffect),
            result_json: JSON.stringify(completedExecution.actualEffect),
          });
        } catch (replayProjectionError) {
          logger.error({
            event: 'decision.post_success_replay_projection_failed',
            err: replayProjectionError,
            decisionId,
            actionId,
            actionExecutionId: claimed.execution.action_execution_id,
          }, 'Completed decision action could not be projected for the immediate replay response');
        }
      }
      throw new DecisionActionError(
        'DECISION_POST_SUCCESS_RESPONSE_FAILED',
        'The action completed, but Nexus could not finish the response. Retry with the same idempotency key.',
        500,
        {
          actionCompleted: true,
          actionExecutionId: claimed.execution.action_execution_id,
          retryWithSameIdempotencyKey: reconciliationStatus === 'succeeded',
          reconciliationStatus,
        },
      );
    }
    const error = err instanceof DecisionActionError
      ? err
      : new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action failed verification', 500, {
          ...privacySafeTransportErrorDetails(err),
          originalErrorLogged: true,
        });
    if ((actionId === 'activate_training_plan_revision'
          || actionId === 'activate_training_coach_v2_proposal')
        && isRetryableTrainingOperationDecisionError(error)
        && releaseRetryableTrainingActivationExecution(
          record,
          claimed.execution.action_execution_id,
        )) {
      logger.warn({
        event: 'decision.training_activation_lock_retryable',
        decisionId,
        actionId,
        operation: error.details?.operation,
        errorCode: error.code,
      }, 'Training activation deferred without consuming its Decision attempt');
      emitDecisionLifecycleEvent({
        decisionId,
        userId,
        tenantId,
        event: 'action_retryable',
        actionId,
        toStatus: record.status,
        reason: error.code,
      });
      throw error;
    }
    logger.error(
      { err, decisionId, actionId, userId, tenantId },
      'Decision action failed',
    );
    const failureOutcome = markExecutionFailed(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      error.code,
      error.details,
    );
    resolveDecisionConflictAudit(
      decisionId,
      userId,
      tenantId,
      failureOutcome === 'partially_failed' ? 'execution_partially_failed' : 'execution_failed',
    );
    const failureRecord = getDecisionRecord(record.itemId, record.userId, record.tenantId);
    if (failureRecord && ['unread', 'read', 'failed'].includes(failureRecord.status)) {
      markDecisionFailed(failureRecord, actionId, error.code);
    }
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: failureOutcome === 'partially_failed' ? 'action_partially_failed' : 'action_failed',
      actionId,
      reason: error.code,
    });
    recordDecisionOutcome(record, {
      actionShown: actionId,
      actionTaken: actionId,
      actionSucceeded: false,
      failedReason: error.code,
      partialFailure: failureOutcome === 'partially_failed',
      timeToActionMs: timeToActionMs(record),
    });
    throw error;
  }
}



export function decisionLifecycleMutationReceiptId(input: {
  operation: 'review' | 'edit' | 'mark_viewed';
  decisionId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
}): string {
  return `dle_command_${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}



export function isExactDecisionLifecycleMutationReplay(input: {
  receiptId: string;
  decisionId: string;
  userId: number;
  tenantId: number;
  requestFingerprint: string;
}): boolean {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson
      FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(
    input.receiptId,
    input.decisionId,
    input.userId,
    input.tenantId,
  ) as { metadataJson: string } | undefined;
  if (!row) return false;
  const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
  if (metadata.idempotencyRequestFingerprint !== input.requestFingerprint) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different Decision Center mutation.',
      409,
    );
  }
  return true;
}



export async function performDecisionAction(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
  opts: {
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    /** Internal-only signal set by the two-key, opted-in low-risk resolver. */
    automaticResolution?: boolean;
  } = {},
): Promise<DecisionActionResult> {
  const invocation = { decisionId, actionId, userId, tenantId, opts };
  const engine = createDecisionCenterEngineSelector<
    typeof invocation,
    DecisionActionResult,
    never
  >({
    active: {
      engineId: 'decision-center-rewrite-v2',
      execute: async (command) => ({
        result: await performDecisionActionCore(
          command.decisionId,
          command.actionId,
          command.userId,
          command.tenantId,
          command.opts,
        ),
        deliveryRequests: [],
      }),
    },
    legacy: {
      engineId: 'decision-center-legacy-v1',
      execute: async (command) => ({
        result: await performDecisionActionLegacyCore(
          command.decisionId,
          command.actionId,
          command.userId,
          command.tenantId,
          command.opts,
        ),
        deliveryRequests: [],
      }),
    },
    guards: {
      authorize: (command) => assertDecisionEngineInvocationAuthorized(command),
      authorizeDelivery: () => undefined,
    },
  });
  return (await engine.execute(invocation)).result;
}



/**
 * True only when this exact scoped action/idempotency tuple already owns a
 * durable execution-ledger row. APNs callers use it to distinguish safe
 * outcome reconciliation from a fresh background authorization request.
 */
export function isDecisionActionAttemptReplay(input: {
  decisionId: string;
  actionId: string;
  userId: number;
  tenantId?: number;
  idempotencyKey: string;
}): boolean {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'decision_action_attempt_replay', {
    decisionId: input.decisionId,
    actionId: input.actionId,
  });
  ensureDecisionCenterTables();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) return false;
  return getExistingExecution(
    input.decisionId,
    input.actionId,
    input.userId,
    tenantId,
    idempotencyKey,
  ) !== null;
}



export function assertDecisionEngineInvocationAuthorized(command: {
  decisionId: string;
  actionId: string;
  userId: number;
  tenantId: number;
  opts: {
    idempotencyKey?: string;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    payload?: Record<string, unknown>;
    automaticResolution?: boolean;
  };
}): void {
  assertScope(
    command.userId,
    command.tenantId,
    'perform_decision_action',
    { decisionId: command.decisionId, actionId: command.actionId },
  );
  const record = getDecisionRecord(command.decisionId, command.userId, command.tenantId);
  if (!record || !isDecisionRecord(record)) {
    throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found for authenticated user', 404);
  }
  const requestFingerprint = decisionActionRequestFingerprint(command);
  const idempotencyKey = command.opts.idempotencyKey?.trim();
  const recordedExecution = idempotencyKey
    ? getExistingExecution(
        command.decisionId,
        command.actionId,
        command.userId,
        command.tenantId,
        idempotencyKey,
      )
    : null;
  if (recordedExecution) {
    assertDecisionActionReplayFingerprint(recordedExecution, requestFingerprint);
  }
  const isRecordedReplay = typeof command.opts.idempotencyKey === 'string'
    && isDecisionActionAttemptReplay({
      decisionId: command.decisionId,
      actionId: command.actionId,
      userId: command.userId,
      tenantId: command.tenantId,
      idempotencyKey: command.opts.idempotencyKey,
    });
  if (isRecordedReplay) return;
  if (command.opts.channel === 'apns') {
    const apnsPolicy = evaluateDecisionApnsActionRequest({
      decisionId: command.decisionId,
      actionId: command.actionId,
      userId: command.userId,
      tenantId: command.tenantId,
      recordVersion: command.opts.expectedVersion ?? null,
      contextVersion: command.opts.contextVersion ?? null,
    });
    if (!apnsPolicy.execute) {
      throw new DecisionActionError(
        'APNS_ACTION_NOT_ALLOWED',
        'Open Nexus to review the current decision before acting.',
        409,
        apnsPolicy as unknown as Record<string, unknown>,
      );
    }
  }
  // Bind transport payloads to the reviewed proposal before asking for
  // approval. Invalid targeting must never be disguised as an approval gap.
  validatedDecisionActionPayload(record, command.actionId, command.opts.payload ?? {});
  if (MUTATING_ACTIONS.has(command.actionId)) {
    const approvalLevel = approvalLevelForRecord(record);
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this action.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This action requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation' && !hasStrongApprovalForCurrentVersion(record)) {
      throw new DecisionActionError(
        'DECISION_STRONG_CONFIRMATION_REQUIRED',
        'This high-impact action requires a current strong approval before execution.',
        409,
        { currentItem: formatDecisionItemForApi(record) },
      );
    }
    validateExpectedDecisionVersion(
      record,
      command.opts.expectedVersion,
      VERSIONED_DECISION_ACTIONS.has(command.actionId),
    );
  }
  // Action-specific payload binding, lifecycle, permission, and approval
  // checks run inside the selected engine before any execution claim. Keeping
  // them there preserves deterministic validation order (an untrusted payload
  // cannot be hidden behind an approval response) while this shared selector
  // guard remains responsible for scoped access and APNs delivery policy.
}



async function performDecisionActionCore(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  opts: {
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    automaticResolution?: boolean;
  },
): Promise<DecisionActionResult> {
  assertScope(userId, tenantId, 'perform_decision_action', { decisionId, actionId });
  ensureDecisionCenterTables();
  reclaimExpiredExecutionLeases(userId, tenantId);
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found for authenticated user', 404);
  const idempotencyKey = opts.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision actions require an idempotency key', 400);
  }
  const requestFingerprint = decisionActionRequestFingerprint({
    decisionId,
    actionId,
    userId,
    tenantId,
    opts,
  });
  // A known key is replayed before any current-state authorization check.
  // That cannot create a new logical write: the durable ledger row binds the
  // exact scope, decision, action, and key to its original outcome.
  const existing = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  const existingForKey = getExistingExecutionForIdempotencyKey(
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  );
  if (!existing && existingForKey) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different decision action.',
      409,
      { priorActionId: existingForKey.action_id },
    );
  }
  if (existing) assertDecisionActionReplayFingerprint(existing, requestFingerprint);
  if (existing && existing.status === 'succeeded') {
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existing);
  }
  if (existing && existing.status === 'started') {
    return waitForExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  }
  if (existing && existing.status === 'partially_failed') {
    const reconciliation = reconcilePartialDecisionExecution(record);
    const reconciled = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (reconciliation === 'applied' && reconciled?.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, reconciled);
    }
    throw executionReplayError(reconciled ?? existing, reconciliation === 'unknown'
      ? 'Prior decision action outcome still requires recovery review'
      : 'Prior decision action attempt was verified as not applied');
  }
  if (existing && existing.status === 'failed') {
    throw executionReplayError(existing, 'Prior decision action attempt failed');
  }
  if (opts.channel === 'apns') {
    const apnsPolicy = evaluateDecisionApnsActionRequest({
      decisionId,
      actionId,
      userId,
      tenantId,
      recordVersion: opts.expectedVersion ?? null,
      contextVersion: opts.contextVersion ?? null,
    });
    if (!apnsPolicy.execute) {
      throw new DecisionActionError(
        'APNS_ACTION_NOT_ALLOWED',
        'Open Nexus to review the current decision before acting.',
        409,
        apnsPolicy as unknown as Record<string, unknown>,
      );
    }
  }
  if (opts.contextVersion && opts.contextVersion !== decisionContextVersion(record)) {
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      currentContextVersion: decisionContextVersion(record),
    });
  }
  const actionPayload = validatedDecisionActionPayload(record, actionId, opts.payload ?? {});
  const logicalActionHash = logicalActionHashForAttempt(record, actionId, actionPayload);
  const existingLogical = getExistingLogicalExecution(userId, tenantId, logicalActionHash);
  if (existingLogical?.status === 'started') {
    logger.info({
      event: 'decision.logical_duplicate_blocked',
      decisionId,
      canonicalDecisionId: existingLogical.decision_id,
      userId,
      tenantId,
    }, 'Decision logical duplicate joined an active execution');
    return waitForExecutionById(decisionId, actionId, userId, tenantId, existingLogical.action_execution_id);
  }
  if (existingLogical?.status === 'succeeded' && actionId !== 'undo_reflow') {
    guardActionable(record, actionId);
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existingLogical);
  }
  if (existingLogical?.status === 'partially_failed') {
    throw executionReplayError(existingLogical, 'An equivalent decision action requires recovery review');
  }
  guardDecisionLifecycleMutation(record, 'perform_action', {
    allowExecution: { actionId, idempotencyKey },
  });
  // A verified replay is returned above even if the source has since changed.
  // Only genuinely new attempts are evaluated against current state.
  const supersededReason = supersedeIfSourceStateStale(record);
  if (supersededReason) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Decision context changed because the source item is no longer actionable.',
      409,
      { reason: supersededReason },
    );
  }
  // New attempt (unseen key): now validate that the action is actually available + actionable.
  const availableActions = actionsForRecord(record);
  const systemLifecycleAction: NotificationActionButton | null = actionId === 'snooze'
    ? { id: 'snooze', label: 'Snooze', style: 'secondary' }
    : actionId === 'dismiss'
      ? { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
      : null;
  const selectedAction = availableActions.find((candidate) => candidate.id === actionId) ?? systemLifecycleAction;
  if (!selectedAction) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'That action is not available for this decision', 400);
  }
  guardActionable(record, actionId);
  guardDecisionDependencies(record, actionId);
  // Direct API callers may act before the client has posted its card exposure.
  // Keep audit ordering deterministic by recording the selected preview once
  // before the execution claim.
  emitDecisionActionPreviewedIfFirst(record, actionId);

  const action = selectedAction;
  const requiresVersionClaim = MUTATING_ACTIONS.has(actionId);
  const requiresExpectedVersion = VERSIONED_DECISION_ACTIONS.has(actionId);
  if (requiresVersionClaim) {
    const approvalLevel = approvalLevelForRecord(record);
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this action.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This action requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation'
        && !hasStrongApprovalForCurrentVersion(record)) {
      throw new DecisionActionError(
        'DECISION_STRONG_CONFIRMATION_REQUIRED',
        'This high-impact action requires a current strong approval before execution.',
        409,
        { currentItem: formatDecisionItemForApi(record) },
      );
    }
    revalidateDecisionActionForExecution(record, actionId, opts.contextVersion, actionPayload);
  }
  validateExpectedDecisionVersion(record, opts.expectedVersion, requiresExpectedVersion);
  const command = buildDecisionActionMutationCommand(record, actionId, actionPayload, {
    idempotencyKey,
    channel: opts.automaticResolution === true ? 'automation' : opts.channel,
    recordVersion: opts.expectedVersion,
    contextVersion: opts.contextVersion,
  });
  const commandExpectedEffect = {
    ...command.readback.expectedState,
    idempotencyRequestFingerprint: requestFingerprint,
    commandContract: {
      schemaVersion: command.schemaVersion,
      commandId: command.commandId,
      scope: command.scope,
      channel: command.channel,
      recordVersion: command.recordVersion,
      contextVersion: command.contextVersion,
      approval: command.approval,
      execution: command.execution,
      readback: {
        verifierId: command.readback.verifierId,
        entityType: command.readback.entityType,
        entityId: command.readback.entityId,
        mode: command.readback.mode,
      },
    },
  };
  const claimed = claimExecution(
    record,
    actionId,
    idempotencyKey,
    executorSkillForAction(actionId, record),
    {
      logicalActionHash: requiresVersionClaim ? logicalActionHash : null,
      expectedVersion: opts.expectedVersion ?? record.recordVersion,
      contextVersion: decisionContextVersion(record),
      mutateRecordVersion: requiresVersionClaim,
      expectedEffect: commandExpectedEffect,
    },
  );
  if (!claimed.isNew) {
    if (claimed.execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, claimed.execution);
    }
    if (claimed.execution.status === 'started') {
      return waitForExecutionById(decisionId, actionId, userId, tenantId, claimed.execution.action_execution_id);
    }
    throw executionReplayError(claimed.execution, 'Prior decision action attempt failed');
  }

  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_started', actionId });
  let sourceEffectCompleted = false;
  let completedExecution: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  } | null = null;
  try {
    const claimedRecord = getDecisionRecord(decisionId, userId, tenantId);
    if (!claimedRecord) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing before execution', 404);
    if (requiresVersionClaim) {
      await refreshTrainingCapacityForDecisionExecution(
        claimedRecord,
        actionId,
        claimed.execution.action_execution_id,
      );
      revalidateDecisionActionForExecution(claimedRecord, actionId, opts.contextVersion, actionPayload);
    }
    const changedReason = actionId === 'undo_reflow' ? null : sourceStateSupersessionReason(claimedRecord);
    if (changedReason) {
      throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed before execution and needs review.', 409, {
        reason: changedReason,
        recordVersion: claimedRecord.recordVersion,
      });
    }
    const execution = await executeDecisionMutationCommand(
      record,
      action,
      command,
      claimed.execution.action_execution_id,
    );
    completedExecution = execution;
    // From this point onward the authoritative domain executor returned after its read-back.
    // Post-success projection/audit errors must never rewrite that completed effect as failed.
    sourceEffectCompleted = true;
    markExecutionSucceeded(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      execution.expectedEffect,
      execution.actualEffect,
    );
    invalidatePlanningAfterVerifiedDecisionSourceMutation({
      actionId,
      userId,
      status: 'succeeded',
      readBackOk: execution.readBackOk,
      idempotent: false,
    });
    if (actionId === 'approve_product_learning_case'
        && record.relatedEntityType === 'product_learning_case'
        && record.relatedEntityId) {
      recordLearningCaseReviewApproval({
        tenantId,
        userId,
        caseId: record.relatedEntityId,
        actionExecutionId: claimed.execution.action_execution_id,
      });
    }
    // Post-action: format the just-actioned decision directly from its record. The active-inbox visibility
    // filter (getDecisionItem → isUserFacingDecision) must NOT apply here — a successfully actioned decision
    // belongs to handled history and must be returned as the action result even when a live re-read would
    // hide it. This matters for actions that mutate their own source state: choose_another_time moves the
    // agenda so the recomputed advice degrades and the filtered read would drop the decision, throwing a
    // spurious "Decision missing" after a write that actually succeeded.
    const updatedRecord = getDecisionRecord(decisionId, userId, tenantId);
    const updated = updatedRecord && isDecisionRecord(updatedRecord) ? formatDecisionItemForApi(updatedRecord) : null;
    if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after action execution', 500);
    try {
      recordVerifiedDecisionAction(record, action, actionId, execution);
      resolveDecisionConflictAudit(
        decisionId,
        userId,
        tenantId,
        opts.automaticResolution === true ? 'automatic_low_risk_reflow' : 'execution_succeeded',
        opts.automaticResolution === true,
      );
      emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'action_succeeded', actionId, toStatus: updated.status });
      if (execution.readBackOk) emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'verified', actionId });
      if (actionId === 'undo_reflow') emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'rolled_back', actionId, toStatus: updated.status });
      if (opts.automaticResolution === true) {
        emitDecisionLifecycleEvent({
          decisionId,
          userId,
          tenantId,
          event: 'auto_resolved',
          actionId,
          toStatus: updated.status,
          reason: 'persisted_user_opt_in_low_risk_reversible',
        });
      }
      if (actionId !== 'snooze'
          && execution.actualEffect.decisionOutcomeRecorded !== true) {
        recordDecisionOutcome(record, {
          actionShown: action.id,
          actionTaken: actionId,
          ...decisionOutcomeFlagsForAction(actionId, action),
          actionSucceeded: true,
          timeToActionMs: timeToActionMs(record),
        });
      }
      materializeDecisionRankSnapshotForScope(userId, tenantId);
    } catch (postSuccessError) {
      logger.error({
        event: 'decision.post_success_audit_failed',
        err: postSuccessError,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
      }, 'Decision action succeeded but post-success audit projection failed');
    }
    return {
      actionId,
      status: 'succeeded',
      idempotent: false,
      item: updated,
      verification: {
        readBackOk: execution.readBackOk,
        expectedEffect: execution.expectedEffect,
        actualEffect: execution.actualEffect,
        message: execution.message,
      },
    };
  } catch (err) {
    if (sourceEffectCompleted && completedExecution) {
      const reconciliationStatus = reconcileCompletedExecutionAfterResponseFailure(
        claimed.execution.action_execution_id,
        userId,
        tenantId,
        completedExecution,
      );
      logger.error({
        event: 'decision.post_success_response_failed',
        err,
        decisionId,
        actionId,
        userId,
        tenantId,
        actionExecutionId: claimed.execution.action_execution_id,
        reconciliationStatus,
      }, 'Decision action completed but the success response could not be finalized');
      if (reconciliationStatus === 'succeeded') {
        try {
          return idempotentActionResult(decisionId, actionId, userId, tenantId, {
            ...claimed.execution,
            status: 'succeeded',
            expected_effect_json: JSON.stringify(completedExecution.expectedEffect),
            result_json: JSON.stringify(completedExecution.actualEffect),
          });
        } catch (replayProjectionError) {
          logger.error({
            event: 'decision.post_success_replay_projection_failed',
            err: replayProjectionError,
            decisionId,
            actionId,
            actionExecutionId: claimed.execution.action_execution_id,
          }, 'Completed decision action could not be projected for the immediate replay response');
        }
      }
      throw new DecisionActionError(
        'DECISION_POST_SUCCESS_RESPONSE_FAILED',
        'The action completed, but Nexus could not finish the response. Retry with the same idempotency key.',
        500,
        {
          actionCompleted: true,
          actionExecutionId: claimed.execution.action_execution_id,
          retryWithSameIdempotencyKey: reconciliationStatus === 'succeeded',
          reconciliationStatus,
        },
      );
    }
    const error = err instanceof DecisionActionError
      ? err
      : new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action failed verification', 500, {
          ...privacySafeTransportErrorDetails(err),
          originalErrorLogged: true,
        });
    if ((actionId === 'activate_training_plan_revision'
          || actionId === 'activate_training_coach_v2_proposal')
        && isRetryableTrainingOperationDecisionError(error)
        && releaseRetryableTrainingActivationExecution(
          record,
          claimed.execution.action_execution_id,
        )) {
      logger.warn({
        event: 'decision.training_activation_lock_retryable',
        decisionId,
        actionId,
        operation: error.details?.operation,
        errorCode: error.code,
      }, 'Training activation deferred without consuming its Decision attempt');
      emitDecisionLifecycleEvent({
        decisionId,
        userId,
        tenantId,
        event: 'action_retryable',
        actionId,
        toStatus: record.status,
        reason: error.code,
      });
      throw error;
    }
    logger.error(
      { err, decisionId, actionId, userId, tenantId },
      'Decision action failed',
    );
    const failureOutcome = markExecutionFailed(
      claimed.execution.action_execution_id,
      userId,
      tenantId,
      error.code,
      error.details,
    );
    resolveDecisionConflictAudit(
      decisionId,
      userId,
      tenantId,
      failureOutcome === 'partially_failed' ? 'execution_partially_failed' : 'execution_failed',
    );
    const failureRecord = getDecisionRecord(record.itemId, record.userId, record.tenantId);
    if (failureRecord && ['unread', 'read', 'failed'].includes(failureRecord.status)) {
      markDecisionFailed(failureRecord, actionId, error.code);
    }
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: failureOutcome === 'partially_failed' ? 'action_partially_failed' : 'action_failed',
      actionId,
      reason: error.code,
    });
    recordDecisionOutcome(record, {
      actionShown: actionId,
      actionTaken: actionId,
      actionSucceeded: false,
      failedReason: error.code,
      partialFailure: failureOutcome === 'partially_failed',
      timeToActionMs: timeToActionMs(record),
    });
    throw error;
  }
}



export function reviewDecision(
  decisionId: string,
  userId: number,
  tenantId: number,
  input: {
    outcome: DecisionReviewOutcome;
    expectedVersion?: number;
    idempotencyKey?: string;
    deferUntil?: string;
    reasonCode?: string;
    replacementChoiceId?: DecisionReplacementChoice;
    channel?: string;
    strongConfirmationText?: string;
  },
): DecisionApiItem {
  assertScope(userId, tenantId, 'review_decision', { decisionId });
  ensureDecisionCenterTables();
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision reviews require an idempotency key', 400);
  }
  if (input.expectedVersion == null) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'Decision reviews require the current record version', 428);
  }
  const expectedVersion = input.expectedVersion;
  const reviewAttemptHash = logicalActionAttemptHash(`review:${decisionId}`, input.outcome, {
    expectedVersion,
    idempotencyKey,
    deferUntil: input.deferUntil ?? null,
    reasonCode: input.reasonCode ?? null,
    replacementChoiceId: input.replacementChoiceId ?? null,
    strongConfirmation: input.strongConfirmationText === 'CONFIRM',
  });
  const legacyReviewReceiptId = `dle_review_${reviewAttemptHash}`;
  const reviewReceiptId = decisionLifecycleMutationReceiptId({
    operation: 'review',
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  });
  const prior = isExactDecisionLifecycleMutationReplay({
    receiptId: reviewReceiptId,
    decisionId,
    userId,
    tenantId,
    requestFingerprint: reviewAttemptHash,
  }) || Boolean(getDb().prepare(`
    SELECT 1 FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(legacyReviewReceiptId, decisionId, userId, tenantId));
  if (prior) {
    const replay = getDecisionRecord(decisionId, userId, tenantId);
    if (!replay) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
    return formatDecisionItemForApi(replay);
  }
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!(record && (
    decisionFlowV1EnforcedForRecord(record)
    || approvalLevelForRecord(record) === 'strong_confirmation'
  ))) {
    throw new DecisionActionError('DECISION_REVIEW_UNAVAILABLE', 'Versioned decision review is not enabled for this account.', 409);
  }
  guardDecisionLifecycleMutation(record, `review_${input.outcome}`);
  const approvalLevel = approvalLevelForRecord(record);
  if (input.outcome === 'approve') {
    if (approvalLevel === 'none') {
      throw new DecisionActionError(
        'DECISION_REVIEW_NOT_APPLICABLE',
        'This item is review-only and cannot be approved for execution',
        409,
      );
    }
    if (approvalLevel === 'unavailable') {
      throw new DecisionActionError('DECISION_PERMISSION_REQUIRED', 'Current permissions do not allow this proposal to be approved.', 403);
    }
    if (approvalLevel === 'admin_review') {
      throw new DecisionActionError('DECISION_ADMIN_REVIEW_REQUIRED', 'This proposal requires an authorized administrator review.', 403);
    }
    if (approvalLevel === 'strong_confirmation' && input.strongConfirmationText !== 'CONFIRM') {
      throw new DecisionActionError('DECISION_STRONG_CONFIRMATION_REQUIRED', 'Type CONFIRM to approve this high-impact proposal.', 409);
    }
    const currentState = durableDecisionStateForRecord(record);
    if (currentState !== 'ready_for_review' && currentState !== 'proposed') {
      throw new DecisionActionError('DECISION_TRANSITION_NOT_ALLOWED', 'This decision is not ready for approval.', 409, {
        decisionState: currentState,
        currentItem: formatDecisionItemForApi(record),
      });
    }
    const dependencyState = dependencyStateForRecord(record);
    if (dependencyState.blockedByDecisionIds.length > 0) {
      throw new DecisionActionError('DECISION_DEPENDENCY_BLOCKED', 'Resolve blocking decisions before approval.', 409, {
        blockedByDecisionIds: dependencyState.blockedByDecisionIds,
      });
    }
  }
  if (!reviewSupportedForRecord(record)) {
    throw new DecisionActionError(
      'DECISION_REVIEW_NOT_SUPPORTED',
      'This decision does not support the versioned review workflow.',
      409,
      { currentItem: formatDecisionItemForApi(record) },
    );
  }
  validateExpectedDecisionVersion(record, expectedVersion, true);
  guardActionable(record, 'review');
  if (input.outcome === 'approve') {
    const storedConflict = decisionContextForRecord(record).conflictEvaluation;
    const requiresReplacementChoice = storedConflict?.findings.some((finding) => finding.class === 'approved_commitment') === true;
    if (requiresReplacementChoice && input.replacementChoiceId !== 'replace_with_candidate') {
      throw new DecisionActionError(
        'DECISION_REPLACEMENT_CONFIRMATION_REQUIRED',
        'Choose the proposed replacement explicitly before approving it.',
        409,
        {
          contextVersion: decisionContextVersion(record),
          alternatives: storedConflict?.alternatives ?? [],
        },
      );
    }
    revalidateDecisionContext(record, decisionContextVersion(record) ?? undefined, {
      confirmationGranted: true,
      replacementApproved: input.replacementChoiceId === 'replace_with_candidate',
    });
  }
  const reasonCode = normalizeClosedReasonCode(input.reasonCode);
  const nextState: DurableDecisionState = input.outcome === 'approve'
    ? 'approved'
    : input.outcome === 'reject'
      ? 'rejected'
      : 'deferred';
  const explicitDeferUntil = input.outcome === 'defer' && input.deferUntil != null
    ? normalizeFutureTimestamp(input.deferUntil)
    : null;
  if (input.outcome === 'defer' && input.deferUntil != null && !explicitDeferUntil) {
    throw new DecisionActionError(
      'DECISION_DEFER_UNTIL_INVALID',
      'deferUntil must be a valid future ISO timestamp.',
      400,
      { field: 'deferUntil' },
    );
  }
  const deferUntil = input.outcome === 'defer'
    ? explicitDeferUntil ?? DateTime.utc().plus({ days: 1 }).toISO()
    : null;
  const nextLegacyStatus = input.outcome === 'reject' ? 'dismissed'
    : input.outcome === 'defer' ? 'snoozed'
      : record.status === 'unread' ? 'read' : record.status;
  const requestedAt = appNowIso();
  const reviewCommand = createDecisionMutationCommand({
    commandId: `dmc_${reviewAttemptHash}`,
    decisionId,
    operation: 'review',
    actionId: `review:${input.outcome}`,
    scope: { userId, tenantId },
    channel: normalizeDecisionMutationChannel(input.channel),
    idempotencyKey,
    recordVersion: expectedVersion,
    contextVersion: decisionContextVersion(record),
    approval: input.outcome === 'approve'
      ? {
          requiredLevel: approvalLevel === 'strong_confirmation' ? 'strong_confirmation' : 'user_confirmation',
          evidence: {
            level: approvalLevel === 'strong_confirmation' ? 'strong_confirmation' : 'user_confirmation',
            actorUserId: userId,
            confirmedAt: requestedAt,
            evidenceRef: `decision-review:${createHash('sha256').update(JSON.stringify({
              decisionId,
              expectedVersion,
              idempotencyKey,
              strength: approvalLevel === 'strong_confirmation' ? 'strong' : 'standard',
            })).digest('hex').slice(0, 32)}`,
          },
        }
      : { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision.review',
      strategy: 'synchronous',
      riskLevel: approvalLevel === 'strong_confirmation' ? 'high' : 'low',
      reversible: input.outcome === 'defer',
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision.state',
      entityType: 'notification_center_item',
      entityId: decisionId,
      mode: 'versioned',
      expectedState: {
        decisionState: nextState,
        status: nextLegacyStatus,
        ...(deferUntil ? { deferUntil } : {}),
      },
    },
    payload: {
      outcome: input.outcome,
      ...(reasonCode ? { reasonCode } : {}),
      ...(input.replacementChoiceId ? { replacementChoiceId: input.replacementChoiceId } : {}),
      ...(deferUntil ? { deferUntil } : {}),
    },
    requestedAt,
  });

  getDb().transaction(() => {
    const update = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = ?,
             snoozed_until = CASE WHEN ? = 'deferred' THEN ? ELSE snoozed_until END,
             dismissed_at = CASE WHEN ? = 'rejected' THEN datetime('now') ELSE dismissed_at END,
             record_version = record_version + 1,
             updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(
      nextState,
      nextLegacyStatus,
      nextState,
      deferUntil,
      nextState,
      decisionId,
      userId,
      tenantId,
      expectedVersion,
    );
    if (update.changes !== 1) {
      const wonByReplay = isExactDecisionLifecycleMutationReplay({
        receiptId: reviewReceiptId,
        decisionId,
        userId,
        tenantId,
        requestFingerprint: reviewAttemptHash,
      }) || Boolean(getDb().prepare(`
        SELECT 1 FROM decision_lifecycle_events
         WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(legacyReviewReceiptId, decisionId, userId, tenantId));
      if (wonByReplay) return;
      const current = getDecisionRecord(decisionId, userId, tenantId);
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed before the review was recorded.',
        409,
        decisionVersionConflictDetails(current),
      );
    }
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewReceiptId,
      decisionId,
      userId,
      tenantId,
      input.outcome === 'approve' ? 'approved' : input.outcome === 'reject' ? 'rejected' : 'deferred',
      nextState,
      `review:${reviewAttemptHash}`,
      reasonCode,
      JSON.stringify({
        previousVersion: expectedVersion,
        nextVersion: expectedVersion + 1,
        contextVersion: decisionContextVersion(record),
        replacementChoiceId: input.replacementChoiceId ?? null,
        confirmationStrength: approvalLevel === 'strong_confirmation' ? 'strong' : 'standard',
        idempotencyRequestFingerprint: reviewAttemptHash,
        commandContract: reviewCommand,
      }),
    );
    if (input.outcome === 'reject'
        && record.sourceSkill === 'training'
        && record.relatedEntityType === 'training_plan_revision'
        && record.relatedEntityId
        && tableExists('training_plan_revisions')) {
      getDb().prepare(`
        UPDATE training_plan_revisions
           SET lifecycle_state = 'EXPIRED', approval_state = 'REJECTED',
               expired_at = datetime('now')
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
           AND decision_id = ? AND lifecycle_state = 'PENDING_REVIEW'
           AND approval_state = 'PENDING'
      `).run(record.relatedEntityId, userId, tenantId, decisionId);
    }
    syncTrainingAdaptationProposalForDecisionState(
      getDb(),
      decisionId,
      userId,
      tenantId,
      input.outcome === 'reject' ? 'REJECTED' : input.outcome === 'defer' ? 'DEFERRED' : 'PENDING_REVIEW',
    );
    resolveDecisionConflictAudit(decisionId, userId, tenantId, `review_${input.outcome}`);
    materializeDecisionRankSnapshotForScope(userId, tenantId);
  })();

  const updated = getDecisionRecord(decisionId, userId, tenantId);
  if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after review', 500);
  return formatDecisionItemForApi(updated);
}



export function reviseDecisionProposal(
  decisionId: string,
  userId: number,
  tenantId: number,
  input: {
    expectedVersion?: number;
    idempotencyKey?: string;
    channel?: string;
    recommendedStartAt?: string;
    recommendedEndAt?: string;
  },
): DecisionApiItem {
  assertScope(userId, tenantId, 'revise_decision_proposal', { decisionId });
  ensureDecisionCenterTables();
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Proposal edits require an idempotency key', 400);
  }
  if (input.expectedVersion == null) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'Proposal edits require the current record version', 428);
  }
  const expectedVersion = input.expectedVersion;
  const editAttemptHash = logicalActionAttemptHash(`edit:${decisionId}`, 'edit_proposal', {
    expectedVersion,
    idempotencyKey,
    recommendedStartAt: input.recommendedStartAt ?? null,
    recommendedEndAt: input.recommendedEndAt ?? null,
  });
  const legacyEditReceiptId = `dle_edit_${editAttemptHash}`;
  const editReceiptId = decisionLifecycleMutationReceiptId({
    operation: 'edit',
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  });
  const prior = isExactDecisionLifecycleMutationReplay({
    receiptId: editReceiptId,
    decisionId,
    userId,
    tenantId,
    requestFingerprint: editAttemptHash,
  }) || Boolean(getDb().prepare(`
    SELECT 1 FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(legacyEditReceiptId, decisionId, userId, tenantId));
  if (prior) {
    const replay = getDecisionRecord(decisionId, userId, tenantId);
    if (!replay) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
    return formatDecisionItemForApi(replay);
  }
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!(record && decisionFlowV1EnforcedForRecord(record))) {
    throw new DecisionActionError('DECISION_EDIT_UNAVAILABLE', 'Versioned proposal editing is not enabled for this account.', 409);
  }
  guardDecisionLifecycleMutation(record, 'edit_proposal');
  validateExpectedDecisionVersion(record, expectedVersion, true);
  guardActionable(record, 'edit_proposal');

  const context = decisionContextForRecord(record);
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action) throw new DecisionActionError('DECISION_EDIT_UNSUPPORTED', 'This proposal does not support structured edits.', 409);
  if (editableProposalFieldsForRecord(record).length === 0) {
    throw new DecisionActionError(
      'DECISION_EDIT_UNSUPPORTED',
      'This proposal type is not allowlisted for structured edits.',
      409,
    );
  }
  const start = normalizeTimestamp(input.recommendedStartAt ?? context.recommendedStartAt);
  const end = normalizeTimestamp(input.recommendedEndAt ?? context.recommendedEndAt);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) {
    throw new DecisionActionError('DECISION_EDIT_INVALID', 'Proposal edit requires a valid start and end window.', 400);
  }
  const contextVersion = `ctx_revision_${expectedVersion + 1}_${Date.now()}`;
  const revisedAction = buildNormalizedDecisionAction({
    intent: action.intent,
    targetEntities: action.targetEntities,
    affectedResources: action.affectedResources,
    requestedWindow: { start, end, timezone: action.requestedWindow?.timezone ?? context.timezone ?? 'UTC' },
    preconditions: action.preconditions,
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    dependencies: action.dependencies,
    exclusivityKeys: action.exclusivityKeys,
    authorizationScope: action.authorizationScope,
    risk: action.risk,
    reversibility: action.reversibility,
    contextVersion,
  });
  const conflictMode = getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId });
  const flowEnforced = decisionFlowV1EnforcedForRecord(record);
  const revisedRevalidation = conflictMode === 'off' && !flowEnforced ? null : revalidateNormalizedDecisionAction({
    scope: { userId, tenantId },
    action: revisedAction,
    decisionId,
    additionalExisting: context.conflictComparisons ?? undefined,
    contextExpiresAt: decisionContextExpiresAt(record),
    candidateCreatedAt: appNowIso(),
    confidence: context.candidateConfidence ?? undefined,
  });
  const revisedConflict = revisedRevalidation?.conflictEvaluation ?? null;
  const nextDecisionState = conflictMode === 'active' || flowEnforced
    ? decisionStateForConflictEvaluation(revisedConflict)
    : 'ready_for_review';
  const revisedContext: DecisionLogicContext = {
    ...context,
    recommendedStartAt: start,
    recommendedEndAt: end,
    normalizedAction: revisedAction,
    conflictEvaluation: conflictMode === 'active' || flowEnforced ? revisedConflict : null,
    reasonCodes: [...new Set([...(context.reasonCodes ?? []), 'user_revised_proposal'])],
  };
  const proposalRisk = revisedAction.risk === 'critical' || revisedAction.risk === 'high'
    ? 'high'
    : revisedAction.risk === 'medium'
      ? 'medium'
      : 'low';
  const proposalCommand = createDecisionMutationCommand({
    commandId: `dmc_${editAttemptHash}`,
    decisionId,
    operation: 'edit',
    actionId: 'edit_proposal',
    scope: { userId, tenantId },
    channel: normalizeDecisionMutationChannel(input.channel),
    idempotencyKey,
    recordVersion: expectedVersion,
    contextVersion,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision.edit_proposal',
      strategy: 'synchronous',
      riskLevel: proposalRisk,
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision.proposal_window',
      entityType: record.relatedEntityType ?? 'notification_center_item',
      entityId: record.relatedEntityId ?? decisionId,
      mode: 'versioned',
      expectedState: {
        contextVersion,
        recommendedStartAt: start,
        recommendedEndAt: end,
        decisionState: nextDecisionState,
      },
    },
    payload: { recommendedStartAt: start, recommendedEndAt: end },
    requestedAt: appNowIso(),
  });

  getDb().transaction(() => {
    const update = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             record_version = record_version + 1,
             updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(nextDecisionState, decisionId, userId, tenantId, expectedVersion);
    if (update.changes !== 1) {
      const wonByReplay = isExactDecisionLifecycleMutationReplay({
        receiptId: editReceiptId,
        decisionId,
        userId,
        tenantId,
        requestFingerprint: editAttemptHash,
      }) || Boolean(getDb().prepare(`
        SELECT 1 FROM decision_lifecycle_events
         WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(legacyEditReceiptId, decisionId, userId, tenantId));
      if (wonByReplay) return;
      const current = getDecisionRecord(decisionId, userId, tenantId);
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed before the proposal edit was saved.',
        409,
        decisionVersionConflictDetails(current),
      );
    }
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET decision_context_json = ?, context_version = ?, context_observed_at = ?,
             candidate_fingerprint = ?, normalized_action_json = ?
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(
      JSON.stringify(revisedContext),
      contextVersion,
      appNowIso(),
      revisedAction.candidateFingerprint,
      JSON.stringify(revisedAction),
      record.intentId,
      userId,
      tenantId,
    );
    if (intentUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Proposal source row was not updated.', 409);
    }
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, 'revised', ?, ?, NULL, ?)
    `).run(
      editReceiptId,
      decisionId,
      userId,
      tenantId,
      nextDecisionState,
      `edit:${editAttemptHash}`,
      JSON.stringify({
        previousVersion: expectedVersion,
        nextVersion: expectedVersion + 1,
        fields: ['recommended_window'],
        idempotencyRequestFingerprint: editAttemptHash,
        commandContract: proposalCommand,
      }),
    );
    resolveDecisionConflictAudit(decisionId, userId, tenantId, 'proposal_revised');
    if (revisedConflict) recordDecisionConflictEvaluation(record, revisedConflict);
    materializeDecisionRankSnapshotForScope(userId, tenantId);
  })();
  const updated = getDecisionRecord(decisionId, userId, tenantId);
  if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after proposal edit', 500);
  return formatDecisionItemForApi(updated);
}



export function editableProposalFieldsForRecord(record: DecisionRecord): string[] {
  const context = decisionContextForRecord(record);
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action || approvalLevelForRecord(record) === 'none') return [];
  const editableSecretaryReflow = record.sourceSkill === 'secretary'
    && record.relatedEntityType === 'secretary_agenda_item'
    && context.recipe === 'secretary_reflow_window_v1'
    && action.requestedWindow != null
    && action.affectedResources.some((resource) => resource.type === 'calendar_timeline')
    && /reflow|reschedule/.test(action.intent);
  return editableSecretaryReflow ? ['recommendedStartAt', 'recommendedEndAt'] : [];
}



export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}



export function normalizeFutureTimestamp(value: unknown): string | null {
  const normalized = normalizeTimestamp(value);
  return normalized && Date.parse(normalized) > Date.now() ? normalized : null;
}



export function normalizeClosedReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : 'other';
}



export function snoozeDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
  minutes = 60,
  expectedVersion?: number,
  activeExecution?: { actionId: string; idempotencyKey: string },
): DecisionApiItem {
  const deferUntil = DateTime.utc()
    .plus({ minutes: Math.min(Math.max(minutes, 5), 10_080) })
    .toISO()!;
  return snoozeDecisionAt(
    decisionId,
    userId,
    tenantId,
    deferUntil,
    expectedVersion,
    activeExecution,
  );
}



export function snoozeDecisionAt(
  decisionId: string,
  userId: number,
  tenantId: number,
  deferUntil: string,
  expectedVersion?: number,
  activeExecution?: { actionId: string; idempotencyKey: string },
): DecisionApiItem {
  assertScope(userId, tenantId, 'snooze_decision', { decisionId });
  ensureDecisionCenterTables();
  const before = getDecisionRecord(decisionId, userId, tenantId);
  if (!before) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  guardDecisionLifecycleMutation(before, 'snooze', { allowExecution: activeExecution });
  // Unified command executions already require an explicit record version.
  // Keep the exported legacy service signature additive for older callers:
  // direct snooze calls still use the row version captured by this function.
  validateExpectedDecisionVersion(before, expectedVersion, activeExecution != null);
  const until = normalizeFutureTimestamp(deferUntil);
  if (!until) {
    throw new DecisionActionError(
      'DECISION_DEFER_UNTIL_NOT_FUTURE',
      'deferUntil must be a valid future ISO timestamp.',
      409,
      { field: 'deferUntil' },
    );
  }
  const update = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'snoozed', decision_state = 'deferred', snoozed_until = ?,
           read_at = COALESCE(read_at, datetime('now')),
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND record_version = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(until, decisionId, userId, tenantId, expectedVersion ?? before.recordVersion);
  if (update.changes !== 1) {
    const current = getDecisionRecord(decisionId, userId, tenantId);
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed before it could be snoozed.',
      409,
      decisionVersionConflictDetails(current),
    );
  }
  syncTrainingAdaptationProposalForDecisionState(
    getDb(), decisionId, userId, tenantId, 'DEFERRED',
  );
  const item = getDecisionItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after snooze', 404);
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'snoozed', toStatus: item.status });
  resolveDecisionConflictAudit(decisionId, userId, tenantId, 'deferred');
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'snooze',
      actionTaken: 'snooze',
      snoozed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
  if (!activeExecution) materializeDecisionRankSnapshotForScope(userId, tenantId);
  return item;
}



/** Closed vocabulary for dismiss feedback (C3) — never store free user text; unknown → 'other'. */
export const DECISION_DISMISS_REASONS = ['already_handled', 'not_relevant', 'wrong_data', 'bad_timing', 'too_risky', 'duplicate', 'dont_show_type', 'other'] as const;



export function normalizeDismissReason(reason?: string | null): DecisionDismissReason | null {
  if (reason == null || reason.trim() === '') return null;
  const value = reason.trim().toLowerCase();
  return (DECISION_DISMISS_REASONS as readonly string[]).includes(value) ? (value as DecisionDismissReason) : 'other';
}



export function dismissDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
  reason?: string,
  expectedVersion?: number,
  activeExecution?: { actionId: string; idempotencyKey: string },
): DecisionApiItem {
  const before = getDecisionRecord(decisionId, userId, tenantId);
  if (!before) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  guardDecisionLifecycleMutation(before, 'dismiss', { allowExecution: activeExecution });
  // See snoozeDecisionAt: command callers are version-strict while the
  // long-standing direct service import remains compatible with old clients.
  validateExpectedDecisionVersion(before, expectedVersion, activeExecution != null);
  if (!['unread', 'read', 'failed', 'snoozed'].includes(before.status)) {
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision is no longer in a dismissible state.',
      409,
      decisionVersionConflictDetails(before, { currentStatus: before.status }),
    );
  }
  const stateUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'dismissed', dismissed_at = datetime('now'),
           decision_state = 'rejected', record_version = record_version + 1,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND record_version = ?
  `).run(decisionId, userId, tenantId, expectedVersion ?? before.recordVersion);
  if (stateUpdate.changes !== 1) {
    const current = getDecisionRecord(decisionId, userId, tenantId);
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed before it could be dismissed.',
      409,
      decisionVersionConflictDetails(current),
    );
  }
  expireTrainingPlanRevisionForDecision(getDb(), decisionId, userId, tenantId, 'REJECTED');
  const dismissedRecord = getDecisionRecord(decisionId, userId, tenantId);
  const decision = dismissedRecord ? formatDecisionItemForApi(dismissedRecord) : null;
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after dismiss', 404);
  emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'dismissed', toStatus: decision.status, reason: normalizeDismissReason(reason) });
  resolveDecisionConflictAudit(decisionId, userId, tenantId, 'rejected');
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'dismiss',
      actionTaken: 'dismiss',
      dismissed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
  if (!activeExecution) materializeDecisionRankSnapshotForScope(userId, tenantId);
  return decision;
}



export function markDecisionViewed(
  decisionId: string,
  userId: number,
  tenantId = userId,
  options: { idempotencyKey?: string; expectedVersion?: number; channel?: string } = {},
): DecisionApiItem {
  assertScope(userId, tenantId, 'mark_decision_viewed', { decisionId });
  const idempotencyKey = options.idempotencyKey?.trim();
  if (!idempotencyKey) {
    const item = markNotificationCenterItemRead(decisionId, userId, tenantId);
    if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
    const decision = getDecisionItem(decisionId, userId, tenantId);
    if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after viewed', 404);
    emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'detail_opened', toStatus: decision.status });
    emitDecisionLifecycleEvent({ decisionId, userId, tenantId, event: 'viewed', toStatus: decision.status });
    materializeDecisionRankSnapshotForScope(userId, tenantId);
    return decision;
  }

  ensureDecisionCenterTables();
  const attemptHash = logicalActionAttemptHash(`viewed:${decisionId}`, 'mark_viewed', {
    idempotencyKey,
    expectedVersion: options.expectedVersion ?? null,
  });
  const actionId = `viewed:${attemptHash}`;
  const detailReceiptId = `dle_view_detail_${attemptHash}`;
  const legacyViewedReceiptId = `dle_viewed_${attemptHash}`;
  const viewedReceiptId = decisionLifecycleMutationReceiptId({
    operation: 'mark_viewed',
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  });
  const prior = isExactDecisionLifecycleMutationReplay({
    receiptId: viewedReceiptId,
    decisionId,
    userId,
    tenantId,
    requestFingerprint: attemptHash,
  }) || Boolean(getDb().prepare(`
    SELECT 1 FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(legacyViewedReceiptId, decisionId, userId, tenantId));
  if (prior) {
    const replay = getDecisionItem(decisionId, userId, tenantId);
    if (!replay) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
    return replay;
  }
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  if (options.expectedVersion != null) validateExpectedDecisionVersion(record, options.expectedVersion, true);
  const requestedAt = appNowIso();
  const command = createDecisionMutationCommand({
    commandId: `dmc_${attemptHash}`,
    decisionId,
    operation: 'mark_viewed',
    actionId: null,
    scope: { userId, tenantId },
    channel: normalizeDecisionMutationChannel(options.channel),
    idempotencyKey,
    recordVersion: options.expectedVersion ?? record.recordVersion,
    contextVersion: decisionContextVersion(record),
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision.mark_viewed',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: false,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision.status',
      entityType: 'notification_center_item',
      entityId: decisionId,
      mode: 'versioned',
      expectedState: { status: record.status === 'unread' ? 'read' : record.status },
    },
    payload: {},
    requestedAt,
  });
  let decision: DecisionApiItem | null = null;
  getDb().transaction(() => {
    const replay = isExactDecisionLifecycleMutationReplay({
      receiptId: viewedReceiptId,
      decisionId,
      userId,
      tenantId,
      requestFingerprint: attemptHash,
    }) || Boolean(getDb().prepare(`
      SELECT 1 FROM decision_lifecycle_events
       WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(legacyViewedReceiptId, decisionId, userId, tenantId));
    if (replay) {
      const replayRecord = getDecisionRecord(decisionId, userId, tenantId);
      if (!replayRecord) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
      decision = formatDecisionItemForApi(replayRecord);
      return;
    }
    const expectedVersion = options.expectedVersion ?? record.recordVersion;
    const update = getDb().prepare(`
      UPDATE notification_center_items
         SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             read_at = COALESCE(read_at, datetime('now')),
             record_version = record_version + CASE WHEN status = 'unread' THEN 1 ELSE 0 END,
             updated_at = CASE WHEN status = 'unread' THEN datetime('now') ELSE updated_at END
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status IN ('unread', 'read', 'failed', 'snoozed')
    `).run(decisionId, userId, tenantId, expectedVersion);
    if (update.changes !== 1) {
      const wonByReplay = isExactDecisionLifecycleMutationReplay({
        receiptId: viewedReceiptId,
        decisionId,
        userId,
        tenantId,
        requestFingerprint: attemptHash,
      }) || Boolean(getDb().prepare(`
        SELECT 1 FROM decision_lifecycle_events
         WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(legacyViewedReceiptId, decisionId, userId, tenantId));
      if (wonByReplay) {
        const replayRecord = getDecisionRecord(decisionId, userId, tenantId);
        if (!replayRecord) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
        decision = formatDecisionItemForApi(replayRecord);
        return;
      }
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed before it could be marked viewed.',
        409,
        decisionVersionConflictDetails(getDecisionRecord(decisionId, userId, tenantId)),
      );
    }
    const viewedRecord = getDecisionRecord(decisionId, userId, tenantId);
    decision = viewedRecord ? formatDecisionItemForApi(viewedRecord) : null;
    if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after viewed', 404);
    const insert = getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    insert.run(detailReceiptId, decisionId, userId, tenantId, 'detail_opened', decision.status, actionId, '{}');
    insert.run(
      viewedReceiptId,
      decisionId,
      userId,
      tenantId,
      'viewed',
      decision.status,
      actionId,
      JSON.stringify({
        idempotencyRequestFingerprint: attemptHash,
        commandContract: command,
      }),
    );
    materializeDecisionRankSnapshotForScope(userId, tenantId);
  })();
  return decision!;
}



export class DecisionActionError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DecisionActionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}



export function actionsForRecord(record: DecisionRecord): NotificationActionButton[] {
  // Legacy rows may still contain controls that were once rendered disabled.
  // Keep them in the audit substrate but never expose them as current actions.
  const actions = record.actions.filter((action) => hasDecisionExecutor(action.id));
  const rollback = rollbackContractForRecord(record);
  if (
    rollback.available
    && rollback.actionId
    && !actions.some((action) => action.id === rollback.actionId)
  ) {
    actions.unshift({
      id: rollback.actionId,
      label: 'Undo reflow',
      style: 'secondary',
    });
  }
  // D: expose the fully-wired (truth-table implemented) `choose_another_time` action on a secretary reflow
  // that has feasible alternative slots, so the user can pick a specific window via the structured
  // DecisionOptions. Flag-gated and pushed (not unshifted, never primary). OFF or no-feasible-slot leaves
  // the action set byte-identical. The flag check short-circuits the advisor call when off.
  if (
    !actions.some((action) => action.id === 'choose_another_time')
    && isDecisionChoiceOptionsEnabled(process.env, { userId: record.userId, tenantId: record.tenantId })
    && secretaryReflowChoiceAdvice(record)
  ) {
    actions.push({ id: 'choose_another_time', label: 'Choose another time', style: 'secondary' });
  }
  return actions;
}



export function rollbackContractForRecord(record: DecisionRecord): { available: boolean; actionId: string | null } {
  const actionId = typeof record.actionResult?.rollbackActionId === 'string'
    ? record.actionResult.rollbackActionId
    : null;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  return {
    available: record.status === 'actioned'
      && record.actionResult?.rollbackAvailable === true
      && !!actionId
      && !!expectedRevision,
    actionId,
  };
}



export function dependencyStateForRecord(record: DecisionRecord): { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[]; relationships: DecisionRelationship[] } {
  const dependencies = listDecisionDependencies(record.itemId, record.userId, record.tenantId);
  const unresolved = new Set(['unread', 'read', 'failed', 'snoozed']);
  return {
    dependsOnDecisionIds: dependencies.map((dependency) => dependency.dependsOnDecisionId),
    // C6: typed relationship edges (raw type + semantics) for the client. Read-only projection.
    relationships: dependencies.map((dependency) => {
      const semantics = decisionRelationshipSemantics(dependency.relationship);
      return { decisionId: dependency.dependsOnDecisionId, type: dependency.relationship, kind: semantics.kind, label: semantics.label };
    }),
    blockedByDecisionIds: dependencies
      // C6: only a 'blocks' relationship prevents action (decisionRelationshipSemantics is the single
      // source of truth). Every other typed relationship — conflicts_with / duplicate_of / related_to /
      // requires_same_slot / affects_same_entity / alternative_to / blocked_by / supersedes / caused_by /
      // related — is advisory and never contributes to blockedByDecisionIds.
      .filter((dependency) => decisionRelationshipSemantics(dependency.relationship).blocksAction && dependency.blockerStatus && unresolved.has(dependency.blockerStatus))
      .map((dependency) => dependency.dependsOnDecisionId),
  };
}



export function guardActionable(record: DecisionRecord, actionId: string): void {
  if (durableDecisionStateForRecord(record) === 'blocked' && MUTATING_ACTIONS.has(actionId)) {
    throw new DecisionActionError('DECISION_CONFLICT_BLOCKED', 'Decision is blocked until its conflict or precondition is resolved.', 409);
  }
  if (record.status === 'expired') throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    const expire = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'expired', decision_state = 'expired',
             record_version = record_version + 1, updated_at = datetime('now')
      WHERE item_id = ? AND user_id = ? AND tenant_id = ?
        AND status != 'expired'
    `).run(record.itemId, record.userId, record.tenantId);
    if ((expire.changes ?? 0) > 0) {
      expireTrainingPlanRevisionForDecision(getDb(), record.itemId, record.userId, record.tenantId);
      emitDecisionLifecycleEvent({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, event: 'expired', toStatus: 'expired' });
      emitUnblockedDependentsForBlockers(
        [{ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId }],
        'blocker_expired',
      );
    }
    throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  }
  if (record.status === 'superseded') throw new DecisionActionError('DECISION_SUPERSEDED', 'Decision was superseded by newer state', 409);
  if (record.status === 'dismissed') throw new DecisionActionError('DECISION_DISMISSED', 'Decision was dismissed', 409);
  if (record.status === 'actioned' && rollbackContractForRecord(record).actionId !== actionId) {
    throw new DecisionActionError('DECISION_ALREADY_ACTIONED', 'Decision was already actioned', 409);
  }
}



export function expireTrainingPlanRevisionForDecision(
  db: ReturnType<typeof getDb>,
  decisionId: string,
  userId: number,
  tenantId: number,
  approvalState: 'EXPIRED' | 'REJECTED' = 'EXPIRED',
): void {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_plan_revisions'
  `).get();
  if (!table) return;
  db.prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'EXPIRED', approval_state = ?,
           expired_at = datetime('now')
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND lifecycle_state = 'PENDING_REVIEW' AND approval_state = 'PENDING'
  `).run(approvalState, decisionId, userId, tenantId);
  syncTrainingAdaptationProposalForDecisionState(
    db,
    decisionId,
    userId,
    tenantId,
    approvalState === 'REJECTED' ? 'REJECTED' : 'EXPIRED',
  );
}



export function syncTrainingAdaptationProposalForDecisionState(
  db: ReturnType<typeof getDb>,
  decisionId: string,
  userId: number,
  tenantId: number,
  state: 'PENDING_REVIEW' | 'DEFERRED' | 'REJECTED' | 'EXPIRED',
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_proposals'").get()) {
    return;
  }
  const proposal = db.prepare(`
    SELECT proposal_id AS proposalId, status, material_fingerprint AS materialFingerprint
      FROM training_adaptation_proposals
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId) as {
    proposalId: string;
    status: string;
    materialFingerprint: string;
  } | undefined;
  if (!proposal) return;
  let update;
  if (state === 'PENDING_REVIEW') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'PENDING_REVIEW'
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ? AND status = 'DEFERRED'
    `).run(proposal.proposalId, userId, tenantId);
  } else if (state === 'DEFERRED') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'DEFERRED', deferred_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ? AND status = 'PENDING_REVIEW'
    `).run(proposal.proposalId, userId, tenantId);
  } else if (state === 'REJECTED') {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'REJECTED', rejected_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ?
         AND status IN ('PENDING_REVIEW', 'DEFERRED')
    `).run(proposal.proposalId, userId, tenantId);
  } else {
    update = db.prepare(`
      UPDATE training_adaptation_proposals
         SET status = 'EXPIRED', expired_at = datetime('now')
       WHERE proposal_id = ? AND user_id = ? AND tenant_id = ?
         AND status IN ('CANDIDATE', 'PENDING_REVIEW', 'DEFERRED')
    `).run(proposal.proposalId, userId, tenantId);
  }
  if ((update.changes ?? 0) !== 1) return;
  if (state === 'REJECTED') {
    emitDomainEvent({
      tenantId,
      userId,
      sourceSkill: 'training',
      eventType: 'training.adaptation.rejected.v1',
      entityType: 'training_adaptation_proposal',
      entityId: proposal.proposalId,
      schemaVersion: 'training-adaptation-rejection.v1',
      payload: {
        action: 'REJECT',
        proposalId: proposal.proposalId,
        materialFingerprint: proposal.materialFingerprint,
      },
      privacyClassification: 'health',
      idempotencyKey: `training.adaptation.rejected:${proposal.proposalId}`,
      causationId: decisionId,
    }, db);
  }
  if (state === 'DEFERRED') incrementTrainingGenerationCounter('adaptation_deferred_total');
  else if (state === 'REJECTED') incrementTrainingGenerationCounter('adaptation_rejected_total');
  else if (state === 'EXPIRED') incrementTrainingGenerationCounter('adaptation_expired_total');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_lifecycle_events'").get()) {
    db.prepare(`
      INSERT INTO training_adaptation_lifecycle_events (
        event_id, proposal_id, tenant_id, user_id, event_type, reason_code, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, '{}')
    `).run(
      `tale_${randomUUID()}`,
      proposal.proposalId,
      tenantId,
      userId,
      state === 'PENDING_REVIEW' ? 'REVIEW_REQUESTED' : state,
      `DECISION_${state}`,
    );
  }
}



export function guardDecisionLifecycleMutation(
  record: DecisionRecord,
  operation: string,
  options: {
    allowPartialRecovery?: boolean;
    allowExecution?: { actionId: string; idempotencyKey: string };
  } = {},
): void {
  const blockingStatuses = options.allowPartialRecovery ? ['started'] : ['started', 'partially_failed'];
  const placeholders = blockingStatuses.map(() => '?').join(', ');
  const execution = getDb().prepare(`
    SELECT action_execution_id AS executionId, action_id AS actionId, idempotency_key AS idempotencyKey,
           status, lease_expires_at AS leaseExpiresAt
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN (${placeholders})
       AND NOT (action_id = ? AND idempotency_key = ?)
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get(
    record.itemId,
    record.userId,
    record.tenantId,
    ...blockingStatuses,
    options.allowExecution?.actionId ?? '',
    options.allowExecution?.idempotencyKey ?? '',
  ) as { executionId: string; actionId: string; idempotencyKey: string; status: string; leaseExpiresAt: string | null } | undefined;
  if (!execution) return;
  throw new DecisionActionError(
    execution.status === 'partially_failed'
      ? 'DECISION_EXECUTION_RECOVERY_REQUIRED'
      : 'DECISION_ACTION_IN_PROGRESS',
    execution.status === 'partially_failed'
      ? 'This decision has an uncertain partial execution. Reconcile it before changing the proposal lifecycle.'
      : 'This decision is currently executing. Wait for the verified outcome before changing it.',
    409,
    {
      operation,
      actionExecutionId: execution.executionId,
      actionId: execution.actionId,
      executionStatus: execution.status,
      leaseExpiresAt: execution.leaseExpiresAt,
    },
  );
}



export function guardDecisionDependencies(record: DecisionRecord, actionId: string): void {
  if (actionId === 'open_detail' || actionId === 'dismiss' || actionId === 'snooze' || actionId === 'not_now' || actionId === 'undo_reflow') {
    return;
  }
  const blockedByDecisionIds = dependencyStateForRecord(record).blockedByDecisionIds;
  if (blockedByDecisionIds.length === 0) return;
  throw new DecisionActionError('DECISION_DEPENDENCY_BLOCKED', 'Resolve the blocking decision before running this action.', 409, {
    blockedByDecisionIds,
  });
}



export function decisionContextVersion(record: DecisionRecord): string | null {
  return normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)?.contextVersion
    ?? record.storedContextVersion;
}



export function decisionContextExpiresAt(record: DecisionRecord): string | undefined {
  const contextExpiry = decisionContextForRecord(record).contextExpiresAt;
  if (typeof contextExpiry === 'string' && Number.isFinite(Date.parse(contextExpiry))) return contextExpiry;
  return record.expiresAt ?? record.decisionDeadline ?? undefined;
}



export function logicalActionHashForAttempt(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): string {
  const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  return logicalActionAttemptHash(normalized?.logicalActionHash ?? `legacy:${record.itemId}`, actionId, payload);
}



/**
 * Bind client-supplied action parameters to the proposal the user actually
 * reviewed. Transport payloads can select an advertised option or provide an
 * explicitly editable value, but they cannot silently retarget a decision.
 */
export function validatedDecisionActionPayload(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (actionId === 'snooze') {
    const context = decisionContextForRecord(record);
    const timezone = userDecisionContextDefaults(record.userId).timezone
      ?? context.timezone
      ?? 'UTC';
    const resolution = resolveDecisionDeferUntil({
      timezone,
      deferUntil: typeof payload.deferUntil === 'string' ? payload.deferUntil : null,
      followUp: typeof payload.followUp === 'string' ? payload.followUp : null,
      minutes: payload.minutes == null ? null : Number(payload.minutes),
    });
    if (!resolution.ok) {
      throw new DecisionActionError(
        `DECISION_${resolution.code}`,
        resolution.code === 'DEFER_UNTIL_NOT_FUTURE'
          ? 'deferUntil must be later than the current instant.'
          : 'The requested revisit time is invalid.',
        resolution.code === 'DEFER_UNTIL_NOT_FUTURE' ? 409 : 400,
        { field: resolution.code === 'INVALID_MINUTES' ? 'minutes' : 'deferUntil' },
      );
    }
    return {
      deferUntil: resolution.deferUntil,
      deferSource: resolution.source,
    };
  }

  if (actionId === 'dismiss' || actionId === 'reject_reflow' || actionId === 'not_now') {
    return typeof payload.reason === 'string'
      ? { reason: normalizeDismissReason(payload.reason) }
      : {};
  }

  if (actionId === 'choose_another_time') {
    const startAt = normalizeTimestamp(typeof payload.startAt === 'string' ? payload.startAt : null);
    const endAt = normalizeTimestamp(typeof payload.endAt === 'string' ? payload.endAt : null);
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_REQUIRED',
        'Choosing another time requires a valid advertised start and end window.',
        400,
      );
    }
    const advice = secretaryReflowChoiceAdvice(record);
    const advertised = advice ? [
      { startAt: advice.recommendedStartAt, endAt: advice.recommendedEndAt },
      ...advice.alternatives,
    ] : [];
    const selectedWasAdvertised = advertised.some((candidate) =>
      candidate.startAt && candidate.endAt
      && Date.parse(candidate.startAt) === Date.parse(startAt)
      && Date.parse(candidate.endAt) === Date.parse(endAt));
    if (!selectedWasAdvertised) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The selected window is not part of the current reviewed proposal. Refresh or edit the proposal first.',
        409,
      );
    }
    return { startAt, endAt };
  }

  if (actionId === 'mark_paid') {
    const relatedMonth = record.relatedEntityType === 'finance_tax_event'
      && typeof record.relatedEntityId === 'string'
      && /^\d{4}-\d{2}$/.test(record.relatedEntityId)
      ? record.relatedEntityId
      : null;
    const suppliedMonth = typeof payload.month === 'string' ? payload.month : null;
    if (!relatedMonth || (suppliedMonth != null && suppliedMonth !== relatedMonth)) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The payment action must target the tax event attached to this decision.',
        409,
      );
    }
    // Canonicalize absent and explicitly supplied values to one logical action.
    return { month: relatedMonth };
  }

  if (actionId === 'add_meal') {
    const target = record.relatedEntityType === 'meal_plan' && typeof record.relatedEntityId === 'string'
      ? record.relatedEntityId.match(/^(\d{4}-\d{2}-\d{2}):([^:]+)$/)
      : null;
    const date = typeof payload.date === 'string' ? payload.date : null;
    const mealType = typeof payload.mealType === 'string'
      ? payload.mealType
      : typeof payload.meal_type === 'string' ? payload.meal_type : null;
    if (!target || date !== target[1] || mealType !== target[2]) {
      throw new DecisionActionError(
        'DECISION_ACTION_PAYLOAD_MISMATCH',
        'The meal action must target the date and meal slot attached to this decision.',
        409,
      );
    }
    return {
      date,
      mealType,
      title: payload.title,
      ...(typeof payload.notes === 'string' ? { notes: payload.notes } : {}),
    };
  }

  return payload;
}



export function validateExpectedDecisionVersion(
  record: DecisionRecord,
  expectedVersion: number | undefined,
  requiredForAction: boolean,
): void {
  if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0)) {
    throw new DecisionActionError('DECISION_VERSION_INVALID', 'expectedVersion must be a positive integer', 400);
  }
  const enforced = requiredForAction && decisionFlowV1EnforcedForRecord(record);
  if (expectedVersion == null && enforced) {
    throw new DecisionActionError('DECISION_VERSION_REQUIRED', 'This decision action requires the current record version.', 428, {
      ...decisionVersionConflictDetails(record),
    });
  }
  if (expectedVersion != null && expectedVersion !== record.recordVersion) {
    logger.info({
      event: 'decision.version_conflict',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      expectedVersion,
      currentVersion: record.recordVersion,
    }, 'Decision optimistic-concurrency conflict');
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed in another session. Refresh before acting.',
      409,
      decisionVersionConflictDetails(record),
    );
  }
}



export function decisionVersionConflictDetails(
  record: DecisionRecord | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  let currentItem: DecisionApiItem | null = null;
  if (record) {
    try {
      currentItem = formatDecisionItemForApi(record);
    } catch (err) {
      logger.warn({
        event: 'decision.version_conflict_projection_failed',
        err,
        decisionId: record.itemId,
        userId: record.userId,
        tenantId: record.tenantId,
      }, 'Could not include the current safe Decision Center item in a version-conflict response');
    }
  }
  return {
    currentVersion: record?.recordVersion ?? null,
    decisionState: record ? durableDecisionStateForRecord(record) : null,
    updatedAt: record?.updatedAt ?? null,
    currentItem,
    ...extra,
  };
}



export function revalidateDecisionActionForExecution(
  record: DecisionRecord,
  actionId: string,
  expectedContextVersion?: string,
  payload: Record<string, unknown> = {},
): ConflictEvaluation | null {
  const actionOverride = actionId === 'undo_reflow'
    ? secretaryRollbackActionForRecord(record)
    : actionId === 'choose_another_time'
      ? secretarySelectedWindowActionForRecord(record, payload)
      : undefined;
  return revalidateDecisionContext(record, expectedContextVersion, {
    confirmationGranted: true,
    ...(actionOverride ? { actionOverride } : {}),
  });
}



export async function refreshTrainingCapacityForDecisionExecution(
  record: DecisionRecord,
  actionId: string,
  executionId: string,
): Promise<void> {
  if (actionId !== 'activate_training_plan_revision') return;
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const capacity = action?.preconditions.find((precondition) =>
    precondition.type === 'training_capacity_context' && precondition.required);
  if (!capacity) return;
  const expectedContextVersion = capacity.expectedVersion;
  if (!expectedContextVersion) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Calendar capacity approval context is incomplete. Refresh the plan before activation.',
      409,
      { reasonCode: 'TRAINING_M4_CAPACITY_EXPECTED_VERSION_MISSING' },
    );
  }
  try {
    const snapshots = await import('../training-m4-capacity-snapshots');
    const refreshed = await snapshots.refreshTrainingM4CapacityContextForDecision({
      scope: { userId: record.userId, tenantId: record.tenantId },
      expectedContextVersion,
      executionId,
    });
    if (refreshed.contextVersion !== expectedContextVersion) {
      throw new Error('TRAINING_M4_CAPACITY_CHANGED_AFTER_REVIEW');
    }
  } catch (error) {
    const reasonCode = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'TRAINING_M4_CAPACITY_REFRESH_FAILED')
      : error instanceof Error ? error.message : 'TRAINING_M4_CAPACITY_REFRESH_FAILED';
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'Calendar capacity changed or could not be freshly verified after review. Refresh the plan before activation.',
      409,
      { reasonCode },
    );
  }
}



export function secretarySelectedWindowActionForRecord(
  record: DecisionRecord,
  payload: Record<string, unknown>,
): NormalizedDecisionAction {
  const stored = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const start = typeof payload.startAt === 'string' ? normalizeTimestamp(payload.startAt) : null;
  const end = typeof payload.endAt === 'string' ? normalizeTimestamp(payload.endAt) : null;
  if (!stored || !start || !end || Date.parse(start) >= Date.parse(end)) {
    throw new DecisionActionError(
      'DECISION_ACTION_PAYLOAD_MISMATCH',
      'The selected Secretary window is not bound to a current normalized proposal.',
      409,
    );
  }
  return buildNormalizedDecisionAction({
    intent: stored.intent,
    targetEntities: stored.targetEntities,
    affectedResources: stored.affectedResources,
    requestedWindow: {
      start,
      end,
      timezone: stored.requestedWindow?.timezone ?? decisionContextForRecord(record).timezone ?? 'UTC',
    },
    preconditions: stored.preconditions,
    expectedEffects: stored.expectedEffects,
    prohibitedEffects: stored.prohibitedEffects,
    dependencies: stored.dependencies,
    exclusivityKeys: stored.exclusivityKeys,
    authorizationScope: stored.authorizationScope,
    risk: stored.risk,
    reversibility: stored.reversibility,
    contextVersion: stored.contextVersion,
  });
}



export function secretaryRollbackActionForRecord(record: DecisionRecord): NormalizedDecisionAction {
  const storedAction = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const rollback = record.actionResult?.rollback;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  const previous = rollback && typeof rollback === 'object' && !Array.isArray(rollback)
    ? (rollback as Record<string, unknown>).previous
    : null;
  if (record.sourceSkill !== 'secretary'
      || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId
      || !expectedRevision || !previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new DecisionActionError(
      'DECISION_ROLLBACK_UNAVAILABLE',
      'This rollback does not have a complete, current Secretary state contract.',
      409,
    );
  }
  const prior = previous as Record<string, unknown>;
  const priorStart = stringOrNull(prior.startAt);
  const priorEnd = stringOrNull(prior.endAt);
  const timezone = storedAction?.requestedWindow?.timezone
    ?? decisionContextForRecord(record).timezone
    ?? 'UTC';
  const requestedWindow = priorStart && priorEnd
    && Number.isFinite(Date.parse(priorStart)) && Number.isFinite(Date.parse(priorEnd))
    && Date.parse(priorStart) < Date.parse(priorEnd)
    ? { start: priorStart, end: priorEnd, timezone }
    : undefined;
  const localDay = requestedWindow
    ? DateTime.fromISO(requestedWindow.start, { setZone: true }).setZone(timezone).toISODate()
    : null;
  return buildNormalizedDecisionAction({
    intent: 'undo_secretary_reflow',
    targetEntities: [{ type: 'secretary_agenda_item', id: record.relatedEntityId, version: expectedRevision }],
    affectedResources: storedAction?.affectedResources.length
      ? storedAction.affectedResources
      : [{ type: 'secretary_agenda_item', id: record.relatedEntityId }],
    ...(requestedWindow ? { requestedWindow } : {}),
    preconditions: [{
      type: 'agenda_state',
      ref: record.relatedEntityId,
      expectedVersion: expectedRevision,
      required: true,
    }],
    expectedEffects: [{ type: 'restore_prior_agenda_state', targetRef: `secretary_agenda_item:${record.relatedEntityId}` }],
    prohibitedEffects: [{ type: 'overwrite_changed_agenda_state', targetRef: `secretary_agenda_item:${record.relatedEntityId}` }],
    dependencies: storedAction?.dependencies ?? [],
    exclusivityKeys: storedAction?.exclusivityKeys.length
      ? storedAction.exclusivityKeys
      : [localDay
          ? `calendar_timeline:${record.tenantId}:${localDay}`
          : `secretary_agenda_item:${record.tenantId}:${record.relatedEntityId}`],
    authorizationScope: storedAction?.authorizationScope.length
      ? storedAction.authorizationScope
      : ['calendar:write'],
    risk: storedAction?.risk ?? 'medium',
    reversibility: 'reversible',
    contextVersion: storedAction?.contextVersion ?? `rollback:${record.itemId}:${expectedRevision}`,
  });
}



export function revalidateDecisionContext(
  record: DecisionRecord,
  expectedContextVersion?: string,
  options: {
    confirmationGranted?: boolean;
    replacementApproved?: boolean;
    actionOverride?: NormalizedDecisionAction;
  } = {},
): ConflictEvaluation | null {
  const storedAction = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const currentContextVersion = decisionContextVersion(record);
  if (expectedContextVersion && currentContextVersion !== expectedContextVersion) {
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      currentContextVersion,
    });
  }
  const action = options.actionOverride ?? storedAction;
  if (!action) return null;
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId: record.userId, tenantId: record.tenantId });
  const approved = durableDecisionStateForRecord(record) === 'approved' || options.confirmationGranted === true;
  const replacementApproved = options.replacementApproved === true
    || hasApprovedReplacementForContext(record, action.contextVersion);
  const revalidation = revalidateNormalizedDecisionAction({
    scope: { userId: record.userId, tenantId: record.tenantId },
    action,
    decisionId: record.itemId,
    additionalExisting: decisionContextForRecord(record).conflictComparisons ?? undefined,
    decisionApproved: approved,
    replacementApproved,
    confirmationApproved: approved,
    confidence: decisionContextForRecord(record).candidateConfidence ?? undefined,
    contextExpiresAt: decisionContextExpiresAt(record),
    candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
  });
  logger.info({
    event: 'decision.revalidation_changed',
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    mode,
    disposition: revalidation.conflictEvaluation.disposition,
    reasonCodes: revalidation.conflictEvaluation.reasonCodes,
    missingPermissionCount: revalidation.missingPermissions.length,
    failedPreconditionCount: revalidation.preconditions.filter((precondition) => !precondition.ok).length,
    contextSourcesHealthy: revalidation.contextSourcesHealthy,
  }, 'Decision context revalidated');
  const enforce = mode === 'active' || decisionFlowV1EnforcedForRecord(record);
  if (!enforce) return revalidation.conflictEvaluation;

  const conflict = revalidation.conflictEvaluation;
  const storedConflict = decisionContextForRecord(record).conflictEvaluation;
  const storedFindingKeys = conflictFindingKeys(storedConflict);
  const currentFindingKeys = conflictFindingKeys(conflict);
  if (options.confirmationGranted === true
    && currentFindingKeys.length > 0
    && (storedFindingKeys.length === 0 || storedFindingKeys.join('|') !== currentFindingKeys.join('|'))) {
    persistRevalidationFailure(record, conflict, 'conflicts_changed_after_review', 'ready_for_review');
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'The conflicts changed after this proposal was shown and require fresh review.', 409, {
      previousReasonCodes: storedConflict?.reasonCodes ?? [],
      currentReasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'allow' || conflict.disposition === 'auto_resolve') return conflict;
  if (conflict.disposition === 'needs_confirmation' && options.confirmationGranted !== true) {
    persistRevalidationFailure(record, conflict, 'current_tradeoff_requires_confirmation');
    throw new DecisionActionError('DECISION_CONFIRMATION_REQUIRED', 'The proposal has current tradeoffs that require confirmation.', 409, {
      reasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'stale') {
    persistRevalidationFailure(record, conflict, 'material_context_stale');
    throw new DecisionActionError('DECISION_CONTEXT_CHANGED', 'Decision context changed and must be reviewed again.', 409, {
      reasonCodes: conflict.reasonCodes,
      contextVersion: conflict.contextVersion,
    });
  }
  if (conflict.disposition === 'supersede') {
    persistRevalidationFailure(record, conflict, 'newer_decision_supersedes_proposal');
    throw new DecisionActionError('DECISION_SUPERSEDED', 'A newer decision supersedes this proposal.', 409, {
      winnerDecisionId: conflict.winnerDecisionId ?? null,
      reasonCodes: conflict.reasonCodes,
    });
  }
  const changedPreconditions = revalidation.preconditions.filter((precondition) =>
    !precondition.ok
    && precondition.reasonCode !== 'unsupported_required_precondition'
    && precondition.reasonCode !== 'precondition_source_unavailable');
  if (changedPreconditions.length > 0) {
    persistRevalidationFailure(record, conflict, 'authoritative_source_state_changed', 'ready_for_review');
    throw new DecisionActionError(
      'DECISION_CONTEXT_CHANGED',
      'The authoritative source state changed and this proposal requires fresh review.',
      409,
      {
        reasonCodes: conflict.reasonCodes,
        contextVersion: conflict.contextVersion,
        preconditions: changedPreconditions,
      },
    );
  }
  persistRevalidationFailure(
    record,
    conflict,
    conflict.disposition === 'suppress_duplicate' ? 'equivalent_decision_exists' : 'current_policy_blocks_action',
  );
  throw new DecisionActionError(
    conflict.disposition === 'suppress_duplicate' ? 'DECISION_DUPLICATE' : 'DECISION_CONFLICT_BLOCKED',
    conflict.disposition === 'suppress_duplicate'
      ? 'An equivalent decision already exists.'
      : 'The action is blocked by current policy, permissions, commitments, or preconditions.',
    409,
    {
      winnerDecisionId: conflict.winnerDecisionId ?? null,
      reasonCodes: conflict.reasonCodes,
      missingPermissions: revalidation.missingPermissions,
      preconditions: revalidation.preconditions.filter((precondition) => !precondition.ok),
    },
  );
}



/**
 * A failed current-state check must revoke any durable approval, not merely
 * reject one request while leaving the UI on an apparently approved version.
 * The state/context/version change and privacy-safe audit event are committed
 * together; a concurrent winner returns the normal version-conflict response.
 */
export function persistRevalidationFailure(
  record: DecisionRecord,
  conflict: ConflictEvaluation,
  reason: string,
  nextStateOverride?: DurableDecisionState,
): void {
  const currentContext = decisionContextForRecord(record);
  const nextContext: DecisionLogicContext = {
    ...currentContext,
    conflictEvaluation: conflict,
  };
  const nextState: DurableDecisionState = nextStateOverride ?? (conflict.disposition === 'supersede'
    || conflict.disposition === 'suppress_duplicate'
    ? 'superseded'
    : conflict.disposition === 'needs_confirmation'
      ? 'ready_for_review'
      : 'blocked');
  const contextChanged = conflictMaterialKey(currentContext.conflictEvaluation) !== conflictMaterialKey(conflict);
  const stateChanged = durableDecisionStateForRecord(record) !== nextState;
  if (!contextChanged && !stateChanged) return;

  const now = appNowIso();
  getDb().transaction(() => {
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET decision_context_json = ?, context_version = ?
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(
      JSON.stringify(nextContext),
      conflict.contextVersion,
      record.intentId,
      record.userId,
      record.tenantId,
    );
    if (intentUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision context could not be invalidated safely.', 409);
    }
    const itemUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET decision_state = ?,
             status = CASE WHEN ? = 'superseded' THEN 'superseded'
                           WHEN status = 'actioned' THEN 'read'
                           ELSE status END,
             record_version = record_version + 1,
             updated_at = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('dismissed', 'expired', 'superseded')
    `).run(
      nextState,
      nextState,
      now,
      record.itemId,
      record.userId,
      record.tenantId,
      record.recordVersion,
    );
    if (itemUpdate.changes !== 1) {
      throw new DecisionActionError('DECISION_VERSION_CONFLICT', 'Decision changed during revalidation.', 409, {
        ...decisionVersionConflictDetails(getDecisionRecord(record.itemId, record.userId, record.tenantId)),
      });
    }
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'revalidation_failed', ?, ?, ?, ?)
    `).run(
      `dle_${randomUUID()}`,
      record.itemId,
      record.userId,
      record.tenantId,
      nextState,
      reason,
      JSON.stringify({
        policyVersion: conflict.policyVersion,
        contextVersion: conflict.contextVersion,
        disposition: conflict.disposition,
        reasonCodes: conflict.reasonCodes,
        previousVersion: record.recordVersion,
        nextVersion: record.recordVersion + 1,
      }),
      now,
    );
  })();
}



export function hasApprovedReplacementForContext(record: DecisionRecord, contextVersion: string): boolean {
  try {
    const rows = getDb().prepare(`
      SELECT metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'approved'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10
    `).all(record.itemId, record.userId, record.tenantId) as Array<{ metadataJson: string | null }>;
    return rows.some((row) => {
      const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
      return metadata.contextVersion === contextVersion
        && metadata.replacementChoiceId === 'replace_with_candidate';
    });
  } catch {
    return false;
  }
}



export function hasStrongApprovalForCurrentVersion(record: DecisionRecord): boolean {
  try {
    const rows = getDb().prepare(`
      SELECT metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'approved'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10
    `).all(record.itemId, record.userId, record.tenantId) as Array<{ metadataJson: string | null }>;
    return rows.some((row) => {
      const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
      return metadata.confirmationStrength === 'strong'
        && metadata.nextVersion === record.recordVersion
        && metadata.contextVersion === decisionContextVersion(record);
    });
  } catch {
    return false;
  }
}



export function conflictFindingKeys(conflict: ConflictEvaluation | null | undefined): string[] {
  if (!conflict) return [];
  return conflict.findings.map((finding) => [
    finding.class,
    finding.severity,
    finding.reasonCode,
    finding.conflictingDecisionId ?? '',
    finding.resourceKey ?? '',
  ].join(':')).sort();
}



export function getExistingExecution(decisionId: string, actionId: string, userId: number, tenantId: number, idempotencyKey: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE decision_id = ? AND action_id = ? AND user_id = ? AND tenant_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(decisionId, actionId, userId, tenantId, idempotencyKey) as any ?? null;
}



export function getExistingExecutionForIdempotencyKey(
  decisionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND idempotency_key = ?
     ORDER BY created_at ASC
     LIMIT 1
  `).get(decisionId, userId, tenantId, idempotencyKey) as any ?? null;
}



export function getExistingLogicalExecution(userId: number, tenantId: number, logicalActionHash: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE user_id = ? AND tenant_id = ? AND logical_action_hash = ?
       AND (status IN ('succeeded', 'partially_failed')
         OR (status = 'started' AND (lease_expires_at IS NULL OR datetime(lease_expires_at) > datetime('now'))))
     ORDER BY created_at ASC
     LIMIT 1
  `).get(userId, tenantId, logicalActionHash) as any ?? null;
}



export function buildDecisionActionMutationCommand(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
  input: {
    idempotencyKey: string;
    channel?: string;
    recordVersion?: number;
    contextVersion?: string;
  },
): DecisionMutationCommand<Record<string, unknown>> {
  const descriptor = findDecisionExecutor(actionId);
  if (!descriptor) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'This decision action does not have a registered executor and read-back contract.',
      409,
      { actionId },
    );
  }
  const contextVersion = input.contextVersion ?? decisionContextVersion(record);
  const expectedState = expectedExecutionStateForAttempt(record, actionId, payload);
  const relatedEntityId = record.relatedEntityId ?? record.itemId;
  const relatedEntityType = record.relatedEntityType ?? 'decision';
  const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const riskLevel = normalized?.risk === 'critical' || normalized?.risk === 'high'
    ? 'high'
    : normalized?.risk === 'medium'
      ? 'medium'
      : 'low';
  const requestedAt = appNowIso();
  const channel = normalizeDecisionMutationChannel(input.channel);
  const commandId = `dmc_${createHash('sha256').update(JSON.stringify({
    decisionId: record.itemId,
    actionId,
    userId: record.userId,
    tenantId: record.tenantId,
    idempotencyKey: input.idempotencyKey,
  })).digest('hex').slice(0, 32)}`;
  return createDecisionMutationCommand({
    commandId,
    decisionId: record.itemId,
    operation: actionId === 'snooze' ? 'snooze' : actionId === 'dismiss' || actionId === 'not_now'
      ? 'dismiss'
      : 'act',
    actionId,
    scope: { userId: record.userId, tenantId: record.tenantId },
    channel,
    idempotencyKey: input.idempotencyKey,
    recordVersion: input.recordVersion ?? record.recordVersion,
    contextVersion: contextVersion ?? null,
    approval: decisionCommandApproval(
      record,
      actionId,
      channel,
      requestedAt,
      input.idempotencyKey,
    ),
    execution: {
      executorId: descriptor.executorKey,
      strategy: 'synchronous',
      riskLevel,
      reversible: normalized?.reversibility !== 'irreversible',
      supportsIdempotency: true,
    },
    readback: {
      verifierId: descriptor.readBackKey ?? 'decision.navigation_acknowledgement',
      entityType: relatedEntityType,
      entityId: relatedEntityId,
      mode: descriptor.executionKind === 'mutation' ? 'versioned' : 'exact',
      expectedState,
    },
    payload,
    requestedAt,
  });
}



export function normalizeDecisionMutationChannel(value?: string): DecisionMutationChannel {
  if (value == null || value === '') return 'internal';
  if (value === 'rest' || value === 'ios' || value === 'portal' || value === 'chat' || value === 'shortcut'
      || value === 'apns' || value === 'automation' || value === 'internal') return value;
  throw new DecisionActionError(
    'DECISION_MUTATION_INVALID',
    'Decision mutation channel is not supported.',
    400,
    { field: 'channel' },
  );
}



export function decisionCommandApproval(
  record: DecisionRecord,
  actionId: string,
  channel: DecisionMutationChannel,
  confirmedAt: string,
  idempotencyKey: string,
): DecisionMutationApproval {
  // Approval is bound to the command being executed, not merely to the
  // riskiest action present on the Decision. A Finance Decision can require
  // strong confirmation for `mark_paid` while still allowing the user to
  // dismiss or defer it with ordinary explicit confirmation. Navigation and
  // detail reads never manufacture approval evidence.
  if (actionId === 'open_detail' || actionId === 'reconnect') {
    return { requiredLevel: 'none', evidence: null };
  }
  const level: DecisionApprovalLevel = actionId === 'dismiss'
    || actionId === 'reject_reflow'
    || actionId === 'not_now'
    || actionId === 'snooze'
    ? 'user_confirmation'
    : approvalLevelForRecord(record);
  if (level === 'none') return { requiredLevel: 'none', evidence: null };
  if (level === 'unavailable' || level === 'admin_review') {
    throw new DecisionActionError(
      level === 'unavailable' ? 'DECISION_PERMISSION_REQUIRED' : 'DECISION_ADMIN_REVIEW_REQUIRED',
      level === 'unavailable'
        ? 'Current permissions do not allow this action.'
        : 'This action requires an authorized administrator review.',
      403,
    );
  }
  const durableReceipt = currentDecisionApprovalReceipt(record);
  if (level === 'strong_confirmation') {
    if (!durableReceipt || durableReceipt.strength !== 'strong') {
      throw new DecisionActionError(
        'DECISION_STRONG_CONFIRMATION_REQUIRED',
        'This high-impact action requires a current strong approval before execution.',
        409,
      );
    }
    return {
      requiredLevel: 'strong_confirmation',
      evidence: {
        level: 'strong_confirmation',
        actorUserId: record.userId,
        confirmedAt: durableReceipt.confirmedAt,
        evidenceRef: durableReceipt.eventId,
      },
    };
  }
  if (durableReceipt) {
    return {
      requiredLevel: 'user_confirmation',
      evidence: {
        level: 'user_confirmation',
        actorUserId: record.userId,
        confirmedAt: durableReceipt.confirmedAt,
        evidenceRef: durableReceipt.eventId,
      },
    };
  }
  const evidenceRef = `decision-approval:${createHash('sha256').update(JSON.stringify({
    decisionId: record.itemId,
    recordVersion: record.recordVersion,
    contextVersion: decisionContextVersion(record),
    source: channel === 'automation' ? 'persisted_low_risk_opt_in' : 'explicit_action_request',
    idempotencyKey,
  })).digest('hex').slice(0, 32)}`;
  return {
    requiredLevel: level,
    evidence: {
      level,
      actorUserId: record.userId,
      confirmedAt,
      evidenceRef,
    },
  };
}



export function currentDecisionApprovalReceipt(record: DecisionRecord): {
  eventId: string;
  confirmedAt: string;
  strength: 'standard' | 'strong';
} | null {
  try {
    const rows = getDb().prepare(`
      SELECT event_id AS eventId, created_at AS confirmedAt, metadata_json AS metadataJson
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'approved'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10
    `).all(record.itemId, record.userId, record.tenantId) as Array<{
      eventId: string;
      confirmedAt: string;
      metadataJson: string | null;
    }>;
    for (const row of rows) {
      const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
      if (metadata.nextVersion !== record.recordVersion
          || metadata.contextVersion !== decisionContextVersion(record)) continue;
      return {
        eventId: row.eventId,
        confirmedAt: normalizeTimestamp(row.confirmedAt) ?? appNowIso(),
        strength: metadata.confirmationStrength === 'strong' ? 'strong' : 'standard',
      };
    }
  } catch {
    return null;
  }
  return null;
}



export function expectedExecutionStateForAttempt(
  record: DecisionRecord,
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (actionId === 'choose_another_time') {
    return {
      verifier: 'secretary_agenda_state',
      expectedLifecycleState: 'reflowed',
      targetStateHash: privacySafeStateHash({ startAt: payload.startAt, endAt: payload.endAt }),
    };
  }
  if (actionId === 'accept_reflow') {
    const context = decisionContextForRecord(record);
    return {
      verifier: 'secretary_agenda_state',
      expectedLifecycleState: 'reflowed',
      targetStateHash: privacySafeStateHash({
        startAt: context.recommendedStartAt ?? null,
        endAt: context.recommendedEndAt ?? null,
      }),
    };
  }
  if (actionId === 'undo_reflow') {
    return {
      verifier: 'secretary_rollback_state',
      expectedStateHash: privacySafeStateHash(record.actionResult?.rollback ?? null),
    };
  }
  if (actionId === 'mark_paid') {
    return { verifier: 'finance_tax_event', targetRef: record.relatedEntityId, expectedStatus: 'paid' };
  }
  if (actionId === 'add_meal') {
    return {
      verifier: 'cooking_meal_plan',
      targetRef: record.relatedEntityId,
      titleHash: privacySafeStateHash(typeof payload.title === 'string' ? payload.title.trim() : null),
    };
  }
  if (actionId === 'approve_script' || actionId === 'request_rewrite') {
    return {
      verifier: 'content_workflow_object',
      targetRef: contentWorkflowObjectIdForDecision(record),
      expectedApprovalState: actionId === 'approve_script' ? 'approved' : 'rejected',
    };
  }
  if (actionId === 'option_a' || actionId === 'option_b') {
    return { verifier: 'chat_pending_confirmation', targetRef: record.relatedEntityId, expectedStatus: 'cleared' };
  }
  if (actionId === 'accept_chat_action_fix') {
    return { verifier: 'decision_projection_only', expectedStatus: 'actioned' };
  }
  if (actionId === 'activate_training_plan_revision') {
    return {
      verifier: 'training_active_plan_reference',
      targetRef: record.relatedEntityId,
      expectedStatus: 'ACTIVE',
    };
  }
  if (actionId === 'activate_training_coach_v2_proposal') {
    return {
      verifier: 'training_coach_v2_proposals',
      targetRef: record.relatedEntityId,
      expectedStatus: 'activated',
    };
  }
  return { verifier: 'registered_executor_readback', actionId };
}



export function privacySafeStateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}



export function privacySafeTrainingCoachV2Effect(
  proposal: {
    kind: string;
    planId: number;
    weekId: number | null;
    state: string;
  },
  readbackValue: object,
): Record<string, unknown> {
  const readback = readbackValue as Record<string, unknown>;
  const affectedSessionIds = Array.isArray(readback.affectedSessionIds)
    ? readback.affectedSessionIds.filter((value) => Number.isSafeInteger(Number(value)))
    : [];
  return {
    proposalState: proposal.state,
    proposalKind: proposal.kind,
    planId: proposal.planId,
    weekId: proposal.weekId,
    adaptationRevision: Number.isSafeInteger(Number(readback.adaptationRevision))
      ? Number(readback.adaptationRevision)
      : null,
    policyVersion: Number.isSafeInteger(Number(readback.policyVersion))
      ? Number(readback.policyVersion)
      : null,
    affectedSessionCount: affectedSessionIds.length,
    propagationPending: readback.propagation != null
      && typeof readback.propagation === 'object'
      && !Array.isArray(readback.propagation)
      && (readback.propagation as Record<string, unknown>).pending === true,
  };
}



export function reconcilePartialDecisionExecution(record: DecisionRecord): DecisionExecutionReconciliationOutcome {
  const execution = getDb().prepare(`
    SELECT action_execution_id AS executionId, action_id AS actionId,
           expected_effect_json AS expectedEffectJson
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get(record.itemId, record.userId, record.tenantId) as {
    executionId: string;
    actionId: string;
    expectedEffectJson: string | null;
  } | undefined;
  if (!execution) return 'none';

  const expected = safeParseJson<Record<string, unknown>>(execution.expectedEffectJson, {});
  const verification = verifyUncertainDecisionExecution(record, execution.actionId, expected);
  if (verification.outcome === 'unknown') {
    getDb().prepare(`
      UPDATE decision_action_executions
         SET error_code = 'DECISION_MANUAL_RECONCILIATION_REQUIRED',
             recovery_json = ?
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
    `).run(JSON.stringify({
      message: 'Nexus could not prove whether the external effect completed. The action remains blocked to prevent a duplicate; review the source system before contacting support.',
      actions: [{ id: 'open_detail', label: 'Review details', style: 'secondary' }],
    }), execution.executionId, record.userId, record.tenantId);
    logger.warn({
      event: 'decision.execution_reconciliation_required',
      decisionId: record.itemId,
      actionExecutionId: execution.executionId,
      actionId: execution.actionId,
      userId: record.userId,
      tenantId: record.tenantId,
    }, 'Decision execution remains blocked because authoritative state is indeterminate');
    return 'unknown';
  }

  const reconciledAt = appNowIso();
  getDb().transaction(() => {
    if (verification.outcome === 'applied') {
      const effects = expectedEffectResultsForExecution(execution.executionId, 'succeeded');
      const executionUpdate = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'succeeded', result_json = ?, effect_results_json = ?,
               recovery_json = '{}', error_code = NULL, completed_at = ?, failed_at = NULL
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(
        JSON.stringify(verification.actualEffect),
        JSON.stringify(effects),
        reconciledAt,
        execution.executionId,
        record.userId,
        record.tenantId,
      );
      assertDecisionScopedUpdateApplied(executionUpdate, 'reconcile_partial_execution_succeeded', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'succeeded', updated_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(reconciledAt, execution.executionId, record.userId, record.tenantId);
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET status = 'actioned', actioned_at = COALESCE(actioned_at, ?),
               action_result_json = CASE WHEN status = 'actioned' THEN action_result_json ELSE ? END,
               record_version = record_version + 1, updated_at = ?
         WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
           AND status NOT IN ('dismissed', 'expired', 'superseded')
      `).run(
        reconciledAt,
        JSON.stringify({ actionId: execution.actionId, reconciled: true, ...verification.actualEffect }),
        reconciledAt,
        record.itemId,
        record.userId,
        record.tenantId,
        record.recordVersion,
      );
      assertDecisionScopedUpdateApplied(itemUpdate, 'reconcile_partial_execution_item_succeeded', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
    } else {
      const effects = expectedEffectResultsForExecution(execution.executionId, 'failed', 'authoritative_state_not_applied');
      const executionUpdate = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'failed', result_json = ?, effect_results_json = ?, recovery_json = '{}',
               error_code = 'DECISION_EXECUTION_RECONCILED_NOT_APPLIED', failed_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(
        JSON.stringify(verification.actualEffect),
        JSON.stringify(effects),
        reconciledAt,
        execution.executionId,
        record.userId,
        record.tenantId,
      );
      assertDecisionScopedUpdateApplied(executionUpdate, 'reconcile_partial_execution_not_applied', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'failed', updated_at = ?
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'partially_failed'
      `).run(reconciledAt, execution.executionId, record.userId, record.tenantId);
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET status = 'failed', decision_state = 'ready_for_review', action_result_json = ?,
               record_version = record_version + 1, updated_at = ?
         WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
           AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
      `).run(
        JSON.stringify({ actionId: execution.actionId, errorCode: 'DECISION_EXECUTION_RECONCILED_NOT_APPLIED' }),
        reconciledAt,
        record.itemId,
        record.userId,
        record.tenantId,
        record.recordVersion,
      );
      assertDecisionScopedUpdateApplied(itemUpdate, 'reconcile_partial_execution_item_not_applied', {
        decisionId: record.itemId,
        executionId: execution.executionId,
      });
    }
  })();
  emitDecisionLifecycleEvent({
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    event: 'execution_reconciled',
    actionId: execution.actionId,
    toStatus: verification.outcome === 'applied' ? 'actioned' : 'ready_for_review',
    reason: verification.outcome === 'applied' ? 'authoritative_state_applied' : 'authoritative_state_not_applied',
  });
  logger.info({
    event: 'decision.execution_recovered',
    decisionId: record.itemId,
    actionExecutionId: execution.executionId,
    actionId: execution.actionId,
    outcome: verification.outcome,
    userId: record.userId,
    tenantId: record.tenantId,
  }, 'Decision partial execution was reconciled against authoritative source state');
  return verification.outcome;
}



export function verifyUncertainDecisionExecution(
  record: DecisionRecord,
  actionId: string,
  expected: Record<string, unknown>,
): { outcome: Exclude<DecisionExecutionReconciliationOutcome, 'none'>; actualEffect: Record<string, unknown> } {
  if (record.status === 'actioned' && record.actionResult?.actionId === actionId) {
    return { outcome: 'applied', actualEffect: { decisionProjectionAlreadyActioned: true } };
  }
  if (actionId === 'activate_training_coach_v2_proposal'
      && record.relatedEntityType === 'training_coach_v2_proposal'
      && record.relatedEntityId) {
    const evidence = getDb().prepare(`
      SELECT kind, plan_id AS planId, week_id AS weekId, state,
             decision_id AS decisionId,
             activation_result_json AS activationResultJson
        FROM training_coach_v2_proposals
       WHERE proposal_id = ? AND tenant_id = ? AND user_id = ?
       LIMIT 1
    `).get(record.relatedEntityId, record.tenantId, record.userId) as {
      kind: string;
      planId: number;
      weekId: number | null;
      state: string;
      decisionId: string | null;
      activationResultJson: string | null;
    } | undefined;
    if (!evidence || evidence.decisionId !== record.itemId) {
      return { outcome: 'unknown', actualEffect: { proposalState: evidence?.state ?? 'missing' } };
    }
    if (evidence.state === 'activated' && evidence.activationResultJson) {
      const stored = safeParseJson<Record<string, unknown>>(evidence.activationResultJson, {});
      return {
        outcome: 'applied',
        actualEffect: privacySafeTrainingCoachV2Effect(evidence, stored),
      };
    }
    if (evidence.state === 'proposal_created') {
      return { outcome: 'not_applied', actualEffect: { proposalState: evidence.state } };
    }
    return { outcome: 'unknown', actualEffect: { proposalState: evidence.state, partialEvidence: true } };
  }
  if (actionId === 'activate_training_plan_revision'
      && record.relatedEntityType === 'training_plan_revision'
      && record.relatedEntityId) {
    const evidence = getDb().prepare(`
      SELECT revisions.lifecycle_state AS revisionState,
             revisions.approval_state AS approvalState,
             refs.active_revision_id AS activeRevisionId,
             refs.projection_plan_id AS projectionPlanId,
             refs.pointer_version AS pointerVersion,
             plans.status AS planStatus,
             plans.source_revision_id AS planSourceRevisionId,
             approvals.action_execution_id AS approvalExecutionId,
             approvals.approved_content_hash AS approvedContentHash
        FROM training_plan_revisions revisions
        LEFT JOIN training_active_plan_references refs
          ON refs.tenant_id = revisions.tenant_id
         AND refs.user_id = revisions.user_id
         AND refs.family_id = revisions.family_id
         AND refs.active_revision_id = revisions.revision_id
        LEFT JOIN fitness_training_plans plans
          ON plans.id = refs.projection_plan_id
         AND plans.tenant_id = revisions.tenant_id
         AND plans.user_id = revisions.user_id
        LEFT JOIN training_plan_revision_approvals approvals
          ON approvals.tenant_id = revisions.tenant_id
         AND approvals.user_id = revisions.user_id
         AND approvals.revision_id = revisions.revision_id
         AND approvals.decision_id = ?
       WHERE revisions.revision_id = ?
         AND revisions.user_id = ? AND revisions.tenant_id = ?
       LIMIT 1
    `).get(
      record.itemId,
      record.relatedEntityId,
      record.userId,
      record.tenantId,
    ) as {
      revisionState: string;
      approvalState: string;
      activeRevisionId: string | null;
      projectionPlanId: number | null;
      pointerVersion: number | null;
      planStatus: string | null;
      planSourceRevisionId: string | null;
      approvalExecutionId: string | null;
      approvedContentHash: string | null;
    } | undefined;
    const outbox = getDb().prepare(`
      SELECT idempotency_key AS idempotencyKey
        FROM event_outbox
       WHERE tenant_id = ? AND user_id = ?
         AND event_type = 'training.plan_revision.activated.v1'
         AND entity_id = ?
         AND idempotency_key = ?
       LIMIT 1
    `).get(
      record.tenantId,
      record.userId,
      record.relatedEntityId,
      `training.plan_revision.activated:${record.relatedEntityId}`,
    ) as { idempotencyKey: string } | undefined;
    const applied = evidence?.revisionState === 'ACTIVE'
      && evidence.approvalState === 'APPROVED'
      && evidence.activeRevisionId === record.relatedEntityId
      && evidence.projectionPlanId != null
      && evidence.planStatus === 'active'
      && evidence.planSourceRevisionId === record.relatedEntityId
      && !!evidence.approvalExecutionId
      && !!evidence.approvedContentHash
      && !!outbox;
    if (applied) {
      return {
        outcome: 'applied',
        actualEffect: {
          trainingState: 'ACTIVE',
          activeRevisionId: record.relatedEntityId,
          projectionPlanId: evidence.projectionPlanId,
          pointerVersion: evidence.pointerVersion,
          activationOutboxPresent: true,
        },
      };
    }
    const cleanlyNotApplied = !!evidence
      && evidence.revisionState === 'PENDING_REVIEW'
      && evidence.approvalState === 'PENDING'
      && evidence.activeRevisionId == null
      && evidence.projectionPlanId == null
      && evidence.approvalExecutionId == null
      && !outbox;
    return cleanlyNotApplied
      ? { outcome: 'not_applied', actualEffect: { trainingState: 'PENDING_REVIEW' } }
      : { outcome: 'unknown', actualEffect: { trainingState: evidence?.revisionState ?? 'missing', partialEvidence: true } };
  }
  if (actionId === 'mark_paid' && record.relatedEntityType === 'finance_tax_event' && record.relatedEntityId) {
    const year = Number(record.relatedEntityId.slice(0, 4));
    const event = getTaxEvents(record.userId, { year, tenantId: record.tenantId })
      .find((candidate) => candidate.month === record.relatedEntityId);
    if (!event) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    return event.status === 'paid'
      ? { outcome: 'applied', actualEffect: { paymentStatus: 'paid', targetRef: record.relatedEntityId } }
      : { outcome: 'not_applied', actualEffect: { paymentStatus: event.status, targetRef: record.relatedEntityId } };
  }
  if ((actionId === 'approve_script' || actionId === 'request_rewrite')) {
    const objectId = contentWorkflowObjectIdForDecision(record);
    const object = objectId ? getContentWorkflowObject(record.userId, objectId, record.tenantId) : null;
    if (!object) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    const expectedState = actionId === 'approve_script' ? 'approved' : 'rewrite_requested';
    const sourceMatches = actionId === 'approve_script'
      ? object.productionState === 'approved' && object.approvalState === 'approved'
      : object.productionState === 'active'
        && object.approvalState === 'not_required'
        && hasContentRewriteDecisionEvidence(record, object.id);
    if (sourceMatches) {
      return { outcome: 'applied', actualEffect: { contentObjectId: object.id, contentApprovalState: expectedState } };
    }
    // `active`/`not_required` is also the ordinary state after a user resumes
    // editing. Without the deterministic Decision receipt and its matching
    // audit event, recovery cannot attribute that state to request_rewrite.
    // Keep the execution uncertain so a retry cannot overwrite newer work.
    if (actionId === 'request_rewrite'
        && object.productionState === 'active'
        && object.approvalState === 'not_required') {
      return {
        outcome: 'unknown',
        actualEffect: {
          contentObjectId: object.id,
          contentApprovalState: object.approvalState,
          explicitDecisionEvidence: false,
        },
      };
    }
    if (!['approved', 'rejected'].includes(object.approvalState)) {
      return { outcome: 'not_applied', actualEffect: { contentObjectId: object.id, contentApprovalState: object.approvalState } };
    }
    return { outcome: 'unknown', actualEffect: { contentObjectId: object.id, contentApprovalState: object.approvalState } };
  }
  if ((actionId === 'accept_reflow' || actionId === 'choose_another_time')
      && record.relatedEntityType === 'secretary_agenda_item' && record.relatedEntityId) {
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    if (agenda.lifecycleState === 'reflowed' && agenda.decisionAction === 'reflowed') {
      const selectedHash = privacySafeStateHash({ startAt: agenda.startAt, endAt: agenda.endAt });
      if (typeof expected.targetStateHash !== 'string' || expected.targetStateHash === selectedHash) {
        return { outcome: 'applied', actualEffect: { lifecycleState: 'reflowed', targetStateHash: selectedHash } };
      }
      return { outcome: 'unknown', actualEffect: { lifecycleState: agenda.lifecycleState, targetStateHash: selectedHash } };
    }
    const expectedRevision = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
      ?.preconditions.find((precondition) => precondition.type === 'agenda_state' && precondition.ref === record.relatedEntityId)
      ?.expectedVersion;
    return expectedRevision && secretaryAgendaStateRevision(agenda) === expectedRevision
      ? { outcome: 'not_applied', actualEffect: { lifecycleState: agenda.lifecycleState } }
      : { outcome: 'unknown', actualEffect: { lifecycleState: agenda.lifecycleState } };
  }
  if (actionId === 'undo_reflow'
      && record.relatedEntityType === 'secretary_agenda_item'
      && record.relatedEntityId) {
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return { outcome: 'unknown', actualEffect: { sourceState: 'missing' } };
    const rollback = record.actionResult?.rollback;
    const previous = rollback && typeof rollback === 'object' && !Array.isArray(rollback)
      ? (rollback as Record<string, unknown>).previous
      : null;
    const redactExplanation = !!previous && typeof previous === 'object' && !Array.isArray(previous)
      && !Object.prototype.hasOwnProperty.call(previous, 'explanation');
    const actualStateHash = privacySafeStateHash(secretaryAgendaRollbackSnapshot(agenda, { redactExplanation }));
    if (typeof expected.expectedStateHash === 'string' && expected.expectedStateHash === actualStateHash) {
      return { outcome: 'applied', actualEffect: { rollbackStateHash: actualStateHash } };
    }
    return { outcome: 'unknown', actualEffect: { rollbackStateHash: actualStateHash } };
  }
  if (actionId === 'add_meal' && record.relatedEntityType === 'meal_plan' && record.relatedEntityId) {
    const target = record.relatedEntityId.match(/^(\d{4}-\d{2}-\d{2}):([^:]+)$/);
    if (!target) return { outcome: 'unknown', actualEffect: { sourceState: 'invalid_target' } };
    const meal = getMealPlan(record.userId, target[1], target[1], record.tenantId)
      .find((candidate) => candidate.meal_type === target[2]);
    if (!meal) return { outcome: 'not_applied', actualEffect: { mealPlanState: 'missing' } };
    const titleHash = privacySafeStateHash(meal.title);
    return typeof expected.titleHash !== 'string' || expected.titleHash === titleHash
      ? { outcome: 'applied', actualEffect: { mealPlanId: meal.id, mealPlanState: 'present', titleHash } }
      : { outcome: 'unknown', actualEffect: { mealPlanId: meal.id, mealPlanState: 'different_value', titleHash } };
  }
  if (actionId === 'accept_chat_action_fix') {
    return { outcome: 'applied', actualEffect: { providerActionExecuted: false, freshConfirmationRequired: true } };
  }
  if (actionId === 'option_a' || actionId === 'option_b') {
    const pending = getPendingChatConfirmation(record.userId, record.tenantId);
    if (pending && (!record.relatedEntityId || pending.id === record.relatedEntityId)) {
      return { outcome: 'not_applied', actualEffect: { pendingConfirmationState: 'present' } };
    }
    return { outcome: 'applied', actualEffect: { pendingConfirmationState: 'cleared' } };
  }
  return { outcome: 'unknown', actualEffect: { verifier: expected.verifier ?? 'unavailable' } };
}



/**
 * Proves that the canonical review-to-active transition was the exact rewrite
 * action for this Decision, rather than an unrelated user or agent edit.
 * Both durable records are required: the receipt gives idempotent mutation
 * identity and the workflow event gives human-auditable action provenance.
 */
export function hasContentRewriteDecisionEvidence(record: DecisionRecord, objectId: number): boolean {
  const parentKey = `decision-content:${record.itemId}:request_rewrite`;
  const compactKey = `${parentKey}:rewrite_requested`;
  const receiptKey = compactKey.length <= 200
    ? compactKey
    : `${parentKey.slice(0, 180)}:rewrite_requested`;
  const receipt = getDb().prepare(`
    SELECT resource_id AS resourceId, result_metadata_json AS resultMetadataJson
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(
    record.tenantId,
    record.userId,
    `transition_item:${objectId}`,
    receiptKey,
  ) as { resourceId: string; resultMetadataJson: string } | undefined;
  if (!receipt || String(receipt.resourceId) !== String(objectId)) return false;
  const receiptMetadata = safeParseJson<Record<string, unknown>>(receipt.resultMetadataJson, {});
  if (receiptMetadata.changed !== true) return false;

  const events = getDb().prepare(`
    SELECT metadata_json AS metadataJson, reason_codes_json AS reasonCodesJson
      FROM content_workflow_events
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND object_id = ? AND action = 'workspace_changes_requested'
       AND from_state = 'review' AND to_state = 'active'
       AND approval_state = 'not_required' AND review_required = 0
     ORDER BY id DESC
     LIMIT 20
  `).all(record.tenantId, record.userId, String(objectId)) as Array<{
    metadataJson: string;
    reasonCodesJson: string;
  }>;
  return events.some((event) => {
    const reasonCodes = safeParseJson<unknown[]>(event.reasonCodesJson, []);
    if (!reasonCodes.includes('changes_requested')) return false;
    const metadata = safeParseJson<Record<string, unknown>>(event.metadataJson, {});
    const audit = metadata.auditContext;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return false;
    const context = audit as Record<string, unknown>;
    return context.action === 'request_rewrite'
      && context.decisionId === record.itemId
      && (context.source === 'decision_center' || context.source === 'decision_center_command_bus');
  });
}



export function reclaimExpiredExecutionLeases(userId: number, tenantId: number): void {
  const reclaimed = getDb().transaction(() => {
    const executions = getDb().prepare(`
      UPDATE decision_action_executions
         SET status = 'partially_failed', error_code = 'DECISION_EXECUTION_LEASE_EXPIRED',
             failed_at = COALESCE(failed_at, datetime('now')),
             effect_results_json = ?,
             recovery_json = ?
       WHERE user_id = ? AND tenant_id = ? AND status = 'started'
         AND ((lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime('now'))
           OR (lease_expires_at IS NULL AND datetime(created_at, ?) <= datetime('now')))
    `).run(
      JSON.stringify([{
        effectId: 'decision_action',
        status: 'unknown',
        reasonCode: 'execution_lease_expired',
      }]),
      JSON.stringify({
        message: 'The previous execution lease expired with an uncertain external outcome. Refresh source state before any recovery.',
        actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
      }),
      userId,
      tenantId,
      `+${DECISION_EXECUTION_LEASE_SECONDS} seconds`,
    ).changes;
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = 'partially_failed', updated_at = datetime('now')
       WHERE user_id = ? AND tenant_id = ? AND status = 'started'
         AND datetime(lease_expires_at) <= datetime('now')
    `).run(userId, tenantId);
    return executions;
  })();
  if (reclaimed > 0) {
    logger.warn({ event: 'decision.execution_lease_uncertain', userId, tenantId, count: reclaimed }, 'Expired execution leases require source reconciliation');
  }
}



export function claimExecution(
  record: DecisionRecord,
  actionId: string,
  idempotencyKey: string,
  executorSkill: string,
  options: {
    logicalActionHash: string | null;
    expectedVersion: number;
    contextVersion: string | null;
    mutateRecordVersion: boolean;
    expectedEffect: Record<string, unknown>;
  },
): { isNew: boolean; execution: any } {
  const db = getDb();
  return db.transaction(() => {
    const existing = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey);
    if (existing) return { isNew: false, execution: existing };
    const existingForKey = getExistingExecutionForIdempotencyKey(
      record.itemId,
      record.userId,
      record.tenantId,
      idempotencyKey,
    );
    if (existingForKey) {
      throw new DecisionActionError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different decision action.',
        409,
        { priorActionId: existingForKey.action_id },
      );
    }

    if (options.logicalActionHash) {
      const logical = getExistingLogicalExecution(record.userId, record.tenantId, options.logicalActionHash);
      if (logical) return { isNew: false, execution: logical };
    }

    const executionId = `dae_${randomUUID()}`;
    const leaseExpiresAt = DateTime.utc().plus({ seconds: DECISION_EXECUTION_LEASE_SECONDS }).toISO()!;
    const normalizedAction = options.logicalActionHash
      ? normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
      : null;

    if (options.mutateRecordVersion) {
      const versionClaim = db.prepare(`
        UPDATE notification_center_items
           SET record_version = record_version + 1,
               decision_state = 'approved',
               updated_at = datetime('now')
         WHERE item_id = ? AND user_id = ? AND tenant_id = ?
           AND record_version = ?
           AND (status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
                OR (? = 1 AND status = 'actioned'))
      `).run(record.itemId, record.userId, record.tenantId, options.expectedVersion, actionId === 'undo_reflow' ? 1 : 0);
      if (versionClaim.changes !== 1) {
        const current = getDecisionRecord(record.itemId, record.userId, record.tenantId);
        throw new DecisionActionError(
          'DECISION_VERSION_CONFLICT',
          'Decision changed before execution could be claimed.',
          409,
          decisionVersionConflictDetails(current),
        );
      }
    }

    for (const exclusivityKey of normalizedAction?.exclusivityKeys ?? []) {
      const exclusivityClaim = db.prepare(`
        INSERT INTO decision_exclusivity_claims (
          user_id, tenant_id, exclusivity_key, action_execution_id, decision_id,
          context_version, status, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, datetime('now'), datetime('now'))
        ON CONFLICT(user_id, tenant_id, exclusivity_key) DO UPDATE SET
          action_execution_id = excluded.action_execution_id,
          decision_id = excluded.decision_id,
          context_version = excluded.context_version,
          status = 'started',
          lease_expires_at = excluded.lease_expires_at,
          updated_at = datetime('now')
        WHERE decision_exclusivity_claims.status IN ('succeeded', 'failed', 'expired')
      `).run(
        record.userId,
        record.tenantId,
        exclusivityKey,
        executionId,
        record.itemId,
        options.contextVersion,
        leaseExpiresAt,
      );
      if (exclusivityClaim.changes !== 1) {
        const owner = db.prepare(`
          SELECT decision_id AS decisionId, lease_expires_at AS leaseExpiresAt
            FROM decision_exclusivity_claims
           WHERE user_id = ? AND tenant_id = ? AND exclusivity_key = ?
           LIMIT 1
        `).get(record.userId, record.tenantId, exclusivityKey) as { decisionId: string; leaseExpiresAt: string } | undefined;
        throw new DecisionActionError('DECISION_RESOURCE_BUSY', 'Another decision is already modifying the same resource.', 409, {
          exclusivityKey,
          conflictingDecisionId: owner?.decisionId ?? null,
          leaseExpiresAt: owner?.leaseExpiresAt ?? null,
        });
      }
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id, idempotency_key,
        executor_skill, status, expected_effect_json, result_json, logical_action_hash,
        expected_record_version, context_version, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, '{}', ?, ?, ?, ?)
    `).run(
      executionId,
      record.itemId,
      actionId,
      record.userId,
      record.tenantId,
      idempotencyKey,
      executorSkill,
      JSON.stringify(options.expectedEffect),
      options.logicalActionHash,
      options.expectedVersion,
      options.contextVersion,
      leaseExpiresAt,
    );

    const execution = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey)
      ?? (options.logicalActionHash ? getExistingLogicalExecution(record.userId, record.tenantId, options.logicalActionHash) : null);
    if (!execution) {
      throw new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action execution could not be claimed', 500);
    }
    if (insert.changes === 1) {
      logger.info({
        event: 'decision.execution_claimed',
        decisionId: record.itemId,
        actionId,
        userId: record.userId,
        tenantId: record.tenantId,
        exclusivityKeyCount: normalizedAction?.exclusivityKeys.length ?? 0,
      }, 'Decision execution claimed');
    }
    return { isNew: insert.changes === 1, execution };
  })();
}



export function idempotentActionResult(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  execution: any,
): DecisionActionResult {
  if (typeof execution.decision_id === 'string' && execution.decision_id !== decisionId) {
    retireLogicalDuplicateDecision(decisionId, execution.decision_id, userId, tenantId);
  }
  // Same direct-record path as performDecisionAction's success branch: a duplicate (idempotent) replay of
  // an action that mutated its own source state — e.g. choose_another_time moving the agenda — must return
  // the actioned decision, not be hidden by getDecisionItem's active-inbox visibility filter (which would
  // throw a spurious 404 on a replay of a write that already succeeded).
  const replayRecord = getDecisionRecord(decisionId, userId, tenantId);
  if (actionId === 'approve_product_learning_case'
      && replayRecord?.relatedEntityType === 'product_learning_case'
      && replayRecord.relatedEntityId
      && typeof execution.action_execution_id === 'string') {
    recordLearningCaseReviewApproval({
      tenantId,
      userId,
      caseId: replayRecord.relatedEntityId,
      actionExecutionId: execution.action_execution_id,
    });
  }
  const current = replayRecord && isDecisionRecord(replayRecord) ? formatDecisionItemForApi(replayRecord) : null;
  if (!current) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after idempotent action', 404);
  return {
    actionId,
    status: 'idempotent',
    idempotent: true,
    item: current,
    verification: {
      readBackOk: true,
      expectedEffect: safeParseJson(execution.expected_effect_json, {}),
      actualEffect: safeParseJson(execution.result_json, {}),
      message: 'Duplicate action returned the original verified result.',
    },
  };
}



export function retireLogicalDuplicateDecision(
  decisionId: string,
  canonicalDecisionId: string,
  userId: number,
  tenantId: number,
): void {
  const update = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'superseded', decision_state = 'superseded',
           superseded_by_item_id = ?,
           action_result_json = ?,
           record_version = record_version + 1,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(
    canonicalDecisionId,
    JSON.stringify({ supersededReason: 'logical_action_completed_by_related_decision' }),
    decisionId,
    userId,
    tenantId,
  );
  if (update.changes === 1) {
    resolveDecisionConflictAudit(decisionId, userId, tenantId, 'superseded_by_verified_execution');
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: 'superseded',
      toStatus: 'superseded',
      reason: 'logical_action_completed_by_related_decision',
      metadata: { canonicalDecisionId },
    });
  }
}



export async function waitForExistingExecution(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): Promise<DecisionActionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const execution = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (!execution || execution.status === 'started') continue;
    if (execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, execution);
    }
    throw executionReplayError(execution, 'Prior decision action attempt failed');
  }

  throw new DecisionActionError('DECISION_ACTION_IN_PROGRESS', 'Decision action is already in progress', 409);
}



export async function waitForExecutionById(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  executionId: string,
): Promise<DecisionActionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const execution = getDb().prepare(`
      SELECT * FROM decision_action_executions
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(executionId, userId, tenantId) as any;
    if (!execution || execution.status === 'started') continue;
    if (execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, execution);
    }
    throw executionReplayError(execution, 'Prior logical decision action attempt failed');
  }
  throw new DecisionActionError('DECISION_ACTION_IN_PROGRESS', 'Decision action is already in progress', 409);
}



export function executionReplayError(execution: any, message: string): DecisionActionError {
  const partial = execution?.status === 'partially_failed';
  return new DecisionActionError(
    partial ? 'DECISION_PARTIALLY_FAILED' : execution?.error_code || 'DECISION_ACTION_FAILED',
    partial ? 'The prior attempt partially completed and requires recovery review.' : message,
    409,
    {
      ...safeParseJson(execution?.result_json, {}),
      effectResults: safeParseJson(execution?.effect_results_json, []),
      recovery: safeParseJson(execution?.recovery_json, {}),
      originalErrorCode: execution?.error_code ?? null,
    },
  );
}



export async function executeDecisionAction(
  record: DecisionRecord,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  actionExecutionId?: string,
): Promise<{
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
}> {
  if (action.id === 'open_detail') {
    markNotificationCenterItemRead(record.itemId, userId, tenantId);
    return verifiedStatusEffect(record, 'read', 'Decision was marked viewed.');
  }

  const commandBusExecution = await maybeExecuteDecisionActionViaCommandBus(record, action, userId, tenantId, idempotencyKey);
  if (commandBusExecution) return commandBusExecution;

  if (action.id === 'dismiss' || action.id === 'reject_reflow' || action.id === 'not_now') {
    const item = dismissDecision(
      record.itemId,
      userId,
      tenantId,
      typeof payload.reason === 'string' ? payload.reason : undefined,
      expectedVersion,
      {
      actionId: action.id,
      idempotencyKey,
      },
    );
    markDecisionAction(record.decisionLogId, action.id);
    return {
      readBackOk: item.status === 'dismissed',
      expectedEffect: { decisionStatus: 'dismissed' },
      actualEffect: { decisionStatus: item.status, decisionOutcomeRecorded: true },
      message: 'Decision was declined/dismissed.',
    };
  }

  if (action.id === 'snooze') {
    const item = snoozeDecisionAt(record.itemId, userId, tenantId, String(payload.deferUntil), expectedVersion, {
      actionId: action.id,
      idempotencyKey,
    });
    markDecisionAction(record.decisionLogId, action.id);
    return {
      readBackOk: item.status === 'snoozed',
      expectedEffect: { decisionStatus: 'snoozed' },
      actualEffect: { decisionStatus: item.status, snoozedUntil: item.snoozedUntil },
      message: 'Decision was snoozed.',
    };
  }

  if (action.id === 'approve_script' || action.id === 'request_rewrite') {
    return executeContentApprovalDecision(record, action.id, userId, tenantId);
  }

  if (action.id === 'accept_reflow' || action.id === 'choose_another_time') {
    return executeSecretaryAgendaDecision(record, action.id, userId, tenantId, payload);
  }

  if (action.id === 'undo_reflow') {
    return executeSecretaryReflowRollback(record, userId, tenantId);
  }

  if (action.id === 'mark_paid') {
    return executeFinancePaymentDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'add_meal') {
    return executeCookingMealDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'option_a' || action.id === 'option_b') {
    return executeChatClarificationDecision(record, action.id, userId, tenantId);
  }

  if (action.id === 'accept_chat_action_fix') {
    return executeChatFixerDecision(record, userId, tenantId);
  }

  if (action.id === 'activate_training_coach_v2_proposal') {
    if (!isTrainingCoachV2Enabled()) {
      throw new DecisionActionError(
        'TRAINING_COACH_V2_DISABLED',
        'Coach V2 is currently off. The approved proposal remains pending and no plan state changed.',
        409,
      );
    }
    if (record.sourceSkill !== 'training'
        || record.relatedEntityType !== 'training_coach_v2_proposal'
        || !record.relatedEntityId
        || !actionExecutionId) {
      throw new DecisionActionError(
        'TRAINING_COACH_V2_DECISION_CONTRACT_INVALID',
        'This Training proposal decision is missing its exact activation contract.',
        409,
      );
    }
    const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
    const target = normalized?.targetEntities.find((entry) =>
      entry.type === 'training_coach_v2_proposal' && entry.id === record.relatedEntityId);
    if (!normalized || !target?.version) {
      throw new DecisionActionError(
        'TRAINING_COACH_V2_DECISION_CONTRACT_INVALID',
        'This Training proposal decision cannot prove the approved proposal version.',
        409,
      );
    }
    const activation = await import('../training-coach-v2-proposal-activation');
    try {
      const revisionTarget = normalized.targetEntities.find((entry) =>
        entry.type === 'training_plan_revision');
      const outcome = await activation.executeTrainingCoachV2ProposalDecision({
        tenantId,
        userId,
        proposalId: record.relatedEntityId,
        decisionId: record.itemId,
        expectedRequestHash: target.version,
        decisionRecordVersion: expectedVersion ?? record.recordVersion,
        actionExecutionId,
        approvedRevisionContentHash: revisionTarget?.version,
        approvedContextVersion: normalized.contextVersion,
      });
      const proposal = outcome.proposal;
      const result = outcome.result;
      const readBackOk = proposal.state === 'activated'
        && proposal.proposalId === record.relatedEntityId
        && proposal.decisionId === record.itemId;
      const safeEffect = privacySafeTrainingCoachV2Effect({
        kind: proposal.kind,
        planId: proposal.planId,
        weekId: proposal.weekId,
        state: proposal.state,
      }, result);
      return persistProjectionAfterVerifiedSourceEffect('training_coach_v2_activation_effect', () => {
        const projection = markDecisionActioned(record, action.id, safeEffect,
          'The approved Training change was applied and verified.');
        return {
          readBackOk: readBackOk && projection.readBackOk,
          expectedEffect: {
            proposalState: 'activated',
            proposalId: record.relatedEntityId,
            decisionStatus: 'actioned',
          },
          actualEffect: { ...projection.actualEffect, ...safeEffect },
          message: 'The approved Training change was applied and verified.',
        };
      });
    } catch (error) {
      const lockError = trainingOperationLockPublicError(error);
      if (lockError) {
        throw new DecisionActionError(lockError.code, lockError.message, lockError.status, lockError.details);
      }
      if (error instanceof activation.TrainingCoachV2ProposalStateError) {
        const status = error.code === 'PROPOSAL_NOT_FOUND' ? 404 : 409;
        throw new DecisionActionError(error.code, error.message, status);
      }
      throw error;
    }
  }

  if (action.id === 'activate_training_plan_revision') {
    if (record.sourceSkill !== 'training'
        || record.relatedEntityType !== 'training_plan_revision'
        || !record.relatedEntityId
        || !actionExecutionId) {
      throw new DecisionActionError(
        'TRAINING_REVISION_DECISION_CONTRACT_INVALID',
        'This Training activation decision is missing its immutable revision contract.',
        409,
      );
    }
    const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
    const target = normalized?.targetEntities.find((entry) =>
      entry.type === 'training_plan_revision' && entry.id === record.relatedEntityId);
    if (!normalized || !target?.version) {
      throw new DecisionActionError(
        'TRAINING_REVISION_DECISION_CONTRACT_INVALID',
        'This Training activation decision cannot prove the approved revision version.',
        409,
      );
    }
    const activation = await import('../training-plan-revision-activation');
    try {
      const result = await activation.activateApprovedTrainingPlanRevision({
        scope: { userId, tenantId },
        revisionId: record.relatedEntityId,
        approval: {
          decisionId: record.itemId,
          decisionRecordVersion: expectedVersion ?? record.recordVersion,
          actionExecutionId,
          approvedContentHash: target.version,
          approvedContextVersion: normalized.contextVersion,
        },
      });
      const readBackOk = result.activeReference.activeRevisionId === record.relatedEntityId
        && result.projection.planId === result.activeReference.projectionPlanId;
      return persistProjectionAfterVerifiedSourceEffect('training_activation_effect', () => {
        const projection = markDecisionActioned(record, action.id, {
          trainingState: 'ACTIVE',
          planState: 'active',
          activeRevisionId: result.revisionId,
          familyId: result.familyId,
          projectionPlanId: result.projection.planId,
          pointerVersion: result.activeReference.pointerVersion,
          rollbackAvailable: false,
        }, 'The approved Training plan revision was activated and verified.');
        return {
          readBackOk: readBackOk && projection.readBackOk,
        expectedEffect: {
          trainingState: 'ACTIVE',
          activeRevisionId: record.relatedEntityId,
          decisionStatus: 'actioned',
        },
        actualEffect: {
          ...projection.actualEffect,
          trainingState: 'ACTIVE',
          planState: 'active',
          activeRevisionId: result.revisionId,
          familyId: result.familyId,
          projectionPlanId: result.projection.planId,
          pointerVersion: result.activeReference.pointerVersion,
          rollbackAvailable: false,
        },
        message: 'The approved Training plan revision was activated and verified.',
        };
      });
    } catch (error) {
      const lockError = trainingOperationLockPublicError(error);
      if (lockError) {
        throw new DecisionActionError(
          lockError.code,
          lockError.message,
          lockError.status,
          lockError.details,
        );
      }
      if (error instanceof activation.TrainingPlanRevisionError) {
        throw new DecisionActionError(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  }

  if (action.id === 'approve_product_learning_case') {
    if (record.sourceSkill !== 'training'
        || record.relatedEntityType !== 'product_learning_case'
        || !record.relatedEntityId
        || !actionExecutionId) {
      throw new DecisionActionError(
        'PRODUCT_LEARNING_REVIEW_CONTRACT_INVALID',
        'This learning review decision is missing its exact scoped case contract.',
        409,
      );
    }
    const learningCase = getLearningCase(tenantId, userId, record.relatedEntityId);
    if (!learningCase || learningCase.lifecycle !== 'candidate') {
      throw new DecisionActionError(
        'PRODUCT_LEARNING_CASE_NOT_CANDIDATE',
        'This learning case is no longer a reviewable candidate.',
        409,
      );
    }
    return markDecisionActioned(record, action.id, {
      productLearningCaseId: learningCase.id,
      approved: true,
      approvalReference: learningReviewApprovalReferenceForExecution(actionExecutionId),
    }, 'The exact product learning case review was approved and durably recorded.');
  }

  // Navigation-only: acknowledge and route the client to connection settings.
  // No provider state changes here, so there is nothing to read back — the
  // user completes re-auth in the app. This replaces `retry`, whose executor
  // never existed and which therefore always rendered disabled.
  if (action.id === 'reconnect') {
    return markDecisionActioned(
      record,
      action.id,
      { navigatedTo: 'nexus://connections', providerReauthRequired: true },
      'Opening connection settings.',
    );
  }

  if (MUTATING_ACTIONS.has(action.id)) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'This decision action needs a deterministic executor before Nexus can run it.',
      409,
      { actionId: action.id, sourceSkill: record.sourceSkill, relatedEntityType: record.relatedEntityType },
    );
  }

  throw new DecisionActionError('UNSUPPORTED_DECISION_ACTION', 'This decision action is not supported yet.', 409, { actionId: action.id });
}



/**
 * Active-engine execution consumes the single immutable command envelope.
 * This adapter is the mechanical join between the advertised registry entry
 * and the long-lived domain executors retained in the compatibility kernel.
 */
export async function executeDecisionMutationCommand(
  record: DecisionRecord,
  action: NotificationActionButton,
  command: DecisionMutationCommand<Record<string, unknown>>,
  actionExecutionId: string,
): ReturnType<typeof executeDecisionAction> {
  const descriptor = command.actionId ? findDecisionExecutor(command.actionId) : null;
  if (
    command.decisionId !== record.itemId
    || command.scope.userId !== record.userId
    || command.scope.tenantId !== record.tenantId
    || command.actionId !== action.id
    || !descriptor
    || descriptor.executorKey !== command.execution.executorId
    || (descriptor.readBackKey ?? 'decision.navigation_acknowledgement') !== command.readback.verifierId
  ) {
    throw new DecisionActionError(
      'DECISION_MUTATION_INVALID',
      'Decision command no longer matches its scoped executor and read-back contract.',
      409,
      { actionId: action.id },
    );
  }
  return executeDecisionAction(
    record,
    action,
    command.scope.userId,
    command.scope.tenantId,
    command.idempotencyKey,
    { ...command.payload },
    command.recordVersion ?? undefined,
    actionExecutionId,
  );
}



export async function maybeExecuteDecisionActionViaCommandBus(
  record: DecisionRecord,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): Promise<{
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} | null> {
  if (!isDecisionCenterCommandBusEnabled(process.env, { userId, tenantId })) return null;
  const item = getDecisionItem(record.itemId, userId, tenantId);
  if (!item) return null;

  const adapter = await import('../decision-command-adapter');
  if (!adapter.isDecisionActionBusEligible({ actionId: action.id, item })) return null;
  if ((action.id === 'approve_script' || action.id === 'request_rewrite')
      && !directOwnedContentObjectForDecision(item, userId, tenantId)) return null;

  try {
    const result = await adapter.runDecisionActionViaCommandBus({
      item,
      actionId: action.id,
      userId,
      tenantId,
      idempotencyKey,
      locale: decisionContextForRecord(record).locale,
    });
    markDecisionAction(record.decisionLogId, action.id);
    return result;
  } catch (err) {
    if (err instanceof adapter.DecisionCommandAdapterError) {
      throw new DecisionActionError(err.code, err.message, err.status, err.details);
    }
    throw err;
  }
}



export function verifiedStatusEffect(record: DecisionRecord, expected: string, message: string): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const actual = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
  const readBackOk = actual === expected;
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision action read-back verification failed', 409, {
      expectedStatus: expected,
      actualStatus: actual,
    });
  }
  return {
    readBackOk,
    expectedEffect: { decisionStatus: expected },
    actualEffect: { decisionStatus: actual },
    message,
  };
}



export function executeSecretaryAgendaDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'secretary' || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'Secretary reflow actions require a persisted Secretary agenda item before Nexus can run them.',
      409,
      { relatedEntityType: record.relatedEntityType },
    );
  }

  const initialAgenda = getSecretaryAgendaItemById({ agendaItemId: record.relatedEntityId, ownerUserId: userId, tenantId });
  if (!initialAgenda) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Secretary agenda item was not found for this user.', 404);
  }
  const expectedAgendaRevision = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)
    ?.preconditions.find((precondition) =>
      precondition.type === 'agenda_state' && precondition.ref === record.relatedEntityId)?.expectedVersion;
  const applied = getDb().transaction(() => {
    const agenda = getSecretaryAgendaItemById({ agendaItemId: record.relatedEntityId!, ownerUserId: userId, tenantId });
    if (!agenda) {
      throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Secretary agenda item was not found for this user.', 404);
    }
    if (expectedAgendaRevision && secretaryAgendaStateRevision(agenda) !== expectedAgendaRevision) {
      throw new DecisionActionError(
        'DECISION_CONTEXT_CHANGED',
        'The Secretary agenda item changed before the reflow could be applied.',
        409,
        { reason: 'agenda_state_changed' },
      );
    }
    const rollback = secretaryAgendaRollbackSnapshot(agenda, {
      redactExplanation: isDecisionRollbackSnapshotProtectionEnabled(process.env, { userId, tenantId })
        && (record.privacyPolicy === 'financial' || record.privacyPolicy === 'sensitive'),
    });
    const updates = buildSecretaryAgendaUpdates(actionId, agenda, payload);
    const agendaUpdate = getDb().prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = ?,
             decision_action = ?,
             decision_reason_codes_json = ?,
             decision_explanation = ?,
             start_at = COALESCE(?, start_at),
             end_at = COALESCE(?, end_at),
             scheduled_segments_json = ?,
             updated_at = datetime('now')
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
    `).run(
      updates.lifecycleState,
      updates.decisionAction,
      JSON.stringify(updates.reasonCodes),
      updates.explanation,
      updates.startAt,
      updates.endAt,
      JSON.stringify(updates.startAt && updates.endAt ? [{ start: updates.startAt, end: updates.endAt, label: 'Decision Center choice' }] : agenda.scheduledSegments),
      agenda.agendaItemId,
      userId,
      String(tenantId),
    );
    assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_agenda_decision_update', {
      agendaItemId: agenda.agendaItemId,
      userId,
      tenantId,
    });

    const verified = getSecretaryAgendaItemById({ agendaItemId: agenda.agendaItemId, ownerUserId: userId, tenantId });
    const readBackOk = verified?.lifecycleState === updates.lifecycleState
      && verified.decisionAction === updates.decisionAction
      && (!updates.startAt || verified.startAt === updates.startAt)
      && (!updates.endAt || verified.endAt === updates.endAt);
    if (!readBackOk) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary reflow read-back verification failed', 409, {
        expectedLifecycleState: updates.lifecycleState,
        actualLifecycleState: verified?.lifecycleState ?? null,
        expectedDecisionAction: updates.decisionAction,
        actualDecisionAction: verified?.decisionAction ?? null,
      });
    }
    return { agenda, rollback, updates, verified: verified! };
  }).immediate();
  const { agenda, rollback, verified } = applied;

  return persistProjectionAfterVerifiedSourceEffect('secretary_agenda_effect', () => (
    markDecisionActioned(record, actionId, {
      secretaryAgendaItemId: agenda.agendaItemId,
      lifecycleState: verified.lifecycleState,
      decisionAction: verified.decisionAction,
      startAt: verified.startAt,
      endAt: verified.endAt,
      rollbackAvailable: true,
      rollbackActionId: 'undo_reflow',
      rollbackExpectedRevision: secretaryAgendaStateRevision(verified),
      rollback,
    }, 'Secretary agenda decision was applied.')
  ));
}



export function executeSecretaryReflowRollback(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const rollback = record.actionResult?.rollback;
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This decision does not have a reversible Secretary reflow.', 409);
  }
  const snapshot = rollback as Record<string, unknown>;
  if (snapshot.type !== 'secretary_agenda_item' || typeof snapshot.agendaItemId !== 'string') {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This rollback contract is not valid for Secretary reflow.', 409);
  }
  if (snapshot.agendaItemId !== record.relatedEntityId) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback target no longer matches the decision related entity.', 409);
  }
  const previous = snapshot.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback is missing the prior Secretary state.', 409);
  }
  const prior = previous as Record<string, unknown>;
  const expectedRevision = typeof record.actionResult?.rollbackExpectedRevision === 'string'
    ? record.actionResult.rollbackExpectedRevision
    : null;
  const expectedLifecycleState = stringOrDefault(prior.lifecycleState, 'proposed');
  const verified = getDb().transaction(() => {
    const currentAgenda = getSecretaryAgendaItemById({
      agendaItemId: snapshot.agendaItemId as string,
      ownerUserId: userId,
      tenantId,
    });
    if (!expectedRevision || !currentAgenda
        || secretaryAgendaStateRevision(currentAgenda) !== expectedRevision) {
      throw new DecisionActionError(
        'DECISION_CONTEXT_CHANGED',
        'The Secretary agenda item changed after reflow and cannot be safely restored without fresh review.',
        409,
        { reason: currentAgenda ? 'rollback_target_changed' : 'rollback_target_missing' },
      );
    }
    const agendaUpdate = getDb().prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = ?,
             decision_action = ?,
             decision_reason_codes_json = ?,
             decision_explanation = ?,
             start_at = ?,
             end_at = ?,
             scheduled_segments_json = ?,
             updated_at = datetime('now')
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
    `).run(
      expectedLifecycleState,
      stringOrNull(prior.decisionAction),
      JSON.stringify(Array.isArray(prior.reasonCodes) ? prior.reasonCodes : []),
      stringOrNull(prior.explanation),
      stringOrNull(prior.startAt),
      stringOrNull(prior.endAt),
      JSON.stringify(Array.isArray(prior.scheduledSegments) ? prior.scheduledSegments : []),
      snapshot.agendaItemId,
      userId,
      String(tenantId),
    );
    assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_reflow_rollback_agenda_update', {
      agendaItemId: snapshot.agendaItemId,
      userId,
      tenantId,
    });

    const readBack = getSecretaryAgendaItemById({ agendaItemId: snapshot.agendaItemId as string, ownerUserId: userId, tenantId });
    if (!readBack || readBack.lifecycleState !== expectedLifecycleState) {
      throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary rollback read-back verification failed', 409, {
        expectedLifecycleState,
        actualLifecycleState: readBack?.lifecycleState ?? null,
      });
    }
    return readBack;
  }).immediate();

  return persistProjectionAfterVerifiedSourceEffect('secretary_rollback_effect', () => {
    const decisionUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'actioned', decision_state = 'cancelled', action_result_json = ?,
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND EXISTS (
           SELECT 1 FROM decision_action_executions executions
            WHERE executions.decision_id = notification_center_items.item_id
              AND executions.user_id = notification_center_items.user_id
              AND executions.tenant_id = notification_center_items.tenant_id
              AND executions.action_id = 'undo_reflow'
              AND executions.status = 'started'
         )
    `).run(JSON.stringify({
      actionId: 'undo_reflow',
      rollbackApplied: true,
      rollbackAvailable: false,
      secretaryAgendaItemId: snapshot.agendaItemId,
      lifecycleState: verified.lifecycleState,
      decisionAction: verified.decisionAction,
    }), record.itemId, userId, tenantId, record.recordVersion + 1);
    assertDecisionScopedUpdateApplied(decisionUpdate, 'secretary_reflow_rollback_decision_update', {
      decisionId: record.itemId,
      userId,
      tenantId,
    });
    markDecisionAction(record.decisionLogId, 'undo_reflow');

    return {
      readBackOk: true,
      expectedEffect: { secretaryAgendaLifecycleState: expectedLifecycleState, decisionStatus: 'actioned', executionStatus: 'rolled_back' },
      actualEffect: {
        secretaryAgendaItemId: snapshot.agendaItemId,
        lifecycleState: verified.lifecycleState,
        decisionAction: verified.decisionAction,
        decisionStatus: 'actioned',
        executionStatus: 'rolled_back',
        rollbackAvailable: false,
      },
      message: 'Secretary reflow was undone. This decision is complete; any new change requires a fresh proposal.',
    };
  });
}



export function secretaryAgendaRollbackSnapshot(agenda: SecretaryAgendaItem, opts: { redactExplanation?: boolean } = {}): Record<string, unknown> {
  // The machine fields below are exactly what executeSecretaryReflowRollback restores. `explanation` is the
  // free-text display copy — the most sensitive field; B2 (redactExplanation) omits it for financial/sensitive
  // decisions so it is not persisted in plaintext at rest. The rollback reader tolerates a missing explanation
  // (stringOrNull -> null), so omitting it never breaks undo. OFF keeps the snapshot byte-identical.
  const previous: Record<string, unknown> = {
    lifecycleState: agenda.lifecycleState,
    decisionAction: agenda.decisionAction,
    reasonCodes: agenda.decisionReasonCodes,
    explanation: agenda.decisionExplanation,
    startAt: agenda.startAt,
    endAt: agenda.endAt,
    scheduledSegments: agenda.scheduledSegments,
  };
  // Delete (not skip) so the OFF path keeps the original key order — byte-identical stored snapshot.
  if (opts.redactExplanation) delete previous.explanation;
  return { type: 'secretary_agenda_item', agendaItemId: agenda.agendaItemId, previous };
}



export function buildSecretaryAgendaUpdates(
  actionId: string,
  agenda: SecretaryAgendaItem,
  payload: Record<string, unknown>,
): {
  lifecycleState: string;
  decisionAction: string;
  reasonCodes: string[];
  explanation: string;
  startAt: string | null;
  endAt: string | null;
} {
  if (actionId === 'choose_another_time') {
    const startAt = typeof payload.startAt === 'string' ? payload.startAt : null;
    const endAt = typeof payload.endAt === 'string' ? payload.endAt : null;
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Choosing another time requires valid startAt and endAt values.', 400);
    }
    return {
      lifecycleState: 'reflowed',
      decisionAction: 'reflowed',
      reasonCodes: ['decision_center_user_selected_alternative_time'],
      explanation: 'User selected an alternate time in Decision Center.',
      startAt,
      endAt,
    };
  }

  if (!agenda.startAt || !agenda.endAt) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Accepting reflow requires a Secretary agenda item with a proposed time.', 400);
  }
  return {
    lifecycleState: 'reflowed',
    decisionAction: 'reflowed',
    reasonCodes: ['decision_center_user_accepted_reflow'],
    explanation: 'User accepted Secretary reflow in Decision Center.',
    startAt: null,
    endAt: null,
  };
}



export function executeFinancePaymentDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'finance') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Finance payment action can only run for Finance decisions.', 409);
  }
  const month = typeof payload.month === 'string'
    ? payload.month
    : record.relatedEntityType === 'finance_tax_event'
      ? record.relatedEntityId
      : null;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Finance payment decisions require a YYYY-MM tax event month.', 400);
  }
  if (record.relatedEntityType !== 'finance_tax_event' || month !== record.relatedEntityId) {
    throw new DecisionActionError(
      'DECISION_ACTION_PAYLOAD_MISMATCH',
      'Finance payment target no longer matches the reviewed tax event.',
      409,
    );
  }

  if (!markTaxPaid(userId, month, { tenantId })) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Finance tax event was not found for this user.', 404);
  }
  const year = Number(month.slice(0, 4));
  const verified = getTaxEvents(userId, { year, tenantId }).find((event) => event.month === month);
  if (verified?.status !== 'paid') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Finance payment read-back verification failed', 409, {
      expectedStatus: 'paid',
      actualStatus: verified?.status ?? null,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('finance_payment_effect', () => (
    markDecisionActioned(record, 'mark_paid', {
      financeTaxMonth: month,
      paymentStatus: verified.status,
      paidAt: verified.paid_at,
    }, 'Finance payment was confirmed.')
  ));
}



export function executeCookingMealDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'cooking') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Cooking meal action can only run for Cooking decisions.', 409);
  }
  const date = typeof payload.date === 'string' ? payload.date : null;
  const mealType = typeof payload.mealType === 'string' ? payload.mealType : typeof payload.meal_type === 'string' ? payload.meal_type : null;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !title) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Cooking decisions require date, mealType, and title before Nexus can update the meal plan.', 400);
  }

  const meal = setMealPlan(userId, date, mealType, title, {
    tenantId,
    notes: typeof payload.notes === 'string' ? payload.notes : 'Added from Decision Center',
  });
  const verified = getMealPlan(userId, date, date, tenantId).find((candidate) => candidate.id === meal.id);
  if (!verified || verified.title !== title || verified.meal_type !== mealType) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Cooking meal read-back verification failed', 409, {
      mealFound: !!verified,
      titleMatched: verified?.title === title,
      mealTypeMatched: verified?.meal_type === mealType,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('cooking_meal_effect', () => (
    markDecisionActioned(record, 'add_meal', {
      mealPlanId: verified.id,
      date: verified.date,
      mealType: verified.meal_type,
      title: verified.title,
    }, 'Cooking meal plan was updated.')
  ));
}



export function executeChatClarificationDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'chat') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Chat clarification action can only run for Chat decisions.', 409);
  }
  const pending = getPendingChatConfirmation(userId, tenantId);
  if (!pending || (record.relatedEntityId && pending.id !== record.relatedEntityId)) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Chat clarification was not found or already expired.', 404);
  }
  clearPendingChatConfirmation(userId, tenantId);
  if (getPendingChatConfirmation(userId, tenantId)) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Chat clarification read-back verification failed', 409);
  }

  return persistProjectionAfterVerifiedSourceEffect('chat_confirmation_effect', () => (
    markDecisionActioned(record, actionId, {
      chatConfirmationId: pending.id,
      selectedOption: actionId,
      involvedSkills: pending.involvedSkills,
    }, 'Chat clarification was recorded.')
  ));
}



export function executeChatFixerDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'chat' || record.relatedEntityType !== 'chat_action_fixer_review') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Chat fixer decision is missing a scoped fixer review.', 409);
  }
  if (record.userId !== userId || record.tenantId !== tenantId) {
    throw new DecisionActionError('DECISION_SCOPE_MISMATCH', 'Decision scope mismatch.', 403);
  }
  return markDecisionActioned(record, 'accept_chat_action_fix', {
    fixerReviewId: record.relatedEntityId,
    providerActionExecuted: false,
    freshConfirmationRequired: true,
  }, 'Chat action correction accepted. Nexus will require a fresh confirmation before any provider write.');
}



export function markDecisionActioned(
  record: DecisionRecord,
  actionId: string,
  actualEffect: Record<string, unknown>,
  message: string,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const claimedVersion = record.recordVersion + 1;
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', decision_state = 'completed', actioned_at = datetime('now'), action_result_json = ?,
           updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
       AND EXISTS (
         SELECT 1 FROM decision_action_executions executions
          WHERE executions.decision_id = notification_center_items.item_id
            AND executions.user_id = notification_center_items.user_id
            AND executions.tenant_id = notification_center_items.tenant_id
            AND executions.action_id = ?
            AND executions.status = 'started'
       )
  `).run(
    JSON.stringify({ actionId, ...actualEffect }),
    record.itemId,
    record.userId,
    record.tenantId,
    claimedVersion,
    actionId,
  );
  assertDecisionScopedUpdateApplied(decisionUpdate, 'mark_decision_actioned', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    actionId,
    claimedVersion,
  });
  markDecisionAction(record.decisionLogId, actionId);
  const actualStatus = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
  if (actualStatus !== 'actioned') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision status read-back verification failed', 409, {
      expectedStatus: 'actioned',
      actualStatus,
    });
  }
  return {
    readBackOk: true,
    expectedEffect: { decisionStatus: 'actioned' },
    actualEffect: { decisionStatus: actualStatus, ...actualEffect },
    message,
  };
}



export function persistProjectionAfterVerifiedSourceEffect<T>(effectId: string, projection: () => T): T {
  try {
    return projection();
  } catch (error) {
    const transport = privacySafeTransportErrorDetails(error);
    throw new DecisionActionError(
      'DECISION_SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED',
      'The source effect completed, but Decision Center recovery is required before any retry.',
      500,
      {
        ...transport,
        outcomeState: 'source_effect_verified_projection_failed',
        effectResults: [
          { effectId, status: 'succeeded' },
          { effectId: 'decision_center_projection', status: 'unknown', reasonCode: 'projection_write_failed' },
        ],
      },
    );
  }
}



export function executeContentApprovalDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'content') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const contentObjectId = contentWorkflowObjectIdForDecision(record);
  if (!contentObjectId) {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const object = getContentWorkflowObject(userId, contentObjectId, tenantId);
  if (!object) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Content object was not found for this user.', 404);
  }
  const decision = actionId === 'approve_script' ? 'approved' : 'rewrite_requested';
  const result = decideContentApproval({
    userId,
    tenantId,
    objectId: object.id,
    approvalType: 'content_review',
    expectedWorkflowVersion: object.workflowVersion,
    idempotencyKey: `decision-content:${record.itemId}:${actionId}`,
    decision,
    reason: actionId === 'request_rewrite' ? 'Requested changes from Decision Center' : null,
    metadata: { source: 'decision_center', decisionId: record.itemId, actionId },
  });
  if (!result.ok || !result.object) {
    throw new DecisionActionError('DECISION_ACTION_FAILED', 'Content approval could not be applied.', 409, { status: result.status });
  }

  const verified = getContentWorkflowObject(userId, object.id, tenantId);
  const expectedContentState = decision;
  const readBackOk = decision === 'approved'
    ? verified?.productionState === 'approved' && verified.approvalState === 'approved'
    : verified?.productionState === 'active' && verified.approvalState === 'not_required';
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Content approval read-back verification failed', 409, {
      expectedContentState,
      actualApprovalState: verified?.approvalState ?? null,
      actualProductionState: verified?.productionState ?? null,
    });
  }

  return persistProjectionAfterVerifiedSourceEffect('content_approval_effect', () => (
    markDecisionActioned(record, actionId, {
      contentObjectId: object.id,
      contentApprovalState: expectedContentState,
      workflowState: verified?.productionState,
    }, decision === 'approved' ? 'Content was approved.' : 'Changes were requested.')
  ));
}



export function markExecutionSucceeded(
  executionId: string,
  userId: number,
  tenantId: number,
  expectedEffect: Record<string, unknown>,
  actualEffect: Record<string, unknown>,
): void {
  const effects = expectedEffectResultsForExecution(executionId, 'succeeded');
  getDb().transaction(() => {
    const claimed = getDb().prepare(`
      SELECT expected_effect_json AS expectedEffectJson
        FROM decision_action_executions
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(executionId, userId, tenantId) as { expectedEffectJson: string | null } | undefined;
    const claimedExpected = safeParseJson<Record<string, unknown>>(claimed?.expectedEffectJson, {});
    const durableExpected = {
      ...claimedExpected,
      ...expectedEffect,
      ...(claimedExpected.commandContract ? { commandContract: claimedExpected.commandContract } : {}),
    };
    const executionUpdate = getDb().prepare(`
      UPDATE decision_action_executions
         SET status = 'succeeded',
             expected_effect_json = ?,
             result_json = ?,
             effect_results_json = ?,
             recovery_json = '{}',
             completed_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
         AND status = 'started'
    `).run(JSON.stringify(durableExpected), JSON.stringify(actualEffect), JSON.stringify(effects), executionId, userId, tenantId);
    if (executionUpdate.changes !== 1) {
      throw new DecisionActionError(
        'DECISION_EXECUTION_STATE_CONFLICT',
        'Decision execution was no longer claimable when success was recorded.',
        409,
        { actionExecutionId: executionId },
      );
    }
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = 'succeeded', updated_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, userId, tenantId);
  })();
}



export function reconcileCompletedExecutionAfterResponseFailure(
  executionId: string,
  userId: number,
  tenantId: number,
  execution: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
  },
): 'succeeded' | 'partially_failed' | 'unknown' {
  try {
    markExecutionSucceeded(executionId, userId, tenantId, execution.expectedEffect, execution.actualEffect);
    return 'succeeded';
  } catch (retryError) {
    logger.warn({
      event: 'decision.execution_success_reconciliation_retry_failed',
      err: retryError,
      executionId,
    }, 'Retrying the completed execution success write did not complete');
  }
  try {
    const current = getDb().prepare(`
      SELECT status FROM decision_action_executions
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? LIMIT 1
    `).get(executionId, userId, tenantId) as { status: string } | undefined;
    if (current?.status === 'succeeded') return 'succeeded';
    if (current?.status === 'partially_failed') return 'partially_failed';

    const successfulEffects = expectedEffectResultsForExecution(executionId, execution.readBackOk ? 'succeeded' : 'unknown');
    const effectResults: DecisionEffectResult[] = [
      ...successfulEffects,
      {
        effectId: 'nexus_execution_reconciliation',
        status: 'unknown',
        reasonCode: 'success_ledger_write_unconfirmed',
      },
    ];
    const recovery = {
      message: 'The external effect completed, but Nexus could not fully persist the success response. Refresh before any retry.',
      actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
    };
    getDb().transaction(() => {
      const update = getDb().prepare(`
        UPDATE decision_action_executions
           SET status = 'partially_failed',
               error_code = 'DECISION_SUCCESS_RECONCILIATION_REQUIRED',
               expected_effect_json = ?, result_json = ?, effect_results_json = ?,
               recovery_json = ?, failed_at = datetime('now')
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
      `).run(
        JSON.stringify(execution.expectedEffect),
        JSON.stringify(execution.actualEffect),
        JSON.stringify(effectResults),
        JSON.stringify(recovery),
        executionId,
        userId,
        tenantId,
      );
      if (update.changes !== 1) {
        throw new Error('DECISION_EXECUTION_RECONCILIATION_STATE_CHANGED');
      }
      getDb().prepare(`
        UPDATE decision_exclusivity_claims
           SET status = 'partially_failed', updated_at = datetime('now')
         WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
      `).run(executionId, userId, tenantId);
    })();
    logger.warn({
      event: 'decision.execution_reconciliation_required',
      executionId,
    }, 'Completed effect retained as partially failed pending source reconciliation');
    return 'partially_failed';
  } catch (reconciliationError) {
    logger.error({
      event: 'decision.execution_reconciliation_persistence_failed',
      err: reconciliationError,
      executionId,
    }, 'Completed effect could not be moved out of the active execution state');
    return 'unknown';
  }
}



export function isRetryableTrainingOperationDecisionError(error: DecisionActionError): boolean {
  return (error.code === 'TRAINING_OPERATION_LOCKED'
      || error.code === 'TRAINING_OPERATION_LOCK_UNAVAILABLE')
    && (error.details?.operation === 'plan_activate' || error.details?.operation === 'adapt')
    && typeof error.details.retryAfterSeconds === 'number'
    && Number.isFinite(error.details.retryAfterSeconds);
}



/**
 * Lock acquisition fails before the Training activation writes anything, so
 * consuming the Decision claim would turn a retryable 409/503 into a terminal
 * failed card. Restore the exact pre-claim row and remove only this execution
 * and its exclusivity claims. The version-qualified transaction refuses to
 * overwrite any concurrent Decision mutation.
 */
export function releaseRetryableTrainingActivationExecution(
  record: DecisionRecord,
  executionId: string,
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const restored = db.prepare(`
      UPDATE notification_center_items
         SET status = ?, decision_state = ?, record_version = ?, updated_at = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
         AND status = ? AND decision_state = 'approved' AND record_version = ?
    `).run(
      record.status,
      record.decisionState,
      record.recordVersion,
      record.updatedAt,
      record.itemId,
      record.userId,
      record.tenantId,
      record.status,
      record.recordVersion + 1,
    );
    if (restored.changes !== 1) return false;

    const removedExecution = db.prepare(`
      DELETE FROM decision_action_executions
       WHERE action_execution_id = ? AND decision_id = ?
         AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, record.itemId, record.userId, record.tenantId);
    if (removedExecution.changes !== 1) {
      throw new Error('DECISION_RETRYABLE_TRAINING_EXECUTION_RELEASE_FAILED');
    }
    db.prepare(`
      DELETE FROM decision_exclusivity_claims
       WHERE action_execution_id = ? AND decision_id = ?
         AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(executionId, record.itemId, record.userId, record.tenantId);
    return true;
  })();
}



export function markExecutionFailed(
  executionId: string,
  userId: number,
  tenantId: number,
  errorCode: string,
  details?: Record<string, unknown>,
): 'failed' | 'partially_failed' {
  const uncertainOutcome = isUncertainDecisionExecutionOutcome(errorCode, details);
  const suppliedEffects = normalizeEffectResults(details?.effectResults);
  const inferredEffects = suppliedEffects.length > 0
    ? suppliedEffects
    : expectedEffectResultsForExecution(
      executionId,
      errorCode === 'DECISION_READBACK_MISMATCH' || uncertainOutcome ? 'unknown' : 'failed',
      errorCode,
    );
  const partiallyFailed = errorCode === 'DECISION_READBACK_MISMATCH'
    || uncertainOutcome
    || (
      inferredEffects.some((effect) => effect.status === 'succeeded' || effect.status === 'compensated')
      && inferredEffects.some((effect) => effect.status === 'failed' || effect.status === 'unknown')
    );
  const status = partiallyFailed ? 'partially_failed' : 'failed';
  const recovery = {
    message: partiallyFailed
      ? 'Some effects may have completed. Refresh source state before choosing a recovery action.'
      : 'The action did not complete. Refresh the decision before retrying.',
    actions: [{ id: 'refresh', label: 'Refresh', style: 'secondary' }],
  };
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE decision_action_executions
         SET status = ?,
             error_code = ?,
             result_json = ?,
             effect_results_json = ?,
             recovery_json = ?,
             failed_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ?
         AND status = 'started'
    `).run(
      status,
      errorCode,
      JSON.stringify(details ?? {}),
      JSON.stringify(inferredEffects),
      JSON.stringify(recovery),
      executionId,
      userId,
      tenantId,
    );
    getDb().prepare(`
      UPDATE decision_exclusivity_claims
         SET status = ?, updated_at = datetime('now')
       WHERE action_execution_id = ? AND user_id = ? AND tenant_id = ? AND status = 'started'
    `).run(status, executionId, userId, tenantId);
  })();
  if (partiallyFailed) {
    logger.warn({ event: 'decision.execution_partially_failed', executionId, errorCode }, 'Decision execution partially failed');
  }
  return status;
}



export function isUncertainDecisionExecutionOutcome(
  errorCode: string,
  details?: Record<string, unknown>,
): boolean {
  const values = [
    errorCode,
    typeof details?.originalCode === 'string' ? details.originalCode : '',
    typeof details?.providerCode === 'string' ? details.providerCode : '',
    typeof details?.causeCode === 'string' ? details.causeCode : '',
    typeof details?.dispatchState === 'string' ? details.dispatchState : '',
    typeof details?.outcomeState === 'string' ? details.outcomeState : '',
  ].join(':').toUpperCase();
  return /TIMEOUT|TIMED_OUT|ETIMEDOUT|NETWORK|PROVIDER_NETWORK_ERROR|FETCH_FAILED|CONNECTION_(RESET|ABORTED|CLOSED)|ECONNRESET|ECONNABORTED|EPIPE|SOCKET_HANG_UP|UNKNOWN_PROVIDER_OUTCOME|DISPATCHED_OUTCOME_UNKNOWN|SOURCE_EFFECT_VERIFIED_PROJECTION_FAILED/.test(values);
}



/**
 * Collapse a provider/network error chain into closed, non-sensitive codes.
 * Node fetch commonly exposes only `TypeError: fetch failed` at the top and a
 * transport code in `cause`; persisting neither raw message nor provider body
 * still lets the execution ledger fail safely as an uncertain outcome.
 */
export function privacySafeTransportErrorDetails(error: unknown): {
  originalCode: string;
  causeCode?: string;
} {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') codes.push(normalizeTransportCode(record.code));
    if (typeof record.message === 'string' && /fetch\s+failed/i.test(record.message)) codes.push('FETCH_FAILED');
    if (typeof record.name === 'string' && /timeout/i.test(record.name)) codes.push('TIMEOUT');
    current = record.cause;
  }
  const normalized = codes.filter((code) => code !== 'UNKNOWN');
  return {
    originalCode: normalized[0] ?? 'UNKNOWN',
    ...(normalized[1] ? { causeCode: normalized[1] } : {}),
  };
}



export function normalizeTransportCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_:-]+/g, '_').slice(0, 80);
  return code || 'UNKNOWN';
}



export function expectedEffectResultsForExecution(
  executionId: string,
  status: DecisionEffectResult['status'],
  reasonCode?: string,
): DecisionEffectResult[] {
  const row = getDb().prepare(`
    SELECT intents.normalized_action_json AS normalizedActionJson
      FROM decision_action_executions executions
      JOIN notification_center_items items
        ON items.item_id = executions.decision_id
       AND items.user_id = executions.user_id AND items.tenant_id = executions.tenant_id
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id AND intents.tenant_id = items.tenant_id
     WHERE executions.action_execution_id = ?
     LIMIT 1
  `).get(executionId) as { normalizedActionJson: string | null } | undefined;
  const action = row?.normalizedActionJson
    ? normalizeDecisionAction(safeParseJson(row.normalizedActionJson, null))
    : null;
  const effects = action?.expectedEffects ?? [];
  if (effects.length === 0) {
    return [{ effectId: 'decision_action', status, ...(reasonCode ? { reasonCode } : {}) }];
  }
  return effects.map((effect) => ({
    effectId: `${effect.type}:${effect.targetRef}`,
    status,
    ...(reasonCode ? { reasonCode } : {}),
  }));
}



export function normalizeEffectResults(value: unknown): DecisionEffectResult[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.effectId !== 'string'
      || !['pending', 'succeeded', 'failed', 'compensated', 'unknown'].includes(String(candidate.status))) return [];
    return [{
      effectId: candidate.effectId,
      status: candidate.status as DecisionEffectResult['status'],
      ...(typeof candidate.reasonCode === 'string' ? { reasonCode: candidate.reasonCode } : {}),
    }];
  });
}



export function markDecisionFailed(record: DecisionRecord, actionId: string, errorCode: string): void {
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'failed', decision_state = 'ready_for_review', action_result_json = ?,
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed') AND record_version = ?
  `).run(
    JSON.stringify({ actionId, errorCode }),
    record.itemId,
    record.userId,
    record.tenantId,
    record.recordVersion,
  );
  if (decisionUpdate.changes !== 1) {
    logger.warn({
      event: 'decision.failure_projection_version_conflict',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      actionId,
      errorCode,
      expectedVersion: record.recordVersion,
    }, 'Decision failure projection did not overwrite a concurrent lifecycle change');
    return;
  }
  logger.warn({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, actionId, errorCode }, 'Decision action failed without closing decision as actioned');
}



export function markDecisionAction(decisionLogId: string | null, actionId: string): void {
  if (!decisionLogId) return;
  getDb().prepare(`
    UPDATE notification_decision_logs
       SET action_taken = ?, opened_at = COALESCE(opened_at, datetime('now'))
     WHERE decision_log_id = ?
  `).run(actionId, decisionLogId);
}



export function sourceStateSupersessionReason(record: DecisionRecord): string | null {
  if (record.sourceSkill === 'content' && recordHasAction(record, CONTENT_APPROVAL_ACTION_IDS)) {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (!contentObjectId) return 'content_object_missing';
    const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
    if (!object) return 'content_object_missing';
    if (object.approvalState === 'approved' || object.approvalState === 'rejected') {
      return 'content_approval_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'secretary' && record.relatedEntityType === 'task_attention_day') {
    const reason = secretaryDailyTaskAttentionSupersessionReason(record);
    if (reason) return reason;
  }
  if (record.sourceSkill === 'secretary' && recordHasAction(record, SECRETARY_REFLOW_ACTION_IDS)) {
    if (record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
      return 'secretary_reflow_missing_agenda_item';
    }
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return 'secretary_agenda_missing';
    if (['reflowed', 'scheduled', 'completed', 'canceled', 'superseded'].includes(agenda.lifecycleState)) {
      return 'calendar_conflict_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'training') {
    if (record.relatedEntityType === 'training_plan_revision' && record.relatedEntityId
        && tableExists('training_plan_revisions')) {
      const revision = getDb().prepare(`
        SELECT lifecycle_state AS lifecycleState, approval_state AS approvalState,
               decision_id AS decisionId, content_hash AS contentHash,
               creation_context_version AS contextVersion
          FROM training_plan_revisions
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(record.relatedEntityId, record.userId, record.tenantId) as {
        lifecycleState: string;
        approvalState: string;
        decisionId: string | null;
        contentHash: string;
        contextVersion: string;
      } | undefined;
      if (!revision) return 'training_plan_revision_missing';
      if (revision.lifecycleState === 'ACTIVE') return 'training_plan_revision_activated_elsewhere';
      // During createDecisionIntent the Decision row exists a few statements
      // before the producer CAS-binds its ID to the immutable candidate. This
      // narrow initial state is safe because no action can execute before the
      // producer finishes the bind and returns the candidate response.
      if (revision.lifecycleState === 'CANDIDATE'
          && revision.approvalState === 'UNREVIEWED'
          && revision.decisionId == null) return null;
      if (revision.lifecycleState !== 'PENDING_REVIEW'
          || revision.approvalState !== 'PENDING'
          || revision.decisionId !== record.itemId) return 'training_plan_revision_changed_elsewhere';
      const normalized = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
      const targetVersion = normalized?.targetEntities.find((entry) =>
        entry.type === 'training_plan_revision' && entry.id === record.relatedEntityId)?.version;
      if (!normalized || targetVersion !== revision.contentHash
          || normalized.contextVersion !== revision.contextVersion) {
        return 'training_plan_revision_changed_elsewhere';
      }
    }
    if (record.relatedEntityType === 'training_plan' && tableExists('fitness_training_plans')) {
      const plan = getDb().prepare(`
        SELECT status, updated_at FROM fitness_training_plans
         WHERE id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(record.relatedEntityId, record.userId, record.tenantId) as { status?: string; updated_at?: string } | undefined;
      if (!plan) return 'training_plan_missing';
      if (plan.status && ['superseded', 'cancelled', 'canceled', 'completed'].includes(plan.status)) {
        return 'training_plan_changed_elsewhere';
      }
      if (plan.updated_at && Date.parse(plan.updated_at) > Date.parse(record.createdAt)) {
        return 'training_plan_changed_elsewhere';
      }
    }
    if (record.relatedEntityType === 'training_profile' && trainingRaceDatePresent(record.userId, record.tenantId)) {
      return 'training_race_date_added_elsewhere';
    }
    if (isMissingRaceDateRecipe(record.dedupeKey) && trainingRaceDatePresent(record.userId, record.tenantId)) {
      return 'training_race_date_added_elsewhere';
    }
  }
  if (record.sourceSkill === 'finance' && recordHasAction(record, FINANCE_PAYMENT_ACTION_IDS)) {
    if (record.relatedEntityType !== 'finance_tax_event' || !record.relatedEntityId) {
      return 'finance_tax_event_missing';
    }
    if (!/^\d{4}-\d{2}$/.test(record.relatedEntityId)) return 'finance_tax_event_missing';
    const year = Number(record.relatedEntityId.slice(0, 4));
    const event = getTaxEvents(record.userId, { year, tenantId: record.tenantId })
      .find((candidate) => candidate.month === record.relatedEntityId);
    if (!event) return 'finance_tax_event_missing';
    if (event.status === 'paid') return 'finance_payment_resolved_elsewhere';
  }
  return null;
}



export function secretaryDailyTaskAttentionSupersessionReason(record: DecisionRecord): string | null {
  if (!record.relatedEntityId || !/^\d{4}-\d{2}-\d{2}$/.test(record.relatedEntityId)) return null;
  // Daily task-attention decisions are intentionally personal-tenant only.
  // The producer rejects tenant != user because the current task read model is
  // user-scoped. Preserve that invariant for malformed or legacy rows before
  // making any user-only task read; an unverifiable row must remain open.
  if (record.tenantId !== record.userId) return null;
  let tasks: NormalizedTask[];
  try {
    tasks = listTasksForUser(record.userId, { status: 'pending' });
  } catch {
    return null;
  }
  const hasAttentionNeed = tasks.some((task) => secretaryTaskStillNeedsAttention(task, record.relatedEntityId!));
  return hasAttentionNeed ? null : 'secretary_daily_attention_resolved_elsewhere';
}



export function secretaryTaskStillNeedsAttention(task: NormalizedTask, localDate: string): boolean {
  if (task.status !== 'pending') return false;
  // M10 P-scale (NEX-17): high-importance means the P1/P2 bucket.
  if (priorityToImportance(task.priority) === 'high') return true;
  const dueKey = secretaryTaskDueDateKey(task);
  return Boolean(dueKey && dueKey <= localDate);
}



export function secretaryTaskDueDateKey(task: NormalizedTask): string | null {
  if (!task.dueDate) return null;
  const parsed = DateTime.fromISO(task.dueDate, { setZone: true });
  if (parsed.isValid) return parsed.toISODate();
  const prefix = task.dueDate.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
}



export function supersedeIfSourceStateStale(record: DecisionRecord): string | null {
  const reason = sourceStateSupersessionReasonForRead(record);
  if (!reason) return null;
  supersedeDecision(record, reason);
  return reason;
}



/**
 * Pure read-side source check. It may query current local state, but it never
 * changes lifecycle, history, metrics, or delivery state. Explicit jobs and
 * command paths call `supersedeIfSourceStateStale` when retirement is wanted.
 */
export function sourceStateSupersessionReasonForRead(record: DecisionRecord): string | null {
  if (!['unread', 'read', 'failed', 'snoozed'].includes(record.status)) return null;
  const uncertainExecution = getDb().prepare(`
    SELECT 1 FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND status IN ('started', 'partially_failed')
     LIMIT 1
  `).get(record.itemId, record.userId, record.tenantId);
  // A potentially committed source effect must be reconciled before normal
  // stale-source retirement. Reads remain available and cannot supersede away
  // the recovery contract.
  if (uncertainExecution) return null;
  return sourceStateSupersessionReason(record);
}



export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
