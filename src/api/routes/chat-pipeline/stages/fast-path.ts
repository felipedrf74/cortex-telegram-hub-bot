// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: token-zero slash-command fast path (/todo, /day, /overdue...).
 * Pure data lookups that must never touch the AI pipeline; intentionally run
 * before the lazy AI lock/quota gate so Free and quota-exhausted paid users
 * retain deterministic Secretary access. Verbatim move.
 * See specs/08-TOKEN-ZERO-ARCHITECTURE.md.
 */

import { logger } from '../../../../utils/logger';
import {
  maybeCacheChatCommandResponse,
  tryBuildFastPathChatResponse,
} from '../../chat-message-local-responses';
import {
  deterministicReadGroundingFact,
  finalizeChatMessageResponse,
} from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const fastPathStage: ChatStage = {
  name: 'fast_path',
  traceStages: ['fast_path'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return !preparedChatTurnCtx(ctx).bypassReadFastPathsForWriteIntent;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedTextLower,
      scopedClientMessageId, userMessageId, chatRequestId, latency,
      recordDeterministicReadEvidence,
    } = preparedChatTurnCtx(ctx);

    const fastPath = await tryBuildFastPathChatResponse(normalizedText, normalizedTextLower, userId, tenantId);
    if (!fastPath) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'fast_path');
    const { response: fastResponse, conversationDomain } = fastPath;
    const response = finalizeChatMessageResponse(fastResponse, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: conversationDomain,
      fallbackRouteMethod: 'fast-path',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      groundingFacts: [deterministicReadGroundingFact('chat.fast_path')],
      stageFamily: 'fast_path',
    });
    // Track domain for conversation continuity even on fast-path.
    rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
    // Cache deterministic responses for the next 60 seconds.
    maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
    logger.info({ cmdLength: normalizedText.length, platform: 'ios', mode: 'fast-path', tenantId, userId }, 'iOS chat fast-path hit');
    recordDeterministicReadEvidence(
      response,
      normalizedText.trim().startsWith('/') ? 'slash' : undefined,
    );
    res.json(response);
    return { kind: 'respond' };
  },
};
