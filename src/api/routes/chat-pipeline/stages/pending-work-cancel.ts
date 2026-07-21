// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: pending-work cancellation turn ("cancel" / "para" etc.).
 * Verbatim move of the cancellation checkpoint family (seeded + empty).
 */

import { cancelAllPendingChatWork } from '../../../../services/chat-pending-work';
import { isPendingChatWorkCancellationTurn } from '../../../../services/chat-pending-cancellation';
import { buildBlocksFromMarkdown } from '../../../../services/chat-response-blocks';
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
import { newAssistantMessageId } from '../support';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const pendingWorkCancelStage: ChatStage = {
  name: 'pending_work_cancel',
  traceStages: ['pending_work_cancelled', 'pending_work_cancel_empty'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(
      ctx.normalizedText
      && ctx.normalizedAttachments.length === 0
      && isPendingChatWorkCancellationTurn(ctx.normalizedText),
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample,
    } = preparedChatTurnCtx(ctx);

    const cancelled = cancelAllPendingChatWork({
      userId,
      tenantId,
      conversationId: scopedClientMessageId ?? chatRequestId,
      nowIso: new Date(requestStartedAt).toISOString(),
    });
    const totalCancelled = cancelled.chatPendingActions
      + cancelled.chatActionRuns
      + cancelled.chatCoreV2Commands
      + (cancelled.chatPendingConfirmation ? 1 : 0)
      + (cancelled.decisionDismissed ? 1 : 0);
    recordChatStage(chatRequestId, totalCancelled > 0 ? 'pending_work_cancelled' : 'pending_work_cancel_empty');
    if (totalCancelled > 0) {
      const isPT = chatCoreV2RouteLocale.startsWith('pt');
      const text = isPT
        ? 'Está cancelado. Não vou continuar essa ação pendente.'
        : 'Cancelled. I will not continue that pending action.';
      const response = finalizeChatMessageResponse({
        id: newAssistantMessageId(),
        text,
        domain: 'secretary',
        routeMethod: 'pending-action-cancelled',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'pending_action_cancelled',
          cancelled,
          mutationBlocked: true,
        },
        timestamp: new Date(requestStartedAt).toISOString(),
        responseBlocks: buildBlocksFromMarkdown(text),
      }, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier0_local',
        fallbackDomain: 'secretary',
        fallbackRouteMethod: 'pending-action-cancelled',
        actionability: 'answer_only',
        verificationStatus: 'not_required',
        compositionMode: 'templated',
        groundingFacts: [deterministicReadGroundingFact('chat.pending_work_cancellation')],
        stageFamily: 'pending_work_cancelled',
      });
      rememberChatActiveDomain(userId, 'secretary', Date.now(), tenantId);
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, 'secretary', normalizedText, response.text, tenantId);
      recordLegacyFallbackSample(false, {
        domain: 'secretary',
        routeOwner: 'chat_pending_work_cancellation',
        routeMethod: response.routeMethod,
      });
      res.json(response);
      return { kind: 'respond' };
    }
    const isPT = chatCoreV2RouteLocale.startsWith('pt');
    const text = isPT
      ? 'Não há nenhuma ação pendente para cancelar.'
      : 'There is no pending action to cancel.';
    const response = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text,
      domain: 'secretary',
      routeMethod: 'pending-action-cancel-empty',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'pending_action_cancel_empty',
        cancelled,
        mutationBlocked: true,
      },
      timestamp: new Date(requestStartedAt).toISOString(),
      responseBlocks: buildBlocksFromMarkdown(text),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier0_local',
      fallbackDomain: 'secretary',
      fallbackRouteMethod: 'pending-action-cancel-empty',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      groundingFacts: [deterministicReadGroundingFact('chat.pending_work_cancellation.empty')],
      stageFamily: 'pending_work_cancel_empty',
    });
    rememberChatActiveDomain(userId, 'secretary', Date.now(), tenantId);
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, 'secretary', normalizedText, response.text, tenantId);
    recordLegacyFallbackSample(false, {
      domain: 'secretary',
      routeOwner: 'chat_pending_work_cancellation',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
