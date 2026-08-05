// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, type Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import {
  fingerprintTrainingPlanClarificationAnswers,
  fingerprintTrainingPlanGenerationProfileContext,
} from '../../services/training-plan-clarification-registry';
import { invalidateCalendarCaches } from '../../services/cache-coherence-registry';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import {
  TRAINING_PLAN_GENERATOR_POLICY_VERSION,
  generateTrainingPlanForUser,
  type TrainingPlanGenerationResult,
} from './training-plan-generation';
import {
  buildTrainingPlanGenerationResponseDiscriminator,
  resolveTrainingPlanGenerationHttpContract,
  type TrainingPlanGenerationRouteSurface,
} from './training-plan-generation-response-contract';
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
import { trainingOperationLockPublicError } from '../../services/training-operation-locks';
import { validateRequestedTrainingCalendarSource } from '../../services/training-calendar-source';
import { isFutureIsoDate, isStrictIsoDate } from '../../services/training-date-utils';
import * as trainingPlans from '../../services/training-plans';
import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
  getTrainingPlanGenerationAttemptStatus,
  normalizeTrainingPlanGenerationAttemptLookupKey,
  startTrainingPlanGenerationIdempotencyHeartbeat,
  TrainingPlanGenerationLeaseLostError,
} from '../../services/training-plan-generation-idempotency';
import { assertLegacyPlanGenerationAllowed } from '../../services/training-plan-revision-legacy-guard';
import { TrainingPlanRevisionError } from '../../services/training-plan-revision-errors';
import { runTrainingPlanRevisionShadowForLegacyRequest } from '../../services/training-plan-revision-shadow';
import { getUserTimezoneById } from '../../services/user-service';
import {
  TrainingPlanPreviewStaleError,
  validateTrainingPlanPreviewToken,
  type TrainingPlanPreviewTokenValidation,
} from '../../services/training-plan-preview-token';

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

    // Resolve once from the authenticated user. Request-body timezone is
    // intentionally ignored so schedule truth cannot be spoofed per request.
    const schedulingTimezone = getUserTimezoneById(userId);
    const raceDateValidation = validateRaceDateInput(raceDate, schedulingTimezone);
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
      const previewContextFingerprint = fingerprintTrainingPlanRouteContext({
        userId,
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
        schedulingTimezone,
      });
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
        schedulingTimezone,
        previewContextFingerprint,
        previewOnly: true,
      });

      sendTrainingPlanGenerationContractResponse(res, 'preview', result);
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan preview failed');
      sendError(res, 'INTERNAL', 'Failed to preview training plan. Please try again.', 500);
    }
  });

  /**
   * POST /api/v1/training/plan/generation-attempt/status
   *
   * Read-only reconciliation for a compatibility-plan create whose HTTP
   * outcome was not observed by the client. POST keeps the bounded
   * idempotency key out of URL/query logs. The service deliberately exposes
   * no request hash, lease owner, fencing token, failure code, or timestamp.
   */
  router.post('/plan/generation-attempt/status', (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const idempotencyKey = normalizeTrainingPlanGenerationAttemptLookupKey(
      req.body?.idempotencyKey,
    );
    if (!idempotencyKey) {
      sendError(
        res,
        'VALIDATION',
        'idempotencyKey must be a non-empty string of at most 160 characters.',
        400,
        { field: 'idempotencyKey' },
      );
      return;
    }

    try {
      sendSuccess(
        res,
        getTrainingPlanGenerationAttemptStatus(userId, tenantId, idempotencyKey),
      );
    } catch (err) {
      logger.error(
        { err, userId, tenantId },
        'Training plan generation attempt status failed',
      );
      sendError(
        res,
        'TRAINING_PLAN_GENERATION_STATUS_UNAVAILABLE',
        'Plan creation status is temporarily unavailable. Retry the same attempt.',
        503,
      );
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

    // Resolve once from the authenticated user. This trusted value is used
    // for validation, idempotency, generation, and immutable persistence.
    const schedulingTimezone = getUserTimezoneById(userId);
    const raceDateValidation = validateRaceDateInput(raceDate, schedulingTimezone);
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

    const requestHash = fingerprintTrainingPlanRouteContext({
      userId,
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
      schedulingTimezone,
    });

    let expectedPreviewCandidateFingerprint: string | undefined;
    let validatedPreviewToken = false;
    const previewTokenWasSupplied = req.body != null
      && typeof req.body === 'object'
      && Object.prototype.hasOwnProperty.call(req.body, 'previewToken');
    if (previewTokenWasSupplied) {
      let previewValidation: TrainingPlanPreviewTokenValidation;
      try {
        previewValidation = typeof req.body.previewToken === 'string'
          ? validateTrainingPlanPreviewToken(req.body.previewToken, { userId, tenantId })
          : { ok: false, code: 'invalid_token' };
      } catch (err) {
        logger.error(
          { err, userId, tenantId },
          'Training plan preview token validation unavailable',
        );
        sendError(
          res,
          'TRAINING_PLAN_PREVIEW_VALIDATION_UNAVAILABLE',
          'Preview validation is temporarily unavailable. Please preview the plan again.',
          503,
          { requiresPreview: true },
        );
        return;
      }

      if (!previewValidation.ok) {
        sendTrainingPlanPreviewStale(res, previewValidation.code);
        return;
      }
      if (previewValidation.payload.contextFingerprint !== requestHash) {
        sendTrainingPlanPreviewStale(res, 'context_changed');
        return;
      }
      validatedPreviewToken = true;
      expectedPreviewCandidateFingerprint = previewValidation.payload.candidateFingerprint;
    }

    const explicitIdempotencyKey = readExplicitTrainingPlanGenerationIdempotencyKey(req);
    if (explicitIdempotencyKey.provided && !explicitIdempotencyKey.key) {
      sendError(
        res,
        'VALIDATION',
        'idempotencyKey must be a non-empty string of at most 160 characters.',
        400,
        { field: 'idempotencyKey' },
      );
      return;
    }
    const idempotencyKey = explicitIdempotencyKey.provided
      ? explicitIdempotencyKey.key!
      : buildAutomaticTrainingPlanGenerationIdempotencyKey(requestHash);
    const idempotencyClaim = claimTrainingPlanGenerationIdempotency(
      userId,
      tenantId,
      idempotencyKey,
      requestHash,
      {
        allowExpiredFencedRequestHashRebind: validatedPreviewToken
          && explicitIdempotencyKey.provided,
      },
    );
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
        // Older completed rows predate F27. Replays are still upgraded
        // additively at the boundary so every public creation response exposes
        // the same versioned discriminator.
        sendSuccess(res, {
          ...idempotencyClaim.responseData,
          ...buildTrainingPlanGenerationResponseDiscriminator('created'),
        }, { status: idempotencyClaim.statusCode });
        return;
      }

      logger.warn(
        {
          userId,
          idempotencyKey,
          reason: replayAssessment.reason,
          planId: replayAssessment.planId ?? null,
        },
        'Training plan idempotency replay retained because active plan proof failed',
      );

      if (replayAssessment.reason === 'plan_lookup_failed') {
        sendError(
          res,
          'TRAINING_PLAN_GENERATION_STATUS_UNAVAILABLE',
          'Plan creation status is temporarily unavailable. Retry the same attempt.',
          503,
        );
        return;
      }

      const inactivePlan = replayAssessment.reason === 'plan_not_active'
        || replayAssessment.reason === 'plan_superseded';
      sendError(
        res,
        inactivePlan
          ? 'TRAINING_PLAN_GENERATION_ALREADY_COMPLETED'
          : 'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
        inactivePlan
          ? 'This plan creation already completed, but that plan is no longer active. Refresh your active plan before starting another.'
          : 'This plan creation already completed, but its persisted plan cannot be safely confirmed. Reconcile the existing attempt before creating another plan.',
        409,
        {
          idempotencyKey: idempotencyClaim.idempotencyKey,
          ...(replayAssessment.planId != null ? { planId: replayAssessment.planId } : {}),
          ...(inactivePlan ? { requiresActivePlanRefresh: true } : {}),
        },
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
    if (idempotencyClaim.kind === 'reconciliation_required') {
      sendError(
        res,
        'TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED',
        'This plan creation already completed, but its stored result cannot be safely read. Reconcile the existing attempt before creating another plan.',
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
    if (idempotencyClaim.kind !== 'claimed') {
      sendError(res, 'INTERNAL', 'Failed to acquire plan generation ownership.', 500);
      return;
    }
    const generationLease = idempotencyClaim;
    const heartbeat = startTrainingPlanGenerationIdempotencyHeartbeat(
      userId,
      tenantId,
      generationLease,
    );
    const failOwnedAttempt = (
      code: string,
      failureClass: 'retryable' | 'terminal' = 'retryable',
    ) => failTrainingPlanGenerationIdempotency(
      userId,
      tenantId,
      generationLease,
      code,
      failureClass,
    );

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
        schedulingTimezone,
        expectedPreviewCandidateFingerprint,
        generationIdempotencyLease: generationLease,
      });

      if (result.status === 'needs_profile') {
        failOwnedAttempt('TRAINING_PLAN_NEEDS_PROFILE');
        sendTrainingPlanGenerationContractResponse(res, 'generate', result);
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
        failOwnedAttempt('TRAINING_PLAN_NEEDS_CLARIFICATION');
        sendTrainingPlanGenerationContractResponse(res, 'generate', result);
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
        sendTrainingPlanGenerationContractResponse(res, 'generate', result);
        failOwnedAttempt('TRAINING_PLAN_REPLACEMENT_FAILED');
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
        failOwnedAttempt('TRAINING_PLAN_QUALITY_BLOCKED');
        sendTrainingPlanGenerationContractResponse(res, 'generate', result);
        return;
      }

      if (result.status === 'preview') {
        logger.warn({ userId }, 'Training plan generate route returned preview unexpectedly');
        // The request may become valid after a fresh preview/confirmation;
        // do not permanently poison this deterministic key as terminal.
        failOwnedAttempt('INVALID_PLAN_GENERATION_STATE');
        sendTrainingPlanGenerationContractResponse(res, 'generate', result);
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

      if (!completeTrainingPlanGenerationIdempotency(userId, tenantId, generationLease, result.data, 201)) {
        throw new TrainingPlanGenerationLeaseLostError();
      }
      sendTrainingPlanGenerationContractResponse(res, 'generate', result);

    } catch (err: any) {
      const ownedFailureCode = err instanceof TrainingPlanGenerationLeaseLostError
        ? err.code
        : err instanceof TrainingPlanPreviewStaleError
          ? err.code
          : 'TRAINING_PLAN_GENERATION_FAILED';
      failOwnedAttempt(ownedFailureCode);
      if (err instanceof TrainingPlanPreviewStaleError) {
        sendTrainingPlanPreviewStale(res, err.reason);
        return;
      }
      if (err instanceof TrainingPlanGenerationLeaseLostError) {
        sendError(
          res,
          err.code,
          'This plan attempt lost ownership and was not allowed to activate. Please retry.',
          409,
        );
        return;
      }
      if (err?.code === 'TRAINING_PLAN_REPLACEMENT_CONFLICT') {
        sendError(
          res,
          err.code,
          'Your active Training plan changed while this replacement was being built. Refresh and try again.',
          409,
        );
        return;
      }
      if (sendTrainingOperationLockRouteError(res, err)) return;
      logger.error({ err, userId }, 'Training plan generation failed');
      sendError(res, 'INTERNAL', 'Failed to generate training plan. Please try again.', 500);
    } finally {
      heartbeat.stop();
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
      sendSuccess(res, result.data, { status: result.status === 'partial_failure' ? 202 : 200 });
    } catch (err: any) {
      if (sendTrainingOperationLockRouteError(res, err)) return;
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
      if (sendTrainingOperationLockRouteError(res, err)) return;
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
      if (sendTrainingOperationLockRouteError(res, err)) return;
      if (sendLegacyRevisionGuardError(res, err)) return;
      logger.error({ err, userId }, 'Training plan cancellation failed');
      sendInternalError(res, 'Failed to cancel training plan');
    }
  });
}

function sendTrainingPlanGenerationContractResponse(
  res: Response,
  surface: TrainingPlanGenerationRouteSurface,
  result: TrainingPlanGenerationResult,
): void {
  const validationErrorCode = result.status === 'needs_profile'
    ? readTrainingPlanGenerationValidationErrorCode(result.data)
    : undefined;
  const contract = resolveTrainingPlanGenerationHttpContract({
    surface,
    outcome: result.status,
    validationErrorCode,
  });

  if (contract.envelope === 'success') {
    sendSuccess(res, result.data, { status: contract.status });
    return;
  }

  sendError(
    res,
    contract.errorCode,
    trainingPlanGenerationErrorMessage(surface, result),
    contract.status,
    trainingPlanGenerationErrorDetails(result),
  );
}

function readTrainingPlanGenerationValidationErrorCode(data: Record<string, unknown>): string | undefined {
  const validationError = data.validationError;
  if (!validationError || typeof validationError !== 'object') return undefined;
  const code = (validationError as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function trainingPlanGenerationErrorMessage(
  surface: TrainingPlanGenerationRouteSurface,
  result: TrainingPlanGenerationResult,
): string {
  const message = (result.data as Record<string, unknown>).message;
  if (typeof message === 'string' && message.trim()) return message;
  if (result.status === 'preview') return 'Plan preview must be confirmed before creation.';
  if (result.status === 'created' && surface === 'preview') {
    return 'Plan preview unexpectedly attempted to create a plan. Please retry the preview.';
  }
  return 'Training plan generation could not complete for the supplied request.';
}

function trainingPlanGenerationErrorDetails(
  result: TrainingPlanGenerationResult,
): Record<string, unknown> {
  const discriminator = {
    schemaVersion: result.data.schemaVersion,
    status: result.data.status,
  };

  if (result.status === 'needs_profile') {
    return {
      ...discriminator,
      needsProfile: result.data.needsProfile,
      missingFields: result.data.missingFields,
      validationError: result.data.validationError,
    };
  }
  if (result.status === 'plan_quality_blocked' || result.status === 'cancellation_failed') {
    const { message: _message, ...details } = result.data;
    return details;
  }
  return discriminator;
}

function sendTrainingOperationLockRouteError(res: Response, error: unknown): boolean {
  const publicError = trainingOperationLockPublicError(error);
  if (!publicError) return false;
  logger.warn(
    { code: publicError.code, operation: publicError.operation },
    'Training operation deferred by the shared resource lock',
  );
  sendError(
    res,
    publicError.code,
    publicError.message,
    publicError.status,
    publicError.details,
  );
  return true;
}

function sendTrainingPlanPreviewStale(res: Response, reason: string): void {
  sendError(
    res,
    'TRAINING_PLAN_PREVIEW_STALE',
    'The Training plan inputs or candidate changed after preview. Preview the plan again before creating it.',
    409,
    { requiresPreview: true, reason },
  );
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

interface TrainingPlanRouteContextInput {
  userId: number;
  objective: string;
  durationWeeks: unknown;
  preferredTime: unknown;
  preferredCardioTime: unknown;
  preferredStrengthTime: unknown;
  sessionsPerWeek: unknown;
  runSessionsPerWeek: unknown;
  bikeSessionsPerWeek: unknown;
  swimSessionsPerWeek: unknown;
  strengthSessionsPerWeek: unknown;
  startPolicy: unknown;
  longWorkoutDay: unknown;
  notes: unknown;
  goalMode: unknown;
  trainingPriority: unknown;
  raceDate: unknown;
  twoADayPreference: unknown;
  calendarSource: unknown;
  schedulingTimezone: string;
}

/**
 * Preview and create call this exact builder after the same public-field
 * defaults/normalizers and trusted timezone resolution. Keeping one builder
 * prevents a field from participating in idempotency while silently escaping
 * signed preview acceptance (or vice versa).
 */
function fingerprintTrainingPlanRouteContext(input: TrainingPlanRouteContextInput): string {
  const { userId, ...normalizedPublicFields } = input;
  return fingerprintTrainingPlanGenerationRequest({
    ...normalizedPublicFields,
    generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
    profileContextFingerprint: fingerprintTrainingPlanGenerationProfileContext(userId),
    // Phase 2 clarification answers remain an explicit, narrow component so
    // their legacy dedupe contract stays visible alongside the full profile
    // context fingerprint used for signed preview acceptance.
    clarificationAnswersFingerprint: fingerprintTrainingPlanClarificationAnswers(userId),
  });
}

type TrainingPlanGenerationReplayAssessment =
  | { replayable: true; createdPlan: boolean; planId?: number }
  | { replayable: false; reason: string; planId?: number | null };

type ExplicitTrainingPlanGenerationIdempotencyKey =
  | { provided: false }
  | { provided: true; key: string | null };

function readExplicitTrainingPlanGenerationIdempotencyKey(
  req: Request,
): ExplicitTrainingPlanGenerationIdempotencyKey {
  const body = req.body;
  if (
    body != null
    && typeof body === 'object'
    && Object.prototype.hasOwnProperty.call(body, 'idempotencyKey')
  ) {
    return {
      provided: true,
      key: normalizeTrainingPlanGenerationAttemptLookupKey(body.idempotencyKey),
    };
  }

  for (const headerName of ['x-idempotency-key', 'idempotency-key']) {
    const value = req.header(headerName);
    if (value !== undefined) {
      return {
        provided: true,
        key: normalizeTrainingPlanGenerationAttemptLookupKey(value),
      };
    }
  }

  return { provided: false };
}

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
      return {
        replayable: false,
        reason: lifecycleStatus === 'superseded' ? 'plan_superseded' : 'plan_not_active',
        planId,
      };
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

function validateRaceDateInput(
  raceDate: unknown,
  schedulingTimezone: string,
): { ok: true } | { ok: false; code: string; message: string } {
  if (raceDate == null || raceDate === '') return { ok: true };
  if (typeof raceDate !== 'string') {
    return { ok: false, code: 'INVALID_RACE_DATE', message: 'raceDate must be a YYYY-MM-DD string.' };
  }
  const trimmed = raceDate.trim();
  if (!isStrictIsoDate(trimmed)) {
    return { ok: false, code: 'INVALID_RACE_DATE', message: 'raceDate must be a real date in YYYY-MM-DD format.' };
  }
  if (!isFutureIsoDate(trimmed, new Date(), schedulingTimezone)) {
    return { ok: false, code: 'PAST_RACE_DATE', message: 'raceDate must be in the future.' };
  }
  return { ok: true };
}
