// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  CHAT_CORE_V2_PREPASS_MAX_CANDIDATES,
  CHAT_CORE_V2_PREPASS_MIN_CANDIDATES,
} from './prepass-contract';

export interface SelectPrepassCandidateCapabilitiesInput {
  message: string;
  activeThreadCapabilityIds?: string[];
  pendingConfirmationCapabilityId?: string;
  recentDomainCapabilityIds?: string[];
}

export interface SelectPrepassCandidateCapabilitiesResult {
  candidateCapabilityIds: string[];
  reasonCodes: string[];
}

const SENTINEL_CAPABILITIES = [
  'clarify_reference',
  'unsupported',
  'general.help',
];

const FALLBACK_READ_CAPABILITIES = [
  'tasks.today_summary',
  'secretary.agenda_summary',
  'training.session_explain',
];

export function selectPrepassCandidateCapabilities(
  input: SelectPrepassCandidateCapabilitiesInput,
): SelectPrepassCandidateCapabilitiesResult {
  const message = input.message.toLowerCase();
  const candidates: string[] = [];
  const reasonCodes: string[] = [];

  addAll(candidates, input.pendingConfirmationCapabilityId ? [input.pendingConfirmationCapabilityId] : []);
  if (input.pendingConfirmationCapabilityId) reasonCodes.push('pending_confirmation');

  if (/\b(move|reschedule|reagendar|mover|adiar)\b/.test(message)) {
    addAll(candidates, ['secretary.schedule_event_preview', 'tasks.create', 'training.modify_session_preview']);
    reasonCodes.push('reschedule_keyword');
  }
  if (/\b(remind|reminder|lembrar|lembrete)\b/.test(message)) {
    addAll(candidates, ['tasks.create', 'notifications.snooze']);
    reasonCodes.push('reminder_keyword');
  }
  if (/\b(buy|spent|expense|paguei|gastei|comprar)\b/.test(message)) {
    addAll(candidates, ['finance.summary', 'cooking.grocery_item_preview']);
    reasonCodes.push('finance_or_purchase_keyword');
  }
  // WP-09 capability-coverage buckets. These map GENERAL domain vocabulary to the
  // REAL registry capability that owns the corresponding answer/draft class — they
  // are derived from the capability registry (cooking answer, content draft,
  // finance-educational, task-create-write), NOT reverse-engineered from any
  // corpus's specific phrasings. The miss analysis only told us WHICH capability
  // classes were uncovered (cooking answer, content draft, write-create); the
  // keywords below are the ordinary words a user would use for those classes in
  // en + pt, so the selector generalises beyond the synthetic fixtures. Adding a
  // keyword that exists only to pass a single corpus item is forbidden (overfit).
  // Count nouns carry an optional trailing `s` (`s?`) so English/Portuguese
  // plurals match too — that is general morphology, not corpus tuning.
  if (/\b(recipes?|cook|cooking|meals?|dinners?|lunch|breakfast|receitas?|cozinhar|jantar|almo[çc]o|refei[çc][aõ]es|refei[çc][aã]o)\b/.test(message)) {
    addAll(candidates, ['cooking.meal_plan_summary']);
    reasonCodes.push('cooking_answer_keyword');
  }
  if (/\b(drafts?|hooks?|captions?|scripts?|outlines?|reels?|roteiros?|legendas?|esbo[çc]os?|rascunhos?)\b/.test(message)) {
    addAll(candidates, ['content.brief_draft_preview']);
    reasonCodes.push('content_draft_keyword');
  }
  if (/\b(afford|budgets?|invest|finance|financial|or[çc]amentos?|despesas?|investir|financeir[oa]s?)\b/.test(message)) {
    addAll(candidates, ['finance.summary']);
    reasonCodes.push('finance_educational_keyword');
  }
  if (/\b(create|add|mark|complete|done|new|crie|criar|cria|marca|marcar|adiciona|adicionar|conclu[ií]d)\b/.test(message)) {
    addAll(candidates, ['tasks.create', 'tasks.complete']);
    reasonCodes.push('task_write_keyword');
  }
  if (/\b(today|hoje|calendar|agenda|task|tarefa|training|treino)\b/.test(message)) {
    addAll(candidates, ['tasks.today_summary', 'secretary.agenda_summary', 'training.session_explain']);
    reasonCodes.push('daily_read_keyword');
  }
  if (/\b(health|injury|pain|medical|les[aã]o|dor)\b/.test(message)) {
    addAll(candidates, ['training.session_explain']);
    reasonCodes.push('high_risk_health_signal');
  }

  addAll(candidates, input.activeThreadCapabilityIds ?? []);
  if ((input.activeThreadCapabilityIds ?? []).length > 0) reasonCodes.push('active_thread_anchor');

  if (/\b(it|that|this|isso|aquilo|ele|ela)\b/.test(message)) {
    addAll(candidates, input.recentDomainCapabilityIds ?? []);
    reasonCodes.push('ambiguous_reference_widened');
  }

  addAll(candidates, SENTINEL_CAPABILITIES);
  addAll(candidates, FALLBACK_READ_CAPABILITIES);

  return {
    candidateCapabilityIds: candidates.slice(0, Math.max(CHAT_CORE_V2_PREPASS_MIN_CANDIDATES, CHAT_CORE_V2_PREPASS_MAX_CANDIDATES)),
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function addAll(target: string[], values: string[]): void {
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !target.includes(normalized)) target.push(normalized);
  }
}
