// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: user-message idempotency claim + request-validated checkpoint.
 * Verbatim move: computes isNewUserFlow BEFORE the claim insert (ordering is
 * load-bearing — the claim writes the user message row), then claims the
 * client message id, then logs the request-started line and records the
 * request_validated trace checkpoint.
 */

import { logger } from '../../../../utils/logger';
import { claimUserChatMessage, listChatMessages } from '../../../../services/chat-history-store';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { newAssistantMessageId } from '../support';
import type { ChatStage, ChatStageResult, ChatTurnCtx } from '../types';

export const idempotencyClaimStage: ChatStage = {
  name: 'idempotency_claim',
  traceStages: ['idempotency_claim_conflict', 'idempotency_in_progress', 'request_validated'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedAttachments,
      scopedClientMessageId, userMessageId, requestStartedAt, chatRequestId, latency,
    } = ctx;

    const isNewUserFlow = listChatMessages(userId, 1, undefined, tenantId).messages.length === 0;

    if (scopedClientMessageId) {
      const claim = claimUserChatMessage({
        userId,
        tenantId,
        messageId: userMessageId,
        text: normalizedText,
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
        timestamp: new Date(requestStartedAt).toISOString(),
      });
      if (claim.status === 'conflict') {
        recordChatStage(chatRequestId, 'idempotency_claim_conflict');
        logger.warn(
          { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
          'iOS chat idempotency claim conflicted with existing message text',
        );
        res.status(409).json({
          error: {
            code: 'CHAT_IDEMPOTENCY_CONFLICT',
            message: 'This chat request id was already used for a different message.',
          },
        });
        return { kind: 'respond' };
      }
      if (claim.status === 'duplicate') {
        recordChatStage(chatRequestId, 'idempotency_in_progress');
        logger.info(
          { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId, lifecycleState: claim.existingLifecycleState },
          'iOS chat idempotent retry found an in-flight message claim',
        );
        const response = finalizeChatMessageResponse({
          id: newAssistantMessageId(),
          text: 'I am still processing that request. I will reuse the original result instead of running the action again.',
          domain: 'secretary',
          routeMethod: 'idempotency-in-progress',
          confidence: 1,
          buttons: null,
          metadata: {
            type: 'chat_idempotency_in_progress',
            idempotencyInProgress: true,
            replayOfUserMessageId: claim.messageId,
          },
          timestamp: new Date(requestStartedAt).toISOString(),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier4_long_running',
          actionability: 'degraded',
          verificationStatus: 'pending',
          stageFamily: 'idempotency_in_progress',
        });
        res.status(202).json(response);
        return { kind: 'respond' };
      }
    }

    logger.info(
      {
        chatRequestId,
        tenantId,
        userId,
        platform: 'ios',
        isNewUserFlow,
        hasAttachments: normalizedAttachments.length > 0,
        textLength: normalizedText.length,
      },
      'iOS chat request started',
    );
    latency.mark('request_validated');
    recordChatStage(chatRequestId, 'request_validated');

    return { kind: 'continue', patch: { isNewUserFlow } };
  },
};
