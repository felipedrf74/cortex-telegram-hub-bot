// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DayOfWeek, SessionType } from './coach-kernel/types';
import {
  CANONICAL_TRAINING_SESSION_TYPES,
  resolveTrainingWorkoutCapability,
} from './training-workout-capability-registry';

export const TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION = 'training-typed-workout-validator.v1' as const;

export type TrainingTypedPhaseType =
  | 'FOUNDATION'
  | 'BASE'
  | 'BUILD'
  | 'PEAK'
  | 'TAPER'
  | 'RACE'
  | 'DELOAD'
  | 'RECOVERY'
  | 'MAINTENANCE';

export type TrainingTypedWorkoutBlockPriority = 'ESSENTIAL' | 'RECOMMENDED' | 'OPTIONAL';

export type TrainingTypedWorkoutBlockType =
  | 'PREPARATION'
  | 'PRIMARY_WORK'
  | 'SECONDARY_WORK'
  | 'CONDITIONING_MODALITY'
  | 'COOLDOWN_RECOVERY';

export interface TrainingStrengthPrescription {
  kind: 'strength';
  sets: number;
  repetitions: string;
  loadGuidance: string;
  targetRpe: number;
  targetRir: number;
  tempo: string;
  restSeconds: number;
}

export interface TrainingSteadyEndurancePrescription {
  kind: 'steady_endurance';
  durationMinutes?: number;
  distanceMeters?: number;
  paceGuidance?: string;
  powerGuidance?: string;
  effortZone: string;
  terrain?: string;
}

export interface TrainingIntervalsPrescription {
  kind: 'intervals';
  repetitions: number;
  workDurationSeconds?: number;
  workDistanceMeters?: number;
  recoveryDurationSeconds?: number;
  recoveryDistanceMeters?: number;
  targetIntensity: string;
}

export interface TrainingMobilityPrescription {
  kind: 'mobility';
  sequenceRounds: number;
  sequenceName?: string;
  side?: 'LEFT' | 'RIGHT' | 'BOTH' | 'ALTERNATING';
  durationSecondsPerSide: number;
  rangeGuidance: string;
}

export interface TrainingSwimmingPrescription {
  kind: 'swimming';
  totalDistanceMeters: number;
  stroke: string;
  drill?: string;
  repetitions: number;
  sendOffSeconds?: number;
  restSeconds?: number;
  targetIntensity: string;
}

export interface TrainingCyclingPrescription {
  kind: 'cycling';
  durationMinutes?: number;
  distanceMeters?: number;
  powerGuidance?: string;
  effortZone: string;
  cadenceRpm?: number;
  terrain?: string;
}

export interface TrainingRecoveryPrescription {
  kind: 'recovery';
  durationMinutes: number;
  effortGuidance: string;
}

export type TrainingSingleModalityPrescription =
  | TrainingStrengthPrescription
  | TrainingSteadyEndurancePrescription
  | TrainingIntervalsPrescription
  | TrainingMobilityPrescription
  | TrainingSwimmingPrescription
  | TrainingCyclingPrescription
  | TrainingRecoveryPrescription;

export interface TrainingMixedSessionPrescription {
  kind: 'mixed_session';
  segments: Array<{
    position: number;
    modality: 'RUNNING' | 'CYCLING' | 'SWIMMING' | 'STRENGTH' | 'MOBILITY' | 'RECOVERY';
    transitionAfterSeconds: number;
    prescription: TrainingSingleModalityPrescription;
  }>;
}

export interface TrainingUnknownPrescription {
  kind: 'unknown';
  rawPrescriptionType: string;
  summary: string;
  newlyPrescribable: false;
}

export type TrainingTypedWorkoutPrescription =
  | TrainingSingleModalityPrescription
  | TrainingMixedSessionPrescription
  | TrainingUnknownPrescription;

export interface TrainingTypedStrengthExercisePrescription {
  exerciseId: string;
  name: string;
  prescription: TrainingStrengthPrescription;
  selectionReasons: string[];
}

export interface TrainingTypedWorkoutBlock {
  blockId: string;
  /** Stable semantic objective used by adaptation/substitution matching. */
  objectiveId?: string;
  position: number;
  blockType: TrainingTypedWorkoutBlockType;
  purpose: string;
  priority: TrainingTypedWorkoutBlockPriority;
  minimumDurationMinutes: number;
  plannedDurationMinutes: number;
  prescription: TrainingTypedWorkoutPrescription;
  exercises?: TrainingTypedStrengthExercisePrescription[];
}

export interface TrainingTypedWorkout<TSessionType extends string = string> {
  workoutKey: string;
  dayOfWeek: DayOfWeek;
  title: string;
  sessionType: TSessionType;
  sessionTypeClassification: 'CANONICAL' | 'UNKNOWN';
  objective: string;
  plannedDurationMinutes: number;
  isStandalone: boolean;
  phaseKey: string | null;
  blocks: TrainingTypedWorkoutBlock[];
}

export interface TrainingTypedPhase {
  phaseKey: string;
  phaseType: TrainingTypedPhaseType;
  position: number;
  startWeek: number;
  endWeek: number;
  durationWeeks: number;
  purpose: string;
  progressionDirection: string;
  recoveryOrLighterPeriod: boolean;
  transitionExplanation: string;
  profileFitExplanation: string;
  /**
   * M2 review metadata. Optional so dormant M1 snapshots remain byte-for-byte
   * compatible; new typed revisions always populate both fields.
   */
  targetWorkoutTypeDistribution?: Array<{
    sessionType: SessionType;
    targetPerWeek: number;
  }>;
  profileFitInputs?: string[];
}

export interface TrainingTypedPlanValidationDocument {
  sourceDocumentSchemaVersion: string;
  periodization: 'PERIODIZED' | 'NON_PERIODIZED';
  horizonWeeks: number;
  phases: TrainingTypedPhase[];
  weeks: Array<{
    weekNumber: number;
    phaseKey: string | null;
    workouts: TrainingTypedWorkout[];
  }>;
}

export interface TrainingTypedValidationCheck {
  code: string;
  status: 'PASS';
  evidence: string;
}

export type TrainingTypedPrescriptionKind = TrainingTypedWorkoutPrescription['kind'];

export const TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE: Readonly<
  Record<SessionType, readonly TrainingTypedPrescriptionKind[]>
> = {
  easy_run: ['steady_endurance'],
  long_run: ['steady_endurance'],
  threshold_run: ['steady_endurance', 'intervals'],
  interval_run: ['intervals'],
  recovery_run: ['steady_endurance'],
  endurance_ride: ['cycling'],
  tempo_ride: ['cycling'],
  threshold_ride: ['cycling', 'intervals'],
  vo2_ride: ['cycling', 'intervals'],
  recovery_ride: ['cycling'],
  technique_swim: ['swimming'],
  aerobic_swim: ['swimming'],
  threshold_swim: ['swimming'],
  speed_swim: ['swimming'],
  recovery_swim: ['swimming'],
  strength_hypertrophy: ['strength'],
  strength_max: ['strength'],
  strength_maintenance: ['strength'],
  brick: ['mixed_session'],
  mobility: ['mobility'],
  rest: ['recovery'],
};

const BLOCK_TYPE_ORDER: Record<TrainingTypedWorkoutBlockType, number> = {
  PREPARATION: 1,
  PRIMARY_WORK: 2,
  SECONDARY_WORK: 3,
  CONDITIONING_MODALITY: 4,
  COOLDOWN_RECOVERY: 5,
};

const BLOCK_PRIORITIES = new Set<TrainingTypedWorkoutBlockPriority>([
  'ESSENTIAL', 'RECOMMENDED', 'OPTIONAL',
]);

const DAYS = new Set<DayOfWeek>([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

const MIXED_SEGMENT_PRESCRIPTIONS: Readonly<Record<
  TrainingMixedSessionPrescription['segments'][number]['modality'],
  readonly TrainingSingleModalityPrescription['kind'][]
>> = {
  RUNNING: ['steady_endurance', 'intervals'],
  CYCLING: ['cycling', 'intervals'],
  SWIMMING: ['swimming'],
  STRENGTH: ['strength'],
  MOBILITY: ['mobility'],
  RECOVERY: ['recovery'],
};

const PHASE_TYPES = new Set<TrainingTypedPhaseType>([
  'FOUNDATION', 'BASE', 'BUILD', 'PEAK', 'TAPER', 'RACE', 'DELOAD', 'RECOVERY', 'MAINTENANCE',
]);

export function validateTrainingTypedPlanDocument(
  document: TrainingTypedPlanValidationDocument,
): TrainingTypedValidationCheck[] {
  const failures: string[] = [];
  if (!nonEmpty(document.sourceDocumentSchemaVersion)
      || !positiveInteger(document.horizonWeeks)
      || document.weeks.length !== document.horizonWeeks
      || document.weeks.some((week, index) => week.weekNumber !== index + 1)) {
    failures.push('TYPED_WEEK_HORIZON_CONTIGUITY');
  }

  const phaseKeys = new Set<string>();
  if (document.periodization === 'PERIODIZED') {
    if (document.phases.length === 0) failures.push('TYPED_PERIODIZED_PHASES_REQUIRED');
    let expectedStartWeek = 1;
    for (const [index, phase] of document.phases.entries()) {
      if (!nonEmpty(phase.phaseKey)
          || phaseKeys.has(phase.phaseKey)
          || !PHASE_TYPES.has(phase.phaseType)
          || phase.position !== index + 1
          || phase.startWeek !== expectedStartWeek
          || phase.endWeek < phase.startWeek
          || phase.durationWeeks !== phase.endWeek - phase.startWeek + 1
          || !nonEmpty(phase.purpose)
          || !nonEmpty(phase.progressionDirection)
          || typeof phase.recoveryOrLighterPeriod !== 'boolean'
          || !nonEmpty(phase.transitionExplanation)
          || !nonEmpty(phase.profileFitExplanation)) {
        failures.push('TYPED_PHASE_ORDER_AND_CONTIGUITY');
      }
      phaseKeys.add(phase.phaseKey);
      expectedStartWeek = phase.endWeek + 1;
    }
    if (expectedStartWeek !== document.horizonWeeks + 1) {
      failures.push('TYPED_PHASE_HORIZON_COVERAGE');
    }
  } else if (document.periodization === 'NON_PERIODIZED') {
    if (document.phases.length > 0) failures.push('TYPED_NON_PERIODIZED_PHASE_OMISSION');
  } else {
    failures.push('TYPED_PERIODIZATION_MODE_INVALID');
  }

  const workoutKeys = new Set<string>();
  for (const week of document.weeks) {
    if (week.workouts.length === 0) failures.push('TYPED_WEEK_WORKOUT_REQUIRED');
    if (document.periodization === 'PERIODIZED') {
      const phase = document.phases.find((entry) => entry.phaseKey === week.phaseKey);
      if (!phase || week.weekNumber < phase.startWeek || week.weekNumber > phase.endWeek) {
        failures.push('TYPED_WEEK_PHASE_BINDING');
      }
    } else if (week.phaseKey !== null) {
      failures.push('TYPED_NON_PERIODIZED_PHASE_OMISSION');
    }
    for (const workout of week.workouts) {
      if (workoutKeys.has(workout.workoutKey)) failures.push('TYPED_UNIQUE_WORKOUT_KEYS');
      workoutKeys.add(workout.workoutKey);
      if (!workout.isStandalone && workout.phaseKey !== week.phaseKey) {
        failures.push('TYPED_WORKOUT_PHASE_BINDING');
      }
      failures.push(...collectWorkoutFailures(workout, {
        requireObjectiveIds: document.sourceDocumentSchemaVersion === 'training-plan-revision.v2',
      }));
    }
  }

  throwIfFailures(failures);
  return typedValidationChecks(document);
}

export function validateTrainingTypedWorkout(
  workout: TrainingTypedWorkout,
  options: { requireObjectiveIds?: boolean } = {},
): TrainingTypedValidationCheck[] {
  const failures = collectWorkoutFailures(workout, options);
  throwIfFailures(failures);
  return [
    { code: 'TYPED_BLOCK_ORDERING', status: 'PASS', evidence: `${workout.blocks.length} ordered priority-bearing block(s)` },
    {
      code: 'TYPED_BLOCK_OBJECTIVE_IDS',
      status: 'PASS',
      evidence: workout.blocks.every((block) => block.objectiveId != null)
        ? 'Every block has a stable semantic objective identifier'
        : 'Legacy-compatible blocks omit optional objective identifiers',
    },
    { code: 'TYPED_PRESCRIPTION_COMPATIBILITY', status: 'PASS', evidence: `${workout.sessionType} uses a compatible primary prescription` },
    { code: 'TYPED_STANDALONE_PHASE_OMISSION', status: 'PASS', evidence: workout.isStandalone ? 'Standalone workout is phase-free' : 'Plan workout phase binding is explicit' },
  ];
}

function collectWorkoutFailures(
  workout: TrainingTypedWorkout,
  options: { requireObjectiveIds?: boolean } = {},
): string[] {
  const failures: string[] = [];
  const capability = resolveTrainingWorkoutCapability(workout.sessionType);
  const canonical = capability.canonical;
  if (!nonEmpty(workout.workoutKey)
      || !nonEmpty(workout.title)
      || !nonEmpty(workout.objective)
      || !nonEmpty(workout.sessionType)
      || !DAYS.has(workout.dayOfWeek)
      || typeof workout.isStandalone !== 'boolean'
      || (workout.phaseKey !== null && !nonEmpty(workout.phaseKey))
      || workout.sessionType !== workout.sessionType.trim()
      || workout.sessionType.length > 128) {
    failures.push('TYPED_WORKOUT_IDENTITY_INVALID');
  }
  if ((canonical && workout.sessionTypeClassification !== 'CANONICAL')
      || (!canonical && workout.sessionTypeClassification !== 'UNKNOWN')) {
    failures.push('TYPED_SESSION_CLASSIFICATION_MISMATCH');
  }
  if (workout.isStandalone && workout.phaseKey !== null) {
    failures.push('TYPED_STANDALONE_PHASE_FORBIDDEN');
  }
  if (!nonNegativeNumber(workout.plannedDurationMinutes)) {
    failures.push('TYPED_WORKOUT_DURATION_INVALID');
  }
  if (canonical && workout.sessionType !== 'rest' && workout.plannedDurationMinutes <= 0) {
    failures.push('TYPED_WORKOUT_DURATION_INVALID');
  }
  if (workout.blocks.length === 0 || !workout.blocks.some((block) => block.priority === 'ESSENTIAL')) {
    failures.push('TYPED_ESSENTIAL_BLOCK_REQUIRED');
  }

  const blockIds = new Set<string>();
  const objectiveIds = new Set<string>();
  let priorBlockTypeOrder = 0;
  for (const [index, block] of workout.blocks.entries()) {
    const currentOrder = BLOCK_TYPE_ORDER[block.blockType];
    const objectiveIdValid = block.objectiveId == null
      ? options.requireObjectiveIds !== true
      : /^[a-z][a-z0-9_.:-]{2,120}$/.test(block.objectiveId)
        && !objectiveIds.has(block.objectiveId);
    if (!objectiveIdValid) failures.push('TYPED_BLOCK_OBJECTIVE_ID_INVALID');
    if (!nonEmpty(block.blockId)
        || blockIds.has(block.blockId)
        || block.position !== index + 1
        || currentOrder == null
        || currentOrder < priorBlockTypeOrder
        || !BLOCK_PRIORITIES.has(block.priority)
        || !nonEmpty(block.purpose)
        || !nonNegativeNumber(block.minimumDurationMinutes)
        || !nonNegativeNumber(block.plannedDurationMinutes)
        || block.plannedDurationMinutes < block.minimumDurationMinutes) {
      failures.push('TYPED_BLOCK_ORDERING_OR_BOUNDS');
    }
    blockIds.add(block.blockId);
    if (block.objectiveId != null) objectiveIds.add(block.objectiveId);
    priorBlockTypeOrder = currentOrder ?? priorBlockTypeOrder;
    failures.push(...collectPrescriptionFailures(block.prescription));
    if (block.exercises != null) {
      if (block.prescription.kind !== 'strength' || !Array.isArray(block.exercises)) {
        failures.push('TYPED_EXERCISE_PRESCRIPTION_INVALID');
      }
      for (const exercise of block.exercises) {
        if (!nonEmpty(exercise.exerciseId)
            || !nonEmpty(exercise.name)
            || exercise.prescription.kind !== 'strength'
            || !Array.isArray(exercise.selectionReasons)
            || exercise.selectionReasons.length === 0
            || !exercise.selectionReasons.every(nonEmpty)) {
          failures.push('TYPED_EXERCISE_PRESCRIPTION_INVALID');
        }
        failures.push(...collectPrescriptionFailures(exercise.prescription));
      }
    }
  }
  const duration = workout.blocks.reduce((total, block) => total + block.plannedDurationMinutes, 0);
  if (duration !== workout.plannedDurationMinutes) failures.push('TYPED_WORKOUT_DURATION_CONSERVATION');

  const primary = workout.sessionType === 'rest'
    ? workout.blocks.find((block) => block.priority === 'ESSENTIAL' && block.prescription.kind === 'recovery')
    : workout.blocks.find((block) => block.blockType === 'PRIMARY_WORK' && block.priority === 'ESSENTIAL');
  if (!primary) failures.push('TYPED_PRIMARY_OBJECTIVE_BLOCK_REQUIRED');
  if (canonical && primary) {
    const expected = TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE[workout.sessionType as SessionType];
    if (!expected?.includes(primary.prescription.kind)) failures.push('TYPED_SESSION_PRESCRIPTION_MISMATCH');
    if (workout.blocks.some((block) => block.prescription.kind === 'unknown')) {
      failures.push('TYPED_CANONICAL_UNKNOWN_PRESCRIPTION_FORBIDDEN');
    }
  }
  if (!canonical && primary) {
    if (primary.prescription.kind !== 'unknown') {
      failures.push('TYPED_UNKNOWN_PRESCRIPTION_REQUIRED');
    } else if (primary.prescription.rawPrescriptionType !== workout.sessionType
        || primary.prescription.newlyPrescribable !== false) {
      failures.push('TYPED_UNKNOWN_IDENTITY_NOT_PRESERVED');
    }
  }
  if (workout.sessionType === 'rest'
      && (workout.plannedDurationMinutes !== 0
        || workout.blocks.some((block) => block.prescription.kind !== 'recovery'))) {
    failures.push('TYPED_REST_ZERO_LOAD_REQUIRED');
  }
  return failures;
}

function collectPrescriptionFailures(prescription: TrainingTypedWorkoutPrescription): string[] {
  const failures: string[] = [];
  switch (prescription.kind) {
    case 'strength':
      if (!positiveInteger(prescription.sets)
          || !nonEmpty(prescription.repetitions)
          || !nonEmpty(prescription.loadGuidance)
          || !numberInRange(prescription.targetRpe, 1, 10)
          || !numberInRange(prescription.targetRir, 0, 10)
          || !nonEmpty(prescription.tempo)
          || !nonNegativeNumber(prescription.restSeconds)) failures.push('TYPED_STRENGTH_PRESCRIPTION_INVALID');
      break;
    case 'steady_endurance':
      if (!positiveOptionalPair(prescription.durationMinutes, prescription.distanceMeters)
          || !nonEmpty(prescription.effortZone)
          || !optionalText(prescription.paceGuidance)
          || !optionalText(prescription.powerGuidance)
          || !optionalText(prescription.terrain)) failures.push('TYPED_ENDURANCE_PRESCRIPTION_INVALID');
      break;
    case 'intervals':
      if (!positiveInteger(prescription.repetitions)
          || !positiveOptionalPair(prescription.workDurationSeconds, prescription.workDistanceMeters)
          || !positiveOptionalPair(prescription.recoveryDurationSeconds, prescription.recoveryDistanceMeters)
          || !nonEmpty(prescription.targetIntensity)) failures.push('TYPED_INTERVAL_PRESCRIPTION_INVALID');
      break;
    case 'mobility':
      if (!positiveInteger(prescription.sequenceRounds)
          || !positiveNumber(prescription.durationSecondsPerSide)
          || !nonEmpty(prescription.rangeGuidance)
          || !optionalText(prescription.sequenceName)
          || (prescription.side != null && !['LEFT', 'RIGHT', 'BOTH', 'ALTERNATING'].includes(prescription.side))) {
        failures.push('TYPED_MOBILITY_PRESCRIPTION_INVALID');
      }
      break;
    case 'swimming':
      if (!positiveNumber(prescription.totalDistanceMeters)
          || !nonEmpty(prescription.stroke)
          || !positiveInteger(prescription.repetitions)
          || !optionalPositiveNumber(prescription.sendOffSeconds)
          || !optionalNonNegativeNumber(prescription.restSeconds)
          || !nonEmpty(prescription.targetIntensity)
          || !optionalText(prescription.drill)) failures.push('TYPED_SWIMMING_PRESCRIPTION_INVALID');
      break;
    case 'cycling':
      if (!positiveOptionalPair(prescription.durationMinutes, prescription.distanceMeters)
          || !nonEmpty(prescription.effortZone)
          || !optionalPositiveNumber(prescription.cadenceRpm)
          || !optionalText(prescription.powerGuidance)
          || !optionalText(prescription.terrain)) failures.push('TYPED_CYCLING_PRESCRIPTION_INVALID');
      break;
    case 'recovery':
      if (!nonNegativeNumber(prescription.durationMinutes) || !nonEmpty(prescription.effortGuidance)) {
        failures.push('TYPED_RECOVERY_PRESCRIPTION_INVALID');
      }
      break;
    case 'mixed_session':
      if (prescription.segments.length < 2) failures.push('TYPED_MIXED_PRESCRIPTION_INVALID');
      for (const [index, segment] of prescription.segments.entries()) {
        if (segment.position !== index + 1
            || !['RUNNING', 'CYCLING', 'SWIMMING', 'STRENGTH', 'MOBILITY', 'RECOVERY'].includes(segment.modality)
            || !nonNegativeNumber(segment.transitionAfterSeconds)) {
          failures.push('TYPED_MIXED_PRESCRIPTION_INVALID');
        }
        if (!MIXED_SEGMENT_PRESCRIPTIONS[segment.modality]?.includes(segment.prescription.kind)) {
          failures.push('TYPED_MIXED_SEGMENT_MODALITY_MISMATCH');
        }
        failures.push(...collectPrescriptionFailures(segment.prescription));
      }
      break;
    case 'unknown':
      if (!nonEmpty(prescription.rawPrescriptionType)
          || !nonEmpty(prescription.summary)
          || prescription.newlyPrescribable !== false) failures.push('TYPED_UNKNOWN_PRESCRIPTION_INVALID');
      break;
    default:
      failures.push('TYPED_PRESCRIPTION_KIND_UNKNOWN');
  }
  return failures;
}

function typedValidationChecks(document: TrainingTypedPlanValidationDocument): TrainingTypedValidationCheck[] {
  const unknownCount = document.weeks.flatMap((week) => week.workouts)
    .filter((workout) => workout.sessionTypeClassification === 'UNKNOWN').length;
  return [
    {
      code: 'TYPED_CANONICAL_SESSION_COVERAGE',
      status: 'PASS',
      evidence: `${CANONICAL_TRAINING_SESSION_TYPES.length} canonical session types have explicit primary-prescription contracts`,
    },
    {
      code: 'TYPED_PHASE_AND_WEEK_CONTIGUITY',
      status: 'PASS',
      evidence: document.periodization === 'PERIODIZED'
        ? `${document.phases.length} ordered phase(s) cover ${document.horizonWeeks} contiguous week(s)`
        : 'Non-periodized document omits phase bindings',
    },
    {
      code: 'TYPED_BLOCK_AND_PRESCRIPTION_VALIDATION',
      status: 'PASS',
      evidence: 'Every workout conserves duration and uses ordered priority-bearing modality-compatible blocks',
    },
    {
      code: 'TYPED_BLOCK_OBJECTIVE_IDS',
      status: 'PASS',
      evidence: document.sourceDocumentSchemaVersion === 'training-plan-revision.v2'
        ? 'Every v2 block has a unique stable semantic objective identifier'
        : 'Objective identifiers remain optional for legacy snapshots',
    },
    {
      code: 'TYPED_STANDALONE_PHASE_OMISSION',
      status: 'PASS',
      evidence: 'Standalone workouts cannot carry a phase binding',
    },
    {
      code: 'TYPED_UNKNOWN_FALLBACK',
      status: 'PASS',
      evidence: `${unknownCount} unknown workout(s); raw identifiers are preserved and never newly prescribable`,
    },
  ];
}

function throwIfFailures(failures: string[]): void {
  if (failures.length === 0) return;
  throw new Error(`TRAINING_TYPED_WORKOUT_VALIDATION_FAILED:${[...new Set(failures)].sort().join(',')}`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalText(value: string | undefined): boolean {
  return value == null || nonEmpty(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function numberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function optionalPositiveNumber(value: number | undefined): boolean {
  return value == null || positiveNumber(value);
}

function optionalNonNegativeNumber(value: number | undefined): boolean {
  return value == null || nonNegativeNumber(value);
}

function positiveOptionalPair(left: number | undefined, right: number | undefined): boolean {
  return (left != null && positiveNumber(left)) || (right != null && positiveNumber(right));
}
