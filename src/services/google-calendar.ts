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

// Google API calls are bounded to 15s. Google Calendar / Drive / Gmail
// normally respond in <2s, but under Google outages they can hang for
// minutes. 15s is aggressive enough to unblock a stuck cron but generous
// enough to absorb normal network variance. Audit Month 2 #4.
const GOOGLE_API_TIMEOUT_MS = 15_000;

let calendarClient: calendar_v3.Calendar | null = null;

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
}

export async function getEvents(startDate: string, endDate: string, userId?: number): Promise<CalendarEvent[]> {
  try {
    const calendar = getCalendar(userId);
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

    return (response.data.items || [])
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
  attendees?: string[];
  location?: string;
  recurrence?: NormalizedRecurrence;
}, userId?: number): Promise<CalendarEvent> {
  try {
    const calendar = getCalendar(userId);
    const attendees = (data.attendees || [])
      .map((email) => email.trim())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const rrule = recurrenceToGoogleRRule(data.recurrence);
    const response = await withTimeout(
      calendar.events.insert({
        calendarId: 'primary',
        ...(attendees.length > 0 ? { sendUpdates: 'all' } : {}),
        requestBody: {
          summary: data.title,
          start: { dateTime: data.start, timeZone: config.app.timezone },
          end: { dateTime: data.end, timeZone: config.app.timezone },
          description: data.description,
          location: data.location,
          ...(rrule ? { recurrence: [rrule] } : {}),
          ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
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
      isAllDay: !response.data.start?.dateTime && !!response.data.start?.date,
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
  new_description?: string;
}, userId?: number): Promise<CalendarEvent> {
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
      }),
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
    logger.error({ err }, 'Failed to update calendar event');
    throw err;
  }
}

export async function deleteEvent(eventId: string, userId?: number): Promise<void> {
  try {
    const calendar = getCalendar(userId);
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
