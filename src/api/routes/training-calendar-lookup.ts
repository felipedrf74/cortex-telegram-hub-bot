// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getEvents } from '../../services/unified-calendar';

// Hardening audit 2026-04-20: `/training/home` runs `getTodaySession`
// and `getWeekPlan` in parallel via Promise.allSettled. Both call
// buildCalendarEventLookup with the SAME (userId, range) because the
// range is derived from the same active-plan metadata. The old code
// fired TWO independent Google+Outlook round-trips per request — each
// ~150-350ms — measured in the audit as 300-700ms of redundant wait.
//
// Rather than a result cache (which risks cross-request staleness),
// coalesce the in-flight Promise: the first caller starts the fetch,
// every subsequent caller with the same key awaits that same Promise.
// The Promise is cleared from the map as soon as it settles, so memory
// doesn't grow unbounded.
//
// Short TTL window (2s) accounts for request chains: if a second call
// comes in immediately AFTER the first settled (e.g. from a different
// handler in the same req), we still serve from the result cache for
// 2 seconds. Longer than that and we re-fetch because calendar data
// CAN change inside a request chain (e.g. after createEvent).
const CALENDAR_LOOKUP_COALESCE_TTL_MS = 2_000;

export type TrainingCalendarLookup = Map<string, { time: string | null; event: any }>;

const calendarLookupInflight = new Map<string, Promise<TrainingCalendarLookup>>();
const calendarLookupRecent = new Map<string, { value: TrainingCalendarLookup; expiresAt: number }>();

export async function buildCalendarEventLookup(
  start: Date,
  end: Date,
  userId: number,
): Promise<TrainingCalendarLookup> {
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const key = `${userId}:${startIso}:${endIso}`;

  // 1) Recent-result short window — reuse if we finished within TTL.
  const recent = calendarLookupRecent.get(key);
  if (recent && recent.expiresAt > Date.now()) {
    return recent.value;
  }

  // 2) In-flight coalescing — if another caller is already fetching
  // the same range, await their Promise rather than firing our own.
  const inflight = calendarLookupInflight.get(key);
  if (inflight) return inflight;

  // 3) Fresh fetch — record the Promise so parallel callers share it.
  const fetchPromise = (async () => {
    const lookup: TrainingCalendarLookup = new Map();
    const events = await getEvents(startIso, endIso, userId);
    for (const event of events || []) {
      if (!event?.id) continue;
      const timeMatch = String(event.start || '').match(/T(\d{2}:\d{2})/);
      lookup.set(event.id, {
        time: timeMatch ? timeMatch[1] : null,
        event,
      });
    }
    return lookup;
  })();

  calendarLookupInflight.set(key, fetchPromise);
  try {
    const lookup = await fetchPromise;
    calendarLookupRecent.set(key, {
      value: lookup,
      expiresAt: Date.now() + CALENDAR_LOOKUP_COALESCE_TTL_MS,
    });
    return lookup;
  } finally {
    calendarLookupInflight.delete(key);
  }
}

export function resetCalendarLookupCoalesceForTests(): void {
  calendarLookupInflight.clear();
  calendarLookupRecent.clear();
}
