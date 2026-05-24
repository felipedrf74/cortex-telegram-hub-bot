// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
} from './types';
import { logger } from '../../utils/logger';
import {
  getChatHybridPlannerMode,
} from '../runtime-flags';
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
export { executeConfirmedChatActionRuns } from './executor/confirmed-runs';
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
