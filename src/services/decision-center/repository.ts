// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center repository implementation.
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
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
} from '../content-tenant-scope';

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
  DecisionActionError,
} from './command-service';
import {
  recordDecisionOutcome,
} from './lifecycle-preferences-jobs';
import {
  evaluateDecisionEligibility,
} from './proposal-service';
import {
  decisionLogicForRecord,
  decisionLogicInputForRecord,
  validateDecisionTimezone,
} from './read-projection-ranking-service';
import {
  DecisionApiItem,
  DecisionExplanationDisplaySection,
  DecisionGuidanceStats,
  DecisionHandledHistoryStats,
  DecisionRecord,
  DecisionUrgency,
} from './types';



export const DECISION_INTERNAL_LIST_HARD_CAP = 50_000;



export const DECISION_OUTCOME_LEDGER_RETENTION_POLICY = Object.freeze({
  rawOutcomeRetentionDays: 180,
  aggregateRetentionDays: 730,
  adminReportingScope: 'aggregate_only',
  privateTextPolicy: 'never_store_raw_private_text',
});



export function decisionFlowV1EnforcedForIntent(input: NotificationIntentInput): boolean {
  if (resolveDecisionCenterRewriteMode(process.env) === 'active') return true;
  const scope = { userId: input.userId, tenantId: input.tenantId ?? input.userId };
  return input.sourceSkill === 'training'
    ? isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)
    : isDecisionFlowV1EnforceEnabled(process.env, scope);
}



export function decisionFlowV1EnforcedForRecord(record: DecisionRecord): boolean {
  if (resolveDecisionCenterRewriteMode(process.env) === 'active') return true;
  const scope = { userId: record.userId, tenantId: record.tenantId };
  return record.sourceSkill === 'training'
    ? isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)
    : isDecisionFlowV1EnforceEnabled(process.env, scope);
}



export const DECISION_TYPES = new Set<NotificationIntentType>([
  'decision_required',
  'conflict_detected',
  'reflow_suggestion',
  'approval_required',
  'sync_failure',
  'security_account',
]);



export const NON_DECISION_TYPES = new Set<NotificationIntentType>([
  'reminder',
  'missed_item',
  'daily_digest',
  'weekly_review',
  'insight',
]);



export const MUTATING_ACTIONS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'retry',
  'option_a',
  'option_b',
  'mark_paid',
  'add_meal',
  'undo_reflow',
  'accept_chat_action_fix',
  'activate_training_plan_revision',
  'activate_training_coach_v2_proposal',
  'approve_product_learning_case',
]);


export const VERSIONED_DECISION_ACTIONS = new Set([
  ...MUTATING_ACTIONS,
  'dismiss',
  'reject_reflow',
  'not_now',
  'snooze',
]);


export const DECISION_EXECUTION_LEASE_SECONDS = 300;


export const CONTENT_APPROVAL_ACTION_IDS = new Set(['approve_script', 'request_rewrite']);


export const SECRETARY_REFLOW_ACTION_IDS = new Set(['accept_reflow', 'choose_another_time']);


export const FINANCE_PAYMENT_ACTION_IDS = new Set(['mark_paid']);



export function appNowIso(): string {
  return new Date(Date.now()).toISOString();
}



export const DECISION_VERIFICATION_STATE_FIELDS: Record<string, string[]> = {
  content: ['contentApprovalState', 'approvalState', 'workflowState'],
  secretary: ['lifecycleState', 'agendaState', 'providerSyncState'],
  finance: ['paymentStatus', 'financeStatus', 'taxEventStatus'],
  training: ['planState', 'lifecycleState', 'trainingState'],
  cooking: ['mealPlanState', 'mealState'],
  sync: ['syncState'],
  system: ['systemState'],
  security: ['securityState'],
  connections: ['syncState', 'connectionState'],
};



export const GUIDANCE_DISPLAY_SECTIONS: DecisionExplanationDisplaySection[] = [
  'decision_needed',
  'what_will_change',
  'why_it_matters',
  'options',
  'verification',
];



export const GUIDANCE_BANNED_TERMS: Array<{ pattern: RegExp; label: string; replacement?: string }> = [
  { pattern: /\[smoke\]/gi, label: '[SMOKE]' },
  { pattern: /decision\s+center\s+(?:v|version\s*)?\d+/gi, label: 'Decision Center version' },
  { pattern: /source[\s_-]?trace/gi, label: 'source_trace' },
  { pattern: /read[\s_-]?back/gi, label: 'read-back', replacement: 'source confirmation' },
  { pattern: /\bverifies\b/gi, label: 'verifier', replacement: 'checks' },
  { pattern: /\b(verifier|verified by verifier)\b/gi, label: 'verifier' },
  { pattern: /secretary[\s_]agenda[\s_]items?(?:[\s_]state)?/gi, label: 'secretary_agenda_items' },
  { pattern: /workflow\s+object/gi, label: 'workflow object' },
  { pattern: /\b(enum|table|model)[\s_-]?name\b/gi, label: 'schema field' },
  { pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+_(?:id|pk|fk|ref|json|table|enum|model)\b/gi, label: 'raw identifier' },
];



export const decisionHandledHistoryStats = {
  writeFailures: 0,
  backfillRuns: 0,
  backfilled: 0,
  backfillFailures: 0,
};



export const decisionGuidanceStats = {
  emitted: 0,
  nullGuidance: 0,
  partial: 0,
  bannedTermsCaught: 0,
  bannedTermsByTerm: {} as Record<string, number>,
  filteredFromUserView: 0,
  filteredByReason: {} as Record<string, number>,
};



export function getDecisionHandledHistoryStats(): DecisionHandledHistoryStats {
  return { ...decisionHandledHistoryStats };
}



export function getDecisionGuidanceStats(): DecisionGuidanceStats {
  return {
    ...decisionGuidanceStats,
    bannedTermsByTerm: { ...decisionGuidanceStats.bannedTermsByTerm },
    filteredByReason: { ...decisionGuidanceStats.filteredByReason },
  };
}



export function decisionOutcomeFlagsForAction(
  actionId: string,
  action: NotificationActionButton,
): Pick<Parameters<typeof recordDecisionOutcome>[1], 'accepted' | 'dismissed' | 'snoozed' | 'askedNexus'> {
  if (actionId === 'open_detail') return { askedNexus: true };
  if (actionId === 'dismiss' || actionId === 'reject_reflow' || actionId === 'not_now') {
    return { dismissed: true };
  }
  if (actionId === 'snooze') return { snoozed: true };
  return { accepted: action.style === 'primary' };
}



export function assertDecisionScopedUpdateApplied(
  result: { changes: number },
  operation: string,
  details: Record<string, unknown>,
): void {
  if (result.changes > 0) return;
  throw new DecisionActionError(
    'DECISION_READBACK_MISMATCH',
    'Decision scoped update did not affect any rows',
    409,
    { operation, ...details },
  );
}



export function isDecisionRecord(item: DecisionRecord): boolean {
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    requiresUserAction: item.requiresUserAction,
    actionButtons: item.actions,
    deliveryPolicy: item.deliveryPolicy,
  });
  return eligibility.classification === 'decision';
}



export function urgencyForPriority(priority: NotificationPriority, deadlineAt?: string | null, expiresAt?: string | null): DecisionUrgency {
  if (priority === 'critical' || priority === 'time_sensitive') return 'urgent';
  const deadline = deadlineAt ?? expiresAt;
  if (deadline) {
    const ms = Date.parse(deadline);
    if (Number.isFinite(ms) && ms - Date.now() <= 24 * 3_600_000) return 'today';
  }
  if (priority === 'active') return 'today';
  return 'optional';
}



export function isVisiblePushEligible(priority: NotificationPriority, type: NotificationIntentType, requiresUserAction: boolean): boolean {
  if (!requiresUserAction) return false;
  if (priority === 'passive') return false;
  return type === 'conflict_detected'
    || type === 'approval_required'
    || type === 'sync_failure'
    || type === 'security_account'
    || priority === 'time_sensitive'
    || priority === 'critical';
}



export function priorityScoreFor(item: DecisionRecord): number {
  const logic = decisionLogicForRecord(item);
  const ranked = rankDecision(decisionLogicInputForRecord(item), logic, logic.quality);
  if (ranked.priorityScore > 0) return ranked.priorityScore;
  const urgencyScore = item.priority === 'critical' ? 100 : item.priority === 'time_sensitive' ? 90 : item.priority === 'active' ? 70 : 35;
  const deadline = item.decisionDeadline ?? item.expiresAt;
  const deadlineBoost = deadline && Date.parse(deadline) - Date.now() <= 24 * 3_600_000 ? 10 : 0;
  return urgencyScore + deadlineBoost;
}



export function compareDecisionApiItemsByRank(a: DecisionApiItem, b: DecisionApiItem): number {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  const aDeadline = Date.parse(a.deadlineAt ?? a.expiresAt ?? a.createdAt);
  const bDeadline = Date.parse(b.deadlineAt ?? b.expiresAt ?? b.createdAt);
  const safeADeadline = Number.isFinite(aDeadline) ? aDeadline : Number.MAX_SAFE_INTEGER;
  const safeBDeadline = Number.isFinite(bDeadline) ? bDeadline : Number.MAX_SAFE_INTEGER;
  if (safeADeadline !== safeBDeadline) return safeADeadline - safeBDeadline;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}



export function materializeDecisionPriorityScore(item: DecisionRecord, priorityScore: number): void {
  if (item.priorityScore === priorityScore) return;
  try {
    const result = getDb().prepare(`
      UPDATE notification_center_items
         SET priority_score = ?
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(priorityScore, item.itemId, item.userId, item.tenantId);
    assertScopedMutation(result, 'materialize_decision_priority_score', {
      itemId: item.itemId,
      userId: item.userId,
      tenantId: item.tenantId,
    });
    item.priorityScore = priorityScore;
  } catch (error) {
    logger.warn?.({ error, itemId: item.itemId }, 'Failed to materialize Decision Center priority score');
  }
}



export function assertScopedMutation(
  result: { changes?: number | bigint },
  operation: string,
  details: { itemId: string; userId: number; tenantId: number },
): void {
  if (Number(result.changes ?? 0) === 1) return;
  recordTenantScopeAnomaly({
    layer: 'orchestration',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(details.userId) ? details.userId : null,
    details,
  });
  throw new DecisionActionError('INVALID_SCOPE', 'Scoped mutation did not affect the expected decision row', 404, details);
}



export function parseDecisionTimestamp(value: string): DateTime {
  const trimmed = value.trim();
  if (!trimmed) return DateTime.invalid('empty decision timestamp');
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const iso = hasExplicitZone ? normalized : `${normalized}Z`;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (parsed.isValid) return parsed.toUTC();
  return DateTime.fromSQL(trimmed, { zone: 'utc' });
}



export function timestampMillis(value: string): number {
  const parsed = parseDecisionTimestamp(value);
  return parsed.isValid ? parsed.toMillis() : 0;
}



export function isTimestampInLocalDay(value: string, timezone: string, now: DateTime): boolean {
  const zone = validateDecisionTimezone(timezone) ?? 'UTC';
  const parsed = parseDecisionTimestamp(value);
  if (!parsed.isValid) return false;
  return parsed.setZone(zone).hasSame(now.setZone(zone), 'day');
}



export function timeToActionMs(record: DecisionRecord): number | null {
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, Date.now() - createdMs);
}



export function deadlineDistanceBucket(deadline: string | null): string {
  if (!deadline) return 'none';
  const delta = Date.parse(deadline) - Date.now();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta <= 3_600_000) return 'within_1h';
  if (delta <= 24 * 3_600_000) return 'within_24h';
  if (delta <= 7 * 24 * 3_600_000) return 'within_week';
  return 'later';
}



export function trainingRaceDatePresent(userId: number, tenantId: number): boolean {
  if (!tableExists('user_profiles')) return false;
  // Legacy user_profiles has no tenant_id column. It is safe only for the
  // repository's personal-tenant convention; shared tenants fail closed.
  if (tenantId !== userId) return false;
  const rows = getDb().prepare(`
    SELECT data
      FROM user_profiles
     WHERE user_id = ?
       AND profile_type IN ('fitness', 'training', 'triathlon-running')
  `).all(userId) as Array<{ data: string }>;
  for (const row of rows) {
    const data = safeParseJson<Record<string, unknown>>(row.data, {});
    const targetRaceDate = data.target_race_date ?? data.race_date;
    if (typeof targetRaceDate === 'string' && /\d{4}-\d{2}-\d{2}/.test(targetRaceDate)) return true;
  }
  return false;
}



export function tableExists(table: string): boolean {
  const row = getDb().prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1
  `).get(table) as { name: string } | undefined;
  return !!row;
}



export function recordHasAction(record: DecisionRecord, actionIds: Set<string>): boolean {
  return record.actions.some((action) => actionIds.has(action.id));
}



export function contentWorkflowObjectIdForDecision(record: DecisionRecord): string | null {
  if (record.relatedEntityType === 'content_workflow_object' && record.relatedEntityId) {
    return record.relatedEntityId;
  }
  if (record.relatedEntityType !== 'content_notification' || !record.relatedEntityId || !tableExists('content_notifications')) {
    return null;
  }
  const row = getDb().prepare(`
    SELECT data
      FROM content_notifications
     WHERE id = ?
       AND user_id = ?
       AND ${contentPrivateScopePredicate()}
     LIMIT 1
  `).get(
    record.relatedEntityId,
    record.userId,
    ...contentPrivateScopeParams(record.userId, record.tenantId),
  ) as { data?: string } | undefined;
  const data = safeParseJson<Record<string, unknown>>(row?.data, {});
  return firstWorkflowObjectId(data);
}



export function firstWorkflowObjectId(data: Record<string, unknown>): string | null {
  for (const key of ['contentObjectId', 'workflowObjectId', 'objectId', 'draftId', 'ideaId']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}



export function executorSkillForAction(actionId: string, record: DecisionRecord): string {
  if (actionId === 'approve_script' || actionId === 'request_rewrite') return 'content';
  if (record.type === 'conflict_detected' || actionId.includes('reflow')) return 'secretary';
  return record.sourceSkill;
}



export function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}



export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}



export function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}



export function assertScope(userId: number, tenantId: number, operation: string, details?: Record<string, unknown>): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'orchestration',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(userId) ? userId : null,
    details,
  });
  throw new DecisionActionError('INVALID_SCOPE', 'Invalid user or tenant scope', 401);
}
