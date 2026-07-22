// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: ChatCoreV2 Action Gateway — natural-language write intents are
 * a firewall, not a legacy best-effort model/tool path: resolve to a command
 * preview, ask for clarification, or stop. Explicit button/slash paths stay
 * fast. Verbatim move of the gateway checkpoint family (preview + stop).
 */

import { getUserTimezoneById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import { runChatCoreV2ActionGateway } from '../../../../services/chat-core-v2';
import { createDecisionIntent } from '../../../../services/decision-center';
import { trackPendingChatConfirmation } from '../../../../services/chat-pending-confirmations';
import { parseContentScriptShortcut } from '../../chat-shortcut-parsers';
import {
  deterministicReadGroundingFact,
  finalizeChatMessageResponse,
} from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { buildChatCoreV2CommandPreviewShortcutResponse } from '../../chat-core-v2-command-preview-response';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import {
  actionGatewayActionability,
  actionGatewayStopText,
  attachPendingConfirmationContract,
  buildChatCoreV2GuardOnlyConfirmationLabels,
  newAssistantMessageId,
  shouldCreateChatCoreV2GuardOnlyConfirmation,
} from '../support';
import {
  recordChatCoreV2GatewayPreviewEvidence,
  recordChatCoreV2GatewayStopEvidence,
} from '../write-evidence';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const actionGatewayStage: ChatStage = {
  name: 'action_gateway',
  traceStages: ['action_gateway_preview', 'action_gateway_stop'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(
      ctx.normalizedText
      && ctx.normalizedAttachments.length === 0
      && !parseContentScriptShortcut(ctx.normalizedText),
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample,
    } = preparedChatTurnCtx(ctx);

    const gatewayResult = runChatCoreV2ActionGateway({
      requestId: chatRequestId,
      normalizedText,
      userId,
      tenantId,
      conversationId: scopedClientMessageId ?? chatRequestId,
      messageId: userMessageId,
      locale: chatCoreV2RouteLocale,
      timezone: getUserTimezoneById(userId),
      now: new Date(requestStartedAt),
    });
    if (gatewayResult.kind === 'resolved_preview' || gatewayResult.kind === 'resolved_execute') {
      recordChatStage(chatRequestId, 'action_gateway_preview');
      const built = buildChatCoreV2CommandPreviewShortcutResponse({
        result: gatewayResult.preview,
        requestStartedAt,
      });
      const response = finalizeChatMessageResponse(built.response, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier2_verified_write',
        fallbackDomain: built.conversationDomain,
        fallbackRouteMethod: built.response.routeMethod,
        actionability: 'preview',
        verificationStatus: 'pending',
        compositionMode: 'templated',
        groundingFacts: [deterministicReadGroundingFact('chat_core_v2.action_gateway')],
        stageFamily: 'action_gateway_preview',
      });
      rememberChatActiveDomain(userId, built.conversationDomain, Date.now(), tenantId);
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, built.conversationDomain, normalizedText, response.text, tenantId);
      recordChatCoreV2GatewayPreviewEvidence({
        tenantId,
        userId,
        requestId: chatRequestId,
        result: gatewayResult,
      });
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          routeMethod: response.routeMethod,
          capabilityId: built.logContext.capabilityId,
          commandId: built.logContext.commandId,
          gatewayOutcome: gatewayResult.kind,
        },
        'iOS chat ChatCoreV2 action gateway handled write intent',
      );
      recordLegacyFallbackSample(false, {
        domain: built.conversationDomain,
        routeOwner: 'chat_core_v2_action_gateway',
        routeMethod: response.routeMethod,
      });
      res.status(202).json(response);
      return { kind: 'respond' };
    }
    if (
      gatewayResult.kind === 'needs_clarification'
      || gatewayResult.kind === 'unsupported_write'
      || gatewayResult.kind === 'blocked_legacy_fallback'
    ) {
      recordChatStage(chatRequestId, 'action_gateway_stop');
      const guardOnlyConfirmation = shouldCreateChatCoreV2GuardOnlyConfirmation(gatewayResult);
      const stopText = actionGatewayStopText(gatewayResult, chatCoreV2RouteLocale);
      const guardLabels = guardOnlyConfirmation
        ? buildChatCoreV2GuardOnlyConfirmationLabels(chatCoreV2RouteLocale)
        : null;
      const pendingGuardConfirmation = guardOnlyConfirmation
        ? trackPendingChatConfirmation({
          userId,
          tenantId,
          actionSummary: stopText,
          involvedSkills: ['secretary'],
          reasonCodes: [
            ...new Set([
              ...gatewayResult.telemetry.reasonCodes,
              'destructive_action',
              'chat_core_v2_guard_only',
            ]),
          ],
          intentClass: 'chat_core_v2_destructive_hold',
          summary: {
            mode: 'chat_core_v2_guard_only',
            gatewayOutcome: gatewayResult.kind,
            detectedIntent: gatewayResult.telemetry.detectedIntent,
            actionType: gatewayResult.telemetry.actionType ?? null,
            reasonCodes: gatewayResult.telemetry.reasonCodes,
          },
          // This guard-only card never executes work. An explicit empty set
          // prevents it from being reused as an untyped destructive grant.
          confirmedTargets: [],
          sourceMessageId: userMessageId,
        })
        : null;
      const guardDecisionResult = pendingGuardConfirmation
        ? await createDecisionIntent({
          userId,
          tenantId,
          sourceSkill: 'chat',
          type: 'decision_required',
          priority: 'active',
          relatedEntityId: pendingGuardConfirmation.id,
          relatedEntityType: 'chat_confirmation',
          title: guardLabels?.title ?? 'Confirmation needed',
          body: pendingGuardConfirmation.actionSummary,
          sensitiveBody: pendingGuardConfirmation.actionSummary,
          actionButtons: [
            { id: 'option_a', label: guardLabels?.actionLabel ?? 'Keep paused', style: 'secondary' },
            { id: 'option_b', label: guardLabels?.cancelLabel ?? 'Cancel', style: 'secondary' },
            { id: 'open_detail', label: chatCoreV2RouteLocale.startsWith('pt') ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
          ],
          deeplink: `nexus://notifications/${pendingGuardConfirmation.id}`,
          expiresAt: pendingGuardConfirmation.expiresAt,
          dedupeKey: `chat:chat-core-v2-guard:${tenantId}:${userId}:${pendingGuardConfirmation.id}`,
          requiresUserAction: true,
          deliveryPolicy: 'in_app_only',
          privacyPolicy: 'standard',
        })
        : null;
      const response = finalizeChatMessageResponse({
        id: newAssistantMessageId(),
        text: stopText,
        domain: 'secretary',
        routeMethod: 'chat-core-v2-action-gateway',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_write_intent_guard',
          responseKind: gatewayResult.kind === 'needs_clarification' || gatewayResult.kind === 'blocked_legacy_fallback'
            ? guardOnlyConfirmation ? 'action_preview' : 'clarification'
            : 'unsupported',
          gatewayOutcome: gatewayResult.kind,
          reason: gatewayResult.kind === 'needs_clarification' ? 'needs_clarification' : gatewayResult.reason,
          ...(guardLabels ? {
            actionConfirmation: {
              title: guardLabels.title,
              message: stopText,
              actionLabel: guardLabels.actionLabel,
              cancelLabel: guardLabels.cancelLabel,
            },
          } : {}),
          chatCoreV2: {
            actionGateway: {
              telemetry: gatewayResult.telemetry,
              candidates: gatewayResult.kind === 'needs_clarification' ? gatewayResult.candidates ?? [] : [],
              humanReview: gatewayResult.kind === 'unsupported_write' ? gatewayResult.humanReview ?? null : null,
              guardOnlyConfirmation,
            },
          },
        },
        timestamp: new Date(requestStartedAt).toISOString(),
        responseCards: guardOnlyConfirmation ? [{
          kind: 'confirmationCard',
          title: guardLabels?.title ?? 'Confirmation needed',
          message: stopText,
          destructive: true,
          confirmAction: null,
        }] : undefined,
      }, {
        normalizedText,
        userId,
        tenantId,
        chatRequestId,
        tracker: latency,
        latencyTier: 'tier1_fast_read',
        fallbackDomain: 'secretary',
        fallbackRouteMethod: 'chat-core-v2-action-gateway',
        actionability: guardOnlyConfirmation ? 'preview' : actionGatewayActionability(gatewayResult),
        verificationStatus: guardOnlyConfirmation ? 'pending' : gatewayResult.kind === 'unsupported_write' ? 'blocked' : 'pending',
        compositionMode: 'templated',
        groundingFacts: [deterministicReadGroundingFact('chat_core_v2.action_gateway')],
        stageFamily: 'action_gateway_stop',
      });
      if (pendingGuardConfirmation) {
        attachPendingConfirmationContract({
          response,
          pendingConfirmation: pendingGuardConfirmation,
          intentClass: 'chat_core_v2_destructive_hold',
          summary: pendingGuardConfirmation.summary ?? {},
          decisionId: guardDecisionResult?.item?.decisionId ?? null,
        });
      }
      rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
      recordChatCoreV2GatewayStopEvidence({
        tenantId,
        userId,
        requestId: chatRequestId,
        result: gatewayResult,
      });
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          routeMethod: response.routeMethod,
          gatewayOutcome: gatewayResult.kind,
          reason: gatewayResult.kind === 'needs_clarification' ? 'needs_clarification' : gatewayResult.reason,
        },
        'iOS chat ChatCoreV2 action gateway stopped legacy write fallthrough',
      );
      recordLegacyFallbackSample(false, {
        domain: response.domain,
        routeOwner: 'chat_core_v2_action_gateway',
        routeMethod: response.routeMethod,
      });
      res.status(202).json(response);
      return { kind: 'respond' };
    }
    return { kind: 'continue' };
  },
};
