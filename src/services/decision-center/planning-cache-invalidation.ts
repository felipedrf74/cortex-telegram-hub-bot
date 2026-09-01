// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidatePlanningCaches } from '../cache-coherence-registry';

/**
 * Only verified writes to sources consumed by weekly/daily planning retire the
 * authenticated user's plan projections. Re-running the invalidation for a
 * durable verified replay is intentional: it closes the crash window between
 * committing the successful execution ledger and retiring cached projections.
 * Decision lifecycle-only mutations, navigation, failed attempts, and
 * unverified outcomes do not invalidate.
 */
const PLANNING_SOURCE_MUTATION_ACTIONS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'undo_reflow',
  'mark_paid',
  'add_meal',
  'activate_training_plan_revision',
  'activate_training_coach_v2_proposal',
]);

export interface DecisionPlanningInvalidationInput {
  actionId: string;
  userId: number;
  status: 'succeeded' | 'failed' | 'blocked' | 'idempotent' | 'reconciled';
  readBackOk: boolean;
  idempotent: boolean;
}

export function invalidatePlanningAfterVerifiedDecisionSourceMutation(
  input: DecisionPlanningInvalidationInput,
): boolean {
  const durableVerifiedSuccess = (input.status === 'succeeded' && !input.idempotent)
    || (input.status === 'idempotent' && input.idempotent)
    || (input.status === 'reconciled' && input.idempotent);
  if (
    !durableVerifiedSuccess
    || !input.readBackOk
    || !PLANNING_SOURCE_MUTATION_ACTIONS.has(input.actionId)
  ) return false;
  invalidatePlanningCaches(input.userId);
  return true;
}

export function isPlanningSourceMutationAction(actionId: string): boolean {
  return PLANNING_SOURCE_MUTATION_ACTIONS.has(actionId);
}
