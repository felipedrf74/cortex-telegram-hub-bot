// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { UnifiedCalendarEvent } from './unified-calendar';

export interface CalendarConflictPair {
  first: UnifiedCalendarEvent;
  second: UnifiedCalendarEvent;
}

/**
 * Finds every overlapping pair in one calendar window. Unlike an adjacent-only comparison, the
 * forward scan continues through all events that start before the current event ends, so a long
 * commitment overlapping multiple nested events cannot hide the later conflicts.
 */
export function findCalendarConflictPairs(events: UnifiedCalendarEvent[]): CalendarConflictPair[] {
  const validEvents = events.filter(hasValidWindow);
  const sorted = [...new Map(validEvents.map((event) => [eventKey(event), event])).values()]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end) || a.id.localeCompare(b.id));
  const pairs: CalendarConflictPair[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const first = sorted[index];
    const firstEnd = Date.parse(first.end);
    for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
      const second = sorted[otherIndex];
      if (Date.parse(second.start) >= firstEnd) break;
      if (!windowsOverlap(first, second)) continue;
      const key = conflictPairKey(first, second);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ first, second });
    }
  }
  return pairs;
}

export function conflictPairKey(first: UnifiedCalendarEvent, second: UnifiedCalendarEvent): string {
  return [eventKey(first), eventKey(second)].sort().join('|');
}

function eventKey(event: UnifiedCalendarEvent): string {
  return `${event.source}:${event.id}:${new Date(event.start).toISOString()}:${new Date(event.end).toISOString()}`;
}

function hasValidWindow(event: UnifiedCalendarEvent): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function windowsOverlap(first: UnifiedCalendarEvent, second: UnifiedCalendarEvent): boolean {
  return Date.parse(first.start) < Date.parse(second.end) && Date.parse(second.start) < Date.parse(first.end);
}
