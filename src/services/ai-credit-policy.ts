// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operation pricing for the hybrid AI credit ledger, per the owner-approved
 * plan (docs/release/hybrid-ai-commerce-production-plan.md §2). These values
 * are server-owned policy: clients never submit credit amounts.
 */

export type AiCreditOperationClass =
  | 'standard'
  | 'deep'
  | 'standard_script'
  | 'scheduled_script'
  | 'priority_script';

export const AI_CREDIT_OPERATION_COSTS: Readonly<Record<AiCreditOperationClass, number>> = Object.freeze({
  standard: 1,
  deep: 3,
  standard_script: 10,
  scheduled_script: 10,
  priority_script: 12,
});

/** Promotional lots expire after a configured 30, 60, or maximum 90 days. */
export const PROMOTIONAL_EXPIRY_ALLOWED_DAYS: readonly number[] = Object.freeze([30, 60, 90]);

export function getAiCreditOperationCost(operationClass: AiCreditOperationClass): number {
  return AI_CREDIT_OPERATION_COSTS[operationClass];
}

export function isAllowedPromotionalExpiryDays(days: number): boolean {
  return PROMOTIONAL_EXPIRY_ALLOWED_DAYS.includes(days);
}
