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
  const timezone = normalizeTimezone(options.timezone) ?? normalizeTimezone(config.app.timezone) ?? DEFAULT_TRAINING_TIMEZONE;
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

export function isPastIsoDate(value: string, now: Date = new Date()): boolean {
  const today = DateTime.fromJSDate(now, { zone: 'UTC' }).startOf('day');
  const candidate = DateTime.fromISO(value, { zone: 'UTC' }).startOf('day');
  return candidate.isValid && candidate < today;
}

function normalizeTimezone(value: string | null | undefined): string | null {
  const timezone = typeof value === 'string' ? value.trim() : '';
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}
