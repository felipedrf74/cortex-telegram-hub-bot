// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getGraphClient, getGraphClientForUser, isMicrosoftConfigured } from './microsoft-auth';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getTokens } from './oauth-store';
import { CalendarEvent } from './google-calendar';
import type { NormalizedRecurrence } from './recurrence-utils';
import { isProviderEventNotFoundError } from './training-calendar-errors';
import { withTimeout } from '../utils/timeout';

const OUTLOOK_IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';
const OUTLOOK_EVENTS_MAX_PAGES = 10;
const OUTLOOK_API_TIMEOUT_MS = 15_000;

function outlookCalendarViewPreferHeader(): string {
  return `outlook.timezone="${config.app.timezone}", ${OUTLOOK_IMMUTABLE_ID_PREFER}`;
}

function fullOutlookEventDescription(event: any): string | undefined {
  const bodyContent = typeof event?.body?.content === 'string' ? event.body.content : '';
  if (bodyContent.trim()) return bodyContent;
  return event?.bodyPreview || undefined;
}

function graphApiPathFromNextLink(nextLink: string): string {
  try {
    const url = new URL(nextLink);
    const path = url.pathname.startsWith('/v1.0/')
      ? url.pathname.slice('/v1.0'.length)
      : url.pathname;
    return `${path}${url.search}`;
  } catch {
    return nextLink;
  }
}

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
    const response = await withTimeout(
      client.api('/me/outlook/masterCategories').get(),
      OUTLOOK_API_TIMEOUT_MS,
    );
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
    const firstResponse = await withTimeout(client
      .api('/me/calendarView')
      .query({
        startDateTime: new Date(startDate).toISOString(),
        endDateTime: new Date(endDate).toISOString(),
        $orderby: 'start/dateTime',
        $top: 100,
        $select: 'id,subject,start,end,isAllDay,isCancelled,responseStatus,showAs,bodyPreview,body,location,webLink,categories,iCalUId,originalStart,organizer',
      })
      .header('Prefer', outlookCalendarViewPreferHeader())
      .get(), OUTLOOK_API_TIMEOUT_MS);

    const values: any[] = [...(firstResponse.value || [])];
    let nextLink = firstResponse['@odata.nextLink'];
    let pageCount = 1;
    while (typeof nextLink === 'string' && nextLink && pageCount < OUTLOOK_EVENTS_MAX_PAGES) {
      const request = client.api(graphApiPathFromNextLink(nextLink));
      request.header('Prefer', outlookCalendarViewPreferHeader());
      const page = await withTimeout(request.get(), OUTLOOK_API_TIMEOUT_MS);
      values.push(...(page.value || []));
      nextLink = page['@odata.nextLink'];
      pageCount += 1;
    }
    if (typeof nextLink === 'string' && nextLink) {
      throw new Error(`Outlook calendar pagination page limit exceeded (${OUTLOOK_EVENTS_MAX_PAGES})`);
    }

    const masterCategories = await getMasterCategories(userId);

    return values
      .filter((event: any) => !event.isCancelled && event.responseStatus?.response !== 'declined')
      .map((event: any) => ({
        id: event.id || '',
        summary: event.subject || '(No title)',
        start: event.start?.dateTime || '',
        end: event.end?.dateTime || '',
        description: fullOutlookEventDescription(event),
        location: event.location?.displayName || undefined,
        htmlLink: event.webLink || undefined,
        categories: Array.isArray(event.categories) ? event.categories : undefined,
        color: resolveOutlookEventColor(
          Array.isArray(event.categories) ? event.categories : undefined,
          masterCategories
        ),
        isAllDay: !!event.isAllDay,
        timeZone: event.start?.timeZone || event.end?.timeZone,
        // Graph's schedule contract groups `free` and `workingElsewhere` as
        // availabilityView 0. Tentative, busy, OOF, unknown, and missing
        // values remain conservatively blocking.
        blocksTime: !['free', 'workingelsewhere']
          .includes(String(event.showAs ?? '').trim().toLowerCase()),
        providerUid: typeof event.iCalUId === 'string' ? event.iCalUId : undefined,
        providerOccurrenceStart: typeof event.originalStart === 'string'
          ? event.originalStart
          : undefined,
        organizer: typeof event.organizer?.emailAddress?.address === 'string'
          ? event.organizer.emailAddress.address.trim().toLowerCase()
          : undefined,
      }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Outlook calendar events');
    throw err;
  }
}

export async function getEventById(eventId: string, userId?: number): Promise<CalendarEvent | null> {
  try {
    return await getOutlookEventRequest(eventId, userId, true);
  } catch (err) {
    if (shouldRetryOutlookRequestWithoutImmutableId(err)) {
      try {
        return await getOutlookEventRequest(eventId, userId, false);
      } catch (retryErr) {
        if (isProviderEventNotFoundError(retryErr)) return null;
        logger.error({ err: retryErr }, 'Failed to fetch Outlook calendar event by id after legacy id retry');
        throw retryErr;
      }
    }
    if (isProviderEventNotFoundError(err)) return null;
    logger.error({ err }, 'Failed to fetch Outlook calendar event by id');
    throw err;
  }
}

async function getOutlookEventRequest(
  eventId: string,
  userId: number | undefined,
  preferImmutableId: boolean,
): Promise<CalendarEvent> {
  const client = userId
    ? getGraphClientForUser(userId)
    : getGraphClient();
  const request = client.api(`/me/events/${eventId}`);
  if (preferImmutableId) request.header('Prefer', OUTLOOK_IMMUTABLE_ID_PREFER);
  const event = await withTimeout(request.get(), OUTLOOK_API_TIMEOUT_MS);
  return {
    id: event.id || eventId,
    summary: event.subject || '(No title)',
    start: event.start?.dateTime || '',
    end: event.end?.dateTime || '',
    description: fullOutlookEventDescription(event),
    location: event.location?.displayName || undefined,
    htmlLink: event.webLink || undefined,
    categories: Array.isArray(event.categories) ? event.categories : undefined,
    isAllDay: !!event.isAllDay,
    timeZone: event.start?.timeZone || event.end?.timeZone,
    blocksTime: !['free', 'workingelsewhere']
      .includes(String(event.showAs ?? '').trim().toLowerCase()),
    providerUid: typeof event.iCalUId === 'string' ? event.iCalUId : undefined,
    providerOccurrenceStart: typeof event.originalStart === 'string'
      ? event.originalStart
      : undefined,
    organizer: typeof event.organizer?.emailAddress?.address === 'string'
      ? event.organizer.emailAddress.address.trim().toLowerCase()
      : undefined,
  };
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
    if (options?.signal?.aborted) throw new Error('provider_write_aborted');
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
    const writableCategories = await resolveWritableOutlookCategories(data.categories, userId);
    if (writableCategories.length > 0) {
      postBody.categories = writableCategories;
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
      {
        titleLength: String(postBody.subject || '').length,
        categoryCount: Array.isArray(postBody.categories) ? postBody.categories.length : 0,
        droppedCategoryCount: Math.max(0, (data.categories?.length ?? 0) - writableCategories.length),
        attendeeCount: attendees.length,
      },
      'Creating Outlook calendar event',
    );
    const request = client.api('/me/events');
    request.header('Prefer', OUTLOOK_IMMUTABLE_ID_PREFER);
    if (options?.signal) request.option('signal', options.signal);
    const response = await request.post(postBody);

    return {
      id: response.id || '',
      summary: response.subject || data.title,
      start: response.start?.dateTime || data.start,
      end: response.end?.dateTime || data.end,
      description: response.bodyPreview || undefined,
      htmlLink: response.webLink || undefined,
      categories: Array.isArray(response.categories) ? response.categories : (writableCategories.length > 0 ? writableCategories : undefined),
      isAllDay: !!response.isAllDay,
      providerUid: typeof response.iCalUId === 'string' ? response.iCalUId : undefined,
      providerOccurrenceStart: typeof response.originalStart === 'string'
        ? response.originalStart
        : undefined,
      organizer: typeof response.organizer?.emailAddress?.address === 'string'
        ? response.organizer.emailAddress.address.trim().toLowerCase()
        : undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create Outlook calendar event');
    throw err;
  }
}

async function resolveWritableOutlookCategories(categories: string[] | undefined, userId?: number): Promise<string[]> {
  const cleanCategories = [...new Set((categories || [])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean))];
  if (cleanCategories.length === 0) return [];

  const masterCategories = await getMasterCategories(userId);
  if (masterCategories.length === 0) {
    logger.warn(
      { requestedCategories: cleanCategories },
      'Dropping Outlook event categories because master categories could not be verified',
    );
    return [];
  }

  const byNormalizedName = new Map(
    masterCategories.map((category) => [normalizeCategoryName(category.displayName), category.displayName] as const),
  );
  const writable = cleanCategories
    .map((category) => byNormalizedName.get(normalizeCategoryName(category)))
    .filter((category): category is string => Boolean(category));
  const dropped = cleanCategories.filter((category) => !byNormalizedName.has(normalizeCategoryName(category)));
  if (dropped.length > 0) {
    logger.warn(
      { droppedCategories: dropped, writableCategories: writable },
      'Dropping Outlook event categories that are not in the user master category list',
    );
  }
  return [...new Set(writable)];
}

function normalizeCategoryName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function updateEvent(data: {
  event_id: string;
  new_start?: string;
  new_end?: string;
  new_title?: string;
  new_description?: string;
}, userId?: number, options?: { signal?: AbortSignal }): Promise<CalendarEvent> {
  try {
    if (options?.signal?.aborted) throw new Error('provider_write_aborted');
    const client = userId
      ? getGraphClientForUser(userId)
      : getGraphClient();
    const patch: any = {};

    if (data.new_title) patch.subject = data.new_title;
    if (data.new_description !== undefined) {
      patch.body = {
        contentType: 'text',
        content: data.new_description,
      };
    }
    if (data.new_start) patch.start = { dateTime: data.new_start, timeZone: config.app.timezone };
    if (data.new_end) patch.end = { dateTime: data.new_end, timeZone: config.app.timezone };

    const request = client.api(`/me/events/${data.event_id}`);
    request.header('Prefer', OUTLOOK_IMMUTABLE_ID_PREFER);
    if (options?.signal) request.option('signal', options.signal);
    const response = await request.patch(patch);

    return {
      id: response.id || data.event_id,
      summary: response.subject || '',
      start: response.start?.dateTime || '',
      end: response.end?.dateTime || '',
      description: response.bodyPreview || undefined,
      htmlLink: response.webLink || undefined,
      isAllDay: !!response.isAllDay,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update Outlook calendar event');
    throw err;
  }
}

export async function deleteEvent(eventId: string, userId?: number, options?: { signal?: AbortSignal }): Promise<void> {
  try {
    if (options?.signal?.aborted) throw new Error('provider_write_aborted');
    await deleteOutlookEventRequest(eventId, userId, options, true);
  } catch (err) {
    if (shouldRetryOutlookRequestWithoutImmutableId(err)) {
      logger.debug(
        { err, userId },
        'Retrying Outlook event delete without immutable-id preference for legacy stored event id',
      );
      try {
        await deleteOutlookEventRequest(eventId, userId, options, false);
        return;
      } catch (retryErr) {
        if (isProviderEventNotFoundError(retryErr)) throw retryErr;
        logger.error({ err: retryErr }, 'Failed to delete Outlook calendar event after legacy id retry');
        throw retryErr;
      }
    }
    if (isProviderEventNotFoundError(err)) throw err;
    logger.error({ err }, 'Failed to delete Outlook calendar event');
    throw err;
  }
}

async function deleteOutlookEventRequest(
  eventId: string,
  userId: number | undefined,
  options: { signal?: AbortSignal } | undefined,
  preferImmutableId: boolean,
): Promise<void> {
  const client = userId
    ? getGraphClientForUser(userId)
    : getGraphClient();
  const request = client.api(`/me/events/${eventId}`);
  if (preferImmutableId) request.header('Prefer', OUTLOOK_IMMUTABLE_ID_PREFER);
  if (options?.signal) request.option('signal', options.signal);
  await request.delete();
}

function shouldRetryOutlookRequestWithoutImmutableId(err: unknown): boolean {
  const candidate = err as { statusCode?: unknown; code?: unknown; message?: unknown; body?: unknown } | null;
  if (!candidate || typeof candidate !== 'object') return false;
  if (Number(candidate.statusCode) !== 400) return false;
  const code = String(candidate.code || '');
  const message = `${String(candidate.message || '')} ${String(candidate.body || '')}`.toLowerCase();
  return code === 'ErrorInvalidRequest' && message.includes('non-calendar folder');
}
