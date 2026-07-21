// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 unsupported fallback — returned instead of the
 * legacy routeMessage path when the V2 owner deems the turn unsupported and
 * legacy fallback is disabled. Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import { evaluateChatCoreV2UnsupportedFallback } from '../../../../services/chat-core-v2';
import { buildBlocksFromMarkdown } from '../../../../services/chat-response-blocks';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { newAssistantMessageId } from '../support';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const unsupportedFallbackStage: ChatStage = {
  name: 'chat_core_v2_unsupported_fallback',
  traceStages: ['chat_core_v2_unsupported_fallback'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample,
    } = preparedChatTurnCtx(ctx);

    const unsupportedFallback = evaluateChatCoreV2UnsupportedFallback({
      normalizedText,
      locale: chatCoreV2RouteLocale,
      tenantId,
      env: process.env,
    });
    if (!unsupportedFallback.response) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'chat_core_v2_unsupported_fallback');
    latency.mark('chat_core_v2_unsupported_fallback_returned');
    const unsupportedResponse = {
      id: newAssistantMessageId(),
      text: unsupportedFallback.response.text,
      domain: 'chat',
      routeMethod: 'unsupported',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_unsupported_fallback',
        kind: unsupportedFallback.response.kind,
        locale: unsupportedFallback.response.locale,
        reasonCodes: unsupportedFallback.response.reasonCodes,
        decisionReason: unsupportedFallback.decisionReason,
        legacyFallbackDisabled: unsupportedFallback.legacyFallbackDisabled,
        routeGuess: {
          intent: unsupportedFallback.routeGuess.intent,
          domains: unsupportedFallback.routeGuess.domains,
          capabilityIds: unsupportedFallback.routeGuess.capabilityIds,
          confidence: unsupportedFallback.routeGuess.confidence,
          unsupportedReason: unsupportedFallback.routeGuess.unsupportedReason,
        },
      },
      timestamp: new Date(requestStartedAt).toISOString(),
      responseBlocks: buildBlocksFromMarkdown(unsupportedFallback.response.text),
      reasonCodes: unsupportedFallback.response.reasonCodes,
    };
    const response = finalizeChatMessageResponse(unsupportedResponse, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: unsupportedResponse.domain,
      fallbackRouteMethod: unsupportedResponse.routeMethod,
      fallbackConfidence: unsupportedResponse.confidence,
      actionability: 'blocked',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      locale: chatCoreV2RouteLocale,
      fallback: {
        fallbackType: 'degraded_response',
        fallbackReason: unsupportedFallback.decisionReason ?? 'chat_core_v2_unsupported_fallback',
        retryable: false,
        userActionRequired: true,
        operatorActionRequired: false,
      },
      stageFamily: 'chat_core_v2_unsupported_fallback',
    });
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
    rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
    logger.info(
      {
        chatRequestId,
        tenantId,
        userId,
        routeMethod: response.routeMethod,
        decisionReason: unsupportedFallback.decisionReason,
        legacyFallbackDisabled: unsupportedFallback.legacyFallbackDisabled,
      },
      'iOS chat returned ChatCoreV2 unsupported fallback instead of legacy routeMessage',
    );
    recordLegacyFallbackSample(false, {
      domain: response.domain,
      routeOwner: 'chat_core_v2_unsupported_fallback',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
