// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M14 stage: deterministic routing-clarify terminal.
 *
 * When the pre_routing orchestrator decision carries a clarify decision
 * (flag AI_ROUTING_CLARIFY, default OFF), this stage responds DIRECTLY with
 * the templated question through the finalizer's contract_only family — the
 * model is never reached, exactly like the destructive-confirmation hold.
 * The persisted assistant message therefore IS the rigid template, which
 * makes isRoutingClarifyQuestion loop prevention deterministic: the next
 * turn's continuity state carries the template verbatim and the orchestrator
 * refuses to re-clarify a clarify-response turn.
 *
 * Ordered AFTER destructive_confirmation_hold (the safety pause outranks a
 * routing question; explicit-confirmation turns never clarify anyway) and
 * BEFORE the v2 local-answer/legacy-tail model owners (a clarify turn must
 * never reach a model).
 */

import { logger } from '../../../../utils/logger';
import { buildChatResponseSufficiencyMetadata } from '../../../../services/chat-response-sufficiency';
import { buildChatSkillRoutingLogContext } from '../../../../services/chat-skill-orchestrator';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { newAssistantMessageId } from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const routingClarifyStage: ChatStage = {
  name: 'routing_clarify',
  traceStages: ['routing_clarify'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(ctx.preRoutingDecision?.clarify);
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, chatRequestId, latency, requestStartedAt,
      recordLegacyFallbackSample, preRoutingDecision,
    } = routedChatTurnCtx(ctx);
    const clarify = preRoutingDecision.clarify!;

    recordChatStage(chatRequestId, 'routing_clarify');
    const sufficiency = buildChatResponseSufficiencyMetadata({
      actionStatus: 'needs_clarification',
      needsClarification: true,
    });
    // The response domain stays the top clarify candidate: it is the best
    // available continuity pin while the user disambiguates.
    const domain = clarify.candidateDomains[0];
    const response = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text: clarify.question,
      domain,
      routeMethod: 'routing-clarify',
      confidence: preRoutingDecision.confidence,
      buttons: null,
      metadata: {
        type: 'chat_routing_clarify',
        actionStatus: sufficiency.actionStatus,
        candidateDomains: clarify.candidateDomains,
        reasonCodes: ['clarify_ambiguous_write_intents'],
        unresolvedBlockers: sufficiency.unresolvedBlockers,
        responseSufficiency: sufficiency,
      },
      timestamp: new Date().toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      actionability: 'clarify',
      verificationStatus: 'not_required',
      stageFamily: 'routing_clarify',
      requestStartedAt,
    });
    // Continuity write: the template becomes the durable lastAssistantMessage
    // so the NEXT turn's pre_routing decision sees it and never re-clarifies.
    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
      conversationId: scopedClientMessageId ?? chatRequestId,
      lastAssistantMessageId: response.id,
      anchorEntityIds: [],
    });
    syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
    logger.info(
      {
        chatRequestId,
        userId,
        tenantId,
        candidateDomains: clarify.candidateDomains,
        orchestration: buildChatSkillRoutingLogContext(preRoutingDecision),
      },
      'iOS chat turn paused for deterministic routing clarification',
    );
    recordLegacyFallbackSample(true, {
      domain: response.domain,
      routeOwner: 'routing_clarify',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
