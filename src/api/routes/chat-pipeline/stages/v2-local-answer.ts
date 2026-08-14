// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 local answer owner — ordinary natural-language
 * answer turns served through the V2 planner/composer when the explicit V2
 * local-chat serving flag is visible (canary/on). Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import {
  isContentModelBackedChatShortcutRequest,
  resolveLocalPrimaryContentChatShortcutAdmission,
  tryBuildLocalPrimaryContentChatShortcutResponse,
} from '../../chat-message-shortcuts';
import {
  isLocalPrimaryChatUserEnrolled,
  loadChatV2MemoryContextForOrchestrator,
  runChatCoreV2LocalChatTurn,
} from '../../../../services/chat-core-v2';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { sendChatTierRequiredIfNeeded } from '../../chat-message-tier-gate';
import { sendError } from '../../../response-helpers';
import { ForwardedLocalInferenceError } from '../../../../services/content-engine';
import { SkillInferencePolicyError } from '../../../../services/skill-inference-service';
import { isPublishedChatShadowBaselineEligible } from '../../../../services/chat-shadow-baseline';
import { buildRecentTurnsForChatCoreV2 } from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const v2LocalAnswerStage: ChatStage = {
  name: 'chat_core_v2_local_answer',
  traceStages: ['chat_core_v2_local_answer'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(
      ctx.normalizedText
      && ctx.normalizedAttachments.length === 0
      && !ctx.normalizedText.trim().startsWith('/')
      // This stage also owns enrolled Content script/refinement shortcuts,
      // which run before the generic local Chat orchestrator. Keep the risk
      // boundary here so those early owners cannot relabel a high-risk turn as
      // the low-risk Content workload they dispatch internally.
      && ctx.preTurnContract?.riskClass !== 'high'
      && ctx.preTurnContract?.riskClass !== 'destructive',
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample, ensureModelBudget,
      activeContext,
    } = routedChatTurnCtx(ctx);

    const contentModelShortcutRecognized = isContentModelBackedChatShortcutRequest({
      normalizedText,
      activeContext,
    });
    const contentShortcutAdmission = contentModelShortcutRecognized
      ? resolveLocalPrimaryContentChatShortcutAdmission({ normalizedText, activeContext, userId })
      : null;
    // A recognized but non-enrolled shortcut belongs wholly to legacy. In
    // particular, do not move its tier gate ahead of legacy_route tracing.
    if (contentModelShortcutRecognized && !contentShortcutAdmission) {
      return { kind: 'continue' };
    }
    if (contentShortcutAdmission && sendChatTierRequiredIfNeeded(res, userId, 'content')) {
      return { kind: 'respond' };
    }

    let contentShortcut: Awaited<ReturnType<typeof tryBuildLocalPrimaryContentChatShortcutResponse>>;
    try {
      contentShortcut = contentShortcutAdmission
        ? await tryBuildLocalPrimaryContentChatShortcutResponse({
        normalizedText,
        userId,
        tenantId,
        userLanguage: chatCoreV2RouteLocale,
        activeContext,
        abortSignal: ctx.abortSignal,
        localPrimaryAdmission: contentShortcutAdmission,
      })
        : null;
    } catch (error) {
      if (ctx.abortSignal?.aborted) return { kind: 'respond' };
      if (error instanceof SkillInferencePolicyError) {
        sendError(res, error.code, error.message, error.status, error.details);
        return { kind: 'respond' };
      }
      if (error instanceof ForwardedLocalInferenceError) {
        sendError(res, error.code, error.publicMessage, error.status, error.details);
        return { kind: 'respond' };
      }
      throw error;
    }
    if (contentShortcut) {
      const { conversationDomain } = contentShortcut;
      recordChatStage(chatRequestId, 'chat_core_v2_local_answer');
      latency.mark('chat_core_v2_local_answer_completed');
      const response = finalizeChatMessageResponse(contentShortcut.response, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier3_model_assisted',
        fallbackDomain: conversationDomain,
        fallbackRouteMethod: contentShortcut.response.routeMethod,
        fallbackConfidence: contentShortcut.response.confidence,
        locale: chatCoreV2RouteLocale,
        actionability: 'answer_only',
        verificationStatus: 'not_required',
        compositionMode: 'model_constrained',
        stageFamily: 'chat_core_v2_local_answer',
        requestStartedAt,
      });
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
      rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId, {
        conversationId: scopedClientMessageId ?? chatRequestId,
        lastAssistantMessageId: response.id,
        anchorEntityIds: [],
      });
      recordLegacyFallbackSample(false, {
        domain: response.domain,
        routeOwner: 'chat_core_v2_local_answer',
        routeMethod: response.routeMethod,
      });
      res.json(response);
      return { kind: 'respond' };
    }
    if (!isLocalPrimaryChatUserEnrolled(userId)
        && !await ensureModelBudget('iOS chat local answer blocked by legacy AI budget')) {
      return { kind: 'respond' };
    }
    let pendingLocalPrimaryChatShadow: (() => void) | null = null;
    const localChatResult = await runChatCoreV2LocalChatTurn({
      normalizedText,
      userId,
      tenantId,
      requestId: chatRequestId,
      locale: chatCoreV2RouteLocale,
      surface: 'ios',
      ...(ctx.preTurnContract?.riskClass ? { riskClass: ctx.preTurnContract.riskClass } : {}),
      recentTurns: buildRecentTurnsForChatCoreV2(userId, tenantId),
      memoryContext: loadChatV2MemoryContextForOrchestrator({
        userId,
        tenantId,
        env: process.env,
      }),
      cloudBudgetBoundary: async (providerCall, fallbackBudget) => {
        if (!await ensureModelBudget(
          'iOS chat local-answer cloud fallback blocked by AI budget',
          fallbackBudget,
        )) {
          throw Object.assign(new Error('chat_cloud_budget_denied'), { code: 'CHAT_CLOUD_BUDGET_DENIED' });
        }
        return providerCall();
      },
      abortSignal: ctx.abortSignal,
      deferShadowUntilVisibleOwner: (scheduleShadow) => {
        pendingLocalPrimaryChatShadow = scheduleShadow;
      },
      env: process.env,
    });
    // A disconnected client owns cancellation of this turn. Do not continue
    // into the legacy provider path and do not persist or emit a response.
    if (ctx.abortSignal?.aborted) return { kind: 'respond' };
    if (!localChatResult) {
      return pendingLocalPrimaryChatShadow
        ? { kind: 'continue', patch: { pendingLocalPrimaryChatShadow } }
        : { kind: 'continue' };
    }

    recordChatStage(chatRequestId, 'chat_core_v2_local_answer');
    latency.mark('chat_core_v2_local_answer_completed');
    const response = finalizeChatMessageResponse(localChatResult.response, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: localChatResult.degraded ? 'tier1_fast_read' : 'tier3_model_assisted',
      fallbackDomain: localChatResult.response.domain,
      fallbackRouteMethod: localChatResult.response.routeMethod,
      fallbackConfidence: localChatResult.response.confidence,
      locale: chatCoreV2RouteLocale,
      actionability: localChatResult.degraded ? 'degraded' : 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: localChatResult.degraded ? 'templated' : 'model_constrained',
      fallback: localChatResult.degraded ? {
        fallbackType: 'model_unavailable',
        fallbackReason: String(localChatResult.response.metadata.reason ?? 'local_chat_degraded'),
        retryable: true,
        userActionRequired: false,
        operatorActionRequired: false,
      } : undefined,
      stageFamily: 'chat_core_v2_local_answer',
      requestStartedAt,
    });
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
    if (response.domain !== 'chat') {
      // M13: durable continuity — local-answer terminal knows the
      // persisted assistant message id.
      rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
        conversationId: scopedClientMessageId ?? chatRequestId,
        lastAssistantMessageId: response.id,
        anchorEntityIds: [],
      });
    }
    logger.info(
      {
        chatRequestId,
        tenantId,
        userId,
        routeMethod: response.routeMethod,
        degraded: localChatResult.degraded,
      },
      'iOS chat handled natural-language answer with ChatCoreV2 local answer owner',
    );
    recordLegacyFallbackSample(false, {
      domain: response.domain,
      routeOwner: 'chat_core_v2_local_answer',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    const scheduleShadow = pendingLocalPrimaryChatShadow as (() => void) | null;
    pendingLocalPrimaryChatShadow = null;
    if (scheduleShadow && isPublishedChatShadowBaselineEligible(response.metadata)) {
      try {
        scheduleShadow();
      } catch (error) {
        logger.warn({
          chatRequestId,
          tenantId,
          userId,
          errorName: error instanceof Error ? error.name : typeof error,
        }, 'Unable to schedule detached Chat shadow after visible V2 publication');
      }
    }
    return { kind: 'respond' };
  },
};
