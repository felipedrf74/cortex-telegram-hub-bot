// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: token-zero natural-language shortcut (deterministic reads that
 * must never queue behind a model call). Verbatim move.
 */

import { tryBuildTokenZeroChatMessageShortcutResponse } from '../../chat-message-shortcuts';
import { inspectContentCreativeShortcut } from '../../chat-shortcut-parsers';
import {
  deterministicReadGroundingFact,
  finalizeChatMessageResponse,
} from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import { sendChatTierRequiredIfNeeded } from '../../chat-message-tier-gate';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const tokenZeroShortcutStage: ChatStage = {
  name: 'token_zero_shortcut',
  traceStages: ['token_zero_shortcut'],
  canHandle(ctx: ChatTurnCtx): boolean {
    const p = preparedChatTurnCtx(ctx);
    const malformedCreativeCommand = p.normalizedText
      ? inspectContentCreativeShortcut(p.normalizedText).status === 'invalid'
      : false;
    return Boolean(
      p.normalizedText
      && p.normalizedAttachments.length === 0
      && (malformedCreativeCommand || (
        !p.bypassReadFastPathsForWriteIntent
        && !p.bypassNaturalLanguageTokenZeroForChatCoreV2
      )),
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, chatRequestId, latency,
      chatCoreV2RouteLocale, recordDeterministicReadEvidence,
      recordChatV2CompletionEvidenceForImmediateResponse,
    } = preparedChatTurnCtx(ctx);

    const tokenZeroShortcut = await tryBuildTokenZeroChatMessageShortcutResponse({
      normalizedText,
      userId,
      tenantId,
      userLanguage: chatCoreV2RouteLocale,
    });
    if (!tokenZeroShortcut) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'token_zero_shortcut');
    const { conversationDomain } = tokenZeroShortcut;
    if (sendChatTierRequiredIfNeeded(res, userId, conversationDomain)) return { kind: 'respond' };
    const response = finalizeChatMessageResponse(tokenZeroShortcut.response, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: conversationDomain,
      fallbackRouteMethod: tokenZeroShortcut.response.routeMethod,
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      groundingFacts: [deterministicReadGroundingFact('chat.token_zero_shortcut')],
      stageFamily: 'token_zero_shortcut',
    });
    rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
    recordDeterministicReadEvidence(response);
    recordChatV2CompletionEvidenceForImmediateResponse(response);
    res.json(response);
    return { kind: 'respond' };
  },
};
