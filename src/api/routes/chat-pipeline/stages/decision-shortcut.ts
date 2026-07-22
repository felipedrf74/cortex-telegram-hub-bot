// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: "confirm this decision" shortcut — resolves a staged pending
 * chat confirmation through Decision Center. Verbatim move.
 */

import { getUserTimezoneById } from '../../../../services/user-service';
import { executeConfirmedChatActionRuns } from '../../../../services/chat';
import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from '../../../../services/chat-pending-confirmations';
import {
  findDecisionByRelatedEntity,
  performDecisionAction,
} from '../../../../services/decision-center';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import {
  isAcceptCurrentDecisionShortcut,
  newAssistantMessageId,
  normalizeIdempotencyKey,
  statusForChatActionResponse,
} from '../support';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const decisionShortcutStage: ChatStage = {
  name: 'decision_confirmation_shortcut',
  traceStages: ['decision_confirmation_shortcut'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return isAcceptCurrentDecisionShortcut(ctx.normalizedTextLower);
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      req, res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, chatRequestId, latency, chatCoreV2RouteLocale,
      recordLegacyFallbackSample,
    } = preparedChatTurnCtx(ctx);

    const pending = getPendingChatConfirmation(userId, tenantId);
    const decision = pending
      ? findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id)
      : null;
    if (!pending || !decision) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'decision_confirmation_shortcut');
    const result = await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
      idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
        ?? `chat-confirm:${tenantId}:${userId}:${pending.id}:${Date.now()}`,
    });
    const confirmedAction = await executeConfirmedChatActionRuns({
      text: pending.actionSummary,
      userId,
      tenantId,
      conversationId: scopedClientMessageId ?? chatRequestId,
      messageId: userMessageId,
      sourceMessageId: pending.sourceMessageId,
      confirmedTargets: pending.confirmedTargets,
      channel: 'ios',
      locale: chatCoreV2RouteLocale,
      timezone: getUserTimezoneById(userId),
    });
    if (confirmedAction) {
      clearPendingChatConfirmation(userId, tenantId);
      // M8: confirmed action runs are read-back verified inside the
      // executor — finalizer policy 'passthrough'.
      const response = finalizeChatMessageResponse(confirmedAction.response, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier2_verified_write',
        stageFamily: 'decision_confirmation_execute',
      });
      response.metadata.confirmationDecision = {
        decisionId: result.item.decisionId,
        actionId: result.actionId,
        idempotent: result.idempotent,
        verification: result.verification,
      };
      rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
      recordLegacyFallbackSample(true, {
        domain: response.domain,
        routeOwner: 'decision_confirmation_shortcut',
        routeMethod: response.routeMethod,
      });
      res.status(statusForChatActionResponse(confirmedAction.status, response)).json(response);
      return { kind: 'respond' };
    }
    const response = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text: chatCoreV2RouteLocale.startsWith('pt')
        ? 'Confirmado. A decisão foi registada no Decision Center e verificada pelo servidor.'
        : 'Confirmed. The decision was recorded in Decision Center and verified by the server.',
      domain: 'chat',
      routeMethod: 'decision-center-action',
      confidence: 0.95,
      buttons: null,
      metadata: {
        type: 'decision_center_chat_confirmation_actioned',
        decisionId: result.item.decisionId,
        actionId: result.actionId,
        idempotent: result.idempotent,
        verification: result.verification,
      },
      timestamp: new Date().toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier2_verified_write',
      actionability: 'execute',
      verificationStatus: 'verified',
      stageFamily: 'decision_confirmation_templated',
    });
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    recordLegacyFallbackSample(true, {
      domain: response.domain,
      routeOwner: 'decision_confirmation_shortcut',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
