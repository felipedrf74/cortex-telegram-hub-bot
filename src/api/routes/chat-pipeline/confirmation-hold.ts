// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 increment (c): ONE shared destructive-confirmation-hold builder for the
 * two formerly copy-pasted planner `needs_confirmation` blocks (deterministic
 * pass + model pass in chat-message-routes.ts).
 *
 * The two blocks were diffed FIRST (whitespace-normalized): the ONLY textual
 * difference was an unused local alias in the deterministic block
 * (`const lang = chatCoreV2RouteLocale; const isPT = lang.startsWith('pt')`
 * vs `const isPT = chatCoreV2RouteLocale.startsWith('pt')`). There are NO
 * behavioral differences, so this builder takes no variant parameters —
 * every input below is turn state both blocks already shared.
 */

import { createDecisionIntent } from '../../../services/decision-center';
import { trackPendingChatConfirmation } from '../../../services/chat-pending-confirmations';
import {
  buildConfirmedDestructiveTargetsForPlanSteps,
  type ChatPlanStep,
} from '../../../services/chat';
import {
  attachPendingConfirmationContract,
  intentClassForAction,
  mapActionPlannerSkillToNexusSkill,
} from './support';

/**
 * Stages the pending confirmation + Decision Center intent for a planner
 * result with status 'needs_confirmation' and attaches the confirmation
 * contract to the response metadata. Byte-identical to both original blocks.
 */
export async function attachPlannerNeedsConfirmationHold(input: {
  response: { text?: string; metadata?: Record<string, any> };
  planSteps: ReadonlyArray<ChatPlanStep>;
  normalizedText: string;
  userId: number;
  tenantId: number;
  userMessageId: string;
  chatCoreV2RouteLocale: string;
}): Promise<void> {
  const { response, normalizedText, userId, tenantId, userMessageId } = input;
  const isPT = input.chatCoreV2RouteLocale.startsWith('pt');
  const involvedSkills = [...new Set(input.planSteps.map((step) => mapActionPlannerSkillToNexusSkill(step.skill)))];
  const reasonCodes = [...new Set(input.planSteps.map((step) => `${step.risk}_requires_confirmation`))];
  const intentClass = intentClassForAction(input.planSteps[0]?.action, involvedSkills);
  const summary = {
    text: response.text || normalizedText,
    steps: input.planSteps.map((step) => ({
      skill: step.skill,
      action: step.action,
      risk: step.risk,
      args: step.args,
    })),
  };
  const pendingConfirmation = trackPendingChatConfirmation({
    userId,
    tenantId,
    actionSummary: response.text || normalizedText,
    involvedSkills,
    reasonCodes,
    intentClass,
    summary,
    confirmedTargets: buildConfirmedDestructiveTargetsForPlanSteps(input.planSteps),
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
    title: isPT ? 'Nexus precisa de confirmação' : 'Nexus needs confirmation',
    body: pendingConfirmation.actionSummary,
    sensitiveBody: pendingConfirmation.actionSummary,
    actionButtons: [
      { id: 'option_a', label: isPT ? 'Confirmar' : 'Confirm', style: 'primary' },
      { id: 'option_b', label: isPT ? 'Não executar' : 'Do not run', style: 'secondary' },
      { id: 'open_detail', label: isPT ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
    ],
    deeplink: `nexus://notifications/${pendingConfirmation.id}`,
    expiresAt: pendingConfirmation.expiresAt,
    dedupeKey: `chat:action-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
    idempotencyKey: `chat-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
    channel: 'chat',
    requiresUserAction: true,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'standard',
  });
  attachPendingConfirmationContract({
    response,
    pendingConfirmation,
    intentClass,
    summary,
    decisionId: decisionResult.item?.decisionId ?? null,
  });
}
