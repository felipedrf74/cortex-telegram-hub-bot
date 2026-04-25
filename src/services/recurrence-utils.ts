// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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
