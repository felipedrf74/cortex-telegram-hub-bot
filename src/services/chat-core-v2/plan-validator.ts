// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2ActivationConfig } from './activation-flags';
import type { ChatTurnPlanMicro } from './plan-schema';

export type PlanValidationIssue =
  | 'unknown_capability'
  | 'write_not_allowed_in_current_phase'
  | 'cloud_fallback_not_allowed'
  | 'missing_grounding'
  | 'stale_context'
  | 'ambiguous_reference'
  | 'budget_exceeded';

export interface PlanValidationContext {
  contextHash: string;
  allowedCapabilityIds: string[];
  availableEvidenceIds: string[];
  activation: Pick<
    ChatCoreV2ActivationConfig,
    'allowWritePreviews' | 'allowCloudFallback' | 'forceEvidenceForFactualClaims'
  >;
  promptTokenCount?: number;
  promptHardCapTokens?: number;
}

export interface PlanValidationResult {
  ok: boolean;
  issues: PlanValidationIssue[];
  allowedCapabilityIds: string[];
  requiredClarificationReason?: PlanValidationIssue;
}

export function validateChatTurnPlanMicroAgainstContext(
  plan: ChatTurnPlanMicro,
  context: PlanValidationContext,
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const allowed = new Set(context.allowedCapabilityIds);
  const evidence = new Set(context.availableEvidenceIds);

  for (const capabilityId of plan.capabilityIds) {
    if (!allowed.has(capabilityId)) issues.push('unknown_capability');
  }
  for (const request of plan.requiredReads) {
    if (!allowed.has(request.capabilityId)) issues.push('unknown_capability');
  }
  for (const request of plan.proposedWrites) {
    if (!allowed.has(request.capabilityId)) issues.push('unknown_capability');
  }
  if (plan.proposedWrites.length > 0 && !context.activation.allowWritePreviews) {
    issues.push('write_not_allowed_in_current_phase');
  }
  if (plan.escalationReasons.includes('cloud_allowlist_candidate') && !context.activation.allowCloudFallback) {
    issues.push('cloud_fallback_not_allowed');
  }
  if (context.activation.forceEvidenceForFactualClaims) {
    for (const evidenceClaimId of plan.evidenceClaimIds) {
      if (!evidence.has(evidenceClaimId)) issues.push('missing_grounding');
    }
  }
  if (plan.contextHash !== context.contextHash) {
    issues.push('stale_context');
  }
  if (plan.escalationReasons.includes('ambiguous_reference') && plan.intent !== 'clarify') {
    issues.push('ambiguous_reference');
  }
  if (
    context.promptTokenCount !== undefined
    && context.promptHardCapTokens !== undefined
    && context.promptTokenCount > context.promptHardCapTokens
  ) {
    issues.push('budget_exceeded');
  }

  const uniqueIssues = [...new Set(issues)];
  return {
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    allowedCapabilityIds: plan.capabilityIds.filter((capabilityId) => allowed.has(capabilityId)),
    requiredClarificationReason: uniqueIssues.find(isClarificationIssue),
  };
}

function isClarificationIssue(issue: PlanValidationIssue): boolean {
  return issue === 'ambiguous_reference' || issue === 'stale_context' || issue === 'budget_exceeded';
}
