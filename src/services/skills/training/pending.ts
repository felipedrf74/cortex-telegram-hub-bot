// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getActivePendingChatAction,
  type ChatSlotProvenance,
} from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import {
  extractTrainingPlanSlots,
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
  // F26 canary: canonical creation fields only continue an explicitly
  // pending Training draft. A bare frequency answer must not invent a plan.
  if (!pending) return null;

  const collected = { ...pending.collectedSlots };
  const provenance: Record<string, ChatSlotProvenance> = {};

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
