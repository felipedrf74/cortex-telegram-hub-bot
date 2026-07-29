// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 deterministic read — ONE shared module instantiated
 * TWICE in the runner's ordered array (the two formerly separate checkpoints).
 *
 * DECISION (M10 increment b): the two checkpoints were NOT collapsed into a
 * single re-entrant stage evaluation because they are not equivalent and the
 * replay corpus cannot prove equivalence (both families are listed as NOT
 * COVERED there — no corpus proof exists). Real differences, encoded below
 * as the variant table:
 *   - guard: the late checkpoint additionally requires
 *     !bypassReadFastPathsForWriteIntent; the early one does not.
 *   - probe input: both pass the request-resolved
 *     locale=chatCoreV2RouteLocale; early passes NO surface while late passes
 *     surface:'ios'.
 *   - trace name: chat_core_v2_deterministic_read_early vs
 *     chat_core_v2_deterministic_read (both pinned by the stage trace).
 *   - latency mark: only the early checkpoint marks
 *     chat_core_v2_deterministic_read_completed.
 *   - finalizer options: only the late checkpoint sets
 *     compositionMode:'templated' + deterministic-read grounding facts.
 *   - evidence: only the late checkpoint records deterministic-read evidence.
 *   - log line: distinct messages/fields per checkpoint.
 */

import { getUserTimezoneById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import {
  tryBuildChatCoreV2DeterministicReadRoute,
} from '../../../../services/chat-core-v2';
import {
  deterministicReadGroundingFact,
  finalizeChatMessageResponse,
} from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { buildChatCoreV2DeterministicReadShortcutResponse } from '../../chat-core-v2-deterministic-read-response';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export type DeterministicReadVariant = 'early' | 'gated';

export function createChatCoreV2DeterministicReadStage(variant: DeterministicReadVariant): ChatStage {
  const traceName = variant === 'early'
    ? 'chat_core_v2_deterministic_read_early'
    : 'chat_core_v2_deterministic_read';
  return {
    name: traceName,
    traceStages: [traceName],
    canHandle(ctx: ChatTurnCtx): boolean {
      const p = preparedChatTurnCtx(ctx);
      const base = Boolean(
        p.normalizedText
        && p.normalizedAttachments.length === 0
        && !p.normalizedText.trim().startsWith('/'),
      );
      if (variant === 'early') return base;
      return base && !p.bypassReadFastPathsForWriteIntent;
    },
    async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
      const {
        res, userId, tenantId, normalizedText, scopedClientMessageId,
        userMessageId, requestStartedAt, chatRequestId, latency,
        chatCoreV2RouteLocale, recordDeterministicReadEvidence,
        recordLegacyFallbackSample,
      } = preparedChatTurnCtx(ctx);

      const readRoute = variant === 'early'
        ? tryBuildChatCoreV2DeterministicReadRoute({
          normalizedText,
          userId,
          tenantId,
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        })
        : tryBuildChatCoreV2DeterministicReadRoute({
          normalizedText,
          userId,
          tenantId,
          surface: 'ios',
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        });
      if (!readRoute) return { kind: 'continue' };

      recordChatStage(chatRequestId, traceName);
      if (variant === 'early') latency.mark('chat_core_v2_deterministic_read_completed');
      const built = buildChatCoreV2DeterministicReadShortcutResponse({
        result: readRoute,
        requestStartedAt,
      });
      const { conversationDomain } = built;
      const response = finalizeChatMessageResponse(built.response, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier1_fast_read',
        fallbackDomain: conversationDomain,
        fallbackRouteMethod: variant === 'early' ? 'chat-core-v2-deterministic-read' : built.response.routeMethod,
        actionability: 'answer_only',
        verificationStatus: 'not_required',
        ...(variant === 'gated' ? {
          compositionMode: 'templated' as const,
          groundingFacts: [deterministicReadGroundingFact('chat_core_v2.deterministic_read')],
        } : {}),
        stageFamily: traceName,
      });
      rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
      if (variant === 'gated') {
        recordDeterministicReadEvidence(response);
        logger.info(
          {
            chatRequestId,
            tenantId,
            userId,
            capabilityId: built.logContext.capabilityId,
            contextHash: built.logContext.contextHash,
          },
          'iOS chat ChatCoreV2 deterministic read route handled request',
        );
      } else {
        logger.info(
          {
            chatRequestId,
            platform: 'ios',
            mode: 'chat-core-v2-deterministic-read',
            tenantId,
            userId,
            capabilityId: built.logContext.capabilityId,
            contextHash: built.logContext.contextHash,
          },
          'iOS chat Chat Core v2 deterministic read hit',
        );
      }
      recordLegacyFallbackSample(false, {
        domain: readRoute.readModel.domain,
        routeOwner: 'chat_core_v2_deterministic_read',
        routeMethod: response.routeMethod,
      });
      res.json(response);
      return { kind: 'respond' };
    },
  };
}
