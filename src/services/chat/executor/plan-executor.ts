// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  authorizeChatToolCall,
  buildConfirmedDestructiveTargetId,
  CONFIRMED_TARGET_FIELDS,
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
  type ChatConfirmedDestructiveTarget,
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

function normalizeConfirmationTargetId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function confirmationToolInputForStep(step: ChatPlanStep): { toolName: string; input: Record<string, unknown> } | null {
  const targetContract = findChatActionDefinition(step.skill, step.action)?.confirmationTarget;
  if (!targetContract) return null;
  if (targetContract.argumentFields) {
    return {
      toolName: targetContract.tool,
      input: Object.fromEntries(
        Object.entries(targetContract.argumentFields).map(([toolField, stepField]) => [toolField, step.args?.[stepField]]),
      ),
    };
  }
  const [toolField] = CONFIRMED_TARGET_FIELDS[targetContract.tool] ?? [];
  if (!toolField) return null;
  return {
    toolName: targetContract.tool,
    input: { [toolField]: step.args?.[targetContract.argumentField] },
  };
}

/**
 * Builds the exact grants staged by the confirmation hold. The registry owns
 * the action -> authorization-tool/argument mapping so newly reachable risky
 * actions cannot silently fall back to a turn-wide or tool-only grant.
 */
export function buildConfirmedDestructiveTargetsForPlanSteps(
  steps: ReadonlyArray<ChatPlanStep>,
): ChatConfirmedDestructiveTarget[] {
  const targets: ChatConfirmedDestructiveTarget[] = [];
  for (const step of steps) {
    if (!CONFIRMATION_GRANT_STEP_RISKS.has(step.risk)) continue;
    const definition = findChatActionDefinition(step.skill, step.action);
    const targetContract = definition?.confirmationTarget;
    if (!targetContract) continue;
    const authorizationCall = confirmationToolInputForStep(step);
    const targetId = authorizationCall
      ? buildConfirmedDestructiveTargetId(authorizationCall.toolName, authorizationCall.input)
      : normalizeConfirmationTargetId(step.args?.[targetContract.argumentField]);
    if (!targetId) continue;
    targets.push({ tool: targetContract.tool, targetId });
  }
  return targets;
}

function authorizationCallForRiskyStep(step: ChatPlanStep): {
  toolName: string;
  input: Record<string, unknown>;
} | null {
  return confirmationToolInputForStep(step);
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
  const currentAuthorization = getCurrentChatToolAuthorizationContext();
  const shouldBindAuthorization = options.authorizationContextBound !== true && (
    !currentAuthorization
    || (
      options.confirmed === true
      && currentAuthorization.userId === input.userId
      && currentAuthorization.tenantId === input.tenantId
    )
  );
  if (shouldBindAuthorization) {
    const confirmedTargets = options.confirmed === true
      ? options.confirmedTargets ?? buildConfirmedDestructiveTargetsForPlanSteps(plan.steps)
      : undefined;
    return runWithChatToolAuthorization({
      userId: input.userId,
      tenantId: input.tenantId,
      confirmedDestructiveAction: options.confirmed === true,
      // ADV-3: exact server-staged grants are authoritative. Direct/internal
      // confirmed-plan callers derive the same exact set from the registry.
      confirmedDestructiveTargets: confirmedTargets,
      confirmationSource: options.confirmationSource
        ?? (options.confirmed === true ? 'pending_confirmation' : 'none'),
      requireConfirmationForWrites: shouldRequireSafeWriteConfirmation(input),
    }, () => executeChatActionPlan(plan, input, deps, {
      ...options,
      authorizationContextBound: true,
    }));
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
        title: input.locale?.startsWith('pt')
          ? 'Confirmação necessária'
          : 'Confirmation needed',
        message: confirmationCopy(plan, input),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
      ...multiStepMetadata(plan, []),
    });
  }

  // M16 (multi-step upgrade): topological, bounded-sequential execution.
  // A failed/blocked step blocks ONLY its dependents (status 'blocked' with
  // reason 'dependency_failed'); independent branches keep executing. There
  // is deliberately NO parallelism. Steps that require user input mid-run
  // (needs_clarification / needs_confirmation) still stop the whole loop —
  // continuing past a pending user decision would be unsafe.
  //
  // M1/ADV-3 interaction: the registry-executor path dispatches steps
  // directly, so target-bound registry actions are authorized explicitly
  // below before their step executor runs. The loop also remains
  // structurally bounded to the previewed steps, each at most once;
  // continue-on-failure can never add work beyond the preview.
  const results: ChatStepExecutionResult[] = [];
  for (const step of plan.steps) {
    if (step.dependsOnStepIds?.some((dep) => {
      const depResult = results.find((result) => result.step.stepId === dep);
      return !depResult || depResult.status !== 'verified_success';
    })) {
      results.push({ step, status: 'blocked', error: 'dependency_failed' });
      continue;
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
      continue;
    }
    const runtimeStep: ChatPlanStep = { ...step, args: resolveStepRefs(step.args, results) };
    // Some safe-write definitions are dynamically elevated (for example a
    // calendar create with attendees). They keep their existing structural
    // preview bound because there is no pre-existing target id. Exact grant
    // consumption applies to registry actions that declare a target contract.
    if (findChatActionDefinition(runtimeStep.skill, runtimeStep.action)?.confirmationTarget) {
      const authorizationCall = authorizationCallForRiskyStep(runtimeStep);
      const authorization = authorizationCall
        ? authorizeChatToolCall(
          authorizationCall.toolName,
          authorizationCall.input,
          input.userId,
          input.tenantId,
        )
        : null;
      if (!authorization?.allowed) {
        persistStepStatus(plan, input, runtimeStep, 'blocked');
        results.push({
          step: runtimeStep,
          status: 'blocked',
          error: 'confirmation_target_mismatch',
        });
        continue;
      }
    }
    // Internal fail-closed observation seam used by staging safety probes.
    // It runs before dispatch-table lookup so a probe can throw without any
    // registry executor or provider dependency being touched.
    options.beforeStepExecution?.(runtimeStep);
    const result = await executeStepWithReliability(runtimeStep, {
      plan,
      input,
      deps,
      persistRuns: input.persistRuns !== false,
      confirmed: options.confirmed === true,
    });
    results.push(result);
    // Pending-user-decision statuses stop the run; anything else (failed,
    // blocked, partial_success, verified_pending) only blocks dependents.
    if (result.status === 'needs_confirmation' || result.status === 'needs_clarification') break;
  }

  requeuePartialSuccessPendingParents(input, plan, results);
  return buildExecutedChatActionResponse(input, plan, results);
}
