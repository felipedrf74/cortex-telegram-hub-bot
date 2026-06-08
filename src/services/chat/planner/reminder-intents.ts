// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeSlotProvenance } from '../../chat-action-state';
import { makeStep } from '../../skills/step-builder';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import { buildPlanFromSteps } from './plan-builder';

type ReminderTimeSlot = {
  value: string;
  rawText: string;
  spanStart: number;
  spanEnd: number;
  confidence: number;
};

const FINANCE_REMINDER_TERMS = /\b(credit card|cartao|cartão|cartao de credito|cartão de crédito|fatura|factura|bill|invoice|darf|irs|iva|tax|imposto|stripe|payment|pagamento)\b/;
const REMINDER_VERB = /\b(remind\s+me|reminder|lembra-?me|lembre-?me|lembrar|me\s+lembra|me\s+lembre|avisa-?me|avise-?me|av[ií]same|alerta-?me|recordatorio|recuerdame|recu[eé]rdame)\b/i;
const IMPERATIVE_BARE_REMINDER_VERB = /^\s*(?:avisa|alerta)\b(?!\s+(?:que|es)\b)/i;

export function parseStandaloneReminderIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  if (!REMINDER_VERB.test(input.text) && !IMPERATIVE_BARE_REMINDER_VERB.test(folded) && !/\blembrete\b/.test(folded)) return null;
  if (FINANCE_REMINDER_TERMS.test(folded)) return null;

  const remindAt = extractReminderTimeSlot(input);
  if (!remindAt) return null;
  const message = extractReminderMessage(input.text, remindAt).trim();
  if (!message) return null;

  const args = {
    message,
    remindAt: remindAt.value,
    timezone: input.timezone,
  };
  const step: ChatPlanStep = makeStep(input, {
    skill: 'secretary_reminders',
    action: 'set_reminder',
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: true,
    slotProvenance: {
      message: makeSlotProvenance({
        slot: 'message',
        value: message,
        rawText: message,
        turnId: input.messageId,
        spanStart: input.text.indexOf(message) >= 0 ? input.text.indexOf(message) : null,
        spanEnd: input.text.indexOf(message) >= 0 ? input.text.indexOf(message) + message.length : null,
        sourceType: 'user_message',
        normalizer: 'secretary_reminder_message_v1',
        confidence: 0.82,
      }),
      remindAt: makeSlotProvenance({
        slot: 'remindAt',
        value: remindAt.value,
        rawText: remindAt.rawText,
        turnId: input.messageId,
        spanStart: remindAt.spanStart,
        spanEnd: remindAt.spanEnd,
        sourceType: 'user_message',
        normalizer: 'secretary_reminder_time_v1',
        confidence: remindAt.confidence,
      }),
    },
  });
  return buildPlanFromSteps(input, [step], ['secretary_reminder_write_intent', 'deterministic_reminder_parser'], 0.84);
}

function extractReminderTimeSlot(input: ChatPlannerInput): ReminderTimeSlot | null {
  const now = resolveNow(input);
  const match = findClockMatch(input.text);
  const date = resolveReminderDate(input.text, now, match?.hour, match?.minute);
  if (!date) return null;
  const hour = match?.hour ?? 9;
  const minute = match?.minute ?? 0;
  const scheduled = date.set({ hour, minute, second: 0, millisecond: 0 });
  const adjusted = match && scheduled.toMillis() <= now.toMillis() ? scheduled.plus({ days: 1 }) : scheduled;
  return {
    value: adjusted.toISO()!,
    rawText: match?.rawText ?? date.toISODate() ?? input.text,
    spanStart: match?.spanStart ?? 0,
    spanEnd: match?.spanEnd ?? 0,
    confidence: match ? 0.9 : 0.72,
  };
}

function resolveNow(input: ChatPlannerInput): DateTime {
  const parsed = DateTime.fromISO(input.nowIso ?? new Date().toISOString(), { setZone: true }).setZone(input.timezone);
  return parsed.isValid ? parsed : DateTime.now().setZone(input.timezone);
}

function findClockMatch(text: string): { hour: number; minute: number; rawText: string; spanStart: number; spanEnd: number } | null {
  const patterns = [
    /\b(?:at|às?|as|pelas?|para\s+as|a\s+las)\s*(\d{1,2})(?::(\d{2})|h(\d{2})?)?\s*(am|pm)?\b/i,
    /\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\s*(am|pm)?\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const hourValue = Number.parseInt(match[1] || '', 10);
    const minuteValue = Number.parseInt(match[2] || match[3] || '0', 10);
    if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue) || minuteValue < 0 || minuteValue > 59) continue;
    let hour = hourValue;
    const ampm = String(match[4] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour < 0 || hour > 23) continue;
    return {
      hour,
      minute: minuteValue,
      rawText: match[0],
      spanStart: match.index,
      spanEnd: match.index + match[0].length,
    };
  }
  return null;
}

function resolveReminderDate(text: string, now: DateTime, hour?: number, minute?: number): DateTime | null {
  const folded = foldCalendarText(text);
  if (/\b(tomorrow|amanha|amanhã|mañana|manana)\b/.test(folded)) return now.plus({ days: 1 }).startOf('day');
  if (/\b(today|hoje)\b/.test(folded)) return now.startOf('day');
  const weekday = weekdayIndex(folded);
  if (weekday != null) {
    let daysAhead = (weekday - now.weekday + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    return now.plus({ days: daysAhead }).startOf('day');
  }
  if (hour != null) {
    const candidate = now.set({ hour, minute: minute ?? 0, second: 0, millisecond: 0 });
    return candidate.toMillis() <= now.toMillis() ? now.plus({ days: 1 }).startOf('day') : now.startOf('day');
  }
  return null;
}

function weekdayIndex(folded: string): number | null {
  const days: Array<[RegExp, number]> = [
    [/\b(monday|segunda(?:-feira)?|lunes)\b/, 1],
    [/\b(tuesday|terca(?:-feira)?|terça(?:-feira)?|martes)\b/, 2],
    [/\b(wednesday|quarta(?:-feira)?|miercoles|miércoles)\b/, 3],
    [/\b(thursday|quinta(?:-feira)?|jueves)\b/, 4],
    [/\b(friday|sexta(?:-feira)?|viernes)\b/, 5],
    [/\b(saturday|sabado|sábado)\b/, 6],
    [/\b(sunday|domingo)\b/, 7],
  ];
  return days.find(([pattern]) => pattern.test(folded))?.[1] ?? null;
}

function extractReminderMessage(text: string, timeSlot: ReminderTimeSlot): string {
  const withoutTime = `${text.slice(0, timeSlot.spanStart)} ${text.slice(timeSlot.spanEnd)}`;
  return withoutTime
    .replace(/^\s*(?:please|por\s+favor|pfv)\s+/i, '')
    .replace(/^\s*(?:remind\s+me(?:\s+to)?|reminder(?:\s+to)?|lembra-?me(?:\s+de)?|lembre-?me(?:\s+de)?|me\s+lembra(?:\s+de)?|me\s+lembre(?:\s+de)?|lembrar(?:\s+de)?|avisa-?me(?:\s+de)?|avise-?me(?:\s+de)?|avisa(?:\s+de)?|alerta(?:\s+de)?|recordatorio(?:\s+para)?|recuerdame(?:\s+a)?|recu[eé]rdame(?:\s+a)?)\s*/i, '')
    .replace(/\b(?:today|tomorrow|hoje|amanh[ãa]|ma[ñn]ana|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes)\b/gi, ' ')
    .replace(/^(?:to|de|para|about|sobre|a)\s+/i, '')
    .replace(/[.?!]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
