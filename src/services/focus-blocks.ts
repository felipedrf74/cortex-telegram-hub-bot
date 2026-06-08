// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import type { CalendarSource, UnifiedCalendarEvent } from './unified-calendar';
import { getEvents, getEventsForSources } from './unified-calendar';
import { getUserTimezoneById } from './user-service';
import { getAppleHealthSleepAgendaEvents, type AppleHealthSleepAgendaEvent } from './health-sleep-agenda';

export interface FocusConflict {
  id: string;
  title: string;
  start: string;
  end: string;
  source: CalendarSource | 'apple_health' | null;
}

export interface FocusConflictPrecheckResult {
  status: 'clean' | 'conflicted' | 'unavailable';
  start: string;
  end: string;
  timezone: string;
  source: CalendarSource;
  conflicts: FocusConflict[];
  nextFreeSlot: { start: string; end: string } | null;
  warningCodes: string[];
  warnings: string[];
}

export interface PomodoroInterval {
  kind: 'focus' | 'rest';
  index: number;
  start: string;
  end: string;
  durationMinutes: number;
}

export function roundUpToNextQuarterHour(date: Date, timezone: string): Date {
  const dt = DateTime.fromJSDate(date).setZone(timezone);
  const minutes = dt.minute;
  const roundedMinute = Math.ceil(minutes / 15) * 15;
  const rounded = dt
    .set({ second: 0, millisecond: 0 })
    .plus({ hours: roundedMinute === 60 ? 1 : 0 })
    .set({ minute: roundedMinute === 60 ? 0 : roundedMinute });
  return rounded.toUTC().toJSDate();
}

export function buildPomodoroIntervals(input: {
  start: Date;
  blocks: number;
  timezone?: string;
}): PomodoroInterval[] {
  const timezone = input.timezone || 'UTC';
  const blocks = Math.max(1, Math.min(8, Math.round(input.blocks)));
  let cursor = DateTime.fromJSDate(input.start).setZone(timezone);
  const intervals: PomodoroInterval[] = [];
  for (let block = 1; block <= blocks; block += 1) {
    const focusStart = cursor;
    const focusEnd = focusStart.plus({ minutes: 25 });
    intervals.push(toInterval('focus', block, focusStart, focusEnd));
    cursor = focusEnd;

    const restMinutes = block % 4 === 0 ? 15 : 5;
    const restStart = cursor;
    const restEnd = restStart.plus({ minutes: restMinutes });
    intervals.push(toInterval('rest', block, restStart, restEnd));
    cursor = restEnd;
  }
  return intervals;
}

export function pomodoroDurationMinutes(blocks: number): number {
  return buildPomodoroIntervals({ start: new Date('2026-01-01T00:00:00Z'), blocks, timezone: 'UTC' })
    .reduce((sum, interval) => sum + interval.durationMinutes, 0);
}

export function buildPomodoroDescription(intervals: PomodoroInterval[], timezone: string): string {
  const lines = intervals.map((interval) => {
    const label = interval.kind === 'focus' ? `Focus ${interval.index}` : `Rest after block ${interval.index}`;
    const start = DateTime.fromISO(interval.start).setZone(timezone).toFormat('HH:mm');
    const end = DateTime.fromISO(interval.end).setZone(timezone).toFormat('HH:mm');
    return `- ${label}: ${start}-${end} (${interval.durationMinutes}m)`;
  });
  return [
    'Nexus Pomodoro focus block',
    '',
    ...lines,
    '',
    'Nexus category: pomodoro',
  ].join('\n');
}

export async function precheckFocusCalendarConflict(input: {
  userId: number;
  source: CalendarSource;
  start: string;
  end: string;
  timezone?: string;
  constrainToSource?: boolean;
}): Promise<FocusConflictPrecheckResult> {
  const timezone = input.timezone || getUserTimezoneById(input.userId);
  const start = DateTime.fromISO(input.start, { setZone: true });
  const end = DateTime.fromISO(input.end, { setZone: true });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) {
    return {
      status: 'unavailable',
      start: input.start,
      end: input.end,
      timezone,
      source: input.source,
      conflicts: [],
      nextFreeSlot: null,
      warningCodes: ['INVALID_FOCUS_WINDOW'],
      warnings: ['Focus block start and end must be valid ISO timestamps.'],
    };
  }

  try {
    const searchStart = start.minus({ hours: 2 }).toUTC().toISO()!;
    const searchEnd = end.plus({ hours: 12 }).toUTC().toISO()!;
    const providerEvents = input.constrainToSource
      ? await getEventsForSources(searchStart, searchEnd, input.userId, [input.source])
      : await getEvents(searchStart, searchEnd, input.userId);
    const sleepEvents = getAppleHealthSleepAgendaEvents({
      userId: input.userId,
      start: searchStart,
      end: searchEnd,
      timezone,
    });
    const events = [...providerEvents, ...sleepEvents];
    const conflicts = overlappingEvents(events, start.toUTC(), end.toUTC());
    const nextFreeSlot = conflicts.length > 0
      ? findNextFreeSlot(events, end, end.diff(start, 'minutes').minutes, timezone)
      : null;
    return {
      status: conflicts.length > 0 ? 'conflicted' : 'clean',
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      timezone,
      source: input.source,
      conflicts: conflicts.map(formatConflict),
      nextFreeSlot,
      warningCodes: conflicts.length > 0 ? ['FOCUS_SLOT_CONFLICT'] : [],
      warnings: conflicts.length > 0 ? ['The requested focus block overlaps existing calendar events.'] : [],
    };
  } catch {
    return {
      status: 'unavailable',
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      timezone,
      source: input.source,
      conflicts: [],
      nextFreeSlot: null,
      warningCodes: ['CALENDAR_CONFLICT_CHECK_UNAVAILABLE'],
      warnings: ['Calendar availability could not be checked right now.'],
    };
  }
}

function toInterval(kind: 'focus' | 'rest', index: number, start: DateTime, end: DateTime): PomodoroInterval {
  return {
    kind,
    index,
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    durationMinutes: Math.round(end.diff(start, 'minutes').minutes),
  };
}

type BusyEvent = UnifiedCalendarEvent | AppleHealthSleepAgendaEvent;

function overlappingEvents(events: BusyEvent[], startUtc: DateTime, endUtc: DateTime): BusyEvent[] {
  return events.filter((event) => {
    const eventStart = parseBoundary(event.start);
    const eventEnd = parseBoundary(event.end);
    if (!eventStart?.isValid || !eventEnd?.isValid) return false;
    return eventEnd.toMillis() > startUtc.toMillis() && eventStart.toMillis() < endUtc.toMillis();
  });
}

function findNextFreeSlot(
  events: BusyEvent[],
  after: DateTime,
  durationMinutes: number,
  timezone: string,
): { start: string; end: string } | null {
  let cursor = DateTime.fromJSDate(roundUpToNextQuarterHour(after.toJSDate(), timezone)).setZone(timezone);
  const horizon = cursor.plus({ hours: 12 });
  while (cursor.toMillis() < horizon.toMillis()) {
    const candidateEnd = cursor.plus({ minutes: durationMinutes });
    if (overlappingEvents(events, cursor.toUTC(), candidateEnd.toUTC()).length === 0) {
      return { start: cursor.toUTC().toISO()!, end: candidateEnd.toUTC().toISO()! };
    }
    cursor = cursor.plus({ minutes: 15 });
  }
  return null;
}

function parseBoundary(value: string | undefined): DateTime | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return DateTime.fromISO(value, { zone: 'utc' });
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toUTC() : null;
}

function formatConflict(event: BusyEvent): FocusConflict {
  const raw: any = event;
  return {
    id: String(event.id || ''),
    title: String(event.summary || raw.title || raw.subject || '(No title)'),
    start: String(event.start || ''),
    end: String(event.end || ''),
    source: event.source ?? null,
  };
}
