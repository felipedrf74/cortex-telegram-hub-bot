// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DayOfWeek, SessionType } from './coach-kernel/types';
import {
  resolveTrainingWorkoutCapability,
} from './training-workout-capability-registry';
import {
  validateTrainingTypedWorkout,
  type TrainingTypedPhaseType,
  type TrainingTypedWorkout,
  type TrainingTypedWorkoutBlock,
  type TrainingTypedWorkoutPrescription,
} from './training-typed-workout-v1';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export const TRAINING_MODALITY_WORKOUT_BUILDER_VERSION = 'training-modality-workout-builder.v1' as const;

export interface BuildCanonicalTrainingWorkoutInput {
  sessionType: SessionType;
  workoutKey: string;
  dayOfWeek: DayOfWeek;
  durationMinutes: number;
  phaseType: TrainingTypedPhaseType;
  phaseKey: string | null;
  isStandalone?: boolean;
}

export function buildCanonicalTrainingWorkout(
  input: BuildCanonicalTrainingWorkoutInput,
): TrainingTypedWorkout<SessionType> {
  const capability = resolveTrainingWorkoutCapability(input.sessionType);
  if (!capability.canonical) throw new Error('TRAINING_CANONICAL_SESSION_TYPE_REQUIRED');
  const isStandalone = input.isStandalone ?? false;
  if (isStandalone && input.phaseKey !== null) {
    throw new Error('TRAINING_STANDALONE_PHASE_FORBIDDEN');
  }
  if (input.sessionType === 'rest') {
    const rest = restWorkout(input);
    validateTrainingTypedWorkout(rest, { requireObjectiveIds: true });
    return rest;
  }
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 10 || input.durationMinutes > 360) {
    throw new Error('TRAINING_WORKOUT_DURATION_OUT_OF_RANGE');
  }

  const preparationMinutes = Math.max(3, Math.floor(input.durationMinutes * 0.15));
  const cooldownMinutes = Math.max(2, Math.floor(input.durationMinutes * 0.1));
  const primaryMinutes = input.durationMinutes - preparationMinutes - cooldownMinutes;
  const preparation = preparationBlock(input, preparationMinutes);
  const primary: TrainingTypedWorkoutBlock = {
    blockId: 'primary-work',
    objectiveId: `primary.${input.sessionType}`,
    position: 2,
    blockType: 'PRIMARY_WORK',
    purpose: objectiveFor(input.sessionType),
    priority: 'ESSENTIAL',
    minimumDurationMinutes: Math.max(5, Math.floor(primaryMinutes * 0.65)),
    plannedDurationMinutes: primaryMinutes,
    prescription: primaryPrescription(input.sessionType, input.durationMinutes, input.phaseType),
  };
  const cooldown: TrainingTypedWorkoutBlock = {
    blockId: 'cooldown-recovery',
    objectiveId: 'recovery.cooldown',
    position: 3,
    blockType: 'COOLDOWN_RECOVERY',
    purpose: 'Downshift gradually and complete the session without adding training load.',
    priority: 'OPTIONAL',
    minimumDurationMinutes: 0,
    plannedDurationMinutes: cooldownMinutes,
    prescription: {
      kind: 'recovery',
      durationMinutes: cooldownMinutes,
      effortGuidance: 'Very easy movement and relaxed breathing.',
    },
  };
  const workout: TrainingTypedWorkout<SessionType> = {
    workoutKey: input.workoutKey,
    dayOfWeek: input.dayOfWeek,
    title: capability.presentationLabel,
    sessionType: input.sessionType,
    sessionTypeClassification: 'CANONICAL',
    objective: objectiveFor(input.sessionType),
    plannedDurationMinutes: input.durationMinutes,
    isStandalone,
    phaseKey: isStandalone ? null : input.phaseKey,
    blocks: [preparation, primary, cooldown],
  };
  validateTrainingTypedWorkout(workout, { requireObjectiveIds: true });
  return workout;
}

/** Honest compatibility fallback: it preserves the raw identifier and can be
 * rendered, but it is explicitly not eligible for generation/activation. */
export function buildUnknownTrainingWorkoutFallback(input: {
  rawSessionType: string;
  workoutKey: string;
  dayOfWeek: DayOfWeek;
  durationMinutes: number;
  summary?: string;
}): TrainingTypedWorkout {
  const raw = input.rawSessionType.trim();
  if (!raw || raw.length > 128 || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 1) {
    throw new Error('TRAINING_UNKNOWN_WORKOUT_FALLBACK_INVALID');
  }
  const workout: TrainingTypedWorkout = {
    workoutKey: input.workoutKey,
    dayOfWeek: input.dayOfWeek,
    title: 'Unknown workout type',
    sessionType: raw,
    sessionTypeClassification: 'UNKNOWN',
    objective: 'Preserve the supplied workout without inventing a modality or prescription.',
    plannedDurationMinutes: input.durationMinutes,
    isStandalone: true,
    phaseKey: null,
    blocks: [{
      blockId: 'unknown-primary',
      objectiveId: 'unknown.preserved',
      position: 1,
      blockType: 'PRIMARY_WORK',
      purpose: 'Retain the original workout information for review.',
      priority: 'ESSENTIAL',
      minimumDurationMinutes: input.durationMinutes,
      plannedDurationMinutes: input.durationMinutes,
      prescription: {
        kind: 'unknown',
        rawPrescriptionType: raw,
        summary: input.summary?.trim() || 'Generic prescription retained without assigning a known modality.',
        newlyPrescribable: false,
      },
    }],
  };
  validateTrainingTypedWorkout(workout);
  incrementTrainingGenerationCounter('typed_unknown_fallback_total');
  return workout;
}

function preparationBlock(
  input: BuildCanonicalTrainingWorkoutInput,
  plannedDurationMinutes: number,
): TrainingTypedWorkoutBlock {
  const swim = input.sessionType.endsWith('_swim');
  const bike = input.sessionType.endsWith('_ride');
  const strength = input.sessionType.startsWith('strength_');
  const prescription: TrainingTypedWorkoutPrescription = swim
    ? {
      kind: 'swimming',
      totalDistanceMeters: Math.max(100, plannedDurationMinutes * 40),
      stroke: 'Freestyle',
      drill: 'Easy technique preparation',
      repetitions: 4,
      restSeconds: 20,
      targetIntensity: 'Easy',
    }
    : bike
      ? {
        kind: 'cycling',
        durationMinutes: plannedDurationMinutes,
        effortZone: 'Zone 1',
        cadenceRpm: 85,
        terrain: 'Low-resistance trainer or flat terrain',
      }
      : strength || input.sessionType === 'mobility'
        ? {
          kind: 'mobility',
          sequenceRounds: 1,
          sequenceName: strength ? 'Movement-pattern preparation' : 'Controlled range check',
          side: 'BOTH',
          durationSecondsPerSide: 30,
          rangeGuidance: 'Use a comfortable, controlled, pain-free range.',
        }
        : {
          kind: 'steady_endurance',
          durationMinutes: plannedDurationMinutes,
          paceGuidance: 'Very easy conversational pace',
          effortZone: 'Zone 1',
          terrain: 'Stable, low-complexity terrain',
        };
  return {
    blockId: 'preparation',
    objectiveId: preparationObjectiveId(input.sessionType),
    position: 1,
    blockType: 'PREPARATION',
    purpose: 'Prepare the relevant movement pattern and check comfortable execution.',
    priority: 'ESSENTIAL',
    minimumDurationMinutes: Math.min(3, plannedDurationMinutes),
    plannedDurationMinutes,
    prescription,
  };
}

function primaryPrescription(
  sessionType: SessionType,
  durationMinutes: number,
  phaseType: TrainingTypedPhaseType,
): TrainingTypedWorkoutPrescription {
  const lighter = phaseType === 'DELOAD' || phaseType === 'RECOVERY' || phaseType === 'TAPER' || phaseType === 'RACE';
  switch (sessionType) {
    case 'easy_run':
    case 'long_run':
    case 'recovery_run':
      return {
        kind: 'steady_endurance',
        durationMinutes: Math.max(10, Math.floor(durationMinutes * 0.75)),
        paceGuidance: sessionType === 'recovery_run' ? 'Very easy conversational pace' : 'Controlled conversational pace',
        effortZone: sessionType === 'recovery_run' ? 'Zone 1' : 'Zone 2',
        terrain: sessionType === 'long_run' ? 'Predictable endurance route' : 'Flat or gently rolling terrain',
      };
    case 'threshold_run':
      return intervalPrescription(3, 480, 120, lighter ? 'Upper Zone 3' : 'Threshold');
    case 'interval_run':
      return intervalPrescription(6, 180, 120, lighter ? 'Controlled Zone 4' : 'VO2');
    case 'endurance_ride':
    case 'tempo_ride':
    case 'threshold_ride':
    case 'vo2_ride':
    case 'recovery_ride':
      return {
        kind: 'cycling',
        durationMinutes: Math.max(10, Math.floor(durationMinutes * 0.75)),
        powerGuidance: cyclingPower(sessionType, lighter),
        effortZone: cyclingZone(sessionType, lighter),
        cadenceRpm: sessionType === 'vo2_ride' ? 95 : 88,
        terrain: sessionType === 'recovery_ride' ? 'Low-resistance trainer or flat road' : 'Trainer or predictable road',
      };
    case 'technique_swim':
    case 'aerobic_swim':
    case 'threshold_swim':
    case 'speed_swim':
    case 'recovery_swim':
      return {
        kind: 'swimming',
        totalDistanceMeters: Math.max(400, durationMinutes * (lighter ? 25 : 35)),
        stroke: 'Freestyle',
        drill: swimDrill(sessionType),
        repetitions: swimRepetitions(sessionType),
        sendOffSeconds: sessionType === 'speed_swim' ? 75 : undefined,
        restSeconds: sessionType === 'threshold_swim' ? 30 : 20,
        targetIntensity: swimIntensity(sessionType, lighter),
      };
    case 'strength_hypertrophy':
    case 'strength_max':
    case 'strength_maintenance':
      return {
        kind: 'strength',
        sets: lighter ? 2 : sessionType === 'strength_max' ? 4 : 3,
        repetitions: sessionType === 'strength_max' ? '3–5' : sessionType === 'strength_maintenance' ? '5–8' : '6–12',
        loadGuidance: lighter ? 'Use a clearly submaximal load with repeatable form.' : 'Use a controllable load that preserves the target repetitions in reserve.',
        targetRpe: lighter ? 6 : sessionType === 'strength_max' ? 8.5 : 8,
        targetRir: lighter ? 4 : sessionType === 'strength_max' ? 2 : 2,
        tempo: sessionType === 'strength_max' ? '2-1-1-0' : '2-0-1-0',
        restSeconds: sessionType === 'strength_max' ? 180 : 90,
      };
    case 'brick': {
      const segmentMinutes = Math.max(5, Math.floor(durationMinutes * 0.34));
      return {
        kind: 'mixed_session',
        segments: [
          {
            position: 1,
            modality: 'CYCLING',
            transitionAfterSeconds: 120,
            prescription: {
              kind: 'cycling',
              durationMinutes: segmentMinutes,
              powerGuidance: lighter ? '55–65% FTP' : '65–75% FTP',
              effortZone: lighter ? 'Zone 1–2' : 'Zone 2',
              cadenceRpm: 88,
            },
          },
          {
            position: 2,
            modality: 'RUNNING',
            transitionAfterSeconds: 0,
            prescription: {
              kind: 'steady_endurance',
              durationMinutes: segmentMinutes,
              paceGuidance: 'Controlled transition pace',
              effortZone: lighter ? 'Zone 1' : 'Zone 2',
            },
          },
        ],
      };
    }
    case 'mobility':
      return {
        kind: 'mobility',
        sequenceRounds: lighter ? 1 : 2,
        sequenceName: 'Whole-body mobility sequence',
        side: 'BOTH',
        durationSecondsPerSide: 40,
        rangeGuidance: 'Move slowly through a comfortable, controlled range; do not force end range.',
      };
    case 'rest':
      return { kind: 'recovery', durationMinutes: 0, effortGuidance: 'Rest with normal daily movement only.' };
  }
}

function restWorkout(input: BuildCanonicalTrainingWorkoutInput): TrainingTypedWorkout<SessionType> {
  return {
    workoutKey: input.workoutKey,
    dayOfWeek: input.dayOfWeek,
    title: 'Rest',
    sessionType: 'rest',
    sessionTypeClassification: 'CANONICAL',
    objective: 'Protect recovery without adding prescribed training load.',
    plannedDurationMinutes: 0,
    isStandalone: input.isStandalone ?? false,
    phaseKey: input.isStandalone ? null : input.phaseKey,
    blocks: [{
      blockId: 'rest-recovery',
      objectiveId: 'recovery.rest',
      position: 1,
      blockType: 'COOLDOWN_RECOVERY',
      purpose: 'No prescribed training work.',
      priority: 'ESSENTIAL',
      minimumDurationMinutes: 0,
      plannedDurationMinutes: 0,
      prescription: { kind: 'recovery', durationMinutes: 0, effortGuidance: 'Rest; optional normal daily movement only.' },
    }],
  };
}

function preparationObjectiveId(sessionType: SessionType): string {
  if (sessionType.endsWith('_run')) return 'preparation.running';
  if (sessionType.endsWith('_ride')) return 'preparation.cycling';
  if (sessionType.endsWith('_swim')) return 'preparation.swimming';
  if (sessionType.startsWith('strength_')) return 'preparation.strength';
  if (sessionType === 'brick') return 'preparation.mixed';
  if (sessionType === 'mobility') return 'preparation.mobility';
  return 'preparation.recovery';
}

function objectiveFor(sessionType: SessionType): string {
  const objectives: Record<SessionType, string> = {
    easy_run: 'Build aerobic durability at conversational effort.',
    long_run: 'Extend aerobic endurance with controlled pacing.',
    threshold_run: 'Accumulate controlled work near threshold.',
    interval_run: 'Develop high-intensity running capacity with complete recoveries.',
    recovery_run: 'Promote low-load movement and recovery.',
    endurance_ride: 'Build cycling endurance with stable aerobic power.',
    tempo_ride: 'Sustain controlled tempo power and cadence.',
    threshold_ride: 'Accumulate cycling work near functional threshold.',
    vo2_ride: 'Develop high-intensity cycling capacity with bounded intervals.',
    recovery_ride: 'Promote low-load cycling recovery.',
    technique_swim: 'Improve swimming technique through purposeful drills.',
    aerobic_swim: 'Build continuous aerobic swimming capacity.',
    threshold_swim: 'Accumulate controlled swimming work near threshold.',
    speed_swim: 'Develop short swimming speed while preserving technique.',
    recovery_swim: 'Promote low-load movement and comfortable technique.',
    strength_hypertrophy: 'Build muscle capacity across reviewed movement patterns.',
    strength_max: 'Develop high-force strength with controlled technique and long recovery.',
    strength_maintenance: 'Retain strength exposure with bounded fatigue.',
    brick: 'Practice an ordered cycling-to-running transition at controlled effort.',
    mobility: 'Restore comfortable range and reinforce controlled movement quality.',
    rest: 'Protect recovery without adding prescribed training load.',
  };
  return objectives[sessionType];
}

function intervalPrescription(
  repetitions: number,
  workDurationSeconds: number,
  recoveryDurationSeconds: number,
  targetIntensity: string,
): TrainingTypedWorkoutPrescription {
  return { kind: 'intervals', repetitions, workDurationSeconds, recoveryDurationSeconds, targetIntensity };
}

function cyclingZone(sessionType: SessionType, lighter: boolean): string {
  if (lighter || sessionType === 'recovery_ride') return 'Zone 1–2';
  if (sessionType === 'endurance_ride') return 'Zone 2';
  if (sessionType === 'tempo_ride') return 'Zone 3';
  if (sessionType === 'threshold_ride') return 'Zone 4';
  return 'Zone 5';
}

function cyclingPower(sessionType: SessionType, lighter: boolean): string {
  if (lighter || sessionType === 'recovery_ride') return '50–65% FTP';
  if (sessionType === 'endurance_ride') return '65–75% FTP';
  if (sessionType === 'tempo_ride') return '76–87% FTP';
  if (sessionType === 'threshold_ride') return '95–100% FTP';
  return '106–120% FTP';
}

function swimDrill(sessionType: SessionType): string | undefined {
  if (sessionType === 'technique_swim') return 'Catch-up and single-arm drill';
  if (sessionType === 'recovery_swim') return 'Relaxed balance drill';
  return undefined;
}

function swimRepetitions(sessionType: SessionType): number {
  if (sessionType === 'speed_swim') return 12;
  if (sessionType === 'threshold_swim') return 6;
  return 4;
}

function swimIntensity(sessionType: SessionType, lighter: boolean): string {
  if (lighter || sessionType === 'recovery_swim') return 'Easy';
  if (sessionType === 'speed_swim') return 'Fast with complete recovery';
  if (sessionType === 'threshold_swim') return 'Threshold';
  if (sessionType === 'aerobic_swim') return 'Aerobic';
  return 'Technique-first easy effort';
}
