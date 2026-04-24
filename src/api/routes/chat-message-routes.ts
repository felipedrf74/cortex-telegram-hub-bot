// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage, keywordMatch } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import { listChatMessages } from '../../services/chat-history-store';
import { getUserLanguage, getUserById, getUserByTelegramId } from '../../services/user-service';
import { acquireCostLock } from '../../services/cost-guardrail';
import { checkTierAccess } from '../../services/skill-tiers';
import { buildAITemporarilyBusyResponse } from '../../domains/ai-unavailable';
import { getCurrentRequestId } from '../../utils/request-context';
import {
  buildDefaultButtonsForChatDomain,
  getChatDomainHandler,
  getLastChatActiveDomain,
  rememberChatActiveDomain,
  resolveChatActiveContext,
} from './chat-message-context';
import {
  buildChatHandlerResponseEnvelope,
  executeChatDomainHandler,
} from './chat-message-execution';
import { sendInternalError } from '../response-helpers';
import {
  isRetryableAIProviderError,
} from './chat-content-refinement';
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

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export { clearChatActiveDomain } from './chat-message-context';

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
    const { userId } = req as AuthenticatedRequest;
    const {
      normalizedText,
      normalizedTextLower,
      normalizedAttachments,
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
      const isNewUserFlow = listChatMessages(userId, 1).messages.length === 0;
      logger.info(
        {
          chatRequestId,
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
        const cached = getCachedChatCommandResponse(userId, normalizedTextLower);
        if (cached) {
          logger.debug({ cmd: normalizedText, platform: 'ios' }, 'Returning cached chat command');
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
        const userMessageId = `msg-user-${Date.now()}`;
        rememberChatActiveDomain(userId, result.conversationDomain);
        persistExchange(userId, userMessageId, result.userText, result.response.id, result.response);
        syncConversationStateForShortcut(userId, result.conversationDomain, result.userText, result.response.text);
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
        rememberChatActiveDomain(userId, conversationDomain);
        // Cache deterministic responses for the next 60 seconds.
        maybeCacheChatCommandResponse(userId, normalizedTextLower, fastResponse);
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, fastResponse.id, fastResponse);
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, fastResponse.text);
        logger.info({ cmd: normalizedText, platform: 'ios', mode: 'fast-path' }, 'iOS chat fast-path hit');
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
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, planResponse.id, planResponse);
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, planResponse.text);
        res.json(planResponse);
        return;
      }

      // ── Cost cap enforcement ─────────────────────────────────────
      // Per-user daily AI cap. Reject before invoking the AI pipeline if
      // the user is over their plan quota. Token-zero routes above remain
      // available; this only protects paid AI traffic from runaway spend.
      if (sendChatQuotaExceededIfNeeded(res, userId, 'iOS chat: user over daily cost cap')) return;

      const activeContext = resolveChatActiveContext(userId);

      // Route the message (handles both commands and natural language).
      // April 9 2026: thread userId into routeMessage so the classifier
      // cost row in api_usage attributes this call to the real user
      // instead of user_id=0. Without this, every iOS chat message's
      // classification cost was orphaned under user_id=0 and the
      // per-user cap (isUserOverDailyCap) couldn't see the spend.
      const route = await routeMessage(normalizedText, activeContext, userId);
      logger.info(
        {
          chatRequestId,
          domain: route.domain,
          method: route.method,
          confidence: route.confidence,
          platform: 'ios',
        },
        'iOS message routed',
      );

      // Track domain for continuity
      rememberChatActiveDomain(userId, route.domain);

      // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
      // Same two-layer check as the Telegram handler: explicit disable
      // first, then tier requirement. Fail-open on errors so a bus of
      // signal service issue never locks users out of their data.
      try {
        const user = getUserById(userId) || getUserByTelegramId(userId);
        if (user) {
          const tierResult = checkTierAccess({ id: user.id, tier: user.tier }, route.domain);
          if (!tierResult.allowed) {
            logger.info(
              { userId, domain: route.domain, userTier: tierResult.userTier, requiredTier: tierResult.requiredTier, reason: tierResult.reason },
              'iOS tier gate blocked message',
            );
            res.status(403).json({
              error: {
                code: 'TIER_REQUIRED',
                message: `This feature requires the ${tierResult.requiredTier} tier. Your current tier: ${tierResult.userTier}.`,
                details: {
                  domain: route.domain,
                  userTier: tierResult.userTier,
                  requiredTier: tierResult.requiredTier,
                },
              },
            });
            return;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'iOS tier gate check failed — falling through (fail-open)');
      }

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
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text);
        res.json(response);
        return;
      }

      const result = await executeChatDomainHandler(handler, route.strippedMessage, userId);

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
            textPreview: response.text.slice(0, 160),
          },
          'iOS new-user chat response envelope',
        );
      }

      // Cache the response if it was a deterministic command
      maybeCacheChatCommandResponse(userId, normalizedTextLower, response);

      persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
      logger.info(
        {
          chatRequestId,
          userId,
          domain: response.domain,
          durationMs: Date.now() - requestStartedAt,
        },
        'iOS chat request completed',
      );
      res.json(response);
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (isRetryableAIProviderError(err)) {
        const degradedDomain = keywordMatch(normalizedText) || getLastChatActiveDomain(userId) || 'secretary';
        const degraded = await buildAITemporarilyBusyResponse(degradedDomain, userId);
        const timestamp = new Date().toISOString();
        const assistantMessageId = `msg-${Date.now()}`;
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
          metadata: { degraded: true, retryable: true },
          timestamp,
        };
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, assistantMessageId, response);
        syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text);
        res.json(response);
        return;
      }
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `chat failed (${chatRequestId})`,
        detail: 'Unhandled chat route failure',
        domain: 'secretary',
      });
      logger.error({ err, text: normalizedText, platform: 'ios', chatRequestId, userId }, 'iOS chat/message failed');
      sendInternalError(res, 'Failed to process message');
    } finally {
      // Release the per-user cost lock so the next concurrent request
      // from this user can run its own check → AI → spend cycle.
      releaseCostLock();
    }
  });
}
