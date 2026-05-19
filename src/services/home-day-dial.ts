// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { getUserTimezoneById } from './user-service';
import { getAppleHealthSleepCycles } from './health-sleep-agenda';

export type DayDialSegmentKind = 'meet' | 'focus' | 'train' | 'eat' | 'sleep' | 'open';

export interface DayDialSegment {
  kind: DayDialSegmentKind;
  start: string;
  end: string;
  minutes: number;
  title: string | null;
}

export interface DayDialTotal {
  kind: DayDialSegmentKind;
  minutes: number;
  hours: number;
  unavailable?: boolean;
}

export interface DayDialModel {
  date: string;
  timezone: string;
  generatedAt: string;
  segments: DayDialSegment[];
  totals: DayDialTotal[];
  warningCodes: string[];
  warnings: string[];
}

type CalendarLikeEvent = {
  id?: string;
  title?: string;
  summary?: string;
  subject?: string;
  start?: string;
  end?: string;
  rawStart?: string;
  rawEnd?: string;
  source?: string | null;
  categories?: string[] | null;
  category?: string | null;
};

const ORDER: DayDialSegmentKind[] = ['meet', 'focus', 'train', 'eat', 'sleep', 'open'];

export function buildHomeDayDial(input: {
  userId: number;
  calendarEvents: CalendarLikeEvent[];
  date?: string;
  timezone?: string;
}): DayDialModel {
  const timezone = input.timezone || getUserTimezoneById(input.userId);
  const localDay = input.date
    ? DateTime.fromISO(input.date, { zone: timezone })
    : DateTime.now().setZone(timezone);
  const dayStart = localDay.startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const segments: DayDialSegment[] = [];

  for (const event of input.calendarEvents || []) {
    if (isAppleHealthSleepEvent(event)) continue;
    const clipped = clipToDay(event.rawStart ?? event.start, event.rawEnd ?? event.end, dayStart, dayEnd, timezone);
    if (!clipped) continue;
    const kind = classifyEvent(event);
    segments.push({
      kind,
      start: clipped.start.toUTC().toISO()!,
      end: clipped.end.toUTC().toISO()!,
      minutes: Math.round(clipped.end.diff(clipped.start, 'minutes').minutes),
      title: event.title || event.summary || event.subject || null,
    });
  }

  const sleepCycles = getAppleHealthSleepCycles({
    userId: input.userId,
    start: dayStart.toUTC().toISO()!,
    end: dayEnd.toUTC().toISO()!,
    timezone,
  });
  segments.push(...sleepCycles.map((cycle) => ({
    kind: 'sleep' as const,
    start: cycle.start,
    end: cycle.end,
    minutes: cycle.minutes,
    title: 'Sleep',
  })));
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  if (sleepCycles.length === 0) {
    warningCodes.push('SLEEP_DATA_UNAVAILABLE');
    warnings.push('Sleep data is unavailable for this day.');
  }

  const occupiedMinutes = clampMinutes(sumMinutes(segments.filter((segment) => segment.kind !== 'open')), 0, 1440);
  if (occupiedMinutes < 1440) {
    segments.push({
      kind: 'open',
      start: dayStart.toUTC().toISO()!,
      end: dayEnd.toUTC().toISO()!,
      minutes: 1440 - occupiedMinutes,
      title: null,
    });
  }

  const totals = ORDER.map((kind) => {
    const minutes = clampMinutes(sumMinutes(segments.filter((segment) => segment.kind === kind)), 0, 1440);
    return {
      kind,
      minutes,
      hours: Math.round((minutes / 60) * 10) / 10,
      ...(kind === 'sleep' && sleepCycles.length === 0 ? { unavailable: true } : {}),
    };
  });

  return {
    date: dayStart.toISODate()!,
    timezone,
    generatedAt: DateTime.utc().toISO()!,
    segments: segments.sort((a, b) => a.start.localeCompare(b.start)),
    totals,
    warningCodes,
    warnings,
  };
}

function classifyEvent(event: CalendarLikeEvent): DayDialSegmentKind {
  const text = [
    event.title,
    event.summary,
    event.subject,
    event.category,
    ...(Array.isArray(event.categories) ? event.categories : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bsleep\b|\bsono\b/.test(text)) return 'sleep';
  if (/\b(nexus category:\s*)?pomodoro\b|\bfocus\b|deep work|bloqueio|foco/.test(text)) return 'focus';
  if (/training|workout|run\b|gym|strength|swim|bike|treino|corrida|academia/.test(text)) return 'train';
  if (/meal|lunch|dinner|breakfast|eat|almo[cç]o|jantar|caf[eé]/.test(text)) return 'eat';
  return 'meet';
}

function isAppleHealthSleepEvent(event: CalendarLikeEvent): boolean {
  return event.source === 'apple_health'
    || String(event.category || '').toLowerCase() === 'sleep'
    || (Array.isArray(event.categories) && event.categories.some((category) => String(category).toLowerCase() === 'sleep'));
}

function clipToDay(
  startRaw: unknown,
  endRaw: unknown,
  dayStart: DateTime,
  dayEnd: DateTime,
  timezone: string,
): { start: DateTime; end: DateTime } | null {
  const start = parseBoundary(startRaw, timezone);
  const end = parseBoundary(endRaw, timezone);
  if (!start?.isValid || !end?.isValid || end <= start) return null;
  const clippedStart = start < dayStart ? dayStart : start;
  const clippedEnd = end > dayEnd ? dayEnd : end;
  if (clippedEnd <= clippedStart) return null;
  return { start: clippedStart, end: clippedEnd };
}

function parseBoundary(value: unknown, timezone: string): DateTime | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return DateTime.fromISO(raw, { zone: timezone }).startOf('day');
  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (parsed.isValid) return parsed.setZone(timezone);
  const local = DateTime.fromISO(raw, { zone: timezone });
  return local.isValid ? local : null;
}

function sumMinutes(segments: DayDialSegment[]): number {
  return segments.reduce((sum, segment) => sum + Math.max(0, segment.minutes || 0), 0);
}

function clampMinutes(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
