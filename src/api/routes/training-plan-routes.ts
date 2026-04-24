// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { invalidateCalendarCaches } from '../../services/calendar-cache-invalidator';
import * as onboarding from '../../services/onboarding';
import * as trainingPlans from '../../services/training-plans';
import {
  readContentMeshContext,
  readCookingMeshContext,
  readFinanceMeshContext,
  readSecretaryMeshContext,
  readTrainingMeshContext,
} from '../../services/cross-agent-learning';
import { buildSharedDecisionContext } from '../../services/shared-decision-context';
import {
  adaptTrainingPlanToAvailableEquipment,
  buildTrainingEquipmentAdaptation,
} from '../../services/training-plan-equipment-adaptation';
import { deleteEvent, getEvents } from '../../services/unified-calendar';
import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
} from '../../services/training-plan-coordination';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import {
  acquireCostLock,
  buildQuotaExceededMessage,
  isUserOverDailyCap,
} from '../../services/cost-guardrail';
import { buildCoachKernelTrainingPlan } from '../../services/training-coach-kernel-plan-generator';
import {
  buildBusyWindows,
  normalizePreferredTime,
  type BusyWindow,
} from './training-schedule-utils';
import { resolveObjectiveProfileRequirement } from './training-profile-requirements';
import { buildDeterministicTrainingPlan } from './training-fallback-plan';
import { fetchCurrentReadinessForPlan } from './training-read-models';
import { persistGeneratedTrainingPlan } from './training-plan-persistence';

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
      // ── Step 1: Check user profile ──────────────────────────────
      const fitnessProfile = onboarding.getProfile?.(userId, 'fitness');
      const gymProfile = onboarding.getProfile?.(userId, 'triathlon-gym');
      const runProfile = onboarding.getProfile?.(userId, 'triathlon-running');

      if (!fitnessProfile || Object.keys(fitnessProfile).length === 0) {
        sendSuccess(res, {
          needsProfile: true,
          message: 'Complete your Fitness Profile first to generate a personalized plan.',
          missingFields: onboarding.getMissingProfileFields?.(userId, 'fitness') || [],
        });
        return;
      }

      const objectiveRequirement = resolveObjectiveProfileRequirement(objective, userId);
      if (objectiveRequirement) {
        sendSuccess(res, {
          needsProfile: true,
          requiredQuestionnaireId: objectiveRequirement.questionnaireId,
          requiredQuestionnaireTitle: objectiveRequirement.title,
          message: objectiveRequirement.message,
          missingFields: objectiveRequirement.missingFields,
        });
        return;
      }

      // ── Step 2: Get calendar free slots for next N weeks ────────
      const now = new Date();
      const endDate = new Date(now.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);
      const startStr = now.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      let busyWindows: BusyWindow[] = [];
      try {
        const events = await getEvents(startStr, endStr, userId);
        busyWindows = buildBusyWindows(events || []);
      } catch {
        // Calendar unavailable — plan without schedule constraints.
      }

      // ── Step 3: One AI call → structured plan JSON ─────────────
      const equipmentAdaptation = buildTrainingEquipmentAdaptation({
        fitnessProfile,
        gymProfile,
      });

      let sharedDecisionContext = '';
      let coordination = buildTrainingPlanCoordination({
        sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
        strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
        longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
        fitnessProfile,
        gymProfile,
        runProfile,
        training: null,
        cooking: null,
        finance: null,
        content: null,
        secretary: null,
      });

      try {
        const [trainingContextResult, cookingContextResult, financeContextResult, contentContextResult, secretaryContextResult, sharedContextResult] = await Promise.allSettled([
          readTrainingMeshContext({ userId, weekStart: startStr }),
          readCookingMeshContext({ userId, weekStart: startStr }),
          readFinanceMeshContext({ userId, weekStart: startStr }),
          readContentMeshContext({ userId, weekStart: startStr }),
          readSecretaryMeshContext({ userId, weekStart: startStr }),
          buildSharedDecisionContext('triathlon', userId),
        ]);

        sharedDecisionContext = sharedContextResult.status === 'fulfilled' ? sharedContextResult.value : '';
        coordination = buildTrainingPlanCoordination({
          sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
          strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
          longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
          fitnessProfile,
          gymProfile,
          runProfile,
          training: trainingContextResult.status === 'fulfilled' ? trainingContextResult.value : null,
          cooking: cookingContextResult.status === 'fulfilled' ? cookingContextResult.value : null,
          finance: financeContextResult.status === 'fulfilled' ? financeContextResult.value : null,
          content: contentContextResult.status === 'fulfilled' ? contentContextResult.value : null,
          secretary: secretaryContextResult.status === 'fulfilled' ? secretaryContextResult.value : null,
          sharedDecisionContext,
        });
      } catch (err) {
        logger.warn({ err, userId }, 'training plan coordination context unavailable — falling back to profile/calendar only');
      }

      const normalizedPreferredTime = normalizePreferredTime(preferredTime, '12:00');
      const normalizedPreferredCardioTime = normalizePreferredTime(preferredCardioTime, normalizedPreferredTime);
      const normalizedPreferredStrengthTime = normalizePreferredTime(preferredStrengthTime, normalizedPreferredTime);

      // Fetch current readiness so the planner seeds its AthleteState with
      // real HRV / sleep / body-battery instead of a hardcoded yellow (70).
      // Missing-wearable users degrade gracefully to the neutral fallback
      // inside the generator.
      const currentReadiness = await fetchCurrentReadinessForPlan(userId);

      let usedFallbackTemplate = false;
      let planData: any;
      try {
        planData = adaptTrainingPlanToAvailableEquipment(
          applyTrainingPlanCoordination(buildCoachKernelTrainingPlan({
            userId,
            objective,
            durationWeeks,
            startDate: startStr,
            sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
            strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
            preferredTime: normalizedPreferredTime,
            preferredCardioTime: normalizedPreferredCardioTime,
            preferredStrengthTime: normalizedPreferredStrengthTime,
            longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
            notes: typeof notes === 'string' ? notes.trim() : null,
            fitnessProfile,
            gymProfile,
            runProfile,
            currentReadiness,
          }), coordination),
          equipmentAdaptation,
        );
      } catch (err: any) {
        logger.warn(
          { err, userId, objective },
          'Coach-kernel training plan generation unavailable — using deterministic fallback template',
        );
        planData = adaptTrainingPlanToAvailableEquipment(
          applyTrainingPlanCoordination(buildDeterministicTrainingPlan(objective, durationWeeks, {
            sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
            strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
            longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
          }), coordination),
          equipmentAdaptation,
        );
        usedFallbackTemplate = true;
      }

      // ── Step 4: Bulk insert plan + weeks + sessions ────────────
      const persistedPlan = await persistGeneratedTrainingPlan({
        userId,
        objective,
        durationWeeks,
        startDate: startStr,
        endDate: endStr,
        now,
        planData,
        preferencesJson: JSON.stringify({
          preferredTime: normalizedPreferredTime,
          preferredCardioTime: normalizedPreferredCardioTime,
          preferredStrengthTime: normalizedPreferredStrengthTime,
          sessionsPerWeek,
          strengthSessionsPerWeek,
          longWorkoutDay: longWorkoutDay || null,
          notes: notes || null,
        }),
        normalizedPreferredTime,
        normalizedPreferredCardioTime,
        normalizedPreferredStrengthTime,
        busyWindows,
      });

      logger.info({
        userId, planId: persistedPlan.planId, totalSessions: persistedPlan.totalSessions, eventsCreated: persistedPlan.eventsCreated,
        objective, durationWeeks,
      }, 'Training plan generated and scheduled');
      if (persistedPlan.eventsCreated > 0) {
        invalidateCalendarCaches(userId);
      }
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        planId: persistedPlan.planId,
        planName: planData.planName,
        sport: planData.sport,
        objective,
        durationWeeks,
        totalSessions: persistedPlan.totalSessions,
        eventsCreated: persistedPlan.eventsCreated,
        preferredCardioTime: normalizedPreferredCardioTime,
        preferredStrengthTime: normalizedPreferredStrengthTime,
        weeks: persistedPlan.weekSummaries,
        fallbackTemplateUsed: usedFallbackTemplate,
        message: usedFallbackTemplate
          ? `Plan created with a reliable fallback template. ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`
          : `Plan created! ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`,
      }, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      sendError(res, 'INTERNAL', 'Failed to generate training plan. Please try again.', 500);
    } finally {
      releaseCostLock();
    }
  });

  router.post('/plan/cancel', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const requestedPlanId = Number(req.body?.planId);

    try {
      const plan = Number.isFinite(requestedPlanId) && requestedPlanId > 0
        ? trainingPlans.getPlanById(requestedPlanId)
        : trainingPlans.getActivePlan(userId);

      if (plan && plan.user_id !== userId) {
        sendError(res, 'FORBIDDEN', 'This training plan does not belong to the current user.', 403);
        return;
      }
      if (!plan) {
        sendSuccess(res, {
          cancelled: false,
          removedEvents: 0,
          message: 'No active training plan to cancel.',
        });
        return;
      }

      const weeks = trainingPlans.getWeeksForPlan(plan.id);
      const sessions = weeks.flatMap((week: any) => trainingPlans.getSessionsForWeek(week.id));
      const deletableSessions = sessions.filter((session: any) => session.calendar_event_id && session.calendar_source);

      const deletionResults = await Promise.allSettled(
        deletableSessions.map((session: any) =>
          deleteEvent(session.calendar_event_id, session.calendar_source, userId),
        ),
      );
      const removedEvents = deletionResults.filter(r => r.status === 'fulfilled').length;

      for (const session of sessions) {
        const nextStatus = session.status === 'completed' ? 'completed' : 'skipped';
        trainingPlans.updateSession(session.id, {
          status: nextStatus,
          calendar_event_id: null,
          calendar_source: null,
        });
      }

      trainingPlans.updatePlanStatus(plan.id, 'cancelled');

      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        cancelled: true,
        planId: plan.id,
        removedEvents,
        totalSessions: sessions.length,
        message: `Plan cancelled. ${removedEvents} scheduled workout${removedEvents === 1 ? '' : 's'} removed from the calendar.`,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan cancellation failed');
      sendInternalError(res, 'Failed to cancel training plan');
    }
  });
}
