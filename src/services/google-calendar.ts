// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { google, calendar_v3 } from 'googleapis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import {
  buildGoogleOAuth2Client,
  buildGoogleOAuth2ClientForUser,
  isGoogleConfigured,
  registerGoogleClientReset,
} from './google-auth';
import { recurrenceToGoogleRRule, type NormalizedRecurrence } from './recurrence-utils';
import { isProviderEventNotFoundError } from './training-calendar-errors';

// Google API calls are bounded to 15s. Google Calendar / Drive / Gmail
// normally respond in <2s, but under Google outages they can hang for
// minutes. 15s is aggressive enough to unblock a stuck cron but generous
// enough to absorb normal network variance. Audit Month 2 #4.
const GOOGLE_API_TIMEOUT_MS = 15_000;
const GOOGLE_EVENTS_MAX_PAGES = 20;

let calendarClient: calendar_v3.Calendar | null = null;

export interface SanitizedGoogleCalendarError {
  name: string;
  message: string;
  code?: number | string;
  status?: number;
  statusCode?: number;
  reason?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  responseStatus?: number;
  responseStatusText?: string;
}

export class GoogleCalendarApiError extends Error {
  code?: number | string;
  status?: number;
  statusCode?: number;
  reason?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  responseStatus?: number;
  responseStatusText?: string;

  constructor(readonly safeDetails: SanitizedGoogleCalendarError) {
    super(safeDetails.message || 'Google Calendar API request failed');
    this.name = 'GoogleCalendarApiError';
    this.code = safeDetails.code;
    this.status = safeDetails.status;
    this.statusCode = safeDetails.statusCode;
    this.reason = safeDetails.reason;
    this.errors = safeDetails.errors;
    this.responseStatus = safeDetails.responseStatus;
    this.responseStatusText = safeDetails.responseStatusText;
  }
}

/** @deprecated No-op. userId is now read from AsyncLocalStorage context. */
export function setGoogleCalendarUserId(_userId: number | null): void {
  // Intentionally empty
}

registerGoogleClientReset(() => { calendarClient = null; });

function getCalendar(userId?: number): calendar_v3.Calendar {
  let effectiveUserId: number | null = userId ?? null;
  if (effectiveUserId === null) {
    try {
      const { getCurrentContext } = require('../utils/request-context');
      effectiveUserId = getCurrentContext()?.userId ?? null;
    } catch {}
  }

  if (effectiveUserId !== null) {
    const oauth2Client = buildGoogleOAuth2ClientForUser(effectiveUserId);
    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  // Owner singleton fallback (Telegram bot / cron)
  if (calendarClient) return calendarClient;
  const oauth2Client = buildGoogleOAuth2Client();
  calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  return calendarClient;
}

export function isGoogleCalendarConfigured(userId?: number): boolean {
  return isGoogleConfigured(userId);
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  categories?: string[];
  color?: string;
  isAllDay?: boolean;
  /** IANA zone supplied by the provider or the configured calendar default. */
  timeZone?: string;
  /** Explicit provider free/busy intent. Undefined remains conservatively busy. */
  blocksTime?: boolean;
  /** Provider-stable cross-calendar meeting identity (Google iCalUID / Graph iCalUId). */
  providerUid?: string;
  /** Immutable recurrence-instance start used with providerUid to identify one occurrence. */
  providerOccurrenceStart?: string;
  /** Normalized organizer address used only when a stable UID is unavailable. */
  organizer?: string;
}

export async function getEvents(startDate: string, endDate: string, userId?: number): Promise<CalendarEvent[]> {
  try {
    const calendar = getCalendar(userId);
    const items: calendar_v3.Schema$Event[] = [];
    let calendarTimeZone: string | undefined;
    let pageToken: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= GOOGLE_EVENTS_MAX_PAGES) {
        throw new Error(`Google Calendar pagination page limit exceeded (${GOOGLE_EVENTS_MAX_PAGES})`);
      }
      const response = await withTimeout(
        calendar.events.list({
          calendarId: 'primary',
          timeMin: new Date(startDate).toISOString(),
          timeMax: new Date(endDate).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
          pageToken,
        }),
        GOOGLE_API_TIMEOUT_MS,
      );
      pageCount += 1;
      items.push(...(response.data.items || []));
      calendarTimeZone ??= response.data.timeZone || undefined;
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    return items
      .filter((event) => event.status !== 'cancelled')
      .map((event) => ({
        id: event.id || '',
        summary: event.summary || '(No title)',
        start: event.start?.dateTime || event.start?.date || '',
        end: event.end?.dateTime || event.end?.date || '',
        description: event.description || undefined,
        location: event.location || undefined,
        htmlLink: event.htmlLink || undefined,
        isAllDay: !event.start?.dateTime && !!event.start?.date,
        timeZone: event.start?.timeZone || event.end?.timeZone || calendarTimeZone,
        blocksTime: event.transparency !== 'transparent',
        providerUid: event.iCalUID || undefined,
        providerOccurrenceStart: event.originalStartTime?.dateTime
          || event.originalStartTime?.date
          || undefined,
        organizer: event.organizer?.email?.trim().toLowerCase() || undefined,
      }));
  } catch (err) {
    throw logAndWrapGoogleCalendarError(err, 'Failed to fetch calendar events');
  }
}

export async function getEventById(eventId: string, userId?: number): Promise<CalendarEvent | null> {
  try {
    const calendar = getCalendar(userId);
    const response = await withTimeout(
      calendar.events.get({
        calendarId: 'primary',
        eventId,
      }),
      GOOGLE_API_TIMEOUT_MS,
    );
    const event = response.data;
    if (event.status === 'cancelled') return null;
    return {
      id: event.id || eventId,
      summary: event.summary || '(No title)',
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      description: event.description || undefined,
      location: event.location || undefined,
      htmlLink: event.htmlLink || undefined,
      isAllDay: !event.start?.dateTime && !!event.start?.date,
      timeZone: event.start?.timeZone || event.end?.timeZone || undefined,
      blocksTime: event.transparency !== 'transparent',
      providerUid: event.iCalUID || undefined,
      providerOccurrenceStart: event.originalStartTime?.dateTime
        || event.originalStartTime?.date
        || undefined,
      organizer: event.organizer?.email?.trim().toLowerCase() || undefined,
    };
  } catch (err) {
    if (isProviderEventNotFoundError(err)) return null;
    throw logAndWrapGoogleCalendarError(err, 'Failed to fetch calendar event by id');
  }
}

export async function createEvent(data: {
  title: string;
  start: string;
  end: string;
  description?: string;
  categories?: string[];
  attendees?: string[];
  location?: string;
  recurrence?: NormalizedRecurrence;
}, userId?: number, options?: { signal?: AbortSignal }): Promise<CalendarEvent> {
  try {
    const calendar = getCalendar(userId);
    const attendees = (data.attendees || [])
      .map((email) => email.trim())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const rrule = recurrenceToGoogleRRule(data.recurrence);
    const description = withGoogleCategoryTags(data.description, data.categories);
    const response = await withTimeout(
      calendar.events.insert({
        calendarId: 'primary',
        ...(attendees.length > 0 ? { sendUpdates: 'all' } : {}),
        requestBody: {
          summary: data.title,
          start: { dateTime: data.start, timeZone: config.app.timezone },
          end: { dateTime: data.end, timeZone: config.app.timezone },
          description,
          location: data.location,
          ...(rrule ? { recurrence: [rrule] } : {}),
          ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
        },
      }, options?.signal ? { signal: options.signal } : undefined),
      GOOGLE_API_TIMEOUT_MS,
    );

    return {
      id: response.data.id || '',
      summary: response.data.summary || data.title,
      start: response.data.start?.dateTime || data.start,
      end: response.data.end?.dateTime || data.end,
      description: response.data.description || description || undefined,
      categories: data.categories,
      htmlLink: response.data.htmlLink || undefined,
      isAllDay: !response.data.start?.dateTime && !!response.data.start?.date,
      providerUid: response.data.iCalUID || undefined,
      providerOccurrenceStart: response.data.originalStartTime?.dateTime
        || response.data.originalStartTime?.date
        || undefined,
      organizer: response.data.organizer?.email?.trim().toLowerCase() || undefined,
    };
  } catch (err) {
    throw logAndWrapGoogleCalendarError(err, 'Failed to create calendar event');
  }
}

export function withGoogleCategoryTags(description: string | undefined, categories: string[] | undefined): string | undefined {
  const cleanCategories = (categories || [])
    .map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '')
    .filter(Boolean);
  if (cleanCategories.length === 0) return description;
  const unique = [...new Set(cleanCategories)];
  const tag = `Nexus category: ${unique.join(', ')}`;
  const base = description?.trim();
  // Phase 17 hostile-QA fix (2026-05-18): the route layer calls
  // withNexusCategoryDescription, which appends `Nexus category: …`. When
  // the unified path then routes through createEvent here, this function
  // appended a SECOND identical tag — two `Nexus category: focus` lines
  // visible in the Google event description. Detect any pre-existing
  // `Nexus category: …` line in the description and skip the duplicate.
  if (base && /^Nexus category:\s*/im.test(base)) {
    return base;
  }
  return base ? `${base}\n\n${tag}` : tag;
}

export async function updateEvent(data: {
  event_id: string;
  new_start?: string;
  new_end?: string;
  new_title?: string;
  new_description?: string;
}, userId?: number, options?: { signal?: AbortSignal }): Promise<CalendarEvent> {
  try {
    const calendar = getCalendar(userId);
    const requestBody: calendar_v3.Schema$Event = {};

    if (data.new_title) requestBody.summary = data.new_title;
    if (data.new_description !== undefined) requestBody.description = data.new_description;
    if (data.new_start) requestBody.start = { dateTime: data.new_start, timeZone: config.app.timezone };
    if (data.new_end) requestBody.end = { dateTime: data.new_end, timeZone: config.app.timezone };

    const response = await withTimeout(
      calendar.events.patch({
        calendarId: 'primary',
        eventId: data.event_id,
        requestBody,
      }, options?.signal ? { signal: options.signal } : undefined),
      GOOGLE_API_TIMEOUT_MS,
    );

    return {
      id: response.data.id || data.event_id,
      summary: response.data.summary || '',
      start: response.data.start?.dateTime || '',
      end: response.data.end?.dateTime || '',
      description: response.data.description || undefined,
      htmlLink: response.data.htmlLink || undefined,
      isAllDay: !response.data.start?.dateTime && !!response.data.start?.date,
    };
  } catch (err) {
    throw logAndWrapGoogleCalendarError(err, 'Failed to update calendar event');
  }
}

export async function deleteEvent(eventId: string, userId?: number, options?: { signal?: AbortSignal }): Promise<void> {
  try {
    const calendar = getCalendar(userId);
    await withTimeout(
      calendar.events.delete({
        calendarId: 'primary',
        eventId,
      }, options?.signal ? { signal: options.signal } : undefined),
      GOOGLE_API_TIMEOUT_MS,
    );
  } catch (err) {
    if (isProviderEventNotFoundError(err)) {
      logger.debug({ eventId, userId }, 'Google Calendar event already deleted');
      return;
    }
    throw logAndWrapGoogleCalendarError(err, 'Failed to delete calendar event');
  }
}

export function sanitizeGoogleCalendarErrorForLog(err: unknown): SanitizedGoogleCalendarError {
  if (err instanceof GoogleCalendarApiError) return err.safeDetails;
  const anyErr = err as any;
  const directError = safeRead(() => anyErr?.error);
  const responseData = safeRead(() => anyErr?.response?.data);
  const responseError = safeRead(() => responseData?.error)
    ?? (isGoogleErrorEnvelope(responseData) ? responseData : undefined);
  const directErrors = normalizeGoogleErrorItems(safeRead(() => anyErr?.errors));
  const topLevelErrorErrors = normalizeGoogleErrorItems(safeRead(() => directError?.errors));
  const responseErrors = normalizeGoogleErrorItems(safeRead(() => responseError?.errors));
  const errors = directErrors.length > 0
    ? directErrors
    : (responseErrors.length > 0 ? responseErrors : topLevelErrorErrors);
  const status = numberOrUndefined(
    safeRead(() => anyErr?.status)
      ?? safeRead(() => anyErr?.statusCode)
      ?? safeRead(() => anyErr?.response?.status)
      ?? safeRead(() => directError?.code)
      ?? safeRead(() => responseError?.code),
  );
  const code = safeRead(() => anyErr?.code) ?? status;
  const message = [
    safeRead(() => anyErr?.message),
    safeRead(() => directError?.message),
    safeRead(() => responseError?.message),
    errors.map((item) => item.message).filter(Boolean).join('; '),
  ].filter(Boolean).join(' — ') || String(err);
  const reason = String(
    safeRead(() => anyErr?.reason)
      ?? safeRead(() => anyErr?.error?.reason)
      ?? safeRead(() => directError?.errors?.[0]?.reason)
      ?? errors[0]?.reason
      ?? '',
  ) || undefined;

  return {
    name: safeRead(() => anyErr?.name) || (err instanceof Error ? err.name : typeof err),
    message,
    code,
    status,
    statusCode: status,
    reason,
    errors: errors.length > 0 ? errors : undefined,
    responseStatus: numberOrUndefined(safeRead(() => anyErr?.response?.status)),
    responseStatusText: safeRead(() => anyErr?.response?.statusText),
  };
}

export function toGoogleCalendarApiError(err: unknown): GoogleCalendarApiError {
  if (err instanceof GoogleCalendarApiError) return err;
  return new GoogleCalendarApiError(sanitizeGoogleCalendarErrorForLog(err));
}

function logAndWrapGoogleCalendarError(err: unknown, message: string): GoogleCalendarApiError {
  const wrapped = toGoogleCalendarApiError(err);
  logger.error(
    {
      err: wrapped,
      googleCalendarError: wrapped.safeDetails,
    },
    message,
  );
  return wrapped;
}

function normalizeGoogleErrorItems(raw: unknown): Array<{ reason?: string; message?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const reason = stringOrUndefined((item as any).reason);
    const message = stringOrUndefined((item as any).message);
    return reason || message ? [{ reason, message }] : [];
  });
}

function isGoogleErrorEnvelope(value: unknown): value is {
  code?: unknown;
  message?: unknown;
  errors?: Array<{ reason?: unknown; message?: unknown }>;
} {
  return Boolean(value && typeof value === 'object' && (
    'errors' in value || 'code' in value || 'message' in value
  ));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeRead<T>(reader: () => T): T | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}
