// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getActivePendingChatAction,
  makeSlotProvenance,
  type ChatSlotProvenance,
} from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import {
  extractTrainingPlanSlots,
  extractWeeklyVolumeKm,
  makeTrainingPlanStep,
  missingTrainingPlanSlots,
} from './helpers';

export function buildPendingSlotContinuationPlan(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'training',
    nowIso: input.nowIso,
  });
  const weeklyVolume = extractWeeklyVolumeKm(input.text);

  if (!pending) {
    if (weeklyVolume == null) return null;
    return helpers.buildNeedsInputPlan(input, {
      skill: 'training',
      action: 'training_plan_create',
      question: input.locale?.startsWith('pt')
        ? 'Posso usar esse volume semanal num plano de treino. Estás a criar ou ajustar um plano?'
        : 'I can use that weekly volume for a training plan. Are we creating or adjusting a plan?',
      args: { weeklyVolumeKm: weeklyVolume },
      routingSignals: ['standalone_training_slot_without_pending_action'],
    });
  }

  const collected = { ...pending.collectedSlots };
  const provenance: Record<string, ChatSlotProvenance> = {};
  if (weeklyVolume != null && pending.missingSlots.includes('weeklyVolumeKm')) {
    collected.weeklyVolumeKm = weeklyVolume;
    provenance.weeklyVolumeKm = makeSlotProvenance({
      slot: 'weeklyVolumeKm',
      value: weeklyVolume,
      rawText: input.text,
      turnId: input.messageId,
      sourceType: 'user_message',
      normalizer: 'training_weekly_volume_v1',
      confidence: 0.96,
    });
  }

  const extracted = extractTrainingPlanSlots(input);
  for (const [slot, value] of Object.entries(extracted.slots)) {
    if (value == null || value === '') continue;
    if (!pending.missingSlots.includes(slot) && collected[slot] != null) continue;
    collected[slot] = value;
    provenance[slot] = extracted.provenance[slot];
  }

  if (Object.keys(provenance).length === 0) {
    return helpers.buildNeedsInputPlan(input, {
      skill: 'training',
      action: 'training_plan_create',
      question: helpers.buildTargetedClarificationQuestion(input, [
        makeTrainingPlanStep(input, pending.collectedSlots, pending.missingSlots, {}),
      ]),
      args: pending.collectedSlots,
      routingSignals: ['pending_training_action_unmatched_answer'],
    });
  }

  const missing = missingTrainingPlanSlots(collected);
  const step = makeTrainingPlanStep(input, collected, missing, provenance);
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_training_plan_slot_fill', ...Object.keys(provenance).map((slot) => `slot:${slot}`)],
    missing.length === 0 ? 0.94 : 0.88,
  );
}
