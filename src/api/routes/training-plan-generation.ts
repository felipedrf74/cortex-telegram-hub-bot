// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as onboarding from '../../services/onboarding';
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
import { getEvents } from '../../services/unified-calendar';
import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
} from '../../services/training-plan-coordination';
import { buildCoachKernelTrainingPlan } from '../../services/training-coach-kernel-plan-generator';
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
import { persistGeneratedTrainingPlan } from './training-plan-persistence';
import { cancelTrainingPlanForUser } from './training-plan-cancellation';
import { enforceRequestedTrainingPlanVolume } from '../../services/training-plan-volume-enforcement';
import * as trainingPlans from '../../services/training-plans';
import { findOrphanedOwnerships } from '../../services/training-plan-lifecycle';
import { reconcileOrphanedTrainingAgendaEvents } from '../../services/training-agenda-reconciliation';
import { logger } from '../../utils/logger';
import type { CalendarSource } from '../../services/unified-calendar';

export interface GenerateTrainingPlanForUserInput {
  userId: number;
  objective: string;
  durationWeeks?: number;
  preferredTime?: string;
  preferredCardioTime?: unknown;
  preferredStrengthTime?: unknown;
  sessionsPerWeek?: unknown;
  strengthSessionsPerWeek?: unknown;
  longWorkoutDay?: unknown;
  notes?: unknown;
  /**
   * Slice 2.B — explicit two-a-day preference. Routes to
   * `availability.maxSessionsPerDay` inside the kernel input. When
   * omitted the generator behaves exactly as before (volume-based
   * inference) — additive, fully backward-compatible.
   */
  twoADayPreference?: 'never' | 'optional' | 'preferred' | null;
  calendarSource?: CalendarSource | null;
}

export type TrainingPlanGenerationResult =
  | {
      status: 'needs_profile';
      data: Record<string, unknown>;
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
  | { kind: 'forbidden' }
  | { kind: 'local_delete_failed'; reason: string; activePlansRemaining: number };

async function runPrePersistCancellationSaga(userId: number): Promise<CancellationSagaOutcome> {
  try {
    const cancellation = await cancelTrainingPlanForUser(userId);
    if (cancellation.status === 'forbidden') {
      return { kind: 'forbidden' };
    }
    if (cancellation.status === 'not_found') {
      const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId);
      if (reconciliation.failed > 0) {
        return { kind: 'external_partial', orphanedEventCount: reconciliation.failed };
      }
      return { kind: 'no_active_plan' };
    }
    // Status is 'cancelled' — local hard-delete succeeded. The slice
    // 4.D ownership audit table tells us whether any external calendar
    // deletes failed (status='orphaned' rows). Those are reconcilable;
    // the saga can safely proceed.
    const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId);
    const orphans = findOrphanedOwnerships(userId, userId);
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
    const remainingPlans = trainingPlans.getActivePlans?.(userId) ?? [];
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
    const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId);
    return { kind: 'external_partial', orphanedEventCount: reconciliation.failed || -1 };
  }
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
    strengthSessionsPerWeek = 2,
    longWorkoutDay,
    notes,
    twoADayPreference,
    calendarSource,
  } = input;
  const durationWeeks = input.durationWeeks ?? 4;

  const fitnessProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'fitness'));
  const gymProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-gym'));
  const runProfile = unwrapOnboardingProfileData(onboarding.getProfile?.(userId, 'triathlon-running'));

  if (!fitnessProfile || Object.keys(fitnessProfile).length === 0) {
    return {
      status: 'needs_profile',
      data: {
        needsProfile: true,
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
  const endDate = new Date(now.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);
  const startStr = now.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

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
    const events = await getEvents(startStr, endStr, userId);
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

  const equipmentAdaptation = buildTrainingEquipmentAdaptation({
    fitnessProfile,
    gymProfile,
  });

  const normalizedSessionsPerWeek = clampNumber(sessionsPerWeek, 5, 3, 7);
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
    runProfile,
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
        sessionsPerWeek: normalizedSessionsPerWeek,
        strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
        preferredTime: normalizedPreferredTime,
        preferredCardioTime: normalizedPreferredCardioTime,
        preferredStrengthTime: normalizedPreferredStrengthTime,
        longWorkoutDay: normalizedLongWorkoutDay,
        notes: typeof notes === 'string' ? notes.trim() : null,
        fitnessProfile,
        gymProfile,
        runProfile,
        currentReadiness,
        twoADayPreference,
      }), coordination),
      equipmentAdaptation,
    );
  } catch (err) {
    logger.warn(
      { err, userId, objective },
      'Coach-kernel training plan generation unavailable — using deterministic fallback template',
    );
    planData = adaptTrainingPlanToAvailableEquipment(
      applyTrainingPlanCoordination(buildDeterministicTrainingPlan(objective, durationWeeks, {
        sessionsPerWeek: normalizedSessionsPerWeek,
        strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
        longWorkoutDay: normalizedLongWorkoutDay,
      }), coordination),
      equipmentAdaptation,
    );
    usedFallbackTemplate = true;
  }

  planData = adaptTrainingPlanToAvailableEquipment(
    enforceRequestedTrainingPlanVolume(planData, {
      sessionsPerWeek: normalizedSessionsPerWeek,
      strengthSessionsPerWeek: effectiveStrengthSessionsPerWeek,
      preferredCardioTime: normalizedPreferredCardioTime,
      preferredStrengthTime: normalizedPreferredStrengthTime,
      startDate: startStr,
    }),
    equipmentAdaptation,
  );

  // Slice 4.D.2 — saga for pre-persist cancellation. The previous
  // silent catch produced a double-plan state when the local
  // hard-delete failed; the new saga inspects post-cancellation
  // database state and aborts the persist when the old plan rows
  // are still present.
  const cancellationOutcome = await runPrePersistCancellationSaga(userId);

  switch (cancellationOutcome.kind) {
    case 'forbidden':
      logger.warn(
        { userId },
        'Existing active training plan was not user-owned during replacement; continuing with new plan creation',
      );
      break;
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
        },
      };
    case 'success':
    case 'no_active_plan':
      // Clean state — proceed.
      break;
  }

  // training-expert-coach-knowledge-engine (2026-05-03):
  // The persister now runs the deterministic plan-linter in advisor
  // mode. Pass through the fields the linter needs for accurate rules:
  //   • equipmentProfile — drives the equipment_compatibility rule.
  //   • raceDate         — drives the no_fake_taper_without_event rule
  //                        and the race_specific_plan_requires_race_date
  //                        rule.
  //   • isRaceSpecific   — derived from the objective; tells the linter
  //                        whether to treat missing race date as a
  //                        blocker.
  // All three are best-effort: when absent, the relevant rules no-op.
  const equipmentProfileLabel: string | undefined =
    typeof gymProfile?.equipment_access === 'string'
      ? String(gymProfile.equipment_access).toLowerCase().trim() || undefined
      : typeof fitnessProfile?.available_equipment === 'string'
        ? String(fitnessProfile.available_equipment).toLowerCase().trim() || undefined
        : undefined;
  const raceDateForLint: string | null =
    typeof runProfile?.target_race_date === 'string' && runProfile.target_race_date.trim()
      ? runProfile.target_race_date
      : null;
  const isRaceSpecificForLint =
    objectiveNeedsRunningProfile(objective) &&
    /\b(marathon|half\s*marathon|10k|5k|race|ironman|70\.3|trail)\b/i.test(objective);

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
      trainingCalendarSource: calendarSource || null,
    }),
    normalizedPreferredTime,
    normalizedPreferredCardioTime,
    normalizedPreferredStrengthTime,
    busyWindows,
    athleteProfiles: {
      fitnessProfile,
      gymProfile,
      runProfile,
    },
    calendarSource: calendarSource || undefined,
    equipmentProfile: equipmentProfileLabel,
    raceDate: raceDateForLint,
    isRaceSpecific: isRaceSpecificForLint,
  });

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
  const planWarnings: Array<{ code: string; message: string }> = [];
  if (calendarFetchDegraded) {
    planWarnings.push({
      code: 'calendar_fetch_degraded',
      message:
        'Could not read your calendar to detect conflicts. The plan was generated ' +
        'without conflict checks — please review the week before trusting it.',
    });
  }
  for (const blocker of lintResult.blockers) {
    planWarnings.push({ code: `lint_blocker_${blocker.ruleId}`, message: blocker.message });
  }
  for (const warning of lintResult.warnings) {
    planWarnings.push({ code: `lint_warning_${warning.ruleId}`, message: warning.message });
  }

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
      totalSessions: persistedPlan.totalSessions,
      eventsCreated: persistedPlan.eventsCreated,
      preferredCardioTime: normalizedPreferredCardioTime,
      preferredStrengthTime: normalizedPreferredStrengthTime,
      weeks: persistedPlan.weekSummaries,
      profileQuality: planData.profileQuality ?? null,
      decisionReasons: Array.isArray(planData.decisionReasons) ? planData.decisionReasons : [],
      fallbackTemplateUsed: usedFallbackTemplate,
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
  const resolved = Number(raw) || fallback;
  return Math.max(min, Math.min(max, resolved));
}
