// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M19: deterministic fallback after both action-planner passes decline an
 * actionable cross-skill request while AI_CROSS_SKILL_EXECUTION is enabled.
 *
 * This stage is deliberately after the Decision Center / destructive hold /
 * routing-clarify terminals: exact confirmations and safety questions retain
 * ownership. It is before the V2 local-answer and legacy general-answer
 * owners, so retiring cross_skill_bridge never silently drops a second action.
 * No model or tool is invoked here and the response explicitly says that no
 * action ran.
 */

import { logger } from '../../../../utils/logger';
import { buildChatResponseSufficiencyMetadata } from '../../../../services/chat-response-sufficiency';
import { buildChatSkillRoutingLogContext } from '../../../../services/chat-skill-orchestrator';
import { isCrossSkillExecutionEnabled } from '../../../../services/chat/planner/cross-skill-ownership';
import { shouldRunActionPlannerBeforeReadOnlyFastPaths } from '../../../../services/chat/planner/preflight-gates';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import { rememberChatActiveDomain } from '../../chat-message-context';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from '../../chat-persistence';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { newAssistantMessageId } from '../support';
import { routedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';

const NON_ACTION_OWNER_SKILLS = new Set(['shared_context', 'tools']);

function isActionableCrossSkillPlannerDecline(ctx: ChatTurnCtx): boolean {
  if (!isCrossSkillExecutionEnabled()) return false;
  const routed = routedChatTurnCtx(ctx);
  const decision = routed.preRoutingDecision;
  if (!decision?.intentKinds.includes('cross_skill')) return false;
  const owners = decision.involvedSkills.filter((skill) => !NON_ACTION_OWNER_SKILLS.has(skill));
  if (new Set(owners).size < 2) return false;

  // The shared preflight predicate is the planner's own write/read boundary.
  // Intent kinds cover schedule/plan verbs that intentionally sit outside
  // that predicate. Pure cross-skill comparisons continue to their safe
  // primary read owner; only executable work is stopped here.
  return shouldRunActionPlannerBeforeReadOnlyFastPaths(routed.normalizedText)
    || decision.intentKinds.some((kind) => (
      kind === 'action'
      || kind === 'scheduling'
      || kind === 'plan_creation'
      || kind === 'cancellation'
      || kind === 'edit_update'
    ));
}

export function buildCrossSkillPlanDeclinedText(locale: string | null | undefined): string {
  const normalized = String(locale ?? '').trim().toLowerCase();
  if (normalized.startsWith('pt')) {
    return 'Não consegui transformar com segurança todas as partes deste pedido num único plano executável, por isso não executei nenhuma das ações. Envia cada ação como um passo separado, começando pela primeira.';
  }
  if (normalized.startsWith('es')) {
    return 'No pude convertir con seguridad todas las partes de esta solicitud en un único plan ejecutable, así que no ejecuté ninguna de las acciones. Envía cada acción como un paso separado, empezando por la primera.';
  }
  return 'I could not safely turn every part of this request into one executable plan, so I did not run any action. Please send each action as a separate step, starting with the one you want first.';
}

export const crossSkillPlanDeclinedStage: ChatStage = {
  name: 'cross_skill_plan_declined',
  traceStages: ['cross_skill_plan_declined'],
  canHandle: isActionableCrossSkillPlannerDecline,
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      res, userId, tenantId, normalizedText, scopedClientMessageId,
      userMessageId, requestStartedAt, chatRequestId, latency,
      chatCoreV2RouteLocale, recordLegacyFallbackSample, preRoutingDecision,
    } = routedChatTurnCtx(ctx);
    const domain = preRoutingDecision.primaryDomain ?? 'secretary';
    const sufficiency = buildChatResponseSufficiencyMetadata({
      actionStatus: 'needs_clarification',
      needsClarification: true,
      unresolvedBlockers: ['cross_skill_plan_requires_separate_steps'],
    });

    recordChatStage(chatRequestId, 'cross_skill_plan_declined');
    const response = finalizeChatMessageResponse({
      id: newAssistantMessageId(),
      text: buildCrossSkillPlanDeclinedText(chatCoreV2RouteLocale),
      domain,
      routeMethod: 'cross-skill-plan-declined',
      confidence: preRoutingDecision.confidence,
      buttons: null,
      metadata: {
        type: 'chat_cross_skill_plan_declined',
        actionStatus: sufficiency.actionStatus,
        involvedSkills: preRoutingDecision.involvedSkills,
        reasonCodes: [...new Set([
          ...preRoutingDecision.reasonCodes,
          'cross_skill_plan_declined',
        ])],
        executedActions: 0,
        legacyBridgeRetired: true,
        unresolvedBlockers: sufficiency.unresolvedBlockers,
        responseSufficiency: sufficiency,
      },
      timestamp: new Date(requestStartedAt).toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      fallbackDomain: domain,
      fallbackRouteMethod: 'cross-skill-plan-declined',
      fallbackConfidence: preRoutingDecision.confidence,
      actionability: 'clarify',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      locale: chatCoreV2RouteLocale,
      fallback: {
        fallbackType: 'degraded_response',
        fallbackReason: 'cross_skill_plan_declined',
        retryable: false,
        userActionRequired: true,
        operatorActionRequired: false,
      },
      stageFamily: 'cross_skill_plan_declined',
      requestStartedAt,
    });

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
        orchestration: buildChatSkillRoutingLogContext(preRoutingDecision),
      },
      'iOS chat planner-declined cross-skill turn returned deterministic clarification',
    );
    recordLegacyFallbackSample(false, {
      domain: response.domain,
      routeOwner: 'cross_skill_plan_declined',
      routeMethod: response.routeMethod,
    });
    res.json(response);
    return { kind: 'respond' };
  },
};
