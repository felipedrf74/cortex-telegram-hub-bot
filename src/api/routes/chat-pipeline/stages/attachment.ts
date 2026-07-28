// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: attachment turns (image/receipt/etc.). Verbatim move.
 */

import { getUserLanguageById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import { buildChatAttachmentResponse } from '../../chat-message-attachments';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const attachmentStage: ChatStage = {
  name: 'attachment',
  traceStages: ['attachment'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return ctx.normalizedAttachments.length > 0;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedAttachments,
      scopedClientMessageId, userMessageId, requestStartedAt, chatRequestId,
      latency, ensureModelBudget,
    } = preparedChatTurnCtx(ctx);

    recordChatStage(chatRequestId, 'attachment');
    if (!await ensureModelBudget('iOS chat attachment blocked by AI budget')) return { kind: 'respond' };

    const attachment = normalizedAttachments[0];
    const lang = getUserLanguageById(userId) || 'pt-BR';
    const result = await buildChatAttachmentResponse({
      attachment,
      normalizedText,
      userId,
      tenantId,
      language: lang,
    });
    rememberChatActiveDomain(userId, result.conversationDomain, Date.now(), tenantId);
    const response = finalizeChatMessageResponse(result.response, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: result.degraded ? 'tier4_long_running' : 'tier2_verified_write',
      fallbackDomain: result.conversationDomain,
      fallbackRouteMethod: 'attachment',
      stageFamily: 'attachment',
      requestStartedAt,
      actionability: result.degraded ? 'degraded' : 'answer_only',
      verificationStatus: result.degraded ? 'failed' : 'not_required',
      fallback: result.degraded ? {
        fallbackType: 'deterministic_summary',
        fallbackReason: result.degradedReason ?? 'attachment_processing_degraded',
        retryable: true,
        userActionRequired: false,
        operatorActionRequired: false,
      } : undefined,
    });
    persistExchange(userId, userMessageId, result.userText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, result.conversationDomain, result.userText, response.text, tenantId);
    if (result.degraded) {
      logger.warn(
        { err: result.error, chatRequestId, userId, reason: result.degradedReason, platform: 'ios' },
        'iOS chat attachment degraded',
      );
    }
    res.json(response);
    return { kind: 'respond' };
  },
};
