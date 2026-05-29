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
