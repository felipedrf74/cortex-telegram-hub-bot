// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeSlotProvenance, type ChatSlotProvenance } from '../../chat-action-state';
import { buildStepIdempotencyKey } from '../../skills/step-builder';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import { stepRequiresConfirmation } from './plan-utils';
import { containsPromptInjectionMarker } from './safety-refusals';
import {
  hasLegacySubtaskIntent,
  removeTaskQuotedSegments,
} from './task-subtasks';

export function parseSimpleTaskIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const step = parseSimpleTaskStep(input, input.text);
  if (!step) return null;
  const requireSafeWrites = input.requireSafeWriteConfirmation === true;
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: stepRequiresConfirmation(step, { requireSafeWrites }),
    confidence: 0.82,
    debug: {
      routingSignals: ['task_write_intent', 'deterministic_task_parser'],
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

export function parseSimpleTaskStep(input: ChatPlannerInput, text: string | null): ChatPlanStep | null {
  if (!text) return null;
  const folded = foldCalendarText(text);
  if (hasLegacySubtaskIntent(removeTaskQuotedSegments(text))) return null;
  // Phase 2 batch 10: PT-BR colloquial create-verbs ("bota", "coloca", "põe",
  // "mete") added so "Bota uma tarefa chamada X" routes through the simple-
  // task parser instead of falling through.
  // Phase 8 batch 43 (2026-05-15): Spanish "crea"/"crear" + "tarea" added
  // for minimum Spanish coverage.
  // Phase 9 batch 48 (2026-05-16): Spanish "añade"/"añadir" added.
  const directTaskCreate = /\b(cria|criar|adiciona|adicionar|create|add|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?|a[nñ]ade|a[nñ]adir|agreg[ae][r]?)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded);
  const reminderTaskCreate = isPlainTaskReminderCreate(folded);
  if (!directTaskCreate && !reminderTaskCreate) return null;
  const titleSlot = extractTaskTitleSlot(input, text);
  const title = titleSlot?.value.trim();
  if (!title) return null;
  const dueSlot = extractTaskDueDateTimeSlot(input, text);
  // Literal-title policy (audit §10, approved 2026-05-15 by Felipe): when the
  // title span comes from an explicit title marker (called/chamada/titulo:/named/
  // quoted-string — extractTaskTitleSlot returns confidence ≥ 0.95 for those),
  // treat the title as user-provided content, even if it contains destructive
  // verbs. Outside trusted spans (heuristic fallback at confidence < 0.95),
  // the unsafe-title defense still applies.
  //
  // Prompt-injection markers (§10.1 point 4) override the literal-title policy:
  // explicit LLM-instruction syntax (`ignore previous instructions`,
  // `<|im_start|>`, `[INST]`, etc.) refuses regardless of trusted-span status.
  const fromTrustedTitleSpan = (titleSlot?.confidence ?? 0) >= 0.95;
  const hasInjectionMarker = containsPromptInjectionMarker(title);
  const destructiveOutsideTitleSpan = !fromTrustedTitleSpan && isUnsafeTaskTitle(title);
  const unsafeTitle = hasInjectionMarker || destructiveOutsideTitleSpan;
  const args = unsafeTitle
    ? { title: null, rejectedTitle: title, list: null, dueDateTime: dueSlot?.value ?? null, notes: null }
    : { title, list: null, dueDateTime: dueSlot?.value ?? null, notes: null };
  const slotProvenance: Record<string, ChatSlotProvenance> = {
    title: makeSlotProvenance({
      slot: 'title',
      value: title,
      rawText: titleSlot?.rawText ?? title,
      turnId: input.messageId,
      spanStart: titleSlot?.spanStart ?? null,
      spanEnd: titleSlot?.spanEnd ?? null,
      sourceType: 'user_message',
      normalizer: 'task_title_v2',
      confidence: titleSlot?.confidence ?? 0.9,
    }),
  };
  if (dueSlot) {
    slotProvenance.dueDateTime = makeSlotProvenance({
      slot: 'dueDateTime',
      value: dueSlot.value,
      rawText: dueSlot.rawText,
      turnId: input.messageId,
      spanStart: dueSlot.spanStart,
      spanEnd: dueSlot.spanEnd,
      sourceType: 'user_message',
      normalizer: 'task_due_datetime_v1',
      confidence: dueSlot.confidence,
    });
  }
  return {
    stepId: `step-${randomUUID()}`,
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: unsafeTitle ? 'ambiguous' : 'safe_write',
    riskClass: unsafeTitle ? 'R4' : 'R1',
    provider: 'nexus',
    args,
    slotProvenance,
    requiredArgsPresent: !unsafeTitle,
    idempotencyKey: buildStepIdempotencyKey(input, 'create_task', args),
    verification: {
      required: true,
      method: 'local_read_back',
      expectedFields: unsafeTitle ? {} : { title },
    },
  };
}

export function startsWithSimpleTaskCreateIntent(text: string): boolean {
  const folded = foldCalendarText(text).replace(/^(?:please|por favor|pfv)\s+/, '');
  return /^\s*(?:create|add|cria[r]?|adiciona[r]?|bota[r]?|coloca[r]?|poe[r]?|mete[r]?|crea[r]?|anade|anadir|agrega[r]?)\b[\s\S]{0,40}\b(?:task|tarefa|todo|lembrete|tarea)\b/.test(folded)
    || /^\s*(?:remind me to|lembra-?me de|lembre-?me de|recuerdame(?: a)?|recordarme(?: a)?)\b/.test(folded);
}

function isUnsafeTaskTitle(title: string): boolean {
  const folded = foldCalendarText(title);
  return /\b(delete|remove|erase|wipe|apaga|apagar|elimina|eliminar|remove)\b.*\b(all|todos|todas|everything|tasks|tarefas|events|eventos|emails?)\b/.test(folded)
    || /\b(send|envia|enviar)\b.*\b(all|todos|todas|emails?|mensagens)\b/.test(folded)
    || /\b(delete|apaga|apagar)\b.*\b(church|igreja|event|evento)\b/.test(folded);
}

function extractTaskTitleSlot(input: ChatPlannerInput, text: string): { value: string; rawText: string; spanStart: number; spanEnd: number; confidence: number } | null {
  const quotedTaskTitle = /\b(?:task|tarefa|todo|lembrete|tarea)\b\s*["“]([^"”]+)["”]/i.exec(text);
  if (quotedTaskTitle?.[1]) {
    const raw = quotedTaskTitle[1].trim();
    const cleaned = cleanupTaskTitle(raw, input);
    if (cleaned.length > 0) {
      const start = quotedTaskTitle.index + quotedTaskTitle[0].indexOf(quotedTaskTitle[1]);
      return { value: cleaned, rawText: raw, spanStart: start, spanEnd: start + quotedTaskTitle[1].length, confidence: 0.98 };
    }
  }

  const explicitPatterns = [
    /\b(?:called|named|titled|with\s+title|chamad[oa]|com\s+o\s+t[ií]tulo|t[ií]tulo|llamad[oa]|titulada)\s*[:\-]?\s*["“]?([\s\S]+?)["”]?(?=$|[.!?]\s*$)/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(text);
    const raw = match?.[1]?.trim();
    if (!match || !raw) continue;
    const cleaned = cleanupTaskTitle(raw, input);
    if (cleaned.length > 0) {
      const start = match.index + match[0].indexOf(match[1]);
      return { value: cleaned, rawText: raw, spanStart: start, spanEnd: start + match[1].length, confidence: 0.97 };
    }
  }

  const reminder = /\b(?:remind\s+me\s+to|lembra-?me\s+de|lembre-?me\s+de|recu[eé]rdame\s+(?:a\s+)?|recordarme\s+(?:a\s+)?)\b/i.exec(text);
  if (reminder) {
    const rest = text.slice(reminder.index + reminder[0].length).trim();
    const cleaned = sentenceCaseEnglishTaskTitle(cleanupTaskTitle(rest, input), input, text);
    if (cleaned.length > 0) {
      const start = text.indexOf(rest);
      return { value: cleaned, rawText: rest, spanStart: start >= 0 ? start : reminder.index, spanEnd: start >= 0 ? start + rest.length : text.length, confidence: 0.85 };
    }
  }

  const taskNoun = /\b(?:task|tarefa|todo|lembrete|tarea)\b/i.exec(text);
  if (!taskNoun) return null;
  let rest = text.slice(taskNoun.index + taskNoun[0].length).trim();
  rest = rest.replace(/^(?:to|for|para)\s+/i, '');
  rest = stripLeadingTaskTemporalPhrase(rest, input);
  let cleaned = sentenceCaseEnglishTaskTitle(cleanupTaskTitle(rest, input), input, text);
  if (cleaned.length === 0) {
    cleaned = sentenceCaseEnglishTaskTitle(extractPreTaskModifierTitle(text, taskNoun.index, input), input, text);
  }
  if (cleaned.length === 0) return null;
  const start = text.indexOf(rest);
  return { value: cleaned, rawText: rest, spanStart: start >= 0 ? start : taskNoun.index, spanEnd: start >= 0 ? start + rest.length : text.length, confidence: 0.82 };
}

function extractPreTaskModifierTitle(text: string, taskNounIndex: number, input: ChatPlannerInput): string {
  const prefix = text.slice(0, taskNounIndex)
    .replace(/^\s*(?:please|por favor|pfv)\s+/i, '')
    .replace(/^\s*(?:create|add|cria[r]?|adiciona[r]?|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?|a[nñ]ade|a[nñ]adir|agreg[ae][r]?)\s+/i, '')
    .replace(/^\s*(?:a|an|uma?|una?)\s+/i, '')
    .trim();
  const cleaned = cleanupTaskTitle(prefix, input);
  return /^(?:new|nova?|nuevo|nueva)$/i.test(cleaned) ? '' : cleaned;
}

function isPlainTaskReminderCreate(folded: string): boolean {
  if (!/\b(remind me to|lembra-?me de|lembre-?me de|recuerdame(?: a)?|recordarme(?: a)?)\b/.test(folded)) return false;
  return !/\b(credit card|cartao|cartao de credito|fatura|factura|bill|invoice|darf|irs|iva|tax|imposto|stripe|payment|pagamento)\b/.test(folded);
}

function sentenceCaseEnglishTaskTitle(title: string, input: ChatPlannerInput, sourceText: string): string {
  if (!title) return title;
  const isEnglish = input.locale?.toLowerCase().startsWith('en') === true
    || /^\s*(?:add|create|remind me to)\b/i.test(sourceText);
  if (!isEnglish || !/^[a-z]/.test(title)) return title;
  return `${title[0]?.toUpperCase() ?? ''}${title.slice(1)}`;
}

function cleanupTaskTitle(title: string, input: ChatPlannerInput): string {
  let cleaned = title.trim()
    .replace(/^["“]|["”]$/g, '')
    .replace(/[.?!]+$/g, '')
    .trim();
  cleaned = stripTaskTemporalPhrase(cleaned, input).trim();
  cleaned = cleaned
    .replace(/\s+(?:tomorrow|amanh[ãa]|ma[ñn]ana|today|hoje)(?:\s+(?:at|[àa]s?|as|a\s+las|pelas?|by|para\s+as?)\s*)?(?:\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i, '')
    .trim();
  cleaned = cleaned
    .replace(/\s+\b(?:please|por favor)\b$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

function stripLeadingTaskTemporalPhrase(text: string, input: ChatPlannerInput): string {
  const folded = foldCalendarText(text);
  if (!/^(today|tomorrow|amanha|amanhã|hoje|next|proxim[ao]|próxim[ao]|\d{1,2}[\/-]\d{1,2})\b/.test(folded)) return text;
  return text
    .replace(/^(?:today|tomorrow|amanh[ãa]|ma[ñn]ana|hoje)(?:\s+(?:at|às?|as|a\s+las|pelas?)\s*)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}h(?:\d{2})?)?\s*/i, '')
    .replace(/^(?:next|pr[oó]xim[ao])\s+\w+\s*/i, '')
    .trim();
}

function stripTaskTemporalPhrase(title: string, input: ChatPlannerInput): string {
  const due = extractTaskDueDateTimeSlot(input, title);
  if (!due) return title;
  return `${title.slice(0, due.spanStart)} ${title.slice(due.spanEnd)}`.replace(/\s{2,}/g, ' ').trim();
}

function extractTaskDueDateTimeSlot(input: ChatPlannerInput, text: string): { value: string; rawText: string; spanStart: number; spanEnd: number; confidence: number } | null {
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const patterns = [
    /\b(?:for|para|due|vence|pra|p[ao]ra)?\s*(?<date>tomorrow|amanh[ãa]|ma[ñn]ana|today|hoje)(?=\s|$|[,.!?])\s+(?:at|às?|as|a\s+las|pelas?|by|para\s+as)?\s*(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
    /\b(?<date>tomorrow|amanh[ãa]|ma[ñn]ana|today|hoje)(?=\s|$|[,.!?])(?:\s+(?:at|às?|as|a\s+las|pelas?|by|para)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:for|para|due|vence|pra|p[ao]ra)\s+(?<date>tomorrow|amanh[ãa]|ma[ñn]ana|today|hoje)(?=\s|$|[,.!?])(?:\s+(?:at|às?|as|a\s+las|pelas?)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:for|on|by|due|para|pra|p[ao]ra|el|na|no)?\s*(?<date>monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes)\b(?:\s+(?:at|às?|as|a\s+las|pelas?|by|para\s+as)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:at|às?|as|pelas?)\s*(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.groups) continue;
    const raw = match[0];
    const dateWord = foldCalendarText(String(match.groups.date || ''));
    let date = resolveTaskDueDate(now, dateWord);
    if (!dateWord && /\b(?:at|às?|as|pelas?)\b/i.test(raw)) date = now;
    const parsedTime = parseTaskClockTime(match.groups.time || '');
    if (!parsedTime && !dateWord) continue;
    const value = parsedTime
      ? date.set({
        hour: parsedTime.hour,
        minute: parsedTime.minute,
        second: 0,
        millisecond: 0,
      }).toISO()
      : date.toISODate();
    if (!value) continue;
    return {
      value,
      rawText: raw.trim(),
      spanStart: match.index,
      spanEnd: match.index + raw.length,
      confidence: dateWord ? 0.94 : 0.78,
    };
  }
  return null;
}

function resolveTaskDueDate(now: DateTime, dateWord: string): DateTime {
  if (dateWord === 'tomorrow' || dateWord === 'amanha' || dateWord === 'manana') return now.plus({ days: 1 });
  const weekday = taskWeekdayNumber(dateWord);
  if (!weekday) return now;
  let days = weekday - now.weekday;
  if (days <= 0) days += 7;
  return now.plus({ days });
}

function taskWeekdayNumber(dateWord: string): number | null {
  switch (dateWord) {
    case 'monday':
    case 'segunda':
    case 'segunda-feira':
    case 'lunes':
      return 1;
    case 'tuesday':
    case 'terca':
    case 'terca-feira':
    case 'martes':
      return 2;
    case 'wednesday':
    case 'quarta':
    case 'quarta-feira':
    case 'miercoles':
      return 3;
    case 'thursday':
    case 'quinta':
    case 'quinta-feira':
    case 'jueves':
      return 4;
    case 'friday':
    case 'sexta':
    case 'sexta-feira':
    case 'viernes':
      return 5;
    case 'saturday':
    case 'sabado':
      return 6;
    case 'sunday':
    case 'domingo':
      return 7;
    default:
      return null;
  }
}

function parseTaskClockTime(rawInput: unknown): { hour: number; minute: number } | null {
  const raw = String(rawInput || '').trim().toLowerCase();
  const match = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) || raw.match(/\b(\d{1,2})h(\d{2})?\b/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

export function extractTaskClause(text: string): string | null {
  const match = text.match(/\b(?:e|and)\s+(?=(?:cria|criar|adiciona|adicionar|create|add)\b[\s\S]*\b(?:tarefa|task|todo|lembrete)\b)([\s\S]+)$/i);
  return match?.[1]?.trim() || null;
}
