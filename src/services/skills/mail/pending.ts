// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { getActivePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';

export function buildPendingMailDraftContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'mail',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'draft_email') return null;
  const folded = foldCalendarText(input.text);
  const refinementPattern = /\b(shorter|longer|friendlier|formal|casual|punchier|tighter|crisper|softer|include\s+\w+|mention\s+\w+|add\s+\w+|remove\s+\w+|bullet\s+points|line\s+breaks|mais\s+(?:curto|longo|formal|amig[aá]vel|direto)|m[aá]s\s+(?:cort[oa]|larg[oa]|formal|amistos[oa]|direct[oa]|breve|simple)|incluir?\s+\w+|incluy[ae]\s+\w+|menciona[r]?\s+\w+|adiciona[r]?\s+\w+|a[nñ]ade\s+\w+|quita\s+\w+|elimina\s+\w+)\b/i;
  if (!refinementPattern.test(folded)) return null;
  const refinements = (folded.match(new RegExp(refinementPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, refinements };
  const step = makeStep(input, {
    skill: 'mail',
    action: 'draft_email',
    risk: 'safe_write',
    provider: 'gmail',
    args: collected,
    requiredArgsPresent: true,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_mail_draft_refinement', `refinements:${refinements.length}`],
    0.9,
  );
}
