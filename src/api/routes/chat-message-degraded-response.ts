// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { buildAITemporarilyBusyResponse } from '../../domains/ai-unavailable';
import { keywordMatch } from '../../router';
import { logger } from '../../utils/logger';
import { getLastChatActiveDomain } from './chat-message-context';
import { isRetryableAIProviderError } from './chat-content-refinement';
import {
  buildNexusAnswerContract,
  createChatLatencyTracker,
  metadataGroundingFacts,
} from '../../services/chat-answer-contract';
import { applyChatFallbackPolicy } from '../../services/chat-fallback-policy';
import { buildChatGroundingEnvelope } from '../../services/chat-grounding-layer';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';

export async function sendRetryableChatFailureResponseIfNeeded(opts: {
  err: unknown;
  res: Response;
  userId: number;
  tenantId?: number;
  normalizedText: string;
  chatRequestId: string;
}): Promise<boolean> {
  const { err, res, userId, tenantId, normalizedText, chatRequestId } = opts;
  if (!isRetryableAIProviderError(err)) return false;

  const degradedDomain = keywordMatch(normalizedText) || getLastChatActiveDomain(userId, Date.now(), tenantId) || 'secretary';
  const degraded = await buildAITemporarilyBusyResponse(degradedDomain, userId);
  const timestamp = new Date().toISOString();
  const assistantMessageId = `msg-${Date.now()}`;
  const tracker = createChatLatencyTracker(Date.now());
  tracker.mark('retryable_provider_failure');
  const grounding = buildChatGroundingEnvelope({
    message: normalizedText,
    userId,
    tenantId: tenantId ?? userId,
    routedDomain: degraded.domain,
  });
  const contract = buildNexusAnswerContract({
    intent: grounding.capability.intent,
    ownerSkill: grounding.capability.ownerSkill,
    routeMethod: 'degraded',
    confidence: 0.1,
    groundingFacts: grounding.groundingFacts,
    missingFacts: grounding.missingFacts,
    staleness: grounding.staleness,
    riskLevel: grounding.capability.riskLevel,
    actionability: 'degraded',
    verificationStatus: 'failed',
    fallback: {
      fallbackType: 'degraded_response',
      fallbackReason: 'retryable_ai_provider_failure',
      retryable: true,
      sourceFreshness: grounding.staleness,
      userActionRequired: false,
      operatorActionRequired: false,
    },
    userFacingSummary: degraded.text,
    traceId: chatRequestId,
    latency: tracker.snapshot('tier4_long_running', grounding.capability.capability.latencyBudgetMs),
  });
  const fallbackPolicy = applyChatFallbackPolicy(contract);

  logger.warn(
    { err, platform: 'ios', chatRequestId, userId, degradedDomain },
    'iOS chat/message degraded after retryable AI provider failure',
  );

  const response = {
    id: assistantMessageId,
    text: degraded.text,
    domain: degraded.domain,
    routeMethod: 'degraded',
    confidence: 0.1,
    buttons: null,
    metadata: {
      type: 'nexus_answer',
      degraded: true,
      retryable: true,
      chatReasoning: fallbackPolicy.contract,
      groundingFacts: metadataGroundingFacts(fallbackPolicy.contract.groundingFacts),
      fallback: fallbackPolicy.contract.fallback,
      fallbackPolicy: fallbackPolicy.policy,
    },
    timestamp,
  };
  if (tenantId) {
    persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, assistantMessageId, response, tenantId);
    syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text, tenantId);
  } else {
    persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, assistantMessageId, response);
    syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text);
  }
  res.json(response);
  return true;
}
