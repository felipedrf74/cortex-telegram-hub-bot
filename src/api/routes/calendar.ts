// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Calendar routes — token-zero data lookups for Google + Outlook calendars.
 *
 * All endpoints call `unified-calendar` directly. NO AI involvement.
 * The unified calendar layer handles parallel fetch + deduplication of events
 * that exist on both providers (e.g. an Outlook meeting that's also synced to
 * Google via the user's calendar sync).
 *
 * POST /events enables the "smart blocking" flow in the iOS app: user picks
 * a time range + title directly from a day view and the event lands on
 * their calendar without going through the AI pipeline ($0.00/call).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import {
  getEvents,
  createEvent,
  isAnyCalendarConfigured,
  type CalendarSource,
} from '../../services/unified-calendar';
import { getCached, setCache, clearCache } from '../../services/cache-store';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';

const TODAY_TTL = 120; // 2 min — calendar can change mid-day from notifications
const RANGE_TTL = 60;  // 1 min for arbitrary ranges

export function calendarRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/calendar/events?start=ISO&end=ISO
   * Returns events between start and end across all configured calendars.
   * Defaults to today if start/end omitted.
   */
  router.get('/events', asyncHandler(async (req, res: Response) => {
    if (!isAnyCalendarConfigured()) {
      sendSuccess(res, { events: [] });
      return;
    }

    const { start, end } = parseRange(req.query.start as string | undefined, req.query.end as string | undefined);
    const userId = (req as any).userId;
    const cacheKey = userId ? `u:${userId}:calendar:events:${start}:${end}` : `calendar:events:${start}:${end}`;

    const cached = getCached<any[]>(cacheKey);
    if (cached) {
      sendSuccess(res, { events: cached }, { cached: true });
      return;
    }

    try {
      const events = await getEvents(start, end);
      const formatted = events.map(formatEvent);
      setCache(cacheKey, formatted, RANGE_TTL);
      sendSuccess(res, { events: formatted });
    } catch (err: any) {
      logger.error({ err }, 'iOS calendar/events failed');
      sendError(res, 'CALENDAR_FETCH_FAILED', err?.message || 'Failed to fetch calendar events', 500);
    }
  }));

  /**
   * POST /api/v1/calendar/events
   *
   * Token-zero event creation — the "smart blocking" endpoint for the iOS
   * app. The client picks a time range + title from a visual day view
   * (iOS-native calendar style) and this creates the event directly on
   * the user's Google or Outlook calendar via the unified layer.
   *
   * Body:
   *   { title: string, start: ISO8601, end: ISO8601,
   *     description?: string, source?: "google"|"outlook" }
   *
   * Source defaults to Outlook when configured (most users treat Outlook
   * as their primary), else Google. The client can force a specific
   * source via the `source` field.
   *
   * Cache: invalidates the `calendar:today:*` and `calendar:events:*`
   * keys that overlap the new event so the dashboard reflects the new
   * event on the next poll. Full-prefix invalidation isn't supported by
   * cache-store yet, so we just kill today's cache (the most common
   * target) and let range caches expire naturally via TTL.
   */
  router.post('/events', asyncHandler(async (req, res: Response) => {
    if (!isAnyCalendarConfigured()) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }

    const body = req.body as {
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      source?: string;
    };

    if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
      sendError(res, 'VALIDATION', 'title is required', 400);
      return;
    }
    if (!body.start || !body.end) {
      sendError(res, 'VALIDATION', 'start and end (ISO 8601) are required', 400);
      return;
    }

    // Parse and validate the datetimes to avoid passing garbage through
    // to Google/Outlook which return cryptic 400s.
    const start = new Date(body.start);
    const end = new Date(body.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      sendError(res, 'VALIDATION', 'start and end must be valid ISO 8601 timestamps', 400);
      return;
    }
    if (end.getTime() <= start.getTime()) {
      sendError(res, 'VALIDATION', 'end must be after start', 400);
      return;
    }
    // Guard against absurdly-long events that would fill the user's
    // calendar with a single 30-day block.
    const durationMs = end.getTime() - start.getTime();
    if (durationMs > 24 * 60 * 60 * 1000) {
      sendError(res, 'VALIDATION', 'event duration must be ≤ 24 hours', 400);
      return;
    }

    // Optional explicit source — validated against the known sources
    const allowedSources: CalendarSource[] = ['google', 'outlook'];
    const source = body.source && allowedSources.includes(body.source as CalendarSource)
      ? (body.source as CalendarSource)
      : undefined;

    try {
      const event = await createEvent(
        {
          title: body.title.trim(),
          start: start.toISOString(),
          end: end.toISOString(),
          description: body.description?.trim() || undefined,
        },
        source,
      );

      // Invalidate today's cache so the dashboard re-fetches on next poll.
      // Range caches expire via TTL (60s), so we don't need to loop them.
      clearCache(`calendar:today:${todayDateString()}`);

      logger.info(
        { userId: (req as AuthenticatedRequest).userId, eventId: event.id, source: event.source, title: event.summary },
        'iOS calendar event created',
      );

      sendSuccess(res, { event: formatEvent(event) });
    } catch (err: any) {
      logger.error({ err, body }, 'iOS calendar event create failed');
      sendError(res, 'CALENDAR_CREATE_FAILED', err?.message || 'Failed to create event', 500);
    }
  }));

  /**
   * GET /api/v1/calendar/today
   * Shortcut for today's events in the configured timezone.
   */
  router.get('/today', asyncHandler(async (req, res: Response) => {
    if (!isAnyCalendarConfigured()) {
      sendSuccess(res, { events: [], date: todayDateString() });
      return;
    }

    const userId = (req as any).userId;
    const cacheKey = userId ? `u:${userId}:calendar:today:${todayDateString()}` : `calendar:today:${todayDateString()}`;
    const cached = getCached<any[]>(cacheKey);
    if (cached) {
      sendSuccess(res, { events: cached, date: todayDateString() }, { cached: true });
      return;
    }

    try {
      const { start, end } = todayRangeISO();
      const events = await getEvents(start, end);
      const formatted = events.map(formatEvent);
      setCache(cacheKey, formatted, TODAY_TTL);
      sendSuccess(res, { events: formatted, date: todayDateString() });
    } catch (err: any) {
      logger.error({ err }, 'iOS calendar/today failed');
      sendError(res, 'CALENDAR_FETCH_FAILED', err?.message || 'Failed to fetch today\'s events', 500);
    }
  }));

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a unified calendar event into the iOS DTO shape.
 * Keeps the response stable as the underlying providers add fields.
 */
function formatEvent(e: any) {
  return {
    id: e.id,
    title: e.summary || e.subject || e.title || '(No title)',
    description: e.description || null,
    start: e.start,
    end: e.end,
    location: e.location || null,
    source: e.source || null,
    categories: Array.isArray(e.categories) ? e.categories : null,
    isAllDay: !!e.isAllDay,
  };
}

function parseRange(startQ?: string, endQ?: string): { start: string; end: string } {
  if (startQ && endQ) return { start: startQ, end: endQ };
  return todayRangeISO();
}

function todayRangeISO(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.app.timezone });
}
