// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';

type DateTimeExtractionInput = {
  timezone: string;
  nowIso?: string;
};

type TimeParts = {
  hour: number;
  minute: number;
};

const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(monday|segunda(?:-feira)?|lunes)\b/, 1],
  [/\b(tuesday|terca(?:-feira)?|ter[cç]a(?:-feira)?|martes)\b/, 2],
  [/\b(wednesday|quarta(?:-feira)?|miercoles|mi[eé]rcoles)\b/, 3],
  [/\b(thursday|quinta(?:-feira)?|jueves)\b/, 4],
  [/\b(friday|sexta(?:-feira)?|viernes)\b/, 5],
  [/\b(saturday|sabado|s[aá]bado)\b/, 6],
  [/\b(sunday|domingo)\b/, 7],
];

export function extractContentScheduleDateTime(text: string, input: DateTimeExtractionInput): string | null {
  const zone = input.timezone || 'UTC';
  const now = baseNow(input.nowIso, zone);
  const explicit = extractExplicitIsoDateTime(text, zone);
  if (explicit) return explicit;

  const folded = foldCalendarText(text);
  const date = extractDate(folded, now);
  if (!date) return null;
  const time = extractTime(folded) ?? inferDayPartTime(folded) ?? { hour: 9, minute: 0 };
  const dateTime = date.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  return dateTime.isValid ? dateTime.toISO() : null;
}

export function extractContentScheduleTitle(text: string, fallback: string): string {
  const title = fallback
    .replace(/\s+\b(?:for|para|em|en)\s+(?:today|tomorrow|day after tomorrow|hoje|amanh[aã]|depois de amanh[aã]|ma[nñ]ana|pasado\s+ma[nñ]ana|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes)\b.*$/i, '')
    .replace(/\s+\b(?:at|às|as|a las)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b.*$/i, '')
    .trim();
  return title.length >= 3 ? title : fallback.trim();
}

function baseNow(nowIso: string | undefined, zone: string): DateTime {
  const parsed = nowIso
    ? DateTime.fromISO(nowIso, { setZone: true }).setZone(zone)
    : DateTime.now().setZone(zone);
  return parsed.isValid ? parsed : DateTime.now().setZone(zone);
}

function extractExplicitIsoDateTime(text: string, zone: string): string | null {
  const match = text.match(/\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?\b/);
  if (!match) return null;
  const normalized = match[0].replace(' ', 'T');
  // Offset-less ISO input is wall-clock time in the user's zone, not in the
  // server process zone. Explicit offsets still retain their source zone here
  // and are converted to the requested user zone below.
  const parsed = DateTime.fromISO(normalized, { zone, setZone: true });
  if (!parsed.isValid) return null;
  return parsed.setZone(zone).toISO();
}

function extractDate(folded: string, now: DateTime): DateTime | null {
  if (/\b(day after tomorrow|depois de amanha|pasado\s+manana)\b/.test(folded)) {
    return now.plus({ days: 2 }).startOf('day');
  }
  if (/\b(tomorrow|amanha|manana)\b/.test(folded)) {
    return now.plus({ days: 1 }).startOf('day');
  }
  if (/\b(today|hoje|hoy)\b/.test(folded)) {
    return now.startOf('day');
  }

  const ymd = folded.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (ymd) {
    const parsed = DateTime.fromObject({
      year: Number(ymd[1]),
      month: Number(ymd[2]),
      day: Number(ymd[3]),
    }, { zone: now.zoneName ?? 'UTC' });
    return parsed.isValid ? parsed.startOf('day') : null;
  }

  const dmy = folded.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (dmy) {
    const yearRaw = dmy[3] ? Number(dmy[3]) : now.year;
    const parsed = DateTime.fromObject({
      year: yearRaw < 100 ? 2000 + yearRaw : yearRaw,
      month: Number(dmy[2]),
      day: Number(dmy[1]),
    }, { zone: now.zoneName ?? 'UTC' });
    if (parsed.isValid) return parsed.startOf('day');
  }

  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(folded)) continue;
    let daysAhead = weekday - now.weekday;
    if (daysAhead <= 0 || /\bnext|proxim[oa]|proxima|proximo\b/.test(folded)) daysAhead += 7;
    return now.plus({ days: daysAhead }).startOf('day');
  }
  return null;
}

function extractTime(folded: string): TimeParts | null {
  const hourMinute = folded.match(/\b(?:at|as|a las|para|for)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (hourMinute) return normalizeTime(Number(hourMinute[1]), Number(hourMinute[2]), hourMinute[3]);

  const hourH = folded.match(/\b(?:as|a las|at)?\s*(\d{1,2})h(?:(\d{2}))?\b/);
  if (hourH) return normalizeTime(Number(hourH[1]), Number(hourH[2] ?? 0), undefined);

  const amPm = folded.match(/\b(?:at|as|a las|para|for)?\s*(\d{1,2})\s*(am|pm)\b/);
  if (amPm) return normalizeTime(Number(amPm[1]), 0, amPm[2]);
  return null;
}

function inferDayPartTime(folded: string): TimeParts | null {
  if (/\b(morning|manha|manana)\b/.test(folded)) return { hour: 9, minute: 0 };
  if (/\b(afternoon|tarde)\b/.test(folded)) return { hour: 14, minute: 0 };
  if (/\b(evening|night|noite|noche)\b/.test(folded)) return { hour: 18, minute: 0 };
  return null;
}

function normalizeTime(hour: number, minute: number, marker: string | undefined): TimeParts | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  let normalizedHour = hour;
  if (marker === 'pm' && normalizedHour < 12) normalizedHour += 12;
  if (marker === 'am' && normalizedHour === 12) normalizedHour = 0;
  if (normalizedHour < 0 || normalizedHour > 23) return null;
  return { hour: normalizedHour, minute };
}
