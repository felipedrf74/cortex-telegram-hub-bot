// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the finance skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import type { DateTime } from 'luxon';

import { makeStep, type StepKeyInputs } from '../step-builder';
import { extractTopic } from '../text-extractors';
import type { ChatPlanStep } from '../../chat/types';

export function parseFinanceActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
  now: DateTime,
): ChatPlanStep | null {
  // Phase 3 batch 16: "conta" alone is too broad (matches "conta do Google",
  // "minha conta", etc. across multiple skills). Restrict to financial
  // contexts: "conta bancária", "conta corrente", "conta do (cartão|banco)",
  // or "conta" adjacent to a financial verb/object. The `bill` keyword
  // remains because English usage is unambiguous.
  // Phase 9 batch 48: Spanish gate keywords — `gasté` (past-tense spend),
  // `factura`, `tarjeta de crédito`, `recuérdame`, `recordatorio`.
  if (!/\b(finance|financas|finanças|financeiro|financeira|budget|orcamento|orçamento|fatura|invoice|pagamento|payment|stripe|gastei|gast[eé]|spend|recibo|darf|lembrete|reminder|receipt|categori[zs]e[r]?|categorize|credit\s+card|cart[aã]o\s+de\s+cr[eé]dito|tarjeta\s+de\s+cr[eé]dito|bill|conta\s+(?:banc[aá]ria|corrente|do\s+(?:cart[aã]o|banco))|factura[s]?|recuerdame|recu[eé]rdame|recordatorio)\b/.test(folded)) return null;
  // Categorize-receipt intent: explicit categorize verb with receipt object.
  // Checked before the others because receipts can mention "pay" semantically
  // (it's the same financial event) and we want the categorization request to
  // not be misclassified as a payment_action.
  // Phase 11 batch 58 (2026-05-16): Spanish "categoriza" (imperative) /
  // "categorizar" (infinitive). The previous regex required `e` after
  // `categoriz` so the Spanish present-tense form `categoriza` failed.
  if (/\b(categori[zs][ae][r]?|classific(?:a|ar)|tag|etiquetar)\b.*\b(receipt|recibo|fatura|invoice)\b/.test(folded)
    || /\b(receipt|recibo|fatura|invoice)\b.*\b(categori[zs][ae][r]?|classific(?:a|ar))\b/.test(folded)) {
    return makeStep(input, {
      skill: 'finance',
      action: 'finance_categorize_receipt',
      risk: 'safe_write',
      provider: 'nexus',
      args: { receiptId: null, category: null },
      requiredArgsPresent: false,
    });
  }
  // Reminder takes precedence over payment: "remind me to pay X" is a reminder
  // intent (matrix verb = remind), not a payment-action intent. The embedded
  // infinitive "to pay" must not promote the surface "pay" keyword above the
  // reminder verb. (2026-05-15 routing-gap fix: shadow-parity discovered
  // "Remind me to pay the DARF on Friday" was routing to finance_payment_action.)
  // Phase 6 batch 34 (2026-05-15): PT-PT enclitic "Lembra-me de" added —
  // hyphenated form was missing from the reminder verb set, causing finance
  // summary to claim instead of create_reminder.
  if (/\b(remind\s+me|reminder|lembrete|lembre[\s-]?me|me\s+lembre|me\s+lembra|lembra[\s-]?me|lembrar\s+(?:de|para)|recu[eé]rdame|recuerdame|recordatorio)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'finance',
      action: 'finance_create_reminder',
      risk: 'safe_write',
      provider: 'nexus',
      args: { title: extractTopic(input.text) || input.text.trim(), dueDate: null },
      requiredArgsPresent: false,
    });
  }
  if (/\b(pay|paga|payment|pagamento|stripe|refund|reembolso|invoice action)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'finance',
      action: 'finance_payment_action',
      risk: 'financial',
      provider: 'stripe',
      args: { rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  return makeStep(input, {
    skill: 'finance',
    action: 'finance_summary',
    risk: 'read_only',
    provider: 'nexus',
    args: { month: now.toFormat('yyyy-MM') },
    requiredArgsPresent: true,
  });
}
