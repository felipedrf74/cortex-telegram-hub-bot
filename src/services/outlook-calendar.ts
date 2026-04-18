// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getGraphClient, getGraphClientForUser, isMicrosoftConfigured } from './microsoft-auth';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CalendarEvent } from './google-calendar';

export function isOutlookCalendarConfigured(userId?: number): boolean {
  // Owner-level check (Telegram bot / global config)
  if (isMicrosoftConfigured()) return true;

  // CHAT-M2: per-user check — iOS users connect Outlook via OAuth,
  // storing tokens under their JWT userId (not the Telegram owner ID).
  // Without this check, the unified calendar skips Outlook entirely
  // for iOS users who have a valid connection.
  if (userId && config.outlook.clientId) {
    try {
      const { getTokens } = require('./oauth-store');
      const tokens = getTokens(userId, 'outlook');
      return !!tokens?.refreshToken;
    } catch { /* oauth-store unavailable */ }
  }

  return false;
}

// ── Master Categories (color ↔ displayName mapping) ─────────────────

/**
 * Microsoft Graph preset colors → human color names.
 * See: https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory
 */
const PRESET_COLOR_MAP: Record<string, string> = {
  preset0: 'red', preset1: 'orange', preset2: 'brown',
  preset3: 'yellow', preset4: 'green', preset5: 'teal',
  preset6: 'olive', preset7: 'blue', preset8: 'purple',
  preset9: 'cranberry', preset10: 'steel', preset11: 'darkSteel',
  preset12: 'gray', preset13: 'darkGray', preset14: 'black',
  preset15: 'darkRed', preset16: 'darkOrange', preset17: 'darkBrown',
  preset18: 'darkYellow', preset19: 'darkGreen', preset20: 'darkTeal',
  preset21: 'darkOlive', preset22: 'darkBlue', preset23: 'darkPurple',
  preset24: 'darkCranberry',
};

interface MasterCategory {
  displayName: string;
  color: string; // e.g. "preset7"
}

let masterCategoriesCache: MasterCategory[] | null = null;

/**
 * Fetches the user's Outlook master categories (cached after first call).
 */
export async function getMasterCategories(): Promise<MasterCategory[]> {
  if (masterCategoriesCache) return masterCategoriesCache;

  try {
    const client = getGraphClient();
    const response = await client.api('/me/outlook/masterCategories').get();
    const cats: MasterCategory[] = (response.value || []).map((c: any) => ({
      displayName: c.displayName,
      color: c.color,
    }));
    masterCategoriesCache = cats;
    logger.info(
      { categories: cats.map((c) => `${c.displayName} (${PRESET_COLOR_MAP[c.color] || c.color})`) },
      'Loaded Outlook master categories'
    );
    return cats;
  } catch (err) {
    logger.error({ err }, 'Failed to fetch master categories');
    return [];
  }
}

/**
 * Finds the exact category displayName for a given human color (blue, green, red).
 * Falls back to "Blue Category" etc. if master categories cannot be fetched.
 */
export async function getCategoryNameForColor(color: 'blue' | 'green' | 'red'): Promise<string> {
  const presetMap: Record<string, string> = { blue: 'preset7', green: 'preset4', red: 'preset0' };
  const fallbackMap: Record<string, string> = { blue: 'Blue Category', green: 'Green Category', red: 'Red Category' };

  const categories = await getMasterCategories();
  const preset = presetMap[color];
  const match = categories.find((c) => c.color === preset);

  if (match) {
    return match.displayName;
  }

  // No match for exact preset — try name-based fuzzy match
  const colorLower = color.toLowerCase();
  const fuzzy = categories.find((c) =>
    c.displayName.toLowerCase().includes(colorLower) ||
    c.displayName.toLowerCase().includes(
      colorLower === 'blue' ? 'azul' : colorLower === 'green' ? 'verde' : 'vermelh'
    )
  );
  if (fuzzy) return fuzzy.displayName;

  return fallbackMap[color];
}

export async function getEvents(startDate: string, endDate: string, userId?: number): Promise<CalendarEvent[]> {
  try {
    // CHAT-M2: use per-user Graph client when userId is available (iOS path).
    // Falls back to the owner singleton for Telegram/global codepath.
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    const response = await client
      .api('/me/calendarView')
      .query({
        startDateTime: new Date(startDate).toISOString(),
        endDateTime: new Date(endDate).toISOString(),
        $orderby: 'start/dateTime',
        $top: 50,
        $select: 'id,subject,start,end,bodyPreview,location,webLink',
      })
      .header('Prefer', `outlook.timezone="${config.app.timezone}"`)
      .get();

    return (response.value || []).map((event: any) => ({
      id: event.id || '',
      summary: event.subject || '(No title)',
      start: event.start?.dateTime || '',
      end: event.end?.dateTime || '',
      description: event.bodyPreview || undefined,
      location: event.location?.displayName || undefined,
      htmlLink: event.webLink || undefined,
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Outlook calendar events');
    throw err;
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
}, userId?: number): Promise<CalendarEvent> {
  try {
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    const attendees = (data.attendees || [])
      .map((email) => email.trim())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const postBody: any = {
      subject: data.title,
      start: {
        dateTime: data.start,
        timeZone: config.app.timezone,
      },
      end: {
        dateTime: data.end,
        timeZone: config.app.timezone,
      },
    };
    if (data.description) {
      postBody.body = { contentType: 'Text', content: data.description };
    }
    if (data.categories && data.categories.length > 0) {
      postBody.categories = data.categories;
    }
    if (data.location) {
      postBody.location = { displayName: data.location };
    }
    if (attendees.length > 0) {
      postBody.attendees = attendees.map((address) => ({
        emailAddress: { address },
        type: 'required',
      }));
    }
    logger.info(
      { subject: postBody.subject, categories: postBody.categories, attendeeCount: attendees.length },
      'Creating Outlook calendar event',
    );
    const response = await client.api('/me/events').post(postBody);

    return {
      id: response.id || '',
      summary: response.subject || data.title,
      start: response.start?.dateTime || data.start,
      end: response.end?.dateTime || data.end,
      description: response.bodyPreview || undefined,
      htmlLink: response.webLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create Outlook calendar event');
    throw err;
  }
}

export async function updateEvent(data: {
  event_id: string;
  new_start?: string;
  new_end?: string;
  new_title?: string;
}, userId?: number): Promise<CalendarEvent> {
  try {
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    const patch: any = {};

    if (data.new_title) patch.subject = data.new_title;
    if (data.new_start) patch.start = { dateTime: data.new_start, timeZone: config.app.timezone };
    if (data.new_end) patch.end = { dateTime: data.new_end, timeZone: config.app.timezone };

    const response = await client.api(`/me/events/${data.event_id}`).patch(patch);

    return {
      id: response.id || data.event_id,
      summary: response.subject || '',
      start: response.start?.dateTime || '',
      end: response.end?.dateTime || '',
      htmlLink: response.webLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update Outlook calendar event');
    throw err;
  }
}

export async function deleteEvent(eventId: string, userId?: number): Promise<void> {
  try {
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    await client.api(`/me/events/${eventId}`).delete();
  } catch (err) {
    logger.error({ err }, 'Failed to delete Outlook calendar event');
    throw err;
  }
}
