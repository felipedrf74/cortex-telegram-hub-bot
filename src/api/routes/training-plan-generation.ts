// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as onboarding from '../../services/onboarding';
import { DateTime } from 'luxon';
import { config } from '../../config';
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
  type TrainingEquipmentAdaptation,
} from '../../services/training-plan-equipment-adaptation';
import { getEvents, getEventsForSources } from '../../services/unified-calendar';
import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
} from '../../services/training-plan-coordination';
import {
  buildCoachKernelTrainingPlan,
  normalizeTrainingPlanDurationWeeks,
  type TrainingGoalMode,
  type TrainingPriority,
} from '../../services/training-coach-kernel-plan-generator';
import {
  buildBusyWindows,
  normalizePreferredTime,
  type BusyWindow,
} from './training-schedule-utils';
import {
  objectiveNeedsGymProfile,
  objectiveNeedsRunningProfile,
  resolveObjectiveProfileRequirement,
} from './training-profile-requirements';
import { buildDeterministicTrainingPlan } from './training-fallback-plan';
import { fetchCurrentReadinessForPlan } from './training-read-models';
import {
  finalizeGeneratedTrainingPlanForPersistence,
  lintGeneratedTrainingPlanPreflight,
  persistGeneratedTrainingPlan,
} from './training-plan-persistence';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import { enforceRequestedTrainingPlanVolume } from '../../services/training-plan-volume-enforcement';
import { EQUIPMENT_VOCABULARY_VERSION } from '../../services/training-equipment-vocabulary';
import {
  GENERATION_PIPELINE_VERSION,
  loadTrainingCatalogSnapshot,
} from '../../services/coach-kernel/training-catalog';
import { STRENGTH_SELECTOR_POLICY_VERSION } from '../../services/coach-kernel/strength-selector';
import * as trainingPlans from '../../services/training-plans';
import { findOrphanedOwnerships } from '../../services/training-plan-lifecycle';
import { reconcileOrphanedTrainingAgendaEvents } from '../../services/training-agenda-reconciliation';
import { resolveTrainingCalendarSource } from '../../services/training-calendar-source';
import { isPastIsoDate, isStrictIsoDate } from '../../services/training-date-utils';
import { logger } from '../../utils/logger';
import type { CalendarSource } from '../../services/unified-calendar';
import type { PlanLintResult } from '../../services/coach-kernel/plan-linter';
import type {
  CapacityWindow,
  HealthSignal,
  TrainingDecisionReason,
  TrainingDecisionReasonCode,
} from '../../services/coach-kernel/types';
import { requireTenantIdParam } from '../../services/tenant-scope';
import { getLatestHealthSignal, type HealthSignalRow } from '../../services/health-signals';
import { incrementTrainingGenerationCounter } from '../../services/training-generation-observability';
import {
  deriveSafetyTriggerFromSignal,
  wireHealthSignalToSafety,
  type WireHealthSignalOutput,
} from '../../services/coach-kernel/safety-wiring';

export const TRAINING_PLAN_GENERATOR_POLICY_VERSION = 'training-plan-shape-v2';

type TrainingGenerationVersionPins = {
  catalogVersion: string;
  sciencePolicyVersion: string;
  selectorPolicyVersion: string;
  equipmentVocabularyVersion: string;
  generationPipelineVersion: string;
};

export interface GenerateTrainingPlanForUserInput {
  userId: number;
  tenantId: number;
  objective: string;
  durationWeeks?: number;
  preferredTime?: string;
  preferredCardioTime?: unknown;
  preferredStrengthTime?: unknown;
  sessionsPerWeek?: unknown;
  runSessionsPerWeek?: unknown;
  bikeSessionsPerWeek?: unknown;
  swimSessionsPerWeek?: unknown;
  strengthSessionsPerWeek?: unknown;
  startPolicy?: unknown;
  longWorkoutDay?: unknown;
  notes?: unknown;
  goalMode?: unknown;
  trainingPriority?: unknown;
  raceDate?: unknown;
  /**
   * Slice 2.B — explicit two-a-day preference. Routes to
   * `availability.maxSessionsPerDay` inside the kernel input. When
   * omitted the generator behaves exactly as before (volume-based
   * inference) — additive, fully backward-compatible.
   */
  twoADayPreference?: 'never' | 'optional' | 'preferred' | 'auto' | null;
  calendarSource?: CalendarSource | null;
  previewOnly?: boolean;
}

export type TrainingPlanStartPolicy = 'next_full_week' | 'today';

export interface TrainingSafetyGenerationSummary {
  status: 'pass' | 'warning' | 'blocked';
  message: string;
  reasonCode: TrainingDecisionReasonCode | null;
}

export type TrainingPlanGenerationResult =
  | {
      status: 'needs_profile';
      data: Record<string, unknown>;
    }
  | {
      status: 'preview';
      data: {
        status: 'preview';
        planName: string | null;
        sport: string | null;
        objective: string;
        durationWeeks: number;
        resolvedStartDate: string;
        weeklyTargets: TrainingPlanWeeklyTargets;
        totalSessions: number;
        calendarSource: CalendarSource | null;
        phaseRoadmap: Array<{
          weekNumber: number;
          phase: string;
          sessionCount: number;
          keySessions: string[];
        }>;
        planLint: PlanLintResult;
        warnings: Array<{ code: string; message: string }>;
        blockers: Array<{ code: string; message: string }>;
        calendarFetchDegraded: boolean;
        calendarFetchError?: string;
        fallbackTemplateUsed: boolean;
        goalMode: TrainingGoalMode | null;
        trainingPriority: TrainingPriority | null;
        raceDate: string | null;
        generatorPolicyVersion: string;
        generationVersionPins: TrainingGenerationVersionPins;
        trainingSafety?: TrainingSafetyGenerationSummary | null;
      };
    }
  | {
      status: 'created';
      data: Record<string, unknown>;
      planId: number;
      eventsCreated: number;
      totalSessions: number;
      durationWeeks: number;
    }
  /**
   * Strict Training quality gate. Returned before any existing plan is
   * cancelled or any new plan/week/session rows are written.
   */
  | {
      status: 'plan_quality_blocked';
      data: {
        status: 'plan_quality_blocked';
        message: string;
        planLint: PlanLintResult;
        warnings: Array<{ code: string; message: string }>;
        calendarFetchDegraded: boolean;
        calendarFetchError?: string;
        fallbackTemplateUsed: boolean;
        goalMode: TrainingGoalMode | null;
        trainingPriority: TrainingPriority | null;
        raceDate: string | null;
        generatorPolicyVersion: string;
        generationVersionPins: TrainingGenerationVersionPins;
        trainingSafety?: TrainingSafetyGenerationSummary | null;
      };
    }
  /**
   * Slice 4.D.2 — saga abort. The pre-persist cancellation of the
   * existing plan failed in a way that's NOT safe to ignore: the old
   * plan rows are still in the DB. Creating a new plan on top would
   * leave the user with two active plans + two calendar event sets.
   * The route surfaces this so iOS can render an actionable retry
   * banner instead of silently producing a corrupt double-plan
   * state.
   */
  | {
      status: 'cancellation_failed';
      data: {
        message: string;
        reason: string;
        activePlansRemaining: number;
        generationVersionPins: TrainingGenerationVersionPins;
      };
    };

/**
 * Slice 4.D.2 — saga taxonomy for the pre-persist cancellation step.
 *
 * The audit identified silent error suppression in the catch block
 * around `cancelTrainingPlanForUser` as compounding root cause #4 of
 * regression #3. Previously we logged + continued unconditionally,
 * which produced a double-plan state when the local hard-delete
 * failed (e.g. SQLite was locked, the cancellation route's narrative
 * cleanup threw before the local delete, etc.).
 *
 * The new shape distinguishes:
 *   - `success`           — old plan + events fully cleaned up.
 *   - `no_active_plan`    — first-time user, nothing to cancel.
 *   - `external_partial`  — local delete OK; some calendar deletes
 *                            failed transiently. Safe to continue;
 *                            orphans are queued via the slice 4.D
 *                            ownership audit table.
 *   - `forbidden`         — old plan was owned by a different user
 *                            (rare; route handles this explicitly).
 *                            Continue with new plan.
 *   - `local_delete_failed` — DANGEROUS. Old plan rows are still in
 *                            the DB. Caller MUST abort the persist.
 */
type CancellationSagaOutcome =
  | { kind: 'success'; removedEvents: number }
  | { kind: 'no_active_plan' }
  | { kind: 'external_partial'; orphanedEventCount: number }
  | { kind: 'local_delete_failed'; reason: string; activePlansRemaining: number };

async function runPrePersistCancellationSaga(userId: number, tenantId: number): Promise<CancellationSagaOutcome> {
  try {
    const cancellation = await cancelTrainingPlanForUser(userId, undefined, { tenantId });
    if (cancellation.status === 'not_found') {
      const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId, tenantId);
      if (reconciliation.failed > 0) {
        return { kind: 'external_partial', orphanedEventCount: reconciliation.failed };
      }
      return { kind: 'no_active_plan' };
    }
    // Status is 'cancelled' — local hard-delete succeeded. The slice
    // 4.D ownership audit table tells us whether any external calendar
    // deletes failed (status='orphaned' rows). Those are reconcilable;
    // the saga can safely proceed.
    const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId, tenantId);
    const orphans = findOrphanedOwnerships(userId, tenantId);
    const orphanedEventCount = orphans.length + reconciliation.failed;
    if (orphanedEventCount > 0) {
      return { kind: 'external_partial', orphanedEventCount };
    }
    return { kind: 'success', removedEvents: cancellation.data.removedEvents };
  } catch (err) {
    // The throw landed somewhere inside `cancelTrainingPlanForUser`.
    // We can't tell from here whether the local hard-delete already
    // ran. Conservative inspection: if any active plans remain for
    // this user, the cancellation didn't finish — abort. If none
    // remain, the throw was post-delete (e.g. narrative cleanup), so
    // continuing is safe but we mark it as external-partial so the
    // ownership reconciler picks up any remaining orphans.
    const remainingPlans = trainingPlans.getActivePlans?.(userId, tenantId) ?? [];
    const reason = err instanceof Error ? err.message : String(err);
    if (remainingPlans.length > 0) {
      return {
        kind: 'local_delete_failed',
        reason,
        activePlansRemaining: remainingPlans.length,
      };
    }
    logger.warn(
      { err, userId },
      'Cancellation threw post-delete; saga continuing with reconciliation queued',
    );
    const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId, tenantId);
    return { kind: 'external_partial', orphanedEventCount: reconciliation.failed || -1 };
  }
}

export interface TrainingPlanWeeklyTargets {
  sessionsPerWeek: number;
  runSessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  bikeSessionsPerWeek: number | null;
  swimSessionsPerWeek: number | null;
}

export async function generateTrainingPlanForUser(
  input: GenerateTrainingPlanForUserInput,
): Promise<TrainingPlanGenerationResult> {
  const {
    userId,
    objective,
    preferredTime = '12:00',
    preferredCardioTime,
    preferredStrengthTime,
    sessionsPerWeek = 5,
    runSessionsPerWeek,
    bikeSessionsPerWeek,
    swimSessionsPerWeek,
    strengthSessionsPerWeek = 2,
    startPolicy,
    longWorkoutDay,
    notes,
    goalMode,
    trainingPriority,
    raceDate,
    twoADayPreference,
    calendarSource,
    previewOnly = false,
  } = input;
  const tenantId = requireTenantIdParam(input.tenantId, 'generateTrainingPlanForUser');
  const requestedDurationWeeks = normalizeTrainingPlanDurationWeeks(input.durationWeeks, 4);

  const fitnessProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'fitness'));
  const gymProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-gym'));
  const runProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-running'));
  const normalizedGoalMode = normalizeGoalMode(goalMode);
  const normalizedTrainingPriority = normalizeTrainingPriority(trainingPriority);
  const normalizedRaceDate = normalizeIsoDate(raceDate);
  const raceDateWasProvided = typeof raceDate === 'string'
    ? raceDate.trim() !== ''
    : raceDate != null;
  if (raceDateWasProvided && normalizedRaceDate == null) {
    return {
      status: 'needs_profile',
      data: {
        needsProfile: true,
        message: 'Race date must be a real future date in YYYY-MM-DD format.',
        missingFields: ['raceDate'],
        validationError: {
          code: 'INVALID_RACE_DATE',
          field: 'raceDate',
        },
      },
    };
  }
  if (normalizedRaceDate && isPastIsoDate(normalizedRaceDate)) {
    return {
      status: 'needs_profile',
      data: {
        needsProfile: true,
        message: 'Race date must be in the future.',
        missingFields: ['raceDate'],
        validationError: {
          code: 'PAST_RACE_DATE',
          field: 'raceDate',
        },
      },
    };
  }
  const effectiveRaceDate = normalizedRaceDate ?? resolveProfileRaceDate(runProfile);
  const runProfileForPlan = effectiveRaceDate
    ? {
        ...(runProfile ?? {}),
        target_race_date: effectiveRaceDate,
        target_race: typeof runProfile?.target_race === 'string' && runProfile.target_race.trim()
          ? runProfile.target_race
          : objective,
      }
    : runProfile;
  // Computed here (not at the lint-input site below) because the
  // duration clamp after start-date resolution needs the exact same
  // event-based definition the linter applies.
  const raceDateForLint: string | null =
    effectiveRaceDate
      ? effectiveRaceDate
      : typeof runProfileForPlan?.target_race_date === 'string' && runProfileForPlan.target_race_date.trim()
      ? runProfileForPlan.target_race_date
      : null;
  const isRaceSpecificForLint =
    objectiveNeedsRunningProfile(objective) &&
    /\b(marathon|half\s*marathon|10k|5k|race|ironman|70\.3|trail)\b/i.test(objective);

  if (!fitnessProfile || Object.keys(fitnessProfile).length === 0) {
    // RERUN-2 finding 3 (2026-06-12): this gate used to omit
    // requiredQuestionnaireId/Title while the objective gate right below
    // includes them — the null id suppressed the iOS routing CTA for
    // empty-fitness-profile users. Keep the shape identical to the
    // objective gate so every needs_profile response is routable.
    return {
      status: 'needs_profile',
      data: {
        needsProfile: true,
        requiredQuestionnaireId: 'fitness',
        requiredQuestionnaireTitle: onboarding.getQuestionnaire('fitness')?.title ?? 'fitness',
        message: 'Complete your Fitness Profile first to generate a personalized plan.',
        missingFields: onboarding.getMissingProfileFields?.(userId, 'fitness') || [],
      },
    };
  }

  const objectiveRequirement = resolveObjectiveProfileRequirement(objective, userId);
  if (objectiveRequirement) {
    return {
      status: 'needs_profile',
      data: {
        needsProfile: true,
        requiredQuestionnaireId: objectiveRequirement.questionnaireId,
        requiredQuestionnaireTitle: objectiveRequirement.title,
        message: objectiveRequirement.message,
        missingFields: objectiveRequirement.missingFields,
      },
    };
  }

  const now = new Date();
  const normalizedStartPolicy = normalizeStartPolicy(startPolicy);
  const startStr = resolveTrainingPlanStartDate(now, normalizedStartPolicy);
  // rerun-4 R3 (2026-06-12): iOS derives the requested week count from
  // "today", but the engine anchors the plan at its start policy (e.g.
  // next Monday). A 16-week request made days before that anchor then
  // overshoots the race date and plan_duration_overshoots_race_date
  // hard-blocks the wizard with no recourse. The engine owns the start
  // date, so it also owns making the duration fit: clamp the requested
  // weeks down to the largest whole-week count that still ends by race
  // day (same arithmetic as the linter). Requests that already fit are
  // untouched; a race too close to fit even one full week falls
  // through to the honest linter blocker.
  const durationWeeks = clampTrainingPlanDurationWeeksToRaceDate({
    requestedDurationWeeks,
    startDateIso: startStr,
    raceDateIso: normalizedGoalMode === 'event_based' || isRaceSpecificForLint
      ? raceDateForLint
      : null,
  });
  const endStr = DateTime
    .fromISO(startStr, { zone: config.app.timezone || 'Europe/Lisbon' })
    .plus({ weeks: durationWeeks })
    .toISODate() ?? startStr;
  const resolvedCalendarSource = resolveTrainingCalendarSource({
    userId,
    tenantId,
    requestedSource: calendarSource ?? undefined,
  });

  // training-expert-coach-knowledge-engine (2026-05-03):
  // Calendar fetch is the upstream source of truth for "when can the
  // user actually train?". A silent empty `busyWindows` after a
  // `getEvents` failure means we schedule blind — sessions land on top
  // of meetings with no warning. Two changes here:
  //   1. The catch logs the error structurally so SRE can see when
  //      Google/Outlook is degraded for a real user.
  //   2. We track a `calendarFetchDegraded` flag so downstream callers
  //      (and the plan-linter response) can attach an explicit warning
  //      ("Plan generated without calendar conflict detection — please
  //      review your week before trusting it"). The plan still
  //      generates so the user isn't blocked by transient OAuth
  //      hiccups, but the caller knows it happened.
  let busyWindows: BusyWindow[] = [];
  let calendarFetchDegraded = false;
  let calendarFetchError: string | undefined;
  try {
    const events = resolvedCalendarSource
      ? await getEventsForSources(startStr, endStr, userId, [resolvedCalendarSource])
      : await getEvents(startStr, endStr, userId);
    busyWindows = buildBusyWindows(events || []);
  } catch (err) {
    calendarFetchDegraded = true;
    calendarFetchError = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        userId,
        startDate: startStr,
        endDate: endStr,
        err,
      },
      'training-plan-generation: calendar getEvents failed; plan will be generated without conflict detection',
    );
  }

  const equipmentAuthorityEnabled = config.coaching.coachKernelEquipmentAuthorityEnabled;
  const equipmentAdaptation = buildTrainingEquipmentAdaptation({
    fitnessProfile,
    gymProfile,
    conservativeUnknown: equipmentAuthorityEnabled,
  });

  const normalizedSessionsPerWeek = clampNumber(sessionsPerWeek, 5, 3, 7);
  const normalizedRunSessionsPerWeek =
    normalizeOptionalSessionTarget(runSessionsPerWeek, 0, 7) ?? normalizedSessionsPerWeek;
  const normalizedBikeSessionsPerWeek = normalizeOptionalSessionTarget(bikeSessionsPerWeek, 0, 7);
  const normalizedSwimSessionsPerWeek = normalizeOptionalSessionTarget(swimSessionsPerWeek, 0, 7);
  const normalizedStrengthSessionsPerWeek = clampNumber(strengthSessionsPerWeek, 0, 0, 6);
  const gymOnlyObjective = objectiveNeedsGymProfile(objective) && !objectiveNeedsRunningProfile(objective);
  const effectiveStrengthSessionsPerWeek = normalizedStrengthSessionsPerWeek > 0
    ? normalizedStrengthSessionsPerWeek
    : gymOnlyObjective
      ? Math.min(normalizedSessionsPerWeek, 6)
      : 0;
  const normalizedLongWorkoutDay = typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null;

  let sharedDecisionContext = '';
  let coordination = buildTrainingPlanCoordination({
    sessionsPerWeek: normalizedSessionsPerWeek,
    strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
    longWorkoutDay: normalizedLongWorkoutDay,
    fitnessProfile,
    gymProfile,
    runProfile: runProfileForPlan,
    training: null,
    cooking: null,
    finance: null,
    content: null,
    secretary: null,
  });

  try {
    const [
      trainingContextResult,
      cookingContextResult,
      financeContextResult,
      contentContextResult,
      secretaryContextResult,
      sharedContextResult,
    ] = await Promise.allSettled([
      readTrainingMeshContext({ userId, weekStart: startStr }),
      readCookingMeshContext({ userId, weekStart: startStr }),
      readFinanceMeshContext({ userId, weekStart: startStr }),
      readContentMeshContext({ userId, weekStart: startStr }),
      readSecretaryMeshContext({ userId, weekStart: startStr }),
      buildSharedDecisionContext('triathlon', userId),
    ]);

    sharedDecisionContext = sharedContextResult.status === 'fulfilled' ? sharedContextResult.value : '';
    coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: normalizedSessionsPerWeek,
      strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
      longWorkoutDay: normalizedLongWorkoutDay,
      fitnessProfile,
      gymProfile,
      runProfile: runProfileForPlan,
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
  const upstreamCapacityWindows = config.coaching.trainingCalendarCapacityKernelEnabled && !calendarFetchDegraded
    ? buildKernelCapacityWindows({
        startDate: startStr,
        busyWindows,
      })
    : null;
  if (upstreamCapacityWindows?.some((window) => window.constraints.includes('calendar_busy_windows_present'))) {
    incrementTrainingGenerationCounter('calendar_capacity_reflow_total');
  }
  const currentReadiness = await fetchCurrentReadinessForPlan(userId, tenantId);

  let usedFallbackTemplate = false;
  let planData: any;
  let kernelEquipmentCandidate: any | null = null;
  try {
    kernelEquipmentCandidate = applyTrainingPlanCoordination(buildCoachKernelTrainingPlan({
      userId,
      tenantId,
      objective,
      durationWeeks,
      startDate: startStr,
      sessionsPerWeek: normalizedSessionsPerWeek,
      runSessionsPerWeek: normalizedRunSessionsPerWeek,
      bikeSessionsPerWeek: normalizedBikeSessionsPerWeek,
      swimSessionsPerWeek: normalizedSwimSessionsPerWeek,
      strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
      preferredTime: normalizedPreferredTime,
      preferredCardioTime: normalizedPreferredCardioTime,
      preferredStrengthTime: normalizedPreferredStrengthTime,
      longWorkoutDay: normalizedLongWorkoutDay,
      notes: typeof notes === 'string' ? notes.trim() : null,
      goalMode: normalizedGoalMode,
      trainingPriority: normalizedTrainingPriority,
      raceDate: effectiveRaceDate,
      fitnessProfile,
      gymProfile,
      runProfile: runProfileForPlan,
      currentReadiness,
      twoADayPreference,
      capacityWindows: upstreamCapacityWindows,
    }), coordination);
    planData = applyEquipmentAuthorityMode(
      kernelEquipmentCandidate,
      equipmentAdaptation,
      equipmentAuthorityEnabled,
    );
  } catch (err) {
    logger.warn(
      { err, userId, objective },
      'Coach-kernel training plan generation unavailable — using deterministic fallback template',
    );
    kernelEquipmentCandidate = applyTrainingPlanCoordination(buildDeterministicTrainingPlan(objective, durationWeeks, {
      sessionsPerWeek: normalizedSessionsPerWeek,
      strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
      longWorkoutDay: normalizedLongWorkoutDay,
    }), coordination);
    planData = applyEquipmentAuthorityMode(
      kernelEquipmentCandidate,
      equipmentAdaptation,
      equipmentAuthorityEnabled,
    );
    usedFallbackTemplate = true;
  }

  const volumeEnforcementInput = {
    sessionsPerWeek: normalizedSessionsPerWeek,
    runSessionsPerWeek: normalizedRunSessionsPerWeek,
    strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
    preferredCardioTime: normalizedPreferredCardioTime,
    preferredStrengthTime: normalizedPreferredStrengthTime,
    startDate: startStr,
    longWorkoutDay: coordination.resolvedLongWorkoutDay ?? normalizedLongWorkoutDay,
  };
  planData = applyEquipmentAuthorityMode(
    enforceRequestedTrainingPlanVolume(planData, volumeEnforcementInput),
    equipmentAdaptation,
    equipmentAuthorityEnabled,
  );
  if (
    config.coaching.coachKernelEquipmentAuthorityShadowEnabled
    && !equipmentAuthorityEnabled
    && kernelEquipmentCandidate
  ) {
    const shadowCandidate = applyEquipmentAuthorityDecisionReasons(
      enforceRequestedTrainingPlanVolume(cloneTrainingPlan(kernelEquipmentCandidate), volumeEnforcementInput),
      equipmentAdaptation,
    );
    logEquipmentAuthorityShadowDiff({
      userId,
      tenantId,
      legacyPlan: planData,
      kernelPlan: shadowCandidate,
      equipmentAdaptation,
    });
  }
  if (equipmentAuthorityEnabled) {
    planData = applyEquipmentAuthorityDecisionReasons(planData, equipmentAdaptation);
  }

  const safetyOutput = config.coaching.trainingSafetyGuardrailsEnabled
    ? buildTrainingSafetyOutputForGeneration({
        userId,
        tenantId,
        affectedDate: startStr,
      })
    : undefined;
  if (safetyOutput && safetyOutput.effectiveSeverity !== 'pass') {
    incrementTrainingGenerationCounter('safety_guardrail_triggered_total');
    planData = applyTrainingSafetyOutputToGeneratedPlan(planData, safetyOutput, startStr);
  }

  // training-expert-coach-knowledge-engine (2026-05-12):
  // Run the Training quality gate BEFORE the cancellation saga and
  // persistence. A plan with deterministic blockers should not delete
  // the user's current plan and should not write a new unsafe plan that
  // iOS merely marks "requires review".
  //
  // Pass through the fields the linter needs for accurate rules:
  //   • equipmentProfile — drives the equipment_compatibility rule.
  //   • raceDate         — drives the no_fake_taper_without_event rule
  //                        and the race_specific_plan_requires_race_date
  //                        rule.
  //   • isRaceSpecific   — derived from the objective; tells the linter
  //                        whether to treat missing race date as a
  //                        blocker.
  //   • goalMode         — distinguishes event-based taper/race strictness
  //                        from continuous or hypertrophy-style plans.
  // All four are best-effort: when absent, the relevant rules no-op.
  const equipmentProfileLabel: string | undefined = equipmentAuthorityEnabled
    ? equipmentAdaptation.equipmentProfile
    : typeof gymProfile?.equipment_access === 'string'
      ? String(gymProfile.equipment_access).toLowerCase().trim() || undefined
      : typeof fitnessProfile?.available_equipment === 'string'
        ? String(fitnessProfile.available_equipment).toLowerCase().trim() || undefined
        : undefined;
  const generationVersionPins = buildTrainingGenerationVersionPins();

  const persistenceInput = {
    userId,
    tenantId,
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
      runSessionsPerWeek: runSessionsPerWeek ?? null,
      bikeSessionsPerWeek: bikeSessionsPerWeek ?? null,
      swimSessionsPerWeek: swimSessionsPerWeek ?? null,
      strengthSessionsPerWeek,
      longWorkoutDay: longWorkoutDay || null,
      notes: notes || null,
      goalMode: normalizedGoalMode,
      trainingPriority: normalizedTrainingPriority,
      raceDate: effectiveRaceDate,
      startPolicy: normalizedStartPolicy,
      trainingCalendarSource: resolvedCalendarSource || null,
      generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
      generationVersionPins,
    }),
    normalizedPreferredTime,
    normalizedPreferredCardioTime,
    normalizedPreferredStrengthTime,
    busyWindows,
    athleteProfiles: {
      fitnessProfile,
      gymProfile,
      runProfile: runProfileForPlan,
    },
    calendarSource: resolvedCalendarSource || undefined,
    equipmentProfile: equipmentProfileLabel,
    raceDate: raceDateForLint,
    isRaceSpecific: isRaceSpecificForLint,
    goalMode: normalizedGoalMode,
  };

  const finalizedPersistenceInput = finalizeGeneratedTrainingPlanForPersistence(persistenceInput);
  const preflightLint = lintGeneratedTrainingPlanPreflight(finalizedPersistenceInput);
  if (previewOnly) {
    return {
      status: 'preview',
      data: {
        status: 'preview',
        planName: typeof planData.planName === 'string' ? planData.planName : null,
        sport: typeof planData.sport === 'string' ? planData.sport : null,
        objective,
        durationWeeks,
        resolvedStartDate: startStr,
        weeklyTargets: buildWeeklyTargets({
          sessionsPerWeek: normalizedSessionsPerWeek,
          runSessionsPerWeek: normalizedRunSessionsPerWeek,
          strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
          bikeSessionsPerWeek: normalizedBikeSessionsPerWeek,
          swimSessionsPerWeek: normalizedSwimSessionsPerWeek,
        }),
        totalSessions: countSchedulablePlanSessions(planData),
        calendarSource: resolvedCalendarSource || null,
        phaseRoadmap: buildPlanPhaseRoadmap(planData),
        planLint: preflightLint,
        warnings: buildPlanWarnings({
          calendarFetchDegraded,
          calendarFetchError,
          lintResult: preflightLint,
          safetyOutput,
        }),
        blockers: preflightLint.blockers.map((blocker) => ({
          code: blocker.ruleId,
          message: blocker.message,
        })),
        calendarFetchDegraded,
        ...(calendarFetchError ? { calendarFetchError } : {}),
        fallbackTemplateUsed: usedFallbackTemplate,
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        raceDate: raceDateForLint,
        generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
        generationVersionPins,
        trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      },
    };
  }

  if (preflightLint.status === 'fail') {
    incrementTrainingGenerationCounter('final_validation_failure_total');
    logger.warn(
      {
        event: 'training_plan_quality_gate.blocked_pre_persist',
        userId,
        objective,
        blockerRuleIds: preflightLint.blockers.map((b) => b.ruleId),
        warningRuleIds: preflightLint.warnings.map((w) => w.ruleId),
      },
      'Training plan quality gate blocked plan before cancellation/persistence',
    );
    return {
      status: 'plan_quality_blocked',
      data: {
        status: 'plan_quality_blocked',
        message:
          'Nexus blocked this plan before saving because it failed the Training quality gate. Review the coach warning, adjust the inputs, and generate again.',
        planLint: preflightLint,
        warnings: buildPlanWarnings({
          calendarFetchDegraded,
          calendarFetchError,
          lintResult: preflightLint,
          safetyOutput,
        }),
        calendarFetchDegraded,
        ...(calendarFetchError ? { calendarFetchError } : {}),
        fallbackTemplateUsed: usedFallbackTemplate,
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        raceDate: raceDateForLint,
        generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
        generationVersionPins,
        trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      },
    };
  }

  // Slice 4.D.2 — saga for pre-persist cancellation. The previous
  // silent catch produced a double-plan state when the local
  // hard-delete failed; the new saga inspects post-cancellation
  // database state and aborts the persist when the old plan rows
  // are still present. This now runs only after the strict quality
  // gate has passed, so a blocked candidate cannot delete the current
  // plan.
  const cancellationOutcome = await runPrePersistCancellationSaga(userId, tenantId);

  switch (cancellationOutcome.kind) {
    case 'external_partial':
      logger.warn(
        { userId, orphanedEventCount: cancellationOutcome.orphanedEventCount },
        'Pre-persist cancellation: local delete OK but some external calendar deletes failed; reconciliation queued via ownership audit',
      );
      break;
    case 'local_delete_failed':
      logger.error(
        {
          userId,
          reason: cancellationOutcome.reason,
          activePlansRemaining: cancellationOutcome.activePlansRemaining,
        },
        'Pre-persist cancellation: LOCAL DELETE FAILED — aborting new plan persist to avoid double-plan corruption',
      );
      return {
        status: 'cancellation_failed',
        data: {
          message:
            'Could not finalize cancellation of the existing plan. The old plan is still active. Please retry in a moment.',
          reason: cancellationOutcome.reason,
          activePlansRemaining: cancellationOutcome.activePlansRemaining,
          generationVersionPins,
        },
      };
    case 'success':
    case 'no_active_plan':
      // Clean state — proceed.
      break;
  }

  const persistedPlan = await persistGeneratedTrainingPlan(finalizedPersistenceInput);

  // training-expert-coach-knowledge-engine (2026-05-03):
  // Surface plan-linter findings + calendar-degraded warning on the
  // response so iOS can render an honest "review your week before
  // trusting it" banner. Both fields are best-effort signals; the iOS
  // client decides UX. Treating these as silent passes was the historical
  // foot-gun where a calendar outage produced sessions stacked on top of
  // meetings with no warning.
  // Lint result is optional defensively: mocked persistGeneratedTrainingPlan
  // in legacy tests pre-dates the lint field; production always populates it.
  const lintResult = persistedPlan.lint ?? {
    status: 'pass' as const,
    blockers: [],
    warnings: [],
    suggestedFixes: [],
  };
  const sessionsLinked = typeof persistedPlan.sessionsLinked === 'number'
    ? persistedPlan.sessionsLinked
    : persistedPlan.eventsCreated;
  const sessionsFailed = Math.max(0, persistedPlan.totalSessions - sessionsLinked);
  const planWarnings = buildPlanWarnings({
    calendarFetchDegraded,
    calendarFetchError,
    lintResult,
    safetyOutput,
  });

  return {
    status: 'created',
    planId: persistedPlan.planId,
    eventsCreated: persistedPlan.eventsCreated,
    totalSessions: persistedPlan.totalSessions,
    durationWeeks,
    data: {
      planId: persistedPlan.planId,
      planName: planData.planName,
      sport: planData.sport,
      objective,
      durationWeeks,
      resolvedStartDate: startStr,
      calendarSource: resolvedCalendarSource || null,
      phaseRoadmap: buildPlanPhaseRoadmap(planData),
      totalSessions: persistedPlan.totalSessions,
      eventsCreated: persistedPlan.eventsCreated,
      calendarSync: {
        provider: resolvedCalendarSource || null,
        sessionsAttempted: persistedPlan.totalSessions,
        eventsCreated: persistedPlan.eventsCreated,
        sessionsLinked,
        sessionsFailed,
        unscheduled: sessionsFailed,
        status: sessionsLinked >= persistedPlan.totalSessions
          ? 'synced'
          : sessionsLinked > 0
            ? 'partial'
            : 'not_synced',
      },
      preferredCardioTime: normalizedPreferredCardioTime,
      preferredStrengthTime: normalizedPreferredStrengthTime,
      weeklyTargets: buildWeeklyTargets({
        sessionsPerWeek: normalizedSessionsPerWeek,
        runSessionsPerWeek: normalizedRunSessionsPerWeek,
        strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
        bikeSessionsPerWeek: normalizedBikeSessionsPerWeek,
        swimSessionsPerWeek: normalizedSwimSessionsPerWeek,
      }),
      weeks: persistedPlan.weekSummaries,
      profileQuality: planData.profileQuality ?? null,
      decisionReasons: Array.isArray(planData.decisionReasons) ? planData.decisionReasons : [],
      fallbackTemplateUsed: usedFallbackTemplate,
      goalMode: normalizedGoalMode,
      trainingPriority: normalizedTrainingPriority,
      raceDate: raceDateForLint,
      generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
      generationVersionPins,
      trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      // training-expert-coach-knowledge-engine: explicit calendar
      // health flag + lint verdict surface on the response payload.
      calendarFetchDegraded,
      ...(calendarFetchError ? { calendarFetchError } : {}),
      planLint: lintResult,
      warnings: planWarnings,
      message: usedFallbackTemplate
        ? `Plan created with a reliable fallback template. ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`
        : `Plan created! ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`,
    },
  };
}

function countSchedulablePlanSessions(planData: any): number {
  return (Array.isArray(planData?.weeks) ? planData.weeks : []).reduce((sum: number, week: any) => {
    const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
    return sum + sessions.filter((session: any) => {
      const type = String(session?.sessionType || '').toLowerCase();
      const status = String(session?.scheduleState || '').toLowerCase();
      return type !== 'rest' && status !== 'dropped' && status !== 'deferred';
    }).length;
  }, 0);
}

function buildKernelCapacityWindows(input: {
  startDate: string;
  busyWindows: BusyWindow[];
}): CapacityWindow[] {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const weekStart = DateTime.fromISO(input.startDate, { zone }).startOf('day');
  if (!weekStart.isValid) return [];
  const windows: CapacityWindow[] = [];
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const day = weekStart.plus({ days: dayOffset });
    const dayStart = day.set({ hour: 5, minute: 0, second: 0, millisecond: 0 });
    const dayEnd = day.set({ hour: 21, minute: 0, second: 0, millisecond: 0 });
    const busy = input.busyWindows
      .map((window) => ({
        start: DateTime.fromMillis(window.startMs, { zone }),
        end: DateTime.fromMillis(window.endMs, { zone }),
      }))
      .filter((window) => window.start < dayEnd && window.end > dayStart)
      .map((window) => ({
        start: window.start < dayStart ? dayStart : window.start,
        end: window.end > dayEnd ? dayEnd : window.end,
      }))
      .filter((window) => window.end > window.start)
      .sort((left, right) => left.start.toMillis() - right.start.toMillis());

    let cursor: DateTime<boolean> = dayStart;
    const pushFreeWindow = (start: DateTime<boolean>, end: DateTime<boolean>, hasBusyPressure: boolean): void => {
      const availableMinutes = Math.floor(end.diff(start, 'minutes').minutes);
      if (availableMinutes < 20) return;
      windows.push({
        date: day.toISODate() ?? input.startDate,
        startTime: start.toFormat('HH:mm'),
        endTime: end.toFormat('HH:mm'),
        availableMinutes,
        constraints: hasBusyPressure
          ? ['calendar_busy_windows_present']
          : ['calendar_open_day'],
        source: 'calendar',
      });
    };

    for (const block of busy) {
      pushFreeWindow(cursor, block.start, busy.length > 0);
      if (block.end > cursor) cursor = block.end;
    }
    pushFreeWindow(cursor, dayEnd, busy.length > 0);
  }
  return windows;
}

function buildTrainingGenerationVersionPins(): TrainingGenerationVersionPins {
  const snapshot = loadTrainingCatalogSnapshot();
  return {
    catalogVersion: snapshot.catalogVersion,
    sciencePolicyVersion: snapshot.sciencePolicyVersion,
    selectorPolicyVersion: STRENGTH_SELECTOR_POLICY_VERSION,
    equipmentVocabularyVersion: EQUIPMENT_VOCABULARY_VERSION,
    generationPipelineVersion: GENERATION_PIPELINE_VERSION,
  };
}

function buildPlanPhaseRoadmap(planData: any): Array<{
  weekNumber: number;
  phase: string;
  sessionCount: number;
  keySessions: string[];
}> {
  return (Array.isArray(planData?.weeks) ? planData.weeks : []).map((week: any, index: number) => {
    const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
    const activeSessions = sessions.filter((session: any) =>
      String(session?.sessionType || '').toLowerCase() !== 'rest'
      && String(session?.scheduleState || '').toLowerCase() !== 'dropped'
    );
    const keySessions = activeSessions
      .map((session: any) => String(session?.title || '').trim())
      .filter((title: string) => title.length > 0)
      .slice(0, 3);
    return {
      weekNumber: Number(week?.weekNumber) || index + 1,
      phase: String(week?.focus || 'base'),
      sessionCount: activeSessions.length,
      keySessions,
    };
  });
}

function applyEquipmentAuthorityMode(
  planData: any,
  equipmentAdaptation: TrainingEquipmentAdaptation,
  equipmentAuthorityEnabled: boolean,
): any {
  if (equipmentAuthorityEnabled) return planData;
  return adaptTrainingPlanToAvailableEquipment(planData, equipmentAdaptation);
}

function applyEquipmentAuthorityDecisionReasons(
  planData: any,
  equipmentAdaptation: TrainingEquipmentAdaptation,
): any {
  const equipmentReasons = safeDecisionReasons(equipmentAdaptation.decisionReasons);
  if (equipmentReasons.length === 0) return planData;
  return {
    ...planData,
    decisionReasons: dedupeDecisionReasons([
      ...safeDecisionReasons(planData?.decisionReasons),
      ...equipmentReasons,
    ]),
  };
}

function cloneTrainingPlan(planData: any): any {
  return JSON.parse(JSON.stringify(planData ?? {}));
}

function logEquipmentAuthorityShadowDiff(input: {
  userId: number;
  tenantId: number;
  legacyPlan: any;
  kernelPlan: any;
  equipmentAdaptation: TrainingEquipmentAdaptation;
}): void {
  const legacy = summarizeEquipmentPlanForShadow(input.legacyPlan);
  const kernel = summarizeEquipmentPlanForShadow(input.kernelPlan);
  const changedExerciseSessionCount = Math.max(
    legacy.sessionExerciseFingerprints.length,
    kernel.sessionExerciseFingerprints.length,
  ) === 0
    ? 0
    : Array.from({
        length: Math.max(
          legacy.sessionExerciseFingerprints.length,
          kernel.sessionExerciseFingerprints.length,
        ),
      }).filter((_, index) =>
        legacy.sessionExerciseFingerprints[index] !== kernel.sessionExerciseFingerprints[index]
      ).length;

  logger.info(
    {
      event: 'training_equipment_authority.shadow_diff',
      userId: input.userId,
      tenantId: input.tenantId,
      equipmentProfile: input.equipmentAdaptation.equipmentProfile,
      canonicalEquipmentProfileId: input.equipmentAdaptation.canonicalProfile.profileId,
      canonicalEquipmentConfidence: input.equipmentAdaptation.canonicalProfile.confidence,
      changedExerciseSessionCount,
      legacyGymSessionCount: legacy.gymSessionCount,
      kernelGymSessionCount: kernel.gymSessionCount,
      legacyExerciseCount: legacy.exerciseCount,
      kernelExerciseCount: kernel.exerciseCount,
      legacyDuplicateSessionCount: legacy.duplicateSessionCount,
      kernelDuplicateSessionCount: kernel.duplicateSessionCount,
    },
    'training-plan-generation: equipment authority shadow comparison recorded',
  );
}

function summarizeEquipmentPlanForShadow(planData: any): {
  gymSessionCount: number;
  exerciseCount: number;
  duplicateSessionCount: number;
  sessionExerciseFingerprints: string[];
} {
  const sessions = (Array.isArray(planData?.weeks) ? planData.weeks : [])
    .flatMap((week: any) => Array.isArray(week?.sessions) ? week.sessions : [])
    .filter((session: any) => String(session?.sessionType || '').toLowerCase() === 'gym');
  const fingerprints: string[] = [];
  let exerciseCount = 0;
  let duplicateSessionCount = 0;
  for (const session of sessions) {
    const names = (Array.isArray(session?.exercises) ? session.exercises : [])
      .map((exercise: any) => String(exercise?.exerciseId ?? exercise?.name ?? '').trim().toLowerCase())
      .filter(Boolean);
    exerciseCount += names.length;
    if (new Set(names).size < names.length) duplicateSessionCount += 1;
    fingerprints.push(stableShadowFingerprint(names.join('|')));
  }
  return {
    gymSessionCount: sessions.length,
    exerciseCount,
    duplicateSessionCount,
    sessionExerciseFingerprints: fingerprints,
  };
}

function stableShadowFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const GENERATION_HEALTH_INJURY_STATUSES = new Set([
  'none',
  'acute',
  'chronic_managed',
  'returning',
  'post_exertional_symptom_risk',
] as const);

const GENERATION_HEALTH_MENSTRUAL_STATUSES = new Set([
  'menses',
  'follicular',
  'ovulation',
  'luteal',
  'amenorrhea',
  'symptom_only',
] as const);

const GENERATION_HEALTH_ENERGY_RISKS = new Set(['low', 'moderate', 'high'] as const);

function buildTrainingSafetyOutputForGeneration(input: {
  userId: number;
  tenantId: number;
  affectedDate: string;
}): WireHealthSignalOutput | undefined {
  const healthSignal = getLatestHealthSignal(input.userId, input.tenantId, input.affectedDate, {
    maxAgeDays: config.coaching.trainingSafetyHealthSignalMaxAgeDays,
  });
  if (!healthSignal) return undefined;
  const decoded = decodeHealthSignalRowForGeneration(healthSignal);
  const trigger = deriveSafetyTriggerFromSignal({
    source: decoded.source,
    illnessSymptoms: decoded.illnessSymptoms,
    injuryStatus: decoded.injuryStatus,
    energyAvailabilityRisk: decoded.energyAvailabilityRisk,
    painScore: decoded.painScore,
    painLocation: decoded.painLocation,
  });
  return wireHealthSignalToSafety({
    signal: decoded,
    source: trigger.source,
    triggerType: trigger.triggerType,
    affectedDate: input.affectedDate,
  });
}

function decodeHealthSignalRowForGeneration(row: HealthSignalRow): HealthSignal {
  let illnessSymptoms: string[] | undefined;
  if (row.illness_symptoms_json) {
    try {
      const parsed = JSON.parse(row.illness_symptoms_json) as unknown;
      if (Array.isArray(parsed)) {
        illnessSymptoms = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch (err) {
      logger.warn(
        { err, signalId: row.id },
        'training_plan_generation.health_signal_illness_json_parse_failed',
      );
    }
  }

  const injuryStatus = GENERATION_HEALTH_INJURY_STATUSES.has(row.injury_status as never)
    ? row.injury_status as HealthSignal['injuryStatus']
    : undefined;
  const menstrualStatus = GENERATION_HEALTH_MENSTRUAL_STATUSES.has(row.menstrual_status as never)
    ? row.menstrual_status as HealthSignal['menstrualStatus']
    : undefined;
  const energyAvailabilityRisk = GENERATION_HEALTH_ENERGY_RISKS.has(row.energy_availability_risk as never)
    ? row.energy_availability_risk as HealthSignal['energyAvailabilityRisk']
    : undefined;

  return {
    capturedAt: row.created_at,
    painScore: row.pain_score ?? undefined,
    painLocation: row.pain_location ?? undefined,
    illnessSymptoms,
    injuryStatus,
    menstrualStatus,
    energyAvailabilityRisk,
    consentScope: row.consent_scope
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    source: row.source ?? undefined,
  };
}

function applyTrainingSafetyOutputToGeneratedPlan(
  planData: any,
  safetyOutput: WireHealthSignalOutput,
  affectedDate: string,
): any {
  const safetyReasons = normalizeSafetyDecisionReasons(safetyOutput, affectedDate);
  const decisionReasons = dedupeDecisionReasons([
    ...safeDecisionReasons(planData?.decisionReasons),
    ...safetyReasons,
  ]);
  if (safetyOutput.effectiveSeverity !== 'block') {
    return {
      ...planData,
      decisionReasons,
    };
  }

  const safetyMessage = safetyReasons[0]?.text
    ?? 'Training is paused until the safety check is resolved.';
  const weeks = Array.isArray(planData?.weeks)
    ? planData.weeks.map((week: any, weekIndex: number) => {
        const weekReasons = dedupeDecisionReasons([
          ...safeDecisionReasons(week?.decisionReasons),
          ...safetyReasons,
        ]);
        const sessions = Array.isArray(week?.sessions)
          ? week.sessions.map((session: any) => ({
              ...session,
              sessionType: 'rest',
              title: 'Safety pause',
              durationMinutes: 0,
              description: safetyMessage,
              exercises: [],
              scheduleState: 'deferred',
              scheduleAdjustments: [
                'Training paused until the safety check is resolved.',
              ],
              scheduleReason: safetyMessage,
              decisionReasons: dedupeDecisionReasons([
                ...safeDecisionReasons(session?.decisionReasons),
                ...safetyReasons,
              ]),
            }))
          : [{
              dayOfWeek: 'Monday',
              sessionType: 'rest',
              title: 'Safety pause',
              durationMinutes: 0,
              description: safetyMessage,
              exercises: [],
              scheduleState: 'deferred',
              scheduleAdjustments: [
                'Training paused until the safety check is resolved.',
              ],
              scheduleReason: safetyMessage,
              decisionReasons: safetyReasons,
            }];
        return {
          ...week,
          focus: 'recovery',
          intensityPct: Math.min(Number(week?.intensityPct) || 50, 30),
          sessions,
          decisionReasons: weekReasons,
          weekNumber: Number(week?.weekNumber) || weekIndex + 1,
        };
      })
    : [];

  return {
    ...planData,
    weeks,
    decisionReasons,
  };
}

function normalizeSafetyDecisionReasons(
  safetyOutput: WireHealthSignalOutput,
  affectedDate: string,
): TrainingDecisionReason[] {
  const existing = safetyOutput.decisionReasons.filter((reason) =>
    reason && typeof reason.text === 'string' && reason.text.trim().length > 0,
  );
  if (existing.length > 0) return existing;

  const code: TrainingDecisionReasonCode = safetyOutput.effectiveSeverity === 'block'
    ? 'medical_referral'
    : 'safety_warning_inferred';
  return [{
    code,
    text: safetyOutput.effectiveSeverity === 'block'
      ? 'For your safety, please consult a qualified healthcare professional before continuing with this training plan.'
      : 'A safety signal was detected, so the coach kept this plan conservative.',
    severity: safetyOutput.effectiveSeverity === 'block' ? 'block' : 'warning',
    affectedEntity: { type: 'week', id: affectedDate },
    sourceConstraint: {
      type: 'safety',
      label: 'training safety guardrail',
    },
    evidence: ['training_safety_guardrails_enabled'],
  }];
}

function buildTrainingSafetyGenerationSummary(
  safetyOutput: WireHealthSignalOutput | undefined,
): TrainingSafetyGenerationSummary | null {
  if (!safetyOutput || safetyOutput.effectiveSeverity === 'pass') {
    return safetyOutput
      ? {
          status: 'pass',
          message: 'No training safety guardrail changed this plan.',
          reasonCode: null,
        }
      : null;
  }
  const reason = normalizeSafetyDecisionReasons(safetyOutput, '')[0];
  return {
    status: safetyOutput.effectiveSeverity === 'block' ? 'blocked' : 'warning',
    message: reason?.text ?? 'A training safety guardrail changed this plan.',
    reasonCode: reason?.code ?? null,
  };
}

function safeDecisionReasons(value: unknown): TrainingDecisionReason[] {
  return Array.isArray(value)
    ? value.filter((reason): reason is TrainingDecisionReason =>
        reason != null &&
        typeof reason === 'object' &&
        typeof (reason as TrainingDecisionReason).code === 'string' &&
        typeof (reason as TrainingDecisionReason).text === 'string',
      )
    : [];
}

function dedupeDecisionReasons(reasons: TrainingDecisionReason[]): TrainingDecisionReason[] {
  const seen = new Set<string>();
  const output: TrainingDecisionReason[] = [];
  for (const reason of reasons) {
    const key = [
      reason.code,
      reason.affectedEntity?.type ?? '',
      reason.affectedEntity?.id ?? '',
      reason.text.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reason);
  }
  return output;
}

function buildPlanWarnings(input: {
  calendarFetchDegraded: boolean;
  calendarFetchError?: string;
  lintResult: PlanLintResult;
  safetyOutput?: WireHealthSignalOutput;
}): Array<{ code: string; message: string }> {
  const planWarnings: Array<{ code: string; message: string }> = [];
  if (input.calendarFetchDegraded) {
    planWarnings.push({
      code: 'calendar_fetch_degraded',
      message:
        'Could not read your calendar to detect conflicts. The plan was generated ' +
        'without conflict checks — please review the week before trusting it.',
      });
  }
  if (input.safetyOutput && input.safetyOutput.effectiveSeverity !== 'pass') {
    const reason = normalizeSafetyDecisionReasons(input.safetyOutput, '')[0];
    planWarnings.push({
      code: input.safetyOutput.effectiveSeverity === 'block'
        ? 'safety_guardrail_blocked'
        : 'safety_guardrail_warning',
      message: reason?.text ?? 'A training safety guardrail changed this plan.',
    });
  }
  for (const blocker of input.lintResult.blockers) {
    planWarnings.push({ code: `lint_blocker_${blocker.ruleId}`, message: blocker.message });
  }
  for (const warning of input.lintResult.warnings) {
    planWarnings.push({ code: `lint_warning_${warning.ruleId}`, message: warning.message });
  }
  return planWarnings;
}

function unwrapOnboardingProfileData(profile: unknown): Record<string, any> | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;

  const record = profile as Record<string, any>;
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, any>;
  }

  // Unit tests and legacy callers sometimes pass the profile-data object
  // directly. Keep that path supported while the production service returns
  // the persisted wrapper row { id, user_id, profile_type, data, ... }.
  return record;
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const resolved = Number(raw);
  const candidate = Number.isFinite(resolved) && resolved > 0 ? Math.round(resolved) : fallback;
  return Math.max(min, Math.min(max, candidate));
}

function normalizeOptionalSessionTarget(raw: unknown, min: number, max: number): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const resolved = Number(raw);
  if (!Number.isFinite(resolved)) return null;
  return Math.max(min, Math.min(max, Math.round(resolved)));
}

function normalizeStartPolicy(raw: unknown): TrainingPlanStartPolicy {
  return raw === 'today' ? 'today' : 'next_full_week';
}

export function resolveTrainingPlanStartDate(now: Date, startPolicy: TrainingPlanStartPolicy): string {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  if (!today.isValid) return now.toISOString().slice(0, 10);
  if (startPolicy === 'today') return today.toISODate() ?? now.toISOString().slice(0, 10);

  // Luxon weekday is 1=Monday ... 7=Sunday. A full training week begins
  // on Monday; when today is Monday, starting today is already a full week.
  const daysUntilMonday = (8 - today.weekday) % 7;
  return today.plus({ days: daysUntilMonday }).toISODate() ?? today.toISODate() ?? now.toISOString().slice(0, 10);
}

/// Largest whole-week duration that still ends by race day, mirroring
/// the plan linter's plan_duration_overshoots_race_date arithmetic
/// (planDays <= daysThroughRace, race day inclusive). Returns the
/// request unchanged when there is no race date, the dates are
/// malformed, the race precedes the start, or the window is too small
/// to fit even one full week — those cases stay with the linter.
export function clampTrainingPlanDurationWeeksToRaceDate(params: {
  requestedDurationWeeks: number;
  startDateIso: string;
  raceDateIso: string | null;
}): number {
  const { requestedDurationWeeks, startDateIso, raceDateIso } = params;
  if (!raceDateIso) return requestedDurationWeeks;
  const zone = config.app.timezone || 'Europe/Lisbon';
  const start = DateTime.fromISO(startDateIso, { zone }).startOf('day');
  const race = DateTime.fromISO(raceDateIso, { zone }).startOf('day');
  if (!start.isValid || !race.isValid || race < start) return requestedDurationWeeks;
  const daysThroughRace = Math.floor(race.diff(start, 'days').days) + 1;
  const maxWholeWeeks = Math.floor(daysThroughRace / 7);
  if (maxWholeWeeks < 1) return requestedDurationWeeks;
  return Math.min(requestedDurationWeeks, maxWholeWeeks);
}

function buildWeeklyTargets(input: TrainingPlanWeeklyTargets): TrainingPlanWeeklyTargets {
  return {
    sessionsPerWeek: input.sessionsPerWeek,
    runSessionsPerWeek: input.runSessionsPerWeek,
    strengthSessionsPerWeek: input.strengthSessionsPerWeek,
    bikeSessionsPerWeek: input.bikeSessionsPerWeek,
    swimSessionsPerWeek: input.swimSessionsPerWeek,
  };
}

function normalizeGoalMode(raw: unknown): TrainingGoalMode | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'event_based' ||
    normalized === 'continuous' ||
    normalized === 'maintenance' ||
    normalized === 'return_to_training'
  ) {
    return normalized;
  }
  return null;
}

function normalizeTrainingPriority(raw: unknown): TrainingPriority | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'running' ||
    normalized === 'cycling' ||
    normalized === 'swimming' ||
    normalized === 'strength' ||
    normalized === 'triathlon' ||
    normalized === 'hybrid'
  ) {
    return normalized;
  }
  return null;
}

function normalizeIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return isStrictIsoDate(trimmed) ? trimmed : null;
}

function resolveProfileRaceDate(profile: Record<string, any> | null | undefined): string | null {
  if (!profile) return null;
  return normalizeIsoDate(profile.target_race_date)
    ?? normalizeIsoDate(profile.targetRaceDate)
    ?? normalizeIsoDate(profile.race_date)
    ?? normalizeIsoDate(profile.raceDate);
}
