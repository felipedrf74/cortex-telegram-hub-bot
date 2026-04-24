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
  updateEvent,
  deleteEvent,
  isAnyCalendarConfigured,
  hasConnectedCalendarForUser,
  hasWritableCalendarForUser,
  type CalendarSource,
} from '../../services/unified-calendar';
import { getCached, setCache } from '../../services/cache-store';
import { invalidateCalendarCaches } from '../../services/calendar-cache-invalidator';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { getFocusBlockRecommendation } from '../../services/focus-planner';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

const TODAY_TTL = 120; // 2 min — calendar can change mid-day from notifications
const RANGE_TTL = 60;  // 1 min for arbitrary ranges

export function calendarRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'calendar_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/calendar/events?start=ISO&end=ISO
   * Returns events between start and end across all configured calendars.
   * Defaults to today if start/end omitted.
   */
  router.get('/events', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!hasConnectedCalendarForUser(userId)) {
      sendSuccess(res, { events: [] });
      return;
    }

    const { start, end } = parseRange(req.query.start as string | undefined, req.query.end as string | undefined);
    const cacheKey = userId ? `u:${userId}:calendar:events:${start}:${end}` : `calendar:events:${start}:${end}`;

    const cached = getCached<any[]>(cacheKey);
    if (cached) {
      sendSuccess(res, { events: cached }, { cached: true });
      return;
    }

    try {
      // CHAT-M2: pass userId so unified-calendar checks per-user Outlook tokens
      const events = await getEvents(start, end, userId);
      const formatted = events.map(formatEvent);
      setCache(cacheKey, formatted, RANGE_TTL);
      sendSuccess(res, { events: formatted });
    } catch (err: any) {
      logger.error({ err }, 'iOS calendar/events failed');
      sendInternalError(res, 'Failed to fetch calendar events', { code: 'CALENDAR_FETCH_FAILED' });
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
   * Cache: invalidates all user-scoped calendar keys plus dashboard/home
   * projections that derive from calendar truth, so the next poll sees the
   * mutation without waiting for TTL expiry.
   */
  router.post('/events', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!hasWritableCalendarForUser(userId)) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }

    const body = req.body as {
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: unknown[];
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
          location: body.location?.trim() || undefined,
          attendees: Array.isArray(body.attendees)
            ? body.attendees
                .map((value: unknown) => typeof value === 'string' ? value.trim() : '')
                .filter((value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            : undefined,
        },
        source,
        userId,
      );

      invalidateCalendarCaches(userId);

      logger.info(
        { userId: (req as AuthenticatedRequest).userId, eventId: event.id, source: event.source, title: event.summary },
        'iOS calendar event created',
      );

      sendSuccess(res, { event: formatEvent(event) });
    } catch (err: any) {
      logger.error({ err, body }, 'iOS calendar event create failed');
      sendInternalError(res, 'Failed to create event', { code: 'CALENDAR_CREATE_FAILED' });
    }
  }));

  /**
   * PATCH /api/v1/calendar/events/:eventId
   *
   * Token-zero event update for secretary-style calendar mutation
   * from the iOS dashboard. Keeps the route thin and delegates to
   * unified-calendar so provider logic stays shared.
   */
  router.patch('/events/:eventId', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!hasWritableCalendarForUser(userId)) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }

    const eventId = String(req.params.eventId || '').trim();
    if (!eventId) {
      sendError(res, 'VALIDATION', 'eventId is required', 400);
      return;
    }

    const body = req.body as {
      title?: string;
      start?: string;
      end?: string;
      source?: string;
    };

    const source = parseCalendarSource(body.source);
    if (!source) {
      sendError(res, 'VALIDATION', 'source must be google or outlook', 400);
      return;
    }

    const hasTitle = typeof body.title === 'string';
    const hasStart = typeof body.start === 'string';
    const hasEnd = typeof body.end === 'string';
    if (!hasTitle && !hasStart && !hasEnd) {
      sendError(res, 'VALIDATION', 'at least one of title, start, or end is required', 400);
      return;
    }

    const trimmedTitle = typeof body.title === 'string' ? body.title.trim() : undefined;
    if (hasTitle && !trimmedTitle) {
      sendError(res, 'VALIDATION', 'title must not be empty', 400);
      return;
    }

    const parsedStart = body.start ? new Date(body.start) : null;
    const parsedEnd = body.end ? new Date(body.end) : null;
    if (body.start && (!parsedStart || Number.isNaN(parsedStart.getTime()))) {
      sendError(res, 'VALIDATION', 'start must be a valid ISO 8601 timestamp', 400);
      return;
    }
    if (body.end && (!parsedEnd || Number.isNaN(parsedEnd.getTime()))) {
      sendError(res, 'VALIDATION', 'end must be a valid ISO 8601 timestamp', 400);
      return;
    }
    if (parsedStart && parsedEnd && parsedEnd.getTime() <= parsedStart.getTime()) {
      sendError(res, 'VALIDATION', 'end must be after start', 400);
      return;
    }

    try {
      const event = await updateEvent(
        {
          event_id: eventId,
          new_title: trimmedTitle,
          new_start: parsedStart?.toISOString(),
          new_end: parsedEnd?.toISOString(),
        },
        source,
        userId,
      );

      invalidateCalendarCaches(userId);

      logger.info({ userId, eventId, source }, 'iOS calendar event updated');
      sendSuccess(res, { event: formatEvent(event) });
    } catch (err: any) {
      logger.error({ err, eventId, source }, 'iOS calendar event update failed');
      sendInternalError(res, 'Failed to update event', { code: 'CALENDAR_UPDATE_FAILED' });
    }
  }));

  /**
   * DELETE /api/v1/calendar/events/:eventId?source=google|outlook
   *
   * Removes an event directly from the connected calendar provider
   * without involving the AI pipeline.
   */
  router.delete('/events/:eventId', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!hasWritableCalendarForUser(userId)) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }

    const eventId = String(req.params.eventId || '').trim();
    if (!eventId) {
      sendError(res, 'VALIDATION', 'eventId is required', 400);
      return;
    }

    const source = parseCalendarSource(req.query.source as string | undefined);
    if (!source) {
      sendError(res, 'VALIDATION', 'source must be google or outlook', 400);
      return;
    }

    try {
      await deleteEvent(eventId, source, userId);
      invalidateCalendarCaches(userId);
      logger.info({ userId, eventId, source }, 'iOS calendar event deleted');
      sendSuccess(res, { deleted: true, eventId, source });
    } catch (err: any) {
      logger.error({ err, eventId, source }, 'iOS calendar event delete failed');
      sendInternalError(res, 'Failed to delete event', { code: 'CALENDAR_DELETE_FAILED' });
    }
  }));

  /**
   * GET /api/v1/calendar/today
   * Shortcut for today's events in the configured timezone.
   */
  router.get('/today', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!hasConnectedCalendarForUser(userId)) {
      sendSuccess(res, { events: [], date: todayDateString() });
      return;
    }

    const cacheKey = userId ? `u:${userId}:calendar:today:${todayDateString()}` : `calendar:today:${todayDateString()}`;
    const cached = getCached<any[]>(cacheKey);
    if (cached) {
      sendSuccess(res, { events: cached, date: todayDateString() }, { cached: true });
      return;
    }

    try {
      const { start, end } = todayRangeISO();
      // CHAT-M2: pass userId for per-user Outlook token resolution
      const events = await getEvents(start, end, userId);
      const formatted = events.map(formatEvent);
      setCache(cacheKey, formatted, TODAY_TTL);
      sendSuccess(res, { events: formatted, date: todayDateString() });
    } catch (err: any) {
      logger.error({ err }, 'iOS calendar/today failed');
      sendInternalError(res, 'Failed to fetch today\'s events', { code: 'CALENDAR_FETCH_FAILED' });
    }
  }));

  /**
   * GET /api/v1/calendar/focus-recommendation?durationMinutes=90&horizonDays=4
   *
   * Cross-skill token-zero focus-block suggestion. Uses:
   *   - current calendar availability,
   *   - today's readiness/recovery,
   *   - planned training load for the next few days.
   *
   * This is the Secretary surface for "find my best hours and protect them"
   * without sending a chat prompt through the AI pipeline.
   */
  router.get('/focus-recommendation', asyncHandler(async (req, res: Response) => {
    const durationMinutes = clampInt(req.query.durationMinutes as string | undefined, 90, 30, 180);
    const horizonDays = clampInt(req.query.horizonDays as string | undefined, 4, 1, 7);

    try {
      const userId = (req as AuthenticatedRequest).userId;
      const focusRecommendation = await getFocusBlockRecommendation(userId, {
        durationMinutes,
        horizonDays,
      });
      sendSuccess(res, { focusRecommendation, durationMinutes, horizonDays });
    } catch (err: any) {
      logger.error({ err }, 'iOS calendar/focus-recommendation failed');
      sendInternalError(res, 'Failed to build focus recommendation', { code: 'FOCUS_RECOMMENDATION_FAILED' });
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
    color: typeof e.color === 'string' ? e.color : null,
    isAllDay: !!e.isAllDay,
  };
}

function parseCalendarSource(value?: string): CalendarSource | null {
  if (value === 'google' || value === 'outlook') {
    return value;
  }
  return null;
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

function clampInt(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
