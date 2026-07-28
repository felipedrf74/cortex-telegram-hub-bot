// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: General Action Planner — ONE shared module instantiated TWICE
 * in the runner's ordered array:
 *   - 'deterministic': the strictly token-zero first pass
 *     (allowModelPlanner:false) that runs BEFORE read fast paths so
 *     write intents are routed first;
 *   - 'model': the model-assisted pass that only runs after deterministic /
 *     cache / identity / fast-path work has had first refusal (acquires the
 *     AI budget lazily).
 * Both passes share attachPlannerNeedsConfirmationHold (increment c).
 */

import { getUserTimezoneById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import { tryHandleChatActionPlan } from '../../../../services/chat';
import { parseContentScriptShortcut } from '../../chat-shortcut-parsers';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import {
  actionabilityForReasoningStatus,
  anchorEntityIdsFromPlanSteps,
  statusForChatActionResponse,
  verificationForReasoningMetadata,
} from '../support';
import { attachPlannerNeedsConfirmationHold } from '../confirmation-hold';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export type ActionPlannerVariant = 'deterministic' | 'model';

export function createActionPlannerStage(variant: ActionPlannerVariant): ChatStage {
  const traceName = variant === 'deterministic' ? 'action_planner_deterministic' : 'action_planner_model';
  return {
    name: traceName,
    traceStages: variant === 'deterministic'
      ? ['action_planner_deterministic']
      : ['action_planner_model'],
    canHandle(ctx: ChatTurnCtx): boolean {
      return Boolean(
        ctx.normalizedText
        && ctx.normalizedAttachments.length === 0
        && !parseContentScriptShortcut(ctx.normalizedText),
      );
    },
    async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
      const {
        userId, tenantId, normalizedText, scopedClientMessageId,
        userMessageId, requestStartedAt, chatRequestId, latency,
        chatCoreV2RouteLocale, recordLegacyFallbackSample, ensureModelBudget,
      } = preparedChatTurnCtx(ctx);
      const res = ctx.res;

      if (variant === 'model') {
        if (!await ensureModelBudget('iOS chat model planner blocked by AI budget')) return { kind: 'respond' };
      }

      const actionResult = await tryHandleChatActionPlan({
        text: normalizedText,
        userId,
        tenantId,
        conversationId: scopedClientMessageId ?? chatRequestId,
        messageId: userMessageId,
        channel: 'ios',
        locale: chatCoreV2RouteLocale,
        timezone: getUserTimezoneById(userId),
        requireSafeWriteConfirmation: true,
        ...(variant === 'deterministic' ? { allowModelPlanner: false } : {}),
      });
      if (!actionResult) return { kind: 'continue' };

      recordChatStage(chatRequestId, traceName);
      latency.mark('action_planner_completed');
      // M8: planner envelopes carry their own contract metadata from
      // services/chat — the finalizer policy for the deterministic planner
      // family is 'passthrough'; model planner outputs run the full
      // compose + quality gate (a deterministic plan resolved on the model
      // pass keeps the passthrough policy of its family).
      const response = variant === 'deterministic'
        ? finalizeChatMessageResponse(actionResult.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier2_verified_write',
          stageFamily: 'action_planner_deterministic',
        })
        : finalizeChatMessageResponse(actionResult.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier3_model_assisted',
          fallbackDomain: actionResult.response.domain,
          fallbackRouteMethod: actionResult.response.routeMethod,
          fallbackConfidence: actionResult.response.confidence,
          actionability: actionabilityForReasoningStatus(actionResult.status),
          verificationStatus: verificationForReasoningMetadata(
            actionResult.response.metadata as Record<string, unknown> | undefined,
            actionResult.status,
          ),
          compositionMode: 'model_constrained',
          locale: chatCoreV2RouteLocale,
          stageFamily: actionResult.plan.planner === 'deterministic'
            ? 'action_planner_deterministic'
            : 'action_planner_model',
          requestStartedAt,
        });
      if (actionResult.status === 'needs_confirmation') {
        await attachPlannerNeedsConfirmationHold({
          response,
          planSteps: actionResult.plan.steps,
          normalizedText,
          userId,
          tenantId,
          userMessageId,
          chatCoreV2RouteLocale,
        });
      }
      // M13: durable continuity — this terminal knows the persisted
      // assistant message id and the planner step entity ids.
      rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
        conversationId: scopedClientMessageId ?? chatRequestId,
        lastAssistantMessageId: response.id,
        anchorEntityIds: anchorEntityIdsFromPlanSteps(actionResult.plan.steps),
      });
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          routeMethod: response.routeMethod,
          actionStatus: actionResult.status,
          planner: actionResult.plan.planner,
          involvedSkills: actionResult.plan.steps.map((step: { skill: string }) => step.skill),
        },
        variant === 'deterministic'
          ? 'iOS chat action planner handled request'
          : 'iOS chat model-assisted action planner handled request',
      );
      recordLegacyFallbackSample(true, {
        domain: response.domain,
        routeOwner: 'chat_action_planner',
        routeMethod: response.routeMethod,
      });
      res.status(statusForChatActionResponse(actionResult.status, response)).json(response);
      return { kind: 'respond' };
    },
  };
}
