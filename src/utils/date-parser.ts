// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime, WeekdayNumbers } from 'luxon';
import { config } from '../config';

const tz = config?.app?.timezone || 'Europe/Lisbon';

export function now(): DateTime {
  return DateTime.now().setZone(tz);
}

export function todayISO(): string {
  return now().toISODate()!;
}

export function nowISO(): string {
  return now().toISO()!;
}

export function formatDate(isoDate: string): string {
  const dt = DateTime.fromISO(isoDate).setZone(tz);
  return dt.toFormat('ccc LLL dd');
}

export function formatDateTime(isoDate: string): string {
  const dt = DateTime.fromISO(isoDate).setZone(tz);
  return dt.toFormat('ccc LLL dd, HH:mm');
}

export function formatTime(isoDate: string): string {
  const dt = DateTime.fromISO(isoDate).setZone(tz);
  return dt.toFormat('HH:mm');
}

export function parseNaturalDate(text: string): string | null {
  const lower = text.toLowerCase().trim();
  const current = now();

  // Use end-of-day so tasks/reminders due "today" don't appear overdue immediately
  if (lower === 'today') return current.endOf('day').toISO()!;
  if (lower === 'tomorrow') return current.plus({ days: 1 }).endOf('day').toISO()!;
  if (lower === 'next week') return current.plus({ weeks: 1 }).startOf('week').endOf('day').toISO()!;

  const dayNames: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
    friday: 5, saturday: 6, sunday: 7,
  };

  for (const [name, isoDay] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      let target = current.set({ weekday: isoDay as WeekdayNumbers });
      if (target <= current) target = target.plus({ weeks: 1 });

      const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3]?.toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        target = target.set({ hour, minute, second: 0 });
      }
      return target.toISO()!;
    }
  }

  // Try ISO parse
  const parsed = DateTime.fromISO(text, { zone: tz });
  if (parsed.isValid) return parsed.toISO()!;

  // Try common formats
  for (const fmt of ['dd/MM/yyyy HH:mm', 'dd-MM-yyyy HH:mm', 'yyyy-MM-dd HH:mm', 'dd/MM/yyyy', 'dd-MM-yyyy']) {
    const attempt = DateTime.fromFormat(text, fmt, { zone: tz });
    if (attempt.isValid) return attempt.toISO()!;
  }

  return null;
}

export function startOfDay(dt?: DateTime): string {
  return (dt || now()).startOf('day').toISO()!;
}

export function endOfDay(dt?: DateTime): string {
  return (dt || now()).endOf('day').toISO()!;
}

export function startOfWeek(dt?: DateTime): string {
  return (dt || now()).startOf('week').toISO()!;
}

export function endOfWeek(dt?: DateTime): string {
  return (dt || now()).endOf('week').toISO()!;
}
