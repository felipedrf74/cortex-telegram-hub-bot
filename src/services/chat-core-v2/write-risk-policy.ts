// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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

export function requires35BOrBackgroundEscalation(input: {
  riskClass: ChatCoreV2WriteRiskClass;
  escalationReasons?: ChatCoreV2WriteEscalationReason[];
}): boolean {
  return input.riskClass === 'C' || (input.escalationReasons ?? []).length > 0;
}
