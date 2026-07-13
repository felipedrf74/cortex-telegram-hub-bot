// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  BlockPhase,
  CoachingDiscipline,
  SessionType,
  WeekIntentKindEnum,
} from './coach-kernel/types';
import type { TrainingExperienceLevel } from './training-plan-revision-candidate-builder';
import type { TrainingPlanMode } from './training-workout-capability-registry';
import type { TrainingTypedPhase, TrainingTypedPhaseType } from './training-typed-workout-v1';

export const TRAINING_PHASE_MODEL_VERSION = 'training-phase-model.v1' as const;

export interface TrainingPhaseModelInput {
  planMode: TrainingPlanMode;
  discipline: CoachingDiscipline;
  experienceLevel: TrainingExperienceLevel;
  sessionsPerWeek: number;
  horizonWeeks: number;
  targetWorkoutTypeDistribution: Array<{
    sessionType: SessionType;
    targetPerWeek: number;
  }>;
  eventSessionType?: SessionType;
  eventDayIndex?: number;
}

export interface TrainingPhaseModelValidationCheck {
  code: string;
  status: 'PASS';
  evidence: string;
}

const REQUIRED_PROFILE_FIT_INPUTS = [
  'profile.experienceLevel',
  'profile.sessionsPerWeek',
  'discipline',
] as const;

const SEQUENCES: Readonly<Record<TrainingPlanMode, readonly TrainingTypedPhaseType[]>> = {
  event_based: ['BASE', 'BUILD', 'PEAK', 'TAPER', 'RACE'],
  continuous: ['FOUNDATION', 'BUILD', 'DELOAD'],
  maintenance: ['MAINTENANCE', 'RECOVERY'],
  return_to_training: ['FOUNDATION', 'BASE', 'RECOVERY'],
};

const WEIGHTS: Readonly<Record<TrainingPlanMode, readonly number[]>> = {
  event_based: [0.32, 0.3, 0.18, 0.14, 0.06],
  continuous: [0.4, 0.4, 0.2],
  maintenance: [0.75, 0.25],
  return_to_training: [0.45, 0.35, 0.2],
};

const HIGH_LOAD_SESSION_TYPES: readonly SessionType[] = [
  'interval_run', 'threshold_run', 'long_run',
  'vo2_ride', 'threshold_ride', 'tempo_ride',
  'speed_swim', 'threshold_swim',
  'strength_max', 'strength_hypertrophy', 'brick',
];

export function minimumTrainingHorizonForMode(planMode: TrainingPlanMode): number {
  return SEQUENCES[planMode].length;
}

/** Canonical bridge for the pre-M2 week-intent and BlockPhase systems. */
export function trainingPhaseTypeFromWeekIntent(kind: WeekIntentKindEnum): TrainingTypedPhaseType {
  switch (kind) {
    case 'accumulation': return 'BASE';
    case 'intensification': return 'BUILD';
    case 'realization': return 'PEAK';
    case 'deload': return 'DELOAD';
    case 'recovery':
    case 'post_race_recovery': return 'RECOVERY';
    case 'taper': return 'TAPER';
    case 'race': return 'RACE';
  }
}

export function blockPhaseFromTrainingPhaseType(phaseType: TrainingTypedPhaseType): BlockPhase {
  switch (phaseType) {
    case 'FOUNDATION':
    case 'BASE': return 'base';
    case 'BUILD': return 'build';
    case 'PEAK': return 'peak';
    case 'TAPER': return 'taper';
    case 'RACE': return 'race';
    case 'DELOAD':
    case 'RECOVERY': return 'deload';
    case 'MAINTENANCE': return 'maintenance';
  }
}

export function buildTrainingPhaseModel(input: TrainingPhaseModelInput): TrainingTypedPhase[] {
  validatePhaseInput(input);
  const sequence = SEQUENCES[input.planMode];
  const durations = input.planMode === 'event_based' && input.eventSessionType
    ? allocateEventPhaseDurations(input.horizonWeeks)
    : allocatePhaseDurations(input.horizonWeeks, WEIGHTS[input.planMode]);
  let startWeek = 1;
  const phases = sequence.map((phaseType, index): TrainingTypedPhase => {
    const durationWeeks = durations[index];
    const endWeek = startWeek + durationWeeks - 1;
    const next = sequence[index + 1];
    const phase: TrainingTypedPhase = {
      phaseKey: `phase-${index + 1}-${phaseType.toLowerCase()}`,
      phaseType,
      position: index + 1,
      startWeek,
      endWeek,
      durationWeeks,
      purpose: purposeFor(phaseType, input.discipline),
      progressionDirection: progressionFor(phaseType, input.experienceLevel),
      recoveryOrLighterPeriod: isLighterPhase(phaseType),
      transitionExplanation: next
        ? `Move from ${phaseLabel(phaseType)} to ${phaseLabel(next)} after the approved ${durationWeeks}-week exposure; no profile or schedule input is changed automatically.`
        : terminalTransition(input.planMode),
      profileFitExplanation: profileFitFor(phaseType, input),
      targetWorkoutTypeDistribution: targetWorkoutDistributionForPhase(input, phaseType),
      profileFitInputs: [...REQUIRED_PROFILE_FIT_INPUTS],
    };
    startWeek = endWeek + 1;
    return phase;
  });
  validateTrainingPhaseModel(input, phases);
  return phases;
}

export function validateTrainingPhaseModel(
  input: TrainingPhaseModelInput,
  phases: readonly TrainingTypedPhase[],
): TrainingPhaseModelValidationCheck[] {
  validatePhaseInput(input);
  const failures: string[] = [];
  const expectedSequence = SEQUENCES[input.planMode];
  if (phases.length !== expectedSequence.length
      || phases.some((phase, index) => phase.phaseType !== expectedSequence[index])) {
    failures.push('PHASE_SEQUENCE_FOR_PLAN_MODE');
  }

  let expectedStart = 1;
  const phaseKeys = new Set<string>();
  for (const [index, phase] of phases.entries()) {
    if (!nonEmpty(phase.phaseKey)
        || phaseKeys.has(phase.phaseKey)
        || phase.position !== index + 1
        || phase.startWeek !== expectedStart
        || phase.endWeek < phase.startWeek
        || phase.durationWeeks !== phase.endWeek - phase.startWeek + 1) {
      failures.push('PHASE_ORDER_AND_CONTIGUITY');
    }
    phaseKeys.add(phase.phaseKey);
    expectedStart = phase.endWeek + 1;
    if (!nonEmpty(phase.purpose)
        || !nonEmpty(phase.progressionDirection)
        || !nonEmpty(phase.transitionExplanation)
        || !nonEmpty(phase.profileFitExplanation)) {
      failures.push('PHASE_REVIEW_EXPLANATIONS_REQUIRED');
    }
    if (!Array.isArray(phase.profileFitInputs)
        || REQUIRED_PROFILE_FIT_INPUTS.some((key) => !phase.profileFitInputs?.includes(key))) {
      failures.push('PHASE_PROFILE_FIT_INPUTS_REQUIRED');
    }
    if (phase.profileFitExplanation !== profileFitFor(phase.phaseType, input)
        || phase.recoveryOrLighterPeriod !== isLighterPhase(phase.phaseType)) {
      failures.push('PHASE_PROFILE_FIT_MISMATCH');
    }
    const distribution = phase.targetWorkoutTypeDistribution;
    const seen = new Set<string>();
    let invalidDistribution = !Array.isArray(distribution);
    for (const target of distribution ?? []) {
      if (seen.has(target.sessionType)
          || !Number.isSafeInteger(target.targetPerWeek)
          || target.targetPerWeek < 0) invalidDistribution = true;
      seen.add(target.sessionType);
    }
    if (invalidDistribution
        || (distribution ?? []).reduce((sum, target) => sum + target.targetPerWeek, 0) !== 7) {
      failures.push('PHASE_TARGET_DISTRIBUTION_REQUIRED');
    }
    if (JSON.stringify(distribution ?? [])
        !== JSON.stringify(targetWorkoutDistributionForPhase(input, phase.phaseType))) {
      failures.push('PHASE_TARGET_DISTRIBUTION_MISMATCH');
    }
  }
  if (expectedStart !== input.horizonWeeks + 1) failures.push('PHASE_HORIZON_COVERAGE');
  if (!phases.some((phase) => phase.recoveryOrLighterPeriod)) {
    failures.push('PHASE_RECOVERY_PERIOD_REQUIRED');
  }
  if (input.planMode !== 'event_based'
      && phases.some((phase) => phase.phaseType === 'PEAK'
        || phase.phaseType === 'TAPER'
        || phase.phaseType === 'RACE')) {
    failures.push('NON_EVENT_RACE_PHASE_FORBIDDEN');
  }
  throwPhaseFailures(failures);
  return [
    {
      code: 'PHASE_SEQUENCE_FOR_PLAN_MODE',
      status: 'PASS',
      evidence: `${input.planMode} uses ${expectedSequence.join(' → ')}`,
    },
    {
      code: 'PHASE_ORDER_AND_CONTIGUITY',
      status: 'PASS',
      evidence: `${phases.length} phase(s) cover ${input.horizonWeeks} contiguous week(s)`,
    },
    {
      code: 'PHASE_PURPOSE_TRANSITION_PROFILE_FIT',
      status: 'PASS',
      evidence: 'Every phase identifies purpose, progression, transition, recovery state, distribution and causal profile inputs',
    },
  ];
}

/**
 * Quality repair is deliberately bounded: it only reconstructs the phase
 * projection from already-normalized inputs. It never changes profile,
 * schedule, workout selection or approval state. The function is deterministic
 * and idempotent so a retry cannot create a different candidate.
 */
export function repairTrainingPhaseModel(input: TrainingPhaseModelInput): TrainingTypedPhase[] {
  return buildTrainingPhaseModel(input);
}

export function targetWorkoutDistributionForPhase(
  input: TrainingPhaseModelInput,
  phaseType: TrainingTypedPhaseType,
): Array<{ sessionType: SessionType; targetPerWeek: number }> {
  const distribution = input.targetWorkoutTypeDistribution.map((target) => ({ ...target }));
  if (!isLighterPhase(phaseType)) return distribution;

  const recoveryType = recoverySessionType(input.discipline);
  const replacementLimit = phaseType === 'RACE' ? 2 : 1;
  let replacements = 0;
  for (const highLoadType of HIGH_LOAD_SESSION_TYPES) {
    const target = distribution.find((entry) => entry.sessionType === highLoadType);
    while (target && target.targetPerWeek > 0 && replacements < replacementLimit) {
      target.targetPerWeek -= 1;
      const recovery = distribution.find((entry) => entry.sessionType === recoveryType);
      if (recovery) recovery.targetPerWeek += 1;
      else {
        const restIndex = distribution.findIndex((entry) => entry.sessionType === 'rest');
        distribution.splice(restIndex >= 0 ? restIndex : distribution.length, 0, {
          sessionType: recoveryType,
          targetPerWeek: 1,
        });
      }
      replacements += 1;
    }
    if (replacements >= replacementLimit) break;
  }
  const lighter = distribution.filter((target) => target.targetPerWeek > 0 || target.sessionType === 'rest');
  if (phaseType !== 'RACE' || !input.eventSessionType || input.eventDayIndex == null) return lighter;
  const active = lighter.flatMap((target) => target.sessionType === 'rest'
    ? []
    : Array.from({ length: target.targetPerWeek }, () => target.sessionType));
  if (input.eventDayIndex < 0 || input.eventDayIndex >= active.length) {
    throw new Error('TRAINING_PHASE_MODEL_INVALID:EVENT_DAY_INDEX');
  }
  active[input.eventDayIndex] = input.eventSessionType;
  const counts = new Map<SessionType, number>();
  for (const type of active) counts.set(type, (counts.get(type) ?? 0) + 1);
  counts.set('rest', 7 - active.length);
  return [...counts.entries()]
    .map(([sessionType, targetPerWeek]) => ({ sessionType, targetPerWeek }))
    .sort((left, right) => CANONICAL_ORDER.indexOf(left.sessionType) - CANONICAL_ORDER.indexOf(right.sessionType));
}

export function phaseForWeek(
  phases: readonly TrainingTypedPhase[],
  weekNumber: number,
): TrainingTypedPhase | null {
  return phases.find((phase) => weekNumber >= phase.startWeek && weekNumber <= phase.endWeek) ?? null;
}

function validatePhaseInput(input: TrainingPhaseModelInput): void {
  const minimum = minimumTrainingHorizonForMode(input.planMode);
  if (!Number.isSafeInteger(input.horizonWeeks) || input.horizonWeeks < minimum || input.horizonWeeks > 52) {
    throw new Error(`TRAINING_PHASE_MODEL_INVALID:HORIZON_MIN_${minimum}`);
  }
  if (!Number.isSafeInteger(input.sessionsPerWeek) || input.sessionsPerWeek < 1 || input.sessionsPerWeek > 7) {
    throw new Error('TRAINING_PHASE_MODEL_INVALID:SESSIONS_PER_WEEK');
  }
  if (!['novice', 'intermediate', 'advanced'].includes(input.experienceLevel)) {
    throw new Error('TRAINING_PHASE_MODEL_INVALID:EXPERIENCE');
  }
  if (input.targetWorkoutTypeDistribution.reduce((sum, target) => sum + target.targetPerWeek, 0) !== 7) {
    throw new Error('TRAINING_PHASE_MODEL_INVALID:DISTRIBUTION');
  }
  if ((input.eventSessionType == null) !== (input.eventDayIndex == null)) {
    throw new Error('TRAINING_PHASE_MODEL_INVALID:EVENT_BINDING_INCOMPLETE');
  }
}

const CANONICAL_ORDER: readonly SessionType[] = [
  'easy_run', 'long_run', 'threshold_run', 'interval_run', 'recovery_run',
  'endurance_ride', 'tempo_ride', 'threshold_ride', 'vo2_ride', 'recovery_ride',
  'technique_swim', 'aerobic_swim', 'threshold_swim', 'speed_swim', 'recovery_swim',
  'strength_hypertrophy', 'strength_max', 'strength_maintenance', 'brick', 'mobility', 'rest',
];

function allocatePhaseDurations(horizonWeeks: number, weights: readonly number[]): number[] {
  const remaining = horizonWeeks - weights.length;
  const raw = weights.map((weight) => weight * remaining);
  const extra = raw.map(Math.floor);
  let undistributed = remaining - extra.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const entry of order) {
    if (undistributed <= 0) break;
    extra[entry.index] += 1;
    undistributed -= 1;
  }
  return extra.map((value) => value + 1);
}

function allocateEventPhaseDurations(horizonWeeks: number): number[] {
  const taperWeeks = horizonWeeks >= 10 ? 2 : 1;
  const raceWeeks = 1;
  const preparatoryWeeks = horizonWeeks - taperWeeks - raceWeeks;
  const [base, build, peak] = allocatePhaseDurations(preparatoryWeeks, [0.4, 0.4, 0.2]);
  return [base, build, peak, taperWeeks, raceWeeks];
}

function purposeFor(phaseType: TrainingTypedPhaseType, discipline: CoachingDiscipline): string {
  const disciplineLabel = discipline === 'marathon' ? 'running' : discipline;
  const purposes: Record<TrainingTypedPhaseType, string> = {
    FOUNDATION: `Establish repeatable ${disciplineLabel} technique, schedule consistency and tolerable workload.`,
    BASE: `Build durable ${disciplineLabel} capacity before adding more specific demand.`,
    BUILD: `Progress the primary ${disciplineLabel} stimulus while preserving recovery and movement quality.`,
    PEAK: `Concentrate event-specific ${disciplineLabel} quality without adding unnecessary volume.`,
    TAPER: 'Reduce fatigue while retaining short exposures to event-specific intensity.',
    RACE: 'Protect readiness and deliver the reviewed event objective.',
    DELOAD: 'Reduce accumulated fatigue while retaining movement familiarity.',
    RECOVERY: 'Create a deliberately lighter period before the next reviewed progression.',
    MAINTENANCE: `Retain current ${disciplineLabel} capability with the minimum effective dose.`,
  };
  return purposes[phaseType];
}

function progressionFor(
  phaseType: TrainingTypedPhaseType,
  experience: TrainingExperienceLevel,
): string {
  if (isLighterPhase(phaseType)) return 'Reduce volume first; retain controlled technique and only necessary intensity.';
  if (phaseType === 'RACE') return 'No additional progression; preserve readiness for the event objective.';
  if (experience === 'novice') return 'Progress consistency and repetitions before load, duration or intensity.';
  if (experience === 'advanced') return 'Progress one bounded volume or intensity variable while preserving specificity.';
  return 'Progress one bounded duration, volume or intensity variable after successful completion.';
}

function profileFitFor(phaseType: TrainingTypedPhaseType, input: TrainingPhaseModelInput): string {
  return `${phaseLabel(phaseType)} is sized for a ${input.experienceLevel} ${input.discipline} profile training ${input.sessionsPerWeek} time(s) per week across a ${input.horizonWeeks}-week ${input.planMode} horizon.`;
}

function terminalTransition(planMode: TrainingPlanMode): string {
  if (planMode === 'event_based') {
    return 'After the event, collect explicit recovery and outcome feedback before proposing any later phase or plan revision.';
  }
  return 'At the horizon boundary, review outcomes and current constraints before creating another immutable revision.';
}

function isLighterPhase(phaseType: TrainingTypedPhaseType): boolean {
  return phaseType === 'DELOAD' || phaseType === 'RECOVERY' || phaseType === 'TAPER' || phaseType === 'RACE';
}

function recoverySessionType(discipline: CoachingDiscipline): SessionType {
  if (discipline === 'running' || discipline === 'marathon' || discipline === 'hybrid') return 'recovery_run';
  if (discipline === 'cycling') return 'recovery_ride';
  if (discipline === 'swimming') return 'recovery_swim';
  if (discipline === 'triathlon') return 'mobility';
  return 'strength_maintenance';
}

function phaseLabel(phaseType: TrainingTypedPhaseType): string {
  return phaseType.charAt(0) + phaseType.slice(1).toLowerCase();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function throwPhaseFailures(failures: string[]): void {
  if (failures.length === 0) return;
  throw new Error(`TRAINING_PHASE_MODEL_VALIDATION_FAILED:${[...new Set(failures)].sort().join(',')}`);
}
