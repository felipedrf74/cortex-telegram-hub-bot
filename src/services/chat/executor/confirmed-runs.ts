// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  listPendingChatActionRuns,
} from '../../chat-action-run-store';
import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import { resolveChatActionPlannerDeps } from '../deps';
import { executeChatActionPlan } from './plan-executor';
import { rowToConfirmedStep } from './run-persistence';
import {
  authorizeChatActionPlanSteps,
  buildChatActionAccessDeniedResponse,
} from '../authorization';

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
  const authorization = authorizeChatActionPlanSteps({
    userId: input.userId,
    tenantId: input.tenantId,
    steps: plan.steps,
  });
  if (!authorization.allowed) {
    const response = buildChatActionAccessDeniedResponse(input, plan, authorization);
    return { plan, response, status: 'blocked' };
  }
  const resolvedDeps = resolveChatActionPlannerDeps(deps);
  const response = await executeChatActionPlan(plan, {
    ...input,
    conversationId: plan.conversationId,
    messageId: plan.messageId,
  }, resolvedDeps, { confirmed: true });
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
}
