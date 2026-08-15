// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

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
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';
import { finalizeChatMessageResponse } from './chat-message-finalizer';

/**
 * Build and publish the retryable degraded terminal. Runtime callers must
 * retain the user account-inference admission until this promise settles,
 * because it persists both conversation rows and shortcut state.
 */
export async function sendRetryableChatFailureResponseIfNeeded(opts: {
  err: unknown;
  res: Response;
  userId: number;
  tenantId?: number;
  normalizedText: string;
  chatRequestId: string;
  /**
   * Codex QA round 4: pass the original claimed user message id so the
   * degraded response is persisted under the SAME id the route claimed
   * at acceptance. Otherwise the retry on the iOS client can't find a
   * completed assistant for `msg-user-${clientMessageId}` and loops as
   * "in progress".
   */
  userMessageId?: string;
  clientMessageId?: string;
}): Promise<boolean> {
  const { err, res, userId, tenantId, normalizedText, chatRequestId, userMessageId, clientMessageId } = opts;
  if (!isRetryableAIProviderError(err)) return false;

  // 2026-05-18 (skill-hardening QA P1-1): require validated tenantId; the
  // previous `?? userId` fallback could mis-attribute degraded-response
  // events across tenants. Route layer must call assertTenantScope first.
  const validatedTenantId = requireTenantIdParam(tenantId, 'sendRetryableChatFailureResponse');

  const degradedDomain = keywordMatch(normalizedText) || getLastChatActiveDomain(userId, Date.now(), validatedTenantId) || 'secretary';
  const degraded = await buildAITemporarilyBusyResponse(degradedDomain, userId, validatedTenantId);
  const timestamp = new Date().toISOString();
  const assistantMessageId = `msg-${randomUUID()}`;
  const tracker = createChatLatencyTracker(Date.now());
  tracker.mark('retryable_provider_failure');
  const grounding = buildChatGroundingEnvelope({
    message: normalizedText,
    userId,
    tenantId: validatedTenantId,
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

  // The degraded contract is hand-rolled above (buildNexusAnswerContract with
  // actionability 'degraded' + applyChatFallbackPolicy). Routing the envelope
  // through the finalizer with the 'degraded_response' PASSTHROUGH family
  // keeps this terminal visible to the one-terminal-pipeline governance scan
  // without re-gating or re-stamping the hand-rolled contract.
  const response = finalizeChatMessageResponse({
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
  }, {
    normalizedText,
    userId,
    tenantId: validatedTenantId,
    chatRequestId,
    tracker,
    latencyTier: 'tier4_long_running',
    stageFamily: 'degraded_response',
  });
  // Codex QA round 4: preserve the original claimed user-message id so
  // iOS retry can find the completed (degraded) assistant by the same
  // key the route claimed at acceptance. Fall back to a fresh id only
  // when the caller didn't pass one (legacy paths).
  const persistedUserMessageId = userMessageId
    ?? (clientMessageId ? `msg-user-${clientMessageId}` : `msg-user-${randomUUID()}`);
  persistExchange(userId, persistedUserMessageId, normalizedText, assistantMessageId, response, validatedTenantId);
  syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text, validatedTenantId);
  res.json(response);
  return true;
}
