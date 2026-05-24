// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { dismissDecision, getDecisionItem, performDecisionAction, snoozeDecision } from '../../decision-center';
import { claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun, withProviderWriteTimeout } from '../../chat/executor/helpers';

export async function executeDecisionCenterStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const decisionId = typeof args.decisionId === 'string' ? args.decisionId.trim() : '';
  if (!decisionId) return { step, status: 'blocked', error: 'decision_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    let result: unknown;
    if (step.action === 'decision_dismiss') {
      result = dismissDecision(decisionId, input.userId, input.tenantId);
    } else if (step.action === 'decision_snooze') {
      const minutes = typeof args.minutes === 'number' ? args.minutes : 60;
      result = snoozeDecision(decisionId, input.userId, input.tenantId, minutes);
    } else if (step.action === 'decision_choose') {
      const choice = typeof args.choice === 'string' ? args.choice : typeof args.actionId === 'string' ? args.actionId : '';
      if (!choice) return { step, status: 'blocked', error: 'decision_choice_required' };
      result = await withProviderWriteTimeout(() => performDecisionAction(decisionId, choice, input.userId, input.tenantId, {
        idempotencyKey: step.idempotencyKey,
        payload: typeof args.payload === 'object' && args.payload ? args.payload as Record<string, unknown> : {},
      }));
    } else {
      result = getDecisionItem(decisionId, input.userId, input.tenantId);
    }
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = Boolean(readBack);
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const payload = { result, item: readBack, verified };
    if (!updateClaimedActionRun(claim, status, { result: payload, providerObjectId: decisionId, verification: { verified } })) {
      return reconciliationPendingResult(step, status);
    }
    return { step, status, result: payload, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'decision_action_failed' };
  }
}
