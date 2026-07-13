// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  AthleteState,
  CoachingDiscipline,
  DayOfWeek,
  Exercise,
  SessionType,
} from './coach-kernel/types';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import {
  selectStrengthExercisesFromCatalog,
  type StrengthSelectorProfile,
} from './coach-kernel/strength-selector';
import {
  buildTrainingPhaseModel,
  phaseForWeek,
  repairTrainingPhaseModel,
  validateTrainingPhaseModel,
  type TrainingPhaseModelInput,
} from './training-phase-model';
import {
  TRAINING_MODALITY_WORKOUT_BUILDER_VERSION,
  buildCanonicalTrainingWorkout,
} from './training-modality-workout-builder';
import type {
  TrainingPlanCandidateRequest,
  TrainingPlanCausalFactor,
  TrainingPlanRevisionDocument,
  TrainingPlanRevisionQualityCheck,
} from './training-plan-revision-candidate-builder';
import {
  CANONICAL_TRAINING_SESSION_TYPES,
  resolveTrainingWorkoutCapability,
} from './training-workout-capability-registry';
import {
  validateTrainingTypedPlanDocument,
  type TrainingStrengthPrescription,
  type TrainingTypedPlanValidationDocument,
} from './training-typed-workout-v1';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export const TRAINING_TYPED_PLAN_GENERATOR_VERSION = 'training-typed-plan-generator.v1' as const;

export interface BuiltTrainingTypedPlanRevision {
  document: TrainingPlanRevisionDocument;
  causalFactors: TrainingPlanCausalFactor[];
  qualityChecks: TrainingPlanRevisionQualityCheck[];
  selectorPolicyVersion: typeof TRAINING_MODALITY_WORKOUT_BUILDER_VERSION;
}

const DAY_ORDER: DayOfWeek[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

export function buildTrainingTypedPlanRevision(
  request: TrainingPlanCandidateRequest & { horizonWeeks: number },
): BuiltTrainingTypedPlanRevision {
  const activeTypes = selectPlanSessionTypes(request);
  const exerciseLibrary = loadCoachKnowledge().exercises;
  const targetDistribution = distributionFor(activeTypes);
  const phaseInput: TrainingPhaseModelInput = {
    planMode: request.planMode,
    discipline: request.discipline,
    experienceLevel: request.profile.experienceLevel,
    sessionsPerWeek: request.profile.sessionsPerWeek,
    horizonWeeks: request.horizonWeeks,
    targetWorkoutTypeDistribution: targetDistribution,
  };
  const phases = buildTrainingPhaseModel(phaseInput);
  const weeks: TrainingPlanRevisionDocument['weeks'] = Array.from(
    { length: request.horizonWeeks },
    (_, index) => {
      const weekNumber = index + 1;
      const phase = phaseForWeek(phases, weekNumber);
      if (!phase) throw new Error('TRAINING_TYPED_PLAN_PHASE_BINDING_FAILED');
      const phaseSessionTypes = sessionTypesFromDistribution(
        phase.targetWorkoutTypeDistribution ?? targetDistribution,
      );
      const workouts = buildWeekWorkouts(
        request,
        phaseSessionTypes,
        weekNumber,
        phase.phaseKey,
        phase.phaseType,
        exerciseLibrary,
      );
      return {
        weekKey: `week-${weekNumber}`,
        weekNumber,
        phaseKey: phase.phaseKey,
        loadDirection: phase.recoveryOrLighterPeriod
          ? 'REDUCE'
          : weekNumber === 1 ? 'BASELINE' : 'INCREASE',
        workouts,
      };
    },
  );
  const document: TrainingPlanRevisionDocument = {
    schemaVersion: 'training-plan-revision.v2',
    planMode: request.planMode,
    goal: request.goal,
    discipline: request.discipline,
    periodization: 'PERIODIZED',
    profileSummary: {
      experienceLevel: request.profile.experienceLevel,
      sessionsPerWeek: request.profile.sessionsPerWeek,
    },
    ...(request.event ? { event: { ...request.event } } : {}),
    title: titleFor(request),
    horizonWeeks: request.horizonWeeks,
    weeklyStructure: {
      targetSessionsPerWeek: request.profile.sessionsPerWeek,
      sessionDurationMinutes: request.profile.sessionDurationMinutes,
      availableDays: [...request.profile.availableDays],
      targetWorkoutTypeDistribution: targetDistribution,
    },
    phases,
    progression: progressionFor(request),
    recovery: recoveryFor(request),
    weeks,
    assumptions: [
      'No health condition is inferred from profile, calendar or wearable context.',
      'Only explicit schedule, equipment, exclusions and plan-mode inputs are used.',
      'A generated candidate remains unapplied until Decision Center approval.',
    ],
    missingInputs: request.planMode === 'event_based' && !request.event?.date
      ? ['event.date']
      : [],
  };
  const qualityChecks = validateTrainingTypedPlanRevisionDocument(document);
  incrementTrainingGenerationCounter('typed_plan_candidate_generated_total');
  incrementTrainingGenerationCounter('typed_phase_generated_total', phases.length);
  incrementTrainingGenerationCounter(
    'typed_workout_generated_total',
    weeks.reduce((sum, week) => sum + week.workouts.length, 0),
  );
  return {
    document,
    causalFactors: causalFactorsFor(request, activeTypes),
    qualityChecks,
    selectorPolicyVersion: TRAINING_MODALITY_WORKOUT_BUILDER_VERSION,
  };
}

export function validateTrainingTypedPlanRevisionDocument(
  document: TrainingPlanRevisionDocument,
): TrainingPlanRevisionQualityCheck[] {
  const failures: string[] = [];
  if (document.schemaVersion !== 'training-plan-revision.v2'
      || document.periodization !== 'PERIODIZED'
      || !document.profileSummary) {
    failures.push('TYPED_REVISION_SCHEMA');
  }
  if (!Number.isSafeInteger(document.horizonWeeks)
      || document.weeks.length !== document.horizonWeeks
      || document.weeks.some((week, index) => week.weekNumber !== index + 1)) {
    failures.push('TYPED_REVISION_WEEK_HORIZON');
  }
  if (document.planMode === 'event_based') {
    if (!document.event?.name?.trim()
        || !document.event.date
        || Number.isNaN(Date.parse(`${document.event.date}T00:00:00.000Z`))) {
      failures.push('TYPED_REVISION_EVENT_CONTEXT_REQUIRED');
    }
  } else if (document.event != null) {
    failures.push('TYPED_REVISION_NON_EVENT_CONTEXT_FORBIDDEN');
  }
  if (document.weeks.some((week) => week.workouts.length !== 7)) {
    failures.push('TYPED_REVISION_SEVEN_DAY_PROJECTION');
  }

  const phaseInput = phaseInputFromDocument(document);
  let phaseChecks: TrainingPlanRevisionQualityCheck[] = [];
  try {
    phaseChecks = validateTrainingPhaseModel(phaseInput, document.phases);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'PHASE_MODEL_INVALID');
  }

  const canonicalTypes = new Set<string>(CANONICAL_TRAINING_SESSION_TYPES);
  for (const week of document.weeks) {
    const phase = phaseForWeek(document.phases, week.weekNumber);
    if (!phase || week.phaseKey !== phase.phaseKey) failures.push('TYPED_REVISION_WEEK_PHASE_BINDING');
    const counts = new Map<string, number>();
    for (const workout of week.workouts) {
      if (workout.isStandalone === true || workout.phaseKey !== week.phaseKey) {
        failures.push('TYPED_REVISION_WORKOUT_PHASE_BINDING');
      }
      if (!canonicalTypes.has(workout.sessionType)) failures.push('TYPED_REVISION_CANONICAL_GENERATION_ONLY');
      counts.set(workout.sessionType, (counts.get(workout.sessionType) ?? 0) + 1);
    }
    for (const target of phase?.targetWorkoutTypeDistribution ?? []) {
      if ((counts.get(target.sessionType) ?? 0) !== target.targetPerWeek) {
        failures.push('TYPED_REVISION_PHASE_DISTRIBUTION_MATCH');
      }
    }
  }

  let typedChecks: TrainingPlanRevisionQualityCheck[] = [];
  try {
    typedChecks = validateTrainingTypedPlanDocument(asTypedValidationDocument(document));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'TYPED_WORKOUT_VALIDATION_FAILED');
  }
  throwQualityFailures(failures);
  return [
    { code: 'TYPED_REVISION_SCHEMA', status: 'PASS', evidence: 'Validated immutable training-plan-revision.v2 snapshot' },
    ...phaseChecks,
    ...typedChecks,
    { code: 'TYPED_REVISION_PHASE_DISTRIBUTION_MATCH', status: 'PASS', evidence: 'Every week matches its phase workout-type distribution' },
    { code: 'TYPED_REVISION_CANONICAL_GENERATION_ONLY', status: 'PASS', evidence: 'Generated workouts use only the 21 canonical session types' },
  ];
}

/**
 * Repairs phase order/bindings only. It does not alter workouts, prescriptions,
 * schedule, profile or approval state. Reapplying the repair yields identical
 * bytes and therefore the same revision content hash.
 */
export function repairTrainingTypedPlanRevisionPhases(
  document: TrainingPlanRevisionDocument,
): TrainingPlanRevisionDocument {
  const phaseInput = phaseInputFromDocument(document);
  const phases = repairTrainingPhaseModel(phaseInput);
  incrementTrainingGenerationCounter('typed_quality_repair_total');
  return {
    ...document,
    phases,
    weeks: document.weeks.map((week) => {
      const phase = phaseForWeek(phases, week.weekNumber);
      if (!phase) throw new Error('TRAINING_TYPED_PLAN_PHASE_REPAIR_FAILED');
      const phaseKey = phase.phaseKey;
      return {
        ...week,
        phaseKey,
        workouts: week.workouts.map((workout) => ({
          ...workout,
          isStandalone: false,
          phaseKey,
        })),
      };
    }),
  };
}

function buildWeekWorkouts(
  request: TrainingPlanCandidateRequest & { horizonWeeks: number },
  activeTypes: readonly SessionType[],
  weekNumber: number,
  phaseKey: string,
  phaseType: TrainingPlanRevisionDocument['phases'][number]['phaseType'],
  exerciseLibrary: Exercise[],
): TrainingPlanRevisionDocument['weeks'][number]['workouts'] {
  const activeDays = request.profile.availableDays.slice(0, request.profile.sessionsPerWeek);
  const targetStrengthSessions = activeTypes.filter((sessionType) => sessionType.startsWith('strength_')).length;
  let strengthSessionIndex = 0;
  const active = activeDays.map((day, index) => {
    const sessionType = activeTypes[index];
    const workout = buildCanonicalTrainingWorkout({
      sessionType,
      workoutKey: `week-${weekNumber}-${day}-${sessionType}`,
      dayOfWeek: day,
      durationMinutes: durationFor(sessionType, request.profile.sessionDurationMinutes),
      phaseType,
      phaseKey,
    });
    if (!sessionType.startsWith('strength_')) return workout;
    const enhanced = addStrengthExercises({
      workout,
      request,
      sessionType: sessionType as Extract<SessionType, `strength_${string}`>,
      exerciseLibrary,
      weekIndex: weekNumber - 1,
      sessionIndex: strengthSessionIndex,
      targetStrengthSessions,
    });
    strengthSessionIndex += 1;
    return enhanced;
  });
  const rest = DAY_ORDER
    .filter((day) => !activeDays.includes(day))
    .map((day) => buildCanonicalTrainingWorkout({
      sessionType: 'rest',
      workoutKey: `week-${weekNumber}-${day}-rest`,
      dayOfWeek: day,
      durationMinutes: 0,
      phaseType,
      phaseKey,
    }));
  return [...active, ...rest]
    .sort((left, right) => DAY_ORDER.indexOf(left.dayOfWeek) - DAY_ORDER.indexOf(right.dayOfWeek));
}

function selectPlanSessionTypes(
  request: TrainingPlanCandidateRequest & { horizonWeeks: number },
): SessionType[] {
  const advancedStrength: SessionType[] = request.profile.experienceLevel === 'advanced'
    ? ['strength_max', 'strength_hypertrophy', 'strength_hypertrophy', 'strength_maintenance', 'mobility', 'strength_hypertrophy', 'mobility']
    : ['strength_hypertrophy', 'strength_maintenance', 'mobility', 'strength_hypertrophy', 'mobility', 'strength_maintenance', 'mobility'];
  const archetypes: Record<CoachingDiscipline, SessionType[]> = {
    running: ['easy_run', 'long_run', 'threshold_run', 'interval_run', 'recovery_run', 'strength_maintenance', 'mobility'],
    marathon: ['easy_run', 'long_run', 'threshold_run', 'recovery_run', 'strength_maintenance', 'mobility', 'interval_run'],
    cycling: ['endurance_ride', 'tempo_ride', 'threshold_ride', 'vo2_ride', 'recovery_ride', 'strength_maintenance', 'mobility'],
    swimming: ['technique_swim', 'aerobic_swim', 'threshold_swim', 'speed_swim', 'recovery_swim', 'strength_maintenance', 'mobility'],
    strength: advancedStrength,
    triathlon: ['technique_swim', 'endurance_ride', 'easy_run', 'brick', 'strength_maintenance', 'mobility', 'recovery_run'],
    hybrid: ['easy_run', 'strength_hypertrophy', 'threshold_run', 'strength_maintenance', 'mobility', 'endurance_ride', 'recovery_run'],
  };
  const selected = archetypes[request.discipline].slice(0, request.profile.sessionsPerWeek);
  if (selected.length !== request.profile.sessionsPerWeek) {
    throw new Error('TRAINING_TYPED_PLAN_ARCHETYPE_COVERAGE_FAILED');
  }
  return selected;
}

function addStrengthExercises(input: {
  workout: TrainingPlanRevisionDocument['weeks'][number]['workouts'][number];
  request: TrainingPlanCandidateRequest & { horizonWeeks: number };
  sessionType: Extract<SessionType, `strength_${string}`>;
  exerciseLibrary: Exercise[];
  weekIndex: number;
  sessionIndex: number;
  targetStrengthSessions: number;
}): TrainingPlanRevisionDocument['weeks'][number]['workouts'][number] {
  const targetCount = input.request.profile.sessionDurationMinutes >= 60 ? 5 : 3;
  const profile: StrengthSelectorProfile = input.sessionType === 'strength_max'
    ? 'max_strength'
    : input.sessionType === 'strength_maintenance' ? 'maintenance' : 'hypertrophy';
  const exclusions = new Set(input.request.profile.exclusions ?? []);
  const library = input.exerciseLibrary.filter((exercise) => !exclusions.has(exercise.id));
  const selected = selectStrengthExercisesFromCatalog({
    library,
    athlete: selectorAthlete(input.request.profile.experienceLevel),
    availableEquipment: new Set(input.request.profile.equipmentIds),
    profile,
    durationMinutes: input.request.profile.sessionDurationMinutes,
    targetCount,
    targetSessions: Math.max(1, input.targetStrengthSessions),
    sessionIndex: input.sessionIndex,
    weekIndex: input.weekIndex,
  });
  if (selected.variant.exerciseIds.length < Math.min(2, targetCount)) {
    throw new Error('TRAINING_TYPED_CATALOG_INSUFFICIENT_FOR_PROFILE');
  }
  const byId = new Map(library.map((exercise) => [exercise.id, exercise]));
  const primaryIndex = input.workout.blocks.findIndex((block) => block.blockType === 'PRIMARY_WORK');
  const primary = input.workout.blocks[primaryIndex];
  if (!primary || primary.prescription.kind !== 'strength') {
    throw new Error('TRAINING_TYPED_STRENGTH_PRIMARY_REQUIRED');
  }
  const strengthPrescription: TrainingStrengthPrescription = primary.prescription;
  const exercises = selected.variant.exerciseIds.map((exerciseId) => ({
    exerciseId,
    name: byId.get(exerciseId)?.name ?? exerciseId,
    prescription: { ...strengthPrescription },
    selectionReasons: selected.selectionReasons.get(exerciseId)?.pickedBecause
      ?? ['fits the requested movement role and available equipment'],
  }));
  const blocks = input.workout.blocks.map((block, index) => index === primaryIndex
    ? { ...block, exercises }
    : block);
  return { ...input.workout, title: selected.variant.title, blocks };
}

function selectorAthlete(experienceLevel: TrainingPlanCandidateRequest['profile']['experienceLevel']): AthleteState {
  return {
    profile: {
      athleteId: 1,
      name: 'Typed revision candidate profile',
      experienceLevel,
      primaryDiscipline: 'strength',
    },
    readiness: { painFlags: [] },
  } as unknown as AthleteState;
}

function distributionFor(activeTypes: readonly SessionType[]): Array<{
  sessionType: SessionType;
  targetPerWeek: number;
}> {
  const counts = new Map<SessionType, number>();
  for (const sessionType of activeTypes) counts.set(sessionType, (counts.get(sessionType) ?? 0) + 1);
  counts.set('rest', 7 - activeTypes.length);
  return [...counts.entries()]
    .map(([sessionType, targetPerWeek]) => ({ sessionType, targetPerWeek }))
    .sort((left, right) => CANONICAL_TRAINING_SESSION_TYPES.indexOf(left.sessionType)
      - CANONICAL_TRAINING_SESSION_TYPES.indexOf(right.sessionType));
}

function sessionTypesFromDistribution(
  distribution: readonly { sessionType: SessionType; targetPerWeek: number }[],
): SessionType[] {
  return distribution.flatMap((target) => target.sessionType === 'rest'
    ? []
    : Array.from({ length: target.targetPerWeek }, () => target.sessionType));
}

function phaseInputFromDocument(document: TrainingPlanRevisionDocument): TrainingPhaseModelInput {
  if (!document.profileSummary) throw new Error('TRAINING_TYPED_REVISION_PROFILE_SUMMARY_REQUIRED');
  return {
    planMode: document.planMode,
    discipline: document.discipline,
    experienceLevel: document.profileSummary.experienceLevel,
    sessionsPerWeek: document.profileSummary.sessionsPerWeek,
    horizonWeeks: document.horizonWeeks,
    targetWorkoutTypeDistribution: document.weeklyStructure.targetWorkoutTypeDistribution,
  };
}

function asTypedValidationDocument(document: TrainingPlanRevisionDocument): TrainingTypedPlanValidationDocument {
  return {
    sourceDocumentSchemaVersion: document.schemaVersion,
    periodization: document.periodization ?? 'PERIODIZED',
    horizonWeeks: document.horizonWeeks,
    phases: document.phases,
    weeks: document.weeks.map((week) => ({
      weekNumber: week.weekNumber,
      phaseKey: week.phaseKey,
      workouts: week.workouts.map((workout) => ({
        ...workout,
        sessionTypeClassification: resolveTrainingWorkoutCapability(workout.sessionType).canonical
          ? 'CANONICAL' as const
          : 'UNKNOWN' as const,
        isStandalone: workout.isStandalone ?? false,
        phaseKey: workout.phaseKey ?? week.phaseKey,
      })),
    })),
  };
}

function causalFactorsFor(
  request: TrainingPlanCandidateRequest & { horizonWeeks: number },
  sessionTypes: readonly SessionType[],
): TrainingPlanCausalFactor[] {
  return [
    {
      inputKey: 'planMode',
      inputValue: request.planMode,
      materialEffects: ['Phase sequence', 'recovery or taper placement', 'transition rules'],
    },
    {
      inputKey: 'discipline',
      inputValue: request.discipline,
      materialEffects: [`Workout selection: ${sessionTypes.join(', ')}`, 'modality prescription families'],
    },
    ...(request.event?.date ? [{
      inputKey: 'event.date',
      inputValue: request.event.date,
      materialEffects: ['Event-based phase archetype', 'peak/taper/race transition sequence'],
    }] : []),
    {
      inputKey: 'profile.experienceLevel',
      inputValue: request.profile.experienceLevel,
      materialEffects: ['Phase sizing', 'progression direction', 'strength complexity and intensity'],
    },
    {
      inputKey: 'profile.sessionsPerWeek',
      inputValue: request.profile.sessionsPerWeek,
      materialEffects: ['Weekly frequency', 'target workout-type distribution', 'rest-day count'],
    },
    {
      inputKey: 'profile.sessionDurationMinutes',
      inputValue: request.profile.sessionDurationMinutes,
      materialEffects: ['Workout duration', 'block duration', 'prescription volume'],
    },
    {
      inputKey: 'profile.availableDays',
      inputValue: request.profile.availableDays,
      materialEffects: ['Day assignment', 'recovery placement'],
    },
    {
      inputKey: 'profile.equipmentIds',
      inputValue: request.profile.equipmentIds,
      materialEffects: ['Future exercise eligibility', 'honest equipment context'],
    },
    ...(request.profile.exclusions?.length ? [{
      inputKey: 'profile.exclusions',
      inputValue: request.profile.exclusions.length,
      materialEffects: [`${request.profile.exclusions.length} exercise exclusion(s) preserved for exercise selection`],
    }] : []),
  ];
}

function titleFor(request: TrainingPlanCandidateRequest): string {
  if (request.planMode === 'event_based') {
    return request.event?.name?.trim() || `${capitalize(request.discipline)} Event Plan`;
  }
  if (request.planMode === 'return_to_training') return `Return to ${capitalize(request.discipline)}`;
  if (request.planMode === 'maintenance') return `${capitalize(request.discipline)} Maintenance`;
  return `${capitalize(request.discipline)} Development Plan`;
}

function progressionFor(request: TrainingPlanCandidateRequest): TrainingPlanRevisionDocument['progression'] {
  if (request.planMode === 'return_to_training') {
    return {
      direction: 'Re-establish frequency and technique before volume or intensity',
      rule: 'Progress one bounded exposure only after the prior week is completed without a new explicit limitation.',
    };
  }
  if (request.profile.experienceLevel === 'novice') {
    return {
      direction: 'Consistency and technique, then gradual duration or repetition volume',
      rule: 'Preserve modality and skill complexity while progressing one bounded variable.',
    };
  }
  return {
    direction: request.planMode === 'event_based'
      ? 'General capacity toward event specificity, then fatigue reduction'
      : 'Bounded volume and intensity progression with planned recovery',
    rule: 'Change one primary progression variable per build week and retain the approved workout roles.',
  };
}

function recoveryFor(request: TrainingPlanCandidateRequest): TrainingPlanRevisionDocument['recovery'] {
  return {
    strategy: request.planMode === 'event_based'
      ? 'Rest days plus an explicit taper and race-week load reduction'
      : request.planMode === 'maintenance'
        ? 'Minimum effective training separated by an explicit recovery period'
        : 'Rest days plus a closing deload or recovery period',
    placement: `${7 - request.profile.sessionsPerWeek} rest day(s) per week; lighter phase placement is encoded in the immutable phase sequence.`,
  };
}

function durationFor(sessionType: SessionType, requested: number): number {
  if (sessionType === 'mobility') return Math.min(requested, 30);
  if (sessionType === 'long_run') return Math.max(requested, Math.min(180, Math.round(requested * 1.5)));
  return requested;
}

function capitalize(value: string): string {
  return value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function throwQualityFailures(failures: string[]): void {
  if (failures.length === 0) return;
  incrementTrainingGenerationCounter('typed_quality_blocked_total');
  throw new Error(`TRAINING_TYPED_REVISION_QUALITY_FAILED:${[...new Set(failures)].sort().join(',')}`);
}
