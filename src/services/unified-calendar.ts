// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as googleCal from './google-calendar';
import * as outlookCal from './outlook-calendar';
import { logger } from '../utils/logger';
import { config } from '../config';
import { normalizeMicrosoftRecurrence, type NormalizedRecurrence } from './recurrence-utils';
import {
  getStagingFixtureCalendarEvents,
  hasStagingFixtureCalendarEventsForUser,
} from './staging-fixture-calendar';
import { resolveCalendarWritePreference } from './provider-preferences';

export type CalendarSource = 'google' | 'outlook';

export interface UnifiedCalendarEvent extends googleCal.CalendarEvent {
  source: CalendarSource;
  /** When the same event exists on multiple calendars, lists all sources. */
  syncedSources?: CalendarSource[];
}

export type UnifiedCalendarFetchStatus = 'ready' | 'degraded' | 'unavailable';

export interface UnifiedCalendarFetchResult {
  events: UnifiedCalendarEvent[];
  status: UnifiedCalendarFetchStatus;
  warningCodes: string[];
  warnings: string[];
  sources: {
    configured: CalendarSource[];
    fulfilled: CalendarSource[];
    failed: CalendarSource[];
  };
}

class UnifiedCalendarUnavailableError extends Error {
  constructor(
    message: string,
    readonly warningCodes: string[],
    readonly warnings: string[],
  ) {
    super(message);
    this.name = 'UnifiedCalendarUnavailableError';
  }
}

export function isAnyCalendarConfigured(): boolean {
  return googleCal.isGoogleCalendarConfigured() || outlookCal.isOutlookCalendarConfigured();
}

function resolveScopedUserId(userId?: number): number | null {
  if (userId != null) return userId;
  try {
    const { getCurrentContext } = require('../utils/request-context');
    return getCurrentContext()?.userId ?? null;
  } catch {
    return null;
  }
}

export function hasConnectedCalendarForUser(userId?: number): boolean {
  const scopedUserId = resolveScopedUserId(userId);
  if (scopedUserId == null) {
    return isAnyCalendarConfigured();
  }
  return googleCal.isGoogleCalendarConfigured(scopedUserId)
    || outlookCal.isOutlookCalendarConfigured(scopedUserId)
    || hasStagingFixtureCalendarEventsForUser(scopedUserId);
}

/**
 * Exact, side-effect-free provider enrollment for one authenticated user.
 * Unlike `getConfiguredSources()`, this never falls back to owner-global
 * credentials when a user id is supplied.
 */
export function getConfiguredCalendarSourcesForUser(userId: number): CalendarSource[] {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  const sources = new Set<CalendarSource>();
  if (googleCal.isGoogleCalendarConfigured(userId)) sources.add('google');
  if (outlookCal.isOutlookCalendarConfigured(userId)
      || hasStagingFixtureCalendarEventsForUser(userId)) sources.add('outlook');
  return [...sources].sort();
}

export function hasWritableCalendarForUser(userId?: number): boolean {
  const scopedUserId = resolveScopedUserId(userId);
  if (scopedUserId != null) {
    return googleCal.isGoogleCalendarConfigured(scopedUserId)
      || outlookCal.isOutlookCalendarConfigured(scopedUserId);
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
  const result = await getEventsWithDiagnostics(startDate, endDate, userId);
  if (result.status === 'unavailable' && result.sources.configured.length > 0) {
    throw new UnifiedCalendarUnavailableError(
      result.warnings[0] || 'Calendar data is unavailable right now.',
      result.warningCodes,
      result.warnings,
    );
  }
  return result.events;
}

export async function getEventsForSources(
  startDate: string,
  endDate: string,
  userId: number | undefined,
  sources: CalendarSource[],
): Promise<UnifiedCalendarEvent[]> {
  const result = await getEventsWithDiagnostics(startDate, endDate, userId, { sources });
  if (result.status === 'unavailable' && result.sources.configured.length > 0) {
    throw new UnifiedCalendarUnavailableError(
      result.warnings[0] || 'Calendar data is unavailable right now.',
      result.warningCodes,
      result.warnings,
    );
  }
  return result.events;
}

export async function getEventsWithDiagnostics(
  startDate: string,
  endDate: string,
  userId?: number,
  options?: { sources?: CalendarSource[] },
): Promise<UnifiedCalendarFetchResult> {
  const scopedUserId = resolveScopedUserId(userId);
  const allowedSources = options?.sources?.length
    ? new Set<CalendarSource>(options.sources)
    : null;
  const fetchers: Array<{
    source: CalendarSource;
    run: () => Promise<UnifiedCalendarEvent[]>;
  }> = [];

  if ((!allowedSources || allowedSources.has('google')) && googleCal.isGoogleCalendarConfigured(scopedUserId ?? undefined)) {
    fetchers.push({
      source: 'google',
      run: async () => {
        const gEvents = await googleCal.getEvents(startDate, endDate, scopedUserId ?? undefined);
        return gEvents.map((event) => ({ ...event, source: 'google' as const }));
      },
    });
  }

  // CHAT-M2: pass userId to isOutlookCalendarConfigured() so per-user
  // OAuth tokens (from iOS) are checked, not just the global owner token.
  if ((!allowedSources || allowedSources.has('outlook')) && outlookCal.isOutlookCalendarConfigured(scopedUserId ?? undefined)) {
    fetchers.push({
      source: 'outlook',
      run: async () => {
        const oEvents = await outlookCal.getEvents(startDate, endDate, scopedUserId ?? undefined);
        return oEvents.map((event) => ({ ...event, source: 'outlook' as const }));
      },
    });
  }

  if ((!allowedSources || allowedSources.has('outlook')) && hasStagingFixtureCalendarEventsForUser(scopedUserId ?? undefined)) {
    fetchers.push({
      source: 'outlook',
      run: async () => getStagingFixtureCalendarEvents(startDate, endDate, scopedUserId ?? undefined),
    });
  }

  if (fetchers.length === 0) {
    return {
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
      warnings: ['No calendar integration is connected yet.'],
      sources: {
        configured: [],
        fulfilled: [],
        failed: [],
      },
    };
  }

  const results = await Promise.allSettled(fetchers.map((fetcher) => fetcher.run()));
  const events: UnifiedCalendarEvent[] = [];
  const fulfilled: CalendarSource[] = [];
  const failed: CalendarSource[] = [];
  const warningCodes: string[] = [];
  const warnings: string[] = [];

  results.forEach((result, index) => {
    const source = fetchers[index].source;
    if (result.status === 'fulfilled') {
      fulfilled.push(source);
      events.push(...result.value);
      return;
    }

    failed.push(source);
    const code = source === 'google'
      ? 'GOOGLE_CALENDAR_UNAVAILABLE'
      : 'OUTLOOK_CALENDAR_UNAVAILABLE';
    const warning = source === 'google'
      ? 'Google Calendar is unavailable right now.'
      : 'Outlook Calendar is unavailable right now.';
    warningCodes.push(code);
    warnings.push(warning);
    logger.error(
      { err: result.reason, userId: scopedUserId ?? undefined, source },
      'Failed to fetch calendar provider events',
    );
  });

  // Deduplicate events that exist on both calendars
  const deduped = deduplicateEvents(events);

  // Sort all events by start time
  deduped.sort((a, b) => {
    const aTime = new Date(a.start).getTime();
    const bTime = new Date(b.start).getTime();
    return aTime - bTime;
  });

  const status: UnifiedCalendarFetchStatus =
    fulfilled.length === fetchers.length
      ? 'ready'
      : fulfilled.length > 0
        ? 'degraded'
        : 'unavailable';

  return {
    events: deduped,
    status,
    warningCodes,
    warnings,
    sources: {
      configured: fetchers.map((fetcher) => fetcher.source),
      fulfilled,
      failed,
    },
  };
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
    recurrence?: unknown;
  },
  target?: CalendarSource,
  userId?: number,
  options?: { signal?: AbortSignal; tenantId?: number },
): Promise<UnifiedCalendarEvent> {
  const scopedUserId = resolveScopedUserId(userId);
  // Per-user source resolution: check which provider the requesting
  // user has OAuth tokens for. Falls back to global config for the
  // Telegram codepath where userId isn't passed.
  let source = target;
  if (!source) {
    if (scopedUserId != null) {
      source = resolveCalendarWritePreference(scopedUserId, options?.tenantId ?? scopedUserId).source ?? undefined;
    }
    // Fall back to global config check (owner / Telegram codepath)
    if (!source) {
      if (scopedUserId == null) {
        source = outlookCal.isOutlookCalendarConfigured() ? 'outlook' : 'google';
      }
    }
  }

  if (!source || !hasWritableCalendarForUser(scopedUserId ?? undefined)) {
    throw new Error('No calendar provider is connected');
  }

  const recurrence: NormalizedRecurrence | undefined = normalizeMicrosoftRecurrence(
    data.recurrence,
    data.start,
  );
  const eventData = { ...data, recurrence };

  if (source === 'outlook') {
    const event = await outlookCal.createEvent(eventData, scopedUserId ?? undefined, options);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.createEvent(eventData, scopedUserId ?? undefined, options);
    return { ...event, source: 'google' };
  }
}

export async function getEventById(
  eventId: string,
  source: CalendarSource,
  userId?: number,
): Promise<UnifiedCalendarEvent | null> {
  if (source === 'outlook') {
    const event = await outlookCal.getEventById(eventId, userId);
    return event ? { ...event, source: 'outlook' } : null;
  }
  const event = await googleCal.getEventById(eventId, userId);
  return event ? { ...event, source: 'google' } : null;
}

export async function updateEvent(
  data: { event_id: string; new_start?: string; new_end?: string; new_title?: string; new_description?: string },
  source: CalendarSource,
  userId?: number,
  options?: { signal?: AbortSignal },
): Promise<UnifiedCalendarEvent> {
  if (source === 'outlook') {
    const event = await outlookCal.updateEvent(data, userId, options);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.updateEvent(data, userId, options);
    return { ...event, source: 'google' };
  }
}

export async function deleteEvent(eventId: string, source: CalendarSource, userId?: number, options?: { signal?: AbortSignal }): Promise<void> {
  if (source === 'outlook') {
    await outlookCal.deleteEvent(eventId, userId, options);
  } else {
    await googleCal.deleteEvent(eventId, userId, options);
  }
}

// ── Event Deduplication ─────────────────────────────────────────────

/**
 * Build a fingerprint for an event: normalized subject + start time (minute precision).
 * Two events from different calendars with the same fingerprint are considered duplicates.
 */
export function eventFingerprint(event: UnifiedCalendarEvent): string {
  const providerUid = normalizeProviderIdentity(event.providerUid);
  if (providerUid) return `uid:${providerUid}`;
  const subject = (event.summary || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const organizer = normalizeProviderIdentity(event.organizer);
  const allDayDate = normalizeAllDayStartDate(event);
  if (allDayDate) {
    return `${organizer ? `organizer:${organizer}|` : ''}${subject}|all-day:${allDayDate}`;
  }
  // Round start time to the nearest minute to handle timezone conversion differences
  const startMs = new Date(event.start).getTime();
  const startMinute = Math.round(startMs / 60_000);
  return `${organizer ? `organizer:${organizer}|` : ''}${subject}|${startMinute}`;
}

function normalizeProviderIdentity(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || null;
}

function normalizeAllDayStartDate(event: UnifiedCalendarEvent): string | null {
  const start = String(event.start || '').trim();
  if (!start) return null;
  const looksDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start);
  if (!event.isAllDay && !looksDateOnly) return null;
  if (looksDateOnly) return start;

  const datePrefix = start.match(/^(\d{4}-\d{2}-\d{2})T/);
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(start);
  if (event.isAllDay && datePrefix && !hasExplicitZone) {
    return datePrefix[1];
  }

  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return datePrefix?.[1] ?? null;
  return parsed.toLocaleDateString('en-CA', {
    timeZone: config.app.timezone || 'Europe/Lisbon',
  });
}

/**
 * Deduplicate events from multiple calendar sources.
 * When the same event appears on both Google and Outlook (same meeting invite),
 * merge them into a single event with syncedSources listing both calendars.
 * Same-provider duplicates are intentionally preserved because they represent
 * real calendar dirt that cleanup and cancellation paths must still see.
 * Keeps the event with the richer data (longer description, location present).
 */
export function deduplicateEvents(events: UnifiedCalendarEvent[]): UnifiedCalendarEvent[] {
  if (events.length === 0) return events;
  if (events.length === 1) {
    return [{ ...events[0], syncedSources: normalizedSyncedSources(events[0]) }];
  }

  const fingerMap = new Map<string, UnifiedCalendarEvent[]>();
  const repeatedProviderUids = repeatedProviderUidFingerprints(events);
  let dupsFound = 0;

  for (const event of events) {
    const fp = eventFingerprint(event);
    const bucket = fingerMap.get(fp) ?? [];
    const existingIndex = bucket.findIndex((candidate) => {
      const sources = new Set(candidate.syncedSources || [candidate.source]);
      return !sources.has(event.source)
        && providerCopiesShareOccurrence(candidate, event, repeatedProviderUids.has(fp));
    });

    if (existingIndex < 0) {
      bucket.push({ ...event, syncedSources: normalizedSyncedSources(event) });
      fingerMap.set(fp, bucket);
      continue;
    }

    const existing = bucket[existingIndex];
    // Cross-provider duplicate found — merge sources and keep richer data.
    dupsFound++;
    const sources = new Set(existing.syncedSources || [existing.source]);
    sources.add(event.source);
    for (const source of event.syncedSources ?? []) sources.add(source);

    // Keep whichever has more complete data
    const existingScore = dataRichness(existing);
    const newScore = dataRichness(event);

    const richer = newScore > existingScore ? event : existing;
    bucket[existingIndex] = {
      ...richer,
      // A duplicate provider copy may lag or truncate one boundary. Preserve
      // the union of both busy intervals so deduplication can never create
      // false-free calendar capacity merely because the richer row was shorter.
      start: conservativeBoundary(existing.start, event.start, 'earliest'),
      end: conservativeBoundary(existing.end, event.end, 'latest'),
      isAllDay: Boolean(existing.isAllDay || event.isAllDay),
      timeZone: richer.timeZone ?? existing.timeZone ?? event.timeZone,
      providerUid: richer.providerUid ?? existing.providerUid ?? event.providerUid,
      providerOccurrenceStart: richer.providerOccurrenceStart
        ?? existing.providerOccurrenceStart
        ?? event.providerOccurrenceStart,
      organizer: richer.organizer ?? existing.organizer ?? event.organizer,
      // A provider copy that is busy must win over a duplicate marked free.
      // Missing intent is treated as busy for backwards-compatible safety.
      blocksTime: (existing.blocksTime ?? true) || (event.blocksTime ?? true),
      syncedSources: [...sources],
    };
  }

  const deduped = [...fingerMap.values()].flat();
  if (dupsFound > 0) {
    logger.info({ dupsFound, total: events.length, after: deduped.length }, 'Calendar events deduplicated');
  }

  return deduped;
}

function normalizedSyncedSources(event: UnifiedCalendarEvent): CalendarSource[] {
  return [...new Set([event.source, ...(event.syncedSources ?? [])])];
}

function repeatedProviderUidFingerprints(events: UnifiedCalendarEvent[]): Set<string> {
  const counts = new Map<string, Map<CalendarSource, number>>();
  for (const event of events) {
    const uid = normalizeProviderIdentity(event.providerUid);
    if (!uid) continue;
    const fingerprint = `uid:${uid}`;
    const bySource = counts.get(fingerprint) ?? new Map<CalendarSource, number>();
    bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
    counts.set(fingerprint, bySource);
  }
  return new Set([...counts.entries()]
    .filter(([, bySource]) => [...bySource.values()].some((count) => count > 1))
    .map(([fingerprint]) => fingerprint));
}

function providerCopiesShareOccurrence(
  left: UnifiedCalendarEvent,
  right: UnifiedCalendarEvent,
  repeatedUidInWindow: boolean,
): boolean {
  const uid = normalizeProviderIdentity(left.providerUid);
  if (!uid || uid !== normalizeProviderIdentity(right.providerUid)) return true;

  const leftOccurrence = normalizeOccurrenceIdentity(left.providerOccurrenceStart, left);
  const rightOccurrence = normalizeOccurrenceIdentity(right.providerOccurrenceStart, right);
  if (leftOccurrence || rightOccurrence) {
    // If one provider omitted recurrence metadata, compare its visible start to
    // the immutable occurrence identity from the other provider. Never match
    // two different immutable occurrence starts.
    return (leftOccurrence ?? normalizeOccurrenceIdentity(left.start, left))
      === (rightOccurrence ?? normalizeOccurrenceIdentity(right.start, right));
  }

  const leftAllDay = normalizeAllDayStartDate(left);
  const rightAllDay = normalizeAllDayStartDate(right);
  if (leftAllDay || rightAllDay) return leftAllDay != null && leftAllDay === rightAllDay;

  const leftStart = Date.parse(left.start);
  const rightStart = Date.parse(right.start);
  if (!Number.isFinite(leftStart) || !Number.isFinite(rightStart)) return false;
  if (repeatedUidInWindow) {
    // Without immutable occurrence metadata, repeated series instances are
    // paired only at the exact minute. This prevents a missing occurrence on
    // one provider from shifting every later pair.
    return Math.round(leftStart / 60_000) === Math.round(rightStart / 60_000);
  }
  // A single cross-provider copy can differ slightly while one provider is
  // converging after a move. Keep this narrow; wider drift is safer as two
  // visible events than as a fabricated union interval.
  return Math.abs(leftStart - rightStart) <= 15 * 60_000;
}

function normalizeOccurrenceIdentity(
  value: string | null | undefined,
  event: UnifiedCalendarEvent,
): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (event.isAllDay || /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = normalizeAllDayStartDate({ ...event, start: raw, isAllDay: true });
    return date ? `date:${date}` : null;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return `minute:${Math.round(timestamp / 60_000)}`;
}

function conservativeBoundary(
  left: string,
  right: string,
  direction: 'earliest' | 'latest',
): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  if (direction === 'earliest') return leftMs <= rightMs ? left : right;
  return leftMs >= rightMs ? left : right;
}

/** Score an event's data richness (more fields = higher score). */
function dataRichness(event: UnifiedCalendarEvent): number {
  let score = 0;
  if (event.description) score += event.description.length;
  if (event.location) score += 10;
  if (event.htmlLink) score += 5;
  return score;
}
