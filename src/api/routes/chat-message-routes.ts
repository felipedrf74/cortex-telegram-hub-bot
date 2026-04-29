// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import {
  claimUserChatMessage,
  findCompletedAssistantForClientMessage,
  listChatMessages,
} from '../../services/chat-history-store';
import { getUserLanguage } from '../../services/user-service';
import { acquireCostLock } from '../../services/cost-guardrail';
import { getCurrentRequestId } from '../../utils/request-context';
import {
  buildDefaultButtonsForChatDomain,
  getChatDomainHandler,
  rememberChatActiveDomain,
  resolveChatActiveContext,
} from './chat-message-context';
import {
  buildChatHandlerResponseEnvelope,
  executeChatDomainHandler,
} from './chat-message-execution';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingLogContext,
} from '../../services/chat-skill-orchestrator';
import { runWithChatToolAuthorization } from '../../services/chat-tool-authorization';
import { sendInternalError } from '../response-helpers';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';
import { buildChatAttachmentResponse } from './chat-message-attachments';
import { tryBuildChatMessageShortcutResponse } from './chat-message-shortcuts';
import {
  getCachedChatCommandResponse,
  maybeCacheChatCommandResponse,
  tryBuildFastPathChatResponse,
  tryBuildTrainingPlanShortcutResponse,
} from './chat-message-local-responses';
import {
  normalizeChatMessageRequest,
  persistChatLanguagePreference,
  sendChatQuotaExceededIfNeeded,
} from './chat-message-request';
import { sendChatTierRequiredIfNeeded } from './chat-message-tier-gate';
import { sendRetryableChatFailureResponseIfNeeded } from './chat-message-degraded-response';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export { clearChatActiveDomain } from './chat-message-context';

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
}

function buildUserMessageId(clientMessageId: string | null, fallbackTimestamp = Date.now()): string {
  return clientMessageId ? `msg-user-${clientMessageId}` : `msg-user-${fallbackTimestamp}`;
}

export function registerChatMessageRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
): void {
  /**
   * POST /api/v1/chat/message
   * Send a message — equivalent to typing in Telegram.
   * Routes through Router → Domain Handler → returns AI response.
   *
   * For system commands (/day, /tasks, etc.), we route them through the
   * domain handler as natural language since the handler functions
   * accept the raw message text including the / prefix.
   */
  router.post('/message', async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const {
      normalizedText,
      normalizedTextLower,
      normalizedAttachments,
      clientMessageId,
      idempotencyKey,
    } = normalizeChatMessageRequest(req.body);

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_message', {
      hasAttachments: normalizedAttachments.length > 0,
      textLength: normalizedText.length,
    })) {
      return;
    }

    if (!normalizedText && normalizedAttachments.length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'text or attachments are required' },
      });
      return;
    }

    persistChatLanguagePreference(req, userId);

    // ── TOCTOU-safe cost window ─────────────────────────────────
    // Acquire the per-user cost lock BEFORE the quota check so that
    // concurrent iOS requests from the same user serialize through
    // the check → AI → api_usage INSERT boundary. Without this,
    // two parallel calls could both pass the cap check, both spend,
    // and together exceed the daily budget. See
    // `acquireCostLock` docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    try {
      const requestStartedAt = Date.now();
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      const scopedClientMessageId = normalizeIdempotencyKey(
        clientMessageId ?? idempotencyKey ?? req.header('x-idempotency-key') ?? req.header('x-client-message-id'),
      );
      const userMessageId = buildUserMessageId(scopedClientMessageId, requestStartedAt);

      const idempotentHit = findCompletedAssistantForClientMessage(userId, scopedClientMessageId, tenantId);
      if (idempotentHit) {
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
          return;
        }
        logger.info(
          { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
          'iOS chat idempotent retry returned existing assistant message',
        );
        res.json({
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
        });
        return;
      }

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
          return;
        }
        if (claim.status === 'duplicate') {
          logger.info(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId, lifecycleState: claim.existingLifecycleState },
            'iOS chat idempotent retry found an in-flight message claim',
          );
          res.status(202).json({
            id: `msg-${requestStartedAt}`,
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
          });
          return;
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
      // Check cache for known deterministic commands (saves $0.02-0.05 per hit)
      if (normalizedText && normalizedAttachments.length === 0) {
        const cached = getCachedChatCommandResponse(userId, normalizedTextLower, tenantId);
        if (cached) {
          logger.debug({ cmdLength: normalizedText.length, platform: 'ios', tenantId, userId }, 'Returning cached chat command');
          persistExchange(userId, userMessageId, normalizedText, cached.id, cached, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, cached.domain, normalizedText, cached.text, tenantId);
          res.json(cached);
          return;
        }
      }

      if (normalizedAttachments.length > 0) {
        if (sendChatQuotaExceededIfNeeded(res, userId, 'iOS chat attachment blocked by quota')) return;

        const attachment = normalizedAttachments[0];
        const lang = getUserLanguage?.(userId) || 'pt-BR';
        const result = await buildChatAttachmentResponse({
          attachment,
          normalizedText,
          userId,
          language: lang,
        });
        rememberChatActiveDomain(userId, result.conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, result.userText, result.response.id, result.response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, result.conversationDomain, result.userText, result.response.text, tenantId);
        if (result.degraded) {
          logger.warn(
            { err: result.error, chatRequestId, userId, reason: result.degradedReason, platform: 'ios' },
            'iOS chat attachment degraded',
          );
        }
        res.json(result.response);
        return;
      }

      // ── Token-zero fast-path ─────────────────────────────────────
      // Slash commands like /todo, /day, /overdue are pure data lookups.
      // Handle them directly without ever touching the AI pipeline.
      // This is the difference between an instant ~200ms response and a
      // 30-50 second Claude tool-use loop. See specs/08-TOKEN-ZERO-ARCHITECTURE.md.
      const fastPath = await tryBuildFastPathChatResponse(normalizedText, normalizedTextLower, userId);
      if (fastPath) {
        const { response: fastResponse, conversationDomain } = fastPath;
        // Track domain for conversation continuity even on fast-path.
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        // Cache deterministic responses for the next 60 seconds.
        maybeCacheChatCommandResponse(userId, normalizedTextLower, fastResponse, tenantId);
        persistExchange(userId, userMessageId, normalizedText, fastResponse.id, fastResponse, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, fastResponse.text, tenantId);
        logger.info({ cmdLength: normalizedText.length, platform: 'ios', mode: 'fast-path', tenantId, userId }, 'iOS chat fast-path hit');
        res.json(fastResponse);
        return;
      }

      // ── Natural language plan-creation shortcut ───────────────────
      // Intercept "criar plano" / "create training plan" before the AI
      // pipeline. Returns a token-zero response directing the user to
      // the Training tab's one-shot plan generator ($0.01 vs $0.15).
      const trainingPlanShortcut = tryBuildTrainingPlanShortcutResponse(normalizedText, normalizedTextLower, userId);
      if (trainingPlanShortcut) {
        const { response: planResponse, conversationDomain } = trainingPlanShortcut;
        persistExchange(userId, userMessageId, normalizedText, planResponse.id, planResponse, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, planResponse.text, tenantId);
        res.json(planResponse);
        return;
      }

      // ── Cost cap enforcement ─────────────────────────────────────
      // Per-user daily AI cap. Reject before invoking the AI pipeline if
      // the user is over their plan quota. Token-zero routes above remain
      // available; this only protects paid AI traffic from runaway spend.
      if (sendChatQuotaExceededIfNeeded(res, userId, 'iOS chat: user over daily cost cap')) return;

      const activeContext = resolveChatActiveContext(userId, Date.now(), tenantId);
      const preRoutingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        userId,
        tenantId,
      });

      if (preRoutingDecision.safety.requiresConfirmation && !preRoutingDecision.safety.explicitConfirmation) {
        const lang = getUserLanguage(userId);
        const isPT = lang.startsWith('pt');
        const confirmationResponse = {
          id: `msg-${Date.now()}`,
          text: isPT
            ? 'Antes de executar isso, preciso de confirmação explícita. Confirme a ação exata que quer que eu faça, incluindo o item/plano/evento afetado. Não vou apagar, cancelar, enviar ou limpar nada sem essa confirmação.'
            : 'Before I execute that, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation.',
          domain: preRoutingDecision.primaryDomain || 'secretary',
          routeMethod: 'confirmation-required',
          confidence: preRoutingDecision.confidence,
          buttons: null,
          metadata: {
            type: 'chat_action_confirmation_required',
            involvedSkills: preRoutingDecision.involvedSkills,
            reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
          },
          timestamp: new Date().toISOString(),
        };
        rememberChatActiveDomain(userId, confirmationResponse.domain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, confirmationResponse.id, confirmationResponse, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, confirmationResponse.domain, normalizedText, confirmationResponse.text, tenantId);
        logger.info(
          { chatRequestId, userId, tenantId, orchestration: buildChatSkillRoutingLogContext(preRoutingDecision) },
          'iOS chat destructive action paused for confirmation',
        );
        res.json(confirmationResponse);
        return;
      }

      // Route the message (handles both commands and natural language).
      // April 9 2026: thread userId into routeMessage so the classifier
      // cost row in api_usage attributes this call to the real user
      // instead of user_id=0. Without this, every iOS chat message's
      // classification cost was orphaned under user_id=0 and the
      // per-user cap (isUserOverDailyCap) couldn't see the spend.
      const rawRoute = await routeMessage(normalizedText, activeContext, userId, tenantId);
      const routingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        routedDomain: rawRoute.domain,
        userId,
        tenantId,
      });
      const route = applyChatSkillRoutingDecision(rawRoute, routingDecision);
      logger.info(
        {
          chatRequestId,
          domain: route.domain,
          method: route.method,
          confidence: route.confidence,
          platform: 'ios',
          orchestration: buildChatSkillRoutingLogContext(routingDecision),
          rawDomain: rawRoute.domain,
        },
        'iOS message routed',
      );

      // Track domain for continuity
      rememberChatActiveDomain(userId, route.domain, Date.now(), tenantId);

      // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
      // Same two-layer check as the Telegram handler: explicit disable
      // first, then tier requirement. Fail-open on errors so a bus of
      // signal service issue never locks users out of their data.
      if (sendChatTierRequiredIfNeeded(res, userId, route.domain)) return;

      // Execute domain handler
      const handler = getChatDomainHandler(route.domain);
      if (!handler) {
        res.status(400).json({
          error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
        });
        return;
      }

      const shortcutResult = await tryBuildChatMessageShortcutResponse({
        route,
        normalizedText,
        userId,
        userLanguage: getUserLanguage(userId),
        activeContext,
      });
      if (shortcutResult) {
        const { response, conversationDomain } = shortcutResult;
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        res.json(response);
        return;
      }

      const result = await runWithChatToolAuthorization({
        userId,
        tenantId,
        confirmedDestructiveAction: routingDecision.safety.explicitConfirmation,
        confirmationSource: routingDecision.safety.explicitConfirmation ? 'explicit_current_turn' : 'none',
      }, () => executeChatDomainHandler(handler, route.strippedMessage, userId, tenantId));

      // Extract buttons from the response text if present.
      // Secretary fast-path messages expose deterministic command buttons.
      // Triathlon coach replies can expose real "apply recommendation"
      // actions when the current request produced fresh coach state.
      const lang = getUserLanguage(userId);
      const buttons = buildDefaultButtonsForChatDomain(result.domain || route.domain, lang, userId, requestStartedAt);

      const response = buildChatHandlerResponseEnvelope({ route, result, buttons });

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
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (await sendRetryableChatFailureResponseIfNeeded({ err, res, userId, tenantId, normalizedText, chatRequestId })) return;
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `chat failed (${chatRequestId})`,
        detail: 'Unhandled chat route failure',
        domain: 'secretary',
      });
      logger.error({ err, textLength: normalizedText.length, platform: 'ios', chatRequestId, tenantId, userId }, 'iOS chat/message failed');
      sendInternalError(res, 'Failed to process message');
    } finally {
      // Release the per-user cost lock so the next concurrent request
      // from this user can run its own check → AI → spend cycle.
      releaseCostLock();
    }
  });
}
