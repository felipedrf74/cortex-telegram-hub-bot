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
        title: input.locale?.startsWith('pt') ? 'Confirmação necessária' : 'Confirmation needed',
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
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  return buildActionResponse(input, plan, 'verified_success', successCopy(input, results), {
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
