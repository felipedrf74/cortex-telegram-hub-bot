// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 12 batch 63 (2026-05-16): typed slot-extractor adapters.
//
// Phase 11 batch 59 added the typed `SlotExtractor` / `SlotValidator`
// types to the registry but no action entries actually consumed them.
// This module ships three concrete adapters that wire the existing
// deterministic parsers into the typed API, and attaches them to the
// three highest-frequency actions:
//
//   • secretary_calendar.schedule_event
//   • tasks.create_task
//   • training.training_plan_create
//
// The adapters are kept thin — each one calls the existing parser and
// projects its output onto the slot map. Failures (no parse, missing
// slots) return `{ slots: {} }` so downstream validators can flag the
// missing-fields condition uniformly.
//
// The pattern is intentionally repeatable: subsequent batches can add
// adapters for additional actions without changing the typed-slot API
// shape.

import { randomUUID } from 'crypto';

import {
  hasCalendarWriteIntent,
  parseNaturalLanguageCalendarEvent,
} from './calendar-natural-language-parser';
import {
  extractTrainingPlanSlots,
} from './skills/training/helpers';
import {
  parseContentPipelineStageTransition,
} from './skills/content/pipeline-stage';
import type {
  SlotContext,
  SlotExtractor,
} from './chat/registry';

// ─────────────────────────── Calendar adapter ───────────────────────────

export const calendarEventSlotExtractor: SlotExtractor = {
  name: 'calendar_event_nlp',
  label: 'parses ISO start/end + title/provider from natural-language calendar phrasings',
  extract(text, ctx) {
    if (!hasCalendarWriteIntent(text)) return { slots: {} };
    const parsed = parseNaturalLanguageCalendarEvent(text, {
      timezone: ctx.timezone ?? 'UTC',
      nowIso: ctx.nowIso,
    });
    if (!parsed) return { slots: {} };
    return {
      slots: {
        title: parsed.title,
        startDateTime: parsed.startDateTime,
        endDateTime: parsed.endDateTime,
        timezone: parsed.timezone,
        provider: parsed.provider === 'outlook' ? 'outlook_calendar' : 'google_calendar',
        attendees: parsed.attendees,
        location: parsed.location,
        notes: parsed.notes,
        recurrence: parsed.recurrence,
      },
      confidence: parsed.confidence,
    };
  },
};

// ─────────────────────────── Task adapter ───────────────────────────
//
// Two extraction surfaces in priority order:
//   1. Explicit title marker — quoted string, "called X", "chamada X",
//      "titulada X", "llamada X".
//   2. Imperative + object — "Create a task to <object>" / "Cria uma
//      tarefa para <object>" / "Crea una tarea para <object>".
//
// The explicit-marker form scores higher confidence (0.95) because the
// title boundary is unambiguous. The imperative-object form scores 0.7
// because the object string can drift.

const TITLE_MARKER_PATTERN = /\b(?:called|named|chamad[oa]|titulad[oa]|llamad[oa])\s+["']?(.+?)["']?(?=\s+(?:for|until|by|tomorrow|today|next|para|at[eé]|hoje|amanh[aã]|ma[nñ]ana)\b|[,.!?]|$)/i;
const QUOTED_TITLE_PATTERN = /["'""]([^"'""]+)["'""]/;

export const simpleTaskSlotExtractor: SlotExtractor = {
  name: 'simple_task_title',
  label: 'extracts task title from explicit markers or quoted strings',
  extract(text) {
    // Quoted string is the highest-confidence form.
    const quoted = text.match(QUOTED_TITLE_PATTERN);
    if (quoted?.[1] && quoted[1].trim().length > 0) {
      return { slots: { title: quoted[1].trim() }, confidence: 0.95 };
    }
    const marker = text.match(TITLE_MARKER_PATTERN);
    if (marker?.[1] && marker[1].trim().length > 0) {
      return { slots: { title: marker[1].trim() }, confidence: 0.9 };
    }
    return { slots: {} };
  },
};

// ─────────────────────────── Training adapter ───────────────────────────

export const trainingPlanSlotExtractor: SlotExtractor = {
  name: 'training_plan_slots',
  label: 'extracts sport/goal/duration/weeklyVolume/startDate from training-plan phrasings',
  extract(text, ctx) {
    // `extractTrainingPlanSlots` wants a full planner-input shape; build a
    // synthetic one. The slot extractor doesn't care about userId/tenantId
    // (those are not slot data), so any positive integers work.
    const synthetic = {
      userId: 0,
      tenantId: 0,
      conversationId: `typed-slot-${randomUUID()}`,
      messageId: `typed-slot-${randomUUID()}`,
      locale: ctx.locale ?? 'en-US',
      timezone: ctx.timezone ?? 'UTC',
      channel: 'telegram' as const,
      text,
      nowIso: ctx.nowIso,
    };
    const result = extractTrainingPlanSlots(synthetic);
    return { slots: result.slots };
  },
};

// ─────────────────────────── Mail send/draft adapter ───────────────────────────
//
// Phase 13 batch 67 (2026-05-16): mail recipient + subject + body extractor.
// Used by both `mail.send_email` and `mail.draft_email` since they share
// the same slot shape.

const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SUBJECT_MARKER = /\b(?:subject|assunto|asunto)\s*:?\s+([^,.;]+?)(?=\s+(?:and|body|corpo|cuerpo|with|com|con)\b|[,.;]|$)/i;
const BODY_MARKER = /\b(?:body|corpo|cuerpo|with body|com corpo|con cuerpo)\s*:?\s+(.+?)(?=$|[,.;])/i;
const ABOUT_MARKER = /\b(?:about|sobre|saying)\s+(.+?)(?=$|[,.;])/i;

export const mailRecipientSlotExtractor: SlotExtractor = {
  name: 'mail_recipient_subject_body',
  label: 'extracts recipient (email), subject, body from natural-language mail phrasings',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const recipient = text.match(EMAIL_ADDRESS);
    if (recipient) slots.recipient = recipient[0].toLowerCase();
    const subject = text.match(SUBJECT_MARKER);
    if (subject?.[1]) slots.subject = subject[1].trim();
    const body = text.match(BODY_MARKER);
    if (body?.[1]) slots.body = body[1].trim();
    else {
      const about = text.match(ABOUT_MARKER);
      if (about?.[1]) slots.body = about[1].trim();
    }
    return { slots, confidence: Object.keys(slots).length >= 2 ? 0.85 : 0.6 };
  },
};

// ─────────────────────────── Checklist adapter ───────────────────────────
//
// Phase 13 batch 67: checklist title + items extractor.

const CHECKLIST_TITLE = /\b(?:checklist|sub-?tarefas?|subtarefas?)\s+(?:for|para|sobre|de|do|da)\s+([^,.:;]+?)(?:\s+with\b|\s+com\b|\s+con\b|[,.:;]|$)/i;
const CHECKLIST_ITEMS = /\b(?:with|com|con)\s+(.+)$/i;

export const checklistSlotExtractor: SlotExtractor = {
  name: 'checklist_title_items',
  label: 'extracts checklist title + items list from natural-language phrasings',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const titleMatch = text.match(CHECKLIST_TITLE);
    if (titleMatch?.[1]) slots.title = titleMatch[1].trim();
    const itemsMatch = text.match(CHECKLIST_ITEMS);
    if (itemsMatch?.[1]) {
      const items = itemsMatch[1]
        .split(/[,;]\s*|\s+e\s+|\s+y\s+|\s+and\s+/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length > 0) slots.items = items;
    }
    return { slots, confidence: slots.items ? 0.85 : 0.6 };
  },
};

const TASK_WITH_SUBTASKS_PATTERN = /^\s*(?:create|make|cria|criar|crie|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|tarefa|tarea)\s+(?:called|named|chamad[oa]|llamad[oa])?\s*(.+?)\s+(?:where\s+it\s+has\s+|with\s+|com\s+|con\s+)?(?:sub\s*-?\s*tasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?)\s*(?:called|named|chamad[oa]s?|llamad[oa]s?)?\s+(.+)$/i;
const ADD_SUBTASKS_PATTERN = /^\s*(?:add|adiciona|adicionar|a[nñ]ade|a[nñ]adir|agrega|agregar)\s+(.+?)\s+(?:to|under|à|a|na|no|en|bajo)\s+(?:my\s+|minha\s+|meu\s+|mi\s+|the\s+|la\s+|el\s+)?(?:task\s+|tarefa\s+|tarea\s+)?(.+?)(?:\s+task|\s+tarefa|\s+tarea)?$/i;

export const taskWithSubtasksSlotExtractor: SlotExtractor = {
  name: 'task_with_subtasks',
  label: 'extracts a parent task title and checklist subtasks',
  extract(text) {
    const quoted = [...text.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g)]
      .map((match) => (match[1] || match[2] || match[3] || match[4] || '').trim())
      .filter(Boolean);
    const createMatch = text.match(TASK_WITH_SUBTASKS_PATTERN);
    if (createMatch) {
      const title = quoted.length > 0 && /["“'‘]/.test(createMatch[1]) ? quoted[0] : createMatch[1].trim();
      const rawItems = quoted.length > 1 ? quoted.slice(1) : splitChecklistLikeItems(createMatch[2]);
      return rawItems.length > 0
        ? { slots: { title, subtasks: rawItems }, confidence: quoted.length > 1 ? 0.92 : 0.84 }
        : { slots: {} };
    }
    const addMatch = text.match(ADD_SUBTASKS_PATTERN);
    if (addMatch) {
      const subtasks = splitChecklistLikeItems(addMatch[1]);
      const title = addMatch[2].trim().replace(/^\s*(the|a|uma|um|una|un|minha|meu|my|mi|la|el|los|las)\s+/i, '');
      return subtasks.length > 0 && title
        ? { slots: { title, subtasks }, confidence: 0.82 }
        : { slots: {} };
    }
    return { slots: {} };
  },
};

function splitChecklistLikeItems(value: string): string[] {
  const stripped = value
    .replace(/^\s*(called|named|chamad[oa]s?|llamad[oa]s?)\s+/i, '')
    .trim();
  const commaSplit = stripped
    .split(/\s*(?:,|;|\n|\u2022|•)\s*|\s+(?:and|e|y)\s+/g)
    .map((item) => item.trim().replace(/[.?!]+$/g, ''))
    .filter(Boolean);
  if (commaSplit.length > 1) return commaSplit;
  const words = stripped.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  return words.length >= 2 ? words : commaSplit;
}

// ─────────────────────────── Agenda-date adapter ───────────────────────────
//
// Phase 13 batch 67: extracts a date reference from `summarize_agenda`
// phrasings. The deterministic planner already resolves the date elsewhere;
// the typed extractor surfaces just the raw date phrase so downstream
// consumers can normalize it.

const AGENDA_DATE_MARKER = /\b(today|tomorrow|tonight|hoje|amanh[aã]|hoy|ma[nñ]ana|esta\s+(?:semana|noche|tarde|ma[nñ]ana)|next\s+\w+|pr[oó]xim[oa]\s+\w+|el\s+\w+)\b/i;

export const agendaDateSlotExtractor: SlotExtractor = {
  name: 'agenda_date',
  label: 'extracts the date phrase from summarize_agenda requests',
  extract(text) {
    const match = text.match(AGENDA_DATE_MARKER);
    if (!match) return { slots: {} };
    return { slots: { date: match[0].toLowerCase() }, confidence: 0.8 };
  },
};

// ─────────────────────────── Calendar-mutation adapter ───────────────────────────
//
// Phase 13 batch 67: shared extractor for `delete_event` / `update_event` /
// `move_event`. These actions need `eventId` from a recent-entity lookup
// (not extractable from text alone), but the extractor can surface the
// event-reference phrase for the recent-entity resolver to match.

const EVENT_REFERENCE = /\b(?:the|my|a|o|um|el|un)?\s*(dentist\s+appointment|dentista|reuni[aãoó]n|reuniao|reuni[oó]n|meeting|cita|appointment|evento|event)\b\s*(?:com|with|con)?\s*([A-Z][a-z]+)?/i;

export const calendarMutationSlotExtractor: SlotExtractor = {
  name: 'calendar_mutation_reference',
  label: 'extracts the event reference phrase for delete/update/move calendar mutations',
  extract(text) {
    const match = text.match(EVENT_REFERENCE);
    if (!match) return { slots: {} };
    const reference = [match[1], match[2]].filter(Boolean).join(' ').trim();
    return { slots: { eventReference: reference }, confidence: 0.7 };
  },
};

// ─────────────────────────── Phase 14 batch 72 adapters ───────────────────────────
//
// Generic topic / content / reference extractors for actions that don't have
// their own dedicated parser. Each adapter surfaces the most-likely slot
// value from raw user text so callers don't have to reimplement the same
// regex pattern.

const TOPIC_AFTER_PREP = /\b(?:about|sobre|on|regarding|de|do|da)\s+(.+?)(?=[,.!?;]|$)/i;
const DAY_PHRASE = /\b(today|tomorrow|tonight|hoje|amanh[aã]|hoy|ma[nñ]ana|next\s+\w+|pr[oó]xim[oa]\s+\w+|el\s+\w+)\b/i;
const DATE_RANGE = /\b(?:this|next|last|esta|este|pr[oó]xim[oa])\s+(?:week|m[eê]s|month|year|ano)\b/i;
const TASK_REFERENCE_PATTERN = /\b(?:task|tarefa)\s+(?:called|named|chamad[oa]|titulad[oa]|llamad[oa])?\s*([^\s.,;!?]+(?:\s+[^\s.,;!?]+){0,3})/i;
const RECEIPT_CATEGORY_PATTERN = /\b(?:as|como)\s+(office\s+supplies?|travel|meals?|transportation|software|hardware|marketing|advertising|professional\s+services?|utilities|rent|insurance|equipment|subscriptions?|material(?:\s+de\s+escrit[oó]rio)?|alimenta[cç][aã]o|transporte|softwares?|publicidade|servi[cç]os?\s+profissionais|materiales?|viajes|comida[s]?)\b/i;
const DEADLINE_PHRASE = /\b(by|until|para|antes\s+(?:de|del))\s+(.+?)(?=[,.!?;]|$)/i;

export const taskMutationSlotExtractor: SlotExtractor = {
  name: 'task_mutation_reference',
  label: 'extracts the task reference for update/delete/complete task mutations',
  extract(text) {
    const match = text.match(TASK_REFERENCE_PATTERN);
    if (!match?.[1]) return { slots: {} };
    return { slots: { taskReference: match[1].trim() }, confidence: 0.7 };
  },
};

export const topicSlotExtractor: SlotExtractor = {
  name: 'topic_phrase',
  label: 'extracts a topic phrase from "about X" / "sobre X" / "on X" forms',
  extract(text) {
    const match = text.match(TOPIC_AFTER_PREP);
    if (!match?.[1] || match[1].trim().length < 3) return { slots: {} };
    return { slots: { topic: match[1].trim() }, confidence: 0.75 };
  },
};

export const dateRangeSlotExtractor: SlotExtractor = {
  name: 'date_range',
  label: 'extracts a date range phrase ("this week", "next month", "el mes")',
  extract(text) {
    const range = text.match(DATE_RANGE);
    if (range) return { slots: { dateRange: range[0].toLowerCase() }, confidence: 0.8 };
    const day = text.match(DAY_PHRASE);
    if (day) return { slots: { dateRange: day[0].toLowerCase() }, confidence: 0.7 };
    return { slots: {} };
  },
};

export const financeCategorySlotExtractor: SlotExtractor = {
  name: 'finance_category',
  label: 'extracts a finance receipt category from "as X" / "como X" markers',
  extract(text) {
    const match = text.match(RECEIPT_CATEGORY_PATTERN);
    if (!match?.[1]) return { slots: {} };
    return { slots: { category: match[1].trim().toLowerCase() }, confidence: 0.85 };
  },
};

export const reminderSlotExtractor: SlotExtractor = {
  name: 'reminder_title_deadline',
  label: 'extracts reminder title + deadline phrase from "remind me to X by Y"',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const deadline = text.match(DEADLINE_PHRASE);
    if (deadline?.[2]) slots.dueDate = deadline[2].trim();
    const topic = text.match(/\b(?:remind\s+me\s+to|lembre[\s-]?me\s+de|recu[eé]rdame|lembra[\s-]?me\s+de)\s+(.+?)(?=\s+(?:by|until|para|antes)\b|[,.!?;]|$)/i);
    if (topic?.[1]) slots.title = topic[1].trim();
    return { slots, confidence: slots.title && slots.dueDate ? 0.9 : 0.65 };
  },
};

const PLATFORM_PATTERN = /\b(instagram|tiktok|youtube|reel|carousel|shorts|reels|x|twitter|threads|linkedin|facebook)\b/i;

export const contentBriefSlotExtractor: SlotExtractor = {
  name: 'content_brief',
  label: 'extracts objective + platform from content brief / script create phrasings',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const platform = text.match(PLATFORM_PATTERN);
    if (platform) slots.platform = platform[0].toLowerCase();
    const topic = text.match(TOPIC_AFTER_PREP);
    if (topic?.[1] && topic[1].trim().length >= 3) {
      slots.objective = topic[1].trim();
      slots.goal = topic[1].trim();
    }
    return { slots, confidence: slots.platform && slots.objective ? 0.85 : 0.6 };
  },
};

export const contentPipelineStageSlotExtractor: SlotExtractor = {
  name: 'content_pipeline_stage_transition',
  label: 'extracts target stage and content title from content pipeline stage phrasings',
  extract(text) {
    const slots = parseContentPipelineStageTransition(text);
    const result: Record<string, unknown> = {};
    if (slots.topicTitle) result.topicTitle = slots.topicTitle;
    if (slots.targetStage) result.targetStage = slots.targetStage;
    if (slots.youtubeUrl) result.youtubeUrl = slots.youtubeUrl;
    return { slots: result, confidence: result.topicTitle && result.targetStage ? 0.88 : 0.55 };
  },
};

export const cookingMealPlanSlotExtractor: SlotExtractor = {
  name: 'cooking_meal_plan',
  label: 'extracts dateRange for meal-plan generation',
  extract(text) {
    const range = text.match(DATE_RANGE);
    if (range) {
      const dateRange = /next/i.test(range[0]) || /pr[oó]xim/i.test(range[0]) ? 'next_week' : 'this_week';
      return { slots: { dateRange }, confidence: 0.8 };
    }
    return { slots: { dateRange: 'this_week' }, confidence: 0.5 };
  },
};

export const connectionsSlotExtractor: SlotExtractor = {
  name: 'connections_provider',
  label: 'extracts a provider hint from connections sync/status/reconnect phrasings',
  extract(text) {
    const match = text.match(/\b(google|outlook|microsoft|apple|garmin|gmail|hotmail|healthkit|stripe)\b/i);
    if (!match) return { slots: {} };
    return { slots: { provider: match[0].toLowerCase() }, confidence: 0.85 };
  },
};

export const decisionChoiceSlotExtractor: SlotExtractor = {
  name: 'decision_choice',
  label: 'extracts decisionId + choice letter from decision_choose phrasings',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const decisionId = text.match(/\b(?:decision|decis[aã]o|decisi[oó]n)\s*#?:?\s*([a-zA-Z0-9._:-]+)/i);
    if (decisionId?.[1]) slots.decisionId = decisionId[1];
    const choice = text.match(/\b(?:option|op[cç][aã]o|opci[oó]n)\s+([a-zA-Z0-9]+)/i)
      || text.match(/\b(?:choose|chose|pick|escolho|elijo)\s+(?:la\s+|el\s+)?([a-zA-Z0-9]+)/i);
    if (choice?.[1]) slots.choice = choice[1].toUpperCase();
    return { slots, confidence: slots.decisionId && slots.choice ? 0.9 : 0.6 };
  },
};

// ─────────────────────────── No-op adapter (Phase 15 batch 77) ───────────────────────────
//
// For actions that don't have any useful natural-language slot extraction
// (e.g. training_reflow_confirm needs a sessionId from recent-entity
// resolution, not from text). Adopting the typed API still has value:
// the action's `typedSlotValidators` provides the missing-field signal
// uniformly, and downstream consumers can call `getSlotExtractors`
// without branching on whether the entry has any.
export const noopSlotExtractor: SlotExtractor = {
  name: 'noop',
  label: 'no natural-language extraction; slots come from recent-entity / pending state',
  extract() {
    return { slots: {} };
  },
};

export const notificationSlotExtractor: SlotExtractor = {
  name: 'notification_topic',
  label: 'extracts notification topic / trigger from notification_create_intent phrasings',
  extract(text) {
    const trigger = text.match(/\b(?:when|quando|cuando)\s+(.+?)(?=[,.!?;]|$)/i);
    const topic = text.match(/\b(?:notification|notifica[cç][aã]o|notificaci[oó]n|alerta?)\s+(?:about|sobre|de|do|da)\s+(.+?)(?=[,.!?;]|$)/i);
    const slots: Record<string, unknown> = {};
    if (topic?.[1]) slots.topic = topic[1].trim();
    if (trigger?.[1]) slots.trigger = trigger[1].trim();
    return { slots, confidence: 0.7 };
  },
};

// ─────────────────────────── Task reference adapter ───────────────────────────
//
// Phase 14 batch 72 (2026-05-16): extracts the task reference phrase from
// natural-language phrasings for `update_task`, `complete_task`, `delete_task`.
// The taskId itself comes from a recent-entity resolver — this extractor just
// surfaces the surface text the resolver can match.

const TASK_REFERENCE = /\b(?:the|my|a|esta|essa|esa|aquela)?\s*(?:task|tarefa|tarea)\s+(?:of|de|do|da|de la|del)?\s*(?:the\s+)?([a-zA-Z][\w\s-]{2,30}?)(?=\s+(?:to|para|al?|do|done|feita|hecha|in|on|by)\b|[,.!?]|$)/i;
const TASK_THIS_THAT = /\b(?:this|that|esta|essa|esa|aquela)\s+(?:task|tarefa|tarea)\b/i;

export const taskReferenceSlotExtractor: SlotExtractor = {
  name: 'task_reference',
  label: 'extracts task title reference or recent-entity hint for task mutations',
  extract(text) {
    const slots: Record<string, unknown> = {};
    const ref = text.match(TASK_REFERENCE);
    if (ref?.[1]) {
      slots.taskReference = ref[1].trim();
      return { slots, confidence: 0.85 };
    }
    if (TASK_THIS_THAT.test(text)) {
      slots.recentTaskHint = true;
      return { slots, confidence: 0.7 };
    }
    return { slots: {} };
  },
};

// ─────────────────────────── Mail provider adapter ───────────────────────────
//
// Phase 14 batch 72: extracts the mail provider name from text for
// `mail_unread_count` / `mail_inbox_summary` etc.

const MAIL_PROVIDER_PATTERN = /\b(gmail|google\s+mail|outlook(?:\s+mail)?|hotmail|microsoft\s+mail)\b/i;

export const mailProviderSlotExtractor: SlotExtractor = {
  name: 'mail_provider',
  label: 'extracts gmail/outlook_mail provider name from natural-language mail phrasings',
  extract(text) {
    const match = text.match(MAIL_PROVIDER_PATTERN);
    if (!match) return { slots: { provider: 'gmail' }, confidence: 0.3 };
    const p = match[0].toLowerCase();
    if (p.startsWith('outlook') || p === 'hotmail' || p.includes('microsoft')) {
      return { slots: { provider: 'outlook_mail' }, confidence: 0.95 };
    }
    return { slots: { provider: 'gmail' }, confidence: 0.95 };
  },
};

// ─────────────────────────── Meal date-range adapter ───────────────────────────
//
// Phase 14 batch 72: extracts the week / date-range phrase for cooking
// meal-plan / grocery-list actions. The deterministic planner already
// computes `weekStart` from "this week" / "next week"; this extractor
// surfaces the raw phrase for downstream consumers.

const MEAL_DATE_RANGE = /\b(this\s+week|next\s+week|tonight|tomorrow|today|esta\s+semana|pr[oó]xima\s+semana|semana\s+que\s+vem|hoy|ma[nñ]ana|hoje|amanh[aã])\b/i;

export const mealDateRangeSlotExtractor: SlotExtractor = {
  name: 'meal_date_range',
  label: 'extracts the date / week range phrase for cooking meal-plan and grocery-list intents',
  extract(text) {
    const match = text.match(MEAL_DATE_RANGE);
    if (!match) return { slots: {} };
    const phrase = match[0].toLowerCase();
    const isNextWeek = /next|pr[oó]xima|semana\s+que\s+vem/i.test(phrase);
    return {
      slots: { dateRange: isNextWeek ? 'next_week' : 'this_week', datePhrase: phrase },
      confidence: 0.85,
    };
  },
};
