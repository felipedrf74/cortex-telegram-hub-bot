// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Shared deterministic primitives for tenant-safe domain mesh adapters. */

import { DateTime } from 'luxon';
import { config } from '../../config';
import type { UnifiedCalendarEvent } from '../unified-calendar';
import { recordTenantScopeAnomaly } from '../tenant-scope-observability';

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

export function resolveWeekWindow(weekStart?: string): WeekWindow {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const base = weekStart
    ? DateTime.fromISO(weekStart, { zone }).startOf('day')
    : DateTime.now().setZone(zone).startOf('week');
  const start = (base.isValid ? base : DateTime.now().setZone(zone)).startOf('week');
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

export function summarizeBusyDates(events: UnifiedCalendarEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = String(event.start).slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([date]) => date)
    .sort();
}

export function extractTravelDates(events: UnifiedCalendarEvent[]): string[] {
  const regex = /\b(flight|airport|hotel|travel|trip|voo|aeroporto|hotel|viagem)\b/i;
  return uniqueStrings(events
    .filter((event) => regex.test(String(event.summary ?? '')))
    .map((event) => String(event.start).slice(0, 10)));
}

export function summarizeCalendarFragmentation(events: UnifiedCalendarEvent[]): {
  fragmentedDates: string[];
  maxEventsInDay: number;
} {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = String(event.start).slice(0, 10);
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
