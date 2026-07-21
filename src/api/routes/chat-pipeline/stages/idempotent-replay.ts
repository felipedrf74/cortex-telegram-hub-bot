// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: idempotent replay of a completed assistant message.
 * Verbatim move of the first /message checkpoint family.
 */

import { logger } from '../../../../utils/logger';
import { findCompletedAssistantForClientMessage } from '../../../../services/chat-history-store';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import type { ChatStage, ChatStageResult, ChatTurnCtx } from '../types';

export const idempotentReplayStage: ChatStage = {
  name: 'idempotent_replay',
  traceStages: ['idempotent_replay_conflict', 'idempotent_replay'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId, chatRequestId, latency,
    } = ctx;
    const idempotentHit = findCompletedAssistantForClientMessage(userId, scopedClientMessageId, tenantId);
    if (!idempotentHit) return { kind: 'continue' };

    recordChatStage(chatRequestId, idempotentHit.userText !== normalizedText ? 'idempotent_replay_conflict' : 'idempotent_replay');
    if (idempotentHit.userText !== normalizedText) {
      logger.warn(
        { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
        'iOS chat idempotent retry used a client message id with different text',
      );
      res.status(409).json({
        error: {
          code: 'CHAT_IDEMPOTENCY_CONFLICT',
          message: 'This chat request id was already used for a different message.',
        },
      });
      return { kind: 'respond' };
    }
    logger.info(
      { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
      'iOS chat idempotent retry returned existing assistant message',
    );
    // M8: replay envelopes were finalized on the ORIGINAL turn — the
    // finalizer policy for this family is 'passthrough' (byte-identical).
    const replayResponse = finalizeChatMessageResponse({
      id: idempotentHit.assistantMessage.id,
      text: idempotentHit.assistantMessage.text,
      domain: idempotentHit.assistantMessage.domain,
      routeMethod: idempotentHit.assistantMessage.routeMethod ?? 'idempotent-replay',
      confidence: idempotentHit.assistantMessage.confidence ?? 1,
      buttons: idempotentHit.assistantMessage.buttons ?? null,
      metadata: {
        ...(idempotentHit.assistantMessage.metadata && typeof idempotentHit.assistantMessage.metadata === 'object'
          ? idempotentHit.assistantMessage.metadata as Record<string, unknown>
          : {}),
        idempotentReplay: true,
        replayOfUserMessageId: idempotentHit.userMessageId,
      },
      timestamp: idempotentHit.assistantMessage.timestamp,
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier0_local',
      stageFamily: 'idempotent_replay',
    });
    res.json(replayResponse);
    return { kind: 'respond' };
  },
};
