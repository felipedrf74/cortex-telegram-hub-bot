// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../../chat-tool-authorization';
import { resolveStepRefs } from '../../chat-multi-step-dag';
import { findChatActionDefinition } from '../registry';
import type {
  ChatActionExecutionOptions,
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from '../types';
import {
  openSurfacePayloadForStep,
} from './response-cards';
import {
  buildActionResponse,
  multiStepMetadata,
  multiStepType,
} from './response-builder';
import {
  confirmationCopy,
  refusalCopyForReason,
  refusalReasonForPlan,
} from './response-copy';
import {
  confirmationVariant,
  intentClassForPlan,
  shouldRequireSafeWriteConfirmation,
} from '../planner/plan-utils';
import {
  persistPlanStatus,
  persistStepStatus,
  requeuePartialSuccessPendingParents,
} from './run-persistence';
import {
  clarificationReasonForPlan,
} from '../planner/plan-builder';
import {
  defaultClarification,
} from '../planner/clarification';
import { executeStepWithReliability } from './reliability';
import { buildExecutedChatActionResponse } from './result-response';

const CONFIRMATION_GRANT_STEP_RISKS = new Set([
  'destructive',
  'financial',
  'admin_security',
  'external_side_effect',
]);

function confirmedDestructiveTargetsForPlan(plan: ChatActionPlan) {
  return plan.steps
    .filter((step) => CONFIRMATION_GRANT_STEP_RISKS.has(step.risk))
    .map((step) => {
      const args = step.args as Record<string, unknown> | undefined;
      const targetId = typeof args?.eventId === 'string' && args.eventId.trim()
        ? args.eventId.trim()
        : typeof args?.taskId === 'string' && args.taskId.trim()
          ? args.taskId.trim()
          : undefined;
      return targetId ? { targetId } : {};
    });
}

export async function executeChatActionPlan(
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  deps: Required<ChatActionPlannerDeps>,
  options: ChatActionExecutionOptions = {},
): Promise<ChatActionRouteResponse> {
  // Phase 16 batch 80 (2026-05-16): wrap execution in
  // runWithChatToolAuthorization. Before this fix the action planner reached
  // destructive providers (createEvent, updateEvent, deleteEvent, mail send)
  // without the tool-authorization gate at chat-tool-authorization.ts:156-164;
  // the gate was only wired into the legacy tool-call surface at
  // chat-message-routes.ts:1160. Re-entrant calls already inside an auth
  // context fall through (AsyncLocalStorage scope continues unchanged).
  if (!getCurrentChatToolAuthorizationContext()) {
    return runWithChatToolAuthorization({
      userId: input.userId,
      tenantId: input.tenantId,
      confirmedDestructiveAction: options.confirmed === true,
      // ADV-3: a confirmed plan authorizes at most one destructive/external
      // call per previewed risky step — never a turn-wide blank check.
      confirmedDestructiveTargets: options.confirmed === true
        ? confirmedDestructiveTargetsForPlan(plan)
        : undefined,
      confirmationSource: options.confirmationSource
        ?? (options.confirmed === true ? 'pending_confirmation' : 'none'),
      requireConfirmationForWrites: shouldRequireSafeWriteConfirmation(input),
    }, () => executeChatActionPlan(plan, input, deps, options));
  }
  const hasUnresolvedStep = plan.clarificationQuestion || plan.steps.some((step) => !step.requiredArgsPresent);
  if (hasUnresolvedStep) {
    // Phase 16 batch 80 (2026-05-16): refusal-vs-clarification distinction.
    // Refused plans (built by buildSafetyRefusalPlan with rejectionReason
    // populated) now take a distinct branch with metadata.actionStatus
    // 'refused' and metadata.type 'chat_action_refused'.
    const refusalReason = refusalReasonForPlan(plan);
    if (refusalReason) {
      persistPlanStatus(plan, input, 'blocked');
      const refusalMessage = refusalCopyForReason(refusalReason, input);
      return buildActionResponse(input, plan, 'blocked', refusalMessage, {
        type: 'chat_action_refused',
        actionStatus: 'refused',
        refusal: { reason: refusalReason, message: refusalMessage },
      });
    }
    persistPlanStatus(plan, input, 'needs_clarification');
    const question = plan.clarificationQuestion || defaultClarification(input);
    const clarificationReason = clarificationReasonForPlan(plan);
    return buildActionResponse(input, plan, 'needs_clarification', question, {
      type: multiStepType(plan, 'chat_action_needs_input'),
      actionStatus: 'needs_clarification',
      intentClass: plan.intentClass ?? (clarificationReason === 'ambiguous_intent' ? 'clarifying_question' : undefined),
      clarification: { question, reason: clarificationReason },
      openSurface: openSurfacePayloadForStep(plan.steps[0], null, input),
      ...multiStepMetadata(plan, []),
    });
  }

  if (plan.requiresConfirmation && options.confirmed !== true) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: multiStepType(plan, 'chat_action_needs_confirmation'),
      actionStatus: 'needs_confirmation',
      actionConfirmation: {
        title: input.locale?.startsWith('pt') ? 'Confirmação necessária' : 'Confirmation needed',
        message: confirmationCopy(plan, input),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
      ...multiStepMetadata(plan, []),
    });
  }

  const results: ChatStepExecutionResult[] = [];
  for (const step of plan.steps) {
    if (step.dependsOnStepIds?.some((dep) => {
      const depResult = results.find((result) => result.step.stepId === dep);
      return !depResult || depResult.status !== 'verified_success';
    })) {
      results.push({ step, status: 'blocked', error: 'dependency_failed' });
      break;
    }
    if (step.type === 'answer') {
      results.push({ step, status: 'verified_success', result: { text: String((step.args as any).text || '') } });
      continue;
    }
    if (!step.requiredArgsPresent) {
      persistStepStatus(plan, input, step, 'needs_clarification');
      results.push({ step, status: 'needs_clarification', error: 'missing_required_fields' });
      break;
    }
    // Phase 16 batch 82 (2026-05-17): executionPolicy enforcement. Before
    // this the `executionPolicy` field on ChatActionDefinition was declared
    // but never read at runtime — an action marked `'blocked'` (the
    // registry default for `risk: 'ambiguous'`) would reach the action
    // dispatch unchallenged. Now we short-circuit before per-action
    // executors when policy says blocked.
    const stepDefinition = findChatActionDefinition(step.skill, step.action);
    if (stepDefinition?.executionPolicy === 'blocked') {
      results.push({
        step,
        status: 'blocked',
        error: step.action === 'content_publish_now'
          ? 'content_publication_execution_not_supported'
          : 'execution_policy_blocked',
      });
      break;
    }
    const runtimeStep: ChatPlanStep = { ...step, args: resolveStepRefs(step.args, results) };
    const result = await executeStepWithReliability(runtimeStep, {
      plan,
      input,
      deps,
      persistRuns: input.persistRuns !== false,
      confirmed: options.confirmed === true,
    });
    results.push(result);
    if (result.status !== 'verified_success') break;
  }

  requeuePartialSuccessPendingParents(input, plan, results);
  return buildExecutedChatActionResponse(input, plan, results);
}
