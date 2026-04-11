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

// Google API calls are bounded to 15s. Google Calendar / Drive / Gmail
// normally respond in <2s, but under Google outages they can hang for
// minutes. 15s is aggressive enough to unblock a stuck cron but generous
// enough to absorb normal network variance. Audit Month 2 #4.
const GOOGLE_API_TIMEOUT_MS = 15_000;

let calendarClient: calendar_v3.Calendar | null = null;

// Per-request user override for multi-user isolation.
// Same pattern as microsoft-auth.ts _requestUserId.
let _calendarRequestUserId: number | null = null;

/** Set the per-request Google Calendar user override. */
export function setGoogleCalendarUserId(userId: number | null): void {
  _calendarRequestUserId = userId;
}

// The Google client caches MUST be invalidated when /connect google writes
// a fresh refresh token to oauth-store. The OAuth callback handler in
// oauth-flow.ts calls resetGoogleClients() which fans out to every
// registered reset hook (see google-auth.ts).
registerGoogleClientReset(() => { calendarClient = null; });

function getCalendar(): calendar_v3.Calendar {
  // Per-user override: return a fresh per-user client (not cached)
  if (_calendarRequestUserId !== null) {
    const oauth2Client = buildGoogleOAuth2ClientForUser(_calendarRequestUserId);
    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  // Owner singleton fallback
  if (calendarClient) return calendarClient;
  const oauth2Client = buildGoogleOAuth2Client();
  calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  return calendarClient;
}

export function isGoogleCalendarConfigured(): boolean {
  return isGoogleConfigured();
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  htmlLink?: string;
}

export async function getEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
  try {
    const calendar = getCalendar();
    const response = await withTimeout(
      calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date(startDate).toISOString(),
        timeMax: new Date(endDate).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      }),
      GOOGLE_API_TIMEOUT_MS,
    );

    return (response.data.items || []).map((event) => ({
      id: event.id || '',
      summary: event.summary || '(No title)',
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      description: event.description || undefined,
      location: event.location || undefined,
      htmlLink: event.htmlLink || undefined,
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch calendar events');
    throw err;
  }
}

export async function createEvent(data: {
  title: string;
  start: string;
  end: string;
  description?: string;
}): Promise<CalendarEvent> {
  try {
    const calendar = getCalendar();
    const response = await withTimeout(
      calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: data.title,
          start: { dateTime: data.start, timeZone: config.app.timezone },
          end: { dateTime: data.end, timeZone: config.app.timezone },
          description: data.description,
        },
      }),
      GOOGLE_API_TIMEOUT_MS,
    );

    return {
      id: response.data.id || '',
      summary: response.data.summary || data.title,
      start: response.data.start?.dateTime || data.start,
      end: response.data.end?.dateTime || data.end,
      description: response.data.description || undefined,
      htmlLink: response.data.htmlLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create calendar event');
    throw err;
  }
}

export async function updateEvent(data: {
  event_id: string;
  new_start?: string;
  new_end?: string;
  new_title?: string;
}): Promise<CalendarEvent> {
  try {
    const calendar = getCalendar();
    const requestBody: calendar_v3.Schema$Event = {};

    if (data.new_title) requestBody.summary = data.new_title;
    if (data.new_start) requestBody.start = { dateTime: data.new_start, timeZone: config.app.timezone };
    if (data.new_end) requestBody.end = { dateTime: data.new_end, timeZone: config.app.timezone };

    const response = await withTimeout(
      calendar.events.patch({
        calendarId: 'primary',
        eventId: data.event_id,
        requestBody,
      }),
      GOOGLE_API_TIMEOUT_MS,
    );

    return {
      id: response.data.id || data.event_id,
      summary: response.data.summary || '',
      start: response.data.start?.dateTime || '',
      end: response.data.end?.dateTime || '',
      htmlLink: response.data.htmlLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update calendar event');
    throw err;
  }
}

export async function deleteEvent(eventId: string): Promise<void> {
  try {
    const calendar = getCalendar();
    await withTimeout(
      calendar.events.delete({
        calendarId: 'primary',
        eventId,
      }),
      GOOGLE_API_TIMEOUT_MS,
    );
  } catch (err) {
    logger.error({ err }, 'Failed to delete calendar event');
    throw err;
  }
}
