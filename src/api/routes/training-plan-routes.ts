// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { invalidateCalendarCaches } from '../../services/calendar-cache-invalidator';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import {
  acquireCostLock,
  buildQuotaExceededMessage,
  isUserOverDailyCap,
} from '../../services/cost-guardrail';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import { generateTrainingPlanForUser } from './training-plan-generation';
import { syncTrainingPlanCalendar } from './training-plan-calendar-sync';

type TrainingScreenCacheInvalidator = (userId: number) => void;

interface TrainingPlanRouteOptions {
  invalidateTrainingScreenCaches: TrainingScreenCacheInvalidator;
}

export function registerTrainingPlanRoutes(
  router: Router,
  options: TrainingPlanRouteOptions,
): void {
  const { invalidateTrainingScreenCaches } = options;

  /**
   * POST /api/v1/training/plan/generate
   *
   * Token-efficient training plan generation. One AI call produces a
   * full monthly plan — replaces the 70+ tool-call chat flow with a
   * single structured JSON generation + bulk insert.
   *
   * Flow:
   *   1. Read user's fitness profile from onboarding answers
   *   2. Fetch calendar events for the next 4 weeks → find free slots
   *   3. One Gemini call → get structured plan JSON
   *   4. Bulk insert: plan + weeks + sessions + calendar events
   *   5. Return plan summary to iOS
   *
   * Body: { objective: string, durationWeeks?: number, preferredTime?: string }
   */
  router.post('/plan/generate', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const {
      objective,
      durationWeeks = 4,
      preferredTime = '12:00',
      preferredCardioTime,
      preferredStrengthTime,
      sessionsPerWeek = 5,
      strengthSessionsPerWeek = 2,
      longWorkoutDay,
      notes,
    } = req.body;

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    // TOCTOU-safe cost window — serialize check + AI + api_usage row
    // per user. See acquireCostLock docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    const quota = isUserOverDailyCap(userId);
    if (quota.over) {
      releaseCostLock();
      sendError(
        res,
        'QUOTA_EXCEEDED',
        buildQuotaExceededMessage(quota),
        402,
        { plan: quota.plan, resetAt: quota.resetAt },
      );
      return;
    }

    try {
      const result = await generateTrainingPlanForUser({
        userId,
        objective,
        durationWeeks,
        preferredTime,
        preferredCardioTime,
        preferredStrengthTime,
        sessionsPerWeek,
        strengthSessionsPerWeek,
        longWorkoutDay,
        notes,
      });

      if (result.status === 'needs_profile') {
        sendSuccess(res, result.data);
        return;
      }

      logger.info({
        userId,
        planId: result.planId,
        totalSessions: result.totalSessions,
        eventsCreated: result.eventsCreated,
        objective,
        durationWeeks: result.durationWeeks,
      }, 'Training plan generated and scheduled');
      if (result.eventsCreated > 0) {
        invalidateCalendarCaches(userId);
      }
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, result.data, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      sendError(res, 'INTERNAL', 'Failed to generate training plan. Please try again.', 500);
    } finally {
      releaseCostLock();
    }
  });

  /**
   * POST /api/v1/training/plan/sync-calendar
   *
   * Backfill calendar events for the user's active plan. Used as the
   * recovery path when a plan was generated while the user's calendar
   * provider was in `invalid_grant` (or any other failed state) — at
   * generation time every `createEvent` failed and the plan landed with
   * `eventsCreated: 0`. After the user reauths via the Connections
   * sheet, calling this endpoint walks the plan and creates the missing
   * calendar events. Idempotent: sessions that already have a
   * `calendar_event_id` are reported as `sessionsAlreadySynced` and not
   * touched on retry.
   */
  router.post('/plan/sync-calendar', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      const result = await syncTrainingPlanCalendar(userId);
      if (result.status === 'no_active_plan') {
        sendSuccess(res, result.data);
        return;
      }
      if (result.status === 'no_calendar') {
        sendError(res, 'NO_CALENDAR', result.data.message, 409, result.data);
        return;
      }
      if (result.data.eventsCreated > 0) {
        // Calendar caches need to forget the empty pre-sync state so
        // the next /training/week pull surfaces the freshly-linked
        // start times instead of serving the cached `time: null`s.
        invalidateCalendarCaches(userId);
      }
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, result.data);
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan calendar sync failed');
      sendInternalError(res, 'Failed to sync training plan to calendar');
    }
  });

  router.post('/plan/cancel', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      const result = await cancelTrainingPlanForUser(userId, req.body?.planId);
      if (result.status === 'forbidden') {
        sendError(res, 'FORBIDDEN', 'This training plan does not belong to the current user.', 403);
        return;
      }
      if (result.status === 'not_found') {
        sendSuccess(res, result.data);
        return;
      }

      // Hard-delete removes calendar events too — make sure the
      // unified-inbox / dashboard calendar caches don't keep
      // serving the deleted events as if they still existed.
      invalidateCalendarCaches(userId);
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, result.data);
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan cancellation failed');
      sendInternalError(res, 'Failed to cancel training plan');
    }
  });
}
