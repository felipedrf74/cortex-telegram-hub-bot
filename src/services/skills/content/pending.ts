// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { getActivePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';

export function buildPendingContentSpecContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'content',
    nowIso: input.nowIso,
  });
  if (!pending) return null;
  if (pending.action !== 'content_brief_create' && pending.action !== 'content_script_create') {
    return null;
  }
  const folded = foldCalendarText(input.text);
  const specPattern = /\b(audience|tone|length|hook|short|long|brief|punchy|inspirational|educational|tutorial|comedic|professional|casual|formal|under\s+\d+\s+(?:seconds?|words?|minutes?)|\d+\s+(?:seconds?|words?|minutes?)|pubico|p[uú]blico|tom|gancho|curto|longo|inspirador|educacional|tutorial|coloquial|profissional|abaixo\s+de\s+\d+|menos\s+de\s+\d+)\b/i;
  if (!specPattern.test(folded)) return null;
  const specs = (folded.match(new RegExp(specPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, specs };
  const step = makeStep(input, {
    skill: 'content',
    action: pending.action,
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    [`pending_content_${pending.action}_spec_fill`, `specs:${specs.length}`],
    0.9,
  );
}
