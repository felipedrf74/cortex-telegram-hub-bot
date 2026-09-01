// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';

const DEFAULT_TRAINING_TIMEZONE = 'Europe/Lisbon';

const WEEKDAY_KEYS: Record<string, string> = {
  sunday: 'sunday',
  sun: 'sunday',
  domingo: 'sunday',
  monday: 'monday',
  mon: 'monday',
  segunda: 'monday',
  segunda_feira: 'monday',
  lunes: 'monday',
  tuesday: 'tuesday',
  tue: 'tuesday',
  tues: 'tuesday',
  terca: 'tuesday',
  terca_feira: 'tuesday',
  martes: 'tuesday',
  wednesday: 'wednesday',
  wed: 'wednesday',
  quarta: 'wednesday',
  quarta_feira: 'wednesday',
  miercoles: 'wednesday',
  thursday: 'thursday',
  thu: 'thursday',
  thurs: 'thursday',
  quinta: 'thursday',
  quinta_feira: 'thursday',
  jueves: 'thursday',
  friday: 'friday',
  fri: 'friday',
  sexta: 'friday',
  sexta_feira: 'friday',
  viernes: 'friday',
  saturday: 'saturday',
  sat: 'saturday',
  sabado: 'saturday',
};

export interface TrainingDayResolution {
  date: string;
  weekdayName: string;
  weekdayKey: string;
  timezone: string;
}

export function resolveTrainingDay(options: {
  now?: Date;
  timezone?: string | null;
  offsetDays?: number;
} = {}): TrainingDayResolution {
  const timezone = resolveTrainingTimezone(options.timezone);
  const base = DateTime.fromJSDate(options.now ?? new Date(), { zone: timezone });
  const local = (base.isValid ? base : DateTime.fromJSDate(options.now ?? new Date(), { zone: DEFAULT_TRAINING_TIMEZONE }))
    .plus({ days: options.offsetDays ?? 0 })
    .startOf('day');
  const weekdayName = local.setLocale('en-US').toFormat('cccc');

  return {
    date: local.toISODate() ?? '',
    weekdayName,
    weekdayKey: canonicalTrainingWeekdayKey(weekdayName),
    timezone,
  };
}

export function resolveTrainingPlanStartDate(
  now: Date,
  startPolicy: 'next_full_week' | 'today',
  schedulingTimezone?: string | null,
): string {
  const zone = resolveTrainingTimezone(schedulingTimezone);
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  if (!today.isValid) return now.toISOString().slice(0, 10);

  // Luxon weekday is 1=Monday ... 7=Sunday. A full training week begins
  // on Monday; when today is Monday, starting today is already a full week.
  const daysUntilMonday = (8 - today.weekday) % 7;
  if (startPolicy === 'today') {
    // A Sunday "today" request cannot produce an active week-1 schedule in
    // the Monday-start planner: every generated Mon-Sat slot is already in
    // the past and the linter correctly blocks the empty first week. Treat
    // Sunday as the next usable training-week anchor while preserving true
    // same-day starts for Monday-Saturday.
    const anchor = today.weekday === 7 ? today.plus({ days: daysUntilMonday || 1 }) : today;
    return anchor.toISODate() ?? today.toISODate() ?? now.toISOString().slice(0, 10);
  }
  return today.plus({ days: daysUntilMonday }).toISODate() ?? today.toISODate() ?? now.toISOString().slice(0, 10);
}

export function canonicalTrainingWeekdayKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return WEEKDAY_KEYS[normalized] ?? normalized;
}

export function trainingWeekdayMatches(value: unknown, day: TrainingDayResolution): boolean {
  return canonicalTrainingWeekdayKey(value) === day.weekdayKey;
}

export function isStrictIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isPastIsoDate(
  value: string,
  now: Date = new Date(),
  timezone?: string | null,
): boolean {
  const zone = resolveTrainingTimezone(timezone);
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const candidate = DateTime.fromISO(value, { zone }).startOf('day');
  return candidate.isValid && candidate < today;
}

/** True only when the ISO calendar date is later than the user-local day. */
export function isFutureIsoDate(
  value: string,
  now: Date = new Date(),
  timezone?: string | null,
): boolean {
  const zone = resolveTrainingTimezone(timezone);
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const candidate = DateTime.fromISO(value, { zone }).startOf('day');
  return candidate.isValid && candidate > today;
}

/**
 * Tolerant timezone normalization for trusted/persisted runtime context.
 * Public settings input is strictly validated at its route boundary; this
 * helper protects scheduling reads from legacy or corrupt stored values.
 */
export function normalizeTrainingTimezone(value: string | null | undefined): string | null {
  const timezone = typeof value === 'string' ? value.trim() : '';
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

/** Resolve a scheduling zone with one canonical app fallback. */
export function resolveTrainingTimezone(value?: string | null): string {
  return normalizeTrainingTimezone(value)
    ?? normalizeTrainingTimezone(config.app.timezone)
    ?? DEFAULT_TRAINING_TIMEZONE;
}

/**
 * Resolve an immutable plan scheduling zone before considering a live user or
 * app fallback. Plans created before F11 may not have the persisted field, so
 * malformed/legacy preference payloads deliberately fall through safely.
 */
export function resolveTrainingPlanTimezone(
  plan: { preferences_json?: string | null } | null | undefined,
  fallback?: string | null,
): string {
  let persistedTimezone: string | null = null;
  if (typeof plan?.preferences_json === 'string' && plan.preferences_json.trim()) {
    try {
      const preferences = JSON.parse(plan.preferences_json) as unknown;
      if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
        persistedTimezone = normalizeTrainingTimezone(
          (preferences as Record<string, unknown>).schedulingTimezone as string | null | undefined,
        );
      }
    } catch {
      // Legacy/corrupt preference blobs must not break plan reads.
    }
  }

  return resolveTrainingTimezone(persistedTimezone ?? fallback);
}
