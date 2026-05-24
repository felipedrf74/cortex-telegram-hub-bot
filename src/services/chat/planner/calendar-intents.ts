// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import {
  foldCalendarText,
  hasCalendarReadIntent,
  parseNaturalLanguageCalendarEvent,
} from '../../calendar-natural-language-parser';
import { makeSlotProvenance, type ChatSlotProvenance } from '../../chat-action-state';
import { makeStep } from '../../skills/step-builder';
import type { ChatActionRisk, ChatProvider } from '../registry';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import { buildPlanFromSteps } from './plan-builder';

export function parseSummarizeAgendaIntent(input: ChatPlannerInput): ChatActionPlan | null {
  if (!hasCalendarReadIntent(input.text)) return null;
  const folded = foldCalendarText(input.text);
  // Provider hint: "agenda do gmail" routes to google_calendar by behaviour
  // case #5 (audit §11). Default is unscoped; the engine consults connected
  // providers downstream when no hint is given.
  const provider = /\b(gmail|google)\b/.test(folded)
    ? 'google_calendar'
    : /\boutlook\b/.test(folded)
      ? 'outlook_calendar'
      : undefined;
  const baseDay = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const agendaDay = /\b(tomorrow|amanh[aã]|ma[nñ]ana)\b/.test(folded)
    ? baseDay.plus({ days: 1 })
    : baseDay;
  const args: Record<string, unknown> = { date: agendaDay.toISODate() };
  if (provider) args.provider = provider;
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action: 'summarize_agenda',
    risk: 'read_only',
    provider: provider ?? 'nexus',
    args,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(input, [step], ['calendar_read_intent', 'summarize_agenda_short_circuit'], 0.82);
}

// Phase 1 batch 4: calendar mutation intents — update/move/delete event.
// Mirrors parseTaskMutationIntent: claim the action with `eventId: null` and
// let the recent-entity follow-up resolve which event the user means.
// Must run BEFORE parseNaturalLanguageCalendarEvent at the top of the planner
// would not match these (because they lack a full title+time tuple), but we
// still defer to that path when both a clear event title AND new time are
// present: the calendar-write parser handles "schedule a meeting" cleanly.
export function parseCalendarMutationIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Gate: must explicitly reference a calendar object.
  // Phase 8 batch 43: Spanish "reunion"/"cita" added alongside PT-EN nouns.
  const hasCalObject = /\b(event|evento|meeting|reuni[aã]o|reunion[es]?|cita[s]?|appointment|compromisso|consulta|consult|dentist|dentista|standup|sync|sincronia|catch[\s-]?up|agenda|appointment)\b/.test(folded);
  if (!hasCalObject) return null;

  // Delete / cancel intent.
  // Phase 3 batch 16 (2026-05-15): "drop the X" added as informal cancel verb.
  if (/\b(cancel|delete|remove|apaga[r]?|cancela[r]?|elimina[r]?|drop)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'delete_event', 'destructive');
  }
  // Move / reschedule intent.
  // Phase 12 batch 66 (2026-05-16): Spanish "mueve" (imperative of mover)
  // and "reprograma[r]?" (reschedule) added.
  if (/\b(move|reschedule|push|reagenda[r]?|remarca[r]?|mover|mueve[r]?|reprograma[r]?|adia[r]?)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'move_event', 'safe_write');
  }
  // Update / change intent.
  // Phase 11 batch 58 (2026-05-16): Spanish "cambia[r]?" (the most common
  // ES verb for "change") added. "modifica[r]?" already covered both PT
  // and ES forms.
  if (/\b(update|change|edit|atualiza[r]?|altera[r]?|modifica[r]?|cambia[r]?|rename|renomeia[r]?)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'update_event', 'safe_write');
  }
  return null;
}

function buildCalendarMutationPlan(
  input: ChatPlannerInput,
  action: 'update_event' | 'move_event' | 'delete_event',
  risk: ChatActionRisk,
): ChatActionPlan {
  const folded = foldCalendarText(input.text);
  const provider = /\b(outlook)\b/.test(folded) ? 'outlook_calendar' : 'google_calendar';
  const args: Record<string, unknown> = { eventId: null, provider };
  if (action === 'move_event') {
    args.startDateTime = null;
    args.endDateTime = null;
  } else if (action === 'update_event') {
    args.changedFields = null;
  }
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action,
    risk,
    provider,
    args,
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], [`calendar_${action}_intent`, 'deterministic_calendar_parser'], 0.76);
}

// Phase 1 batch 4: check_calendar_conflicts — state-free intent that needs only
// a time range. Claims when the user asks "am I free at X" / "estou livre em
// X". Distinct from summarize_agenda (which asks for the day's events) by
// asking whether a specific slot is busy.
export function parseCheckCalendarConflictsIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const isFreeBusyQuestion =
    /\b(am\s+i\s+free|do\s+i\s+have\s+(?:anything|something)|do\s+i\s+have\s+free\s+time|check\s+(?:my\s+|for\s+)?(?:conflict|availability))\b/.test(folded)
    // Phase 3 batch 15: PT-BR "tô livre" / "tô disponivel" (BR contraction
    // of "estou") added alongside PT-PT phrasings.
    || /\b((?:estou|t[oô])\s+(?:livre|disponivel)|tenho\s+(?:algo|alguma\s+coisa)\s+(?:no|na|em)|verifica[r]?\s+(?:conflitos?|disponibilidade))\b/.test(folded)
    // Phase 12 batch 66 (2026-05-16): Spanish "estoy libre"/"estoy
    // disponible" added (ES uses "estoy" with 'y', distinct from
    // PT-PT "estou" with 'u').
    || /\bestoy\s+(?:libre|disponible)\b/.test(folded);
  if (!isFreeBusyQuestion) return null;
  const calendar = parseNaturalLanguageCalendarEvent(input.text, {
    timezone: input.timezone,
    nowIso: input.nowIso ?? new Date().toISOString(),
  });
  const provider = /\b(outlook)\b/.test(folded) ? 'outlook_calendar' : 'google_calendar';
  const args: Record<string, unknown> = {
    provider,
    startDateTime: calendar?.startDateTime ?? null,
    endDateTime: calendar?.endDateTime ?? null,
  };
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action: 'check_calendar_conflicts',
    risk: 'read_only',
    provider,
    args,
    requiredArgsPresent: Boolean(args.startDateTime && args.endDateTime),
  });
  return buildPlanFromSteps(input, [step], ['check_calendar_conflicts_intent', 'deterministic_calendar_parser'], 0.78);
}

export function buildCalendarSlotProvenance(
  input: ChatPlannerInput,
  calendar: NonNullable<ReturnType<typeof parseNaturalLanguageCalendarEvent>>,
  provider: ChatProvider,
): Record<string, ChatSlotProvenance> {
  const rawText = input.text;
  return {
    title: makeSlotProvenance({ slot: 'title', value: calendar.title, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    provider: makeSlotProvenance({ slot: 'provider', value: provider, rawText, turnId: input.messageId, normalizer: 'calendar_provider_alias_v1', confidence: 0.98 }),
    startDateTime: makeSlotProvenance({ slot: 'startDateTime', value: calendar.startDateTime, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    endDateTime: makeSlotProvenance({ slot: 'endDateTime', value: calendar.endDateTime, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    timezone: makeSlotProvenance({ slot: 'timezone', value: calendar.timezone, rawText: null, turnId: input.messageId, sourceType: 'safe_default', normalizer: 'user_timezone', confidence: 1 }),
  };
}
