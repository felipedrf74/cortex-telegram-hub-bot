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

/**
 * Explicit policy status for the `deep` class (NH-0040): the plan prices
 * deep reasoning/research at 3 credits, but no standalone deep-reasoning
 * user surface exists in the runtime yet — the cloud-allowlist chat fallback
 * is a degraded answer path, not deep reasoning, and content research runs
 * inside script-class jobs. The class is RESERVED, not retired: pricing is
 * live policy the moment the surface ships, and an enforcement test pins
 * that no runtime workload admits `deep` until that deliberate change.
 */
export const DEEP_OPERATION_CLASS_STATUS = 'reserved_pending_deep_surface' as const;

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

/**
 * Plan §2 availability: deep reasoning and scripts are "Unavailable" on Free
 * (and the free-equivalent beta plan). Enforced at reservation so no caller
 * can admit an unavailable class regardless of balance.
 */
const RESTRICTED_PLAN_OPERATION_CLASSES: ReadonlySet<AiCreditOperationClass> = new Set(['standard']);

export function isOperationClassAvailableForPlan(
  plan: string,
  operationClass: AiCreditOperationClass,
): boolean {
  if (plan === 'free' || plan === 'beta') {
    return RESTRICTED_PLAN_OPERATION_CLASSES.has(operationClass);
  }
  return true;
}
