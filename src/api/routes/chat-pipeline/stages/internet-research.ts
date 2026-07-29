// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: selective internet research turns (flag-gated). Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import { buildChatInternetResearchAnswer } from '../../../../services/chat-internet-research';
import { buildSimpleStateContext } from '../../../../domains/domain-handler';
import { isChatResearchRouterEnabled } from '../../../../services/runtime-flags';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import {
  domainForTurnContractSkill,
  isChatCoreV2VisibleNaturalLanguageOwnerActive,
  newAssistantMessageId,
} from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const internetResearchStage: ChatStage = {
  name: 'internet_research',
  traceStages: ['internet_research'],
  canHandle(ctx: ChatTurnCtx): boolean {
    const r = routedChatTurnCtx(ctx);
    return Boolean(
      isChatResearchRouterEnabled(process.env, { userId: r.userId, tenantId: r.tenantId })
      && r.preTurnContract?.routeKind === 'internet_research'
      && (r.preTurnContract.groundingRequired === 'web' || r.preTurnContract.groundingRequired === 'local_and_web'),
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      ensureModelBudget, recordLegacyFallbackSample, chatCoreV2RouteLocale,
    } = routedChatTurnCtx(ctx);
    const preTurnContract = routedChatTurnCtx(ctx).preTurnContract!;

    recordChatStage(chatRequestId, 'internet_research');
    if (!await ensureModelBudget('iOS chat internet research blocked by AI budget')) return { kind: 'respond' };
    const researchDomain = domainForTurnContractSkill(preTurnContract.skill) ?? 'chat';
    const localContext = preTurnContract.groundingRequired === 'local_and_web' && researchDomain !== 'chat'
      ? await buildSimpleStateContext(researchDomain, userId, normalizedText, tenantId)
      : null;
    const research = await buildChatInternetResearchAnswer({
      message: normalizedText,
      language: preTurnContract.language,
      skill: preTurnContract.skill,
      expectedResponseShape: preTurnContract.expectedResponseShape,
      userId,
      tenantId,
      groundingRequired: preTurnContract.groundingRequired,
      localContext,
    });
    latency.mark('internet_research_completed');
    const chatCoreV2ResearchOwner = isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId);
    const researchRouteMethod = chatCoreV2ResearchOwner
      ? 'chat-core-v2-internet-research'
      : 'internet-research';
    const researchMetadataType = chatCoreV2ResearchOwner
      ? 'chat_core_v2_internet_research'
      : 'chat_internet_research';
    const response = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text: research.text,
      domain: researchDomain,
      routeMethod: researchRouteMethod,
      confidence: research.degraded ? 0.55 : preTurnContract.confidence,
      buttons: null,
      metadata: {
        type: researchMetadataType,
        webSources: research.sources,
        degraded: research.degraded,
        degradedReason: research.degradedReason ?? null,
        routeKind: preTurnContract.routeKind,
        groundingRequired: preTurnContract.groundingRequired,
        contextCompiler: research.context ?? null,
        ...(chatCoreV2ResearchOwner ? {
          chatCoreV2: {
            owner: 'internet_research_adapter',
            packetOnlyCloudFallback: false,
          },
        } : {}),
      },
      timestamp: new Date().toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier4_long_running',
      fallbackDomain: researchDomain,
      fallbackRouteMethod: researchRouteMethod,
      fallbackConfidence: research.degraded ? 0.55 : preTurnContract.confidence,
      locale: chatCoreV2RouteLocale,
      actionability: research.degraded ? 'degraded' : 'answer_only',
      verificationStatus: research.sources.length > 0 ? 'verified' : 'not_required',
      fallback: research.degraded ? {
        fallbackType: 'model_unavailable',
        fallbackReason: research.degradedReason ?? 'web_research_unavailable',
        retryable: true,
        userActionRequired: false,
        operatorActionRequired: false,
      } : undefined,
      stageFamily: 'internet_research',
      requestStartedAt,
    });
    rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
    logger.info(
      {
        chatRequestId,
        tenantId,
        userId,
        skill: preTurnContract.skill,
        sourceCount: research.sources.length,
        degraded: research.degraded,
      },
      'iOS chat handled selective internet research turn',
    );
    recordLegacyFallbackSample(true, {
      domain: researchDomain,
      routeOwner: 'selective_internet_research',
      routeMethod: researchRouteMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
