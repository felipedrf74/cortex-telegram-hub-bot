// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ActionRisk, ChatCoreV2Domain } from './types';

export type ChatCoreV2WriteRiskClass = 'A' | 'B' | 'C';

export type ChatCoreV2WriteEscalationReason =
  | 'multi_step_write'
  | 'financial_mutation'
  | 'training_plan_over_7_days'
  | 'external_send'
  | 'cross_domain_write'
  | 'ambiguous_reference'
  | 'low_confidence'
  | 'medical_legal_claim';

export interface ChatCoreV2WriteRiskPolicy {
  riskClass: ChatCoreV2WriteRiskClass;
  requires3BCritic: boolean;
  /** Legacy contract name; now means approved strong reasoning or background review. */
  requires35BOrBackground: boolean;
  requiresConfirmation: boolean;
  requiresReadbackVerification: boolean;
}

export const WRITE_RISK_POLICIES: Record<ChatCoreV2WriteRiskClass, ChatCoreV2WriteRiskPolicy> = {
  A: {
    riskClass: 'A',
    requires3BCritic: false,
    requires35BOrBackground: false,
    requiresConfirmation: true,
    requiresReadbackVerification: true,
  },
  B: {
    riskClass: 'B',
    requires3BCritic: true,
    requires35BOrBackground: false,
    requiresConfirmation: true,
    requiresReadbackVerification: true,
  },
  C: {
    riskClass: 'C',
    requires3BCritic: true,
    requires35BOrBackground: true,
    requiresConfirmation: true,
    requiresReadbackVerification: true,
  },
};

export function getWriteRiskPolicy(riskClass: ChatCoreV2WriteRiskClass): ChatCoreV2WriteRiskPolicy {
  return WRITE_RISK_POLICIES[riskClass];
}

/** Legacy exported name retained for stored/internal contract compatibility. */
export function requires35BOrBackgroundEscalation(input: {
  riskClass: ChatCoreV2WriteRiskClass;
  escalationReasons?: ChatCoreV2WriteEscalationReason[];
}): boolean {
  return input.riskClass === 'C' || (input.escalationReasons ?? []).length > 0;
}

/**
 * Pure write-risk classifier (WP-10). Maps a (commandType, domain, capability
 * risk) tuple onto the A/B/C governance class WITHOUT any side effects, DB reads,
 * or env access — so it is safe to call from the firewall hot path and from the
 * background lifecycle.
 *
 * Class ladder (highest wins):
 *  - C  (block + 3B critic + strong cloud/background + human review):
 *        any `finance` write, any `training` plan write, OR a `restricted`
 *        capability risk. These never auto-execute and never receive an execute
 *        envelope from the action gateway.
 *  - B  (3B critic required, still confirmable): a `high` capability risk.
 *  - A  (baseline confirmed write): everything else (the four currently-executable
 *        sync commands all land here).
 *
 * `capability` is the capability's declared `ActionRisk` ('low' | 'medium' |
 * 'high' | 'restricted'); callers that do not have a registry risk pass 'low'.
 */
export function classifyCommandWriteRisk(
  commandType: string,
  domain: ChatCoreV2Domain | string,
  capability: ActionRisk,
): ChatCoreV2WriteRiskClass {
  // Class C: restricted capability risk always blocks, regardless of domain.
  if (capability === 'restricted') return 'C';
  // Class C: every finance write is restricted-by-domain.
  if (domain === 'finance') return 'C';
  // Class C: a training PLAN write (whole-plan rewrite / generation) is
  // human-review territory. A non-plan training write (e.g. a single
  // session modify) is not auto-promoted to C by domain alone.
  if (domain === 'training' && isPlanWriteCommandType(commandType)) return 'C';
  // Class B: a declared high-risk capability needs the 3B critic.
  if (capability === 'high') return 'B';
  // Class A: baseline confirmed write.
  return 'A';
}

/**
 * Whether a (training) command type is a PLAN write — i.e. it creates, rewrites,
 * regenerates, or otherwise mutates a multi-day training plan (not a single
 * session). Substring match on the command type so a future
 * `training.plan_rewrite` / `training.generate_plan` / `training.periodize_plan`
 * all map to Class C without enumerating each one.
 */
function isPlanWriteCommandType(commandType: string): boolean {
  const folded = commandType.toLowerCase();
  return folded.includes('plan');
}

/**
 * Pure escalation-reason classifier (WP-10). Returns the ordered, de-duplicated
 * list of escalation reasons implied by the (commandType, domain, capability)
 * tuple. Used both for telemetry and to decide whether
 * `requires35BOrBackgroundEscalation` fires. The name is a legacy contract;
 * no large local model is selected. Side-effect free.
 */
export function classifyCommandEscalationReasons(
  commandType: string,
  domain: ChatCoreV2Domain | string,
  capability: ActionRisk,
): ChatCoreV2WriteEscalationReason[] {
  const reasons: ChatCoreV2WriteEscalationReason[] = [];
  if (domain === 'finance') reasons.push('financial_mutation');
  if (domain === 'training' && isPlanWriteCommandType(commandType)) {
    reasons.push('training_plan_over_7_days');
  }
  return [...new Set(reasons)];
}

/**
 * Convenience: resolve the full governance policy for a command in one call.
 * Combines the A/B/C class, its base policy, the escalation reasons, and the
 * strong-reasoning/background escalation decision. Pure.
 */
export interface ChatCoreV2CommandWriteRiskAssessment {
  riskClass: ChatCoreV2WriteRiskClass;
  policy: ChatCoreV2WriteRiskPolicy;
  escalationReasons: ChatCoreV2WriteEscalationReason[];
  requires35BOrBackground: boolean;
}

export function assessCommandWriteRisk(input: {
  commandType: string;
  domain: ChatCoreV2Domain | string;
  capability: ActionRisk;
}): ChatCoreV2CommandWriteRiskAssessment {
  const riskClass = classifyCommandWriteRisk(input.commandType, input.domain, input.capability);
  const escalationReasons = classifyCommandEscalationReasons(input.commandType, input.domain, input.capability);
  return {
    riskClass,
    policy: WRITE_RISK_POLICIES[riskClass],
    escalationReasons,
    requires35BOrBackground: requires35BOrBackgroundEscalation({ riskClass, escalationReasons }),
  };
}
