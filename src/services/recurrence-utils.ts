// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

export type RecurrencePatternType = 'daily' | 'weekly' | 'absoluteMonthly';

export interface NormalizedRecurrence {
  pattern: {
    type: RecurrencePatternType;
    interval: number;
    daysOfWeek?: string[];
  };
  range: {
    type: 'noEnd';
    startDate: string;
  };
}

const WEEKDAY_TO_RRULE: Record<string, string> = {
  sunday: 'SU',
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
};

const ALLOWED_PATTERN_TYPES = new Set<RecurrencePatternType>([
  'daily',
  'weekly',
  'absoluteMonthly',
]);

const WEEKDAY_TO_LUXON: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const LUXON_TO_WEEKDAY: Record<number, string> = Object.fromEntries(
  Object.entries(WEEKDAY_TO_LUXON).map(([name, weekday]) => [weekday, name]),
);

export function normalizeMicrosoftRecurrence(
  value: unknown,
  startDate: Date | string,
): NormalizedRecurrence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as any;
  const pattern = raw.pattern && typeof raw.pattern === 'object' ? raw.pattern : null;
  if (!pattern) return undefined;

  const rawType = String(pattern.type || '');
  if (!ALLOWED_PATTERN_TYPES.has(rawType as RecurrencePatternType)) return undefined;

  const interval = Number.isFinite(Number(pattern.interval))
    ? Math.max(1, Math.min(365, Math.floor(Number(pattern.interval))))
    : 1;

  const normalized: NormalizedRecurrence = {
    pattern: {
      type: rawType as RecurrencePatternType,
      interval,
    },
    range: {
      type: 'noEnd',
      startDate: normalizeStartDate(raw.range?.startDate || startDate),
    },
  };

  if (normalized.pattern.type === 'weekly') {
    const days = Array.isArray(pattern.daysOfWeek)
      ? pattern.daysOfWeek
          .map((day: unknown) => String(day || '').toLowerCase().trim())
          .filter((day: string) => WEEKDAY_TO_RRULE[day])
      : [];
    if (days.length > 0) {
      normalized.pattern.daysOfWeek = Array.from(new Set(days));
    }
  }

  return normalized;
}

export function recurrenceToGoogleRRule(recurrence?: NormalizedRecurrence): string | undefined {
  if (!recurrence) return undefined;

  const parts: string[] = [];
  switch (recurrence.pattern.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      break;
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY');
      break;
    default:
      return undefined;
  }

  parts.push(`INTERVAL=${recurrence.pattern.interval || 1}`);

  if (recurrence.pattern.type === 'weekly' && recurrence.pattern.daysOfWeek?.length) {
    const byDay = recurrence.pattern.daysOfWeek
      .map((day) => WEEKDAY_TO_RRULE[day])
      .filter(Boolean);
    if (byDay.length > 0) {
      parts.push(`BYDAY=${byDay.join(',')}`);
    }
  }

  return `RRULE:${parts.join(';')}`;
}

export function realignMicrosoftRecurrenceForDueDate(
  recurrence: unknown,
  dueDateTime: string,
  timezone = 'UTC',
): NormalizedRecurrence | undefined {
  if (!recurrence || typeof recurrence !== 'object' || !dueDateTime) return undefined;

  const normalized = normalizeMicrosoftRecurrence(recurrence, dueDateTime);
  if (!normalized) return undefined;

  const dueLocal = parseTaskDue(dueDateTime, timezone);
  if (!dueLocal.isValid) return undefined;

  const aligned: NormalizedRecurrence = {
    pattern: { ...normalized.pattern },
    range: {
      ...normalized.range,
      startDate: dueLocal.toISODate() || normalized.range.startDate,
    },
  };

  if (aligned.pattern.type === 'weekly') {
    const days = aligned.pattern.daysOfWeek || [];
    // Nexus-created weekly tasks recur on a single weekday. If the user moves
    // that recurring task, realign the weekday as well as the range anchor so
    // the old date no longer projects as a second task.
    if (days.length <= 1) {
      const weekday = LUXON_TO_WEEKDAY[dueLocal.weekday];
      if (weekday) aligned.pattern.daysOfWeek = [weekday];
    }
  }

  return aligned;
}

export function expandRecurringTaskOccurrencesForRange<T extends Record<string, any>>(
  tasks: T[],
  startISO: string,
  endISO: string,
  opts?: { timezone?: string; maxOccurrencesPerTask?: number },
): T[] {
  const timezone = opts?.timezone || 'UTC';
  const rangeStart = parseBoundary(startISO, timezone, 'start');
  const rangeEnd = parseBoundary(endISO, timezone, 'end');
  if (!rangeStart.isValid || !rangeEnd.isValid || rangeEnd < rangeStart) return [];

  const maxOccurrencesPerTask = Math.max(1, Math.min(500, opts?.maxOccurrencesPerTask ?? 120));
  const output: T[] = [];

  for (const task of tasks) {
    const rawDue = extractTaskDue(task);
    const dueLocal = rawDue
      ? parseTaskDue(rawDue, timezone)
      : DateTime.fromISO(String((task.recurrence as any)?.range?.startDate || ''), { zone: timezone }).startOf('day');
    if (!dueLocal.isValid) continue;

    const recurrence = normalizeMicrosoftRecurrence(task.recurrence, rawDue || dueLocal.toISO()!);
    if (!recurrence) {
      if (dueLocal.toUTC() >= rangeStart.toUTC() && dueLocal.toUTC() <= rangeEnd.toUTC()) {
        output.push(task);
      }
      continue;
    }

    const anchor = DateTime.fromISO(recurrence.range.startDate, { zone: timezone })
      .set({
        hour: dueLocal.hour,
        minute: dueLocal.minute,
        second: dueLocal.second,
        millisecond: dueLocal.millisecond,
      });
    if (!anchor.isValid) continue;

    let occurrences = 0;
    for (
      let cursor = rangeStart.setZone(timezone).startOf('day');
      cursor <= rangeEnd.setZone(timezone).endOf('day') && occurrences < maxOccurrencesPerTask;
      cursor = cursor.plus({ days: 1 })
    ) {
      if (cursor.startOf('day') < anchor.startOf('day')) continue;
      if (!doesRecurrenceOccurOnDate(recurrence, anchor, cursor)) continue;

      const occurrence = cursor.set({
        hour: anchor.hour,
        minute: anchor.minute,
        second: anchor.second,
        millisecond: anchor.millisecond,
      });
      if (occurrence.toUTC() < rangeStart.toUTC() || occurrence.toUTC() > rangeEnd.toUTC()) continue;

      output.push(withProjectedDue(task, occurrence, timezone));
      occurrences += 1;
    }
  }

  return output.sort((lhs, rhs) => {
    const lhsDue = parseTaskDue(extractTaskDue(lhs) || '', timezone).toMillis();
    const rhsDue = parseTaskDue(extractTaskDue(rhs) || '', timezone).toMillis();
    return lhsDue - rhsDue;
  });
}

function normalizeStartDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

function parseBoundary(value: string, timezone: string, edge: 'start' | 'end'): DateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = DateTime.fromISO(value, { zone: timezone });
    return edge === 'start' ? day.startOf('day') : day.endOf('day');
  }
  const parsed = DateTime.fromISO(value, hasExplicitZone(value) ? { setZone: true } : { zone: timezone });
  return parsed.isValid ? parsed.setZone(timezone) : DateTime.fromISO(value, { zone: timezone });
}

function extractTaskDue(task: Record<string, any>): string | null {
  const raw = task?.dueDateTime?.dateTime || task?.dueDateTime || task?.dueDate;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function parseTaskDue(value: string, timezone: string): DateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return DateTime.fromISO(value, { zone: timezone }).startOf('day');
  }
  const parsed = DateTime.fromISO(value, hasExplicitZone(value) ? { setZone: true } : { zone: timezone });
  return parsed.isValid ? parsed.setZone(timezone) : DateTime.fromISO(value, { zone: timezone });
}

function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

function doesRecurrenceOccurOnDate(
  recurrence: NormalizedRecurrence,
  anchor: DateTime,
  date: DateTime,
): boolean {
  const interval = Math.max(1, recurrence.pattern.interval || 1);
  switch (recurrence.pattern.type) {
    case 'daily': {
      const days = Math.floor(date.startOf('day').diff(anchor.startOf('day'), 'days').days);
      return days >= 0 && days % interval === 0;
    }
    case 'weekly': {
      const weekdays = recurrence.pattern.daysOfWeek?.length
        ? recurrence.pattern.daysOfWeek.map((day) => WEEKDAY_TO_LUXON[day]).filter(Boolean)
        : [anchor.weekday];
      if (!weekdays.includes(date.weekday)) return false;
      const weeks = Math.floor(date.startOf('week').diff(anchor.startOf('week'), 'weeks').weeks);
      return weeks >= 0 && weeks % interval === 0;
    }
    case 'absoluteMonthly': {
      if (date.day !== anchor.day) return false;
      const months = (date.year - anchor.year) * 12 + (date.month - anchor.month);
      return months >= 0 && months % interval === 0;
    }
    default:
      return false;
  }
}

function withProjectedDue<T extends Record<string, any>>(task: T, occurrence: DateTime, timezone: string): T {
  const iso = occurrence.toUTC().toISO()!;
  const projected: Record<string, any> = {
    ...task,
    dueDateTime: typeof task.dueDateTime === 'object' && task.dueDateTime
      ? { ...task.dueDateTime, dateTime: iso, timeZone: timezone }
      : iso,
    recurrenceInstanceDate: occurrence.toISODate(),
  };
  if ('dueDate' in task) {
    projected.dueDate = iso;
  }
  return projected as T;
}
