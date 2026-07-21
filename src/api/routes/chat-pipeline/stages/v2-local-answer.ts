// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 local answer owner — ordinary natural-language
 * answer turns served through the V2 planner/composer when the explicit V2
 * local-chat serving flag is visible (canary/on). Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import {
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
import { buildRecentTurnsForChatCoreV2 } from '../support';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const v2LocalAnswerStage: ChatStage = {
  name: 'chat_core_v2_local_answer',
  traceStages: ['chat_core_v2_local_answer'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(
      ctx.normalizedText
      && ctx.normalizedAttachments.length === 0
      && !ctx.normalizedText.trim().startsWith('/'),
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample, ensureModelBudget,
    } = preparedChatTurnCtx(ctx);

    if (!await ensureModelBudget('iOS chat local answer blocked by AI budget')) return { kind: 'respond' };
    const localChatResult = await runChatCoreV2LocalChatTurn({
      normalizedText,
      userId,
      tenantId,
      requestId: chatRequestId,
      locale: chatCoreV2RouteLocale,
      surface: 'ios',
      recentTurns: buildRecentTurnsForChatCoreV2(userId, tenantId),
      memoryContext: loadChatV2MemoryContextForOrchestrator({
        userId,
        tenantId,
        env: process.env,
      }),
      env: process.env,
    });
    if (!localChatResult) return { kind: 'continue' };

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
    return { kind: 'respond' };
  },
};
