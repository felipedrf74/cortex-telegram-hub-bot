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
import { DateTime } from 'luxon';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import {
  getEventsWithDiagnostics,
  createEvent,
  updateEvent,
  deleteEvent,
  isAnyCalendarConfigured,
  hasConnectedCalendarForUser,
  hasWritableCalendarForUser,
  type CalendarSource,
} from '../../services/unified-calendar';
import { invalidateCalendarCaches } from '../../services/cache-coherence-registry';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { getFocusBlockRecommendation } from '../../services/focus-planner';
import {
  buildPomodoroDescription,
  buildPomodoroIntervals,
  pomodoroDurationMinutes,
  precheckFocusCalendarConflict,
  roundUpToNextQuarterHour,
} from '../../services/focus-blocks';
import { resolveCalendarWritePreference } from '../../services/provider-preferences';
import { isHomeFocusPillV1Enabled } from '../../services/runtime-flags';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { filterCalendarEventsForTrainingScope } from '../../services/training-calendar-scope';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';
import { getUserTimezoneById } from '../../services/user-service';
import { getAppleHealthSleepAgendaEvents } from '../../services/health-sleep-agenda';
import { requireTenantIdParam } from '../../services/tenant-scope';

const TODAY_TTL = 120; // 2 min — calendar can change mid-day from notifications
const RANGE_TTL = 60;  // 1 min for arbitrary ranges
const TODAY_SWR_STALE = 300;
const RANGE_SWR_STALE = 300;

// Phase 17 hostile-QA fix (2026-05-18): in-flight idempotency for
// POST /focus-blocks to stop duplicate writes from rapid double-taps.
const focusBlockInFlight = new Set<string>();
function focusBlockIdempotencyKey(userId: number, tenantId: number, startIso: string, mode: string): string {
  return `${userId}:${tenantId}:${startIso}:${mode}`;
}

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
    const tenantId = requireTenantIdParam((req as AuthenticatedRequest).tenantId, 'calendar.events');
    if (!hasConnectedCalendarForUser(userId)) {
      const { start, end } = parseRange(
        req.query.start as string | undefined,
        req.query.end as string | undefined,
        calendarUserTimezone(userId),
      );
      sendSuccess(res, buildSleepOnlyCalendarPayload(userId, start, end));
      return;
    }

    const { start, end } = parseRange(req.query.start as string | undefined, req.query.end as string | undefined);
    const cacheKey = calendarEventsCacheKey(userId, tenantId, start, end);
    const forceRefresh = req.query.refresh === 'true' || req.query.forceRefresh === 'true';

    try {
      await handleCachedRoute<any>({
        cacheKey,
        ttlSeconds: RANGE_TTL,
        staleSeconds: RANGE_SWR_STALE,
        refreshContext: { source: 'calendar_route', operation: 'calendar_swr_refresh', userId, tenantId },
        fetchFresh: () => buildEventsPayload(start, end, userId, tenantId),
        shouldServeCached: forceRefresh ? () => false : shouldServeCalendarCache,
        send: (value, meta) => {
          sendConditionalApiSuccess(res, req, normalizeCalendarEventsPayload(value), { cached: meta.cached });
        },
      });
    } catch (err: any) {
      if (err instanceof CalendarFetchError) {
        sendError(res, 'CALENDAR_FETCH_FAILED', err.message, 503, {
          warningCodes: err.warningCodes,
        });
        return;
      }
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
      recurrence?: unknown;
      nexusCategory?: string;
      categories?: unknown;
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
    // Phase 17 hostile-QA fix (2026-05-18): pass tenantId from AuthenticatedRequest
    // so cross-tenant users (tenantId != userId) read their persisted preference
    // instead of falling back to the (userId, userId) default which silently
    // reverts to 'auto'.
    const tenantId = (req as AuthenticatedRequest).tenantId;
    const preferenceResolution = source ? null : resolveCalendarWritePreference(userId, tenantId);
    const resolvedSource = source ?? preferenceResolution?.source ?? undefined;
    if (!resolvedSource) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', preferenceResolution?.warning || 'No calendar provider is connected', 400, {
        warningCodes: preferenceResolution?.warningCode ? [preferenceResolution.warningCode] : ['CALENDAR_INTEGRATION_MISSING'],
      });
      return;
    }

    try {
      const categories = normalizeNexusCategories(body.nexusCategory, body.categories);
      const event = await createEvent(
        {
          title: body.title.trim(),
          start: start.toISOString(),
          end: end.toISOString(),
          description: withNexusCategoryDescription(body.description?.trim() || undefined, categories),
          location: body.location?.trim() || undefined,
          categories,
          attendees: Array.isArray(body.attendees)
            ? body.attendees
                .map((value: unknown) => typeof value === 'string' ? value.trim() : '')
                .filter((value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            : undefined,
          recurrence: body.recurrence,
        },
        resolvedSource,
        userId,
      );

      invalidateCalendarCaches(userId);

      logger.info(
        { userId: (req as AuthenticatedRequest).userId, eventId: event.id, source: event.source, categories },
        'iOS calendar event created',
      );

      sendSuccess(res, {
        event: formatEvent(event),
        providerPreferenceWarning: preferenceResolution?.warningCode ? {
          code: preferenceResolution.warningCode,
          message: preferenceResolution.warning,
          requested: preferenceResolution.requested,
        } : null,
      });
    } catch (err: any) {
      logger.error(
        {
          err,
          userId,
          source: resolvedSource,
          titleLength: typeof body.title === 'string' ? body.title.trim().length : 0,
          hasDescription: typeof body.description === 'string' && body.description.trim().length > 0,
          attendeeCount: Array.isArray(body.attendees) ? body.attendees.length : 0,
          hasLocation: typeof body.location === 'string' && body.location.trim().length > 0,
          hasRecurrence: body.recurrence != null,
        },
        'iOS calendar event create failed',
      );
      sendInternalError(res, 'Failed to create event', { code: 'CALENDAR_CREATE_FAILED' });
    }
  }));

  /**
   * POST /api/v1/calendar/focus-conflict-check
   *
   * Direct pre-write conflict check for Home's focus/Pomodoro quick action.
   */
  router.post('/focus-conflict-check', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const tenantId = (req as AuthenticatedRequest).tenantId;
    // Phase 17 hostile-QA fix (2026-05-18): 403 (not 404) when the feature
    // flag is off — 404 means "the resource doesn't exist"; the endpoint
    // exists, the feature is just disabled. iOS may interpret 404 as
    // "endpoint removed" and retry against legacy paths.
    if (!isHomeFocusPillV1Enabled(process.env, { userId, tenantId })) {
      sendError(res, 'FEATURE_DISABLED', 'Focus quick actions are not enabled for this account.', 403);
      return;
    }
    if (!hasWritableCalendarForUser(userId)) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }
    const timezone = calendarUserTimezone(userId);
    const requestedSource = parseCalendarSource(req.body?.source);
    const preferenceResolution = requestedSource ? null : resolveCalendarWritePreference(userId, tenantId);
    const source = requestedSource ?? preferenceResolution?.source;
    if (!source) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', preferenceResolution?.warning || 'No calendar provider is connected', 400);
      return;
    }
    const rawStart = typeof req.body?.start === 'string' ? req.body.start : null;
    const durationMinutes = clampInt(String(req.body?.durationMinutes || ''), 30, 5, 480);
    const blocks = clampInt(String(req.body?.pomodoroBlocks || ''), 1, 1, 8);
    const mode = String(req.body?.mode || 'focus') === 'pomodoro' ? 'pomodoro' : 'focus';
    const startDate = rawStart ? new Date(rawStart) : roundUpToNextQuarterHour(new Date(), timezone);
    if (Number.isNaN(startDate.getTime())) {
      sendError(res, 'VALIDATION', 'start must be a valid ISO timestamp', 400);
      return;
    }
    const roundedStart = roundUpToNextQuarterHour(startDate, timezone);
    const actualDuration = mode === 'pomodoro' ? pomodoroDurationMinutes(blocks) : durationMinutes;
    const end = new Date(roundedStart.getTime() + actualDuration * 60_000);
    const precheck = await precheckFocusCalendarConflict({
      userId,
      source,
      start: roundedStart.toISOString(),
      end: end.toISOString(),
      timezone,
      constrainToSource: Boolean(requestedSource),
    });
    sendSuccess(res, {
      ...precheck,
      roundedStart: roundedStart.toISOString(),
      durationMinutes: actualDuration,
      pomodoroBlocks: mode === 'pomodoro' ? blocks : null,
      providerPreferenceWarning: preferenceResolution?.warningCode ? {
        code: preferenceResolution.warningCode,
        message: preferenceResolution.warning,
        requested: preferenceResolution.requested,
      } : null,
    });
  }));

  /**
   * POST /api/v1/calendar/focus-blocks
   *
   * Creates a conflict-checked focus or grouped Pomodoro blocker.
   */
  router.post('/focus-blocks', asyncHandler(async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const tenantId = (req as AuthenticatedRequest).tenantId;
    // Phase 17 hostile-QA fix (2026-05-18): 403 for disabled feature, real
    // tenantId in flag scope, tenantId in preference resolver (see GET).
    if (!isHomeFocusPillV1Enabled(process.env, { userId, tenantId })) {
      sendError(res, 'FEATURE_DISABLED', 'Focus quick actions are not enabled for this account.', 403);
      return;
    }
    if (!hasWritableCalendarForUser(userId)) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', 'No calendar provider is connected', 400);
      return;
    }
    const timezone = calendarUserTimezone(userId);
    const mode = String(req.body?.mode || 'focus') === 'pomodoro' ? 'pomodoro' : 'focus';
    const requestedSource = parseCalendarSource(req.body?.source);
    const preferenceResolution = requestedSource ? null : resolveCalendarWritePreference(userId, tenantId);
    const source = requestedSource ?? preferenceResolution?.source;
    if (!source) {
      sendError(res, 'CALENDAR_NOT_CONFIGURED', preferenceResolution?.warning || 'No calendar provider is connected', 400);
      return;
    }
    const requestedStart = typeof req.body?.start === 'string' ? new Date(req.body.start) : new Date();
    if (Number.isNaN(requestedStart.getTime())) {
      sendError(res, 'VALIDATION', 'start must be a valid ISO timestamp', 400);
      return;
    }
    const start = roundUpToNextQuarterHour(requestedStart, timezone);
    const durationMinutes = clampInt(String(req.body?.durationMinutes || ''), 30, 5, 480);
    const blocks = clampInt(String(req.body?.pomodoroBlocks || ''), 1, 1, 8);
    const actualDuration = mode === 'pomodoro' ? pomodoroDurationMinutes(blocks) : durationMinutes;
    const end = new Date(start.getTime() + actualDuration * 60_000);

    // Phase 17 hostile-QA fix (2026-05-18): per-user, per-slot idempotency
    // guard. Two rapid double-taps on the iOS Focus pill would otherwise
    // race the precheck and create two events with identical start/end.
    const idempotencyKey = focusBlockIdempotencyKey(userId, tenantId, start.toISOString(), mode);
    if (focusBlockInFlight.has(idempotencyKey)) {
      sendError(res, 'FOCUS_BLOCK_DUPLICATE', 'A focus block for this slot is already being created.', 409);
      return;
    }
    focusBlockInFlight.add(idempotencyKey);
    try {
      const precheck = await precheckFocusCalendarConflict({
        userId,
        source,
        start: start.toISOString(),
        end: end.toISOString(),
        timezone,
        constrainToSource: Boolean(requestedSource),
      });
      if (precheck.status !== 'clean') {
        sendError(res, precheck.status === 'conflicted' ? 'FOCUS_SLOT_CONFLICT' : 'FOCUS_SLOT_UNAVAILABLE', precheck.warnings[0] || 'Focus block cannot be created for this slot.', 409, {
          precheck,
        });
        return;
      }
      const intervals = mode === 'pomodoro'
        ? buildPomodoroIntervals({ start, blocks, timezone })
        : [];
      const title = mode === 'pomodoro'
        ? `Pomodoro focus (${blocks}x25)`
        : (typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'Focus time');
      const categories = mode === 'pomodoro' ? ['pomodoro', 'focus'] : ['focus'];
      const description = mode === 'pomodoro'
        ? buildPomodoroDescription(intervals, timezone)
        : withNexusCategoryDescription(typeof req.body?.description === 'string' ? req.body.description.trim() : undefined, categories);
      // Phase 17 hostile-QA fix (2026-05-18): wrap createEvent in try/catch
      // so a provider 401/403/5xx maps to typed CALENDAR_CREATE_FAILED
      // instead of a generic 500. Matches POST /events at line 229.
      let event;
      try {
        event = await createEvent(
          {
            title,
            start: start.toISOString(),
            end: end.toISOString(),
            description,
            categories,
          },
          source,
          userId,
        );
      } catch (createErr: unknown) {
        logger.warn(
          { err: createErr, userId, tenantId, source, mode, start: start.toISOString(), end: end.toISOString() },
          'Focus block calendar provider write failed',
        );
        sendError(res, 'CALENDAR_CREATE_FAILED', 'Calendar provider failed to create the focus block.', 502);
        return;
      }
      invalidateCalendarCaches(userId);
      sendSuccess(res, {
        event: formatEvent(event),
        mode,
        pomodoroIntervals: intervals,
        providerPreferenceWarning: preferenceResolution?.warningCode ? {
          code: preferenceResolution.warningCode,
          message: preferenceResolution.warning,
          requested: preferenceResolution.requested,
        } : null,
      }, { status: 201 });
    } finally {
      focusBlockInFlight.delete(idempotencyKey);
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
    const tenantId = requireTenantIdParam((req as AuthenticatedRequest).tenantId, 'calendar.today');
    if (!hasConnectedCalendarForUser(userId)) {
      const timezone = calendarUserTimezone(userId);
      const { start, end } = todayRangeISO(timezone);
      sendSuccess(res, {
        ...buildSleepOnlyCalendarPayload(userId, start, end),
        date: todayDateString(timezone),
      });
      return;
    }

    const timezone = calendarUserTimezone(userId);
    const cacheKey = calendarTodayCacheKey(userId, tenantId, todayDateString(timezone));
    const forceRefresh = req.query.refresh === 'true' || req.query.forceRefresh === 'true';

    try {
      await handleCachedRoute<any>({
        cacheKey,
        ttlSeconds: TODAY_TTL,
        staleSeconds: TODAY_SWR_STALE,
        refreshContext: { source: 'calendar_route', operation: 'calendar_swr_refresh', userId, tenantId },
        fetchFresh: () => buildTodayPayload(userId, tenantId),
        shouldServeCached: forceRefresh ? () => false : shouldServeCalendarCache,
        send: (value, meta) => {
          sendConditionalApiSuccess(res, req, { ...normalizeCalendarEventsPayload(value), date: todayDateString(timezone) }, { cached: meta.cached });
        },
      });
    } catch (err: any) {
      if (err instanceof CalendarFetchError) {
        sendError(res, 'CALENDAR_FETCH_FAILED', err.message, 503, {
          warningCodes: err.warningCodes,
        });
        return;
      }
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

class CalendarFetchError extends Error {
  constructor(message: string, readonly warningCodes: string[]) {
    super(message);
  }
}

function normalizeCalendarEventsPayload(value: any): {
  events: any[];
  status: string;
  warningCodes: string[];
  warnings: string[];
} {
  if (Array.isArray(value)) {
    return { events: value, status: 'ready', warningCodes: [], warnings: [] };
  }
  return {
    events: Array.isArray(value?.events) ? value.events : [],
    status: typeof value?.status === 'string' ? value.status : 'ready',
    warningCodes: Array.isArray(value?.warningCodes) ? value.warningCodes : [],
    warnings: Array.isArray(value?.warnings) ? value.warnings : [],
  };
}

function calendarEventsCacheKey(userId: number | undefined, tenantId: number | undefined, start: string, end: string): string {
  return typeof userId === 'number' && userId > 0
    ? routeCacheKey('t', tenantId ?? 'missing', 'u', userId, 'calendar', 'events', start, end)
    : routeCacheKey('calendar', 'events', start, end);
}

function calendarTodayCacheKey(userId: number | undefined, tenantId: number | undefined, date: string): string {
  return typeof userId === 'number' && userId > 0
    ? routeCacheKey('t', tenantId ?? 'missing', 'u', userId, 'calendar', 'today', date)
    : routeCacheKey('calendar', 'today', date);
}

function shouldServeCalendarCache(hit: { value: any; fresh: boolean }): boolean {
  return !payloadContainsTrainingCalendarEvent(hit.value);
}

function payloadContainsTrainingCalendarEvent(payload: any): boolean {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.some(isTrainingCalendarEventLike);
}

function isTrainingCalendarEventLike(event: any): boolean {
  const source = String(event?.source || '').toLowerCase();
  if (source === 'apple_health') return false;
  const text = [
    event?.title,
    event?.summary,
    event?.category,
    Array.isArray(event?.categories) ? event.categories.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(training|workout|gym|strength|run|runner|treino|corrida|academia)\b/.test(text);
}

function calendarUserTimezone(userId: number): string {
  try {
    return getUserTimezoneById(userId);
  } catch {
    return config.app.timezone || 'Europe/Lisbon';
  }
}

function buildSleepOnlyCalendarPayload(userId: number, start: string, end: string): {
  events: any[];
  status: string;
  warningCodes: string[];
  warnings: string[];
} {
  const timezone = calendarUserTimezone(userId);
  const sleepEvents = getAppleHealthSleepAgendaEvents({ userId, start, end, timezone }).map(formatEvent);
  return {
    events: sortFormattedEvents(sleepEvents),
    status: sleepEvents.length > 0 ? 'degraded' : 'unavailable',
    warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
    warnings: ['No calendar integration is connected yet.'],
  };
}

async function buildEventsPayload(start: string, end: string, userId: number, tenantId: number): Promise<{
  events: any[];
  status: string;
  warningCodes: string[];
  warnings: string[];
}> {
  // CHAT-M2: pass userId so unified-calendar checks per-user Outlook tokens
  const result = await getEventsWithDiagnostics(start, end, userId);
  if (result.status === 'unavailable' && result.sources.configured.length > 0) {
    throw new CalendarFetchError(result.warnings[0] || 'Failed to fetch calendar events', result.warningCodes);
  }

  const timezone = calendarUserTimezone(userId);
  const visibleEvents = filterCalendarEventsForTrainingScope(result.events, userId, tenantId);
  const sleepEvents = getAppleHealthSleepAgendaEvents({ userId, start, end, timezone });
  return {
    events: sortFormattedEvents([...visibleEvents.map(formatEvent), ...sleepEvents.map(formatEvent)]),
    status: result.status === 'unavailable' && sleepEvents.length > 0 ? 'degraded' : result.status,
    warningCodes: result.warningCodes,
    warnings: result.warnings,
  };
}

async function buildTodayPayload(userId: number, tenantId: number): Promise<{
  events: any[];
  status: string;
  warningCodes: string[];
  warnings: string[];
}> {
  const timezone = calendarUserTimezone(userId);
  const { start, end } = todayFetchRangeISO(timezone);
  const actualRange = todayRangeISO(timezone);
  const result = await getEventsWithDiagnostics(start, end, userId);
  if (result.status === 'unavailable' && result.sources.configured.length > 0) {
    throw new CalendarFetchError(result.warnings[0] || 'Failed to fetch today\'s events', result.warningCodes);
  }
  const formatted = filterCalendarEventsForTrainingScope(result.events, userId, tenantId)
    .filter((event) => eventOverlapsRange(event, actualRange.start, actualRange.end))
    .map(formatEvent);
  const sleepEvents = getAppleHealthSleepAgendaEvents({
    userId,
    start: actualRange.start,
    end: actualRange.end,
    timezone,
  }).map(formatEvent);
  return {
    events: sortFormattedEvents([...formatted, ...sleepEvents]),
    status: result.status === 'unavailable' && sleepEvents.length > 0 ? 'degraded' : result.status,
    warningCodes: result.warningCodes,
    warnings: result.warnings,
  };
}

function sortFormattedEvents(events: any[]): any[] {
  return events.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

/**
 * Normalize a unified calendar event into the iOS DTO shape.
 * Keeps the response stable as the underlying providers add fields.
 */
function formatEvent(e: any) {
  const rawTitle = e.summary || e.subject || e.title;
  const title = typeof rawTitle === 'string'
    ? (rawTitle.trim() || '(No title)')
    : rawTitle == null
      ? '(No title)'
      : String(rawTitle);
  return {
    id: typeof e.id === 'string' ? e.id : '',
    title,
    description: typeof e.description === 'string' && e.description.trim() ? e.description : null,
    start: typeof e.start === 'string' ? e.start : '',
    end: typeof e.end === 'string' ? e.end : '',
    location: typeof e.location === 'string' && e.location.trim() ? e.location : null,
    source: parseCalendarSource(e.source) || null,
    ...(typeof e.source === 'string' && e.source === 'apple_health' ? { source: 'apple_health' } : {}),
    ...(typeof e.category === 'string' && e.category.trim() ? { category: e.category.trim() } : {}),
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

function normalizeNexusCategories(nexusCategory: unknown, categories: unknown): string[] | undefined {
  const allowed = new Set(['focus', 'pomodoro', 'training', 'meal', 'meeting']);
  const values = [
    ...(Array.isArray(categories) ? categories : []),
    nexusCategory,
  ];
  const normalized = values
    .map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '')
    .filter((value) => allowed.has(value));
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : undefined;
}

function withNexusCategoryDescription(description: string | undefined, categories: string[] | undefined): string | undefined {
  if (!categories?.length) return description;
  const tag = `Nexus category: ${categories.join(', ')}`;
  if (description?.includes('Nexus category:')) return description;
  return description ? `${description}\n\n${tag}` : tag;
}

function parseRange(startQ?: string, endQ?: string, zone = config.app.timezone || 'Europe/Lisbon'): { start: string; end: string } {
  if (startQ && endQ) return { start: startQ, end: endQ };
  return todayRangeISO(zone);
}

function todayRangeISO(zone = config.app.timezone || 'Europe/Lisbon'): { start: string; end: string } {
  const today = DateTime.now().setZone(zone);
  const start = today.startOf('day');
  const end = today.endOf('day');
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
  };
}

function todayFetchRangeISO(zone = config.app.timezone || 'Europe/Lisbon'): { start: string; end: string } {
  const today = DateTime.now().setZone(zone);
  const start = today.startOf('day');
  const end = today.endOf('day');
  // Fetch a wider provider window so cross-midnight events that overlap today
  // are not missed, then filter back to the actual day before responding.
  return {
    start: start.minus({ days: 1 }).toUTC().toISO()!,
    end: end.plus({ days: 1 }).toUTC().toISO()!,
  };
}

function todayDateString(zone = config.app.timezone || 'Europe/Lisbon'): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: zone });
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

function eventOverlapsRange(event: { start?: string; end?: string }, rangeStart: string, rangeEnd: string): boolean {
  const actualStart = DateTime.fromISO(rangeStart, { zone: 'utc' });
  const actualEnd = DateTime.fromISO(rangeEnd, { zone: 'utc' });
  const eventStart = DateTime.fromISO(String(event.start || ''), { zone: 'utc' });
  const eventEnd = DateTime.fromISO(String(event.end || ''), { zone: 'utc' });

  if (!actualStart.isValid || !actualEnd.isValid) return false;
  if (!eventStart.isValid || !eventEnd.isValid) return false;

  return eventEnd > actualStart && eventStart < actualEnd;
}
