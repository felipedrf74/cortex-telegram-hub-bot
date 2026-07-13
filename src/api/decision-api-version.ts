// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center API version negotiation (v1 default, v2 opt-in).
 *
 * v2 ships compact DecisionCardSummary items on list/overview surfaces (full item only on
 * detail), behind the DECISION_API_V2_ENABLED flag + an x-nexus-api-version: v2 request
 * header. v1 clients (no header / flag off) keep the existing full-item shape unchanged.
 */

import type { AuthenticatedRequest } from './auth-middleware';
import type { ConfidenceExplanation, DecisionActionEffectiveStatus, DecisionApiItem, DecisionCardSummary, EvidenceStrengthLabel } from '../services/decision-center';
import { isDecisionApiV2Enabled } from '../services/runtime-flags';

/**
 * Pure, total derivation of the compact card evidence-strength label from the always-safe confidence
 * label + source freshness. Stale/unknown freshness dominates (stale evidence is weak regardless of
 * confidence). Never reads the privacy-gated basis/uncertainty. Returns undefined when there is no
 * confidence explanation, so the optional card field is omitted (byte-stable).
 */
export function deriveEvidenceStrengthLabel(
  confidence?: Pick<ConfidenceExplanation, 'label' | 'sourceFreshness'>,
): EvidenceStrengthLabel | undefined {
  if (!confidence) return undefined;
  if (confidence.sourceFreshness === 'stale') return 'stale';
  if (confidence.sourceFreshness === 'unknown') return 'unverified';
  return confidence.label === 'high' ? 'strong' : confidence.label === 'medium' ? 'moderate' : 'weak';
}

export type DecisionApiVersion = 'v1' | 'v2';

export interface ResolvedDecisionApiVersion {
  version: DecisionApiVersion;
  schemaVersion: 'decision-center.v1' | 'decision-center.v2';
}

export const DECISION_API_VERSION_HEADER = 'x-nexus-api-version';

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

function requestedVersionHeader(req: AuthenticatedRequest): string {
  const raw = (req.headers?.[DECISION_API_VERSION_HEADER] ?? '') as string | string[];
  const value = Array.isArray(raw) ? raw[0] ?? '' : raw;
  return value.trim().toLowerCase();
}

/** v2 only when the client asks for it AND the flag is opt-in for this user/tenant. */
export function resolveDecisionApiVersion(req: AuthenticatedRequest): ResolvedDecisionApiVersion {
  const wantsV2 = requestedVersionHeader(req) === 'v2';
  const tenantId = typeof req.tenantId === 'number'
    && Number.isSafeInteger(req.tenantId) && req.tenantId > 0
    ? req.tenantId
    : undefined;
  const enabled = isDecisionApiV2Enabled(process.env, {
    userId: req.userId,
    ...(tenantId ? { tenantId } : {}),
  });
  const version: DecisionApiVersion = wantsV2 && enabled ? 'v2' : 'v1';
  return { version, schemaVersion: version === 'v2' ? 'decision-center.v2' : 'decision-center.v1' };
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

/** Project a full DecisionApiItem down to the compact v2 card (no recomputation). */
export function buildDecisionCardSummary(item: DecisionApiItem): DecisionCardSummary & DecisionCardSummaryV2Extras {
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
