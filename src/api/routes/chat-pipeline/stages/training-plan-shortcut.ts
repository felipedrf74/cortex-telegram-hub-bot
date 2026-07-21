// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: natural-language plan-creation shortcut. Intercepts
 * "criar plano" / "create training plan" before the AI pipeline and returns
 * a token-zero response directing the user to the Training tab's one-shot
 * plan generator ($0.01 vs $0.15). Verbatim move.
 */

import { tryBuildTrainingPlanShortcutResponse } from '../../chat-message-local-responses';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const trainingPlanShortcutStage: ChatStage = {
  name: 'training_plan_shortcut',
  traceStages: ['training_plan_shortcut'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedTextLower,
      scopedClientMessageId, userMessageId, chatRequestId, latency,
      recordLegacyFallbackSample,
    } = preparedChatTurnCtx(ctx);

    const trainingPlanShortcut = tryBuildTrainingPlanShortcutResponse(normalizedText, normalizedTextLower, userId);
    if (!trainingPlanShortcut) return { kind: 'continue' };

    recordChatStage(chatRequestId, 'training_plan_shortcut');
    const { response: planResponse, conversationDomain } = trainingPlanShortcut;
    const response = finalizeChatMessageResponse(planResponse, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: conversationDomain,
      fallbackRouteMethod: 'training-plan-shortcut',
      actionability: 'preview',
      verificationStatus: 'not_required',
      stageFamily: 'training_plan_shortcut',
    });
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
    recordLegacyFallbackSample(true, {
      domain: conversationDomain,
      routeOwner: 'training_plan_shortcut',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
