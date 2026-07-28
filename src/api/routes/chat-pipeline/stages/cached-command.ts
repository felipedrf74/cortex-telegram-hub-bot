// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: deterministic chat-command cache replay. Verbatim move — the
 * cache is deterministic and must remain available before entitlement or
 * budget enforcement.
 */

import { logger } from '../../../../utils/logger';
import { getCachedChatCommandResponse } from '../../chat-message-local-responses';
import {
  deterministicReadGroundingFact,
  finalizeChatMessageResponse,
} from '../../chat-message-finalizer';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const cachedCommandStage: ChatStage = {
  name: 'cached_command',
  traceStages: ['cached_command'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(ctx.normalizedText && ctx.normalizedAttachments.length === 0);
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedTextLower,
      scopedClientMessageId, userMessageId, chatRequestId, latency,
      recordDeterministicReadEvidence,
    } = preparedChatTurnCtx(ctx);

    const cached = getCachedChatCommandResponse(userId, normalizedTextLower, tenantId);
    if (!cached) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'cached_command');
    logger.debug({ cmdLength: normalizedText.length, platform: 'ios', tenantId, userId }, 'Returning cached chat command');
    const cachedResponse = finalizeChatMessageResponse(cached, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier0_local',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      groundingFacts: [deterministicReadGroundingFact('chat.fast_path_cache')],
      stageFamily: 'cached_command',
    });
    persistExchange(userId, userMessageId, normalizedText, cachedResponse.id, cachedResponse, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, cachedResponse.domain, normalizedText, cachedResponse.text, tenantId);
    recordDeterministicReadEvidence(
      cachedResponse,
      normalizedText.trim().startsWith('/') ? 'slash' : undefined,
    );
    res.json(cachedResponse);
    return { kind: 'respond' };
  },
};
