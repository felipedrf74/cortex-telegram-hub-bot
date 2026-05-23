// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getActivePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';

export function buildPendingDecisionChooseContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'decision_center',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'decision_choose') return null;
  const choiceMatch =
    input.text.match(/\b(?:option|op[cç][aã]o|opci[oó]n)\s+([a-zA-Z0-9]+)/i)
    || input.text.match(/\b(?:vou\s+de|go\s+with|i'?ll\s+go\s+with|let'?s\s+go\s+with|pick|choose|escolho|elijo|voy\s+con|me\s+quedo\s+con)\s+(?:option\s+|opci[oó]n\s+|la\s+|el\s+)?([a-zA-Z0-9]+)/i)
    || input.text.match(/^\s*([A-D]|\d)\s*[.!]?\s*$/i);
  if (!choiceMatch?.[1]) return null;
  const choice = choiceMatch[1].toUpperCase();
  const collected = { ...pending.collectedSlots, choice };
  const step = makeStep(input, {
    skill: 'decision_center',
    action: 'decision_choose',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_decision_choose_slot_fill', `choice:${choice}`],
    0.92,
  );
}
