// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
  ChatPlanStep,
} from './types';
import {
  listPendingChatActionRuns,
} from '../chat-action-run-store';
import { logger } from '../../utils/logger';
import {
  getChatHybridPlannerMode,
} from '../runtime-flags';
import {
  rowToConfirmedStep,
} from './executor/run-persistence';
import {
  recordShadowTelemetry,
} from './executor/telemetry';
import { executeChatActionPlan } from './executor/plan-executor';
import { buildChatActionPlan } from './planner/orchestrator';
import { resolveChatActionPlannerDeps } from './deps';

export { buildLlmPlannerPrompt, buildTier1ClassifierPrompt, parseLlmPlannerJson, parseTier1ClassifierJson } from './planner/tiers';
export { BROAD_SKILL_MIN_PRIORITY_GAP, BROAD_SKILL_SLOT_COMPLETENESS_BONUS } from './planner/broad-skill-intents';
export { shouldRunActionPlannerBeforeReadOnlyFastPaths } from './planner/preflight-gates';
export { buildDeterministicChatActionPlan } from './planner/deterministic';
export { buildChatActionPlan } from './planner/orchestrator';
export { executeChatActionPlan } from './executor/plan-executor';
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
