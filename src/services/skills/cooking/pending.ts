// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { getActivePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';

export function buildPendingCookingMealPlanContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'cooking',
    nowIso: input.nowIso,
  });
  if (!pending) return null;
  const folded = foldCalendarText(input.text);
  const constraintPattern = /\b(vegetarian|vegan|high[\s-]?protein|low[\s-]?carb|keto|paleo|mediterranean|mediterr[aá]nea?|whole30|gluten[\s-]?free|dairy[\s-]?free|nut[\s-]?free|no\s+(?:fish|pork|beef|red\s+meat|dairy|gluten|sugar|carbs?)|vegetarian[oa]|vegan[oa]|rico\s+em\s+prote[ií]na|alt[oa]\s+en\s+prote[ií]na|baixo\s+em\s+carbo|baj[oa]\s+en\s+carbo|sem\s+(?:peixe|carne|gluten|glúten|laticínios?|lactose|açúcar)|sin\s+(?:pescado|carne|gluten|gl[uú]ten|l[aá]cteos?|lactosa|az[uú]car))\b/i;
  if (!constraintPattern.test(folded)) return null;
  const constraints = (folded.match(new RegExp(constraintPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, constraints };
  const step = makeStep(input, {
    skill: 'cooking',
    action: 'cooking_meal_plan',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_cooking_meal_plan_continuation', `constraints:${constraints.length}`],
    0.9,
  );
}
