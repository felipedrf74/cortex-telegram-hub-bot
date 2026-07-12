// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { invalidateCalendarCaches } from '../../services/cache-coherence-registry';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import {
  TRAINING_PLAN_GENERATOR_POLICY_VERSION,
  generateTrainingPlanForUser,
} from './training-plan-generation';
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
import { isPastIsoDate, isStrictIsoDate } from '../../services/training-date-utils';
import * as trainingPlans from '../../services/training-plans';
import {
  claimTrainingPlanGenerationIdempotency,
  clearTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
  normalizeTrainingPlanGenerationIdempotencyKey,
} from '../../services/training-plan-generation-idempotency';
import { assertLegacyPlanGenerationAllowed } from '../../services/training-plan-revision-legacy-guard';
import { TrainingPlanRevisionError } from '../../services/training-plan-revision-errors';
import { runTrainingPlanRevisionShadowForLegacyRequest } from '../../services/training-plan-revision-shadow';

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
    runTrainingPlanRevisionShadowForLegacyRequest({ scope: { userId, tenantId }, body: req.body });
    if (!allowLegacyGenerationRoute(res, { userId, tenantId })) return;

    const {
      objective,
      durationWeeks = 4,
      preferredTime = '12:00',
      preferredCardioTime,
      preferredStrengthTime,
      sessionsPerWeek = 5,
      runSessionsPerWeek,
      bikeSessionsPerWeek,
      swimSessionsPerWeek,
      strengthSessionsPerWeek,
      startPolicy,
      longWorkoutDay,
      notes,
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference,
      calendarSource,
    } = req.body;
    const normalizedTwoADayPreference = normalizeTrainingTwoADayPreference(twoADayPreference);

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    const planRequestValidation = validateTrainingPlanSelectedModelRequest(req.body ?? {});
    if (!planRequestValidation.ok) {
      sendError(
        res,
        planRequestValidation.code,
        planRequestValidation.message,
        400,
        { field: planRequestValidation.field },
      );
      return;
    }

    const raceDateValidation = validateRaceDateInput(raceDate);
    if (!raceDateValidation.ok) {
      sendError(res, raceDateValidation.code, raceDateValidation.message, 400, { field: 'raceDate' });
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
        runSessionsPerWeek,
        bikeSessionsPerWeek,
        swimSessionsPerWeek,
        strengthSessionsPerWeek,
        startPolicy,
        longWorkoutDay,
        notes,
        goalMode,
        trainingPriority,
        raceDate,
        // 2026-05-25 fix — Bug #2: iOS exposes an "Auto" chip in the
        // training plan editor; it sends the literal string "auto" on
        // the wire. Pre-fix the validator only accepted the legacy
        // three values, so iOS-sent "auto" silently fell through to
        // `undefined` and never reached the planner's two-a-day
        // heuristic explicitly. Now an explicit `'auto'` value flows
        // through; `resolveMaxSessionsPerDay` has a matching branch.
        twoADayPreference: normalizedTwoADayPreference,
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
      if (result.status === 'needs_clarification') {
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
   * Token-efficient training plan generation. The current path is
   * deterministic by default: the coach kernel and Training quality gate
   * produce the plan through REST instead of routing operational work
   * through chat. AI remains reserved for explanation/coaching surfaces,
   * not schedule truth.
   *
   * Flow:
   *   1. Read user's fitness profile from onboarding answers
   *   2. Fetch calendar events for the next 4 weeks → find free slots
   *   3. Coach-kernel build + quality gate
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
    runTrainingPlanRevisionShadowForLegacyRequest({ scope: { userId, tenantId }, body: req.body });
    if (!allowLegacyGenerationRoute(res, { userId, tenantId })) return;

    const {
      objective,
      durationWeeks = 4,
      preferredTime = '12:00',
      preferredCardioTime,
      preferredStrengthTime,
      sessionsPerWeek = 5,
      runSessionsPerWeek,
      bikeSessionsPerWeek,
      swimSessionsPerWeek,
      strengthSessionsPerWeek,
      startPolicy,
      longWorkoutDay,
      notes,
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference,
      calendarSource,
    } = req.body;
    const normalizedTwoADayPreference = normalizeTrainingTwoADayPreference(twoADayPreference);

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    const planRequestValidation = validateTrainingPlanSelectedModelRequest(req.body ?? {});
    if (!planRequestValidation.ok) {
      sendError(
        res,
        planRequestValidation.code,
        planRequestValidation.message,
        400,
        { field: planRequestValidation.field },
      );
      return;
    }

    const raceDateValidation = validateRaceDateInput(raceDate);
    if (!raceDateValidation.ok) {
      sendError(res, raceDateValidation.code, raceDateValidation.message, 400, { field: 'raceDate' });
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
      runSessionsPerWeek,
      bikeSessionsPerWeek,
      swimSessionsPerWeek,
      strengthSessionsPerWeek,
      startPolicy,
      longWorkoutDay,
      notes,
      goalMode,
      trainingPriority,
      raceDate,
      twoADayPreference: normalizedTwoADayPreference,
      calendarSource: calendarSourceValidation.source,
      generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
    };
    const requestHash = fingerprintTrainingPlanGenerationRequest(generationRequest);
    const explicitIdempotencyKey = normalizeTrainingPlanGenerationIdempotencyKey(
      req.body?.idempotencyKey
        ?? req.header('x-idempotency-key')
        ?? req.header('idempotency-key'),
    );
    const idempotencyKey = explicitIdempotencyKey
      ?? buildAutomaticTrainingPlanGenerationIdempotencyKey(requestHash);
    let idempotencyClaim = claimTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
    if (idempotencyClaim.kind === 'replay') {
      const replayAssessment = assessTrainingPlanGenerationReplay({
        userId,
        tenantId,
        responseData: idempotencyClaim.responseData,
      });
      if (replayAssessment.replayable) {
        if (replayAssessment.createdPlan) {
          invalidateCalendarCaches(userId);
          invalidateTrainingScreenCaches(userId);
        }
        sendSuccess(res, idempotencyClaim.responseData, { status: idempotencyClaim.statusCode });
        return;
      }

      const clearedRows = clearTrainingPlanGenerationIdempotency(
        userId,
        tenantId,
        idempotencyKey,
        requestHash,
      );
      logger.warn(
        {
          userId,
          idempotencyKey,
          reason: replayAssessment.reason,
          planId: replayAssessment.planId ?? null,
          clearedRows,
        },
        'Training plan idempotency replay discarded because active plan proof failed',
      );

      idempotencyClaim = claimTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
    }
    if (idempotencyClaim.kind === 'replay') {
      logger.warn(
        { userId, idempotencyKey },
        'Training plan idempotency replay claim reappeared after discard; returning in-progress instead of generating with a stale claim',
      );
      sendError(
        res,
        'TRAINING_PLAN_GENERATION_IN_PROGRESS',
        'This plan creation is being reconciled. Please wait for the current result instead of creating another plan.',
        409,
        { idempotencyKey: idempotencyClaim.idempotencyKey },
      );
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

    // Plan generation is deterministic and token-zero. If a future model
    // explanation is added, that specific call must own its own classified
    // withAiBudgetReservation instead of gating this entire route.
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
        runSessionsPerWeek,
        bikeSessionsPerWeek,
        swimSessionsPerWeek,
        strengthSessionsPerWeek,
        startPolicy,
        longWorkoutDay,
        notes,
        goalMode,
        trainingPriority,
        raceDate,
        // 2026-05-25 fix — Bug #2: iOS exposes an "Auto" chip in the
        // training plan editor; it sends the literal string "auto" on
        // the wire. Pre-fix the validator only accepted the legacy
        // three values, so iOS-sent "auto" silently fell through to
        // `undefined` and never reached the planner's two-a-day
        // heuristic explicitly. Now an explicit `'auto'` value flows
        // through; `resolveMaxSessionsPerDay` has a matching branch.
        twoADayPreference: normalizedTwoADayPreference,
        calendarSource: calendarSourceValidation.source,
      });

      if (result.status === 'needs_profile') {
        failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
        sendSuccess(res, result.data);
        return;
      }

      if (result.status === 'needs_clarification') {
        logger.warn(
          {
            userId,
            clarificationIds: result.data.clarificationIssues.map((issue) => issue.id),
          },
          'Training plan generation needs clarification before persistence',
        );
        failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
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
        failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
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
        failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
        sendSuccess(res, result.data);
        return;
      }

      if (result.status === 'preview') {
        logger.warn({ userId }, 'Training plan generate route returned preview unexpectedly');
        failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
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

      completeTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash, result.data, 201);
      sendSuccess(res, result.data, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      failTrainingPlanGenerationIdempotency(userId, tenantId, idempotencyKey, requestHash);
      sendError(res, 'INTERNAL', 'Failed to generate training plan. Please try again.', 500);
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
      // Calendar sync can create/link sessions, update an existing event, or
      // delete duplicate stale provider events. Refresh calendar caches even
      // when counts stay at zero so the button never appears to no-op.
      invalidateCalendarCaches(userId);
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, result.data);
    } catch (err: any) {
      if (sendLegacyRevisionGuardError(res, err)) return;
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
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', result.data.message, 404, result.data);
        return;
      }
      if (result.status === 'calendar_degraded') {
        sendError(res, 'TRAINING_CALENDAR_AVAILABILITY_UNAVAILABLE', result.data.message, 503, result.data);
        return;
      }
      if (result.status === 'no_calendar' || result.status === 'blocked') {
        sendError(res, result.status === 'no_calendar' ? 'NO_CALENDAR' : 'NO_REFLOW_SLOT', result.data.message, 409, result.data);
        return;
      }
      sendSuccess(res, result.data);
    } catch (err: any) {
      if (sendLegacyRevisionGuardError(res, err)) return;
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
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', result.data.message, 404, result.data);
        return;
      }
      if (result.status === 'calendar_degraded') {
        sendError(res, 'TRAINING_CALENDAR_AVAILABILITY_UNAVAILABLE', result.data.message, 503, result.data);
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
      if (sendLegacyRevisionGuardError(res, err)) return;
      logger.error({ err, userId, sessionId }, 'Training session reflow confirm failed');
      sendInternalError(res, 'Failed to confirm training session reflow');
    }
  });

  router.post('/plan/cancel', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;

    try {
      const result = await cancelTrainingPlanForUser(userId, req.body?.planId, { tenantId });
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
      if (sendLegacyRevisionGuardError(res, err)) return;
      logger.error({ err, userId }, 'Training plan cancellation failed');
      sendInternalError(res, 'Failed to cancel training plan');
    }
  });
}

function allowLegacyGenerationRoute(
  res: Response,
  scope: { userId: number; tenantId: number },
): boolean {
  try {
    assertLegacyPlanGenerationAllowed(scope);
    return true;
  } catch (error) {
    if (sendLegacyRevisionGuardError(res, error)) return false;
    throw error;
  }
}

function sendLegacyRevisionGuardError(res: Response, error: unknown): boolean {
  if (!(error instanceof TrainingPlanRevisionError)) return false;
  sendError(res, error.code, error.message, error.statusCode);
  return true;
}

function buildAutomaticTrainingPlanGenerationIdempotencyKey(requestHash: string): string {
  return `auto:${requestHash.slice(0, 48)}`;
}

type TrainingPlanGenerationReplayAssessment =
  | { replayable: true; createdPlan: boolean; planId?: number }
  | { replayable: false; reason: string; planId?: number | null };

function assessTrainingPlanGenerationReplay(input: {
  userId: number;
  tenantId: number;
  responseData: Record<string, unknown>;
}): TrainingPlanGenerationReplayAssessment {
  const planId = parseReplayPlanId(input.responseData);
  const status = typeof input.responseData.status === 'string'
    ? input.responseData.status.trim().toLowerCase()
    : '';
  const looksCreated = planId != null || status === 'created';

  if (!looksCreated) {
    return { replayable: false, reason: 'non_mutating_response', planId: null };
  }
  if (planId == null) {
    return { replayable: false, reason: 'created_response_missing_plan_id', planId: null };
  }

  try {
    const plan = trainingPlans.getPlanById(planId);
    if (!plan) {
      return { replayable: false, reason: 'plan_missing', planId };
    }
    const planTenantId = normalizeReplayPlanTenantId((plan as { tenant_id?: unknown }).tenant_id, input.tenantId);
    if ((plan as { user_id?: unknown }).user_id !== input.userId || planTenantId !== input.tenantId) {
      return { replayable: false, reason: 'plan_owner_mismatch', planId };
    }
    const lifecycleStatus = typeof (plan as { status?: unknown }).status === 'string'
      ? String((plan as { status?: unknown }).status).trim().toLowerCase()
      : 'active';
    if (lifecycleStatus !== 'active') {
      return { replayable: false, reason: 'plan_not_active', planId };
    }

    const weeks = trainingPlans.getWeeksForPlan(planId);
    if (!Array.isArray(weeks) || weeks.length === 0) {
      return { replayable: false, reason: 'plan_has_no_weeks', planId };
    }
    const sessionCount = weeks.reduce((total, week: any) => {
      const weekId = Number(week?.id);
      if (!Number.isFinite(weekId)) return total;
      const sessions = trainingPlans.getSessionsForWeek(weekId);
      return total + (Array.isArray(sessions) ? sessions.length : 0);
    }, 0);
    if (sessionCount === 0) {
      return { replayable: false, reason: 'plan_has_no_sessions', planId };
    }

    return { replayable: true, createdPlan: true, planId };
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, tenantId: input.tenantId, planId },
      'Training plan idempotency replay proof failed during plan lookup',
    );
    return { replayable: false, reason: 'plan_lookup_failed', planId };
  }
}

function parseReplayPlanId(responseData: Record<string, unknown>): number | null {
  const raw = responseData.planId ?? responseData.plan_id;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return null;
}

function normalizeReplayPlanTenantId(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

type TrainingPlanSelectedModelValidation =
  | { ok: true }
  | { ok: false; field: string; code: string; message: string };

const ALLOWED_TRAINING_GOAL_MODES = new Set([
  'event_based',
  'continuous',
  'maintenance',
  'return_to_training',
]);

const ALLOWED_TRAINING_PRIORITIES = new Set([
  'running',
  'cycling',
  'swimming',
  'strength',
  'triathlon',
  'hybrid',
]);

const ALLOWED_TRAINING_START_POLICIES = new Set([
  'today',
  'next_full_week',
]);

const ALLOWED_TRAINING_TWO_A_DAY_PREFERENCES = new Set([
  'never',
  'optional',
  'preferred',
  'auto',
]);
const MIN_ROUTE_TRAINING_PLAN_DURATION_WEEKS = 1;
const MAX_ROUTE_TRAINING_PLAN_DURATION_WEEKS = 52;

function normalizeTrainingTwoADayPreference(raw: unknown): 'never' | 'optional' | 'preferred' | 'auto' | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  return ALLOWED_TRAINING_TWO_A_DAY_PREFERENCES.has(normalized)
    ? (normalized as 'never' | 'optional' | 'preferred' | 'auto')
    : undefined;
}

function validateTrainingPlanSelectedModelRequest(body: Record<string, unknown>): TrainingPlanSelectedModelValidation {
  const durationValidation = validateIntegerField(
    body,
    'durationWeeks',
    MIN_ROUTE_TRAINING_PLAN_DURATION_WEEKS,
    MAX_ROUTE_TRAINING_PLAN_DURATION_WEEKS,
    'INVALID_TRAINING_PLAN_DURATION',
  );
  if (!durationValidation.ok) return durationValidation;

  const weeklyValidation = validateIntegerField(body, 'sessionsPerWeek', 3, 7, 'INVALID_TRAINING_SESSION_TARGET');
  if (!weeklyValidation.ok) return weeklyValidation;

  for (const field of ['runSessionsPerWeek', 'bikeSessionsPerWeek', 'swimSessionsPerWeek'] as const) {
    const validation = validateIntegerField(body, field, 0, 7, 'INVALID_TRAINING_MODALITY_TARGET');
    if (!validation.ok) return validation;
  }

  const strengthValidation = validateIntegerField(
    body,
    'strengthSessionsPerWeek',
    0,
    6,
    'INVALID_TRAINING_MODALITY_TARGET',
  );
  if (!strengthValidation.ok) return strengthValidation;

  const goalModeValidation = validateAllowedStringField(
    body,
    'goalMode',
    ALLOWED_TRAINING_GOAL_MODES,
    'INVALID_TRAINING_GOAL_MODE',
  );
  if (!goalModeValidation.ok) return goalModeValidation;

  const priorityValidation = validateAllowedStringField(
    body,
    'trainingPriority',
    ALLOWED_TRAINING_PRIORITIES,
    'INVALID_TRAINING_PRIORITY',
  );
  if (!priorityValidation.ok) return priorityValidation;

  const startPolicyValidation = validateAllowedStringField(
    body,
    'startPolicy',
    ALLOWED_TRAINING_START_POLICIES,
    'INVALID_TRAINING_START_POLICY',
  );
  if (!startPolicyValidation.ok) return startPolicyValidation;

  const twoADayValidation = validateAllowedStringField(
    body,
    'twoADayPreference',
    ALLOWED_TRAINING_TWO_A_DAY_PREFERENCES,
    'INVALID_TRAINING_TWO_A_DAY_PREFERENCE',
  );
  if (!twoADayValidation.ok) return twoADayValidation;

  return { ok: true };
}

function validateIntegerField(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  code: string,
): TrainingPlanSelectedModelValidation {
  const raw = body[field];
  if (raw == null || raw === '') return { ok: true };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      field,
      code,
      message: `${field} must be an integer between ${min} and ${max}.`,
    };
  }
  return { ok: true };
}

function validateAllowedStringField(
  body: Record<string, unknown>,
  field: string,
  allowed: Set<string>,
  code: string,
): TrainingPlanSelectedModelValidation {
  const raw = body[field];
  if (raw == null || raw === '') return { ok: true };
  if (typeof raw !== 'string' || !allowed.has(raw.trim().toLowerCase())) {
    return {
      ok: false,
      field,
      code,
      message: `${field} is not supported for Training plan creation.`,
    };
  }
  return { ok: true };
}

function validateRaceDateInput(raceDate: unknown): { ok: true } | { ok: false; code: string; message: string } {
  if (raceDate == null || raceDate === '') return { ok: true };
  if (typeof raceDate !== 'string') {
    return { ok: false, code: 'INVALID_RACE_DATE', message: 'raceDate must be a YYYY-MM-DD string.' };
  }
  const trimmed = raceDate.trim();
  if (!isStrictIsoDate(trimmed)) {
    return { ok: false, code: 'INVALID_RACE_DATE', message: 'raceDate must be a real date in YYYY-MM-DD format.' };
  }
  if (isPastIsoDate(trimmed)) {
    return { ok: false, code: 'PAST_RACE_DATE', message: 'raceDate must be in the future.' };
  }
  return { ok: true };
}
