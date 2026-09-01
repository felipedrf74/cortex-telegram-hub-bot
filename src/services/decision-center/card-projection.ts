// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ConfidenceExplanation,
  DecisionActionEffectiveStatus,
  DecisionApiItem,
  DecisionCardSummary,
  EvidenceStrengthLabel,
} from './types';

export interface DecisionCardActionSummary {
  actionId: string;
  label: string;
  style?: string;
  effectiveStatus?: DecisionActionEffectiveStatus['effective'];
  implemented?: boolean;
  disabledReason?: string | null;
}

export interface DecisionCardSummaryV2Extras {
  whyNow?: string;
  costOfDelay?: string;
  primaryAction?: DecisionCardActionSummary;
  secondaryActions?: DecisionCardActionSummary[];
}

/**
 * Pure, privacy-safe evidence-strength projection. It deliberately ignores
 * confidence basis and uncertainty text because those fields are detail-only.
 */
export function deriveEvidenceStrengthLabel(
  confidence?: Pick<ConfidenceExplanation, 'label' | 'sourceFreshness'>,
): EvidenceStrengthLabel | undefined {
  if (!confidence) return undefined;
  if (confidence.sourceFreshness === 'stale') return 'stale';
  if (confidence.sourceFreshness === 'unknown') return 'unverified';
  return confidence.label === 'high' ? 'strong' : confidence.label === 'medium' ? 'moderate' : 'weak';
}

function summarizeDecisionAction(
  action: NonNullable<DecisionApiItem['recommendedAction']>,
  actionEffectiveStatuses?: DecisionActionEffectiveStatus[],
): DecisionCardActionSummary {
  const effective = actionEffectiveStatuses?.find((candidate) => candidate.actionId === action.id);
  return {
    actionId: action.id,
    label: action.label,
    style: action.style,
    effectiveStatus: effective?.effective,
    implemented: effective?.implemented,
    disabledReason: effective?.capabilityReason ?? null,
  };
}

/** Project a full Decision item to the immutable, privacy-safe v2 list card. */
export function buildDecisionCardSummary(
  item: DecisionApiItem,
): DecisionCardSummary & DecisionCardSummaryV2Extras {
  return {
    schemaVersion: 'decision-center.v2',
    decisionId: item.decisionId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    effectiveStatus: item.effectiveStatus,
    decisionKind: item.decisionKind,
    actionability: item.actionability,
    prioritySnapshot: item.prioritySnapshot,
    urgency: item.urgency,
    timingLabel: item.timingLabel,
    priorityScore: item.priorityScore,
    sectionKey: item.sectionKey,
    isCarryover: item.isCarryover,
    groupKey: item.groupKey,
    displayMode: item.displayMode,
    frontendActionState: item.frontendActionState,
    impactLevel: item.impactLevel,
    safePreviewTitle: item.safePreviewTitle,
    safePreviewBody: item.safePreviewBody,
    recommendedActionLabel: item.recommendedActionLabel,
    primaryActionLabel: item.primaryActionLabel,
    deadlineAt: item.deadlineAt,
    expiresAt: item.expiresAt,
    badgeContribution: item.badgeContribution,
    confidence: item.confidence,
    evidenceStrengthLabel: deriveEvidenceStrengthLabel(item.confidenceExplanation),
    conflictSummary: item.conflictSummary,
    contextVersion: item.contextVersion,
    contextObservedAt: item.contextObservedAt,
    contextFreshness: item.contextFreshness,
    mutualExclusionGroupId: item.mutualExclusionGroupId,
    supersededByDecisionId: item.supersededByDecisionId,
    requiredPermissions: item.requiredPermissions,
    approvalLevel: item.approvalLevel,
    reviewSupported: item.reviewSupported,
    editableProposalFields: item.editableProposalFields,
    reversibility: item.reversibility ?? undefined,
    execution: item.execution,
    refreshSupported: item.refreshSupported,
    recordVersion: item.recordVersion,
    decisionState: item.decisionState,
    whyNow: item.analysis?.whyNow,
    costOfDelay: item.analysis?.costOfDelay,
    primaryAction: item.recommendedAction
      ? summarizeDecisionAction(item.recommendedAction, item.actionEffectiveStatuses)
      : undefined,
    secondaryActions: item.alternativeActions?.length
      ? item.alternativeActions.map((action) => summarizeDecisionAction(action, item.actionEffectiveStatuses))
      : undefined,
  };
}
