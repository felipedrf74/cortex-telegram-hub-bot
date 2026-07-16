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
import {
  TRAINING_M4_PLAN_STRATEGY_VERSION,
  dayOfWeekForIsoDate,
  eventSessionTypeForDiscipline,
  isoDateForWeekDay,
  selectTrainingM4CapacityWindow,
  selectTrainingM4SessionTypes,
  trainingM4ScheduledWindow,
  trainingM4ConflictSetHashForDocument,
  validateTrainingM4InitialScheduleFreshness,
  validateTrainingM4WorkoutCapacity,
} from './training-m4-plan-strategies';

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
  options: { m4StrategyEnabled?: boolean; referenceTime?: Date } = {},
): BuiltTrainingTypedPlanRevision {
  const m4Enabled = options.m4StrategyEnabled === true;
  const activeTypes = m4Enabled
    ? selectTrainingM4SessionTypes({
      planMode: request.planMode,
      discipline: request.discipline,
      sessionsPerWeek: request.profile.sessionsPerWeek,
      goalPriority: request.goalPriority,
    })
    : selectPlanSessionTypes(request);
  const exerciseLibrary = loadCoachKnowledge().exercises;
  const targetDistribution = distributionFor(activeTypes);
  const phaseInput: TrainingPhaseModelInput = {
    planMode: request.planMode,
    discipline: request.discipline,
    experienceLevel: request.profile.experienceLevel,
    sessionsPerWeek: request.profile.sessionsPerWeek,
    horizonWeeks: request.horizonWeeks,
    targetWorkoutTypeDistribution: targetDistribution,
    ...(m4Enabled && request.planMode === 'event_based' && request.event?.date
      ? {
        eventSessionType: eventSessionTypeForDiscipline(request.discipline),
        eventDayIndex: eventDayIndex(request),
      }
      : {}),
  };
  const phases = buildTrainingPhaseModel(phaseInput);
  const weeks: TrainingPlanRevisionDocument['weeks'] = Array.from(
    { length: request.horizonWeeks },
    (_, index) => {
      const weekNumber = index + 1;
      const phase = phaseForWeek(phases, weekNumber);
      if (!phase) throw new Error('TRAINING_TYPED_PLAN_PHASE_BINDING_FAILED');
      let phaseSessionTypes = sessionTypesFromDistribution(
        phase.targetWorkoutTypeDistribution ?? targetDistribution,
      );
      if (m4Enabled && phase.phaseType === 'RACE' && request.planMode === 'event_based') {
        phaseSessionTypes = placeEventSessionAtIndex(
          phaseSessionTypes,
          eventSessionTypeForDiscipline(request.discipline),
          eventDayIndex(request),
        );
      }
      const workouts = buildWeekWorkouts(
        request,
        phaseSessionTypes,
        weekNumber,
        phase.phaseKey,
        phase.phaseType,
        exerciseLibrary,
        m4Enabled,
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
    ...(m4Enabled && request.planStartDate ? { planStartDate: request.planStartDate } : {}),
    periodization: 'PERIODIZED',
    profileSummary: {
      experienceLevel: request.profile.experienceLevel,
      sessionsPerWeek: request.profile.sessionsPerWeek,
    },
    ...(request.event ? { event: { ...request.event } } : {}),
    ...(m4Enabled && request.resourceAccess ? { resourceAccess: { ...request.resourceAccess } } : {}),
    ...(m4Enabled && request.capacity?.contextVersion ? {
      capacityContextVersion: request.capacity.contextVersion,
      capacityContext: {
        source: request.capacity.source,
        contextVersion: request.capacity.contextVersion,
        provisional: request.capacity.source === 'EXPLICIT_USER',
        calendarConflictCoverage: request.capacity.source === 'AUTHORITATIVE'
          ? 'AUTHORITATIVE' as const
          : 'UNAVAILABLE' as const,
      },
    } : {}),
    ...(m4Enabled && request.goalPriority ? {
      goalPriority: {
        primaryDiscipline: request.goalPriority.primaryDiscipline,
        secondaryDisciplines: [...request.goalPriority.secondaryDisciplines],
      },
    } : {}),
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
  if (m4Enabled && request.capacity) {
    validateTrainingM4WorkoutCapacity(
      request.discipline,
      request.capacity.windows,
      weeks.flatMap((week) => week.workouts),
    );
  }
  if (m4Enabled) {
    document.m4 = {
      strategyVersion: TRAINING_M4_PLAN_STRATEGY_VERSION,
      conflictSetHash: trainingM4ConflictSetHashForDocument(document),
      validationScope: 'PLAN_CANDIDATE',
      ...(request.planMode === 'event_based' && request.event?.priority
        ? { eventPriorityTreatment: 'REVIEW_ONLY_NO_AUTOMATIC_LOAD_CHANGE' as const }
        : {}),
    };
    validateTrainingM4InitialScheduleFreshness(document, options.referenceTime ?? new Date());
  }
  const qualityChecks = [
    ...validateTrainingTypedPlanRevisionDocument(document),
    ...(m4Enabled ? validateTrainingM4PlanRevisionDocument(document) : []),
  ];
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
  m4Enabled = false,
): TrainingPlanRevisionDocument['weeks'][number]['workouts'] {
  const activeDays = request.profile.availableDays.slice(0, m4Enabled ? activeTypes.length : request.profile.sessionsPerWeek);
  const targetStrengthSessions = activeTypes.filter((sessionType) => sessionType.startsWith('strength_')).length;
  let strengthSessionIndex = 0;
  const active = activeDays.map((day, index) => {
    const isEventWorkout = m4Enabled
      && request.planMode === 'event_based'
      && weekNumber === request.horizonWeeks
      && request.event?.date
      && day === dayOfWeekForIsoDate(request.event.date);
    const sessionType = isEventWorkout ? eventSessionTypeForDiscipline(request.discipline) : activeTypes[index];
    const workout = buildCanonicalTrainingWorkout({
      sessionType,
      workoutKey: `week-${weekNumber}-${day}-${sessionType}`,
      dayOfWeek: day,
      durationMinutes: durationFor(
        sessionType,
        request.profile.sessionDurationMinutes,
        m4Enabled,
      ),
      phaseType,
      phaseKey,
    });
    const scheduledDate = m4Enabled && request.planStartDate
      ? isEventWorkout && request.event?.date
        ? request.event.date
        : isoDateForWeekDay(request.planStartDate, weekNumber, day)
      : null;
    const capacityWindow = m4Enabled && request.capacity
      ? selectTrainingM4CapacityWindow(
        request.discipline, request.capacity.windows, workout, scheduledDate ?? undefined,
      )
      : null;
    if (m4Enabled && !capacityWindow) {
      throw new Error(`TRAINING_M4_SCHEDULE_CAPACITY_CONFLICT:${day}:${sessionType}`);
    }
    const scheduledWindow = scheduledDate && capacityWindow
      ? trainingM4ScheduledWindow(scheduledDate, capacityWindow, workout.plannedDurationMinutes)
      : null;
    const datedWorkout = {
      ...workout,
      ...(scheduledDate ? { scheduledDate } : {}),
      ...(scheduledWindow ?? {}),
      ...(isEventWorkout ? { eventRole: 'EVENT' as const } : {}),
    };
    const eventWorkout = isEventWorkout && request.discipline === 'triathlon'
      ? makeTriathlonRaceBrick(datedWorkout)
      : datedWorkout;
    if (!sessionType.startsWith('strength_')) return eventWorkout;
    const enhanced = addStrengthExercises({
      workout: eventWorkout,
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
    .map((day) => ({
      ...buildCanonicalTrainingWorkout({
        sessionType: 'rest',
        workoutKey: `week-${weekNumber}-${day}-rest`,
        dayOfWeek: day,
        durationMinutes: 0,
        phaseType,
        phaseKey,
      }),
      ...(m4Enabled && request.planStartDate
        ? { scheduledDate: isoDateForWeekDay(request.planStartDate, weekNumber, day) }
        : {}),
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

function placeEventSessionAtIndex(
  sessionTypes: SessionType[],
  eventSessionType: SessionType,
  index: number,
): SessionType[] {
  const ordered = [...sessionTypes];
  const existing = ordered.indexOf(eventSessionType);
  if (existing < 0) throw new Error('TRAINING_M4_EVENT_SESSION_DISTRIBUTION_MISSING');
  ordered.splice(existing, 1);
  ordered.splice(index, 0, eventSessionType);
  return ordered;
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
    ...(document.m4 && document.planMode === 'event_based' && document.event?.date
      ? {
        eventSessionType: eventSessionTypeForDiscipline(document.discipline),
        eventDayIndex: document.weeklyStructure.availableDays.indexOf(dayOfWeekForIsoDate(document.event.date)),
      }
      : {}),
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
    ...(request.resourceAccess ? [{
      inputKey: 'resourceAccess',
      inputValue: Object.entries(request.resourceAccess).filter(([, enabled]) => enabled).map(([key]) => key),
      materialEffects: ['Modality eligibility', 'resource-conflict validation'],
    }] : []),
    ...(request.capacity ? [{
      inputKey: 'capacity.contextVersion',
      inputValue: request.capacity.contextVersion ?? request.capacity.source,
      materialEffects: request.capacity.source === 'AUTHORITATIVE'
        ? ['Scheduled-day eligibility', 'Decision precondition freshness', 'authoritative calendar conflict coverage']
        : ['Scheduled-day eligibility', 'provisional user-reviewed availability', 'calendar conflict coverage unavailable'],
    }] : []),
    ...(request.goalPriority ? [{
      inputKey: 'goalPriority.primaryDiscipline',
      inputValue: request.goalPriority.primaryDiscipline,
      materialEffects: ['Primary key-session selection', 'hybrid interference constraints'],
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

function durationFor(sessionType: SessionType, requested: number, boundedByReviewedCapacity: boolean): number {
  if (sessionType === 'mobility') return Math.min(requested, 30);
  // M4 capacity is reviewed against the explicit session-duration input. A
  // hidden long-run multiplier would make a verified window insufficient only
  // after candidate submission. Future variable-duration plans must expose
  // that larger duration during input review instead of expanding it here.
  if (boundedByReviewedCapacity) return requested;
  if (sessionType === 'long_run') return Math.max(requested, Math.min(180, Math.round(requested * 1.5)));
  return requested;
}

function eventDayIndex(request: TrainingPlanCandidateRequest): number {
  if (!request.event?.date) throw new Error('TRAINING_M4_EVENT_DATE_REQUIRED');
  const index = request.profile.availableDays.indexOf(dayOfWeekForIsoDate(request.event.date));
  if (index < 0 || index >= request.profile.sessionsPerWeek) {
    throw new Error('TRAINING_M4_EVENT_DAY_UNAVAILABLE');
  }
  return index;
}

function makeTriathlonRaceBrick(
  workout: TrainingPlanRevisionDocument['weeks'][number]['workouts'][number],
): TrainingPlanRevisionDocument['weeks'][number]['workouts'][number] {
  const primaryIndex = workout.blocks.findIndex((block) => block.blockType === 'PRIMARY_WORK');
  const primary = workout.blocks[primaryIndex];
  if (!primary) throw new Error('TRAINING_M4_TRIATHLON_EVENT_PRIMARY_REQUIRED');
  const segmentMinutes = Math.max(5, Math.floor(primary.plannedDurationMinutes / 3));
  const blocks = workout.blocks.map((block, index) => index === primaryIndex
    ? {
      ...block,
      objectiveId: 'primary.triathlon_event',
      purpose: 'Execute the reviewed swim, cycling and running event sequence in order.',
      prescription: {
        kind: 'mixed_session' as const,
        segments: [
          {
            position: 1,
            modality: 'SWIMMING' as const,
            transitionAfterSeconds: 180,
            prescription: {
              kind: 'swimming' as const,
              totalDistanceMeters: Math.max(400, segmentMinutes * 30),
              stroke: 'Freestyle',
              repetitions: 1,
              restSeconds: 0,
              targetIntensity: 'Reviewed event effort',
            },
          },
          {
            position: 2,
            modality: 'CYCLING' as const,
            transitionAfterSeconds: 180,
            prescription: {
              kind: 'cycling' as const,
              durationMinutes: segmentMinutes,
              effortZone: 'Reviewed event effort',
              cadenceRpm: 88,
            },
          },
          {
            position: 3,
            modality: 'RUNNING' as const,
            transitionAfterSeconds: 0,
            prescription: {
              kind: 'steady_endurance' as const,
              durationMinutes: segmentMinutes,
              paceGuidance: 'Reviewed event pace',
              effortZone: 'Reviewed event effort',
            },
          },
        ],
      },
    }
    : block);
  return {
    ...workout,
    title: 'Triathlon event',
    objective: 'Complete the reviewed swim-to-bike-to-run event objective.',
    blocks,
  };
}

export function validateTrainingM4PlanRevisionDocument(
  document: TrainingPlanRevisionDocument,
): TrainingPlanRevisionQualityCheck[] {
  const failures: string[] = [];
  if (!document.m4
      || document.m4.strategyVersion !== TRAINING_M4_PLAN_STRATEGY_VERSION
      || !/^[a-f0-9]{64}$/.test(document.m4.conflictSetHash)
      || document.m4.conflictSetHash !== trainingM4ConflictSetHashForDocument(document)) {
    failures.push('TRAINING_M4_STRATEGY_AND_CONFLICT_IDENTITY');
  }
  if (!document.capacityContext
      || document.capacityContext.contextVersion !== document.capacityContextVersion
      || (document.capacityContext.source === 'AUTHORITATIVE'
        ? document.capacityContext.provisional || document.capacityContext.calendarConflictCoverage !== 'AUTHORITATIVE'
        : !document.capacityContext.provisional || document.capacityContext.calendarConflictCoverage !== 'UNAVAILABLE')) {
    failures.push('TRAINING_M4_CAPACITY_AUTHORITY_CLASSIFICATION');
  }
  const activeWorkouts = document.weeks.flatMap((week) => week.workouts.filter((workout) => workout.sessionType !== 'rest'));
  if (activeWorkouts.some((workout) => !workout.scheduledDate)) {
    failures.push('TRAINING_M4_SCHEDULE_DATES_REQUIRED');
  }
  if (activeWorkouts.some((workout) => !workout.scheduledStartAt
      || !workout.scheduledEndAt
      || !workout.scheduleTimeZone
      || !Number.isFinite(Date.parse(workout.scheduledStartAt))
      || !Number.isFinite(Date.parse(workout.scheduledEndAt))
      || Date.parse(workout.scheduledEndAt) <= Date.parse(workout.scheduledStartAt)
      || Date.parse(workout.scheduledEndAt) - Date.parse(workout.scheduledStartAt)
        !== workout.plannedDurationMinutes * 60_000)) {
    failures.push('TRAINING_M4_SCHEDULE_WINDOWS_REQUIRED');
  }
  if (document.planMode === 'event_based') {
    const event = document.event;
    const m4 = document.m4;
    const eventWorkouts = activeWorkouts.filter((workout) => workout.eventRole === 'EVENT');
    const race = document.phases.at(-1);
    const taper = document.phases.at(-2);
    if (!document.planStartDate || !event?.date
        || eventWorkouts.length !== 1
        || eventWorkouts[0].scheduledDate !== event.date
        || eventWorkouts[0].sessionType !== eventSessionTypeForDiscipline(document.discipline)
        || race?.phaseType !== 'RACE'
        || race.startWeek !== document.horizonWeeks
        || taper?.phaseType !== 'TAPER'
        || taper.endWeek !== race.startWeek - 1
        || activeWorkouts.some((workout) => workout.scheduledDate! > (event?.date ?? ''))) {
      failures.push('TRAINING_M4_EVENT_TAPER_RACE_INVARIANTS');
    }
    if (event?.priority
        && m4?.eventPriorityTreatment !== 'REVIEW_ONLY_NO_AUTOMATIC_LOAD_CHANGE') {
      failures.push('TRAINING_M4_EVENT_PRIORITY_REVIEW_ONLY');
    }
    if (document.discipline === 'triathlon') {
      const primary = eventWorkouts[0]?.blocks.find((block) => block.blockType === 'PRIMARY_WORK');
      const modalities = primary?.prescription.kind === 'mixed_session'
        ? primary.prescription.segments.map((segment) => segment.modality)
        : [];
      if (modalities.join('>') !== 'SWIMMING>CYCLING>RUNNING') {
        failures.push('TRAINING_M4_TRIATHLON_EVENT_ORDER');
      }
    }
  }
  const datedActiveWorkouts = activeWorkouts
    .filter((workout): workout is typeof workout & { scheduledDate: string } => Boolean(workout.scheduledDate))
    .sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate));
  for (let index = 1; index < datedActiveWorkouts.length; index += 1) {
    const previous = datedActiveWorkouts[index - 1];
    const current = datedActiveWorkouts[index];
    const dayGap = Math.round((Date.parse(`${current.scheduledDate}T00:00:00.000Z`)
      - Date.parse(`${previous.scheduledDate}T00:00:00.000Z`)) / 86_400_000);
    if (dayGap > 1) continue;
    if (isHeavyStrength(previous.sessionType) && isHardEndurance(current.sessionType)) {
      failures.push('TRAINING_M4_HYBRID_INTERFERENCE');
    }
    if (isHardEndurance(previous.sessionType) && isHeavyStrength(current.sessionType)) {
      failures.push('TRAINING_M4_HYBRID_INTERFERENCE');
    }
    if (isHardEndurance(previous.sessionType) && isHardEndurance(current.sessionType)) {
      failures.push('TRAINING_M4_HARD_DAY_RECOVERY_SPACING');
    }
  }
  if (failures.length) {
    throw new Error(`TRAINING_M4_PLAN_VALIDATION_FAILED:${[...new Set(failures)].sort().join(',')}`);
  }
  return [
    { code: 'TRAINING_M4_STRATEGY_AND_CONFLICT_IDENTITY', status: 'PASS', evidence: 'Deterministic M4 strategy and immutable conflict-set identity are present' },
    { code: 'TRAINING_M4_RESOURCE_GOAL_CAPACITY', status: 'PASS', evidence: 'Explicit resources, ordered goals and capacity context were validated before composition' },
    {
      code: 'TRAINING_M4_CAPACITY_AUTHORITY_CLASSIFICATION',
      status: 'PASS',
      evidence: document.capacityContext?.source === 'AUTHORITATIVE'
        ? 'Server-provided authoritative capacity is version-bound and revalidated'
        : 'Explicit user-entered availability is immutable and provisional; calendar conflict coverage is unavailable',
    },
    { code: 'TRAINING_M4_RECOVERY_AND_INTERFERENCE', status: 'PASS', evidence: 'Hard endurance and heavy-strength adjacency constraints passed' },
    ...(document.planMode === 'event_based' ? [
      { code: 'TRAINING_M4_EVENT_TAPER_RACE_INVARIANTS', status: 'PASS' as const, evidence: 'Event date, final race phase, preceding taper and exact event workout agree' },
      { code: 'TRAINING_M4_EVENT_PRIORITY_REVIEW_ONLY', status: 'PASS' as const, evidence: 'A/B/C priority is review metadata and cannot silently change training load' },
    ] : []),
  ];
}

function isHardEndurance(sessionType: string): boolean {
  return ['threshold_run', 'interval_run', 'long_run', 'tempo_ride', 'threshold_ride', 'vo2_ride', 'threshold_swim', 'speed_swim', 'brick'].includes(sessionType);
}

function isHeavyStrength(sessionType: string): boolean {
  return sessionType === 'strength_max' || sessionType === 'strength_hypertrophy';
}

function capitalize(value: string): string {
  return value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function throwQualityFailures(failures: string[]): void {
  if (failures.length === 0) return;
  incrementTrainingGenerationCounter('typed_quality_blocked_total');
  throw new Error(`TRAINING_TYPED_REVISION_QUALITY_FAILED:${[...new Set(failures)].sort().join(',')}`);
}
