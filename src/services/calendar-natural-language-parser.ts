// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

export type CalendarNlProvider = 'google' | 'outlook';

export interface ParsedNaturalLanguageCalendarEvent {
  title: string;
  provider?: CalendarNlProvider;
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  attendees: string[];
  location: string | null;
  notes: string | null;
  recurrence: null;
  confidence: number;
  matchedText: {
    date?: string;
    timeRange?: string;
    title?: string;
  };
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NUMERIC_DATE_PATTERN = /\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/;
const DATE_WORD_PATTERN = /\b(?:hoje|today|amanh[aã]|tomorrow|depois de amanh[aã]|day after tomorrow|este|neste|nesse|pr[oó]xim[oa]|next)?\s*(?:segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(monday|segunda(?:-feira)?)\b/, 1],
  [/\b(tuesday|terca(?:-feira)?)\b/, 2],
  [/\b(wednesday|quarta(?:-feira)?)\b/, 3],
  [/\b(thursday|quinta(?:-feira)?)\b/, 4],
  [/\b(friday|sexta(?:-feira)?)\b/, 5],
  [/\b(saturday|sabado)\b/, 6],
  [/\b(sunday|domingo)\b/, 7],
];

const PT_NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  um: 1,
  duas: 2,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
};

export function foldCalendarText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCalendarWriteIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  const hasWriteVerb = /\b(cria|criar|marca|marcar|agenda|agendar|adiciona|adicionar|coloca|mete|poe|faz|schedule|add|create|book)\b/.test(folded);
  const hasCalendarObject = /\b(evento|event|agenda|calendario|calendar|google calendar|gmail agenda|agenda do gmail|agenda google|calendario google|outlook calendar|agenda outlook)\b/.test(folded);
  return hasWriteVerb && hasCalendarObject;
}

export function hasMailReadIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(unread|inbox|mail status|emails? nao lidos?|mensagens? novas?|caixa de entrada|quantos? emails?)\b/.test(folded);
}

export function resolveCalendarProviderAlias(text: string): CalendarNlProvider | undefined {
  const folded = foldCalendarText(text);
  if (/\boutlook\b/.test(folded) && /\b(calendar|calendario|agenda)\b/.test(folded)) return 'outlook';
  if (/\bgoogle calendar\b|\bgoogle agenda\b|\bagenda (?:do )?google\b|\bcalendario (?:do )?google\b/.test(folded)) return 'google';
  if (/\bgmail agenda\b|\bagenda do gmail\b/.test(folded)) return 'google';
  if (/\bgmail\b/.test(folded) && hasCalendarWriteIntent(folded) && !hasMailReadIntent(folded)) return 'google';
  if (/\bgoogle\b/.test(folded)) return 'google';
  return undefined;
}

function uniqueEmails(text: string): string[] {
  return Array.from(new Set((text.match(EMAIL_PATTERN) ?? []).map((email) => email.toLowerCase())));
}

function resolveDate(text: string, timezone: string, nowIso?: string): { day: DateTime; matched?: string } | null {
  const base = (nowIso ? DateTime.fromISO(nowIso, { zone: timezone }) : DateTime.now().setZone(timezone)).setZone(timezone);
  const numeric = text.match(NUMERIC_DATE_PATTERN);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const rawYear = numeric[3] ? Number(numeric[3]) : base.year;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    let candidate = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (!candidate.isValid) return null;
    if (!numeric[3] && candidate.startOf('day') < base.startOf('day')) {
      candidate = candidate.plus({ years: 1 });
    }
    return { day: candidate.startOf('day'), matched: numeric[0] };
  }

  const folded = foldCalendarText(text);
  if (/\b(hoje|today)\b/.test(folded)) return { day: base.startOf('day'), matched: 'today' };
  if (/\b(amanha|tomorrow)\b/.test(folded)) return { day: base.plus({ days: 1 }).startOf('day'), matched: 'tomorrow' };
  if (/\b(depois de amanha|day after tomorrow)\b/.test(folded)) {
    return { day: base.plus({ days: 2 }).startOf('day'), matched: 'day_after_tomorrow' };
  }

  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(folded)) continue;
    let candidate = base.set({ weekday: weekday as any }).startOf('day');
    if (candidate <= base.startOf('day')) candidate = candidate.plus({ weeks: 1 });
    return { day: candidate, matched: text.match(DATE_WORD_PATTERN)?.[0] };
  }

  return null;
}

function parseSingleTime(raw: string): { hour: number; minute: number } | null {
  const folded = foldCalendarText(raw)
    .replace(/\b(horas?|hours?)\b/g, '')
    .replace(/\b(as|às|a|ao|ate|até|to|de|from|das|do)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bmeia noite\b|\bmidnight\b/.test(folded)) {
    return { hour: 0, minute: /\b(meia|half|30)\b/.test(folded.replace('meia noite', '')) ? 30 : 0 };
  }
  if (/\bmeio dia\b|\bmeio-dia\b|\bnoon\b/.test(folded)) {
    return { hour: 12, minute: /\b(meia|meio|half|30)\b/.test(folded.replace(/meio[- ]dia|noon/g, '')) ? 30 : 0 };
  }

  const numeric = folded.match(/\b(\d{1,2})(?:\s*(?:h|:|\.|h)\s*(\d{2}))?\b/);
  let hour: number | null = numeric ? Number(numeric[1]) : null;
  let minute = numeric?.[2] ? Number(numeric[2]) : 0;
  if (hour == null) {
    const word = Object.keys(PT_NUMBER_WORDS).find((candidate) => new RegExp(`\\b${candidate}\\b`).test(folded));
    if (word) hour = PT_NUMBER_WORDS[word];
  }
  if (hour == null || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (/\b(meia|half)\b/.test(folded) && !numeric?.[2]) minute = 30;
  if (/\b(da tarde|da noite|pm)\b/.test(folded) && hour >= 1 && hour <= 11) hour += 12;
  if (/\b(da manha|am)\b/.test(folded) && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function extractTimeRange(text: string): { start: { hour: number; minute: number }; end: { hour: number; minute: number }; matched: string } | null {
  const timeAtom = '(?:\\d{1,2}(?:\\s*(?:h|:|\\.)\\s*\\d{2})?|meio[- ]dia(?:\\s+e\\s+mei[ao])?|meia[- ]noite|uma|um|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)(?:\\s+da\\s+(?:manha|tarde|noite))?';
  const directRange = text.match(new RegExp(`\\b(?:das?|de|from)\\s+(${timeAtom})\\s+(?:às|as|aos?|ao|até|ate|to|-|–)\\s+(${timeAtom})\\b`, 'i'));
  if (directRange) {
    const start = parseSingleTime(directRange[1]);
    const end = parseSingleTime(directRange[2]);
    if (start && end) return { start, end, matched: directRange[0] };
  }

  const range = text.match(/\b(?:das?|de|from)\s+(.{1,32}?)\s+(?:às|as|aos?|ao|até|ate|to|-|–)\s+(.{1,42}?)(?=(?:\s+(?:nesse|neste|este|proximo|próximo|next|domingo|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|hoje|amanhã|amanha|tomorrow|today)\b)|[,.!?]|$)/i);
  if (range) {
    const start = parseSingleTime(range[1]);
    const end = parseSingleTime(range[2]);
    if (start && end) return { start, end, matched: range[0] };
  }

  const duration = text.match(/\b(?:às|as|at)\s+(.{1,32}?)\s+(?:por|durante|for)\s+(\d{1,3})\s*(minutos?|mins?|horas?|hours?|h)\b/i);
  if (duration) {
    const start = parseSingleTime(duration[1]);
    if (!start) return null;
    const amount = Number(duration[2]);
    const unit = foldCalendarText(duration[3]);
    const startDate = DateTime.fromObject({ hour: start.hour, minute: start.minute });
    const endDate = unit.startsWith('h') || unit.startsWith('hora') || unit.startsWith('hour')
      ? startDate.plus({ hours: amount })
      : startDate.plus({ minutes: amount });
    return {
      start,
      end: { hour: endDate.hour, minute: endDate.minute },
      matched: duration[0],
    };
  }

  return null;
}

function extractTitle(text: string, timeRangeText?: string): { title: string | null; matched?: string } {
  const explicit = text.match(/\b(?:chamad[oa]|com o t[ií]tulo|t[ií]tulo\s*:|called|named)\s+["']?(.+?)["']?(?=\s+(?:das?|de|from|às|as|at|hoje|amanh[aã]|nesse|neste|este|pr[oó]xim[oa]|next|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b|[,.!?]|$)/i);
  if (explicit?.[1]) {
    const title = explicit[1].replace(EMAIL_PATTERN, '').trim();
    if (title) return { title, matched: explicit[0] };
  }

  let candidate = text;
  if (timeRangeText) candidate = candidate.replace(timeRangeText, ' ');
  candidate = candidate
    .replace(EMAIL_PATTERN, ' ')
    .replace(NUMERIC_DATE_PATTERN, ' ')
    .replace(DATE_WORD_PATTERN, ' ')
    .replace(/\b(?:cria|criar|marca|marcar|agenda|agendar|adiciona|adicionar|colocar|coloca|mete|poe|faz|schedule|add|create|book)\b/gi, ' ')
    .replace(/\b(?:um|uma|o|a|os|as|no|na|em|in|on|para|for|do|da|dia|the|meu|minha|my|evento|event|calend[aá]rio|calendar|agenda|google|gmail|outlook)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, '')
    .trim();
  return candidate ? { title: candidate } : { title: null };
}

export function parseNaturalLanguageCalendarEvent(
  text: string,
  options: { timezone: string; nowIso?: string },
): ParsedNaturalLanguageCalendarEvent | null {
  if (!hasCalendarWriteIntent(text)) return null;
  const date = resolveDate(text, options.timezone, options.nowIso);
  const timeRange = extractTimeRange(text);
  if (!date || !timeRange) return null;

  const start = date.day.set({
    hour: timeRange.start.hour,
    minute: timeRange.start.minute,
    second: 0,
    millisecond: 0,
  });
  let end = date.day.set({
    hour: timeRange.end.hour,
    minute: timeRange.end.minute,
    second: 0,
    millisecond: 0,
  });
  if (end <= start) end = end.plus({ days: 1 });

  const title = extractTitle(text, timeRange.matched);
  if (!title.title) return null;
  const provider = resolveCalendarProviderAlias(text);
  const confidence = Math.min(0.98, 0.72 + (provider ? 0.08 : 0) + (title.matched ? 0.08 : 0) + (date.matched ? 0.05 : 0) + 0.05);

  return {
    title: title.title,
    provider,
    startDateTime: start.toISO({ suppressMilliseconds: true })!,
    endDateTime: end.toISO({ suppressMilliseconds: true })!,
    timezone: options.timezone,
    attendees: uniqueEmails(text),
    location: null,
    notes: null,
    recurrence: null,
    confidence,
    matchedText: {
      date: date.matched,
      timeRange: timeRange.matched,
      title: title.matched,
    },
  };
}
