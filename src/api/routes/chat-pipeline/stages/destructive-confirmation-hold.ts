// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: destructive-action confirmation hold (pre-routing safety pause
 * when the orchestrator requires confirmation and none was given).
 * Verbatim move.
 */

import { logger } from '../../../../utils/logger';
import { createDecisionIntent } from '../../../../services/decision-center';
import { trackPendingChatConfirmation } from '../../../../services/chat-pending-confirmations';
import { buildChatResponseSufficiencyMetadata } from '../../../../services/chat-response-sufficiency';
import { buildChatSkillRoutingLogContext } from '../../../../services/chat-skill-orchestrator';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import {
  attachPendingConfirmationContract,
  confirmationVariantForIntent,
  destructiveConfirmationCopy,
  intentClassForAction,
  newAssistantMessageId,
} from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

export const destructiveConfirmationHoldStage: ChatStage = {
  name: 'destructive_confirmation_hold',
  traceStages: ['destructive_confirmation_hold'],
  canHandle(ctx: ChatTurnCtx): boolean {
    const r = routedChatTurnCtx(ctx);
    return Boolean(
      r.preRoutingDecision.safety.requiresConfirmation
      && !r.preRoutingDecision.safety.explicitConfirmation,
    );
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, chatRequestId, latency, chatCoreV2RouteLocale,
      recordLegacyFallbackSample, preRoutingDecision,
    } = routedChatTurnCtx(ctx);

    recordChatStage(chatRequestId, 'destructive_confirmation_hold');
    const intentClass = intentClassForAction(undefined, preRoutingDecision.involvedSkills);
    const copy = destructiveConfirmationCopy(chatCoreV2RouteLocale);
    const summary = {
      text: normalizedText,
      involvedSkills: preRoutingDecision.involvedSkills,
      reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
    };
    const pendingConfirmation = trackPendingChatConfirmation({
      userId,
      tenantId,
      actionSummary: normalizedText,
      involvedSkills: preRoutingDecision.involvedSkills,
      reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
      intentClass,
      summary,
      // Pre-routing only knows free text, not a provider-backed target id.
      // Preserve the hold but stage zero grants so acceptance cannot become
      // an untyped destructive authorization.
      confirmedTargets: [],
      sourceMessageId: userMessageId,
    });
    const decisionResult = await createDecisionIntent({
      userId,
      tenantId,
      sourceSkill: 'chat',
      type: 'decision_required',
      priority: 'active',
      relatedEntityId: pendingConfirmation.id,
      relatedEntityType: 'chat_confirmation',
      title: copy.title,
      body: pendingConfirmation.actionSummary,
      sensitiveBody: pendingConfirmation.actionSummary,
      actionButtons: [
        { id: 'option_a', label: copy.confirmLabel, style: 'primary' },
        { id: 'option_b', label: copy.declineLabel, style: 'secondary' },
        { id: 'open_detail', label: copy.openDecisionLabel, style: 'secondary' },
      ],
      deeplink: `nexus://notifications/${pendingConfirmation.id}`,
      expiresAt: pendingConfirmation.expiresAt,
      dedupeKey: `chat:confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
      idempotencyKey: `chat-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
      channel: 'chat',
      requiresUserAction: true,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'standard',
    });
    const sufficiency = buildChatResponseSufficiencyMetadata({
      actionStatus: 'needs_confirmation',
      requiresConfirmation: true,
      unresolvedBlockers: ['target_identity_required'],
    });
    const confirmationResponse = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text: copy.text,
      domain: preRoutingDecision.primaryDomain || 'secretary',
      routeMethod: 'confirmation-required',
      confidence: preRoutingDecision.confidence,
      buttons: null,
      metadata: {
        type: 'chat_action_confirmation_required',
        actionStatus: sufficiency.actionStatus,
        involvedSkills: preRoutingDecision.involvedSkills,
        reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
        unresolvedBlockers: sufficiency.unresolvedBlockers,
        responseSufficiency: sufficiency,
        actionConfirmation: {
          title: copy.title,
          message: pendingConfirmation.actionSummary,
          destructive: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'destructive',
          variant: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes),
          requiresStrongConfirm: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'financial',
        },
      },
      timestamp: new Date().toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier2_verified_write',
      actionability: 'preview',
      verificationStatus: 'pending',
      stageFamily: 'destructive_confirmation_hold',
    });
    attachPendingConfirmationContract({
      response: confirmationResponse,
      pendingConfirmation,
      intentClass,
      summary,
      decisionId: decisionResult.item?.decisionId ?? null,
    });
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
    recordLegacyFallbackSample(true, {
      domain: confirmationResponse.domain,
      routeOwner: 'destructive_confirmation_hold',
      routeMethod: confirmationResponse.routeMethod,
    });
    res.json(confirmationResponse);
    return { kind: 'respond' };
  },
};
