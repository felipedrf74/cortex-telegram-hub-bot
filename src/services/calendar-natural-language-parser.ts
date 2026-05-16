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
// Phase 10 batch 50 (2026-05-16): Spanish weekday names added alongside
// PT-EN forms. Spanish: lunes/martes/miércoles/jueves/viernes/sábado/domingo.
const DATE_WORD_PATTERN = /\b(?:hoje|today|amanh[aã]|tomorrow|depois de amanh[aã]|day after tomorrow|este|neste|nesse|pr[oó]xim[oa]|next|el|la|pasado\s+ma[nñ]ana|ma[nñ]ana)?\s*(?:segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i;

const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(monday|segunda(?:-feira)?|lunes)\b/, 1],
  [/\b(tuesday|terca(?:-feira)?|ter[cç]a(?:-feira)?|martes)\b/, 2],
  [/\b(wednesday|quarta(?:-feira)?|mi[eé]rcoles)\b/, 3],
  [/\b(thursday|quinta(?:-feira)?|jueves)\b/, 4],
  [/\b(friday|sexta(?:-feira)?|viernes)\b/, 5],
  [/\b(saturday|sabado|s[aá]bado)\b/, 6],
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
  // Read-intent first: if the user is asking what's on the agenda (not asking
  // to put something there), this is NOT a write intent. Otherwise the
  // Portuguese noun "agenda" (which is also a write verb meaning "to schedule")
  // collapses these two intents and write-paths wrongly fire on read queries.
  if (hasCalendarReadIntent(folded)) return false;
  // Phase 2 batch 11 (2026-05-15): "block off" / "put on calendar" / "set up"
  // added as English calendar-write verbs. These phrasings are common in
  // natural English calendar requests; gate now accepts them alongside
  // schedule/add/create/book.
  // Phase 9 batch 48 (2026-05-16): Spanish "crea/programa/agenda" added.
  const hasWriteVerb = /\b(cria|criar|marca|marcar|agenda|agendar|adiciona|adicionar|coloca[r]?|mete|poe|faz|schedule|add|create|book|block\s+off|set\s+up|put\s+(?:on|in)\s+(?:my\s+)?calendar|crea[r]?|programa[r]?|a[nñ]ade)\b/.test(folded);
  // The "block off time" form also implies a calendar-write intent even when
  // the object isn't named "event" — the time-blocking idiom is the object.
  const hasBlockOffIdiom = /\bblock\s+off\s+(?:time|the?\s+)/.test(folded);
  // Phase 10 batch 50 (2026-05-16): Spanish calendar nouns added. Note
  // that Portuguese "reunião" folds to "reuniao" but Spanish "reunión"
  // folds to "reunion" (ó → o, not a), so we need both alternations.
  // "cita" is Spanish for appointment.
  const hasCalendarObject = /\b(evento|event(?:s)?|meeting(?:s)?|reuni[aã]o|reuni[oõ]es|reunion(?:es)?|appointment(?:s)?|compromisso(?:s)?|cita[s]?|agenda|calendario|calendar|google calendar|gmail agenda|agenda do gmail|agenda google|calendario google|outlook calendar|agenda outlook)\b/.test(folded);
  return hasWriteVerb && (hasCalendarObject || hasBlockOffIdiom);
}

export function hasCalendarReadIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  // English read patterns: "what's on my agenda", "what's on the agenda",
  // "show my agenda", "agenda summary", "agenda?" alone.
  // Portuguese read patterns: "agenda de hoje", "agenda do gmail" (as query),
  // "minha agenda", "como esta a agenda", "resumo da agenda".
  // Bare "agenda?" with no other token is read intent (asking for summary).
  if (/\b(what'?s?|what is)\s+(?:on\s+)?(?:my|the)\s+agenda\b/.test(folded)) return true;
  if (/\b(show|display|view|list|resume|resumir|resumo|sum[aá]rio|summary\s+of|mostra(?:r|m)?|mostre|exibe|exibir|abre|ver)\s+(?:my|the|a|o|os|as|do|da|de|dos|das)?\s*agenda\b/.test(folded)) return true;
  if (/\bagenda\s+(?:de|do|da|para|of|on|for)\s+\w+/.test(folded) && !/\b(?:cria|criar|marca|marcar|adiciona|coloca[r]?|schedule|add|create|book|agenda(?:r)?\s+(?:uma|um|para))\b.*\b(?:evento|event|meeting|reuni[aã]o|appointment|compromisso|na\s+agenda|no\s+calendario)\b/.test(folded)) return true;
  if (/^\s*agenda\??\s*$/.test(folded)) return true;
  if (/\bminha\s+agenda\b/.test(folded)) return true;
  // Phase 3 batch 16 (2026-05-15): conversational read forms — "What do I
  // have today" / "What do I have on Friday" reads as agenda-query when the
  // tail is a temporal scope. The form lacks the word "agenda" but the
  // intent is the same. Limited to "I have today/tomorrow/...|on <day>" so we
  // don't trip on possessive constructions.
  if (/\bwhat\s+do\s+i\s+have\s+(?:today|tomorrow|this\s+(?:week|morning|afternoon|evening)|on\s+\w+|next\s+\w+)\b/.test(folded)) return true;
  // Phase 3 batch 17: "show me what I have ..." prefix-variant of the same
  // agenda-query intent.
  if (/\bshow\s+me\s+what\s+i\s+have\s+(?:today|tomorrow|this\s+(?:week|morning|afternoon|evening)|on\s+\w+|next\s+\w+)\b/.test(folded)) return true;
  // Phase 9 batch 48 (2026-05-16): Spanish read patterns — "qué hay en mi
  // agenda", "mi agenda", "qué tengo (hoy|mañana|el viernes)".
  if (/\bqu[eé]\s+hay\s+en\s+(?:mi|la)\s+agenda\b/.test(folded)) return true;
  if (/\bqu[eé]\s+tengo\s+(?:hoy|ma[nñ]ana|el\s+\w+|esta\s+(?:semana|tarde|noche))\b/.test(folded)) return true;
  return false;
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
  const hasExplicitNextWeek = /\b(?:next\s+week|proxima\s+semana|la\s+proxima\s+semana|na\s+proxima\s+semana|para\s+a\s+proxima\s+semana)\b/.test(folded);
  // Phase 10 batch 50 (2026-05-16): weekday names checked FIRST. Spanish
  // "Programa una reunión el lunes a las 10 de la mañana" mixes a weekday
  // ("el lunes") with a time-of-day marker that contains the substring
  // "mañana". Previously the bare "mañana" check ran first and resolved
  // the date to tomorrow, shadowing the explicit weekday. Weekday is the
  // more specific signal, so it wins.
  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(folded)) continue;
    let candidate = base.set({ weekday: weekday as any }).startOf('day');
    if (candidate <= base.startOf('day')) candidate = candidate.plus({ weeks: 1 });
    if (hasExplicitNextWeek && candidate < base.plus({ weeks: 1 }).startOf('week')) {
      candidate = candidate.plus({ weeks: 1 });
    }
    return { day: candidate, matched: text.match(DATE_WORD_PATTERN)?.[0] };
  }

  // Day-after-tomorrow before plain tomorrow — "pasado mañana" contains
  // "mañana" as a substring; the longer phrase has to be checked first.
  if (/\b(depois de amanha|depois de amanhã|day after tomorrow|pasado\s+ma[nñ]ana)\b/.test(folded)) {
    return { day: base.plus({ days: 2 }).startOf('day'), matched: 'day_after_tomorrow' };
  }

  if (/\b(hoje|today|hoy)\b/.test(folded)) return { day: base.startOf('day'), matched: 'today' };

  if (hasExplicitNextWeek) {
    return { day: base.plus({ weeks: 1 }).startOf('week'), matched: 'next_week' };
  }

  // Spanish "mañana" gate: when "mañana" appears only as part of "de la
  // mañana" / "por la mañana" / "a la mañana", it is a time-of-day marker
  // ("in the morning"), NOT the date word "tomorrow". Strip those
  // instances before testing, so the bare-tomorrow check only fires when
  // there is a standalone "mañana".
  const datedFolded = folded.replace(/\b(?:de|por|a)\s+la\s+ma[nñ]ana\b/g, ' ');
  if (/\b(amanha|amanhã|tomorrow|ma[nñ]ana)\b/.test(datedFolded)) {
    return { day: base.plus({ days: 1 }).startOf('day'), matched: 'tomorrow' };
  }

  return null;
}

function parseSingleTime(raw: string): { hour: number; minute: number } | null {
  // Phase 10 batch 50: PM/AM detection runs on the original folded text
  // BEFORE the preposition strip — the strip removes "de"/"a" which would
  // otherwise wipe the "de la tarde" / "de la mañana" markers. Keep both
  // forms around: `foldedOrig` for marker detection, `folded` (stripped)
  // for numeric extraction.
  const foldedOrig = foldCalendarText(raw);
  const folded = foldedOrig
    .replace(/\b(horas?|hours?)\b/g, '')
    .replace(/\b(as|às|a|ao|ate|até|to|de|from|das|do|las|al|hasta|desde)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bmeia noite\b|\bmidnight\b/.test(folded)) {
    return { hour: 0, minute: /\b(meia|half|30)\b/.test(folded.replace('meia noite', '')) ? 30 : 0 };
  }
  if (/\bmeio dia\b|\bmeio-dia\b|\bnoon\b/.test(folded)) {
    return { hour: 12, minute: /\b(meia|meio|half|30)\b/.test(folded.replace(/meio[- ]dia|noon/g, '')) ? 30 : 0 };
  }

  // Negative lookahead `(?!\d)` instead of trailing `\b` so "2pm" / "2am"
  // parse correctly — a word boundary requires opposite character classes on
  // either side, which fails between a digit and a letter.
  const numeric = folded.match(/\b(\d{1,2})(?:\s*(?:h|:|\.|h)\s*(\d{2}))?(?!\d)/);
  let hour: number | null = numeric ? Number(numeric[1]) : null;
  let minute = numeric?.[2] ? Number(numeric[2]) : 0;
  if (hour == null) {
    const word = Object.keys(PT_NUMBER_WORDS).find((candidate) => new RegExp(`\\b${candidate}\\b`).test(folded));
    if (word) hour = PT_NUMBER_WORDS[word];
  }
  if (hour == null || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (/\b(meia|half)\b/.test(folded) && !numeric?.[2]) minute = 30;
  // Trailing-only word boundary on pm/am so "2pm" / "2am" parse correctly
  // (there is no word boundary between a digit and a letter; the leading
  // \b that the previous version used silently rejected this common form).
  // Phase 10 batch 50: Spanish "de la tarde"/"de la noche"/"de la mañana"
  // markers checked against `foldedOrig` (pre-strip) because the strip
  // pulls out "de" which the marker depends on.
  if (/(?:\bda tarde\b|\bda noite\b|pm\b|p\.m\.\b|de\s+la\s+tarde\b|de\s+la\s+noche\b|por\s+la\s+tarde\b|por\s+la\s+noche\b)/.test(foldedOrig) && hour >= 1 && hour <= 11) hour += 12;
  if (/(?:\bda manha\b|am\b|a\.m\.\b|de\s+la\s+ma[nñ]ana\b|por\s+la\s+ma[nñ]ana\b)/.test(foldedOrig) && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function extractTimeRange(text: string): { start: { hour: number; minute: number }; end: { hour: number; minute: number }; matched: string } | null {
  // Phase 10 batch 50 (2026-05-16): Spanish PM/AM tail added — "de la
  // tarde"/"de la noche"/"de la mañana" + "por la …" variants. extractTimeRange
  // runs on RAW text (not folded), so the accent variants matter:
  // `ma[nñ]ana` matches both "mañana" (raw) and "manana" (folded). Same
  // for `manh[aã]` covering "manhã"/"manha".
  // Trailing-'h' fix: the digit suffix after "h" is now optional, so
  // "14h" by itself parses as a complete time atom. Previously the
  // suffix required `\d{2}` after the 'h', which made "a las 14h" fail
  // the closing `\b` (the captured atom ended at "14" with 'h' still in
  // the way of the word boundary).
  const timeAtom = '(?:\\d{1,2}(?:\\s*(?:h(?:\\s*\\d{2})?|[:.]\\s*\\d{2}))?|meio[- ]dia(?:\\s+e\\s+mei[ao])?|meia[- ]noite|uma|um|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)(?:\\s+(?:da\\s+(?:manh[aã]|tarde|noite)|de\\s+la\\s+(?:ma[nñ]ana|tarde|noche)|por\\s+la\\s+(?:ma[nñ]ana|tarde|noche)))?';
  const directRange = text.match(new RegExp(`\\b(?:das?|de(?:\\s+las?)?|desde(?:\\s+las?)?|from)\\s+(${timeAtom})\\s+(?:às|as|a\\s+las?|aos?|ao|al|até|ate|hasta(?:\\s+las?)?|to|-|–)\\s+(${timeAtom})\\b`, 'i'));
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

  const duration = text.match(/(?:\b(?:as|at)|às)\s+(.{1,32}?)\s+(?:por|durante|for)\s+(\d{1,3})\s*(minutos?|mins?|horas?|hours?|h)\b/i);
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

  // Single-time fallback (audit §11 / shadow-parity follow-up 2026-05-15):
  // "Schedule a meeting for Friday at 2pm called weekly sync" supplies one
  // anchor time without a range. Default end to start + 1 hour. The guard
  // rejects this match if another time token follows (range case already
  // handled above), and requires the time to be preceded by "at"/"às"/"as"
  // to avoid catching bare digit literals (e.g., "Schedule 3 follow-ups").
  // Phase 10 batch 50: Spanish "a las"/"a la" prefix added. Note that
  // `\\bas\\b` cannot match the "as" inside "las" (both chars are word
  // chars → no boundary), so the alternation must spell out `a\\s+las?`
  // explicitly. Same for the negative lookahead.
  const singleTimeMatch = text.match(new RegExp(`(?:\\b(?:at|as|a\\s+las?)|às)\\s+(${timeAtom}\\s*(?:[ap]\\.?m\\.?)?)\\b(?!\\s*(?:to|-|–|até|ate|às|as|a\\s+las?|aos?|ao|al|hasta|por\\s+\\d))`, 'i'));
  if (singleTimeMatch) {
    const start = parseSingleTime(singleTimeMatch[1]);
    if (start) {
      const startDate = DateTime.fromObject({ hour: start.hour, minute: start.minute });
      const endDate = startDate.plus({ hours: 1 });
      return {
        start,
        end: { hour: endDate.hour, minute: endDate.minute },
        matched: singleTimeMatch[0],
      };
    }
  }

  return null;
}

function extractTitle(text: string, timeRangeText?: string): { title: string | null; matched?: string } {
  // Phase 10 batch 50: Spanish "llamad[oa]" title marker added alongside
  // PT "chamad[oa]" / EN "called|named". Spanish date words (lunes…viernes,
  // hoy, mañana, "el"/"la" articles) added to the lookahead so the title
  // boundary breaks on the Spanish date phrase that follows.
  const explicit = text.match(/\b(?:chamad[oa]|com o t[ií]tulo|t[ií]tulo\s*:|called|named|llamad[oa]|titulad[oa])\s+["']?(.+?)["']?(?=\s+(?:das?|de|from|às|as|at|a\s+las?|hoje|hoy|amanh[aã]|ma[nñ]ana|nesse|neste|este|pr[oó]xim[oa]|next|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|el\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|este\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|para\s+ma[nñ]ana|pasado\s+ma[nñ]ana)\b|[,.!?]|$)/i);
  if (explicit?.[1]) {
    const title = explicit[1].replace(EMAIL_PATTERN, '').trim();
    if (title) return { title, matched: explicit[0] };
  }

  let candidate = text;
  if (timeRangeText) candidate = candidate.replace(timeRangeText, ' ');
  const original = candidate;
  candidate = candidate
    .replace(EMAIL_PATTERN, ' ')
    .replace(NUMERIC_DATE_PATTERN, ' ')
    .replace(DATE_WORD_PATTERN, ' ')
    // Bare date words without a following weekday (e.g. "mañana" alone,
    // "tomorrow" alone) aren't covered by DATE_WORD_PATTERN, which
    // requires a weekday. Strip them here so they don't end up as the
    // residual title for phrases like "Agenda una cita para mañana a las 9".
    .replace(/\b(?:hoje|today|hoy|amanh[aã]|tomorrow|ma[nñ]ana|pasado\s+ma[nñ]ana|depois\s+de\s+amanh[aã]|day\s+after\s+tomorrow|next\s+week|pr[oó]xima\s+semana|la\s+pr[oó]xima\s+semana|na\s+pr[oó]xima\s+semana)\b/gi, ' ')
    // Phase 10 batch 50: Spanish verbs/articles added to the strip-list so
    // the residual candidate doesn't drag write verbs into the title.
    .replace(/\b(?:cria|criar|marca|marcar|agenda|agendar|adiciona|adicionar|colocar|coloca|mete|poe|faz|schedule|add|create|book|crea[r]?|programa[r]?|a[nñ]ade|agrega[r]?)\b/gi, ' ')
    .replace(/\b(?:um|uma|o|a|os|as|no|na|em|in|on|para|for|do|da|dia|the|meu|minha|my|evento|event|calend[aá]rio|calendar|agenda|google|gmail|outlook|un|una|el|la|los|las|reuni[oó]n|reunion|cita[s]?)\b/gi, ' ')
    // Spanish time-preposition + article tokens left over after date/time
    // stripping (e.g. "a las" with the digit already removed).
    .replace(/\b(?:a\s+las?|de\s+la|por\s+la|hasta\s+las?|desde\s+las?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, '')
    .trim();
  if (candidate) return { title: candidate };
  // Spanish currently supports an implicit-subject convention ("Agenda una
  // cita..." -> "Cita"). Do not apply it to Portuguese/English generic nouns:
  // "Cria um evento..." should ask for a real title instead of creating a
  // low-context event called "Evento".
  const spanishSyntax = /\b(?:programa(?:r)?|a[nñ]ade|agrega(?:r)?|crea(?:r)?|una?|el|la|los|las|lunes|martes|mi[eé]rcoles|jueves|viernes|ma[nñ]ana|pasado\s+ma[nñ]ana|cita|reuni[oó]n|reunion)\b/i.test(original);
  const objectMatch = original.match(/\b(reuni[oó]n|reunion|cita|evento)\b/i);
  if (spanishSyntax && objectMatch?.[1]) {
    const noun = objectMatch[1];
    return { title: noun.charAt(0).toUpperCase() + noun.slice(1).toLowerCase() };
  }
  return { title: null };
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
