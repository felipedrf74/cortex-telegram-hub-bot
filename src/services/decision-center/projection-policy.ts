// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NotificationActionButton } from '../notification-orchestrator';
import { computeSharedNotificationActionEffectiveStatus } from '../notification-action-state';
import { isDecisionActionExecutable } from '../decision-center-action-truth-table';
import type {
  Actionability,
  ConfidenceExplanation,
  DecisionActionEffectiveStatus,
  DecisionActionOutcomeStatus,
  DecisionAnalysisBundle,
  DecisionApiItem,
  DecisionEffectiveStatus,
  DecisionKind,
  DecisionLifecycleStatus,
  DurableDecisionState,
} from './types';
import type { DecisionLogicV2, DecisionWhy } from '../decision-center-logic-v2';

/** Minimal immutable input needed by pure client projection policy. */
export interface DecisionProjectionRecord {
  readonly status: string;
  readonly type: string;
  readonly sourceSkill: string;
  readonly requiresUserAction: boolean;
  readonly expiresAt: string | null;
  readonly snoozedUntil: string | null;
  readonly decisionState: DurableDecisionState | null;
  readonly actionResult: Record<string, unknown> | null;
}

/** Map the legacy flat status onto the lifecycle layer (read implies viewed). */
export function legacyStatusToLifecycle(status: string): DecisionLifecycleStatus {
  switch (status) {
    case 'unread': return 'surfaced';
    case 'read':
    case 'viewed': return 'viewed';
    case 'snoozed': return 'snoozed';
    case 'actioned': return 'completed';
    case 'dismissed': return 'dismissed';
    case 'expired': return 'expired';
    case 'superseded': return 'superseded';
    case 'failed': return 'surfaced';
    default: return 'created';
  }
}

/** Item-level action outcome; lifecycle remains independent. */
export function actionOutcomeFromRecord(
  record: Pick<DecisionProjectionRecord, 'status' | 'actionResult'>,
): DecisionActionOutcomeStatus {
  if (record.status === 'actioned' && record.actionResult?.actionId === 'undo_reflow') return 'rolled_back';
  if (record.status === 'actioned') return 'succeeded';
  if (record.status === 'failed') return 'failed';
  return 'none';
}

/** Pure effective-state fold used by list/detail projections. */
export function computeEffectiveStatus(
  record: DecisionProjectionRecord,
  ctx: {
    dependencies: { blockedByDecisionIds: string[] };
    logic: DecisionLogicV2;
    retryAvailable?: boolean;
    executionStatus?: DecisionActionOutcomeStatus;
  },
): DecisionEffectiveStatus {
  if (isDecisionExpired(record) || record.status === 'expired') return 'expired';
  if (record.status === 'superseded') return 'superseded';
  if (record.status === 'dismissed') return 'dismissed';
  if (ctx.executionStatus === 'started') return 'in_progress';
  if (ctx.executionStatus === 'partially_failed') return ctx.retryAvailable ? 'failed_retryable' : 'failed_terminal';
  if (record.status === 'actioned') return 'completed';
  if (record.status === 'failed') return ctx.retryAvailable ? 'failed_retryable' : 'failed_terminal';
  if (!ctx.logic.quality.safeToShowUser) return 'unavailable';
  if (isSnoozedUntilFuture(record)) return 'snoozed';
  if (ctx.dependencies.blockedByDecisionIds.length > 0) return 'waiting_on_dependency';
  if (record.type === 'sync_failure') return 'waiting_on_system';
  return 'needs_action';
}

/** Per-action capability plus lifecycle projection; never writes. */
export function computeActionEffectiveStatus(
  record: DecisionProjectionRecord,
  action: NotificationActionButton,
  ctx: {
    dependencies: { blockedByDecisionIds: string[] };
    logic: DecisionLogicV2;
    reconnectAffordance?: boolean;
    executionStatus?: DecisionActionOutcomeStatus;
  },
): DecisionActionEffectiveStatus {
  const base = computeSharedNotificationActionEffectiveStatus({
    actionId: action.id,
    status: record.status,
    expiresAt: record.expiresAt,
    safeForFrontendAction: ctx.logic.quality.safeForFrontendAction,
    blockedByDependency: ctx.dependencies.blockedByDecisionIds.length > 0
      || durableDecisionStateForProjection(record) === 'blocked',
    reconnectRequired: Boolean(
      ctx.reconnectAffordance
      && record.type === 'sync_failure'
      && action.id === 'retry'
    ),
  }) as DecisionActionEffectiveStatus;
  if (ctx.executionStatus === 'started' || ctx.executionStatus === 'partially_failed') {
    return {
      ...base,
      effective: 'disabled_missing_details',
      capabilityReason: ctx.executionStatus === 'started'
        ? 'execution_in_progress'
        : 'partial_execution_requires_recovery',
    };
  }
  return base;
}

export function computeDecisionKind(
  record: Pick<DecisionProjectionRecord, 'type' | 'sourceSkill' | 'requiresUserAction'>,
  logic: DecisionLogicV2,
  deps: { blockedByDecisionIds: string[] },
  primaryAction: NotificationActionButton | null,
): DecisionKind {
  if (deps.blockedByDecisionIds.length > 0) return 'blocked_action';
  if (record.type === 'sync_failure') return 'status_update';
  if (!record.requiresUserAction) return 'insight';
  if (record.type === 'conflict_detected' || record.sourceSkill === 'finance') return 'risk_alert';
  if (record.type === 'approval_required' || logic.automationEligibility === 'user_opt_in_required') return 'choice_required';
  if (primaryAction && isDecisionActionExecutable(primaryAction.id)) return 'action_proposal';
  return 'recommendation';
}

export function computeActionability(
  record: Pick<DecisionProjectionRecord, 'requiresUserAction'>,
  logic: DecisionLogicV2,
  effectiveStatus: DecisionEffectiveStatus,
  primaryAction: NotificationActionButton | null,
): Actionability {
  if (effectiveStatus === 'unavailable') return 'unavailable';
  if (effectiveStatus === 'waiting_on_dependency') return 'blocked';
  if (['expired', 'superseded', 'dismissed', 'completed'].includes(effectiveStatus)) return 'read_only';
  if (!record.requiresUserAction || !logic.quality.safeForFrontendAction) return 'read_only';
  if (!primaryAction || !isDecisionActionExecutable(primaryAction.id)) return 'read_only';
  return 'confirmation_required';
}

export function gateActionabilityForStaleEvidence(actionability: Actionability): Actionability {
  return ['execute_with_undo', 'confirmation_required', 'requires_human_review'].includes(actionability)
    ? 'preview_available'
    : actionability;
}

export function isHumanReviewQueueAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DECISION_HUMAN_REVIEW_QUEUE_AVAILABLE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === 'on' || raw === '1';
}

export function gateActionabilityForHumanReview(
  actionability: Actionability,
  queueAvailable: boolean,
): Actionability {
  return actionability === 'requires_human_review' && !queueAvailable ? 'unavailable' : actionability;
}

export interface DecisionFatiguePolicy {
  visibleCap: number;
  topPrimaryCount: number;
  perDomainCap: number;
}

const DEFAULT_FATIGUE_POLICY: DecisionFatiguePolicy = {
  visibleCap: 20,
  topPrimaryCount: 5,
  perDomainCap: 10,
};

export function isDecisionItemPolicyFloored(item: DecisionApiItem): boolean {
  const snapshot = item.prioritySnapshot;
  return Boolean(snapshot && (
    snapshot.reasonCodes.some((code) => code.startsWith('floor_'))
    || snapshot.priorityTier === 'critical'
  ));
}

export function applyDecisionFatigueCaps(
  rankedItems: DecisionApiItem[],
  policy: DecisionFatiguePolicy = DEFAULT_FATIGUE_POLICY,
): { primaryItems: DecisionApiItem[]; moreItems: DecisionApiItem[] } {
  const floored: DecisionApiItem[] = [];
  const regular: DecisionApiItem[] = [];
  for (const item of rankedItems) (isDecisionItemPolicyFloored(item) ? floored : regular).push(item);

  const perDomain = new Map<string, number>();
  const domainCapped = regular.filter((item) => {
    const seen = perDomain.get(item.sourceSkill) ?? 0;
    if (seen >= policy.perDomainCap) return false;
    perDomain.set(item.sourceSkill, seen + 1);
    return true;
  });
  const combined = [
    ...floored,
    ...domainCapped.slice(0, Math.max(policy.visibleCap - floored.length, 0)),
  ];
  const primaryCount = Math.max(policy.topPrimaryCount, 0);
  return {
    primaryItems: combined.slice(0, primaryCount),
    moreItems: combined.slice(primaryCount),
  };
}

export function computeConfidenceExplanation(
  confidence: number,
  why: DecisionWhy,
  analysis: Pick<DecisionAnalysisBundle, 'confidenceLabel' | 'sourceFreshness'>,
  exposeEvidence: boolean,
): ConfidenceExplanation {
  return {
    value: Number((Number.isFinite(confidence) ? confidence : 0).toFixed(2)),
    label: analysis.confidenceLabel,
    basis: exposeEvidence ? [...why.facts, ...why.rules].filter(Boolean).slice(0, 4) : [],
    uncertainty: exposeEvidence ? why.uncertainty.filter(Boolean).slice(0, 4) : [],
    sourceFreshness: analysis.sourceFreshness,
  };
}

function isDecisionExpired(record: Pick<DecisionProjectionRecord, 'expiresAt'>): boolean {
  if (!record.expiresAt) return false;
  const expiresMs = Date.parse(record.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}

function isSnoozedUntilFuture(
  record: Pick<DecisionProjectionRecord, 'status' | 'snoozedUntil'>,
): boolean {
  if (record.status !== 'snoozed' || !record.snoozedUntil) return false;
  const untilMs = Date.parse(record.snoozedUntil);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function durableDecisionStateForProjection(
  record: Pick<DecisionProjectionRecord, 'status' | 'decisionState' | 'snoozedUntil'>,
): DurableDecisionState {
  if (record.decisionState === 'deferred' && !isSnoozedUntilFuture(record)) return 'ready_for_review';
  if (record.decisionState) return record.decisionState;
  switch (record.status) {
    case 'snoozed': return 'deferred';
    case 'actioned': return 'approved';
    case 'dismissed': return 'rejected';
    case 'superseded': return 'superseded';
    case 'expired': return 'expired';
    default: return 'ready_for_review';
  }
}
