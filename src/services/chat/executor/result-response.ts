// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionPlan,
  ChatActionRouteResponse,
  ChatPlannerInput,
  ChatStepExecutionResult,
} from '../types';
import {
  actionButtonsForResults,
  calendarCardEvents,
  firstTitle,
  openSurfacePayloadForStep,
  resultCardPayload,
  sanitizeActionResults,
} from './response-cards';
import {
  buildActionResponse,
  multiStepMetadata,
  multiStepType,
} from './response-builder';
import {
  confirmationCopy,
  failureCopy,
  multiStepOutcomeCopy,
  overflowDisclosureCopy,
  partialCopy,
  successCopy,
  verifiedPendingCopy,
} from './response-copy';
import {
  confirmationVariant,
  intentClassForPlan,
} from '../planner/plan-utils';
import { persistPlanStatus } from './run-persistence';
import { clarificationReasonForPlan } from '../planner/plan-builder';
import { buildTargetedClarificationQuestion } from '../planner/clarification';

export function buildExecutedChatActionResponse(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  results: ChatStepExecutionResult[],
): ChatActionRouteResponse {
  const needsConfirmation = results.find((result) => result.status === 'needs_confirmation');
  if (needsConfirmation) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: multiStepType(plan, 'chat_action_needs_confirmation'),
      actionStatus: 'needs_confirmation',
      actionConfirmation: {
        title: input.locale?.startsWith('pt')
          ? 'Confirmação necessária'
          : input.locale?.startsWith('es')
            ? 'Confirmación necesaria'
            : 'Confirmation needed',
        message: failureCopy(input, needsConfirmation.error),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const needsClarification = results.find((result) => result.status === 'needs_clarification');
  if (needsClarification) {
    const question = plan.clarificationQuestion || buildTargetedClarificationQuestion(input, plan.steps);
    return buildActionResponse(input, plan, 'needs_clarification', question, {
      type: multiStepType(plan, 'chat_action_needs_input'),
      actionStatus: 'needs_clarification',
      clarification: { question, reason: clarificationReasonForPlan(plan) },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const failed = results.find((result) => result.status === 'failed' || result.status === 'blocked');
  const partial = results.some((result) => result.status !== 'verified_success');
  // M16 honest partial composition: when a multi-step run has BOTH completed
  // and failed/blocked branches, enumerate done/failed/blocked with
  // per-branch reasons instead of collapsing to the first failure. The
  // answer never claims success for a failed or blocked step.
  const succeededCount = results.filter((result) => result.status === 'verified_success').length;
  if (failed && plan.steps.length > 1 && succeededCount > 0) {
    return buildActionResponse(input, plan, 'partial_success', multiStepOutcomeCopy(input, plan, results), {
      type: multiStepType(plan, 'chat_action_partial_success'),
      actionStatus: 'partial_success',
      // M16/M8 seam fix: stamp the contract verification vocabulary so the
      // pipeline mapping layer (verificationForReasoningMetadata) and this
      // envelope agree — the quality gate exempts honest partial reports on
      // verificationStatus 'partial_failure'.
      verificationStatus: 'partial_failure',
      error: { message: failureCopy(input, failed.error), retryable: results.some((result) => result.status === 'failed') },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  if (failed) {
    return buildActionResponse(input, plan, failed.status, failureCopy(input, failed.error), {
      type: multiStepType(plan, failed.status === 'blocked' ? 'chat_action_blocked' : 'chat_action_failed'),
      actionStatus: failed.status,
      error: { message: failureCopy(input, failed.error), retryable: failed.status !== 'blocked' },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const verifiedPending = results.find((result) => result.status === 'verified_pending');
  if (verifiedPending) {
    return buildActionResponse(input, plan, 'verified_pending', verifiedPendingCopy(input, verifiedPending), {
      type: multiStepType(plan, 'chat_action_verified_pending'),
      actionStatus: 'verified_pending',
      verificationStatus: 'verified_pending',
      openSurface: openSurfacePayloadForStep(verifiedPending.step, verifiedPending.result, input),
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  if (partial) {
    return buildActionResponse(input, plan, 'partial_success', partialCopy(input), {
      type: multiStepType(plan, 'chat_action_partial_success'),
      actionStatus: 'partial_success',
      // See the partial branch above — keep both mapping layers agreeing.
      verificationStatus: 'partial_failure',
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  // M16: keep the overflow disclosure on the executed answer too — the
  // segments beyond the splitter cap were not run and must never be
  // silently absorbed into a success claim.
  const overflowLine = overflowDisclosureCopy(plan, input);
  const successText = overflowLine
    ? `${successCopy(input, results)}\n\n${overflowLine}`
    : successCopy(input, results);
  return buildActionResponse(input, plan, 'verified_success', successText, {
    type: multiStepType(plan, 'chat_action_verified_success'),
    actionStatus: 'verified_success',
    verificationStatus: 'verified_success',
    title: firstTitle(results),
    calendar: calendarCardEvents(results),
    ...resultCardPayload(results),
    actions: actionButtonsForResults(results),
    actionResults: sanitizeActionResults(results),
    ...multiStepMetadata(plan, results),
  });
}
