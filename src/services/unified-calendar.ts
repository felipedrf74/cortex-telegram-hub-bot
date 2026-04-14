// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as googleCal from './google-calendar';
import * as outlookCal from './outlook-calendar';
import { logger } from '../utils/logger';

export type CalendarSource = 'google' | 'outlook';

export interface UnifiedCalendarEvent extends googleCal.CalendarEvent {
  source: CalendarSource;
  /** When the same event exists on multiple calendars, lists all sources. */
  syncedSources?: CalendarSource[];
}

export function isAnyCalendarConfigured(): boolean {
  return googleCal.isGoogleCalendarConfigured() || outlookCal.isOutlookCalendarConfigured();
}

export function hasWritableCalendarForUser(userId?: number): boolean {
  if (userId) {
    try {
      const { isConnected } = require('./oauth-store');
      if (isConnected(userId, 'outlook') || isConnected(userId, 'google')) {
        return true;
      }
    } catch {
      // Fall back to the global owner-configured providers below.
    }
  }
  return isAnyCalendarConfigured();
}

export function getConfiguredSources(): CalendarSource[] {
  const sources: CalendarSource[] = [];
  if (googleCal.isGoogleCalendarConfigured()) sources.push('google');
  if (outlookCal.isOutlookCalendarConfigured()) sources.push('outlook');
  return sources;
}

export async function getEvents(startDate: string, endDate: string, userId?: number): Promise<UnifiedCalendarEvent[]> {
  const events: UnifiedCalendarEvent[] = [];

  // Fetch from both in parallel
  const promises: Promise<void>[] = [];

  if (googleCal.isGoogleCalendarConfigured()) {
    promises.push(
      googleCal.getEvents(startDate, endDate)
        .then((gEvents) => {
          for (const e of gEvents) {
            events.push({ ...e, source: 'google' });
          }
        })
        .catch((err) => {
          logger.error({ err }, 'Failed to fetch Google Calendar events');
        })
    );
  }

  // CHAT-M2: pass userId to isOutlookCalendarConfigured() so per-user
  // OAuth tokens (from iOS) are checked, not just the global owner token.
  if (outlookCal.isOutlookCalendarConfigured(userId)) {
    promises.push(
      outlookCal.getEvents(startDate, endDate, userId)
        .then((oEvents) => {
          for (const e of oEvents) {
            events.push({ ...e, source: 'outlook' });
          }
        })
        .catch((err) => {
          logger.error({ err, userId }, 'Failed to fetch Outlook Calendar events');
        })
    );
  }

  await Promise.all(promises);

  // Deduplicate events that exist on both calendars
  const deduped = deduplicateEvents(events);

  // Sort all events by start time
  deduped.sort((a, b) => {
    const aTime = new Date(a.start).getTime();
    const bTime = new Date(b.start).getTime();
    return aTime - bTime;
  });

  return deduped;
}

export async function createEvent(
  data: {
    title: string;
    start: string;
    end: string;
    description?: string;
    categories?: string[];
    attendees?: string[];
    location?: string;
  },
  target?: CalendarSource,
  userId?: number,
): Promise<UnifiedCalendarEvent> {
  // Per-user source resolution: check which provider the requesting
  // user has OAuth tokens for. Falls back to global config for the
  // Telegram codepath where userId isn't passed.
  let source = target;
  if (!source) {
    if (userId) {
      try {
        const { isConnected } = require('./oauth-store');
        if (isConnected(userId, 'outlook')) source = 'outlook';
        else if (isConnected(userId, 'google')) source = 'google';
      } catch { /* oauth-store not available */ }
    }
    // Fall back to global config check (owner / Telegram codepath)
    if (!source) {
      source = outlookCal.isOutlookCalendarConfigured() ? 'outlook' : 'google';
    }
  }

  if (!source || !hasWritableCalendarForUser(userId)) {
    throw new Error('No calendar provider is connected');
  }

  if (source === 'outlook') {
    const event = await outlookCal.createEvent(data);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.createEvent(data);
    return { ...event, source: 'google' };
  }
}

export async function updateEvent(
  data: { event_id: string; new_start?: string; new_end?: string; new_title?: string },
  source: CalendarSource
): Promise<UnifiedCalendarEvent> {
  if (source === 'outlook') {
    const event = await outlookCal.updateEvent(data);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.updateEvent(data);
    return { ...event, source: 'google' };
  }
}

export async function deleteEvent(eventId: string, source: CalendarSource): Promise<void> {
  if (source === 'outlook') {
    await outlookCal.deleteEvent(eventId);
  } else {
    await googleCal.deleteEvent(eventId);
  }
}

// ── Event Deduplication ─────────────────────────────────────────────

/**
 * Build a fingerprint for an event: normalized subject + start time (minute precision).
 * Two events from different calendars with the same fingerprint are considered duplicates.
 */
export function eventFingerprint(event: UnifiedCalendarEvent): string {
  const subject = (event.summary || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // Round start time to the nearest minute to handle timezone conversion differences
  const startMs = new Date(event.start).getTime();
  const startMinute = Math.round(startMs / 60_000);
  return `${subject}|${startMinute}`;
}

/**
 * Deduplicate events from multiple calendar sources.
 * When the same event appears on both Google and Outlook (same meeting invite),
 * merge them into a single event with syncedSources listing both calendars.
 * Keeps the event with the richer data (longer description, location present).
 */
export function deduplicateEvents(events: UnifiedCalendarEvent[]): UnifiedCalendarEvent[] {
  if (events.length === 0) return events;
  if (events.length === 1) return [{ ...events[0], syncedSources: [events[0].source] }];

  const fingerMap = new Map<string, UnifiedCalendarEvent>();
  let dupsFound = 0;

  for (const event of events) {
    const fp = eventFingerprint(event);
    const existing = fingerMap.get(fp);

    if (!existing) {
      fingerMap.set(fp, { ...event, syncedSources: [event.source] });
      continue;
    }

    // Duplicate found — merge sources and keep richer data
    dupsFound++;
    const sources = new Set(existing.syncedSources || [existing.source]);
    sources.add(event.source);

    // Keep whichever has more complete data
    const existingScore = dataRichness(existing);
    const newScore = dataRichness(event);

    if (newScore > existingScore) {
      fingerMap.set(fp, {
        ...event,
        syncedSources: [...sources],
      });
    } else {
      existing.syncedSources = [...sources];
    }
  }

  if (dupsFound > 0) {
    logger.info({ dupsFound, total: events.length, after: fingerMap.size }, 'Calendar events deduplicated');
  }

  return [...fingerMap.values()];
}

/** Score an event's data richness (more fields = higher score). */
function dataRichness(event: UnifiedCalendarEvent): number {
  let score = 0;
  if (event.description) score += event.description.length;
  if (event.location) score += 10;
  if (event.htmlLink) score += 5;
  return score;
}
