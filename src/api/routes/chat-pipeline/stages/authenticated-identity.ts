// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: authenticated identity fast-path. Identity questions must be
 * answered from the server-scoped auth session, not from a domain prompt or
 * model memory. Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import { tryBuildAuthenticatedIdentityResponse } from '../../chat-message-local-responses';
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

export const authenticatedIdentityStage: ChatStage = {
  name: 'authenticated_identity',
  traceStages: ['authenticated_identity'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedTextLower,
      scopedClientMessageId, userMessageId, chatRequestId, latency,
      chatCoreV2RouteLocale, recordDeterministicReadEvidence,
    } = preparedChatTurnCtx(ctx);

    const identityResponse = tryBuildAuthenticatedIdentityResponse(
      normalizedText,
      normalizedTextLower,
      userId,
      chatCoreV2RouteLocale,
    );
    if (!identityResponse) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'authenticated_identity');
    const { conversationDomain } = identityResponse;
    const response = finalizeChatMessageResponse(identityResponse.response, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: conversationDomain,
      fallbackRouteMethod: 'authenticated-identity',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      groundingFacts: [deterministicReadGroundingFact('auth.session')],
      stageFamily: 'authenticated_identity',
      locale: chatCoreV2RouteLocale,
    });
    rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
    logger.info({ chatRequestId, platform: 'ios', mode: 'authenticated-identity', tenantId, userId }, 'iOS chat authenticated identity fast-path hit');
    recordDeterministicReadEvidence(response);
    res.json(response);
    return { kind: 'respond' };
  },
};
