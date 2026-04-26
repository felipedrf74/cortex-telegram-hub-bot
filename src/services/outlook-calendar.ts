// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getGraphClient, getGraphClientForUser, isMicrosoftConfigured } from './microsoft-auth';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getTokens } from './oauth-store';
import { CalendarEvent } from './google-calendar';
import type { NormalizedRecurrence } from './recurrence-utils';

export function isOutlookCalendarConfigured(userId?: number): boolean {
  // Multi-tenant rule (mirrors `isGoogleConfigured(userId)` in
  // `services/google-auth.ts`): when a `userId` is passed, return the
  // per-user truth ONLY. Falling through to the owner-global
  // `isMicrosoftConfigured()` here was a tenant-leak bug — if the
  // server has owner Outlook tokens, the global check returned `true`
  // for EVERY user, including iOS users who only connected Google.
  // The unified calendar then routed createEvent to Outlook, which
  // failed inside `getAccessTokenForUser` with "Outlook not connected
  // for user N", and `Promise.allSettled` swallowed every failure —
  // the symptom was a generated plan with N sessions in the DB and
  // 0 calendar events created (see prod log 2026-04-25 user 29).
  //
  // Required server-side config still gates everything: without
  // `config.outlook.clientId` we cannot authenticate, period.
  if (!config.outlook.clientId) return false;

  if (userId !== undefined) {
    try {
      const tokens = getTokens(userId, 'outlook');
      return !!tokens?.refreshToken;
    } catch {
      return false;
    }
  }

  // No `userId` → owner / Telegram bot codepath. Fall back to the
  // owner-global check that's still the right answer for that path.
  logger.warn(
    { provider: 'outlook', scope: 'owner_global' },
    'Outlook calendar configured check fell back to owner-global scope because userId was not provided',
  );
  return isMicrosoftConfigured();
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

const PRESET_HEX_MAP: Record<string, string> = {
  preset0: '#E74C3C',
  preset1: '#F39C12',
  preset2: '#8E5C42',
  preset3: '#F4D03F',
  preset4: '#27AE60',
  preset5: '#16A085',
  preset6: '#7D8A2E',
  preset7: '#3498DB',
  preset8: '#8E44AD',
  preset9: '#C0396B',
  preset10: '#5D6D7E',
  preset11: '#34495E',
  preset12: '#95A5A6',
  preset13: '#566573',
  preset14: '#2C3E50',
  preset15: '#922B21',
  preset16: '#AF601A',
  preset17: '#6E2C00',
  preset18: '#B7950B',
  preset19: '#1E8449',
  preset20: '#117A65',
  preset21: '#7D6608',
  preset22: '#1F618D',
  preset23: '#5B2C6F',
  preset24: '#7B1E5A',
};

interface MasterCategory {
  displayName: string;
  color: string; // e.g. "preset7"
}

const masterCategoriesCache = new Map<string, MasterCategory[]>();

function masterCategoryCacheKey(userId?: number): string {
  return userId != null ? `user:${userId}` : 'owner';
}

/**
 * Fetches the user's Outlook master categories (cached after first call).
 */
export async function getMasterCategories(userId?: number): Promise<MasterCategory[]> {
  const cacheKey = masterCategoryCacheKey(userId);
  const cached = masterCategoriesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    const response = await client.api('/me/outlook/masterCategories').get();
    const cats: MasterCategory[] = (response.value || []).map((c: any) => ({
      displayName: c.displayName,
      color: c.color,
    }));
    masterCategoriesCache.set(cacheKey, cats);
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

function resolveOutlookEventColor(
  categories: string[] | undefined,
  masterCategories: MasterCategory[],
): string | undefined {
  const firstCategory = categories?.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
  if (!firstCategory) return undefined;

  const exactMatch = masterCategories.find((category) => category.displayName === firstCategory);
  if (exactMatch) {
    return PRESET_HEX_MAP[exactMatch.color];
  }

  const normalized = firstCategory.toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const fuzzyMatch = masterCategories.find((category) =>
    category.displayName.toLowerCase().replace(/\s+/g, ' ').trim() === normalized
  );
  if (fuzzyMatch) {
    return PRESET_HEX_MAP[fuzzyMatch.color];
  }

  return undefined;
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
        $select: 'id,subject,start,end,isAllDay,isCancelled,responseStatus,bodyPreview,location,webLink,categories',
      })
      .header('Prefer', `outlook.timezone="${config.app.timezone}"`)
      .get();

    const masterCategories = await getMasterCategories(userId);

    return (response.value || [])
      .filter((event: any) => !event.isCancelled && event.responseStatus?.response !== 'declined')
      .map((event: any) => ({
        id: event.id || '',
        summary: event.subject || '(No title)',
        start: event.start?.dateTime || '',
        end: event.end?.dateTime || '',
        description: event.bodyPreview || undefined,
        location: event.location?.displayName || undefined,
        htmlLink: event.webLink || undefined,
        categories: Array.isArray(event.categories) ? event.categories : undefined,
        color: resolveOutlookEventColor(
          Array.isArray(event.categories) ? event.categories : undefined,
          masterCategories
        ),
        isAllDay: !!event.isAllDay,
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
  recurrence?: NormalizedRecurrence;
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
    if (data.recurrence) {
      postBody.recurrence = data.recurrence;
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
      isAllDay: !!response.isAllDay,
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
      isAllDay: !!response.isAllDay,
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
