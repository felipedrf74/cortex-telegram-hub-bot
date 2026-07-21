// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: legacy tail — routeMessage → skill orchestration → tier gate →
 * domain shortcut → authorized domain-handler execution →
 * finalizeChatAnswerMetadata. The pipeline's final terminal (always
 * responds). Verbatim move of the tail of the original handler, including
 * the M1 authorization write-site (runWithChatToolAuthorization) and the
 * M13 continuity write at the legacy terminal.
 */

import { logger } from '../../../../utils/logger';
import { routeMessage } from '../../../../router';
import { getPendingChatConfirmation, clearPendingChatConfirmation } from '../../../../services/chat-pending-confirmations';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingLogContext,
} from '../../../../services/chat-skill-orchestrator';
import { runWithChatToolAuthorization } from '../../../../services/chat-tool-authorization';
import { issueContentIdeaCaptureConsent } from '../../../../services/content-workspace-chat-consent';
import {
  buildDefaultButtonsForChatDomain,
  getChatDomainHandler,
  rememberChatActiveDomain,
} from '../../chat-message-context';
import {
  ChatDomainTimeoutError,
  buildChatHandlerResponseEnvelope,
  buildChatTimeoutPartialReplyText,
  executeChatDomainHandler,
} from '../../chat-message-execution';
import type { ChatDomainExecutionResult } from '../../chat-message-execution';
import { finalizeChatAnswerMetadata, finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { maybeCacheChatCommandResponse } from '../../chat-message-local-responses';
import { sendChatTierRequiredIfNeeded } from '../../chat-message-tier-gate';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { tryBuildChatMessageShortcutResponse } from '../../chat-message-shortcuts';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { applyTurnContractRouteHint } from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const legacyTailStage: ChatStage = {
  name: 'legacy_tail',
  traceStages: ['legacy_route', 'domain_shortcut', 'legacy_response'],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, normalizedTextLower,
      scopedClientMessageId, userMessageId, requestStartedAt, chatRequestId,
      latency, chatCoreV2RouteLocale, recordLegacyFallbackSample,
      ensureModelBudget, activeContext, preTurnContract, isNewUserFlow,
    } = routedChatTurnCtx(ctx);

    // Route the message (handles both commands and natural language).
    // April 9 2026: thread userId into routeMessage so the classifier
    // cost row in api_usage attributes this call to the real user
    // instead of user_id=0. Without this, every iOS chat message's
    // classification cost was orphaned under user_id=0 and the
    // per-user cap (isUserOverDailyCap) couldn't see the spend.
    if (!await ensureModelBudget('iOS chat provider routing blocked by AI budget')) return { kind: 'respond' };
    const rawRoute = await routeMessage(normalizedText, activeContext, userId, tenantId);
    latency.mark('routed');
    recordChatStage(chatRequestId, 'legacy_route');
    const contractAwareRoute = preTurnContract ? applyTurnContractRouteHint(rawRoute, preTurnContract) : rawRoute;
    const routingDecision = analyzeChatSkillOrchestration({
      message: normalizedText,
      activeContext,
      routedDomain: contractAwareRoute.domain,
      userId,
      tenantId,
      // M15: manifest-validated classifier skill hint (only ever set on
      // classifier routes with AI_CLASSIFY_MANIFEST_PROMPT on).
      classifierSkillHint: rawRoute.skill ?? null,
    });
    const pendingConfirmation = routingDecision.safety.explicitConfirmation
      ? getPendingChatConfirmation(userId, tenantId)
      : null;
    const route = applyChatSkillRoutingDecision(contractAwareRoute, routingDecision);
    recordLegacyFallbackSample(true, {
      domain: route.domain,
      routeOwner: 'legacy_route_message',
      routeMethod: route.method,
    });
    logger.info(
      {
        chatRequestId,
        domain: route.domain,
        method: route.method,
        confidence: route.confidence,
        platform: 'ios',
        orchestration: buildChatSkillRoutingLogContext(routingDecision),
        rawDomain: rawRoute.domain,
        contractHintedDomain: contractAwareRoute.domain !== rawRoute.domain ? contractAwareRoute.domain : null,
      },
      'iOS message routed',
    );

    // Track domain for continuity
    rememberChatActiveDomain(userId, route.domain, Date.now(), tenantId);

    // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
    // Two-layer check (legacy chat-handler parity): explicit disable
    // first, then tier requirement. Fail-open on errors so a bus of
    // signal service issue never locks users out of their data.
    if (sendChatTierRequiredIfNeeded(res, userId, route.domain)) return { kind: 'respond' };

    // Execute domain handler
    const handler = getChatDomainHandler(route.domain);
    if (!handler) {
      res.status(400).json({
        error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
      });
      return { kind: 'respond' };
    }

    const shortcutResult = await tryBuildChatMessageShortcutResponse({
      route,
      normalizedText,
      userId,
      tenantId,
      userLanguage: chatCoreV2RouteLocale,
      activeContext,
    });
    if (shortcutResult) {
      recordChatStage(chatRequestId, 'domain_shortcut');
      const { conversationDomain } = shortcutResult;
      const response = finalizeChatMessageResponse(shortcutResult.response, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier1_fast_read',
        fallbackDomain: conversationDomain,
        fallbackRouteMethod: route.method,
        fallbackConfidence: route.confidence,
        actionability: 'answer_only',
        verificationStatus: 'not_required',
        stageFamily: 'domain_shortcut',
        requestStartedAt,
      });
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
      res.json(response);
      return { kind: 'respond' };
    }

    // M18: catch the typed domain-handler timeout. Per the recorded spike
    // verdict the legacy tool loop gets NO auto-resume (the detached loop
    // keeps running after Promise.race; ADV-2 provider pinning + sliced-
    // history shape stability cannot be guaranteed from a later worker), so
    // a timeout WITH checkpointed tool work becomes a deterministic,
    // locale-aware, honest partial-progress reply ("ask me to continue") —
    // template only, zero further model calls, nothing enqueued. A timeout
    // with ZERO completed tools rethrows: the route's pre-M18 degraded
    // behavior stays byte-identical.
    let result: ChatDomainExecutionResult;
    let timeoutPartial: ChatDomainTimeoutError | null = null;
    try {
      result = await runWithChatToolAuthorization({
        userId,
        tenantId,
        confirmedDestructiveAction: routingDecision.safety.explicitConfirmation,
        // ADV-3: an accepted staged confirmation authorizes exactly the
        // targets it was staged with; a free-text confirmation collapses to a
        // single untyped grant (undefined) inside the authorization layer.
        confirmedDestructiveTargets: routingDecision.safety.explicitConfirmation
          ? pendingConfirmation?.confirmedTargets
          : undefined,
        confirmationSource: routingDecision.safety.explicitConfirmation
          ? pendingConfirmation ? 'pending_confirmation' : 'explicit_current_turn'
          : 'none',
        requireConfirmationForWrites: true,
        contentIdeaCaptureConsent: issueContentIdeaCaptureConsent({
          tenantId,
          userId,
          sourceMessageId: userMessageId,
          message: normalizedText,
        }),
      }, () => executeChatDomainHandler(handler, route.strippedMessage, userId, tenantId, undefined, chatRequestId));
    } catch (err) {
      if (!(err instanceof ChatDomainTimeoutError) || err.checkpoints.length === 0) throw err;
      timeoutPartial = err;
      logger.warn(
        {
          chatRequestId,
          userId,
          tenantId,
          domain: route.domain,
          completedTools: err.checkpoints.map((c) => c.toolName),
        },
        'iOS chat domain handler timed out with checkpointed tool work — returning honest partial-progress reply (no auto-resume)',
      );
      result = {
        text: buildChatTimeoutPartialReplyText(chatCoreV2RouteLocale, err.checkpoints.map((c) => c.toolName)),
        domain: route.domain,
        metadata: {
          type: 'chat_timeout_partial',
          timeoutPartial: {
            runId: err.runId,
            completedTools: err.checkpoints.map((c) => c.toolName),
            completedToolCount: err.checkpoints.length,
            // Spike verdict: legacy tool loops are never auto-resumed.
            autoResume: false,
            continuation: 'ask_to_continue',
          },
        },
      };
    }
    latency.mark('domain_handler_completed');
    recordChatStage(chatRequestId, 'legacy_response');
    // M18 remediation (2026-07-21): on a timeout partial NOTHING destructive
    // executed (checkpoints are read-risk only), so the staged confirmation
    // must survive for the retry — clearing it would force the user to
    // re-confirm work that never happened. Completed confirmed turns still
    // consume the staged confirmation exactly as before.
    if (routingDecision.safety.explicitConfirmation && !timeoutPartial) {
      clearPendingChatConfirmation(userId, tenantId);
    }

    // Extract buttons from the response text if present.
    // Secretary fast-path messages expose deterministic command buttons.
    // Triathlon coach replies can expose real "apply recommendation"
    // actions when the current request produced fresh coach state.
    const lang = chatCoreV2RouteLocale;
    const buttons = buildDefaultButtonsForChatDomain(result.domain || route.domain, lang, userId, requestStartedAt, tenantId);

    const enriched = finalizeChatAnswerMetadata({
      normalizedText,
      responseText: result.text,
      userId,
      tenantId,
      chatRequestId,
      routeMethod: route.method,
      domain: result.domain || route.domain,
      confidence: route.confidence,
      tracker: latency,
      // M18: the partial-progress reply is a fixed template (cannot
      // hallucinate) → contract_only family, honestly tagged as a partial
      // outcome with a retryable user-action fallback. Normal turns keep the
      // pre-M18 full-gate path byte-identical.
      latencyTier: timeoutPartial ? 'tier4_long_running' : 'tier3_model_assisted',
      activeContext,
      route,
      routingDecision,
      locale: chatCoreV2RouteLocale,
      existingMetadata: result.metadata && typeof result.metadata === 'object'
        ? result.metadata as Record<string, unknown>
        : null,
      stageFamily: timeoutPartial ? 'legacy_timeout_partial' : 'legacy_response',
      ...(timeoutPartial
        ? {
          actionability: 'answer_only' as const,
          verificationStatus: 'partial_failure' as const,
          fallback: {
            fallbackType: 'deterministic_summary' as const,
            fallbackReason: 'domain_handler_timeout_partial_progress',
            retryable: true,
            userActionRequired: true,
            operatorActionRequired: false,
          },
        }
        : {}),
      requestStartedAt,
    });
    const response = buildChatHandlerResponseEnvelope({
      route,
      result: { ...result, text: enriched.text },
      buttons,
      metadata: enriched.metadata,
    });

    if (isNewUserFlow) {
      logger.debug(
        {
          chatRequestId,
          userId,
          domain: response.domain,
          routeMethod: response.routeMethod,
          hasButtons: Array.isArray(response.buttons) && response.buttons.length > 0,
          metadataType: (response.metadata as { type?: string } | null)?.type || null,
          textLength: response.text.length,
        },
        'iOS new-user chat response envelope',
      );
    }

    // Cache the response if it was a deterministic command
    maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);

    persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
      clientMessageId: scopedClientMessageId,
      requestId: chatRequestId,
    });
    // M13: durable continuity — the legacy terminal now knows the persisted
    // assistant message id (the earlier pin at routing time had no id yet).
    rememberChatActiveDomain(userId, response.domain || route.domain, Date.now(), tenantId, {
      conversationId: scopedClientMessageId ?? chatRequestId,
      lastAssistantMessageId: response.id,
      anchorEntityIds: [],
    });
    logger.info(
      {
        chatRequestId,
        tenantId,
        userId,
        domain: response.domain,
        durationMs: Date.now() - requestStartedAt,
      },
      'iOS chat request completed',
    );
    res.json(response);
    return { kind: 'respond' };
  },
};
