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
  type TrainingPlanVolumeShortfall,
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
  objectiveNeedsCyclingProfile,
  objectiveNeedsGymProfile,
  objectiveNeedsRunningProfile,
  objectiveNeedsSwimProfile,
  objectiveNeedsTriathlonProfiles,
  resolveObjectiveProfileRequirement,
} from './training-profile-requirements';
import { buildDeterministicTrainingPlan } from './training-fallback-plan';
import { fetchCurrentReadinessForPlan } from './training-read-models';
import {
  finalizeGeneratedTrainingPlanForPersistence,
  lintGeneratedTrainingPlanPreflight,
  persistGeneratedTrainingPlan,
  resolvePlanSlotDate,
  type PersistGeneratedTrainingPlanResult,
} from './training-plan-persistence';
import {
  captureTrainingPlanVolumeTargetSnapshot,
  enforceFinalTrainingPlanTwoADayCap,
  enforceRequestedTrainingPlanVolume,
  recalculateFinalTrainingPlanVolumeShortfalls,
} from '../../services/training-plan-volume-enforcement';
import { loadTrainingCatalogSnapshot } from '../../services/coach-kernel/training-catalog';
import * as trainingPlans from '../../services/training-plans';
import { resolveTrainingCalendarSource } from '../../services/training-calendar-source';
import type { TrainingPlanGenerationLeaseIdentity } from '../../services/training-plan-generation-idempotency';
import {
  assessTrainingPlanSpecReadiness,
  buildTrainingPlanSpec,
  type EnduranceKeyDay,
  type TrainingPlanSpecReadinessResult,
} from '../../services/training-plan-spec';
import { parseSessionDurationMinutesAnswer } from '../../services/training-plan-clarification-registry';
import {
  mergeTrainingQualityIntoPlanLint,
  prepareTrainingPlanForQualityGate,
} from '../../services/coach-kernel/training-plan-quality-gate';
import {
  isFutureIsoDate,
  isStrictIsoDate,
  resolveTrainingTimezone,
} from '../../services/training-date-utils';
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
import {
  attachTrainingLearningPathToPlan,
  type TrainingLearningPath,
} from '../../services/training-learning-path';
import {
  assertTrainingExerciseIdentityCatalogIntegrity,
  buildTrainingExerciseIdentityCatalogSnapshot,
} from '../../services/training-exercise-identity';
import {
  getTrainingExerciseIdentityV1Mode,
  type TrainingExerciseIdentityV1Mode,
} from '../../services/runtime-flags';
import {
  buildTrainingPlanGenerationResponseDiscriminator,
  type TrainingPlanGenerationResponseDiscriminator,
} from './training-plan-generation-response-contract';
import {
  fingerprintTrainingPlanPreviewCandidate,
  signTrainingPlanPreviewToken,
  TrainingPlanPreviewStaleError,
} from '../../services/training-plan-preview-token';

export const TRAINING_PLAN_GENERATOR_POLICY_VERSION = 'training-plan-shape-v2';

type TrainingGenerationVersionPins = {
  catalogVersion: string;
  /** Present only when exercise-identity enforcement is active. Keeping this
   * optional preserves the exact legacy off/shadow payload and preferences
   * shape. */
  catalogSourceHash?: string;
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
  /** Trusted request-context digest assembled by the authenticated preview
   * route. When present, the preview returns a signed, scoped candidate token. */
  previewContextFingerprint?: string;
  /** Candidate digest extracted only from a validated signed preview token.
   * Create compares it before any plan/provider persistence. */
  expectedPreviewCandidateFingerprint?: string;
  /**
   * Internal test/staging smoke clock override. Public API routes do not pass
   * this field; production ignores it so users cannot spoof plan dates.
   */
  plannerNow?: unknown;
  /**
   * Trusted internal seam. Public routes resolve this from users.timezone;
   * request-body values must never be forwarded here.
   */
  schedulingTimezone?: string | null;
  /**
   * F1 compatibility-operation fence acquired by the authenticated REST
   * boundary. Persistence revalidates it inside the replacement transaction.
   */
  generationIdempotencyLease?: TrainingPlanGenerationLeaseIdentity;
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
      data: Record<string, unknown> & TrainingPlanGenerationResponseDiscriminator<'needs_profile'>;
    }
  | {
      status: 'preview';
      data: TrainingPlanGenerationResponseDiscriminator<'preview'> & {
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
          phaseGoal?: string | null;
          weeklyLearningFocus?: string | null;
          whyThisMatters?: string | null;
          techniqueCards?: string[];
          benchmarkSessionTitles?: string[];
          assessmentPrompt?: string | null;
        }>;
        trainingLearningPath: TrainingLearningPath | null;
        /** F10: preview must explain any ask-vs-scheduled gap just like the
         * create response; otherwise `weeklyTargets` changes without a
         * machine-readable reason at the athlete's review boundary. */
        volumeShortfalls: TrainingPlanVolumeShortfall[];
        planLint: PlanLintResult;
        warnings: Array<{ code: string; message: string }>;
        blockers: Array<{ code: string; message: string }>;
        calendarFetchDegraded: boolean;
        calendarFetchError?: string;
        fallbackTemplateUsed: boolean;
        decisionReasons: TrainingDecisionReason[];
        goalMode: TrainingGoalMode | null;
        trainingPriority: TrainingPriority | null;
        raceDate: string | null;
        generatorPolicyVersion: string;
        generationVersionPins: TrainingGenerationVersionPins;
        previewToken?: string;
        trainingSafety?: TrainingSafetyGenerationSummary | null;
      };
    }
  | {
      status: 'created';
      data: Record<string, unknown> & TrainingPlanGenerationResponseDiscriminator<'created'>;
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
      status: 'needs_clarification';
      data: TrainingPlanGenerationResponseDiscriminator<'needs_clarification'> & {
        status: 'needs_clarification';
        message: string;
        specReadiness: TrainingPlanSpecReadinessResult;
        clarificationIssues: TrainingPlanSpecReadinessResult['issues'];
        suggestedQuestions: string[];
        fallbackTemplateUsed: boolean;
        decisionReasons: TrainingDecisionReason[];
        goalMode: TrainingGoalMode | null;
        trainingPriority: TrainingPriority | null;
        raceDate: string | null;
        generatorPolicyVersion: string;
        generationVersionPins: TrainingGenerationVersionPins;
        trainingSafety?: TrainingSafetyGenerationSummary | null;
      };
    }
  | {
      status: 'plan_quality_blocked';
      data: TrainingPlanGenerationResponseDiscriminator<'plan_quality_blocked'> & {
        status: 'plan_quality_blocked';
        message: string;
        planLint: PlanLintResult;
        warnings: Array<{ code: string; message: string }>;
        trainingLearningPath?: TrainingLearningPath | null;
        calendarFetchDegraded: boolean;
        calendarFetchError?: string;
        fallbackTemplateUsed: boolean;
        decisionReasons: TrainingDecisionReason[];
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
      data: TrainingPlanGenerationResponseDiscriminator<'cancellation_failed'> & {
        message: string;
        reason: string;
        activePlansRemaining: number;
        generationVersionPins: TrainingGenerationVersionPins;
      };
    };

export interface TrainingPlanWeeklyTargets {
  sessionsPerWeek: number;
  runSessionsPerWeek: number | null;
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
    strengthSessionsPerWeek,
    startPolicy,
    longWorkoutDay,
    notes,
    goalMode,
    trainingPriority,
    raceDate,
    twoADayPreference,
    calendarSource,
    previewOnly = false,
    previewContextFingerprint,
    expectedPreviewCandidateFingerprint,
    plannerNow,
    schedulingTimezone: requestedSchedulingTimezone,
    generationIdempotencyLease,
  } = input;
  const tenantId = requireTenantIdParam(input.tenantId, 'generateTrainingPlanForUser');
  const expectedActivePlanIds = previewOnly
    ? []
    : trainingPlans.getActivePlans(userId, tenantId).map((plan) => plan.id).sort((a, b) => a - b);
  const schedulingTimezone = resolveTrainingTimezone(requestedSchedulingTimezone);
  const exerciseIdentityMode = getTrainingExerciseIdentityV1Mode(process.env, { tenantId, userId });
  const requestedDurationWeeks = normalizeTrainingPlanDurationWeeks(input.durationWeeks, 4);
  const now = resolvePlannerNow(plannerNow);

  const fitnessProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'fitness'));
  const gymProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-gym'));
  const runProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-running'));
  const cyclingProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-cycling'));
  const swimProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-swim'));
  const requestedGoalMode = normalizeGoalMode(goalMode);
  const normalizedTrainingPriority = normalizeTrainingPriority(trainingPriority);
  const normalizedRaceDate = normalizeIsoDate(raceDate);
  const raceDateWasProvided = typeof raceDate === 'string'
    ? raceDate.trim() !== ''
    : raceDate != null;
  if (raceDateWasProvided && normalizedRaceDate == null) {
    return {
      status: 'needs_profile',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_profile'),
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
  if (normalizedRaceDate && !isFutureIsoDate(normalizedRaceDate, now, schedulingTimezone)) {
    return {
      status: 'needs_profile',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_profile'),
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
  const profileRaceDate = resolveProfileRaceDate(runProfile);
  const effectiveProfileRaceDate = profileRaceDate
    && isFutureIsoDate(profileRaceDate, now, schedulingTimezone)
    ? profileRaceDate
    : null;
  const effectiveRaceDate = normalizedRaceDate ?? effectiveProfileRaceDate;
  // Profile dates are advisory and can outlive the event. Strip every alias
  // before reattaching the one validated, strictly-future canonical value so
  // the phase generator cannot see stale/today metadata through a side door.
  const runProfileWithoutRaceDates = stripProfileRaceDates(runProfile);
  const runProfileForPlan = effectiveRaceDate
    ? {
        ...(runProfileWithoutRaceDates ?? {}),
        target_race_date: effectiveRaceDate,
        target_race: typeof runProfile?.target_race === 'string' && runProfile.target_race.trim()
          ? runProfile.target_race
          : objective,
      }
    : runProfileWithoutRaceDates;
  const enduranceProfileForPlan = mergeEnduranceProfileForPlan(runProfileForPlan, cyclingProfile, swimProfile);
  // Computed here (not at the lint-input site below) because the
  // duration clamp after start-date resolution needs the exact same
  // event-based definition the linter applies.
  const raceDateForLint: string | null = effectiveRaceDate;
  // F12 policy (a), chosen 2026-08-03: raceDate wins. The phase generator
  // already builds toward a supplied race, so every downstream consumer must
  // see the same effective mode for clamping, linting, persistence, and reads.
  const raceDateOverridesRequestedMode = raceDateForLint !== null
    && requestedGoalMode !== 'event_based';
  const normalizedGoalMode: TrainingGoalMode | null = raceDateOverridesRequestedMode
    ? 'event_based'
    : requestedGoalMode;
  const isRaceSpecificForLint = normalizedGoalMode === 'event_based';

  if (!fitnessProfile || Object.keys(fitnessProfile).length === 0) {
    // RERUN-2 finding 3 (2026-06-12): this gate used to omit
    // requiredQuestionnaireId/Title while the objective gate right below
    // includes them — the null id suppressed the iOS routing CTA for
    // empty-fitness-profile users. Keep the shape identical to the
    // objective gate so every needs_profile response is routable.
    return {
      status: 'needs_profile',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_profile'),
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
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_profile'),
        needsProfile: true,
        requiredQuestionnaireId: objectiveRequirement.questionnaireId,
        requiredQuestionnaireTitle: objectiveRequirement.title,
        message: objectiveRequirement.message,
        missingFields: objectiveRequirement.missingFields,
      },
    };
  }

  const normalizedStartPolicy = normalizeStartPolicy(startPolicy);
  const startStr = resolveTrainingPlanStartDate(now, normalizedStartPolicy, schedulingTimezone);
  // F12 policy (a): a valid future race date makes the request event-based,
  // but it still has to be reachable from the resolved plan window. The
  // duration clamp cannot repair a race that occurs before week 1, and letting
  // it through would persist an event-based plan whose generated phases omit
  // the race entirely. Fail before calendar reads, kernel generation, or any
  // cancellation/persistence work.
  if (raceDateForLint && raceDateForLint < startStr) {
    return {
      status: 'needs_profile',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_profile'),
        needsProfile: true,
        message: 'Race date must be on or after the resolved training-plan start date.',
        missingFields: ['raceDate'],
        validationError: {
          code: 'RACE_DATE_BEFORE_PLAN_START',
          field: 'raceDate',
          raceDate: raceDateForLint,
          resolvedStartDate: startStr,
        },
      },
    };
  }
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
    raceDateIso: isRaceSpecificForLint ? raceDateForLint : null,
    schedulingTimezone,
  });
  const endStr = DateTime
    .fromISO(startStr, { zone: schedulingTimezone })
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
    busyWindows = buildBusyWindows(events || [], schedulingTimezone);
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
    env: process.env,
    scope: { userId, tenantId },
  });

  const normalizedSessionsPerWeek = clampNumber(sessionsPerWeek, 5, 3, 7);
  const objectiveHasRunning = objectiveNeedsRunningProfile(objective);
  const objectiveHasGym = objectiveNeedsGymProfile(objective);
  const objectiveHasCycling = objectiveNeedsCyclingProfile(objective);
  const objectiveHasSwimming = objectiveNeedsSwimProfile(objective);
  const objectiveHasTriathlon = objectiveNeedsTriathlonProfiles(objective);
  const explicitRunSessionsPerWeek = normalizeOptionalSessionTarget(runSessionsPerWeek, 0, 7);
  const normalizedRunSessionsPerWeek =
    explicitRunSessionsPerWeek ?? (objectiveHasRunning && !objectiveHasTriathlon
      ? normalizedSessionsPerWeek
      : undefined);
  const normalizedBikeSessionsPerWeek = normalizeOptionalSessionTarget(bikeSessionsPerWeek, 0, 7);
  const normalizedSwimSessionsPerWeek = normalizeOptionalSessionTarget(swimSessionsPerWeek, 0, 7);
  const normalizedStrengthSessionsPerWeek = normalizeOptionalSessionTarget(strengthSessionsPerWeek, 0, 6);
  const gymOnlyObjective =
    objectiveHasGym
    && !objectiveHasRunning
    && !objectiveHasCycling
    && !objectiveHasSwimming
    && !objectiveHasTriathlon;
  const effectiveStrengthSessionsPerWeek = normalizedStrengthSessionsPerWeek != null
    ? normalizedStrengthSessionsPerWeek
    : gymOnlyObjective
      ? Math.min(normalizedSessionsPerWeek, 6)
      : 2;
  const normalizedLongWorkoutDay = typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null;

  let sharedDecisionContext = '';
  let coordination = buildTrainingPlanCoordination({
    sessionsPerWeek: normalizedSessionsPerWeek,
    strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
    longWorkoutDay: normalizedLongWorkoutDay,
    fitnessProfile,
    gymProfile,
    runProfile: enduranceProfileForPlan,
    training: null,
    cooking: null,
    finance: null,
    content: null,
    secretary: null,
    env: process.env,
    scope: { userId, tenantId },
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
      readTrainingMeshContext({ userId, tenantId, weekStart: startStr }),
      readCookingMeshContext({ userId, tenantId, weekStart: startStr }),
      readFinanceMeshContext({ userId, tenantId, weekStart: startStr }),
      readContentMeshContext({ userId, tenantId, weekStart: startStr }),
      readSecretaryMeshContext({ userId, tenantId, weekStart: startStr }),
      buildSharedDecisionContext('triathlon', userId, tenantId),
    ]);

    sharedDecisionContext = sharedContextResult.status === 'fulfilled' ? sharedContextResult.value : '';
    coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: normalizedSessionsPerWeek,
      strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
      longWorkoutDay: normalizedLongWorkoutDay,
      fitnessProfile,
      gymProfile,
      runProfile: enduranceProfileForPlan,
      training: trainingContextResult.status === 'fulfilled' ? trainingContextResult.value : null,
      cooking: cookingContextResult.status === 'fulfilled' ? cookingContextResult.value : null,
      finance: financeContextResult.status === 'fulfilled' ? financeContextResult.value : null,
      content: contentContextResult.status === 'fulfilled' ? contentContextResult.value : null,
      secretary: secretaryContextResult.status === 'fulfilled' ? secretaryContextResult.value : null,
      sharedDecisionContext,
      env: process.env,
      scope: { userId, tenantId },
    });
  } catch (err) {
    logger.warn({ err, userId }, 'training plan coordination context unavailable — falling back to profile/calendar only');
  }

  const normalizedPreferredTime = normalizePreferredTime(preferredTime, '12:00');
  const normalizedPreferredCardioTime = normalizePreferredTime(preferredCardioTime, normalizedPreferredTime);
  const normalizedPreferredStrengthTime = normalizePreferredTime(preferredStrengthTime, normalizedPreferredTime);
  const upstreamCapacityWindows = config.coaching.trainingCalendarCapacityKernelEnabled
    && !calendarFetchDegraded
    && busyWindows.length > 0
    ? buildKernelCapacityWindows({
        startDate: startStr,
        busyWindows,
        schedulingTimezone,
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
      runProfile: enduranceProfileForPlan,
      currentReadiness,
      twoADayPreference,
      capacityWindows: upstreamCapacityWindows,
      ...(exerciseIdentityMode === 'active' ? { exerciseIdentityMode } : {}),
    }), coordination, { exerciseIdentityMode });
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
      env: process.env,
      scope: { userId, tenantId },
    }), coordination, { exerciseIdentityMode });
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
    bikeSessionsPerWeek: normalizedBikeSessionsPerWeek,
    swimSessionsPerWeek: normalizedSwimSessionsPerWeek,
    strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
    preferredCardioTime: normalizedPreferredCardioTime,
    preferredStrengthTime: normalizedPreferredStrengthTime,
    startDate: startStr,
    longWorkoutDay: coordination.resolvedLongWorkoutDay ?? normalizedLongWorkoutDay,
    // F7 (Phase 3): the kernel already receives the preference as guidance;
    // the volume enforcer is the per-day-cap guarantee, so it needs it too.
    twoADayPreference: twoADayPreference ?? null,
  };
  // Capture request interpretation while the raw coach output still carries
  // every auto-selected modality. Later trims must not redefine the ask.
  const volumeTargetSnapshot = captureTrainingPlanVolumeTargetSnapshot(
    planData,
    volumeEnforcementInput,
  );
  const volumeEnforcedPlan = enforceRequestedTrainingPlanVolume(planData, volumeEnforcementInput);
  // F10 (Phase 3): captured before the equipment pass, which may rebuild the
  // plan object without carrying the enforcement metadata through.
  let volumeShortfalls = volumeEnforcedPlan.volumeShortfalls ?? [];
  planData = applyEquipmentAuthorityMode(
    volumeEnforcedPlan,
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
  const raceDateGoalModeDecision = buildRaceDateGoalModeOverrideReason({
    requestedGoalMode,
    effectiveGoalMode: normalizedGoalMode,
    raceDate: raceDateForLint,
  });
  if (raceDateGoalModeDecision) {
    planData = {
      ...planData,
      decisionReasons: dedupeDecisionReasons([
        ...safeDecisionReasons(planData?.decisionReasons),
        raceDateGoalModeDecision,
      ]),
    };
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
  const safetyBlocked = safetyOutput?.effectiveSeverity === 'block'
    || generatedPlanContainsSafetyPause(planData);
  planData = attachTrainingLearningPathToPlan(planData, {
    objective,
    goalMode: normalizedGoalMode,
    trainingPriority: normalizedTrainingPriority,
    durationWeeks,
  });

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
  const generationVersionPins = buildTrainingGenerationVersionPins(tenantId, exerciseIdentityMode);
  const requestedStrengthDaysForQuality = effectiveStrengthSessionsPerWeek > 0
    ? effectiveStrengthSessionsPerWeek
    : gymOnlyObjective
      ? normalizedSessionsPerWeek
      : 0;
  const generatedEnduranceSchedule = buildGeneratedEnduranceSchedule(
    planData,
    startStr,
    now,
    schedulingTimezone,
  );
  // Conservative bodyweight items keep generation safe, but an
  // unknown-confidence profile is not evidence that the user declared
  // equipment. Present that distinction to readiness without changing the
  // canonical adaptation used by generation and persistence.
  const equipmentUnknownForReadiness = equipmentAdaptation.canonicalProfile?.confidence === 'unknown';
  const trainingPlanSpec = requestedStrengthDaysForQuality >= 2
    ? buildTrainingPlanSpec({
        userId,
        objective,
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        daysPerWeek: requestedStrengthDaysForQuality,
        startDate: startStr,
        equipmentProfileLabel: equipmentUnknownForReadiness ? 'unknown' : equipmentProfileLabel,
        availableEquipment: equipmentUnknownForReadiness
          ? []
          : equipmentAdaptation.canonicalProfile?.items,
        // Phase 2 (F2): the session_duration_clarification answer is written
        // to the canonical gym profile; consuming it here is what closes the
        // answer → profile write → re-preview loop.
        sessionDurationMinutes: parseSessionDurationMinutesAnswer(gymProfile),
        fitnessProfile,
        gymProfile,
        enduranceSchedule: generatedEnduranceSchedule,
        calendarSource: resolvedCalendarSource || null,
        durationWeeks,
      })
    : null;
  const specReadiness = trainingPlanSpec
    ? assessTrainingPlanSpecReadiness(trainingPlanSpec)
    : null;
  if (!safetyBlocked && specReadiness?.status === 'needs_clarification') {
    incrementTrainingGenerationCounter('spec_needs_clarification_total');
    logger.warn(
      {
        event: 'training_plan_spec.needs_clarification',
        userId,
        objective,
        clarificationIds: specReadiness.issues.map((issue) => issue.id),
      },
      'Training plan generation needs clarification before cancellation/persistence',
    );
    return {
      status: 'needs_clarification',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('needs_clarification'),
        message:
          'Nexus needs one or two training details before saving this high-frequency strength plan.',
        specReadiness,
        clarificationIssues: specReadiness.issues,
        suggestedQuestions: specReadiness.issues.map((issue) => issue.question),
        fallbackTemplateUsed: usedFallbackTemplate,
        decisionReasons: safeDecisionReasons(planData?.decisionReasons),
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        raceDate: raceDateForLint,
        generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
        generationVersionPins,
        trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      },
    };
  }
  const trainingQuality = trainingPlanSpec && !safetyBlocked
    ? prepareTrainingPlanForQualityGate(planData, trainingPlanSpec, { exerciseIdentityMode })
    : null;
  if (trainingQuality) {
    planData = trainingQuality.planData;
  }
  // F7 final invariant restoration: quality enrichment owns split structure
  // and may move sessions after the main volume pass. Re-apply ONLY the hard
  // one-session-per-day shape constraint here, before finalization/lint, so a
  // late repair cannot recreate a doubled day for an athlete who chose
  // `never`. The narrow pass never authors replacement workout content.
  planData = enforceFinalTrainingPlanTwoADayCap(planData, {
    startDate: startStr,
    twoADayPreference: twoADayPreference ?? null,
  });
  volumeShortfalls = planData.volumeShortfalls ?? volumeShortfalls;
  const requestedWeeklyTargets = buildWeeklyTargets({
    sessionsPerWeek: normalizedSessionsPerWeek,
    runSessionsPerWeek: normalizedRunSessionsPerWeek ?? null,
    bikeSessionsPerWeek: normalizedBikeSessionsPerWeek,
    swimSessionsPerWeek: normalizedSwimSessionsPerWeek,
    strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
  });
  const buildPreferencesJson = (weeklyTargets: TrainingPlanWeeklyTargets): string => JSON.stringify({
    schedulingTimezone,
    preferredTime: normalizedPreferredTime,
    preferredCardioTime: normalizedPreferredCardioTime,
    preferredStrengthTime: normalizedPreferredStrengthTime,
    sessionsPerWeek: weeklyTargets.sessionsPerWeek,
    runSessionsPerWeek: weeklyTargets.runSessionsPerWeek,
    bikeSessionsPerWeek: weeklyTargets.bikeSessionsPerWeek,
    swimSessionsPerWeek: weeklyTargets.swimSessionsPerWeek,
    strengthSessionsPerWeek: weeklyTargets.strengthSessionsPerWeek,
    // The flat keys above are REALIZED targets (counted from the finalized
    // plan). requestedTargets preserves what the user asked for, so re-edit
    // flows and honest capacity messaging can compare the two.
    requestedTargets: {
      sessionsPerWeek: requestedWeeklyTargets.sessionsPerWeek,
      runSessionsPerWeek: requestedWeeklyTargets.runSessionsPerWeek,
      bikeSessionsPerWeek: requestedWeeklyTargets.bikeSessionsPerWeek,
      swimSessionsPerWeek: requestedWeeklyTargets.swimSessionsPerWeek,
      strengthSessionsPerWeek: requestedWeeklyTargets.strengthSessionsPerWeek,
    },
    // getAllPlanWeeks reads the per-week learning focus from
    // preferences_json (training-read-models.ts) — without this key a
    // freshly generated plan can never render its learning path on the
    // Plan zone. Caught by the isolated Training E2E lane 2026-07-02
    // after the field was dropped in the 4.14.210 mainline rebase.
    trainingLearningPath: extractTrainingLearningPath(planData),
    longWorkoutDay: longWorkoutDay || null,
    notes: notes || null,
    goalMode: normalizedGoalMode,
    trainingPriority: normalizedTrainingPriority,
    raceDate: effectiveRaceDate,
    startPolicy: normalizedStartPolicy,
    twoADayPreference: twoADayPreference ?? null,
    // F10 (Phase 3): structured record of ask-vs-placed gaps, persisted so
    // re-edit flows and support can see WHY a week under-delivers.
    volumeShortfalls,
    trainingPlanSpec,
    trainingPlanQuality: trainingQuality?.planData.trainingPlanQuality ?? null,
    trainingPlanRepairActions: trainingQuality?.repairActions ?? [],
    trainingCalendarSource: resolvedCalendarSource || null,
    generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
    generationVersionPins,
  });

  const persistenceInput = {
    replaceExistingActivePlan: true,
    expectedActivePlanIds,
    generationIdempotencyLease,
    userId,
    tenantId,
    objective,
    durationWeeks,
    startDate: startStr,
    endDate: endStr,
    now,
    schedulingTimezone,
    planData,
    preferencesJson: buildPreferencesJson(requestedWeeklyTargets),
    normalizedPreferredTime,
    normalizedPreferredCardioTime,
    normalizedPreferredStrengthTime,
    busyWindows,
    athleteProfiles: {
      fitnessProfile,
      gymProfile,
      runProfile: enduranceProfileForPlan,
      cyclingProfile,
      swimProfile,
    },
    calendarSource: resolvedCalendarSource || undefined,
    equipmentProfile: equipmentProfileLabel,
    raceDate: raceDateForLint,
    isRaceSpecific: isRaceSpecificForLint,
    goalMode: normalizedGoalMode,
    // F7 (Phase 3): arms the two_a_day_cap lint rule in preflight + advisor.
    twoADayPreference: twoADayPreference ?? null,
    trainingPlanSpec: trainingPlanSpec ?? undefined,
  };

  let finalizedPersistenceInput = finalizeGeneratedTrainingPlanForPersistence(persistenceInput);
  // F10 final truth: equipment/quality passes and deterministic schedule
  // finalization can add, remove, or defer sessions after the primary volume
  // pass. Recalculate against that exact schedule while retaining the
  // original enforced modality mix for partial-multisport target semantics.
  planData = recalculateFinalTrainingPlanVolumeShortfalls(
    finalizedPersistenceInput.planData,
    volumeTargetSnapshot,
  );
  volumeShortfalls = planData.volumeShortfalls ?? [];
  const scheduledWeeklyTargets = buildScheduledWeeklyTargetsFromPlan(planData, requestedWeeklyTargets);
  finalizedPersistenceInput = {
    ...finalizedPersistenceInput,
    planData,
    preferencesJson: buildPreferencesJson(scheduledWeeklyTargets),
  };
  const basePreflightLint = lintGeneratedTrainingPlanPreflight(finalizedPersistenceInput);
  const preflightLint = trainingQuality
    ? mergeTrainingQualityIntoPlanLint(basePreflightLint, trainingQuality.validation)
    : basePreflightLint;
  const previewCandidateData = {
    ...buildTrainingPlanGenerationResponseDiscriminator('preview'),
    planName: typeof planData.planName === 'string' ? planData.planName : null,
    sport: typeof planData.sport === 'string' ? planData.sport : null,
    objective,
    durationWeeks,
    resolvedStartDate: startStr,
    weeklyTargets: buildWeeklyTargets({
      sessionsPerWeek: scheduledWeeklyTargets.sessionsPerWeek,
      runSessionsPerWeek: scheduledWeeklyTargets.runSessionsPerWeek,
      strengthSessionsPerWeek: scheduledWeeklyTargets.strengthSessionsPerWeek,
      bikeSessionsPerWeek: scheduledWeeklyTargets.bikeSessionsPerWeek,
      swimSessionsPerWeek: scheduledWeeklyTargets.swimSessionsPerWeek,
    }),
    totalSessions: countSchedulablePlanSessions(planData),
    calendarSource: resolvedCalendarSource || null,
    phaseRoadmap: buildPlanPhaseRoadmap(planData),
    trainingLearningPath: extractTrainingLearningPath(planData),
    volumeShortfalls,
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
    decisionReasons: safeDecisionReasons(planData?.decisionReasons),
    goalMode: normalizedGoalMode,
    trainingPriority: normalizedTrainingPriority,
    raceDate: raceDateForLint,
    generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
    generationVersionPins,
    trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
  };
  const previewCandidateFingerprint = fingerprintTrainingPlanPreviewCandidate({
    planData,
    preview: previewCandidateData,
  });
  if (expectedPreviewCandidateFingerprint
    && expectedPreviewCandidateFingerprint !== previewCandidateFingerprint) {
    // The rerun no longer matches the candidate the athlete accepted. This
    // executes before plan persistence and before any provider/calendar work.
    throw new TrainingPlanPreviewStaleError('candidate_changed');
  }
  if (usedFallbackTemplate && !previewOnly) {
    incrementTrainingGenerationCounter('fallback_template_blocked_total');
    logger.warn(
      {
        event: 'training_plan_generation.fallback_requires_review',
        userId,
        objective,
        warningRuleIds: preflightLint.warnings.map((warning) => warning.ruleId),
        blockerRuleIds: preflightLint.blockers.map((blocker) => blocker.ruleId),
      },
      'Training plan fallback template generated but blocked before persistence; user should review a preview and retry the coach kernel path',
    );
    return {
      status: 'plan_quality_blocked',
      data: {
        ...buildTrainingPlanGenerationResponseDiscriminator('plan_quality_blocked'),
        message:
          'Nexus generated a safe fallback preview, but did not save it because the full coach engine was unavailable. Review the preview, retry generation, or adjust the inputs before saving a plan.',
        planLint: preflightLint,
        trainingLearningPath: extractTrainingLearningPath(planData),
        warnings: [
          {
            code: 'fallback_requires_review',
            message:
              'The coach engine was unavailable, so Nexus stopped before saving a generic fallback plan.',
          },
          ...buildPlanWarnings({
            calendarFetchDegraded,
            calendarFetchError,
            lintResult: preflightLint,
            safetyOutput,
          }),
        ],
        calendarFetchDegraded,
        ...(calendarFetchError ? { calendarFetchError } : {}),
        fallbackTemplateUsed: true,
        decisionReasons: safeDecisionReasons(planData?.decisionReasons),
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        raceDate: raceDateForLint,
        generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
        generationVersionPins,
        trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      },
    };
  }
  if (previewOnly) {
    const previewToken = previewContextFingerprint
      ? signTrainingPlanPreviewToken({
          userId,
          tenantId,
          contextFingerprint: previewContextFingerprint,
          candidateFingerprint: previewCandidateFingerprint,
          now,
        })
      : undefined;
    return {
      status: 'preview',
      data: {
        ...previewCandidateData,
        ...(previewToken ? { previewToken } : {}),
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
        ...buildTrainingPlanGenerationResponseDiscriminator('plan_quality_blocked'),
        message:
          'Nexus blocked this plan before saving because it failed the Training quality gate. Review the coach warning, adjust the inputs, and generate again.',
        planLint: preflightLint,
        trainingLearningPath: extractTrainingLearningPath(planData),
        warnings: buildPlanWarnings({
          calendarFetchDegraded,
          calendarFetchError,
          lintResult: preflightLint,
          safetyOutput,
        }),
        calendarFetchDegraded,
        ...(calendarFetchError ? { calendarFetchError } : {}),
        fallbackTemplateUsed: usedFallbackTemplate,
        decisionReasons: safeDecisionReasons(planData?.decisionReasons),
        goalMode: normalizedGoalMode,
        trainingPriority: normalizedTrainingPriority,
        raceDate: raceDateForLint,
        generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
        generationVersionPins,
        trainingSafety: buildTrainingSafetyGenerationSummary(safetyOutput),
      },
    };
  }

  // F6: persistence owns one atomic replacement transaction. It writes the
  // complete graph as pending, revalidates the F1 fence + predecessor CAS,
  // retains prior plans as superseded, activates the candidate, and enqueues
  // calendar work before commit. There is no cancellation/provider saga and
  // therefore no observable zero-active-plan window.
  const buildCreatedResult = (
    persistedPlan: PersistGeneratedTrainingPlanResult,
  ): Extract<TrainingPlanGenerationResult, { status: 'created' }> => {
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
    // Phase 1B: provider calendar work is queued through the outbox and runs in
    // the training_plan_calendar_sync worker after activation, so at response
    // time nothing is created, linked, or failed yet. Reporting
    // `totalSessions - 0` as failures here would fabricate failures; the honest
    // contract is pending + not_synced. (`calendarSyncQueued` is read
    // defensively because legacy tests mock persistGeneratedTrainingPlan
    // without the Phase 1B fields.)
    const calendarSyncPending = persistedPlan.calendarSyncQueued === true;
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
        ...buildTrainingPlanGenerationResponseDiscriminator('created'),
        planId: persistedPlan.planId,
        planName: planData.planName,
        sport: planData.sport,
        objective,
        durationWeeks,
        resolvedStartDate: startStr,
        calendarSource: resolvedCalendarSource || null,
        phaseRoadmap: buildPlanPhaseRoadmap(planData),
        trainingLearningPath: extractTrainingLearningPath(planData),
        totalSessions: persistedPlan.totalSessions,
        eventsCreated: persistedPlan.eventsCreated,
        // Phase 1B contract change (deliberate): calendar sync is asynchronous,
        // so creation responses always report `not_synced` + `pending` and zero
        // counts — never fabricated failures. iOS reads these fields from the
        // wrong nesting level today (F20) and always sees nil, so no released
        // client regresses; the worker-persisted plan-level state is the
        // durable source of truth for later reads.
        calendarSync: {
          provider: resolvedCalendarSource || null,
          sessionsAttempted: persistedPlan.totalSessions,
          eventsCreated: persistedPlan.eventsCreated,
          sessionsLinked: persistedPlan.sessionsLinked,
          sessionsFailed: 0,
          unscheduled: 0,
          status: 'not_synced',
          pending: calendarSyncPending,
        },
        preferredCardioTime: normalizedPreferredCardioTime,
        preferredStrengthTime: normalizedPreferredStrengthTime,
        weeklyTargets: buildWeeklyTargets({
          sessionsPerWeek: scheduledWeeklyTargets.sessionsPerWeek,
          runSessionsPerWeek: scheduledWeeklyTargets.runSessionsPerWeek,
          strengthSessionsPerWeek: scheduledWeeklyTargets.strengthSessionsPerWeek,
          bikeSessionsPerWeek: scheduledWeeklyTargets.bikeSessionsPerWeek,
          swimSessionsPerWeek: scheduledWeeklyTargets.swimSessionsPerWeek,
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
        // F10 (Phase 3, additive): every gap between the requested and the
        // placeable weekly volume, with a machine-readable reason — the fill
        // loops used to under-deliver silently.
        volumeShortfalls,
        // training-expert-coach-knowledge-engine: explicit calendar
        // health flag + lint verdict surface on the response payload.
        calendarFetchDegraded,
        ...(calendarFetchError ? { calendarFetchError } : {}),
        planLint: lintResult,
        warnings: planWarnings,
        message: buildTrainingPlanCreatedMessage({
          totalSessions: persistedPlan.totalSessions,
          durationWeeks,
          calendarSyncPending,
          calendarSource: resolvedCalendarSource || null,
        }),
      },
    };
  };

  const persistedPlan = await persistGeneratedTrainingPlan({
    ...finalizedPersistenceInput,
    ...(generationIdempotencyLease
      ? {
          buildCommittedIdempotencyResponse: (result: PersistGeneratedTrainingPlanResult) =>
            buildCreatedResult(result).data,
        }
      : {}),
  });
  return buildCreatedResult(persistedPlan);
}

function buildTrainingPlanCreatedMessage(input: {
  totalSessions: number;
  durationWeeks: number;
  calendarSyncPending: boolean;
  calendarSource: CalendarSource | null;
}): string {
  const sessionLabel = input.totalSessions === 1 ? 'session' : 'sessions';
  const weekLabel = input.durationWeeks === 1 ? 'week' : 'weeks';
  const base = `Plan created! ${input.totalSessions} ${sessionLabel} scheduled across ${input.durationWeeks} ${weekLabel}.`;
  if (!input.calendarSource) {
    return `${base} Calendar sync is not connected for this plan.`;
  }

  const providerName = input.calendarSource === 'google' ? 'Google Calendar' : 'Outlook Calendar';
  // Phase 1B: provider events are created by the background sync worker, so
  // the creation message never claims events already exist.
  if (input.calendarSyncPending) {
    return `${base} ${providerName} events are being created in the background.`;
  }
  return `${base} No ${providerName} events were queued; use calendar sync after reconnecting the provider.`;
}

function countSchedulablePlanSessions(planData: any): number {
  return (Array.isArray(planData?.weeks) ? planData.weeks : []).reduce((sum: number, week: any) => {
    const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
    return sum + sessions.filter((session: any) => {
      return isSchedulableTrainingPlanSession(session);
    }).length;
  }, 0);
}

function buildScheduledWeeklyTargetsFromPlan(
  planData: any,
  fallback: TrainingPlanWeeklyTargets,
): TrainingPlanWeeklyTargets {
  const weeks = Array.isArray(planData?.weeks) ? planData.weeks : [];

  const maxCounts = {
    trainingDays: 0,
    running: 0,
    cycling: 0,
    swimming: 0,
    strength: 0,
  };
  let sawAnyPlanSession = false;

  for (const week of weeks) {
    const weekCounts = {
      running: 0,
      cycling: 0,
      swimming: 0,
      strength: 0,
    };
    const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
    sawAnyPlanSession = sawAnyPlanSession || sessions.length > 0;
    const trainingDayKeys = new Set<string>();
    for (const [index, session] of sessions.entries()) {
      if (!isSchedulableTrainingPlanSession(session)) continue;
      trainingDayKeys.add(scheduledTrainingDayKey(session, index));
      const modality = scheduledWeeklyTargetModality(session);
      if (!modality) continue;
      weekCounts[modality] += 1;
    }
    maxCounts.trainingDays = Math.max(maxCounts.trainingDays, trainingDayKeys.size);
    maxCounts.running = Math.max(maxCounts.running, weekCounts.running);
    maxCounts.cycling = Math.max(maxCounts.cycling, weekCounts.cycling);
    maxCounts.swimming = Math.max(maxCounts.swimming, weekCounts.swimming);
    maxCounts.strength = Math.max(maxCounts.strength, weekCounts.strength);
  }

  return {
    // Athlete-facing response truth is realized schedule capacity. An empty
    // engine/final plan is zero, not permission to echo the original ask.
    sessionsPerWeek: sawAnyPlanSession ? maxCounts.trainingDays : 0,
    runSessionsPerWeek: nullableScheduledTarget(maxCounts.running, fallback.runSessionsPerWeek),
    bikeSessionsPerWeek: nullableScheduledTarget(maxCounts.cycling, fallback.bikeSessionsPerWeek),
    swimSessionsPerWeek: nullableScheduledTarget(maxCounts.swimming, fallback.swimSessionsPerWeek),
    strengthSessionsPerWeek: maxCounts.strength,
  };
}

function scheduledTrainingDayKey(session: any, fallbackIndex: number): string {
  const date = String(
    session?.date
      || session?.scheduledDate
      || session?.sessionDate
      || session?.startDate
      || '',
  ).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  const day = String(session?.dayOfWeek || session?.day || '').trim().toLowerCase();
  return day || `session-${fallbackIndex}`;
}

function nullableScheduledTarget(count: number, requested: number | null): number | null {
  if (count > 0) return count;
  return requested == null ? null : 0;
}

function isSchedulableTrainingPlanSession(session: any): boolean {
  const type = String(session?.sessionType || '').toLowerCase();
  const status = String(session?.scheduleState || '').toLowerCase();
  return type !== 'rest'
    && status !== 'dropped'
    && status !== 'deferred'
    && status !== 'unscheduled'
    && status !== 'canceled'
    && status !== 'cancelled';
}

function scheduledWeeklyTargetModality(
  session: any,
): 'running' | 'cycling' | 'swimming' | 'strength' | null {
  const type = String(session?.sessionType || '').trim().toLowerCase();
  const title = String(session?.title || '').trim().toLowerCase();
  if (!type && !title) return null;
  if (type === 'gym' || type === 'lift' || type.startsWith('strength')) return 'strength';
  if (type === 'ride' || type === 'bike' || type === 'cycling' || type.includes('cycle')) return 'cycling';
  if (type === 'swim' || type === 'swimming' || type.includes('swim')) return 'swimming';
  if (
    type === 'run'
    || type === 'running'
    || type === 'jog'
    || type === 'brick'
    || type.endsWith('_run')
    || type.includes('run')
    || title.includes('run')
  ) {
    return 'running';
  }
  return null;
}

function buildKernelCapacityWindows(input: {
  startDate: string;
  busyWindows: BusyWindow[];
  schedulingTimezone?: string | null;
}): CapacityWindow[] {
  const zone = resolveTrainingTimezone(input.schedulingTimezone);
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

function buildTrainingGenerationVersionPins(
  tenantId: number,
  exerciseIdentityMode: TrainingExerciseIdentityV1Mode,
): TrainingGenerationVersionPins {
  const snapshot = loadTrainingCatalogSnapshot({ tenantId });
  const identityCatalog = exerciseIdentityMode === 'active'
    ? buildTrainingExerciseIdentityCatalogSnapshot()
    : null;
  if (identityCatalog) assertTrainingExerciseIdentityCatalogIntegrity(identityCatalog);
  return {
    catalogVersion: identityCatalog?.catalogVersion ?? snapshot.catalogVersion,
    ...(identityCatalog ? { catalogSourceHash: identityCatalog.sourceHash } : {}),
    sciencePolicyVersion: snapshot.sciencePolicyVersion,
    selectorPolicyVersion: snapshot.selectorPolicyVersion,
    equipmentVocabularyVersion: snapshot.equipmentVocabularyVersion,
    generationPipelineVersion: snapshot.generationPipelineVersion,
  };
}

function buildPlanPhaseRoadmap(planData: any): Array<{
  weekNumber: number;
  phase: string;
  sessionCount: number;
  keySessions: string[];
  phaseGoal?: string | null;
  weeklyLearningFocus?: string | null;
  whyThisMatters?: string | null;
  techniqueCards?: string[];
  benchmarkSessionTitles?: string[];
  assessmentPrompt?: string | null;
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
    const learningFocus = objectValue(week?.learningFocus);
    return {
      weekNumber: Number(week?.weekNumber) || index + 1,
      phase: String(week?.focus || 'base'),
      sessionCount: activeSessions.length,
      keySessions,
      phaseGoal: nonEmptyString(learningFocus?.phaseGoal),
      weeklyLearningFocus: nonEmptyString(learningFocus?.weeklyLearningFocus),
      whyThisMatters: nonEmptyString(learningFocus?.whyThisMatters),
      techniqueCards: stringArray(learningFocus?.techniqueCards, 4),
      benchmarkSessionTitles: stringArray(learningFocus?.benchmarkSessionTitles, 3),
      assessmentPrompt: nonEmptyString(learningFocus?.assessmentPrompt),
    };
  });
}

function extractTrainingLearningPath(planData: any): TrainingLearningPath | null {
  const learningPath = objectValue(planData?.trainingLearningPath);
  return learningPath ? learningPath as TrainingLearningPath : null;
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, limit)
    : [];
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

function buildRaceDateGoalModeOverrideReason(input: {
  requestedGoalMode: TrainingGoalMode | null;
  effectiveGoalMode: TrainingGoalMode | null;
  raceDate: string | null;
}): TrainingDecisionReason | null {
  if (
    !input.raceDate
    || input.effectiveGoalMode !== 'event_based'
    || input.requestedGoalMode === 'event_based'
  ) {
    return null;
  }
  const requestedLabel = input.requestedGoalMode ?? 'unspecified';
  return {
    code: 'race_date_implies_event_based',
    text:
      `I treated this as an event-based plan because a race date was supplied `
      + `(requested mode: ${requestedLabel}).`,
    severity: 'notice',
    affectedEntity: { type: 'week' },
    sourceConstraint: {
      type: 'time',
      label: 'race_date',
    },
    before: { goalMode: input.requestedGoalMode },
    after: { goalMode: 'event_based' },
    preservedIntent: 'build_toward_race_date',
    evidence: ['valid_race_date_present'],
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
  const buildSafetyPauseSession = (
    base: Record<string, any>,
    decisionReasons: TrainingDecisionReason[],
  ) => ({
    ...base,
    sessionType: 'rest',
    title: 'Safety pause',
    // Structured marker — the pause gate must not depend on string-matching
    // the display title (which is localizable and trim-sensitive).
    safetyPause: true,
    durationMinutes: 0,
    description: safetyMessage,
    exercises: [],
    scheduleState: 'deferred',
    scheduleAdjustments: [
      'Training paused until the safety check is resolved.',
    ],
    scheduleReason: safetyMessage,
    decisionReasons,
  });
  const weeks = Array.isArray(planData?.weeks)
    ? planData.weeks.map((week: any, weekIndex: number) => {
        const weekReasons = dedupeDecisionReasons([
          ...safeDecisionReasons(week?.decisionReasons),
          ...safetyReasons,
        ]);
        const sessions = Array.isArray(week?.sessions)
          ? week.sessions.map((session: any) => buildSafetyPauseSession(
              session,
              dedupeDecisionReasons([
                ...safeDecisionReasons(session?.decisionReasons),
                ...safetyReasons,
              ]),
            ))
          : [buildSafetyPauseSession({ dayOfWeek: 'Monday' }, safetyReasons)];
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

function generatedPlanContainsSafetyPause(planData: any): boolean {
  return Array.isArray(planData?.weeks)
    && planData.weeks.some((week: any) =>
      Array.isArray(week?.sessions)
      && week.sessions.some((session: any) =>
        session?.safetyPause === true
        // Legacy fallback: plans shaped before the structured flag existed
        // only carry the title/type/state triple. Trimmed to tolerate
        // whitespace drift in stored data.
        || (String(session?.sessionType || '').trim().toLowerCase() === 'rest'
          && String(session?.title || '').trim().toLowerCase() === 'safety pause'
          && String(session?.scheduleState || '').trim().toLowerCase() === 'deferred')
      )
    );
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

const TRAINING_PLAN_GENERATION_DAY_INDEX: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function buildGeneratedEnduranceSchedule(
  planData: Record<string, any>,
  startDate: string,
  now: Date,
  schedulingTimezone?: string | null,
): EnduranceKeyDay[] {
  const schedule: EnduranceKeyDay[] = [];
  const zone = resolveTrainingTimezone(schedulingTimezone);
  for (const week of Array.isArray(planData.weeks) ? planData.weeks : []) {
    const weekNumber = typeof week?.weekNumber === 'number' ? week.weekNumber : 1;
    for (const session of Array.isArray(week?.sessions) ? week.sessions : []) {
      const keyDay = enduranceKeyDayTypeForSession(session);
      if (!keyDay) continue;
      const dayIndex = TRAINING_PLAN_GENERATION_DAY_INDEX[String(session?.dayOfWeek || '').trim().toLowerCase()];
      if (dayIndex === undefined) continue;
      const slotDate = resolvePlanSlotDate({
        weekNumber,
        dayIndex,
        planStartDate: startDate,
        now,
        schedulingTimezone: zone,
      });
      if (slotDate.kind !== 'usable') continue;
      const date = DateTime.fromJSDate(slotDate.sessionDate, { zone }).toISODate();
      if (!date) continue;
      schedule.push({
        date,
        type: keyDay.type,
        priority: keyDay.priority,
      });
    }
  }
  return dedupeEnduranceSchedule(schedule);
}

function enduranceKeyDayTypeForSession(session: Record<string, any>): Pick<EnduranceKeyDay, 'type' | 'priority'> | null {
  const tokens = [
    session?.sessionType,
    session?.sessionRole,
    session?.title,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (/\b(long[_ -]?run|long run)\b/.test(tokens)) return { type: 'long_run', priority: 'protected' };
  if (/\brace\b/.test(tokens)) return { type: 'race', priority: 'protected' };
  if (/\b(interval|threshold)\b/.test(tokens)) return { type: 'intervals', priority: 'high' };
  if (/\btempo\b/.test(tokens)) return { type: 'tempo', priority: 'high' };
  if (/\b(long[_ -]?ride|ride|bike|cycling)\b/.test(tokens) && /\b(long|key)\b/.test(tokens)) {
    return { type: 'ride', priority: 'protected' };
  }
  if (/\bswim\b/.test(tokens) && /\b(long|key)\b/.test(tokens)) {
    return { type: 'swim', priority: 'high' };
  }
  return null;
}

function dedupeEnduranceSchedule(schedule: EnduranceKeyDay[]): EnduranceKeyDay[] {
  const seen = new Set<string>();
  const deduped: EnduranceKeyDay[] = [];
  for (const day of schedule) {
    const key = `${day.date}:${day.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(day);
  }
  return deduped;
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

function mergeEnduranceProfileForPlan(
  runProfile: Record<string, any> | null,
  cyclingProfile: Record<string, any> | null,
  swimProfile: Record<string, any> | null,
): Record<string, any> | null {
  const merged: Record<string, any> = { ...(runProfile ?? {}) };

  if (cyclingProfile) {
    assignProfileValueIfEmpty(merged, 'ftp_watts', cyclingProfile.ftp_watts);
    assignProfileValueIfEmpty(merged, 'cycling_ftp_watts', cyclingProfile.ftp_watts);
    assignProfileValueIfEmpty(merged, 'weekly_hours', cyclingProfile.weekly_hours);
    assignProfileValueIfEmpty(merged, 'cycling_weekly_hours', cyclingProfile.weekly_hours);
    assignProfileValueIfEmpty(merged, 'cycling_power_meter', cyclingProfile.power_meter);
    assignProfileValueIfEmpty(merged, 'cycling_primary_discipline', cyclingProfile.primary_discipline);
    assignProfileValueIfEmpty(merged, 'cycling_target_event', cyclingProfile.target_event);
    assignProfileValueIfEmpty(merged, 'cycling_weekly_availability_days', cyclingProfile.weekly_availability_days);
    mergeProfileScheduleValues(
      merged,
      'preferred_training_days',
      cyclingProfile.preferred_training_days,
      cyclingProfile.preferred_days,
      cyclingProfile.available_days,
    );
    mergeProfileScheduleValues(
      merged,
      'blocked_days',
      cyclingProfile.blocked_days,
      cyclingProfile.avoid_days,
      cyclingProfile.unavailable_days,
    );
  }

  if (swimProfile) {
    assignProfileValueIfEmpty(merged, 'swim_experience', swimProfile.experience);
    assignProfileValueIfEmpty(merged, 'swim_primary_stroke', swimProfile.primary_stroke);
    assignProfileValueIfEmpty(merged, 'pool_access', swimProfile.pool_access);
    assignProfileValueIfEmpty(merged, 'swim_pool_access', swimProfile.pool_access);
    assignProfileValueIfEmpty(merged, 'swim_sessions_per_week', swimProfile.sessions_per_week);
    assignProfileValueIfEmpty(merged, 'swim_400m_freestyle_time', swimProfile.time_400m_freestyle_min);
    mergeProfileScheduleValues(
      merged,
      'preferred_training_days',
      swimProfile.preferred_training_days,
      swimProfile.preferred_days,
      swimProfile.available_days,
    );
    mergeProfileScheduleValues(
      merged,
      'blocked_days',
      swimProfile.blocked_days,
      swimProfile.avoid_days,
      swimProfile.unavailable_days,
    );
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

function assignProfileValueIfEmpty(target: Record<string, any>, key: string, value: unknown): void {
  if (hasConcreteProfileValue(target[key]) || !hasConcreteProfileValue(value)) return;
  target[key] = value;
}

function mergeProfileScheduleValues(target: Record<string, any>, key: string, ...values: unknown[]): void {
  for (const value of values) {
    if (!hasConcreteProfileValue(value)) continue;
    const existing = profileScheduleValueList(target[key]);
    const incoming = profileScheduleValueList(value);
    if (incoming.length === 0) continue;
    const merged = [...existing];
    for (const dayText of incoming) {
      if (!merged.some((existingText) => existingText.toLowerCase() === dayText.toLowerCase())) {
        merged.push(dayText);
      }
    }
    target[key] = merged.length === 1 ? merged[0] : merged;
  }
}

function profileScheduleValueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(profileScheduleValueList);
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return hasConcreteProfileValue(value) ? [String(value)] : [];
}

function hasConcreteProfileValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
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

function resolvePlannerNow(raw: unknown): Date {
  if (raw == null || (!config.isStaging && process.env.NODE_ENV !== 'test')) return new Date();
  const parsed = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

export function resolveTrainingPlanStartDate(
  now: Date,
  startPolicy: TrainingPlanStartPolicy,
  schedulingTimezone?: string | null,
): string {
  const zone = resolveTrainingTimezone(schedulingTimezone);
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  if (!today.isValid) return now.toISOString().slice(0, 10);

  // Luxon weekday is 1=Monday ... 7=Sunday. A full training week begins
  // on Monday; when today is Monday, starting today is already a full week.
  const daysUntilMonday = (8 - today.weekday) % 7;
  if (startPolicy === 'today') {
    // A Sunday "today" request cannot produce an active week-1 schedule in
    // the Monday-start planner: every generated Mon-Sat slot is already in
    // the past and the linter correctly blocks the empty first week. Treat
    // Sunday as the next usable training-week anchor while preserving true
    // same-day starts for Monday-Saturday.
    const anchor = today.weekday === 7 ? today.plus({ days: daysUntilMonday || 1 }) : today;
    return anchor.toISODate() ?? today.toISODate() ?? now.toISOString().slice(0, 10);
  }
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
  schedulingTimezone?: string | null;
}): number {
  const { requestedDurationWeeks, startDateIso, raceDateIso } = params;
  if (!raceDateIso) return requestedDurationWeeks;
  const zone = resolveTrainingTimezone(params.schedulingTimezone);
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

function stripProfileRaceDates(
  profile: Record<string, any> | null | undefined,
): Record<string, any> | null {
  if (!profile) return null;
  const sanitized = { ...profile };
  delete sanitized.target_race_date;
  delete sanitized.targetRaceDate;
  delete sanitized.race_date;
  delete sanitized.raceDate;
  return sanitized;
}
