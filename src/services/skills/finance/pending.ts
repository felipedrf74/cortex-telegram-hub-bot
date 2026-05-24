// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { getActivePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';

export function buildPendingFinanceCategorizeContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'finance',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'finance_categorize_receipt') return null;
  const folded = foldCalendarText(input.text);
  const categoryPattern = /\b(office\s+supplies?|travel|meals?\s*(?:and\s+entertainment)?|transportation|software|hardware|marketing|advertising|professional\s+services?|utilities|rent|insurance|equipment|subscriptions?|training|education|material(?:\s+de\s+escrit[oó]rio)?|despesas?\s+de\s+(?:viagem|escrit[oó]rio|transporte|marketing)|alimenta[cç][aã]o|transporte|softwares?|publicidade|servi[cç]os?\s+profissionais|materiais?|formaca[ao]|treinamento)\b/i;
  const match = folded.match(categoryPattern);
  if (!match) return null;
  const category = match[0].toLowerCase().trim();
  const collected = { ...pending.collectedSlots, category };
  const step = makeStep(input, {
    skill: 'finance',
    action: 'finance_categorize_receipt',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: Boolean((collected as Record<string, unknown>).receiptId),
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_finance_categorize_receipt_slot_fill', `category:${category}`],
    0.9,
  );
}
