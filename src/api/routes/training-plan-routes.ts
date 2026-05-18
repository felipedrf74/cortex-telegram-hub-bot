// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { invalidateCalendarCaches } from '../../services/cache-coherence-registry';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import {
  acquireCostLock,
  enforceCostGuardrails,
} from '../../services/cost-guardrail';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import { generateTrainingPlanForUser } from './training-plan-generation';
import {
  confirmTrainingSessionReflow,
  previewTrainingSessionReflow,
  syncTrainingPlanCalendar,
} from './training-plan-calendar-sync';
import {
  isTrainingCalendarWritesEnabled,
  isTrainingPlanGenerationEnabled,
  trainingOperationDisabledMessage,
} from '../../services/training-operational-switches';
import { validateRequestedTrainingCalendarSource } from '../../services/training-calendar-source';
import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
  normalizeTrainingPlanGenerationIdempotencyKey,
} from '../../services/training-plan-generation-idempotency';

type TrainingScreenCacheInvalidator = (userId: number) => void;

interface TrainingPlanRouteOptions {
  invalidateTrainingScreenCaches: TrainingScreenCacheInvalidator;
}

export function registerTrainingPlanRoutes(
  router: Router,
  options: TrainingPlanRouteOptions,
): void {
  const { invalidateTrainingScreenCaches } = options;

  router.post('/plan/preview', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!isTrainingPlanGenerationEnabled()) {
      sendError(
        res,
        'TRAINING_GENERATION_DISABLED',
        trainingOperationDisabledMessage('plan_generation'),
        503,
        { operation: 'plan_generation' },
      );
      return;
    }

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
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference,
      calendarSource,
    } = req.body;

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    const calendarSourceValidation = validateRequestedTrainingCalendarSource(userId, calendarSource);
    if (!calendarSourceValidation.ok) {
      sendError(
        res,
        calendarSourceValidation.code,
        calendarSourceValidation.message,
        calendarSourceValidation.status,
      );
      return;
    }

    try {
      const result = await generateTrainingPlanForUser({
        userId,
        tenantId,
        objective,
        durationWeeks,
        preferredTime,
        preferredCardioTime,
        preferredStrengthTime,
        sessionsPerWeek,
        strengthSessionsPerWeek,
        longWorkoutDay,
        notes,
        goalMode,
        trainingPriority,
        raceDate,
        twoADayPreference: typeof twoADayPreference === 'string'
          && (twoADayPreference === 'never' || twoADayPreference === 'optional' || twoADayPreference === 'preferred')
          ? twoADayPreference
          : undefined,
        calendarSource: calendarSourceValidation.source,
        previewOnly: true,
      });

      if (result.status === 'needs_profile') {
        sendSuccess(res, result.data);
        return;
      }
      if (result.status === 'preview') {
        sendSuccess(res, result.data);
        return;
      }
      sendInternalError(res, 'Failed to preview training plan');
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan preview failed');
      sendError(res, 'INTERNAL', 'Failed to preview training plan. Please try again.', 500);
    }
  });

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
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!isTrainingPlanGenerationEnabled()) {
      sendError(
        res,
        'TRAINING_GENERATION_DISABLED',
        trainingOperationDisabledMessage('plan_generation'),
        503,
        { operation: 'plan_generation' },
      );
      return;
    }

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
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference,
      calendarSource,
    } = req.body;

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    const calendarSourceValidation = validateRequestedTrainingCalendarSource(userId, calendarSource);
    if (!calendarSourceValidation.ok) {
      sendError(
        res,
        calendarSourceValidation.code,
        calendarSourceValidation.message,
        calendarSourceValidation.status,
      );
      return;
    }

    const generationRequest = {
      objective,
      durationWeeks,
      preferredTime,
      preferredCardioTime,
      preferredStrengthTime,
      sessionsPerWeek,
      strengthSessionsPerWeek,
      longWorkoutDay,
      notes,
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference,
      calendarSource: calendarSourceValidation.source,
    };
    const idempotencyKey = normalizeTrainingPlanGenerationIdempotencyKey(
      req.body?.idempotencyKey
        ?? req.header('x-idempotency-key')
        ?? req.header('idempotency-key'),
    );
    const requestHash = fingerprintTrainingPlanGenerationRequest(generationRequest);
    const idempotencyClaim = claimTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
    if (idempotencyClaim.kind === 'replay') {
      sendSuccess(res, idempotencyClaim.responseData, { status: idempotencyClaim.statusCode });
      return;
    }
    if (idempotencyClaim.kind === 'in_progress') {
      sendError(
        res,
        'TRAINING_PLAN_GENERATION_IN_PROGRESS',
        'This plan creation is already in progress. Please wait for the current result instead of creating another plan.',
        409,
        { idempotencyKey: idempotencyClaim.idempotencyKey },
      );
      return;
    }
    if (idempotencyClaim.kind === 'conflict') {
      sendError(
        res,
        'IDEMPOTENCY_KEY_REUSED',
        'This plan creation key was already used for different inputs. Start a fresh preview before creating again.',
        409,
        { idempotencyKey: idempotencyClaim.idempotencyKey },
      );
      return;
    }

    // TOCTOU-safe cost window — serialize check + AI + api_usage row
    // per user. See acquireCostLock docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    const guardrail = enforceCostGuardrails(userId);
    if (guardrail.block) {
      releaseCostLock();
      failTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
      sendError(
        res,
        guardrail.reason,
        guardrail.message,
        guardrail.status,
        guardrail.details,
      );
      return;
    }

    try {
      const result = await generateTrainingPlanForUser({
        userId,
        tenantId,
        objective,
        durationWeeks,
        preferredTime,
        preferredCardioTime,
        preferredStrengthTime,
        sessionsPerWeek,
        strengthSessionsPerWeek,
        longWorkoutDay,
        notes,
        goalMode,
        trainingPriority,
        raceDate,
        twoADayPreference: typeof twoADayPreference === 'string'
          && (twoADayPreference === 'never' || twoADayPreference === 'optional' || twoADayPreference === 'preferred')
          ? twoADayPreference
          : undefined,
        calendarSource: calendarSourceValidation.source,
      });

      if (result.status === 'needs_profile') {
        completeTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash, result.data, 200);
        sendSuccess(res, result.data);
        return;
      }

      // Slice 4.D.2 — saga abort. The pre-persist cancellation
      // could not finalize the local hard-delete of the prior
      // plan, so creating a new plan would corrupt state. We
      // surface a 409 with an actionable reason instead.
      if (result.status === 'cancellation_failed') {
        logger.warn(
          { userId, reason: result.data.reason, activePlansRemaining: result.data.activePlansRemaining },
          'Training plan generation aborted by cancellation saga',
        );
        sendError(
          res,
          'CANCELLATION_FAILED',
          result.data.message,
          409,
          {
            reason: result.data.reason,
            activePlansRemaining: result.data.activePlansRemaining,
          },
        );
        failTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
        return;
      }

      if (result.status === 'plan_quality_blocked') {
        logger.warn(
          {
            userId,
            blockerRuleIds: result.data.planLint.blockers.map((b) => b.ruleId),
            warningRuleIds: result.data.planLint.warnings.map((w) => w.ruleId),
          },
          'Training plan generation blocked by strict quality gate',
        );
        completeTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash, result.data, 200);
        sendSuccess(res, result.data);
        return;
      }

      if (result.status === 'preview') {
        logger.warn({ userId }, 'Training plan generate route returned preview unexpectedly');
        failTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
        sendError(res, 'INVALID_PLAN_GENERATION_STATE', 'Plan preview must be confirmed before creation.', 409);
        return;
      }

      logger.info({
        userId,
        planId: result.planId,
        totalSessions: result.totalSessions,
        eventsCreated: result.eventsCreated,
        objectiveLength: objective.trim().length,
        durationWeeks: result.durationWeeks,
      }, 'Training plan generated and scheduled');
      // Generation now replaces any existing active plan before
      // persisting the new one, so calendar truth can change even when
      // the new plan could not create calendar blocks.
      invalidateCalendarCaches(userId);
      invalidateTrainingScreenCaches(userId);

      completeTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash, result.data, 201);
      sendSuccess(res, result.data, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      failTrainingPlanGenerationIdempotency(userId, idempotencyKey, requestHash);
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
   * calendar events. Idempotent: sessions that already have a verified
   * provider event are reported as `sessionsAlreadySynced`; stale or
   * missing provider links are repaired instead of silently no-oping.
   */
  router.post('/plan/sync-calendar', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!isTrainingCalendarWritesEnabled()) {
      sendError(
        res,
        'TRAINING_CALENDAR_SYNC_DISABLED',
        trainingOperationDisabledMessage('calendar_writes'),
        503,
        { operation: 'calendar_writes' },
      );
      return;
    }

    try {
      const calendarSourceValidation = validateRequestedTrainingCalendarSource(userId, req.body?.calendarSource);
      if (!calendarSourceValidation.ok) {
        sendError(
          res,
          calendarSourceValidation.code,
          calendarSourceValidation.message,
          calendarSourceValidation.status,
        );
        return;
      }

      const result = await syncTrainingPlanCalendar(userId, new Date(), calendarSourceValidation.source, tenantId);
      if (result.status === 'no_active_plan') {
        sendSuccess(res, result.data);
        return;
      }
      if (result.status === 'no_calendar') {
        sendError(res, 'NO_CALENDAR', result.data.message, 409, result.data);
        return;
      }
      if (result.data.eventsCreated > 0 || result.data.sessionsLinked > 0) {
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

  router.post('/sessions/:id/reflow-preview', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      sendError(res, 'VALIDATION', 'session id is required', 400);
      return;
    }

    try {
      const calendarSourceValidation = validateRequestedTrainingCalendarSource(userId, req.body?.calendarSource);
      if (!calendarSourceValidation.ok) {
        sendError(
          res,
          calendarSourceValidation.code,
          calendarSourceValidation.message,
          calendarSourceValidation.status,
        );
        return;
      }

      const result = await previewTrainingSessionReflow(userId, sessionId, calendarSourceValidation.source, tenantId);
      if (result.status === 'forbidden') {
        sendError(res, 'FORBIDDEN', result.data.message, 403, result.data);
        return;
      }
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', result.data.message, 404, result.data);
        return;
      }
      if (result.status === 'no_calendar' || result.status === 'blocked') {
        sendError(res, result.status === 'no_calendar' ? 'NO_CALENDAR' : 'NO_REFLOW_SLOT', result.data.message, 409, result.data);
        return;
      }
      sendSuccess(res, result.data);
    } catch (err: any) {
      logger.error({ err, userId, sessionId }, 'Training session reflow preview failed');
      sendInternalError(res, 'Failed to preview training session reflow');
    }
  });

  router.post('/sessions/:id/reflow-confirm', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      sendError(res, 'VALIDATION', 'session id is required', 400);
      return;
    }
    if (!isTrainingCalendarWritesEnabled()) {
      sendError(
        res,
        'TRAINING_CALENDAR_SYNC_DISABLED',
        trainingOperationDisabledMessage('calendar_writes'),
        503,
        { operation: 'calendar_writes' },
      );
      return;
    }

    try {
      const calendarSourceValidation = validateRequestedTrainingCalendarSource(userId, req.body?.calendarSource);
      if (!calendarSourceValidation.ok) {
        sendError(
          res,
          calendarSourceValidation.code,
          calendarSourceValidation.message,
          calendarSourceValidation.status,
        );
        return;
      }

      const result = await confirmTrainingSessionReflow({
        userId,
        tenantId,
        sessionId,
        proposedStartAt: typeof req.body?.proposedStartAt === 'string' ? req.body.proposedStartAt : null,
        proposedEndAt: typeof req.body?.proposedEndAt === 'string' ? req.body.proposedEndAt : null,
        requestedCalendarSource: calendarSourceValidation.source,
      });
      if (result.status === 'forbidden') {
        sendError(res, 'FORBIDDEN', result.data.message, 403, result.data);
        return;
      }
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', result.data.message, 404, result.data);
        return;
      }
      if (result.status === 'no_calendar' || result.status === 'blocked') {
        sendError(res, result.status === 'no_calendar' ? 'NO_CALENDAR' : 'NO_REFLOW_SLOT', result.data.message, 409, result.data);
        return;
      }
      invalidateCalendarCaches(userId);
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, result.data, { status: result.status === 'partial_failure' ? 202 : 200 });
    } catch (err: any) {
      logger.error({ err, userId, sessionId }, 'Training session reflow confirm failed');
      sendInternalError(res, 'Failed to confirm training session reflow');
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
