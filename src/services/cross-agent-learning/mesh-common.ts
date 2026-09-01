// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Shared deterministic primitives for tenant-safe domain mesh adapters. */

import { DateTime } from 'luxon';
import type { UnifiedCalendarEvent } from '../unified-calendar';
import { recordTenantScopeAnomaly } from '../tenant-scope-observability';
import { resolveTrainingTimezone } from '../training-date-utils';

export function reportInvalidMeshScope(operation: string, userId: number | null | undefined, weekStart?: string): void {
  recordTenantScopeAnomaly({
    layer: 'mesh_context',
    operation,
    reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
    userId: userId ?? null,
    details: {
      weekStart: weekStart ?? null,
    },
  });
}

export interface WeekWindow {
  start: DateTime;
  end: DateTime;
  weekStart: string;
  weekEnd: string;
}

export function resolveWeekWindow(
  weekStart?: string,
  timezone?: string | null,
  referenceNow?: string | null,
): WeekWindow {
  const zone = resolveTrainingTimezone(timezone);
  const parsedReference = referenceNow
    ? DateTime.fromISO(referenceNow, { setZone: true }).setZone(zone)
    : DateTime.invalid('missing request clock');
  const requestNow = parsedReference.isValid ? parsedReference : DateTime.now().setZone(zone);
  const base = weekStart
    ? DateTime.fromISO(weekStart, { zone }).startOf('day')
    : requestNow.startOf('week');
  const start = (base.isValid ? base : requestNow).startOf('week');
  const end = start.plus({ days: 6 }).endOf('day');
  return {
    start,
    end,
    weekStart: start.toISODate()!,
    weekEnd: start.plus({ days: 6 }).toISODate()!,
  };
}

export function weekIsoDates(start: DateTime): string[] {
  return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }).toISODate()!);
}

export function summarizeBusyDates(events: UnifiedCalendarEvent[], timezone?: string | null): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = eventDateInTimezone(event.start, timezone);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([date]) => date)
    .sort();
}

export function extractTravelDates(events: UnifiedCalendarEvent[], timezone?: string | null): string[] {
  const regex = /\b(flight|airport|hotel|travel|trip|voo|aeroporto|hotel|viagem)\b/i;
  return uniqueStrings(events
    .filter((event) => regex.test(String(event.summary ?? '')))
    .map((event) => eventDateInTimezone(event.start, timezone))
    .filter((date): date is string => Boolean(date)));
}

export function summarizeCalendarFragmentation(events: UnifiedCalendarEvent[], timezone?: string | null): {
  fragmentedDates: string[];
  maxEventsInDay: number;
} {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = eventDateInTimezone(event.start, timezone);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  return {
    fragmentedDates: entries
      .filter(([, count]) => count >= 4)
      .map(([date]) => date)
      .sort(),
    maxEventsInDay: entries.reduce((max, [, count]) => Math.max(max, count), 0),
  };
}

function eventDateInTimezone(value: string, timezone?: string | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // Provider all-day values are already local calendar dates and must not be
  // shifted through UTC. Timed values are projected into the user's zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = DateTime.fromISO(
    raw,
    hasExplicitZone ? { setZone: true } : { zone: resolveTrainingTimezone() },
  );
  if (!parsed.isValid) return null;
  return parsed.setZone(resolveTrainingTimezone(timezone)).toISODate();
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function endOfDayIso(date: DateTime): string {
  return date.endOf('day').toUTC().toISO()!;
}

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export async function safelyAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
