// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  findChatActionDefinition,
  type ChatActionDefinition,
} from './registry';
import type {
  CalendarProviderDeps,
  ChatActionExecutionOptions,
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from './types';
import {
  buildNormalizedActionHash,
  claimChatActionRunForExecution,
  listPendingChatActionRuns,
  type ChatActionRunStatus,
} from '../chat-action-run-store';
import {
  rememberRecentChatEntity,
} from '../chat-action-state';
import {
  buildLlmPlannerPrompt,
  buildTier1ClassifierPrompt,
  parseLlmPlannerJson,
  parseTier1ClassifierJson,
} from './planner/tiers';
import { sanitizePlannerArgs } from './planner/arg-sanitizer';
import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../chat-tool-authorization';
import { extractTopic, inferContentPlatform, inferProviderName } from '../skills/text-extractors';
import { invalidateCalendarCaches } from '../cache-coherence-registry';
import { resolveTaskCreationList } from '../task-store/task-list-resolution';
import {
  buildContentAgencyPackage,
  getContentAgencyProject,
  handoffContentAgencyPackageToPipeline,
  persistContentAgencyArtifact,
} from '../content-agency';
import { addTopic, getTopicById } from '../content-scheduler';
import { generateShoppingList, getMealPlan, getShoppingList, setMealPlan } from '../cooking-chef';
import {
  getMonthlySummary,
  getPreferredCurrencyForUser,
  getTaxEvents,
  markTaxPaid,
  updateTransactionCategory,
} from '../finance-tracker';
import { getIntegrationSummary } from '../integration-status';
import { getActivePlanSummary, getPlanById, getSessionById } from '../training-plans';
import {
  confirmTrainingSessionReflow,
  previewTrainingSessionReflow,
} from '../../api/routes/training-plan-calendar-sync';
import { getUnreadMailSummaryForUser } from '../unified-mail-pressure';
import { searchEmailsForUser as searchGmailEmailsForUser } from '../google-gmail';
import { searchEmailsForUser as searchOutlookEmailsForUser } from '../outlook-mail';
import {
  createNotificationIntent,
  getOrCreateNotificationProfile,
  updateNotificationProfile,
} from '../notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
  performDecisionAction,
  snoozeDecision,
} from '../decision-center';
import { logger } from '../../utils/logger';
import {
  getChatHybridPlannerMode,
} from '../runtime-flags';
import { resolveStepRefs } from '../chat-multi-step-dag';
import {
  openSurfacePayloadForStep,
} from './executor/response-cards';
import {
  buildActionResponse,
  multiStepMetadata,
  multiStepType,
} from './executor/response-builder';
import {
  confirmationCopy,
  refusalCopyForReason,
  refusalReasonForPlan,
} from './executor/response-copy';
import {
  confirmationVariant,
  intentClassForPlan,
  normalizeProvider,
} from './planner/plan-utils';
import {
  persistPlanStatus,
  persistStepStatus,
  requeuePartialSuccessPendingParents,
  rowToConfirmedStep,
} from './executor/run-persistence';
import {
  clarificationReasonForPlan,
} from './planner/plan-builder';
import {
  defaultClarification,
} from './planner/clarification';
import {
  recordShadowTelemetry,
} from './executor/telemetry';
import { executeStepWithReliability } from './executor/reliability';
import { buildExecutedChatActionResponse } from './executor/result-response';
import { buildChatActionPlan } from './planner/orchestrator';
import { resolveChatActionPlannerDeps } from './deps';

export { buildLlmPlannerPrompt, buildTier1ClassifierPrompt, parseLlmPlannerJson, parseTier1ClassifierJson } from './planner/tiers';
export { BROAD_SKILL_MIN_PRIORITY_GAP, BROAD_SKILL_SLOT_COMPLETENESS_BONUS } from './planner/broad-skill-intents';
export { shouldRunActionPlannerBeforeReadOnlyFastPaths } from './planner/preflight-gates';
export { buildDeterministicChatActionPlan } from './planner/deterministic';
export { buildChatActionPlan } from './planner/orchestrator';
export { resolveChatActionPlannerDeps } from './deps';

export type {
  CalendarProviderDeps,
  ChatActionExecutionOptions,
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
  ChatPlanStepType,
  ChatStepExecutionResult,
} from './types';

export async function tryHandleChatActionPlan(
  input: ChatPlannerInput,
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  const routeStartedAtMs = Date.now();
  const plannerMode = getChatHybridPlannerMode(process.env, { userId: input.userId, tenantId: input.tenantId });
  if (plannerMode === 'off') return null;
  const plan = await buildChatActionPlan({ ...input, routeStartedAtMs });
  if (!plan) return null;
  if (plannerMode === 'shadow') {
    logger.info({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      actions: plan.steps.map((step) => ({ skill: step.skill, action: step.action, riskClass: step.riskClass })),
      effectiveConfidence: plan.effectiveConfidence ?? plan.confidence,
      routeTier: plan.telemetry?.routeTier,
      threshold: plan.telemetry?.threshold,
    }, 'chat hybrid planner shadow candidate');
    recordShadowTelemetry(plan, input, routeStartedAtMs);
    return null;
  }
  const resolvedDeps = resolveChatActionPlannerDeps(deps);
  const response = await executeChatActionPlan(plan, { ...input, routeStartedAtMs }, resolvedDeps);
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
}

export async function executeConfirmedChatActionRuns(
  input: ChatPlannerInput & { sourceMessageId?: string | null },
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  const rows = listPendingChatActionRuns({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.sourceMessageId ? null : input.conversationId,
    messageId: input.sourceMessageId ?? null,
    limit: 10,
  });
  if (rows.length === 0) return null;
  const steps = rows.map(rowToConfirmedStep).filter((step): step is ChatPlanStep => Boolean(step));
  if (steps.length === 0) return null;
  const plan: ChatActionPlan = {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: rows[0]?.conversation_id ?? input.conversationId,
    messageId: rows[0]?.message_id ?? input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: new Date().toISOString(),
    planner: 'mixed',
    steps,
    requiresConfirmation: false,
    confidence: 0.93,
  };
  const resolvedDeps = resolveChatActionPlannerDeps(deps);
  const response = await executeChatActionPlan(plan, {
    ...input,
    conversationId: plan.conversationId,
    messageId: plan.messageId,
  }, resolvedDeps, { confirmed: true });
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
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
      confirmationSource: options.confirmationSource
        ?? (options.confirmed === true ? 'pending_confirmation' : 'none'),
      requireConfirmationForWrites: input.requireSafeWriteConfirmation === true,
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
      results.push({ step, status: 'blocked', error: 'execution_policy_blocked' });
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
