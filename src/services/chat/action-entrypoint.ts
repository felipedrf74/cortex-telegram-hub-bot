// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import {
  getChatHybridPlannerMode,
} from '../runtime-flags';
import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
} from './types';
import { resolveChatActionPlannerDeps } from './deps';
import {
  recordShadowTelemetry,
} from './executor/telemetry';
import { executeChatActionPlan } from './executor/plan-executor';
import { buildActionResponse } from './executor/response-builder';
import { buildChatActionPlan } from './planner/orchestrator';
import {
  authorizeChatActionPlanSteps,
  buildChatActionAccessDeniedResponse,
} from './authorization';
import { throwIfChatRequestCancelled } from './request-cancellation';

export async function tryHandleChatActionPlan(
  input: ChatPlannerInput,
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  throwIfChatRequestCancelled(input.abortSignal);
  const routeStartedAtMs = Date.now();
  const plannerMode = getChatHybridPlannerMode(process.env, { userId: input.userId, tenantId: input.tenantId });
  if (plannerMode === 'off') return null;
  const plan = await buildChatActionPlan({ ...input, routeStartedAtMs });
  throwIfChatRequestCancelled(input.abortSignal);
  if (!plan) return null;
  const authorization = authorizeChatActionPlanSteps({
    userId: input.userId,
    tenantId: input.tenantId,
    steps: plan.steps,
  });
  if (!authorization.allowed) {
    const response = buildChatActionAccessDeniedResponse({ ...input, routeStartedAtMs }, plan, authorization);
    return { plan, response, status: 'blocked' };
  }
  if (input.blockNonReadOnlyPlans && plan.steps.some((step) => step.risk !== 'read_only')) {
    const isPT = input.locale?.startsWith('pt');
    const response = buildActionResponse(
      { ...input, routeStartedAtMs },
      plan,
      'needs_confirmation',
      isPT
        ? 'Esta ação precisa de confirmação no app antes de eu alterar qualquer coisa.'
        : 'This action needs confirmation in the app before I change anything.',
      {
        type: 'chat_action_confirmation_required',
        actionStatus: 'ACTION_CONFIRMATION_REQUIRED',
        confirmationTransport: 'rest_required',
        mutationBlocked: true,
      },
    );
    return { plan, response, status: 'needs_confirmation' };
  }
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
  throwIfChatRequestCancelled(input.abortSignal);
  const response = await executeChatActionPlan(plan, { ...input, routeStartedAtMs }, resolvedDeps);
  throwIfChatRequestCancelled(input.abortSignal);
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
}
