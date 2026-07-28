// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 shadow-route recording hook (observability only —
 * never responds). Verbatim move.
 */

import { getUserTimezoneById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import { runChatCoreV2ShadowRouteHook } from '../../../../services/chat-core-v2';
import { isChatCoreV2ShadowRouteHookEnabled } from '../../../../services/runtime-flags';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const shadowRouteStage: ChatStage = {
  name: 'shadow_route_recording',
  traceStages: [],
  canHandle(ctx: ChatTurnCtx): boolean {
    return isChatCoreV2ShadowRouteHookEnabled(process.env, { userId: ctx.userId, tenantId: ctx.tenantId });
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      userId, tenantId, normalizedText, normalizedAttachments,
      scopedClientMessageId, userMessageId, requestStartedAt, chatRequestId,
      chatCoreV2RouteLocale,
    } = preparedChatTurnCtx(ctx);

    const shadow = runChatCoreV2ShadowRouteHook({
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      userMessageId,
      clientMessageId: scopedClientMessageId,
      attachmentsCount: normalizedAttachments.length,
      locale: chatCoreV2RouteLocale,
      timezone: getUserTimezoneById(userId),
      now: new Date(requestStartedAt),
    });
    if (shadow.recorded) {
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          routeMethod: shadow.result?.routeDecision.routeMethod,
          reasoningTier: shadow.result?.routeDecision.reasoningTier,
          replayBundleId: shadow.replayBundleId,
        },
        'Chat Core v2 shadow route hook recorded plan',
      );
    }
    return { kind: 'continue' };
  },
};
