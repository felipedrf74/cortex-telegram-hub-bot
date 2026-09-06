// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center read projection ranking service implementation.
 * Keep persistence, authorization, and projection behavior in its owning module.
 */

import { createHash, randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import { getDb } from '../database';

import { emitDomainEvent } from '../event-outbox';

import { incrementTrainingGenerationCounter } from '../training-generation-observability';

import { trainingOperationLockPublicError } from '../training-operation-locks';

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
  type DecisionCommandReceipt,
  type DecisionMutationApproval,
  type DecisionMutationChannel,
  type DecisionMutationCommand,
} from './contracts';

import {
  compactDecisionCommandReadback,
  createDecisionCommandReceipt,
  decisionCommandReceiptId,
  persistDecisionCommandReceipt,
  privacySafeDecisionMutationCommandContract,
  readDecisionCommandReceipt,
} from './command-response-receipts';

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
  DecisionActionError,
  actionsForRecord,
  compareCodeUnits,
  decisionContextExpiresAt,
  decisionContextVersion,
  decisionVersionConflictDetails,
  dependencyStateForRecord,
  editableProposalFieldsForRecord,
  expireTrainingPlanRevisionForDecision,
  guardDecisionLifecycleMutation,
  hasApprovedReplacementForContext,
  normalizeDecisionMutationChannel,
  privacySafeStateHash,
  reclaimExpiredExecutionLeases,
  reconcilePartialDecisionExecution,
  rollbackContractForRecord,
  sourceStateSupersessionReasonForRead,
} from './command-service';
import {
  applyDecisionTypeSuppression,
  emitDecisionLifecycleEvent,
  humanizeActionId,
  mapActionedDecisionToHandledItem,
  mapHandledByNexusItem,
  recordDecisionConflictEvaluation,
  recordDecisionExposure,
  resolveDecisionConflictAudit,
  withHandledRollbackAction,
} from './lifecycle-preferences-jobs';
import {
  decisionStateForConflictEvaluation,
} from './proposal-service';
import {
  DECISION_INTERNAL_LIST_HARD_CAP,
  MUTATING_ACTIONS,
  DECISION_VERIFICATION_STATE_FIELDS,
  GUIDANCE_BANNED_TERMS,
  GUIDANCE_DISPLAY_SECTIONS,
  appNowIso,
  assertScope,
  compareDecisionApiItemsByRank,
  contentWorkflowObjectIdForDecision,
  decisionFlowV1EnforcedForRecord,
  decisionGuidanceStats,
  executorSkillForAction,
  isDecisionRecord,
  isTimestampInLocalDay,
  materializeDecisionPriorityScore,
  parseDecisionTimestamp,
  priorityScoreFor,
  safeParseJson,
  stringOrNull,
  timestampMillis,
  urgencyForPriority,
} from './repository';
import {
  DecisionAlternativeOption,
  DecisionAnalysisBundle,
  DecisionApiItem,
  DecisionApprovalLevel,
  DecisionAskNexusContext,
  DecisionCenterOverview,
  DecisionCenterTopSuggestion,
  DecisionContentCard,
  DecisionEffectResult,
  DecisionExecutionSummary,
  DecisionExplanation,
  DecisionExplanationActionLabels,
  DecisionExplanationDisplaySection,
  DecisionExplanationStep,
  DecisionExplanationStepStatus,
  DecisionFinanceCard,
  DecisionGamificationSummary,
  DecisionGuidanceSanitizationResult,
  DecisionOption,
  DecisionRecord,
  DecisionRefreshOptions,
  DecisionRefreshReceipt,
  DecisionSourceTrace,
  DecisionSummary,
  DecisionTimelineSectionKey,
  DecisionTrainingCard,
  DecisionUrgency,
  DecisionUserFacingFilterVerdict,
  DurableDecisionState,
  HandledByNexusItem,
} from './types';



export function listDecisionItems(
  userId: number,
  tenantId = userId,
  opts: {
    status?: string;
    sourceSkill?: NotificationSourceSkill;
    type?: NotificationIntentType;
    urgency?: DecisionUrgency;
    limit?: number;
    maxLimit?: number;
    recordExposure?: boolean;
    materializePriorityScore?: boolean;
  } = {},
): DecisionApiItem[] {
  assertScope(userId, tenantId, 'list_decision_items', opts);
  ensureDecisionCenterTables();
  const clauses = ['items.user_id = ?', 'items.tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('items.status = ?');
    params.push(opts.status);
  } else if (opts.status === 'all') {
    clauses.push("items.status NOT IN ('expired')");
  } else {
    clauses.push("items.status IN ('unread', 'read', 'failed', 'snoozed')");
  }
  if (opts.sourceSkill) {
    clauses.push('items.source_skill = ?');
    params.push(opts.sourceSkill);
  }
  if (opts.type) {
    clauses.push('items.type = ?');
    params.push(opts.type);
  }
  if (opts.status !== 'expired') {
    // A1: keep hard-expired and future-snoozed rows out of the SQL window, not just the in-memory
    // projection, so a backlog of stale rows cannot consume LIMIT and starve valid active decisions.
    clauses.push('(items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))');
    params.push(appNowIso());
    clauses.push('(items.snoozed_until IS NULL OR datetime(items.snoozed_until) <= datetime(?))');
    params.push(appNowIso());
  }
  // Public routes still pass their own 500-row legacy compatibility cap. The
  // immutable snapshot writer needs the complete scoped universe so a valid
  // v2 cursor cannot silently omit decisions after row 500.
  const maxLimit = Math.min(Math.max(opts.maxLimit ?? 200, 1), DECISION_INTERNAL_LIST_HARD_CAP);
  const requestedLimit = Math.min(Math.max(opts.limit ?? 80, 1), maxLimit);
  const shouldMaterializePriorityScore = opts.materializePriorityScore === true;
  params.push(maxLimit);

  // Keep intents.context_observed_at aligned with getDecisionRecord. evaluateUserFacingDecision
  // hides stale action-queue rows only when that timestamp is missing; omitting it here dropped
  // observed DeviceQA/secretary seeds from overview while GET by id still returned needs_action.
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version, intents.context_observed_at
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       COALESCE(items.priority_score, CASE items.priority WHEN 'critical' THEN 100 WHEN 'time_sensitive' THEN 90 WHEN 'active' THEN 70 ELSE 35 END) DESC,
       COALESCE(intents.decision_deadline, items.expires_at, items.created_at) ASC,
       items.created_at DESC
     LIMIT ?
  `).all(...params) as any[];

  const records = rows
    .map(mapDecisionRecord)
    .filter((item) => isDecisionRecord(item))
    // Reads only project current source truth. Lifecycle retirement is owned
    // by the explicit supersession job/mutation path below; a GET must never
    // turn a stale source into durable Decision Center writes.
    .filter((item) => sourceStateSupersessionReasonForRead(item) === null)
    .filter((item) => isUserFacingDecision(item, decisionLogicForRecord(item)).visible)
    .filter((item) => !isSnoozedUntilFuture(item))
    .filter((item) => opts.status === 'expired' || !isDecisionExpired(item))
    .filter((item) => !opts.urgency || urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt) === opts.urgency);
  return records
    .map((record) => ({
      record,
      item: formatDecisionItemForApi(record, { materializePriorityScore: false }),
    }))
    .sort((a, b) => compareDecisionApiItemsByRank(a.item, b.item))
    .slice(0, requestedLimit)
    .map(({ record, item }) => {
      if (shouldMaterializePriorityScore) materializeDecisionPriorityScore(record, item.priorityScore);
      if (opts.recordExposure === true) recordDecisionExposure(record, item);
      return item;
    });
}



/**
 * Materialize the complete privacy-safe v2 card universe for one scope.
 * Callers own transaction boundaries; proposal creation invokes this inside
 * the intent/item/outbox/job transaction.
 */
export function materializeDecisionRankSnapshotForScope(
  userId: number,
  tenantId = userId,
  now = new Date(),
): DecisionRankSnapshot {
  assertScope(userId, tenantId, 'materialize_decision_rank_snapshot');
  ensureDecisionCenterTables();
  const all = listDecisionItems(userId, tenantId, {
    status: 'all',
    limit: DECISION_INTERNAL_LIST_HARD_CAP,
    maxLimit: DECISION_INTERNAL_LIST_HARD_CAP,
    recordExposure: false,
  });
  const expired = listDecisionItems(userId, tenantId, {
    status: 'expired',
    limit: DECISION_INTERNAL_LIST_HARD_CAP,
    maxLimit: DECISION_INTERNAL_LIST_HARD_CAP,
    recordExposure: false,
  });
  const unique = new Map<string, DecisionApiItem>();
  for (const item of [...all, ...expired]) unique.set(item.decisionId, item);
  const visible = applyDecisionTypeSuppression([...unique.values()], userId, tenantId);
  return materializeDecisionRankSnapshot({
    db: getDb(),
    scope: { userId, tenantId },
    items: visible,
    rankingVersion: DECISION_RANKING_VERSION,
    now,
  });
}



export function isUserFacingDecision(record: DecisionRecord, logic: DecisionLogicV2): DecisionUserFacingFilterVerdict {
  const verdict = evaluateUserFacingDecision(record, logic);
  if (!verdict.visible) {
    decisionGuidanceStats.filteredFromUserView += 1;
    decisionGuidanceStats.filteredByReason[verdict.reason] = (decisionGuidanceStats.filteredByReason[verdict.reason] ?? 0) + 1;
  }
  return verdict;
}



export function evaluateUserFacingDecision(record: DecisionRecord, logic: DecisionLogicV2): DecisionUserFacingFilterVerdict {
  const context = decisionContextForRecord(record);
  const visibilityScope = visibilityScopeForItem(record);
  if (visibilityScope === 'system_admin' || visibilityScope === 'tenant_admin') {
    return { visible: false, reason: 'admin_visibility_scope' };
  }
  if (context.internalOnly === true) return { visible: false, reason: 'internal_only' };
  if (context.smoke === true) return { visible: false, reason: 'smoke_decision' };
  if (record.dedupeKey?.startsWith('smoke:')) return { visible: false, reason: 'smoke_decision' };
  if (record.relatedEntityType === 'decision_center_smoke') return { visible: false, reason: 'smoke_decision' };
  if (!logic.quality.safeToShowUser) return { visible: false, reason: 'unsafe_quality' };
  if (!guidanceEnabledForRecord(record)) return { visible: true, reason: 'guidance_disabled' };

  const actionQueue = ['unread', 'read', 'failed', 'open'].includes(record.status);
  if (actionQueue
      && sourceFreshnessForRecord(record, context) === 'stale'
      && record.contextObservedAt == null) {
    return { visible: false, reason: 'stale_action_source' };
  }
  if (actionQueue && record.requiresUserAction && !logic.quality.safeForFrontendAction) {
    return { visible: false, reason: 'unsafe_frontend_action' };
  }
  if (actionQueue && !hasMinimumVisibleGuidance(record, logic)) {
    return { visible: false, reason: 'incomplete_guidance' };
  }
  return { visible: true, reason: 'visible' };
}



export function hasMinimumVisibleGuidance(record: DecisionRecord, logic: DecisionLogicV2): boolean {
  const headline = firstConcreteOrNull([logic.safePreviewTitle, logic.title]);
  const whatHappened = firstConcreteOrNull([logic.problemStatement, logic.safePreviewBody, record.safeBody]);
  const userAction = firstConcreteOrNull([openDecisionUserAction(record, logic)]);
  const labels = guidanceActionLabelsForRecord(record, logic);
  if (!headline || !whatHappened || !userAction) return false;
  if (record.requiresUserAction && record.type !== 'sync_failure' && !labels?.primary) return false;
  return true;
}



export function getDecisionItem(
  decisionId: string,
  userId: number,
  tenantId = userId,
  opts: { recordExposure?: boolean } = {},
): DecisionApiItem | null {
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) return null;
  if (sourceStateSupersessionReasonForRead(record)) return null;
  const logic = decisionLogicForRecord(record);
  if (!isUserFacingDecision(record, logic).visible) return null;
  if (isDecisionExpired(record)) return null;
  return formatDecisionItemForApiWithExposure(record, opts);
}



/**
 * Exact command-side read that retains terminal rows. User-facing list/detail
 * reads continue to apply active-visibility policy, while mutation surfaces
 * need terminal state to replay a previously completed idempotency key.
 */
export function getDecisionItemForCommand(
  decisionId: string,
  userId: number,
  tenantId = userId,
): DecisionApiItem | null {
  assertScope(userId, tenantId, 'get_decision_item_for_command', { decisionId });
  ensureDecisionCenterTables();
  const record = getDecisionRecord(decisionId, userId, tenantId);
  return record && isDecisionRecord(record) ? formatDecisionItemForApi(record) : null;
}



/** Exact scoped APNs preflight. It never falls back to a list page. */
export function evaluateDecisionApnsActionRequest(input: {
  decisionId: string;
  actionId: string;
  userId: number;
  tenantId: number;
  recordVersion: number | null;
  contextVersion: string | null;
}): DecisionApnsActionPolicyDecision {
  assertScope(input.userId, input.tenantId, 'decision_apns_action_preflight', {
    decisionId: input.decisionId,
    actionId: input.actionId,
  });
  const fetchedAt = appNowIso();
  const record = getDecisionRecord(input.decisionId, input.userId, input.tenantId);
  let exactCurrentState: DecisionApnsExactFetchResult;
  if (!record || !isDecisionRecord(record) || isDecisionExpired(record)
      || sourceStateSupersessionReasonForRead(record)) {
    exactCurrentState = {
      fetchKind: 'exact_current_state',
      status: 'not_found',
      fetchedAt,
      decisionId: input.decisionId,
      userId: input.userId,
      tenantId: input.tenantId,
    };
  } else {
    const logic = decisionLogicForRecord(record);
    const dependencies = dependencyStateForRecord(record);
    const executionStatus = executionSummaryForRecord(record).status;
    const normalizedAction = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
    const lifecycleActionIds = new Set(['dismiss', 'snooze', 'not_now']);
    const actionMap = new Map(actionsForRecord(record).map((action) => [action.id, action]));
    if (['unread', 'read', 'failed', 'snoozed'].includes(record.status)) {
      if (!actionMap.has('dismiss')) actionMap.set('dismiss', { id: 'dismiss', label: 'Dismiss', style: 'secondary' });
      if (!actionMap.has('snooze')) actionMap.set('snooze', { id: 'snooze', label: 'Snooze', style: 'secondary' });
    }
    const approval = approvalLevelForRecord(record);
    exactCurrentState = {
      fetchKind: 'exact_current_state',
      status: 'found',
      fetchedAt,
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      recordVersion: record.recordVersion,
      contextVersion: decisionContextVersion(record),
      actions: [...actionMap.values()].map((action) => {
        const lifecycleAction = lifecycleActionIds.has(action.id);
        const effective = computeActionEffectiveStatus(record, action, {
          dependencies,
          logic,
          reconnectAffordance: isDecisionReconnectAffordanceEnabled(process.env, {
            userId: record.userId,
            tenantId: record.tenantId,
          }),
          executionStatus,
        });
        const normalizedRisk = normalizedAction?.risk;
        const riskLevel = lifecycleAction
          ? 'low'
          : normalizedRisk === 'critical' || normalizedRisk === 'high'
            ? 'high'
            : normalizedRisk === 'medium'
              ? 'medium'
              : riskLevelForItem(record);
        return {
          actionId: action.id,
          riskLevel,
          reviewRequired: !lifecycleAction && approval !== 'none',
          executable: effective.effective === 'enabled'
            && (lifecycleAction || isDecisionActionExecutable(action.id)),
        };
      }),
    };
  }
  return evaluateDecisionApnsActionPolicy({
    request: {
      decisionId: input.decisionId,
      actionId: input.actionId,
      userId: input.userId,
      tenantId: input.tenantId,
      recordVersion: input.recordVersion,
      contextVersion: input.contextVersion,
    },
    exactCurrentState,
  });
}



/**
 * Explicit token-zero revalidation against current local authoritative state.
 *
 * Existing three-argument internal calls retain their original behavior. REST
 * and other command surfaces provide a stable key and receive a durable,
 * version-bound replay receipt. The receipt and all refresh-owned database
 * changes commit in one transaction.
 */
export function refreshDecisionItem(
  decisionId: string,
  userId: number,
  tenantId = userId,
  options: DecisionRefreshOptions = {},
): { item: DecisionApiItem; refreshedAt: string; commandReceipt?: DecisionCommandReceipt } | null {
  assertScope(userId, tenantId, 'refresh_decision_item', { decisionId });
  const idempotencyKey = options.idempotencyKey?.trim();
  if (!idempotencyKey) {
    const result = refreshDecisionItemCore(decisionId, userId, tenantId);
    if (result) materializeDecisionRankSnapshotForScope(userId, tenantId);
    return result;
  }
  if (idempotencyKey.length > 200) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_INVALID', 'Refresh idempotency key is too long.', 400);
  }
  if (options.expectedVersion != null
      && (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 1)) {
    throw new DecisionActionError('DECISION_VERSION_INVALID', 'expectedVersion must be a positive integer.', 400);
  }
  if (options.contextVersion != null && !options.contextVersion.trim()) {
    throw new DecisionActionError('DECISION_CONTEXT_VERSION_INVALID', 'contextVersion must be non-empty.', 400);
  }
  ensureDecisionCenterTables();
  const fingerprint = privacySafeStateHash({
    decisionId,
    userId,
    tenantId,
    expectedVersion: options.expectedVersion ?? null,
    contextVersion: options.contextVersion ?? null,
  });
  const existing = readDecisionRefreshReceipt(decisionId, userId, tenantId, idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new DecisionActionError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different refresh precondition.',
        409,
      );
    }
    const commandReceipt = existing.commandReceipt ?? backfillDecisionRefreshCommandReceipt({
      decisionId,
      userId,
      tenantId,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });
    const current = getDecisionRecord(decisionId, userId, tenantId);
    return current ? {
      item: formatDecisionItemForApi(current),
      refreshedAt: existing.refreshedAt,
      commandReceipt,
    } : null;
  }

  const before = getDecisionRecord(decisionId, userId, tenantId);
  if (!before || !isDecisionRecord(before) || isDecisionExpired(before)) return null;
  if (options.expectedVersion != null && before.recordVersion !== options.expectedVersion) {
    throw new DecisionActionError(
      'DECISION_VERSION_CONFLICT',
      'Decision changed before it could be refreshed.',
      409,
      decisionVersionConflictDetails(before),
    );
  }
  const currentContextVersion = decisionContextVersion(before);
  if (options.contextVersion != null && currentContextVersion !== options.contextVersion) {
    throw new DecisionActionError(
      'DECISION_CONTEXT_VERSION_CONFLICT',
      'Decision context changed before it could be refreshed.',
      409,
      { currentContextVersion, recordVersion: before.recordVersion },
    );
  }
  const requestedAt = appNowIso();
  const command = createDecisionMutationCommand({
    commandId: `dmc_${createHash('sha256').update(JSON.stringify({
      decisionId,
      userId,
      tenantId,
      idempotencyKey,
      operation: 'refresh',
    })).digest('hex').slice(0, 32)}`,
    decisionId,
    operation: 'refresh',
    actionId: null,
    scope: { userId, tenantId },
    channel: normalizeDecisionMutationChannel(options.channel),
    idempotencyKey,
    recordVersion: options.expectedVersion ?? before.recordVersion,
    contextVersion: options.contextVersion ?? currentContextVersion,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision.refresh_context',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: false,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision.context_version',
      entityType: 'decision',
      entityId: decisionId,
      mode: 'versioned',
      expectedState: {
        recordVersion: before.recordVersion,
        contextVersion: currentContextVersion,
      },
    },
    payload: {},
    requestedAt,
  });

  return getDb().transaction(() => {
    const replay = readDecisionRefreshReceipt(decisionId, userId, tenantId, idempotencyKey);
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DecisionActionError(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different refresh precondition.',
          409,
        );
      }
      const commandReceipt = replay.commandReceipt ?? backfillDecisionRefreshCommandReceipt({
        decisionId,
        userId,
        tenantId,
        idempotencyKey,
        requestFingerprint: fingerprint,
      });
      const current = getDecisionRecord(decisionId, userId, tenantId);
      return current ? {
        item: formatDecisionItemForApi(current),
        refreshedAt: replay.refreshedAt,
        commandReceipt,
      } : null;
    }
    const result = refreshDecisionItemCore(decisionId, userId, tenantId);
    if (!result) return null;
    const commandReceipt = persistDecisionRefreshReceiptStrict({
      decisionId,
      userId,
      tenantId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      refreshedAt: result.refreshedAt,
      command,
      requestedRecordVersion: options.expectedVersion ?? null,
      requestedContextVersion: options.contextVersion ?? null,
      readback: {
        recordVersion: result.item.recordVersion ?? null,
        contextVersion: result.item.contextVersion ?? null,
        status: result.item.status,
      },
      item: result.item,
    });
    materializeDecisionRankSnapshotForScope(userId, tenantId);
    return { ...result, commandReceipt };
  })();
}



function refreshDecisionItemCore(
  decisionId: string,
  userId: number,
  tenantId: number,
): { item: DecisionApiItem; refreshedAt: string } | null {
  assertScope(userId, tenantId, 'refresh_decision_item', { decisionId });
  ensureDecisionCenterTables();
  reclaimExpiredExecutionLeases(userId, tenantId);
  let record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record) || isDecisionExpired(record)) return null;
  guardDecisionLifecycleMutation(record, 'refresh', { allowPartialRecovery: true });
  const executionReconciliation = reconcilePartialDecisionExecution(record);
  if (executionReconciliation !== 'none') {
    record = getDecisionRecord(decisionId, userId, tenantId);
    if (!record) return null;
    if (executionReconciliation === 'applied' || executionReconciliation === 'unknown') {
      return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
    }
  }
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  if (!decisionRefreshSupportedForRecord(record) || !action) {
    throw new DecisionActionError(
      'DECISION_REFRESH_NOT_SUPPORTED',
      'This decision does not have a registered source-state refresh contract.',
      409,
    );
  }
  const materialContextExpiry = decisionContextExpiresAt(record);
  if (materialContextExpiry && Date.parse(materialContextExpiry) <= Date.now()) {
    const expired = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'expired', decision_state = 'expired',
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(decisionId, userId, tenantId, record.recordVersion);
    if (expired.changes !== 1) {
      throw new DecisionActionError(
        'DECISION_VERSION_CONFLICT',
        'Decision changed while its expired context was being retired.',
        409,
        decisionVersionConflictDetails(getDecisionRecord(decisionId, userId, tenantId)),
      );
    }
    expireTrainingPlanRevisionForDecision(getDb(), decisionId, userId, tenantId);
    emitDecisionLifecycleEvent({
      decisionId,
      userId,
      tenantId,
      event: 'expired',
      toStatus: 'expired',
      reason: 'material_context_expired_refresh_requires_new_proposal',
    });
    record = getDecisionRecord(decisionId, userId, tenantId);
    if (!record) return null;
    return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
  }
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId });
  if (action) {
    const priorContext = decisionContextForRecord(record);
    const priorConflict = priorContext.conflictEvaluation;
    const initialRevalidation = revalidateNormalizedDecisionAction({
      scope: { userId, tenantId },
      action,
      additionalExisting: priorContext.conflictComparisons ?? undefined,
      decisionId,
      decisionApproved: durableDecisionStateForRecord(record) === 'approved',
      replacementApproved: hasApprovedReplacementForContext(record, action.contextVersion),
      // Approval only covers the conflict set the user actually reviewed.
      // A refresh must surface newly discovered soft conflicts instead of
      // treating the prior approval as blanket confirmation.
      confirmationApproved: false,
      confidence: priorContext.candidateConfidence ?? undefined,
      contextExpiresAt: decisionContextExpiresAt(record),
      candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
    });
    const observedPreconditionVersions = observePreconditionVersions(initialRevalidation.preconditions);
    const sourceVersionMismatch = action.preconditions.some((precondition) => {
      const currentVersion = observedPreconditionVersions.get(precondition.ref);
      return !!currentVersion && currentVersion !== precondition.expectedVersion;
    });
    const initialConflictChanged = conflictMaterialKey(priorConflict) !== conflictMaterialKey(initialRevalidation.conflictEvaluation);
    let refreshedAction = action;
    if (sourceVersionMismatch || initialConflictChanged) {
      refreshedAction = rebuildNormalizedActionForContext(
        refreshedAction,
        nextDecisionContextVersion(refreshedAction, initialRevalidation.conflictEvaluation, observedPreconditionVersions),
      );
    }
    let finalRevalidation = refreshedAction.contextVersion === action.contextVersion
      ? initialRevalidation
      : revalidateNormalizedDecisionAction({
        scope: { userId, tenantId },
        action: refreshedAction,
        additionalExisting: priorContext.conflictComparisons ?? undefined,
        decisionId,
        decisionApproved: durableDecisionStateForRecord(record) === 'approved',
        replacementApproved: hasApprovedReplacementForContext(record, refreshedAction.contextVersion),
        confirmationApproved: false,
        confidence: priorContext.candidateConfidence ?? undefined,
        contextExpiresAt: decisionContextExpiresAt(record),
        candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
      });
    let conflict = finalRevalidation.conflictEvaluation;
    let materialChanged = refreshedAction.contextVersion !== action.contextVersion
      || conflictMaterialKey(priorConflict) !== conflictMaterialKey(conflict);
    if (materialChanged) {
      const stableContextVersion = nextDecisionContextVersion(refreshedAction, conflict, observedPreconditionVersions);
      if (refreshedAction.contextVersion !== stableContextVersion) {
        refreshedAction = rebuildNormalizedActionForContext(refreshedAction, stableContextVersion);
        finalRevalidation = revalidateNormalizedDecisionAction({
          scope: { userId, tenantId },
          action: refreshedAction,
          additionalExisting: priorContext.conflictComparisons ?? undefined,
          decisionId,
          decisionApproved: durableDecisionStateForRecord(record) === 'approved',
          replacementApproved: hasApprovedReplacementForContext(record, refreshedAction.contextVersion),
          confirmationApproved: false,
          confidence: priorContext.candidateConfidence ?? undefined,
          contextExpiresAt: decisionContextExpiresAt(record),
          candidateCreatedAt: record.contextObservedAt ?? record.createdAt,
        });
        conflict = finalRevalidation.conflictEvaluation;
        materialChanged = refreshedAction.contextVersion !== action.contextVersion
          || conflictMaterialKey(priorConflict) !== conflictMaterialKey(conflict);
      }
    }
    if (decisionRefreshSupportedForRecord(record)) {
      const context: DecisionLogicContext = {
        ...priorContext,
        normalizedAction: refreshedAction,
        conflictEvaluation: conflict,
      };
      const priorState = durableDecisionStateForRecord(record);
      const nextState = !materialChanged && priorState === 'approved'
        ? 'approved'
        : decisionStateForConflictEvaluation(conflict);
      getDb().transaction(() => {
        const intentUpdate = getDb().prepare(`
          UPDATE notification_intents
             SET decision_context_json = ?, context_version = ?, context_observed_at = ?,
                 candidate_fingerprint = ?, normalized_action_json = ?
           WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
        `).run(
          JSON.stringify(context),
          refreshedAction.contextVersion,
          appNowIso(),
          refreshedAction.candidateFingerprint,
          JSON.stringify(refreshedAction),
          record!.intentId,
          userId,
          tenantId,
        );
        if (intentUpdate.changes !== 1) {
          throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision context could not be refreshed.', 409);
        }
        const itemUpdate = materialChanged
          ? getDb().prepare(`
              UPDATE notification_center_items
                 SET decision_state = ?,
                     status = CASE WHEN ? = 'superseded' THEN 'superseded' ELSE status END,
                     record_version = record_version + 1, updated_at = datetime('now')
               WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
                 AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
            `).run(nextState, nextState, decisionId, userId, tenantId, record!.recordVersion)
          : getDb().prepare(`
              UPDATE notification_center_items
                 SET decision_state = ?,
                     status = CASE WHEN ? = 'superseded' THEN 'superseded' ELSE status END
               WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
                 AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
            `).run(nextState, nextState, decisionId, userId, tenantId, record!.recordVersion);
        if (itemUpdate.changes !== 1) {
          const current = getDecisionRecord(decisionId, userId, tenantId);
          throw new DecisionActionError(
            'DECISION_VERSION_CONFLICT',
            'Decision changed while it was being refreshed.',
            409,
            decisionVersionConflictDetails(current),
          );
        }
      })();
      resolveDecisionConflictAudit(decisionId, userId, tenantId, materialChanged ? 'refreshed_context_changed' : 'refreshed_unchanged');
      recordDecisionConflictEvaluation(record, conflict);
      record = getDecisionRecord(decisionId, userId, tenantId);
      if (!record) return null;
    } else {
      logger.info({
        event: 'decision.revalidation_shadowed',
        decisionId,
        userId,
        tenantId,
        materialChanged,
        priorContextVersion: action.contextVersion,
        refreshedContextVersion: refreshedAction.contextVersion,
        disposition: conflict.disposition,
      }, 'Decision refresh conflict revalidation completed in shadow mode');
    }
  }
  return { item: formatDecisionItemForApi(record), refreshedAt: DateTime.utc().toISO()! };
}



export function decisionRefreshReceiptEventId(
  decisionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): string {
  return `dle_refresh_${createHash('sha256').update(JSON.stringify({
    decisionId,
    userId,
    tenantId,
    idempotencyKey,
  })).digest('hex')}`;
}



export function readDecisionRefreshReceipt(
  decisionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): DecisionRefreshReceipt | null {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson
     FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'verified' AND reason = 'idempotent_refresh_receipt'
     LIMIT 1
  `).get(
    decisionRefreshReceiptEventId(decisionId, userId, tenantId, idempotencyKey),
    decisionId,
    userId,
    tenantId,
  ) as { metadataJson: string } | undefined;
  if (!row) return null;
  const metadata = safeParseJson<Record<string, unknown>>(row.metadataJson, {});
  const refreshedAt = typeof metadata.refreshedAt === 'string' ? metadata.refreshedAt : null;
  const requestFingerprint = typeof metadata.requestFingerprint === 'string'
    ? metadata.requestFingerprint
    : null;
  if (!refreshedAt || !requestFingerprint) return null;
  const receiptId = decisionCommandReceiptId({
    decisionId,
    operation: 'refresh',
    actionId: null,
    userId,
    tenantId,
    idempotencyKey,
  });
  const commandReceipt = readDecisionCommandReceipt(receiptId, decisionId, userId, tenantId);
  return {
    refreshedAt,
    requestFingerprint,
    ...(commandReceipt ? { commandReceipt } : {}),
  };
}



export function persistDecisionRefreshReceiptStrict(input: {
  decisionId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  requestFingerprint: string;
  refreshedAt: string;
  command: DecisionMutationCommand<Record<string, unknown>>;
  /** Client-sent precondition only; never the observed fallback on `command`. */
  requestedRecordVersion?: number | null;
  requestedContextVersion?: string | null;
  readback: Record<string, unknown>;
  item: DecisionApiItem;
}): DecisionCommandReceipt {
  getDb().prepare(`
    INSERT INTO decision_lifecycle_events
      (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
    VALUES (?, ?, ?, ?, 'verified', ?, 'refresh', 'idempotent_refresh_receipt', ?)
  `).run(
    decisionRefreshReceiptEventId(input.decisionId, input.userId, input.tenantId, input.idempotencyKey),
    input.decisionId,
    input.userId,
    input.tenantId,
    input.readback.status ?? null,
    JSON.stringify({
      refreshedAt: input.refreshedAt,
      requestFingerprint: input.requestFingerprint,
      commandContract: privacySafeDecisionMutationCommandContract(input.command),
      readback: input.readback,
    }),
  );
  const receiptId = decisionCommandReceiptId({
    decisionId: input.decisionId,
    operation: 'refresh',
    actionId: null,
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
  });
  const receipt = createDecisionCommandReceipt({
    receiptId,
    decisionId: input.decisionId,
    operation: 'refresh',
    actionId: null,
    idempotencyKey: input.idempotencyKey,
    status: 'succeeded',
    completedAt: input.refreshedAt,
    requestedRecordVersion: 'requestedRecordVersion' in input
      ? input.requestedRecordVersion
      : input.command.recordVersion,
    requestedContextVersion: 'requestedContextVersion' in input
      ? input.requestedContextVersion
      : input.command.contextVersion,
    readbackItem: compactDecisionCommandReadback(input.item, { actionStatus: 'succeeded' }),
    verification: {
      readBackOk: true,
      expectedEffect: input.command.readback.expectedState,
      actualEffect: input.readback,
      message: 'The original refresh command was recorded and read back exactly.',
    },
  });
  return persistDecisionCommandReceipt({
    receipt,
    userId: input.userId,
    tenantId: input.tenantId,
  });
}



function backfillDecisionRefreshCommandReceipt(input: {
  decisionId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  requestFingerprint: string;
}): DecisionCommandReceipt {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson
      FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'verified' AND reason = 'idempotent_refresh_receipt'
     LIMIT 1
  `).get(
    decisionRefreshReceiptEventId(
      input.decisionId,
      input.userId,
      input.tenantId,
      input.idempotencyKey,
    ),
    input.decisionId,
    input.userId,
    input.tenantId,
  ) as { metadataJson: string } | undefined;
  const metadata = safeParseJson<Record<string, unknown>>(row?.metadataJson, {});
  const storedFingerprint = metadata.requestFingerprint;
  const refreshedAt = metadata.refreshedAt;
  const readback = metadata.readback;
  const commandContract = metadata.commandContract;
  if (storedFingerprint !== input.requestFingerprint
      || typeof refreshedAt !== 'string'
      || !readback
      || typeof readback !== 'object'
      || Array.isArray(readback)) {
    throw new DecisionActionError(
      'DECISION_MUTATION_RECEIPT_INVALID',
      'The predecessor refresh receipt cannot prove its original immutable readback.',
      500,
    );
  }
  const originalReadback = readback as Record<string, unknown>;
  const recordVersion = originalReadback.recordVersion;
  const status = originalReadback.status;
  const contextVersion = originalReadback.contextVersion;
  if (!Number.isSafeInteger(recordVersion)
      || Number(recordVersion) < 1
      || typeof status !== 'string'
      || !status
      || (contextVersion != null && (typeof contextVersion !== 'string' || !contextVersion))) {
    throw new DecisionActionError(
      'DECISION_MUTATION_RECEIPT_INVALID',
      'The predecessor refresh receipt contains an invalid immutable readback.',
      500,
    );
  }
  const storedCommand = commandContract && typeof commandContract === 'object' && !Array.isArray(commandContract)
    ? commandContract as Record<string, unknown>
    : {};
  const requestedRecordVersion = Number.isSafeInteger(storedCommand.recordVersion)
    && Number(storedCommand.recordVersion) > 0
    ? Number(storedCommand.recordVersion)
    : undefined;
  const requestedContextVersion = typeof storedCommand.contextVersion === 'string'
    && storedCommand.contextVersion
    ? storedCommand.contextVersion
    : undefined;
  const receipt = createDecisionCommandReceipt({
    receiptId: decisionCommandReceiptId({
      decisionId: input.decisionId,
      operation: 'refresh',
      actionId: null,
      userId: input.userId,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
    }),
    decisionId: input.decisionId,
    operation: 'refresh',
    actionId: null,
    idempotencyKey: input.idempotencyKey,
    status: 'succeeded',
    completedAt: refreshedAt,
    requestedRecordVersion,
    requestedContextVersion,
    readbackItem: {
      decisionId: input.decisionId,
      recordVersion: Number(recordVersion),
      ...(typeof contextVersion === 'string' ? { contextVersion } : {}),
      status,
      actionStatus: 'succeeded',
    },
    verification: {
      readBackOk: true,
      expectedEffect: { requestFingerprint: input.requestFingerprint },
      actualEffect: {
        recordVersion: Number(recordVersion),
        ...(typeof contextVersion === 'string' ? { contextVersion } : {}),
        status,
      },
      message: 'The predecessor refresh was reconciled from its exact immutable readback.',
    },
  });
  return getDb().transaction(() => persistDecisionCommandReceipt({
    receipt,
    userId: input.userId,
    tenantId: input.tenantId,
  }))();
}



export function observePreconditionVersions(
  preconditions: Array<{ ref: string; currentVersion?: string }>,
): Map<string, string> {
  return new Map(preconditions
    .filter((precondition): precondition is { ref: string; currentVersion: string } => !!precondition.currentVersion)
    .map((precondition) => [precondition.ref, precondition.currentVersion]));
}



export function rebuildNormalizedActionForContext(
  action: NormalizedDecisionAction,
  contextVersion: string,
): NormalizedDecisionAction {
  return buildNormalizedDecisionAction({
    intent: action.intent,
    targetEntities: action.targetEntities,
    affectedResources: action.affectedResources,
    ...(action.requestedWindow ? { requestedWindow: action.requestedWindow } : {}),
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
}



export function nextDecisionContextVersion(
  action: NormalizedDecisionAction,
  conflict: ConflictEvaluation,
  observedPreconditionVersions: Map<string, string>,
): string {
  const shape = {
    candidateFingerprint: action.candidateFingerprint,
    targetEntities: action.targetEntities,
    preconditions: action.preconditions,
    affectedResources: action.affectedResources,
    requestedWindow: action.requestedWindow ?? null,
    observedPreconditionVersions: [...observedPreconditionVersions.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right)),
    conflict: conflictMaterialShape(conflict),
  };
  return `ctx_${createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32)}`;
}



export function conflictMaterialKey(conflict: ConflictEvaluation | null | undefined): string {
  return JSON.stringify(conflict ? conflictMaterialShape(conflict) : null);
}



export function conflictMaterialShape(conflict: ConflictEvaluation): Record<string, unknown> {
  return {
    policyVersion: conflict.policyVersion,
    disposition: conflict.disposition,
    findings: conflict.findings.map((finding) => ({
      class: finding.class,
      severity: finding.severity,
      reasonCode: finding.reasonCode,
      conflictingDecisionId: finding.conflictingDecisionId ?? null,
      resourceKey: finding.resourceKey ?? null,
    })).sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right))),
    winnerDecisionId: conflict.winnerDecisionId ?? null,
    autoResolved: conflict.autoResolved,
  };
}



export function findDecisionByRelatedEntity(
  userId: number,
  tenantId: number,
  relatedEntityType: string,
  relatedEntityId: string,
): DecisionApiItem | null {
  assertScope(userId, tenantId, 'find_decision_by_related_entity', { relatedEntityType, relatedEntityId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version, intents.context_observed_at
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND intents.related_entity_type = ?
       AND intents.related_entity_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
     ORDER BY items.created_at DESC
     LIMIT 1
  `).get(userId, tenantId, relatedEntityType, relatedEntityId) as any;
  if (!row) return null;
  const record = mapDecisionRecord(row);
  if (!isDecisionRecord(record)) return null;
  if (isDecisionExpired(record)) return null;
  const logic = decisionLogicForRecord(record);
  return isUserFacingDecision(record, logic).visible ? formatDecisionItemForApi(record) : null;
}



export function getDecisionSummary(userId: number, tenantId = userId, limit = 3): DecisionSummary {
  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 80, recordExposure: false });
  const handled = listHandledByNexusItems(userId, tenantId, 25);
  const summary = buildDecisionSummaryFromSections(userId, tenantId, items, handled, limit);
  return summary;
}



export function buildDecisionSummaryFromSections(
  userId: number,
  tenantId: number,
  items: DecisionApiItem[],
  handled: HandledByNexusItem[],
  limit = 3,
): DecisionSummary {
  const activeItems = items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
  const openItems = activeItems.filter((item) => item.status !== 'snoozed' || !item.snoozedUntil);
  // C3: COUNTS (openCount/urgentCount/todayCount/badgeCount/gamification) are INTEGRITY reads computed on the
  // raw open set so they stay accurate and consistent with the overview. The RENDERED fields (top pick +
  // preview list + their derived titles/CTA) are USER-FACING, so they respect type-suppression — a muted
  // type must never peek through previewItems/topSuggestion on ANY summary consumer (overview, /summary,
  // portal, secretary fastpath, chat). Flag OFF => presentationItems === openItems (byte-identical). Floored
  // decisions are never suppressed.
  const presentationItems = applyDecisionTypeSuppression(openItems, userId, tenantId);
  const urgentCount = openItems.filter((item) => item.urgency === 'urgent').length;
  const todayCount = openItems.filter((item) => (
    item.urgency === 'urgent' || (item.sectionKey === 'today' && item.isCarryover !== true)
  )).length;
  const top = presentationItems[0] ?? null;
  const locale = userDecisionContextDefaults(userId).locale;
  const timezone = userDecisionContextDefaults(userId).timezone ?? 'UTC';
  const handledTodayCount = handled
    .filter((item) => isTimestampInLocalDay(item.createdAt, timezone, DateTime.utc()))
    .length;
  const gamification = isDecisionStreakV1Enabled(process.env, { userId, tenantId })
    ? readDecisionGamification(userId, tenantId, openItems.length)
    : null;
  return {
    openCount: openItems.length,
    urgentCount,
    todayCount,
    handledTodayCount,
    topDecisionTitle: top?.safePreviewTitle ?? null,
    topDecisionSourceSkill: top?.sourceSkill ?? null,
    topDecisionUrgency: top?.urgency ?? null,
    topDecisionWhy: top?.whySummary ?? top?.analysis?.whyNow ?? null,
    topSuggestion: top ? topSuggestionForItem(top) : null,
    ctaLabel: ctaLabelForSummary(openItems.length, urgentCount, top, locale),
    previewItems: presentationItems.slice(0, Math.min(Math.max(limit, 0), 3)),
    badgeCount: todayCount,
    gamification,
  };
}



export function emptyDecisionSummary(userId: number): DecisionSummary {
  const locale = userDecisionContextDefaults(userId).locale;
  return {
    openCount: 0,
    urgentCount: 0,
    todayCount: 0,
    handledTodayCount: 0,
    topDecisionTitle: null,
    topDecisionSourceSkill: null,
    topDecisionUrgency: null,
    topDecisionWhy: null,
    topSuggestion: null,
    ctaLabel: ctaLabelForSummary(0, 0, null, locale),
    previewItems: [],
    badgeCount: 0,
    gamification: null,
  };
}



export function shouldRethrowDecisionOverviewError(err: unknown): boolean {
  return err instanceof DecisionActionError;
}



export function logDecisionOverviewSectionFailure(section: 'items' | 'handled' | 'summary', err: unknown, userId: number, tenantId: number): void {
  logger.warn({ err, userId, tenantId, section }, 'Decision Center overview section failed');
}



export function openDecisionItemsForOverview(items: DecisionApiItem[]): DecisionApiItem[] {
  return items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
}



export function getDecisionOverview(
  userId: number,
  tenantId = userId,
  opts: { limit?: number; handledLimit?: number; sourceSkill?: NotificationSourceSkill } = {},
): DecisionCenterOverview {
  const limit = Math.min(Math.max(opts.limit ?? 80, 0), 100);
  const handledLimit = Math.min(Math.max(opts.handledLimit ?? 10, 0), 25);
  // Overview counters are totals, not page-local hints. Read the complete
  // bounded scope used by immutable v2 snapshots, then slice only the
  // presentation array. Otherwise a 101-item queue reports exactly 100 and
  // old clients cannot know that cursor pagination is required.
  const itemReadLimit = DECISION_INTERNAL_LIST_HARD_CAP;
  const handledReadLimit = Math.max(handledLimit, 25);
  let allItems: DecisionApiItem[] = [];
  let handledForSummary: HandledByNexusItem[] = [];
  let itemsAvailable = true;
  let handledAvailable = true;
  let summaryAvailable = true;

  try {
    allItems = listDecisionItems(userId, tenantId, {
      status: 'all',
      limit: itemReadLimit,
      maxLimit: itemReadLimit,
      recordExposure: false,
    });
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    itemsAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('items', err, userId, tenantId);
  }

  // BE-1 (Content Studio): when a sourceSkill filter is requested, the rendered
  // `items` come from a dedicated skill-scoped read so skill items buried past
  // the global read limit are never silently dropped. The global `allItems`
  // read above still feeds counters/summary/secretaryToday unchanged.
  let skillOpenItems: DecisionApiItem[] | null = null;
  if (opts.sourceSkill != null && itemsAvailable) {
    try {
      const skillItems = listDecisionItems(userId, tenantId, {
        status: 'all',
        sourceSkill: opts.sourceSkill,
        limit: itemReadLimit,
        maxLimit: itemReadLimit,
        recordExposure: false,
      });
      skillOpenItems = applyDecisionTypeSuppression(openDecisionItemsForOverview(skillItems), userId, tenantId);
    } catch (err) {
      if (shouldRethrowDecisionOverviewError(err)) throw err;
      itemsAvailable = false;
      logDecisionOverviewSectionFailure('items', err, userId, tenantId);
    }
  }

  try {
    handledForSummary = listHandledByNexusItems(userId, tenantId, handledReadLimit);
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    handledAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('handled', err, userId, tenantId);
  }

  // C3: type-suppression is a PRESENTATION filter. `openItemsRaw` is the true open partition and feeds the
  // numeric counts (openCount/staleCount) so they stay consistent with `summary.openCount` (an integrity
  // read built from `allItems`). `allOpenItems` is the user-facing, suppression-filtered set that feeds the
  // rendered list, the top suggestion, and the today narrative. Floored decisions are never suppressed.
  // Flag-gated; OFF makes the two sets identical (byte-identical overview).
  const openItemsRaw = openDecisionItemsForOverview(allItems);
  const allOpenItems = applyDecisionTypeSuppression(openItemsRaw, userId, tenantId);
  let items: DecisionApiItem[] = [];
  let fatigueMeta: DecisionCenterOverview['fatigue'];
  // BE-1: the rendered list draws from the skill-scoped set when a filter was
  // requested; otherwise behavior is unchanged.
  const renderSource = skillOpenItems ?? allOpenItems;
  if (itemsAvailable) {
    if (isDecisionCenterFatigueCapsEnabled(process.env, { userId, tenantId })) {
      // C5: flag-gated, post-ranking selection. Floored decisions bypass the cap; non-floored items
      // are bounded per-domain and to the visible budget. The cap reshapes the already-ranked `items`
      // array (then honors the caller's limit); `fatigue` advertises the primary/More split + how many
      // open decisions were capped out, so the client can render the hierarchy without re-deriving it.
      const { primaryItems, moreItems } = applyDecisionFatigueCaps(renderSource);
      items = [...primaryItems, ...moreItems].slice(0, limit);
      const primaryCount = Math.min(primaryItems.length, items.length);
      fatigueMeta = { primaryCount, moreCount: items.length - primaryCount, cappedCount: Math.max(renderSource.length - items.length, 0) };
    } else {
      items = renderSource.slice(0, limit);
    }
  }
  const handled = handledAvailable ? handledForSummary.slice(0, handledLimit) : [];
  let summary = emptyDecisionSummary(userId);
  if (summaryAvailable) {
    try {
      summary = buildDecisionSummaryFromSections(userId, tenantId, allItems, handledForSummary, 3);
    } catch (err) {
      if (shouldRethrowDecisionOverviewError(err)) throw err;
      summaryAvailable = false;
      logDecisionOverviewSectionFailure('summary', err, userId, tenantId);
    }
  }
  const staleCount = openItemsRaw.filter((item) => item.analysis.sourceFreshness === 'stale' || item.sourceTrace?.dataFreshness === 'cached').length;
  const supersededCount = allItems.filter((item) => ['superseded', 'dismissed', 'actioned'].includes(item.status)).length;
  const topSuggestion = summary.topSuggestion ?? (allOpenItems[0] ? topSuggestionForItem(allOpenItems[0]) : null);
  const language = userDecisionContextDefaults(userId).locale ?? 'en';
  const secretaryToday = buildDecisionCenterSecretaryTodaySummary(allOpenItems, handledForSummary, language);
  return {
    count: renderSource.length,
    openCount: openItemsRaw.filter((item) => ['unread', 'read', 'failed', 'open'].includes(item.status)).length,
    handledCount: handled.length,
    staleCount,
    supersededCount,
    generatedAt: DateTime.utc().toISO()!,
    summary,
    topSuggestion,
    partial: {
      items: itemsAvailable,
      handled: handledAvailable,
      summary: summaryAvailable,
    },
    secretaryToday,
    fatigue: fatigueMeta,
    ...(opts.sourceSkill != null
      ? { sourceSkillFilter: opts.sourceSkill, sourceSkillTotalCount: skillOpenItems?.length ?? 0 }
      : {}),
    items,
    handled,
  };
}



export function buildDecisionCenterReportDocument(userId: number, tenantId = userId): Record<string, unknown> {
  const overview = getDecisionOverview(userId, tenantId, { limit: 20, handledLimit: 10 });
  return {
    type: 'decision_briefing',
    generatedAt: overview.generatedAt,
    summary: {
      openCount: overview.openCount,
      urgentCount: overview.summary.urgentCount,
      handledCount: overview.handledCount,
      staleCount: overview.staleCount,
      supersededCount: overview.supersededCount,
      ctaLabel: overview.summary.ctaLabel,
    },
    topSuggestion: overview.topSuggestion,
    openDecisions: overview.items.slice(0, 8).map((item) => ({
      decisionId: item.decisionId,
      title: item.safePreviewTitle || item.title,
      whyNow: item.analysis.whyNow,
      expectedOutcome: item.analysis.expectedOutcome,
      costOfDelay: item.analysis.costOfDelay,
      confidenceLabel: item.analysis.confidenceLabel,
      sourceFreshness: item.analysis.sourceFreshness,
      actionLabel: item.recommendedActionLabel,
      urgency: item.urgency,
      sourceSkill: item.sourceSkill,
    })),
    handledByNexus: overview.handled.slice(0, 8).map((item) => ({
      itemId: item.itemId,
      title: item.title,
      summary: item.summary,
      explanation: item.explanation,
      actionTaken: item.actionTaken,
      whyBrief: item.whyBrief,
      rollbackAvailable: item.rollbackAvailable,
    })),
    secretaryToday: overview.secretaryToday,
    unresolvedRisk: overview.topSuggestion?.riskIfIgnored ?? null,
  };
}



export function buildDecisionCenterSecretaryTodaySummary(
  openItems: DecisionApiItem[],
  handledItems: HandledByNexusItem[],
  language: string,
): SecretaryTodaySummaryModel {
  // Decision Center's Secretary Today view is intentionally queue-centric:
  // /plan/today owns the richer daily operational scan, while this endpoint
  // mirrors the live decisions/handled source of truth the user is viewing.
  const copy = secretaryTodayLabels(language);
  const secretaryOpen = openItems.filter((item) => item.sourceSkill === 'secretary');
  const secretaryHandled = handledItems.filter((item) => item.sourceSkill === 'secretary');
  const stale = secretaryOpen.filter((item) => item.analysis.sourceFreshness === 'stale' || item.sourceTrace?.dataFreshness === 'cached');
  const checked = [{
    id: 'decision-center-read',
    label: copy.decisionCenterCheckedLabel,
    detail: copy.decisionCenterCheckedDetail,
    status: 'checked' as const,
    source: 'decision_center' as const,
  }];
  const handled = secretaryHandled.slice(0, 3).map((item, index) => ({
    id: `secretary-handled-${index}`,
    label: copy.handledByNexus,
    detail: item.explanation?.result ?? item.summary,
    status: 'handled' as const,
    source: 'decision_center' as const,
  }));
  const needsUser = secretaryOpen.slice(0, 3).map((item, index) => ({
    id: `secretary-needs-user-${index}`,
    label: copy.needsYou,
    detail: item.explanation?.userAction ?? item.recommendedActionLabel ?? item.summary,
    status: 'needs_user' as const,
    source: 'decision_center' as const,
  }));
  const waitingOnSource = stale.slice(0, 3).map((item, index) => ({
    id: `secretary-waiting-source-${index}`,
    label: copy.waitingOnSource,
    detail: item.analysis.freshnessLabel ?? item.summary,
    status: 'waiting_on_source' as const,
    source: 'source_health' as const,
  }));
  const nextBestMove = secretaryOpen[0]?.explanation?.userAction
    ?? secretaryOpen[0]?.recommendedActionLabel
    ?? null;
  const summary = needsUser.length > 0
    ? copy.summaryNeedsUser(needsUser.length)
    : handled.length > 0
      ? copy.summaryHandled(handled.length)
      : waitingOnSource.length > 0
        ? copy.summaryWaitingOnSource
        : copy.summaryAllClear;
  return {
    title: copy.title,
    summary,
    checked,
    handled,
    needsUser,
    waitingOnSource,
    nextBestMove,
    counts: {
      checked: checked.length,
      handled: handled.length,
      needsUser: needsUser.length,
      waitingOnSource: waitingOnSource.length,
    },
  };
}



export function countOpenUrgentDecisionsForUser(userId: number, tenantId = userId): number {
  return getDecisionSummary(userId, tenantId).badgeCount;
}



export function readDecisionGamification(userId: number, tenantId: number, openCount: number): DecisionGamificationSummary {
  ensureDecisionCenterTables();
  const defaults = userDecisionContextDefaults(userId);
  const timezone = defaults.timezone || 'UTC';
  const now = DateTime.now().setZone(timezone);
  const today = now.toISODate()!;

  const since = now.minus({ days: 13 }).toISODate()!;
  const rows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ? AND local_date >= ?
     ORDER BY local_date ASC
  `).all(userId, tenantId, since) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const rowByDate = new Map(rows.map((row) => [row.local_date, row]));
  const last14Days = Array.from({ length: 14 }, (_, idx) => {
    const date = now.minus({ days: 13 - idx }).toISODate()!;
    const row = rowByDate.get(date);
    const cleared = !!row?.reached_zero_at || (date === today && openCount === 0);
    return {
      date,
      cleared,
      reachedZeroAt: row?.reached_zero_at ?? (cleared ? now.toUTC().toISO() : null),
    };
  });
  const allRows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ?
     ORDER BY local_date ASC
  `).all(userId, tenantId) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const clearedByDate = new Map<string, boolean>();
  for (const row of allRows) {
    clearedByDate.set(row.local_date, !!row.reached_zero_at);
  }
  // The live queue is authoritative for today even before the asynchronous
  // daily rollup writer persists its row. A zero open count therefore extends
  // today's streak immediately; historical days still require durable rows.
  if (openCount === 0) clearedByDate.set(today, true);
  // Phase 17 hostile-QA fix (2026-05-18): walk back over the full clearedByDate
  // index, not a fixed 14-day window. The previous code silently capped
  // currentStreakDays at 14 because last14Days has exactly 14 entries —
  // a user with a 30-day clear streak saw 14 forever. Cap at 365 days as
  // a safety bound; a streak longer than a year would re-engage the cap
  // intentionally.
  let currentStreakDays = 0;
  for (let i = 0; i < 365; i += 1) {
    const date = now.minus({ days: i }).toISODate();
    if (date && clearedByDate.get(date) === true) {
      currentStreakDays += 1;
    } else {
      break;
    }
  }
  // Phase 17 hostile-QA fix (2026-05-18): treat missing rollup rows as
  // streak breaks. The previous loop iterated only existing rows, so a
  // user who skipped the app for a week then cleared decisions appeared
  // to have a contiguous streak across the gap. Walk a contiguous date
  // range from the earliest row through today.
  let bestStreakDays = 0;
  if (allRows.length > 0) {
    const startDate = DateTime.fromISO(allRows[0].local_date, { zone: timezone }).startOf('day');
    const endDate = now.startOf('day');
    let cursor = startDate;
    let running = 0;
    while (cursor <= endDate) {
      const dateKey = cursor.toISODate()!;
      if (clearedByDate.get(dateKey) === true) {
        running += 1;
        if (running > bestStreakDays) bestStreakDays = running;
      } else {
        running = 0;
      }
      cursor = cursor.plus({ days: 1 });
    }
  }
  const hoursLeftToday = Math.max(0, Math.round(now.endOf('day').diff(now, 'hours').hours * 10) / 10);
  return {
    currentStreakDays,
    bestStreakDays,
    last14Days,
    decisionsLeft: openCount,
    hoursLeftToday,
    atRisk: openCount > 0 && hoursLeftToday <= 4,
  };
}



export function listHandledByNexusItems(userId: number, tenantId = userId, limit = 25): HandledByNexusItem[] {
  assertScope(userId, tenantId, 'list_handled_by_nexus_items', { limit });
  ensureDecisionCenterTables();
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const wideLimit = Math.min(boundedLimit * 2, 100);
  const explicitRows = getDb().prepare(`
    SELECT *
      FROM handled_by_nexus_items
     WHERE user_id = ?
       AND tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(userId, tenantId, wideLimit) as any[];
  const explicitDecisionIds = new Set(
    explicitRows
      .map((row) => typeof row.decision_id === 'string' ? row.decision_id : null)
      .filter((value): value is string => !!value),
  );
  const explicitItems = explicitRows
    .map((row) => {
      const item = mapHandledByNexusItem(row);
      const record = getDecisionRecord(item.decisionId, userId, tenantId);
      return record ? withHandledRollbackAction(item, record) : item;
    })
    .filter(isHandledByNexusItemUserFacing);

  const actionedRows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version, intents.context_observed_at,
           logs.action_taken AS decision_log_action_taken
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      LEFT JOIN notification_decision_logs logs ON logs.decision_log_id = items.decision_log_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.status = 'actioned'
     ORDER BY COALESCE(items.actioned_at, items.created_at) DESC
     LIMIT ?
  `).all(userId, tenantId, wideLimit) as any[];
  const actionedItems = actionedRows
    .map(mapDecisionRecord)
    .filter((record) => !explicitDecisionIds.has(record.itemId))
    .filter((record) => isUserFacingDecision(record, decisionLogicForRecord(record)).visible)
    .map(mapActionedDecisionToHandledItem);

  return [...explicitItems, ...actionedItems]
    .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt))
    .slice(0, boundedLimit);
}



export function isHandledByNexusItemUserFacing(item: HandledByNexusItem): boolean {
  const haystack = [
    item.title,
    item.summary,
    item.actionTaken,
    item.whyBrief,
    item.explanation?.headline,
    item.explanation?.whatHappened,
    item.explanation?.result,
  ].filter((value): value is string => typeof value === 'string');
  const hidden = haystack.some((value) => /\[smoke\]|decision_center_smoke|source[\s_-]?trace|decision\s+center\s+(?:v|version\s*)?\d+/i.test(value));
  if (hidden) {
    decisionGuidanceStats.filteredFromUserView += 1;
    decisionGuidanceStats.filteredByReason.smoke_decision = (decisionGuidanceStats.filteredByReason.smoke_decision ?? 0) + 1;
  }
  return !hidden;
}



export function formatDecisionItemForApi(
  item: DecisionRecord,
  opts: { materializePriorityScore?: boolean } = {},
): DecisionApiItem {
  const logic = decisionLogicForRecord(item);
  const structuredContext = decisionContextForRecord(item);
  const safeTitle = logic.safePreviewTitle || safeTitleForItem(item);
  const actions = actionsForRecord(item);
  const dependencies = dependencyStateForRecord(item);
  const action = recommendedAction(actions);
  const urgency = urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt);
  const outcome = outcomeSummaryForRecord(item, logic);
  const riskLevel = riskLevelForItem(item);
  const isCarryover = isCarryoverDecision(item, urgency, logic);
  const sectionKey = isCarryover ? 'today' : sectionKeyForRecord(item, urgency, logic);
  const rollback = rollbackContractForRecord(item);
  const exposeDebugEvidence = shouldExposeDecisionDebugEvidence(item);
  const visibleWhatWillChange = userVisibleWhatWillChangeForApi(item, logic);
  const execution = executionSummaryForRecord(item);
  const effectiveStatus = computeEffectiveStatus(item, {
    dependencies,
    logic,
    retryAvailable: outcome.retryActions.length > 0 || execution.recoveryActions.length > 0,
    executionStatus: execution.status,
  });
  const decisionKind = computeDecisionKind(item, logic, dependencies, action);
  let actionability = computeActionability(item, logic, effectiveStatus, action);
  if (durableDecisionStateForRecord(item) === 'blocked') actionability = 'blocked';
  if (isSecretaryReviewOnlyPreview(item, structuredContext.normalizedAction ?? null)) actionability = 'read_only';
  if (execution.status === 'started' || execution.status === 'partially_failed') actionability = 'blocked';
  const rankDeadline = item.decisionDeadline ?? item.expiresAt;
  const prioritySnapshot = rankDecisionPriority({
    priority: item.priority,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    deadlineSoon: !!rankDeadline && Number.isFinite(Date.parse(rankDeadline)) && Date.parse(rankDeadline) - Date.now() <= 24 * 3_600_000,
    riskLevel,
    actionCount: actions.length,
    dependencyBlocked: dependencies.blockedByDecisionIds.length > 0,
  });
  const priorityScore = priorityScoreFor(item);
  if (opts.materializePriorityScore === true) {
    materializeDecisionPriorityScore(item, priorityScore);
  }
  const analysisBundle = analysisForRecord(item, logic);
  // F2: gate actionability on stale evidence (flag-gated; only lowers write-capable actionability so the
  // client offers Refresh instead of acting on stale data). OFF or fresh => unchanged.
  if (analysisBundle.sourceFreshness === 'stale'
      && isDecisionEvidenceFreshnessGateEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })) {
    actionability = gateActionabilityForStaleEvidence(actionability);
  }
  // F human-review fallback: a requires_human_review decision with no live review queue is gated to
  // unavailable (manual-only). Composes AFTER F2; both only ever lower. OFF/no-review-value => unchanged.
  if (isDecisionHumanReviewGateEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })) {
    actionability = gateActionabilityForHumanReview(actionability, isHumanReviewQueueAvailable(process.env));
  }
  const confidenceExplanation = computeConfidenceExplanation(logic.confidence, logic.why, analysisBundle, exposeDebugEvidence);
  const conflictPolicyActive = isDecisionConflictPolicyV1Enabled(process.env, { userId: item.userId, tenantId: item.tenantId })
    || decisionFlowV1EnforcedForRecord(item);
  const conflictSummary = conflictPolicyActive
    ? buildDecisionConflictSummary(structuredContext.conflictEvaluation, structuredContext.locale)
    : null;
  const requiredPermissions = requiredPermissionsForRecord(item);
  const approvalLevel = approvalLevelForRecord(item);
  const normalizedAction = normalizeDecisionAction(structuredContext.normalizedAction);
  const contextVersion = decisionContextVersion(item);
  const reviewSupported = reviewSupportedForRecord(item, normalizedAction, approvalLevel);
  const editableProposalFields = reviewSupported ? editableProposalFieldsForRecord(item) : [];
  const mutualExclusionGroupId = conflictPolicyActive
    ? mutualExclusionGroupIdForRecord(item, structuredContext.conflictEvaluation)
    : null;
  const recommendedStartAt = canonicalStoredDecisionContextTimestamp(item.decisionContext?.recommendedStartAt);
  const recommendedEndAt = canonicalStoredDecisionContextTimestamp(item.decisionContext?.recommendedEndAt);
  return {
    decisionId: item.itemId,
    itemId: item.itemId,
    id: item.itemId,
    intentId: item.intentId,
    decisionLogId: item.decisionLogId,
    userId: item.userId,
    tenantId: item.tenantId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    lifecycleStatus: legacyStatusToLifecycle(item.status),
    actionOutcomeStatus: execution.status === 'none' ? actionOutcomeFromRecord(item) : execution.status,
    effectiveStatus,
    actionEffectiveStatuses: actions.map((candidate) => computeActionEffectiveStatus(item, candidate, {
      dependencies,
      logic,
      reconnectAffordance: isDecisionReconnectAffordanceEnabled(process.env, { userId: item.userId, tenantId: item.tenantId }),
      executionStatus: execution.status,
    })),
    decisionKind,
    actionability,
    prioritySnapshot,
    urgency,
    timingLabel: timingLabelForRecord(item, urgency),
    priorityScore,
    title: logic.title,
    summary: logic.problemStatement,
    deeplink: item.deeplink,
    safePreviewTitle: safeTitle,
    safePreviewBody: logic.safePreviewBody || item.safeBody,
    recommendedActionLabel: logic.primaryActionLabel || (action?.label ?? null),
    recommendedAction: action,
    alternativeActions: actions.filter((candidate) => candidate.id !== action?.id),
    whySummary: logic.whySummary,
    whyDetails: exposeDebugEvidence ? whyDetailsForItem(item, logic) : [],
    explanation: explanationForDecisionItem(item, logic),
    problemStatement: logic.problemStatement,
    recommendation: logic.recommendation,
    expectedEffect: logic.expectedEffect,
    impactIfIgnored: logic.impactIfIgnored,
    impactLevel: riskLevel,
    primaryActionLabel: logic.primaryActionLabel,
    secondaryActionLabels: logic.secondaryActionLabels,
    urgencyReason: logic.urgencyReason,
    why: exposeDebugEvidence ? logic.why : emptyDecisionWhy(),
    actionPreview: visibleWhatWillChange,
    whatWillChange: visibleWhatWillChange,
    alternatives: alternativesForRecord(item, logic, actions),
    options: isDecisionChoiceOptionsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildSecretaryChoiceOptions(item, logic)
      : undefined,
    contentCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildContentDecisionCard(item, logic, action)
      : undefined,
    trainingCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildTrainingDecisionCard(item, rollback)
      : undefined,
    financeCard: isDecisionSkillCardsEnabled(process.env, { userId: item.userId, tenantId: item.tenantId })
      ? buildFinanceDecisionCard(item, logic, analysisBundle, action)
      : undefined,
    automationEligibility: logic.automationEligibility,
    autopilotPolicy: logic.autopilotPolicy,
    readBackVerifier: exposeDebugEvidence ? logic.readBackVerifier : null,
    handledByNexus: false,
    handledAt: null,
    outcomeSummary: outcome.outcomeSummary,
    failureReason: outcome.failureReason,
    retryActions: outcome.retryActions,
    notificationEligibility: logic.notificationEligibility,
    apnsInterruptionLevel: logic.apnsInterruptionLevel,
    collapseKey: logic.collapseKey,
    badgeContribution: logic.badgeContribution,
    quality: logic.quality,
    relatedEntities: item.relatedEntityId && item.relatedEntityType
      ? [{ type: item.relatedEntityType, id: item.relatedEntityId }]
      : [],
    relatedEntitiesSafe: relatedEntitiesSafeForRecord(item, logic),
    sourceTraceSummary: exposeDebugEvidence ? sourceTraceSummaryForRecord(item, logic) : null,
    sourceTrace: exposeDebugEvidence ? sourceTraceForRecord(item, logic) : null,
    dependencyGraphSummary: dependencyGraphSummaryForRecord(dependencies, userDecisionContextDefaults(item.userId).locale),
    actionTruthTableEntry: exposeDebugEvidence && action ? actionTruthTableEntryForRecord(item, action, logic, rollback) : null,
    askNexusContext: null,
    deadlineAt: item.decisionDeadline,
    expiresAt: item.expiresAt,
    confidence: logic.confidence,
    analysis: analysisBundle,
    confidenceExplanation,
    ...(conflictSummary ? { conflictSummary } : {}),
    ...(contextVersion
      ? { contextVersion }
      : {}),
    ...(item.contextObservedAt ? { contextObservedAt: item.contextObservedAt } : {}),
    contextFreshness: analysisBundle.sourceFreshness,
    ...(mutualExclusionGroupId ? { mutualExclusionGroupId } : {}),
    ...(item.supersededByItemId ? { supersededByDecisionId: item.supersededByItemId } : {}),
    requiredPermissions,
    approvalLevel,
    reviewSupported,
    editableProposalFields,
    recommendedStartAt,
    recommendedEndAt,
    reversibility: normalizedAction?.reversibility ?? null,
    execution,
    refreshSupported: decisionRefreshSupportedForRecord(item),
    recordVersion: item.recordVersion,
    decisionState: durableDecisionStateForRecord(item),
    riskLevel,
    groupKey: groupKeyForRecord(item),
    sectionKey,
    isCarryover,
    displayMode: displayModeForRecord(item, logic),
    frontendActionState: frontendActionStateForRecord(item, logic, dependencies, action),
    privacyClassification: item.privacyPolicy,
    visibilityScope: visibilityScopeForItem(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    snoozedUntil: item.snoozedUntil,
    actions,
    dependsOnDecisionIds: dependencies.dependsOnDecisionIds,
    relationships: dependencies.relationships,
    blockedByDecisionIds: dependencies.blockedByDecisionIds,
    rollbackAvailable: rollback.available,
    rollbackActionId: rollback.actionId,
  };
}



/**
 * Full-detail and mutation readback payloads expose proposal timestamps from
 * the durable decision context. Normalize legacy offsets and reject malformed
 * values so clients compare one canonical representation after an edit.
 */
export function canonicalStoredDecisionContextTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}



export function mutualExclusionGroupIdForRecord(
  record: DecisionRecord,
  evaluation: ConflictEvaluation | null | undefined,
): string | null {
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  if (!action || action.exclusivityKeys.length === 0 || !evaluation) return null;
  const groupingConflict = evaluation.findings.some((finding) =>
    finding.class === 'mutually_exclusive_effects'
      || finding.class === 'time_overlap'
      || finding.class === 'resource_competition'
      || finding.class === 'concurrent_mutation');
  if (!groupingConflict) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify({
      tenantId: record.tenantId,
      userId: record.userId,
      exclusivityKeys: [...action.exclusivityKeys].sort(),
    }))
    .digest('hex')
    .slice(0, 24);
  return `mxg_${digest}`;
}



export function formatDecisionItemForApiWithExposure(
  item: DecisionRecord,
  opts: { recordExposure?: boolean; materializePriorityScore?: boolean } = {},
): DecisionApiItem {
  const apiItem = formatDecisionItemForApi(item, { materializePriorityScore: opts.materializePriorityScore });
  if (opts.recordExposure === true) recordDecisionExposure(item, apiItem);
  return apiItem;
}



export function displayModeForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionFrontendDisplayMode {
  if (!logic.quality.safeToShowUser) return 'details_unavailable';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'actioned') return 'handled';
  if (item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (item.type === 'sync_failure') return 'waiting_on_system';
  return 'needs_input';
}



export function frontendActionStateForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  dependencies: { blockedByDecisionIds: string[] },
  action: NotificationActionButton | null = recommendedAction(actionsForRecord(item)),
): DecisionFrontendActionState {
  if (!logic.quality.safeForFrontendAction) return 'disabled_missing_details';
  if (!action || !isDecisionActionExecutable(action.id)) return 'disabled_missing_details';
  if (item.status === 'expired') return 'disabled_expired';
  if (item.status === 'superseded' || item.status === 'dismissed' || item.status === 'actioned') return 'disabled_superseded';
  if (durableDecisionStateForRecord(item) === 'blocked') return 'disabled_missing_details';
  if (dependencies.blockedByDecisionIds.length > 0) return 'disabled_missing_details';
  return 'enabled';
}



export function safeTitleForItem(item: DecisionRecord): string {
  if (item.privacyPolicy === 'financial' || item.sourceSkill === 'finance') return 'Finance decision';
  if (item.privacyPolicy === 'health' || item.sourceSkill === 'training') return item.type === 'decision_required' ? 'Training decision' : 'Training update';
  if (item.privacyPolicy === 'private_content' || item.sourceSkill === 'content') return 'Content review';
  if (item.privacyPolicy === 'sensitive') return sourceLabel(item.sourceSkill);
  return item.title;
}



export function shouldExposeDecisionDebugEvidence(item: DecisionRecord): boolean {
  void item;
  return process.env.DECISION_CENTER_DEBUG_EVIDENCE === '1';
}



export function emptyDecisionWhy(): DecisionWhy {
  return {
    facts: [],
    preferences: [],
    rules: [],
    tradeoffs: [],
    uncertainty: [],
  };
}



export function userVisibleWhatWillChangeForApi(item: DecisionRecord, logic: DecisionLogicV2): DecisionWhatWillChange[] {
  if (logic.whatWillChange.length === 0) return [];
  return logic.whatWillChange.slice(0, 3).map((change) => ({
    ...change,
    verificationMethod: openVerificationTextForRecord(item, logic),
  }));
}



export function whyDetailsForItem(item: DecisionRecord, logic: DecisionLogicV2): Array<{ label: string; value: string }> {
  const details = [
    { label: 'Source', value: sourceLabel(item.sourceSkill) },
    { label: 'Recommendation', value: logic.recommendation },
    { label: 'Expected effect', value: logic.expectedEffect },
    { label: 'Rule', value: logic.why.rules[0] ?? 'Decision Center only shows items that require user judgment or approval.' },
  ];
  for (const fact of logic.why.facts.slice(0, 3)) {
    details.push({ label: 'Fact', value: fact });
  }
  for (const tradeoff of logic.why.tradeoffs.slice(0, 2)) {
    details.push({ label: 'Tradeoff', value: tradeoff });
  }
  if (item.decisionDeadline) {
    details.push({ label: 'Deadline', value: item.decisionDeadline });
  }
  if (item.privacyPolicy !== 'public') {
    details.push({ label: 'Privacy', value: 'Home and notifications use a safe preview; details require authenticated access.' });
  }
  return details;
}



export function timingLabelForRecord(item: DecisionRecord, urgency: DecisionUrgency): string | null {
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (!timestamp) {
    if (urgency === 'urgent') return 'Urgent';
    if (urgency === 'today') return 'Today';
    if (urgency === 'this_week') return 'This week';
    return null;
  }
  const timezone = decisionTimezoneForRecord(item);
  const parsed = parseDecisionTimestamp(timestamp).setZone(timezone);
  if (!parsed.isValid) return urgency === 'urgent' ? 'Urgent' : null;
  const now = DateTime.utc().setZone(timezone);
  if (parsed.hasSame(now, 'day')) return 'Today';
  if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'Tomorrow';
  if (parsed <= now.plus({ days: 7 })) return 'This week';
  return parsed.toFormat('LLL d');
}



export function sectionKeyForRecord(item: DecisionRecord, urgency: DecisionUrgency, logic: DecisionLogicV2): DecisionTimelineSectionKey {
  const displayMode = displayModeForRecord(item, logic);
  if (displayMode === 'waiting_on_system') return 'waiting_on_systems';
  if (displayMode === 'handled' || item.status === 'actioned' || item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (urgency === 'urgent') return 'urgent';
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (timestamp) {
    const timezone = decisionTimezoneForRecord(item);
    const parsed = parseDecisionTimestamp(timestamp).setZone(timezone);
    if (parsed.isValid) {
      const now = DateTime.utc().setZone(timezone);
      if (parsed.hasSame(now, 'day')) return 'today';
      if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'tomorrow';
      if (parsed <= now.plus({ days: 7 })) return 'this_week';
    }
  }
  if (urgency === 'today') return 'today';
  return 'this_week';
}



export function isCarryoverDecision(
  item: DecisionRecord,
  urgency: DecisionUrgency,
  logic: DecisionLogicV2,
): boolean {
  const displayMode = displayModeForRecord(item, logic);
  if (urgency === 'urgent'
      || displayMode === 'waiting_on_system'
      || displayMode === 'handled'
      || ['actioned', 'superseded', 'dismissed', 'expired'].includes(item.status)) {
    return false;
  }
  const timezone = decisionTimezoneForRecord(item);
  const created = parseDecisionTimestamp(item.createdAt).setZone(timezone);
  const today = DateTime.utc().setZone(timezone).toISODate();
  return created.isValid && today != null && created.toISODate()! < today;
}



export function decisionTimezoneForRecord(item: DecisionRecord): string {
  return validateDecisionTimezone(decisionContextForRecord(item).timezone)
    ?? userDecisionContextDefaults(item.userId).timezone
    ?? 'UTC';
}



export function groupKeyForRecord(item: DecisionRecord): string {
  if (item.relatedEntityType && item.relatedEntityId) return `${item.sourceSkill}:${item.relatedEntityType}:${item.relatedEntityId}`;
  return `${item.sourceSkill}:${item.type}:${item.dedupeKey ?? item.itemId}`;
}



export function alternativesForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  actions: NotificationActionButton[],
): DecisionAlternativeOption[] {
  const alternatives: DecisionAlternativeOption[] = [];
  const primary = recommendedAction(actions);
  if (primary) {
    alternatives.push({
      id: `${item.itemId}:recommended`,
      label: logic.primaryActionLabel || primary.label,
      rank: 'best',
      reason: logic.whySummary,
      actionId: primary.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), primary) === 'enabled',
      source: 'recipe',
    });
  }
  for (const action of actions.filter((candidate) => candidate.id !== primary?.id && candidate.id !== 'open_detail')) {
    alternatives.push({
      id: `${item.itemId}:${action.id}`,
      label: action.label,
      rank: action.style === 'destructive' ? 'not_recommended' : 'good',
      reason: action.style === 'destructive'
        ? 'This option changes or rejects the recommendation, so Nexus keeps it explicit.'
        : 'Available as a lower-friction alternative if the recommendation does not fit.',
      actionId: action.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), action) === 'enabled',
      source: 'recipe',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'snooze')) {
    alternatives.push({
      id: `${item.itemId}:snooze`,
      label: 'Snooze',
      rank: 'good',
      reason: 'Use this if the decision is real but not worth interrupting this window.',
      actionId: 'snooze',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'dismiss')) {
    alternatives.push({
      id: `${item.itemId}:dismiss`,
      label: 'Dismiss',
      rank: 'not_recommended',
      reason: 'Dismiss only when the recommendation no longer matters; Nexus records that outcome for future ranking.',
      actionId: 'dismiss',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  return alternatives.slice(0, 5);
}



/**
 * Shared (D) — the advisor's feasible slot recommendation for a SECRETARY REFLOW decision, or null when this
 * is not a secretary reflow (carries `accept_reflow`) with candidate slots and a feasible recommendation.
 * Pure: decisionContextForRecord + adviseSecretaryDecision are read-only and do NOT call back into
 * actionsForRecord / decisionLogicForRecord, so this is safe to call from actionsForRecord without recursion.
 */
export function secretaryReflowChoiceAdvice(record: DecisionRecord): SecretaryDecisionAdvice | null {
  if (record.sourceSkill !== 'secretary') return null;
  if (!record.actions.some((candidate) => candidate.id === 'accept_reflow')) return null;
  const context = decisionContextForRecord(record);
  const slots = context.candidateSlots ?? [];
  if (slots.length === 0) return null;
  const advice = adviseSecretaryDecision({
    title: context.entityTitle ?? '',
    currentStartAt: context.currentStartAt,
    currentEndAt: context.currentEndAt,
    availableSlots: slots,
    allowProtectedTimeOverride: context.allowProtectedTimeOverride === true,
    reasonCodes: context.reasonCodes ?? [],
    timezone: context.timezone,
    locale: context.locale,
  });
  return advice.recommendedStartAt && advice.recommendedEndAt ? advice : null;
}



/**
 * D (secretary choose-a-time) — surface the slot CHOICES the advisor already computes (recommended slot +
 * ranked feasible alternatives, each a concrete window + tradeoff) as structured DecisionOptions the client
 * can render as a choice UI. Every option maps to the (fully-wired) `choose_another_time` action with its
 * window as the payload — a lightweight intent, NOT a baked preview (the client confirms freshly at
 * selection time). The action is surfaced under the same flag by actionsForRecord, so the options are
 * genuinely invokable. Returns undefined — never [] — when this is unsafe to act on or there is no feasible
 * recommendation, so no hollow choice UI is ever shown.
 */
export function buildSecretaryChoiceOptions(item: DecisionRecord, logic: DecisionLogicV2): DecisionOption[] | undefined {
  if (!logic.quality.safeForFrontendAction) return undefined; // never offer actionable options on an unsafe decision
  const advice = secretaryReflowChoiceAdvice(item);
  if (!advice) return undefined;
  const options: DecisionOption[] = [{
    optionId: `${item.itemId}:opt:recommended`,
    title: advice.bestAction,
    summary: advice.scheduleImpact,
    tradeoffs: advice.whyTradeoffs,
    recommended: true,
    risk: 'low', // schedule reflow is reversible (undo_reflow), so choosing a window is low-risk
    actionId: 'choose_another_time',
    actionPayload: { startAt: advice.recommendedStartAt!, endAt: advice.recommendedEndAt! },
  }];
  for (const alt of advice.alternatives) {
    if (!alt.startAt || !alt.endAt) continue;
    options.push({
      optionId: `${item.itemId}:opt:${alt.startAt}`,
      title: alt.label,
      summary: alt.tradeoff,
      tradeoffs: [alt.tradeoff],
      recommended: false,
      risk: 'low',
      actionId: 'choose_another_time',
      actionPayload: { startAt: alt.startAt, endAt: alt.endAt },
    });
  }
  return options;
}



/**
 * D (content) — surface the content pipeline state for a content decision as a structured card. Pure +
 * read-only (getContentWorkflowObject is scope-checked by userId/tenantId). Returns undefined — never a
 * partial card — for non-content decisions or when the backing workflow object is missing, so the field is
 * only present when every value is real.
 */
export function buildContentDecisionCard(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  primaryAction: NotificationActionButton | null,
): DecisionContentCard | undefined {
  if (item.sourceSkill !== 'content') return undefined;
  const objectId = contentWorkflowObjectIdForDecision(item);
  if (!objectId) return undefined;
  const object = getContentWorkflowObject(item.userId, objectId, item.tenantId);
  if (!object) return undefined;
  return {
    objectType: object.objectType,
    pipelineStage: object.editorialState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    nextActionLabel: logic.primaryActionLabel || (primaryAction?.label ?? null),
  };
}



/**
 * Conservative training-risk label derived ONLY from the agenda's structured decisionReasonCodes (enum
 * tokens, never free text), so injected evidence in a title/body can never move the risk. Defaults to
 * 'low' and only escalates on explicit risk tokens — never overconfident.
 */
export function trainingRiskFromReasonCodes(codes: string[]): 'low' | 'medium' | 'high' {
  const set = codes.map((code) => code.toLowerCase());
  const has = (...needles: string[]): boolean => set.some((code) => needles.some((needle) => code.includes(needle)));
  if (has('compression', 'deload', 'conflict', 'injury', 'overreach')) return 'high';
  if (has('peak', 'race', 'taper')) return 'medium';
  return 'low';
}



/**
 * D (training) — before/after window + risk + undo card for a training-origin reflow decision. Reads the
 * anchoring secretary agenda item (owner/tenant-scoped) for the BEFORE window + structured reason codes,
 * and the already-computed recommended window (context) for the AFTER. Pure-ish (one scoped read). Returns
 * undefined (no hollow card) for non-training decisions, a non-training agenda, or a missing before window.
 */
export function buildTrainingDecisionCard(
  item: DecisionRecord,
  rollback: { available: boolean; actionId: string | null },
): DecisionTrainingCard | undefined {
  // Gate on the ANCHORING AGENDA's skill, not the decision's: a training-session reflow is surfaced under
  // sourceSkill 'secretary' (the scheduler) while the agenda is source_skill 'training'. The cheap
  // relatedEntityType check first avoids a DB read for non-reflow decisions.
  if (item.relatedEntityType !== 'secretary_agenda_item' || !item.relatedEntityId) return undefined;
  const agenda = getSecretaryAgendaItemById({ agendaItemId: item.relatedEntityId, ownerUserId: item.userId, tenantId: item.tenantId });
  if (!agenda || agenda.sourceSkill !== 'training') return undefined; // true training origin only
  const beforeStartAt = agenda.startAt ?? null;
  const beforeEndAt = agenda.endAt ?? null;
  if (!beforeStartAt || !beforeEndAt) return undefined; // no hollow card without a real before window
  const context = decisionContextForRecord(item);
  const afterStartAt = context.recommendedStartAt ?? null;
  const afterEndAt = context.recommendedEndAt ?? null;
  return {
    beforeWindowLabel: formatDecisionWindow(beforeStartAt, beforeEndAt, context.timezone, context.locale),
    afterWindowLabel: afterStartAt && afterEndAt ? formatDecisionWindow(afterStartAt, afterEndAt, context.timezone, context.locale) : null,
    beforeStartAt,
    beforeEndAt,
    afterStartAt,
    afterEndAt,
    risk: trainingRiskFromReasonCodes(agenda.decisionReasonCodes ?? []),
    undoAvailable: rollback.available,
  };
}



/**
 * D (finance) — READ-ONLY, privacy-safe card for a finance tax-event decision. Surfaces ONLY the tax month
 * + payment-status enum + freshness label + next action; NEVER any amount field. Same owner/tenant-scoped
 * tax-event derivation the executor already trusts. Returns undefined (no hollow card) unless a real
 * matching tax event exists.
 */
export function buildFinanceDecisionCard(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  analysisBundle: DecisionAnalysisBundle,
  primaryAction: NotificationActionButton | null,
): DecisionFinanceCard | undefined {
  if (item.sourceSkill !== 'finance') return undefined;
  const month = item.relatedEntityType === 'finance_tax_event' ? item.relatedEntityId : null;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return undefined; // same gate as the finance executor
  const year = Number(month.slice(0, 4));
  const event = getTaxEvents(item.userId, { year, tenantId: item.tenantId }).find((candidate) => candidate.month === month);
  if (!event) return undefined; // no hollow card
  return {
    // Safe labels only — month + status enum + freshness; no amount/currency/due value ever.
    taxMonth: event.month,
    paymentStatus: event.status,
    freshnessLabel: analysisBundle.freshnessLabel,
    nextActionLabel: logic.primaryActionLabel || (primaryAction?.label ?? null),
  };
}



export function relatedEntitiesSafeForRecord(item: DecisionRecord, logic: DecisionLogicV2): Array<{ type: string; label: string }> {
  if (!item.relatedEntityType || !item.relatedEntityId) {
    return logic.relatedEntityReason ? [{ type: 'reason', label: logic.relatedEntityReason }] : [];
  }
  const sensitive = item.privacyPolicy === 'financial' || item.privacyPolicy === 'sensitive';
  return [{
    type: item.relatedEntityType,
    label: sensitive ? `${sourceLabel(item.sourceSkill)} item` : `${sourceLabel(item.sourceSkill)} ${item.relatedEntityType.replace(/_/g, ' ')}`,
  }];
}



export function sourceTraceSummaryForRecord(item: DecisionRecord, logic: DecisionLogicV2): string {
  const entity = item.relatedEntityType ? item.relatedEntityType.replace(/_/g, ' ') : 'source state';
  const verifier = logic.readBackVerifier ?? 'non-mutating decision';
  return `${sourceLabel(item.sourceSkill)} ${entity} -> Decision Center v2 -> ${verifier}`;
}



export function sourceTraceForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionSourceTrace {
  const sourceEntityIds = item.relatedEntityType && item.relatedEntityId
    ? [`${item.relatedEntityType}:${item.relatedEntityId}`]
    : [];
  // C2: when the decision is anchored on a Secretary agenda item, surface
  // its persisted reasoning trail. Use the same owner-scoped read used by
  // `decisionContextForRecord` so cross-tenant leaks are impossible
  // (lookup tuple = agendaItemId + ownerUserId + tenantId).
  const reasoningTrail = reasoningTrailForRecord(item);
  return {
    originatingSkill: item.sourceSkill,
    originatingSignal: item.type,
    sourceEntityIds,
    sourceTimestamp: item.createdAt,
    enrichmentService: 'decision-center-logic-v2',
    orchestrator: item.sourceSkill === 'secretary' || item.type === 'conflict_detected'
      ? 'secretary-decision-advisor'
      : 'decision-center-facade',
    executor: actionsForRecord(item).length > 0 ? executorSkillForAction(actionsForRecord(item)[0].id, item) : null,
    verifier: logic.readBackVerifier,
    relatedStateReadModels: relatedStateReadModelsForRecord(item),
    confidenceSource: logic.confidence >= 0.8 ? 'structured-state-and-readback' : 'partial-structured-state',
    dataFreshness: item.status === 'snoozed' ? 'cached' : 'live',
    ...(reasoningTrail && reasoningTrail.length > 0 ? { reasoningTrail } : {}),
  };
}



export function analysisForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAnalysisBundle {
  const context = decisionContextForRecord(item);
  const sourceFreshness = sourceFreshnessForRecord(item, context);
  const confidenceLabel = logic.confidence >= 0.8 ? 'high' : logic.confidence >= 0.6 ? 'medium' : 'low';
  const rollbackConfidence = !rollbackContractForRecord(item).available
    ? 'none'
    : logic.readBackVerifier
      ? 'high'
      : logic.confidence >= 0.7
        ? 'medium'
        : 'low';
  return {
    confidence: logic.confidence,
    confidenceLabel,
    sourceFreshness,
    freshnessLabel: freshnessLabel(sourceFreshness, context),
    whyNow: logic.urgencyReason || logic.whySummary,
    expectedOutcome: logic.expectedEffect,
    costOfDelay: logic.impactIfIgnored,
    tradeoffs: logic.why.tradeoffs.slice(0, 3),
    uncertainty: logic.why.uncertainty.slice(0, 3),
    rollbackConfidence,
  };
}



export function sourceFreshnessForRecord(item: DecisionRecord, context: DecisionLogicContext): DecisionAnalysisBundle['sourceFreshness'] {
  if (item.status === 'snoozed') return 'stale';
  if (context.contextExpiresAt) {
    const contextExpiry = Date.parse(context.contextExpiresAt);
    if (!Number.isFinite(contextExpiry)) return 'unknown';
    if (contextExpiry <= Date.now()) return 'stale';
  }
  const state = String(context.providerSyncState ?? '').toLowerCase();
  if (state && state !== 'synced' && state !== 'deleted') {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt ?? ''));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    const ageMinutes = (Date.now() - updatedAt) / 60_000;
    return ageMinutes > 15 ? 'stale' : 'fresh';
  }
  if (context.providerSyncUpdatedAt) {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    return (Date.now() - updatedAt) / 60_000 <= 15 ? 'fresh' : 'live';
  }
  return item.relatedEntityId ? 'live' : 'unknown';
}



export function freshnessLabel(freshness: DecisionAnalysisBundle['sourceFreshness'], context: DecisionLogicContext): string {
  switch (freshness) {
    case 'live':
      return 'Live read model';
    case 'fresh':
      return context.providerSyncUpdatedAt ? `Fresh as of ${context.providerSyncUpdatedAt}` : 'Fresh provider state';
    case 'stale':
      return context.providerSyncUpdatedAt ? `Provider state may be stale since ${context.providerSyncUpdatedAt}` : 'Stale state; refresh before acting';
    case 'unknown':
    default:
      return 'Freshness unknown';
  }
}



export function topSuggestionForItem(item: DecisionApiItem): DecisionCenterTopSuggestion {
  return {
    decisionId: item.decisionId,
    title: item.explanation?.headline ?? item.safePreviewTitle ?? item.title,
    actionLabel: item.explanation?.actionLabels?.primary ?? item.recommendedActionLabel ?? item.primaryActionLabel ?? null,
    whyNow: item.explanation?.whyItMatters ?? item.analysis?.whyNow ?? item.whySummary ?? item.urgencyReason,
    expectedOutcome: item.explanation?.result ?? item.analysis?.expectedOutcome ?? item.expectedEffect,
    riskIfIgnored: item.explanation?.ifIgnored ?? item.analysis?.costOfDelay ?? item.impactIfIgnored,
    sourceSkill: item.sourceSkill,
    urgency: item.urgency,
  };
}



/**
 * Read the persisted Secretary reasoning trail for a decision record.
 *
 * Returns `null` when:
 * - the record isn't anchored on a `secretary_agenda_item`, OR
 * - the agenda item is missing / doesn't match the owner+tenant scope, OR
 * - the persisted column is empty (e.g. legacy rows from before W-E).
 *
 * The owner+tenant scope is enforced by `getSecretaryAgendaItemById` itself,
 * so a cross-tenant decisionId cannot leak another user's trail.
 */
export function reasoningTrailForRecord(item: DecisionRecord): ReasoningTrailNode[] | null {
  if (item.relatedEntityType !== 'secretary_agenda_item' || !item.relatedEntityId) return null;
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: item.relatedEntityId,
    ownerUserId: item.userId,
    tenantId: item.tenantId,
  });
  if (!agenda) return null;
  return agenda.reasoningTrail.length > 0 ? agenda.reasoningTrail : null;
}



export function relatedStateReadModelsForRecord(item: DecisionRecord): string[] {
  const models = ['notification_center_items', 'notification_intents'];
  if (item.sourceSkill === 'secretary') models.push('secretary_agenda_items');
  if (item.sourceSkill === 'content') models.push('content_workflow_objects');
  if (item.sourceSkill === 'cooking') models.push('cooking_meal_plans');
  if (item.sourceSkill === 'finance') models.push('finance_tax_events');
  return models;
}



export function dependencyGraphSummaryForRecord(
  dependencies: { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[] },
  locale?: string | null,
): string | null {
  const pt = String(locale ?? '').toLowerCase().startsWith('pt');
  if (dependencies.blockedByDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.blockedByDecisionIds.length;
      return `Bloqueado por ${count} decisão${count === 1 ? '' : 'ões'} por resolver.`;
    }
    return `Blocked by ${dependencies.blockedByDecisionIds.length} unresolved decision${dependencies.blockedByDecisionIds.length === 1 ? '' : 's'}.`;
  }
  if (dependencies.dependsOnDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.dependsOnDecisionIds.length;
      return `Relacionado com ${count} decisão${count === 1 ? '' : 'ões'} anterior${count === 1 ? '' : 'es'}.`;
    }
    return `Related to ${dependencies.dependsOnDecisionIds.length} upstream decision${dependencies.dependsOnDecisionIds.length === 1 ? '' : 's'}.`;
  }
  return null;
}



export function actionTruthTableEntryForRecord(
  item: DecisionRecord,
  action: NotificationActionButton,
  logic: DecisionLogicV2,
  rollback: { available: boolean },
): DecisionActionTruthTableEntry {
  return buildDecisionActionTruthTableEntry({
    actionId: action.id,
    sourceSkill: item.sourceSkill,
    expectedEffect: logic.expectedEffect,
    readBackVerifier: logic.readBackVerifier,
    outcomeSummary: outcomeSummaryForRecord({ ...item, status: 'actioned' }, logic).outcomeSummary,
    rollbackAvailable: rollback.available,
    notificationCanAct: logic.notificationEligibility === 'visible' && logic.quality.safeForAPNs,
    riskIfIgnored: logic.riskIfIgnored,
    priority: item.priority,
  });
}



export function askNexusContextForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAskNexusContext {
  return {
    decisionId: item.itemId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    prompt: `Explain this ${sourceLabel(item.sourceSkill)} decision, the recommendation, and what changes if I approve: ${logic.safePreviewTitle || logic.title}`,
  };
}



export function decisionLogicForIntentInput(input: NotificationIntentInput): DecisionLogicV2 {
  return buildDecisionLogicV2({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    title: input.title,
    body: input.body,
    safeBody: input.body,
    actions: input.actionButtons ?? [],
    relatedEntityType: input.relatedEntityType ?? null,
    relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
    deadlineAt: input.decisionDeadline ?? null,
    expiresAt: input.expiresAt ?? null,
    privacyClassification: input.privacyPolicy ?? privacyPolicyForSource(input.sourceSkill),
    visibilityScope: visibilityScopeForIntentInput(input),
    context: decisionContextForIntentInput(input),
  });
}



export function decisionLogicForRecord(record: DecisionRecord): DecisionLogicV2 {
  return buildDecisionLogicV2(decisionLogicInputForRecord(record));
}



export function decisionLogicInputForRecord(record: DecisionRecord): Parameters<typeof buildDecisionLogicV2>[0] {
  return {
    sourceSkill: record.sourceSkill,
    type: record.type,
    priority: record.priority,
    title: record.title,
    body: record.body,
    safeBody: record.safeBody,
    actions: actionsForRecord(record),
    relatedEntityType: record.relatedEntityType,
    relatedEntityId: record.relatedEntityId,
    deadlineAt: record.decisionDeadline,
    expiresAt: record.expiresAt,
    privacyClassification: record.privacyPolicy,
    visibilityScope: visibilityScopeForItem(record),
    context: decisionContextForRecord(record),
  };
}



export function decisionContextForIntentInput(input: NotificationIntentInput): DecisionLogicContext {
  const suppliedRaw = input.decisionContext ?? null;
  const supplied = withUserDecisionContextDefaults(input.userId, suppliedRaw);
  const relatedEntityType = input.relatedEntityType ?? null;
  if (input.sourceSkill === 'secretary' && relatedEntityType === 'secretary_agenda_item' && input.relatedEntityId != null) {
    const tenantId = input.tenantId ?? input.userId;
    let agenda: SecretaryAgendaItem | null = null;
    try {
      agenda = getSecretaryAgendaItemById({
        agendaItemId: String(input.relatedEntityId),
        ownerUserId: input.userId,
        tenantId,
      });
    } catch (error) {
      if (!hasDecisionContextPayload(suppliedRaw)) throw error;
      logger.warn({
        event: 'decision.secretary_agenda_context_unavailable',
        userId: input.userId,
        tenantId,
      }, 'Using supplied structured decision context while Secretary agenda read model is unavailable');
    }
    if (agenda) return secretaryAgendaDecisionContext(agenda, supplied);
  }
  if (hasDecisionContextPayload(suppliedRaw)) return supplied;
  if (input.sourceSkill === 'training' && isMissingRaceDateRecipe(input.dedupeKey)) {
    return withUserDecisionContextDefaults(input.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  return supplied;
}



/**
 * True when a decision's dedupeKey marks it as the training "missing race date" RECIPE. Gated on the
 * recipe (dedupeKey prefix), NOT free-text title/body — so untrusted evidence text that happens to
 * contain the phrase "race date" can never trip race-date context/supersession handling and wrongly
 * hide an unrelated training decision. The missing-race-date fixtures/recipe use a dedupeKey like
 * `training:missing-race-date:<userId>:demo`.
 */
export function isMissingRaceDateRecipe(dedupeKey: string | null | undefined): boolean {
  return /(^|:)missing[- ]race[- ]date/i.test(dedupeKey ?? '');
}



export function decisionContextForRecord(record: DecisionRecord): DecisionLogicContext {
  const hasStoredContext = hasDecisionContextPayload(record.decisionContext);
  const storedContext = withUserDecisionContextDefaults(record.userId, record.decisionContext);
  if (record.sourceSkill === 'secretary' && record.relatedEntityType === 'secretary_agenda_item' && record.relatedEntityId) {
    let agenda: SecretaryAgendaItem | null = null;
    try {
      agenda = getSecretaryAgendaItemById({
        agendaItemId: record.relatedEntityId,
        ownerUserId: record.userId,
        tenantId: record.tenantId,
      });
    } catch (error) {
      if (!hasStoredContext) throw error;
      logger.warn({
        event: 'decision.secretary_agenda_context_unavailable',
        userId: record.userId,
        tenantId: record.tenantId,
      }, 'Using stored structured decision context while Secretary agenda read model is unavailable');
    }
    if (agenda) return secretaryAgendaDecisionContext(agenda, storedContext);
    if (hasStoredContext) return storedContext;
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'secretary agenda item is missing' });
  }
  if (hasStoredContext) return storedContext;
  if (record.sourceSkill === 'content') {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (contentObjectId) {
      const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
      if (object) return withUserDecisionContextDefaults(record.userId, { entityTitle: object.title, sourceState: object.approvalState });
    }
  }
  if (record.sourceSkill === 'training' && isMissingRaceDateRecipe(record.dedupeKey)) {
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  if (record.type === 'sync_failure') {
    return withUserDecisionContextDefaults(record.userId, { providerName: sourceLabel(record.sourceSkill), explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' });
  }
  return storedContext;
}



export function secretaryAgendaDecisionContext(agenda: SecretaryAgendaItem, supplied?: DecisionLogicContext | null): DecisionLogicContext {
  const candidateSlots = secretaryCandidateSlots(agenda, supplied);
  const currentStartAt = supplied?.currentStartAt ?? agenda.startAt ?? null;
  const currentEndAt = supplied?.currentEndAt ?? agenda.endAt ?? null;
  const advice = adviseSecretaryDecision({
    title: agenda.title,
    currentStartAt,
    currentEndAt,
    availableSlots: candidateSlots,
    allowProtectedTimeOverride: supplied?.allowProtectedTimeOverride === true,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    timezone: supplied?.timezone,
    locale: supplied?.locale,
  });
  const normalizedAction = normalizeDecisionAction(supplied?.normalizedAction)
    ?? buildSecretaryAgendaReflowAction(agenda, supplied, advice.recommendedStartAt, advice.recommendedEndAt);
  const suppliedTitle = supplied?.entityTitle?.trim() ?? '';
  return {
    ...(supplied ?? {}),
    // Producers may deliberately supply a privacy-safe fixed label. Preserve
    // it rather than re-inserting user-authored agenda copy into policy JSON.
    entityTitle: suppliedTitle && !isGenericDecisionCopy(suppliedTitle) ? suppliedTitle : agenda.title,
    currentStartAt,
    currentEndAt,
    recommendedStartAt: advice.recommendedStartAt,
    recommendedEndAt: advice.recommendedEndAt,
    candidateSlots,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    sourceState: supplied?.sourceState ?? agenda.lifecycleState,
    providerSyncState: agenda.providerSyncState,
    providerSyncUpdatedAt: agenda.updatedAt,
    recipe: supplied?.recipe ?? 'secretary_reflow_window_v1',
    normalizedAction,
  };
}



export function buildSecretaryAgendaReflowAction(
  agenda: SecretaryAgendaItem,
  context: DecisionLogicContext | null | undefined,
  recommendedStartAt: string | null,
  recommendedEndAt: string | null,
): NormalizedDecisionAction {
  const revision = secretaryAgendaStateRevision(agenda);
  const timezone = context?.timezone ?? 'UTC';
  const requestedWindow = recommendedStartAt && recommendedEndAt
    && Number.isFinite(Date.parse(recommendedStartAt))
    && Number.isFinite(Date.parse(recommendedEndAt))
    && Date.parse(recommendedStartAt) < Date.parse(recommendedEndAt)
    ? { start: recommendedStartAt, end: recommendedEndAt, timezone }
    : undefined;
  const localDay = requestedWindow
    ? DateTime.fromISO(requestedWindow.start, { setZone: true }).setZone(timezone).toISODate()
    : null;
  return buildNormalizedDecisionAction({
    intent: 'reflow_secretary_agenda',
    targetEntities: [{ type: 'secretary_agenda_item', id: agenda.agendaItemId, version: revision }],
    affectedResources: [
      { type: 'secretary_agenda_item', id: agenda.agendaItemId },
      { type: 'calendar_timeline', id: `${agenda.tenantId}:${localDay ?? 'unscheduled'}` },
    ],
    ...(requestedWindow ? { requestedWindow } : {}),
    preconditions: [{
      type: 'agenda_state',
      ref: agenda.agendaItemId,
      expectedVersion: revision,
      required: true,
    }],
    expectedEffects: [{ type: 'move_agenda_window', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    prohibitedEffects: [{ type: 'overwrite_changed_agenda_state', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    dependencies: [],
    exclusivityKeys: [
      `secretary_agenda_item:${agenda.tenantId}:${agenda.agendaItemId}`,
      `calendar_timeline:${agenda.tenantId}:${localDay ?? 'unscheduled'}`,
    ],
    authorizationScope: ['decision_center:write'],
    risk: 'medium',
    reversibility: 'reversible',
    contextVersion: `ctx_secretary_agenda_${revision}`,
  });
}



export function withUserDecisionContextDefaults(userId: number, context?: DecisionLogicContext | null): DecisionLogicContext {
  const merged: DecisionLogicContext = { ...(context ?? {}) };
  const defaults = userDecisionContextDefaults(userId);
  if (!merged.timezone && defaults.timezone) merged.timezone = defaults.timezone;
  if (!merged.locale && defaults.locale) merged.locale = defaults.locale;
  return merged;
}



export function hasDecisionContextPayload(context?: DecisionLogicContext | null): boolean {
  if (!context || typeof context !== 'object') return false;
  return Object.keys(context).some((key) => key !== 'timezone' && key !== 'locale');
}



export function userDecisionContextDefaults(userId: number): Pick<DecisionLogicContext, 'timezone' | 'locale'> {
  if (!Number.isFinite(userId) || userId <= 0) return {};
  try {
    const row = getDb().prepare('SELECT language, timezone FROM users WHERE id = ?').get(userId) as {
      language?: string | null;
      timezone?: string | null;
    } | undefined;
    const timezone = validateDecisionTimezone(row?.timezone);
    const locale = validateDecisionLocale(row?.language);
    return {
      ...(timezone ? { timezone } : {}),
      ...(locale ? { locale } : {}),
    };
  } catch {
    return {};
  }
}



export function validateDecisionTimezone(timezone?: string | null): string | undefined {
  if (typeof timezone !== 'string' || !timezone.trim()) return undefined;
  const trimmed = timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}



export function validateDecisionLocale(locale?: string | null): string | undefined {
  if (typeof locale !== 'string' || !locale.trim()) return undefined;
  return normalizeSupportedLang(locale, 'en-US');
}



export function secretaryCandidateSlots(
  agenda: SecretaryAgendaItem,
  supplied?: DecisionLogicContext | null,
): SecretaryAvailableSlot[] {
  const slots: SecretaryAvailableSlot[] = [];
  const addSlot = (
    startAt?: string | null,
    endAt?: string | null,
    label?: string | null,
    metadata?: Partial<SecretaryAvailableSlot> | null,
  ) => {
    if (!startAt || !endAt) return;
    if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(startAt) >= Date.parse(endAt)) return;
    if (slots.some((slot) => Date.parse(slot.startAt) === Date.parse(startAt) && Date.parse(slot.endAt) === Date.parse(endAt))) return;
    slots.push({
      ...(metadata ?? {}),
      startAt,
      endAt,
      label: label ?? metadata?.label ?? undefined,
    });
  };

  for (const slot of supplied?.candidateSlots ?? []) {
    addSlot(slot.startAt, slot.endAt, slot.label ?? 'Candidate slot', slot);
  }
  addSlot(supplied?.recommendedStartAt, supplied?.recommendedEndAt, 'Recommended slot');
  for (const segment of agenda.scheduledSegments ?? []) {
    addSlot(segment.start, segment.end, segment.label ?? 'Secretary candidate');
  }
  addSlot(agenda.startAt, agenda.endAt, 'Proposed slot');
  return slots;
}



export function outcomeSummaryForRecord(record: DecisionRecord, logic: DecisionLogicV2): {
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
} {
  if (!record.actionResult) return { outcomeSummary: null, failureReason: null, retryActions: [] };
  const actionId = typeof record.actionResult.actionId === 'string' ? record.actionResult.actionId : null;
  const errorCode = typeof record.actionResult.errorCode === 'string' ? record.actionResult.errorCode : null;
  if (record.status === 'failed' || errorCode) {
    return {
      outcomeSummary: 'Action failed. You can retry.',
      failureReason: errorCode ?? 'Decision action failed.',
      retryActions: actionsForRecord(record).filter((action) => action.style === 'primary' || action.id !== 'open_detail'),
    };
  }
  if (record.status === 'actioned') {
    if (record.sourceSkill === 'secretary') {
      const startAt = typeof record.actionResult.startAt === 'string' ? record.actionResult.startAt : null;
      const endAt = typeof record.actionResult.endAt === 'string' ? record.actionResult.endAt : null;
      const context = decisionContextForRecord(record);
      const window = formatDecisionWindow(startAt, endAt, context.timezone, context.locale) ?? 'the proposed window';
      return { outcomeSummary: `Done — Secretary applied ${window} and verified the agenda item.`, failureReason: null, retryActions: [] };
    }
    if (record.sourceSkill === 'content') {
      const state = typeof record.actionResult.approvalState === 'string' ? record.actionResult.approvalState : 'updated';
      return { outcomeSummary: `Done — content workflow is ${state}.`, failureReason: null, retryActions: [] };
    }
    return { outcomeSummary: `Done — ${logic.expectedEffect}`, failureReason: null, retryActions: [] };
  }
  return { outcomeSummary: null, failureReason: null, retryActions: [] };
}



export function explanationForDecisionItem(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  if (record.status === 'failed') return finalizeDecisionExplanation(record, failedDecisionExplanation(record, logic));
  if (record.status === 'actioned') {
    const actionId = actionIdForRecord(record) ?? 'completed';
    return finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
      actionId,
      actualEffect: record.actionResult ?? {},
      message: outcomeSummaryForRecord(record, logic).outcomeSummary ?? null,
    }));
  }
  return finalizeDecisionExplanation(record, openDecisionExplanation(record, logic));
}



export function openDecisionExplanation(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  const entity = entityLabelForRecord(record, logic);
  const source = sourceLabel(record.sourceSkill);
  const userAction = openDecisionUserAction(record, logic);
  const verification = openVerificationTextForRecord(record, logic);
  const actionLabels = guidanceActionLabelsForRecord(record, logic);
  const result = guidanceWhatWillChangeForRecord(record, logic);
  const base: DecisionExplanation = {
    headline: `${source} needs a decision on ${entity}.`,
    whatHappened: firstConcrete([logic.problemStatement, logic.safePreviewBody, record.safeBody, record.body], `${source} found an item that needs review.`),
    whyItMatters: firstConcrete([logic.whySummary, logic.impactIfIgnored], `This affects ${source} orchestration and should stay explicit.`),
    nexusAction: firstConcrete([logic.recommendation], `Nexus prepared the safest available ${source} move and is waiting for your choice.`),
    userAction,
    result,
    verification,
    nextStep: userAction,
    recommendedMove: firstConcrete([logic.recommendation, userAction], userAction),
    ifIgnored: firstConcrete([logic.impactIfIgnored, logic.whySummary], `This ${source} item stays unresolved.`),
    actionLabels,
    displaySections: GUIDANCE_DISPLAY_SECTIONS,
    steps: [
      { label: 'Signal reviewed', detail: firstConcrete([logic.problemStatement], `${source} evaluated the source signal.`), status: 'done' },
      { label: 'User decision needed', detail: userAction, status: 'needs_user' },
      { label: 'Nexus action', detail: result, status: 'pending' },
      { label: 'Verification', detail: verification, status: logic.readBackVerifier ? 'pending' : 'done' },
    ],
  };
  if (record.type === 'sync_failure') {
    return {
      ...base,
      headline: `${source} sync needs attention.`,
      whatHappened: firstConcrete([logic.problemStatement], `${source} sync did not finish cleanly.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], `Recent ${source} data may stay stale until the sync is retried.`),
      nexusAction: firstConcrete([logic.recommendation], `Nexus can retry the sync without changing your plan.`),
      userAction: openDecisionUserAction(record, logic),
      result: firstConcrete([logic.expectedEffect], `Nexus retries ${source} sync and checks provider status.`),
      nextStep: openDecisionUserAction(record, logic),
    };
  }
  if (record.sourceSkill === 'content') {
    return {
      ...base,
      headline: `${entity} needs content review.`,
      whatHappened: firstConcrete([logic.problemStatement], `${entity} is ready for approval or rewrite feedback.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Publishing stays paused until you approve it or request changes.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus can advance the workflow or keep quality control open for a rewrite.'),
      userAction: openDecisionUserAction(record, logic),
      result: firstConcrete([logic.expectedEffect], 'The content state changes only after Nexus confirms the updated state.'),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'secretary') {
    return {
      ...base,
      headline: `${entity} needs schedule judgment.`,
      whatHappened: firstConcrete([logic.problemStatement], `Secretary found a schedule conflict or reflow option for ${entity}.`),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Leaving it open can keep the day plan conflicted or stale.'),
      nexusAction: firstConcrete([logic.recommendation], 'Secretary prepared the safest schedule change and is waiting for approval.'),
      result: firstConcrete([logic.expectedEffect], guidanceWhatWillChangeForRecord(record, logic)),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'finance') {
    return {
      ...base,
      headline: `${source} needs confirmation.`,
      whatHappened: firstConcrete([logic.problemStatement], 'A finance item needs explicit confirmation.'),
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Keeping financial state accurate prevents stale reminders and bad planning pressure.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus will update only the scoped finance item after your confirmation.'),
      result: firstConcrete([logic.expectedEffect], 'Finance state is updated and verified without exposing private values in previews.'),
      verification: openVerificationTextForRecord(record, logic),
    };
  }
  if (record.sourceSkill === 'cooking') {
    return {
      ...base,
      headline: `${source} needs a meal choice.`,
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Meal and fueling choices change the plan only when you confirm them.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus prepared the safest meal-plan update and is waiting for your choice.'),
      result: firstConcrete([logic.expectedEffect], 'Cooking updates the meal plan after the choice is verified.'),
    };
  }
  if (record.sourceSkill === 'training') {
    return {
      ...base,
      headline: `${entity} needs training judgment.`,
      whyItMatters: firstConcrete([logic.impactIfIgnored, logic.whySummary], 'Training changes can affect load, recovery, and protected work later in the week.'),
      nexusAction: firstConcrete([logic.recommendation], 'Nexus prepared the safest coach move and is waiting for approval.'),
      result: firstConcrete([logic.expectedEffect], 'Training state changes only after the relevant plan state is verified.'),
    };
  }
  return base;
}



export function failedDecisionExplanation(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanation {
  const source = sourceLabel(record.sourceSkill);
  const failure = outcomeSummaryForRecord(record, logic);
  const retry = actionsForRecord(record).find((action) => action.style === 'primary')?.label ?? 'Retry or review the decision';
  return {
    headline: `${source} action needs retry.`,
    whatHappened: firstConcrete([logic.problemStatement], `${source} could not complete the last action.`),
    whyItMatters: firstConcrete([failure.failureReason, logic.impactIfIgnored], 'The decision remains open until Nexus can verify the result.'),
    nexusAction: 'Nexus stopped before closing the decision because it could not confirm a safe result.',
    userAction: retry,
    result: firstConcrete([failure.outcomeSummary], 'No verified state change was recorded.'),
    verification: firstConcrete([failure.failureReason], 'The final source check failed or returned an error.'),
    nextStep: retry,
    recommendedMove: retry,
    ifIgnored: firstConcrete([logic.impactIfIgnored], 'The decision stays open until the result is confirmed.'),
    actionLabels: guidanceActionLabelsForRecord(record, logic),
    displaySections: GUIDANCE_DISPLAY_SECTIONS,
    steps: [
      { label: 'Action attempted', detail: 'Nexus tried to perform the selected action.', status: 'done' },
      { label: 'Verification blocked', detail: firstConcrete([failure.failureReason], 'The resulting state could not be verified.'), status: 'blocked' },
      { label: 'Needs review', detail: retry, status: 'needs_user' },
    ],
  };
}



export function handledDecisionExplanation(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  input: {
    actionId: string;
    actualEffect?: Record<string, unknown> | null;
    message?: string | null;
  },
): DecisionExplanation {
  const actionLabel = actionLabelForRecord(record, input.actionId);
  const humanActionLabel = humanActionLabelForRecord(
    record,
    logic,
    record.actions.find((action) => action.id === input.actionId) ?? null,
  ) ?? actionLabel;
  const entity = entityLabelForRecord(record, logic);
  const source = sourceLabel(record.sourceSkill);
  const actualEffect = input.actualEffect ?? {};
  const result = handledResultForRecord(record, logic, input.actionId, actualEffect, input.message);
  const verification = handledVerificationTextForRecord(record, logic, input.actionId, actualEffect);
  const nextStep = rollbackContractForRecord({ ...record, status: 'actioned' }).available
    ? 'No action is needed now. Undo is available if this change no longer works.'
    : 'No action is needed in Decision Center right now.';
  const base: DecisionExplanation = {
    headline: `${source} handled ${entity}.`,
    whatHappened: firstConcrete([logic.problemStatement], `${source} had an actionable Decision Center item.`),
    whyItMatters: handledBenefitForRecord(record, logic, input.actionId),
    nexusAction: `Nexus performed ${humanActionLabel} for ${entity}.`,
    userAction: 'No user action needed now.',
    result,
    verification,
    nextStep,
    recommendedMove: nextStep,
    ifIgnored: handledBenefitForRecord(record, logic, input.actionId),
    actionLabels: guidanceActionLabelsForRecord(record, logic),
    displaySections: ['what_will_change', 'why_it_matters', 'verification'],
    steps: [
      { label: 'Decision cleared', detail: `${source} item left the active queue.`, status: 'done' },
      { label: 'Action performed', detail: `Nexus performed ${humanActionLabel}.`, status: 'done' },
      { label: 'Verification checked', detail: verification, status: 'done' },
      { label: 'Next step', detail: nextStep, status: 'done' },
    ],
  };
  if (input.actionId === 'auto_dismiss_stale_decision') {
    return {
      ...base,
      headline: `${source} removed a resolved decision.`,
      nexusAction: `Nexus removed ${entity} from the active queue because the source state already changed.`,
      result: `The Decision Center no longer asks you to handle ${entity}.`,
      verification: firstConcrete([input.message], 'Nexus confirmed the source item was no longer actionable.'),
      nextStep: 'No action is needed unless the source item reopens.',
      steps: [
        { label: 'Source checked', detail: firstConcrete([input.message], 'The source state no longer requires this decision.'), status: 'done' },
        { label: 'Queue cleaned', detail: `${entity} was removed from active decisions.`, status: 'done' },
        { label: 'User spared', detail: 'No duplicate decision remains for you to clear.', status: 'done' },
      ],
    };
  }
  if (record.sourceSkill === 'content') {
    const state = stringOrNull(actualEffect.contentApprovalState) ?? stringOrNull(actualEffect.approvalState);
    const isRewrite = input.actionId === 'request_rewrite' || state === 'rewrite_requested';
    return {
      ...base,
      headline: isRewrite ? `Rewrite requested for ${entity}.` : `${entity} approved.`,
      nexusAction: isRewrite
        ? `Nexus requested changes on ${entity} and kept publishing paused.`
        : `Nexus approved ${entity} and moved the content workflow forward.`,
      result: isRewrite
        ? 'The content workflow is marked for rewrite, so quality control continues before publishing.'
        : 'The content workflow is approved and ready for its next downstream step.',
      nextStep: isRewrite
        ? 'Review the rewritten draft in Content when it is ready.'
        : 'Continue from Content when you are ready to publish or schedule it.',
    };
  }
  if (record.sourceSkill === 'secretary') {
    const context = decisionContextForRecord(record);
    const window = formatDecisionWindow(
      stringOrNull(actualEffect.startAt),
      stringOrNull(actualEffect.endAt),
      context.timezone,
      context.locale,
    );
    return {
      ...base,
      headline: `Secretary rescheduled ${entity}.`,
      nexusAction: `Secretary applied ${humanActionLabel} for ${entity}.`,
      result: window
        ? `${entity} was placed in ${window} and removed from active decisions.`
        : `${entity} was reflowed and removed from active decisions.`,
      nextStep: actualEffect.rollbackAvailable === true
        ? 'No action needed now. Undo remains available if the new timing no longer works.'
        : nextStep,
    };
  }
  if (record.sourceSkill === 'finance') {
    return {
      ...base,
      headline: `Finance updated ${entity}.`,
      nexusAction: `Nexus performed ${actionLabel} on the scoped finance item.`,
      result: 'Finance state is updated, so stale payment or tax reminders can stay out of the queue.',
      nextStep: 'No Decision Center action is needed unless Finance opens a new item.',
    };
  }
  return base;
}



export function handledBenefitForRecord(record: DecisionRecord, logic: DecisionLogicV2, actionId: string): string {
  if (actionId === 'auto_dismiss_stale_decision') {
    return 'This prevents you from clearing a decision that the source system already resolved.';
  }
  if (record.sourceSkill === 'content') {
    return 'The content workflow has a verified next state instead of staying blocked in review.';
  }
  if (record.sourceSkill === 'secretary') {
    return 'Your active queue is quieter because the schedule change was applied and verified.';
  }
  if (record.sourceSkill === 'finance') {
    return 'Financial reminders stay aligned with the verified source of truth.';
  }
  if (record.sourceSkill === 'training') {
    return 'Training coordination can continue from a verified plan state.';
  }
  if (record.sourceSkill === 'cooking') {
    return 'Meal planning can continue from a verified choice instead of another prompt.';
  }
  return firstConcrete([logic.expectedEffect, logic.whySummary], 'Nexus verified the result and removed the item from active decisions.');
}



export function handledResultForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  actionId: string,
  actualEffect: Record<string, unknown>,
  message?: string | null,
): string {
  if (message && !isGenericDecisionCopy(message)) return message;
  const outcome = outcomeSummaryForRecord({ ...record, status: 'actioned', actionResult: { actionId, ...actualEffect } }, logic).outcomeSummary;
  if (outcome && !isGenericDecisionCopy(outcome)) return outcome;
  if (record.sourceSkill === 'content') {
    const state = stringOrNull(actualEffect.contentApprovalState) ?? stringOrNull(actualEffect.approvalState);
    if (!state) return 'Content action completed; source confirmation is still pending.';
    return `Content workflow is now ${state}.`;
  }
  const state = concreteVerificationStateForRecord(record, actualEffect);
  if (state) return `${sourceLabel(record.sourceSkill)} state is now ${state}.`;
  return `${sourceLabel(record.sourceSkill)} action completed; source confirmation is still pending.`;
}



export function openDecisionUserAction(record: DecisionRecord, logic: DecisionLogicV2): string {
  const primary = firstConcreteOrNull([logic.primaryActionLabel, recommendedAction(actionsForRecord(record))?.label]);
  if (primary) return primary;
  if (record.requiresUserAction) return `Choose how Nexus should handle this ${sourceLabel(record.sourceSkill)} item.`;
  return `Review this ${sourceLabel(record.sourceSkill)} item when you are ready.`;
}



export function concreteVerificationStateForRecord(
  record: DecisionRecord,
  actualEffect: Record<string, unknown>,
): string | null {
  const fieldNames = DECISION_VERIFICATION_STATE_FIELDS[record.sourceSkill]
    ?? ['decisionStatus', 'state', 'status', 'lifecycleState', 'syncState'];
  for (const fieldName of fieldNames) {
    const value = stringOrNull(actualEffect[fieldName]);
    if (value) return value;
  }
  return null;
}



export function guidanceEnabledForRecord(record: DecisionRecord): boolean {
  const scope = { userId: record.userId, tenantId: record.tenantId };
  return isDecisionCenterGuidanceV1Enabled(process.env, scope)
    && isDecisionCenterGuidanceSkillEnabled(record.sourceSkill, process.env, scope);
}



export function isPortugueseRecord(record: DecisionRecord): boolean {
  return isPortugueseLocale(decisionContextForRecord(record).locale);
}



export function guidanceActionLabelsForRecord(record: DecisionRecord, logic: DecisionLogicV2): DecisionExplanationActionLabels | undefined {
  const actions = actionsForRecord(record);
  const primary = recommendedAction(actions);
  const primaryLabel = humanActionLabelForRecord(record, logic, primary);
  if (!primaryLabel) return undefined;
  const secondary = actions
    .filter((action) => action.id !== primary?.id && action.id !== 'open_detail')
    .map((action) => humanActionLabelForRecord(record, logic, action))
    .filter((label): label is string => !!label)
    .slice(0, 2);
  return { primary: primaryLabel, secondary };
}



export function humanActionLabelForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  action?: NotificationActionButton | null,
): string | null {
  const pt = isPortugueseRecord(record);
  const context = decisionContextForRecord(record);
  const recommendedWindow = formatDecisionWindow(
    context.recommendedStartAt,
    context.recommendedEndAt,
    context.timezone,
    context.locale,
  );
  if (record.sourceSkill === 'secretary') {
    if (action?.id === 'accept_reflow' || /reflow/i.test(action?.label ?? logic.primaryActionLabel)) {
      return recommendedWindow
        ? (pt ? `Mover para ${recommendedWindow}` : `Move to ${recommendedWindow}`)
        : (pt ? 'Remarcar' : 'Reschedule');
    }
    if (action?.id === 'choose_another_time') {
      return pt ? 'Escolher outro horário' : 'Choose another time';
    }
    if (action?.id === 'undo_reflow') {
      return pt ? 'Desfazer mudança' : 'Undo change';
    }
  }
  const label = firstConcreteOrNull([action?.label, logic.primaryActionLabel]);
  if (!label) return null;
  if (/^reflow$/i.test(label)) return pt ? 'Remarcar' : 'Reschedule';
  if (/^open detail$/i.test(label)) return pt ? 'Rever' : 'Review';
  return label;
}



export function guidanceWhatWillChangeForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const change = logic.whatWillChange[0];
  if (change?.effect) return change.effect;
  return firstConcrete([logic.expectedEffect], `Nexus will update ${sourceLabel(record.sourceSkill)} after your choice.`);
}



export function openVerificationTextForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const source = sourceLabel(record.sourceSkill);
  if (record.sourceSkill === 'secretary') return 'Nexus will check the calendar item after the change before closing this.';
  if (record.sourceSkill === 'content') return 'Nexus will check the content state after your choice before closing this.';
  if (record.sourceSkill === 'finance') return 'Nexus will check Finance after your confirmation before closing this.';
  if (record.sourceSkill === 'training') return 'Nexus will check the training plan state after your choice before closing this.';
  if (record.sourceSkill === 'cooking') return 'Nexus will check the meal plan after your choice before closing this.';
  if (logic.readBackVerifier) return `Nexus will check ${source} after your choice before closing this.`;
  return `Nexus will keep this item in ${source} until the source state changes.`;
}



export function handledVerificationTextForRecord(
  record: DecisionRecord,
  logic: DecisionLogicV2,
  actionId: string,
  actualEffect: Record<string, unknown>,
): string {
  const concreteState = concreteVerificationStateForRecord(record, actualEffect);
  const source = sourceLabel(record.sourceSkill);
  if (concreteState) return `Nexus checked ${source} and found the state is ${concreteState}.`;
  if (logic.readBackVerifier) return `Nexus checked ${source}; full source confirmation is still pending.`;
  return `${source} action ${actionLabelForRecord(record, actionId)} completed; Nexus will keep watching for source confirmation.`;
}



export function sanitizeGuidanceString(
  value: string,
  context: { decisionId?: string; sourceSkill?: NotificationSourceSkill } = {},
): DecisionGuidanceSanitizationResult {
  let sanitized = value;
  const rejectedTerms: string[] = [];
  for (const term of GUIDANCE_BANNED_TERMS) {
    if (!term.pattern.test(sanitized)) {
      term.pattern.lastIndex = 0;
      continue;
    }
    term.pattern.lastIndex = 0;
    rejectedTerms.push(term.label);
    sanitized = sanitized.replace(term.pattern, term.replacement ?? '[redacted]');
  }
  if (rejectedTerms.length > 0) {
    decisionGuidanceStats.bannedTermsCaught += rejectedTerms.length;
    for (const term of rejectedTerms) {
      decisionGuidanceStats.bannedTermsByTerm[term] = (decisionGuidanceStats.bannedTermsByTerm[term] ?? 0) + 1;
    }
    logger.warn({
      decisionId: context.decisionId ?? 'unknown',
      sourceSkill: context.sourceSkill ?? 'unknown',
      rejectedTerms,
    }, 'Decision Center guidance copy redacted technical terms');
  }
  return { sanitized, rejectedTerms };
}



export function sanitizeDecisionExplanation(record: DecisionRecord, explanation: DecisionExplanation): DecisionExplanation {
  const context = { decisionId: record.itemId, sourceSkill: record.sourceSkill };
  const sanitize = (value: string) => sanitizeGuidanceString(value, context).sanitized;
  const sanitized: DecisionExplanation = {
    ...explanation,
    headline: sanitize(explanation.headline),
    whatHappened: sanitize(explanation.whatHappened),
    whyItMatters: sanitize(explanation.whyItMatters),
    nexusAction: sanitize(explanation.nexusAction),
    userAction: sanitize(explanation.userAction),
    result: sanitize(explanation.result),
    verification: sanitize(explanation.verification),
    nextStep: sanitize(explanation.nextStep),
    recommendedMove: explanation.recommendedMove ? sanitize(explanation.recommendedMove) : undefined,
    ifIgnored: explanation.ifIgnored ? sanitize(explanation.ifIgnored) : undefined,
    actionLabels: explanation.actionLabels
      ? {
        primary: sanitize(explanation.actionLabels.primary),
        secondary: explanation.actionLabels.secondary.map(sanitize),
      }
      : undefined,
    displaySections: explanation.displaySections,
    steps: explanation.steps.map((step) => ({
      ...step,
      label: sanitize(step.label),
      detail: sanitize(step.detail),
    })),
  };
  if (!sanitized.recommendedMove || !sanitized.ifIgnored || !sanitized.actionLabels?.primary) {
    decisionGuidanceStats.partial += 1;
  } else {
    decisionGuidanceStats.emitted += 1;
  }
  return sanitized;
}



export function finalizeDecisionExplanation(record: DecisionRecord, explanation: DecisionExplanation): DecisionExplanation {
  if (!guidanceEnabledForRecord(record)) {
    decisionGuidanceStats.nullGuidance += 1;
    const {
      recommendedMove,
      ifIgnored,
      actionLabels,
      displaySections,
      ...legacy
    } = explanation;
    void recommendedMove;
    void ifIgnored;
    void actionLabels;
    void displaySections;
    return sanitizeDecisionExplanation(record, legacy);
  }
  return sanitizeDecisionExplanation(record, explanation);
}



export function actionIdForRecord(record: DecisionRecord): string | null {
  return record.decisionLogActionTaken
    ?? stringOrNull(record.actionResult?.actionId)
    ?? null;
}



export function actionLabelForRecord(record: DecisionRecord, actionId: string): string {
  return record.actions.find((action) => action.id === actionId)?.label
    ?? humanizeActionId(actionId);
}



export function entityLabelForRecord(record: DecisionRecord, logic: DecisionLogicV2): string {
  const context = decisionContextForRecord(record);
  return firstConcrete([
    context.entityTitle,
    logic.safePreviewTitle,
    logic.title,
    record.title,
  ], `${sourceLabel(record.sourceSkill)} item`);
}



export function firstConcrete(candidates: Array<string | null | undefined>, fallback: string | null): string {
  return firstConcreteOrNull(candidates) ?? fallback ?? 'Decision details are available in Nexus.';
}



export function firstConcreteOrNull(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isGenericDecisionCopy(trimmed)) continue;
    return trimmed;
  }
  return null;
}



export function isGenericDecisionCopy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'secretary'
    || normalized === 'review'
    || normalized === 'completed'
    || normalized === 'action saved'
    || normalized.startsWith('secretary needs your attention')
    || normalized.startsWith('nexus needs your attention')
    || normalized.startsWith('nexus completed the requested action')
    || normalized.startsWith('nexus completed:')
    || normalized.startsWith('nexus found a schedule or capacity conflict')
    || normalized.startsWith('demo schedule conflict')
    || normalized.startsWith('open nexus to view details');
}



export function normalizeDecisionExplanation(value: unknown): DecisionExplanation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const headline = stringOrNull(record.headline);
  const whatHappened = stringOrNull(record.whatHappened);
  const whyItMatters = stringOrNull(record.whyItMatters);
  const nexusAction = stringOrNull(record.nexusAction);
  const userAction = stringOrNull(record.userAction);
  const result = stringOrNull(record.result);
  const verification = stringOrNull(record.verification);
  const nextStep = stringOrNull(record.nextStep);
  if (!headline || !whatHappened || !whyItMatters || !nexusAction || !userAction || !result || !verification || !nextStep) {
    return null;
  }
  const recommendedMove = stringOrNull(record.recommendedMove) ?? undefined;
  const ifIgnored = stringOrNull(record.ifIgnored) ?? undefined;
  const actionLabels = normalizeDecisionExplanationActionLabels(record.actionLabels);
  const displaySections = normalizeDecisionExplanationDisplaySections(record.displaySections);
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps = rawSteps
    .map((step) => normalizeDecisionExplanationStep(step))
    .filter((step): step is DecisionExplanationStep => !!step);
  return {
    headline,
    whatHappened,
    whyItMatters,
    nexusAction,
    userAction,
    result,
    verification,
    nextStep,
    steps,
    recommendedMove,
    ifIgnored,
    actionLabels,
    displaySections,
  };
}



export function normalizeDecisionExplanationActionLabels(value: unknown): DecisionExplanationActionLabels | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const primary = stringOrNull(record.primary);
  if (!primary) return undefined;
  const secondary = Array.isArray(record.secondary)
    ? record.secondary.map((item) => stringOrNull(item)).filter((item): item is string => !!item)
    : [];
  return { primary, secondary };
}



export function normalizeDecisionExplanationDisplaySections(value: unknown): DecisionExplanationDisplaySection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.filter((section): section is DecisionExplanationDisplaySection => isDecisionExplanationDisplaySection(section));
  return sections.length > 0 ? sections : undefined;
}



export function isDecisionExplanationDisplaySection(value: unknown): value is DecisionExplanationDisplaySection {
  return value === 'decision_needed'
    || value === 'what_will_change'
    || value === 'why_it_matters'
    || value === 'options'
    || value === 'verification'
    || value === 'debug';
}



export function normalizeDecisionExplanationStep(value: unknown): DecisionExplanationStep | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const label = stringOrNull(record.label);
  const detail = stringOrNull(record.detail);
  const status = stringOrNull(record.status);
  if (!label || !detail || !isDecisionExplanationStepStatus(status)) return null;
  return { label, detail, status };
}



export function isDecisionExplanationStepStatus(value: string | null): value is DecisionExplanationStepStatus {
  return value === 'done' || value === 'needs_user' || value === 'pending' || value === 'blocked';
}



export function privacyPolicyForSource(sourceSkill: NotificationSourceSkill): NotificationPrivacyPolicy {
  if (sourceSkill === 'finance') return 'financial';
  if (sourceSkill === 'training') return 'health';
  if (sourceSkill === 'content') return 'private_content';
  if (sourceSkill === 'security') return 'sensitive';
  return 'standard';
}



export function sourceLabel(source: NotificationSourceSkill): string {
  switch (source) {
    case 'secretary': return 'Secretary';
    case 'training': return 'Training';
    case 'content': return 'Content';
    case 'cooking': return 'Cooking';
    case 'finance': return 'Finance';
    case 'chat': return 'Chat';
    case 'system': return 'System';
    case 'security': return 'Security';
  }
}



export function recommendedAction(actions: NotificationActionButton[]): NotificationActionButton | null {
  return actions.find((action) => action.style === 'primary')
    ?? actions.find((action) => action.id !== 'open_detail')
    ?? actions[0]
    ?? null;
}



export function confidenceForItem(item: DecisionRecord): number {
  if (item.type === 'decision_required') return 0.72;
  if (item.type === 'conflict_detected' || item.type === 'approval_required') return 0.86;
  if (item.type === 'sync_failure') return 0.8;
  return 0.75;
}



export function riskLevelForItem(item: DecisionRecord): 'low' | 'medium' | 'high' {
  const normalizedRisk = normalizeDecisionAction(decisionContextForRecord(item).normalizedAction)?.risk;
  if (normalizedRisk === 'critical' || normalizedRisk === 'high') return 'high';
  if (normalizedRisk === 'medium') return 'medium';
  if (normalizedRisk === 'low') return 'low';
  if (item.priority === 'critical' || item.priority === 'time_sensitive') return 'high';
  if (item.type === 'approval_required' || item.type === 'sync_failure') return 'medium';
  return 'low';
}



export function visibilityScopeForItem(item: DecisionRecord): DecisionApiItem['visibilityScope'] {
  return visibilityScopeFromContext(item.decisionContext) ?? 'user_private';
}



export function visibilityScopeForIntentInput(input: NotificationIntentInput): DecisionVisibilityScope {
  const candidate = input.visibilityScope ?? input.decisionContext?.visibilityScope;
  return normalizeVisibilityScope(candidate) ?? 'user_private';
}



export function visibilityScopeFromContext(context: DecisionLogicContext | null | undefined): DecisionVisibilityScope | null {
  return normalizeVisibilityScope(context?.visibilityScope);
}



export function normalizeVisibilityScope(value: unknown): DecisionVisibilityScope | null {
  return value === 'user_private'
    || value === 'tenant_shared'
    || value === 'tenant_admin'
    || value === 'system_admin'
    ? value
    : null;
}



export function ctaLabelForSummary(openCount: number, urgentCount: number, top: DecisionApiItem | null, locale?: string | null): string {
  const pt = isPortugueseLocale(locale);
  if (openCount === 0) return pt ? 'Tudo certo' : 'All Clear';
  if (urgentCount > 0) return pt ? 'Decisão urgente' : 'Urgent Decision';
  if (top?.type === 'conflict_detected') return pt ? 'Conflito de agenda' : 'Schedule Conflict';
  if (openCount === 1) return pt ? '1 decisão' : '1 Decision';
  return pt ? `${openCount} decisões` : `${openCount} Decisions`;
}



export function isPortugueseLocale(locale?: string | null): boolean {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('pt');
}



export function getDecisionRecord(decisionId: string, userId: number, tenantId = userId): DecisionRecord | null {
  assertScope(userId, tenantId, 'get_decision_record', { decisionId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version, intents.context_observed_at
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId) as any;
  return row ? mapDecisionRecord(row) : null;
}



export function mapDecisionRecord(row: any): DecisionRecord {
  return {
    itemId: row.item_id,
    intentId: row.intent_id,
    decisionLogId: row.decision_log_id ?? null,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    safeBody: row.safe_body,
    sensitiveBody: row.sensitive_body ?? null,
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    status: row.status,
    deeplink: row.deeplink,
    actions: safeParseJson(row.actions_json, []),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    relatedEntityId: row.related_entity_id,
    relatedEntityType: row.related_entity_type,
    decisionContext: safeParseJson(row.decision_context_json, null),
    requiresUserAction: !!row.requires_user_action,
    // Carried through so the badge can exclude it. A Decision Center row is
    // never promotional today, but the field is required by the shared type
    // and defaulting it silently would reintroduce the gap it closes.
    promotional: !!row.promotional,
    decisionDeadline: row.decision_deadline,
    privacyPolicy: row.privacy_policy ?? 'standard',
    deliveryPolicy: row.delivery_policy,
    snoozedUntil: row.snoozed_until ?? null,
    priorityScore: row.priority_score ?? null,
    actionedAt: row.actioned_at ?? null,
    decisionLogActionTaken: row.decision_log_action_taken ?? null,
    actionResult: row.action_result_json ? safeParseJson(row.action_result_json, null) : null,
    recordVersion: Number.isSafeInteger(Number(row.record_version)) && Number(row.record_version) > 0
      ? Number(row.record_version)
      : 1,
    decisionState: isDurableDecisionState(row.decision_state) ? row.decision_state : null,
    updatedAt: row.updated_at ?? row.created_at,
    supersededByItemId: row.superseded_by_item_id ?? null,
    contextObservedAt: row.context_observed_at ?? null,
    storedContextVersion: typeof row.context_version === 'string' && row.context_version.trim()
      ? row.context_version
      : null,
  };
}



export function isDurableDecisionState(value: unknown): value is DurableDecisionState {
  return value === 'proposed' || value === 'needs_input' || value === 'blocked'
    || value === 'ready_for_review' || value === 'approved' || value === 'rejected'
    || value === 'deferred' || value === 'superseded' || value === 'expired'
    || value === 'cancelled';
}



export function durableDecisionStateForRecord(record: DecisionRecord): DurableDecisionState {
  if (record.decisionState === 'deferred' && !isSnoozedUntilFuture(record)) return 'ready_for_review';
  if (record.decisionState) return record.decisionState;
  switch (record.status) {
    case 'snoozed': return 'deferred';
    case 'actioned': return 'approved';
    case 'dismissed': return 'rejected';
    case 'superseded': return 'superseded';
    case 'expired': return 'expired';
    case 'unread':
    case 'read':
    case 'viewed':
    case 'failed':
    default:
      return 'ready_for_review';
  }
}



export function isSnoozedUntilFuture(item: DecisionRecord): boolean {
  if (item.status !== 'snoozed' || !item.snoozedUntil) return false;
  const untilMs = Date.parse(item.snoozedUntil);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}



/**
 * A decision whose hard deadline (expires_at) has already passed must never be
 * surfaced as actionable. This uses the same Date.parse semantics as the
 * action-time guard in guardActionable(), so the display filter and the
 * action guard agree on "expired". A null/unparseable expires_at is treated as
 * non-expiring (matches guardActionable, which only flips on a finite past ms).
 */
export function isDecisionExpired(item: DecisionRecord): boolean {
  if (!item.expiresAt) return false;
  const expiresMs = Date.parse(item.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}



export function requiredPermissionsForRecord(record: DecisionRecord): string[] {
  return normalizeDecisionAction(decisionContextForRecord(record).normalizedAction)?.authorizationScope ?? [];
}



export function approvalLevelForRecord(record: DecisionRecord): DecisionApprovalLevel {
  const action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction);
  const conflict = decisionContextForRecord(record).conflictEvaluation;
  if (conflict?.findings.some((finding) => finding.class === 'permission_policy')) return 'unavailable';
  if (isSecretaryReviewOnlyPreview(record, action)) return 'none';
  const visibilityScope = visibilityScopeForItem(record);
  if (record.sourceSkill === 'security' || visibilityScope === 'tenant_admin' || visibilityScope === 'system_admin') {
    return 'admin_review';
  }
  // Finance remains a strong-confirmation class even before its normalized
  // domain adapter exists. Under flow enforcement that intentionally fails
  // closed: no structured review means no current strong approval token.
  if (record.sourceSkill === 'finance') return 'strong_confirmation';
  if (!action) return record.requiresUserAction ? 'user_confirmation' : 'none';
  if (action.risk === 'critical' || action.risk === 'high' || action.reversibility === 'irreversible'
  ) return 'strong_confirmation';
  return record.requiresUserAction ? 'user_confirmation' : 'none';
}



export function reviewSupportedForRecord(
  record: DecisionRecord,
  action = normalizeDecisionAction(decisionContextForRecord(record).normalizedAction),
  approvalLevel = approvalLevelForRecord(record),
): boolean {
  // The emergency legacy engine remains behind the rewrite authorization
  // guard, so high-impact actions must still expose a way to acquire the
  // strong approval that execution now requires unconditionally.
  const legacyStrongApproval = approvalLevel === 'strong_confirmation'
    && record.actions.some((candidate) => MUTATING_ACTIONS.has(candidate.id));
  if (!decisionFlowV1EnforcedForRecord(record) && !legacyStrongApproval) return false;
  if ((!action && !legacyStrongApproval)
      || approvalLevel === 'none'
      || approvalLevel === 'unavailable'
      || approvalLevel === 'admin_review') return false;
  const state = durableDecisionStateForRecord(record);
  return (state === 'proposed' || state === 'ready_for_review' || state === 'blocked' || state === 'needs_input')
    && !['actioned', 'dismissed', 'expired', 'superseded'].includes(record.status);
}



export function isSecretaryReviewOnlyPreview(
  record: DecisionRecord,
  action: NormalizedDecisionAction | null,
): boolean {
  if (record.sourceSkill !== 'secretary') return false;
  const context = decisionContextForRecord(record);
  const reasons = new Set(context.reasonCodes ?? []);
  return reasons.has('preview_only')
    && record.actions.length > 0
    && record.actions.every((candidate) => candidate.id === 'open_detail')
    && !!action?.prohibitedEffects.some((effect) =>
      effect.type === 'automatic_execution'
      || effect.type === 'automatic_external_mutation'
      || effect.type === 'automatic_calendar_mutation');
}



/**
 * Refresh is a first-class recovery operation whenever either its dedicated
 * rollout is enabled or flow-v1 enforcement depends on fresh revalidation.
 * Keeping this decision in one helper prevents the API contract from
 * advertising a recovery action whose route would return 404.
 */
export function decisionRefreshSupportedForScope(userId: number, tenantId = userId): boolean {
  return isDecisionRefreshEnabled(process.env, { userId, tenantId })
    || isDecisionFlowV1EnforceEnabled(process.env, { userId, tenantId })
    || getDecisionConflictPolicyV1Mode(process.env, { userId, tenantId }) === 'active';
}



/** Route-level gate that adds only Training-personal v1 enforcement. */
export function decisionRefreshSupportedForDecision(
  decisionId: string,
  userId: number,
  tenantId = userId,
): boolean {
  if (decisionRefreshSupportedForScope(userId, tenantId)) return true;
  const record = getDecisionRecord(decisionId, userId, tenantId);
  return Boolean(record && record.sourceSkill === 'training' && decisionFlowV1EnforcedForRecord(record));
}



export function decisionRefreshSupportedForRecord(record: DecisionRecord): boolean {
  return (decisionRefreshSupportedForScope(record.userId, record.tenantId)
    || decisionFlowV1EnforcedForRecord(record))
    && ['unread', 'read', 'failed', 'snoozed'].includes(record.status)
    && normalizeDecisionAction(decisionContextForRecord(record).normalizedAction) !== null;
}



export function executionSummaryForRecord(record: DecisionRecord): DecisionExecutionSummary {
  let row: {
    action_execution_id: string;
    action_id: string;
    status: string;
    effect_results_json: string | null;
    recovery_json: string | null;
    error_code: string | null;
  } | undefined;
  try {
    row = getDb().prepare(`
      SELECT action_execution_id, action_id, status, effect_results_json, recovery_json, error_code
        FROM decision_action_executions
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId) as typeof row;
  } catch {
    row = undefined;
  }
  if (!row) return { status: actionOutcomeFromRecord(record), effectResults: [], recoveryActions: [] };
  const rawStatus = row.status === 'partially_failed' ? 'partially_failed'
    : row.status === 'succeeded' && row.action_id === 'undo_reflow' ? 'rolled_back'
      : row.status === 'succeeded' ? 'succeeded'
      : row.status === 'failed' ? 'failed'
        : row.status === 'started' ? 'started' : 'none';
  const effectResults = safeParseJson<DecisionEffectResult[]>(row.effect_results_json, [])
    .filter((effect) => effect && typeof effect.effectId === 'string'
      && ['pending', 'succeeded', 'failed', 'compensated', 'unknown'].includes(effect.status));
  const recovery = safeParseJson<{ message?: string; actions?: NotificationActionButton[] }>(row.recovery_json, {});
  const recoveryActions = (Array.isArray(recovery.actions) ? recovery.actions : [])
    .filter((action) => action?.id !== 'refresh'
      || decisionRefreshSupportedForRecord(record)
      || (row?.status === 'partially_failed'
        && decisionRefreshSupportedForScope(record.userId, record.tenantId)))
    .slice(0, 4);
  const recoveryMessage = recovery.message && recoveryActions.length === 0
    && /refresh/i.test(recovery.message)
    ? 'Review the current source state before choosing a recovery action.'
    : recovery.message;
  return {
    status: rawStatus,
    lastAttemptId: row.action_execution_id,
    effectResults,
    recoveryActions,
    ...(recoveryMessage ? { message: recoveryMessage } : row.error_code ? { message: row.error_code } : {}),
  };
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Side-effect-free reads, projections, and deterministic ranking boundary. */
export {
  buildDecisionCardSummary,
  deriveEvidenceStrengthLabel,
} from './card-projection';


export {
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
} from './projection-policy';


export type { DecisionFatiguePolicy } from './projection-policy';


export {
  DECISION_RANKING_POLICY,
  DECISION_RANKING_VERSION,
  rankDecisionPriority,
} from './ranking-policy';


export type {
  DecisionPrioritySnapshot,
  DecisionPriorityTier,
  DecisionRankingInputs,
} from './ranking-policy';
