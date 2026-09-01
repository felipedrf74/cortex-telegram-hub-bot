// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Mechanical capability registry for actions Decision Center may advertise.
 * The runtime handler remains selected by the command service; this registry
 * is deliberately data-only so reads, OpenAPI checks, and tests can prove
 * capability truth without importing domain writers.
 */

export type DecisionExecutionKind = 'read' | 'mutation' | 'navigation';

export interface DecisionExecutorDescriptor {
  actionId: string;
  executorKey: string;
  executionKind: DecisionExecutionKind;
  readBackKey: string | null;
}

const EXECUTORS = [
  { actionId: 'open_detail', executorKey: 'decision.open_detail', executionKind: 'read', readBackKey: null },
  { actionId: 'dismiss', executorKey: 'decision.dismiss', executionKind: 'mutation', readBackKey: 'decision.status' },
  { actionId: 'reject_reflow', executorKey: 'decision.dismiss', executionKind: 'mutation', readBackKey: 'decision.status' },
  { actionId: 'not_now', executorKey: 'decision.dismiss', executionKind: 'mutation', readBackKey: 'decision.status' },
  { actionId: 'snooze', executorKey: 'decision.snooze', executionKind: 'mutation', readBackKey: 'decision.snoozed_until' },
  { actionId: 'approve_script', executorKey: 'content.approve_script', executionKind: 'mutation', readBackKey: 'content.approval' },
  { actionId: 'request_rewrite', executorKey: 'content.request_rewrite', executionKind: 'mutation', readBackKey: 'content.approval' },
  { actionId: 'accept_reflow', executorKey: 'secretary.accept_reflow', executionKind: 'mutation', readBackKey: 'secretary.agenda' },
  { actionId: 'choose_another_time', executorKey: 'secretary.choose_time', executionKind: 'mutation', readBackKey: 'secretary.agenda' },
  { actionId: 'undo_reflow', executorKey: 'secretary.undo_reflow', executionKind: 'mutation', readBackKey: 'secretary.agenda' },
  { actionId: 'mark_paid', executorKey: 'finance.mark_paid', executionKind: 'mutation', readBackKey: 'finance.tax_event' },
  { actionId: 'add_meal', executorKey: 'cooking.add_meal', executionKind: 'mutation', readBackKey: 'cooking.meal_plan' },
  { actionId: 'activate_training_plan_revision', executorKey: 'training.activate_revision', executionKind: 'mutation', readBackKey: 'training.active_revision' },
  { actionId: 'activate_training_coach_v2_proposal', executorKey: 'training.activate_coach_v2_proposal', executionKind: 'mutation', readBackKey: 'training.coach_v2_proposal' },
  { actionId: 'approve_product_learning_case', executorKey: 'training.approve_learning_case', executionKind: 'mutation', readBackKey: 'training.learning_approval' },
  { actionId: 'option_a', executorKey: 'chat.choose_option', executionKind: 'mutation', readBackKey: 'chat.pending_confirmation' },
  { actionId: 'option_b', executorKey: 'chat.choose_option', executionKind: 'mutation', readBackKey: 'chat.pending_confirmation' },
  { actionId: 'accept_chat_action_fix', executorKey: 'chat.accept_action_fix', executionKind: 'mutation', readBackKey: 'decision.status' },
  { actionId: 'reconnect', executorKey: 'navigation.open_connections', executionKind: 'navigation', readBackKey: null },
] as const satisfies readonly DecisionExecutorDescriptor[];

const BY_ACTION = new Map<string, DecisionExecutorDescriptor>(
  EXECUTORS.map((descriptor) => [descriptor.actionId, descriptor]),
);

export function findDecisionExecutor(actionId: string): DecisionExecutorDescriptor | null {
  return BY_ACTION.get(actionId) ?? null;
}

export function hasDecisionExecutor(actionId: string): boolean {
  return BY_ACTION.has(actionId);
}

export function listDecisionExecutors(): readonly DecisionExecutorDescriptor[] {
  return EXECUTORS;
}
