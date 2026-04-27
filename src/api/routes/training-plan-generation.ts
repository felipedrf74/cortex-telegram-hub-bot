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
import { logger } from '../../utils/logger';

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
    };

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
  } = input;
  const durationWeeks = input.durationWeeks ?? 4;

  const fitnessProfile = onboarding.getProfile?.(userId, 'fitness');
  const gymProfile = onboarding.getProfile?.(userId, 'triathlon-gym');
  const runProfile = onboarding.getProfile?.(userId, 'triathlon-running');

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

  let busyWindows: BusyWindow[] = [];
  try {
    const events = await getEvents(startStr, endStr, userId);
    busyWindows = buildBusyWindows(events || []);
  } catch {
    // Calendar unavailable — plan without schedule constraints.
  }

  const equipmentAdaptation = buildTrainingEquipmentAdaptation({
    fitnessProfile,
    gymProfile,
  });

  const normalizedSessionsPerWeek = clampNumber(sessionsPerWeek, 5, 3, 7);
  const normalizedStrengthSessionsPerWeek = clampNumber(strengthSessionsPerWeek, 0, 0, 4);
  const gymOnlyObjective = objectiveNeedsGymProfile(objective) && !objectiveNeedsRunningProfile(objective);
  const effectiveStrengthSessionsPerWeek = normalizedStrengthSessionsPerWeek > 0
    ? normalizedStrengthSessionsPerWeek
    : gymOnlyObjective
      ? Math.min(normalizedSessionsPerWeek, 4)
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

  try {
    const cancellation = await cancelTrainingPlanForUser(userId);
    if (cancellation.status === 'forbidden') {
      logger.warn({ userId }, 'Existing active training plan was not user-owned during replacement; continuing with new plan creation');
    }
  } catch (err) {
    // Replacing a plan should be best-effort: if old calendar cleanup
    // has a transient provider problem, the new plan still needs to be
    // created. The cancellation route always hard-deletes local plan
    // rows when it can, and logs provider misses internally.
    logger.warn({ err, userId }, 'Existing active training plan cleanup failed before new plan persistence');
  }

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
    athleteProfiles: {
      fitnessProfile,
      gymProfile,
      runProfile,
    },
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
      totalSessions: persistedPlan.totalSessions,
      eventsCreated: persistedPlan.eventsCreated,
      preferredCardioTime: normalizedPreferredCardioTime,
      preferredStrengthTime: normalizedPreferredStrengthTime,
      weeks: persistedPlan.weekSummaries,
      fallbackTemplateUsed: usedFallbackTemplate,
      message: usedFallbackTemplate
        ? `Plan created with a reliable fallback template. ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`
        : `Plan created! ${persistedPlan.totalSessions} sessions scheduled across ${durationWeeks} weeks. ${persistedPlan.eventsCreated} calendar events created.`,
    },
  };
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const resolved = Number(raw) || fallback;
  return Math.max(min, Math.min(max, resolved));
}
