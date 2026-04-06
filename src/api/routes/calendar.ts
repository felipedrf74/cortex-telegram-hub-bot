// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Calendar routes — token-zero data lookups for Google + Outlook calendars.
 *
 * All endpoints call `unified-calendar.getEvents()` directly. NO AI involvement.
 * The unified calendar layer handles parallel fetch + deduplication of events
 * that exist on both providers (e.g. an Outlook meeting that's also synced to
 * Google via the user's calendar sync).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getEvents, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { getCached, setCache } from '../../services/cache-store';
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
    const cacheKey = `calendar:events:${start}:${end}`;

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
   * GET /api/v1/calendar/today
   * Shortcut for today's events in the configured timezone.
   */
  router.get('/today', asyncHandler(async (_req, res: Response) => {
    if (!isAnyCalendarConfigured()) {
      sendSuccess(res, { events: [], date: todayDateString() });
      return;
    }

    const cacheKey = `calendar:today:${todayDateString()}`;
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
