// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { SessionType } from './coach-kernel/types';

export type TrainingWorkoutPresentationFamily =
  | 'running'
  | 'cycling'
  | 'swimming'
  | 'strength'
  | 'mixed'
  | 'mobility'
  | 'rest'
  | 'unknown';

export type TrainingPlanMode = 'event_based' | 'continuous' | 'maintenance' | 'return_to_training';

export const CANONICAL_TRAINING_SESSION_TYPES = [
  'easy_run',
  'long_run',
  'threshold_run',
  'interval_run',
  'recovery_run',
  'endurance_ride',
  'tempo_ride',
  'threshold_ride',
  'vo2_ride',
  'recovery_ride',
  'technique_swim',
  'aerobic_swim',
  'threshold_swim',
  'speed_swim',
  'recovery_swim',
  'strength_hypertrophy',
  'strength_max',
  'strength_maintenance',
  'brick',
  'mobility',
  'rest',
] as const satisfies readonly SessionType[];

export interface TrainingWorkoutCapability {
  sessionType: SessionType;
  canonical: true;
  presentationFamily: Exclude<TrainingWorkoutPresentationFamily, 'unknown'>;
  presentationLabel: string;
  milestone1GenerationEnabled: boolean;
  typedWorkoutGenerationEnabled: true;
}

const MILESTONE_1_GENERATION_TYPES = new Set<SessionType>([
  'strength_hypertrophy',
  'strength_maintenance',
  'mobility',
  'rest',
]);

const LABELS: Record<SessionType, string> = {
  easy_run: 'Easy run',
  long_run: 'Long run',
  threshold_run: 'Threshold run',
  interval_run: 'Interval run',
  recovery_run: 'Recovery run',
  endurance_ride: 'Endurance ride',
  tempo_ride: 'Tempo ride',
  threshold_ride: 'Threshold ride',
  vo2_ride: 'VO2 ride',
  recovery_ride: 'Recovery ride',
  technique_swim: 'Technique swim',
  aerobic_swim: 'Aerobic swim',
  threshold_swim: 'Threshold swim',
  speed_swim: 'Speed swim',
  recovery_swim: 'Recovery swim',
  strength_hypertrophy: 'Strength hypertrophy',
  strength_max: 'Maximum strength',
  strength_maintenance: 'Strength maintenance',
  brick: 'Brick session',
  mobility: 'Mobility',
  rest: 'Rest',
};

function presentationFamily(sessionType: SessionType): Exclude<TrainingWorkoutPresentationFamily, 'unknown'> {
  if (sessionType.endsWith('_run')) return 'running';
  if (sessionType.endsWith('_ride')) return 'cycling';
  if (sessionType.endsWith('_swim')) return 'swimming';
  if (sessionType.startsWith('strength_')) return 'strength';
  if (sessionType === 'brick') return 'mixed';
  if (sessionType === 'mobility') return 'mobility';
  return 'rest';
}

export const TRAINING_WORKOUT_CAPABILITY_REGISTRY: readonly TrainingWorkoutCapability[] =
  CANONICAL_TRAINING_SESSION_TYPES.map((sessionType) => ({
    sessionType,
    canonical: true,
    presentationFamily: presentationFamily(sessionType),
    presentationLabel: LABELS[sessionType],
    milestone1GenerationEnabled: MILESTONE_1_GENERATION_TYPES.has(sessionType),
    typedWorkoutGenerationEnabled: true,
  }));

export const TRAINING_PLAN_MODE_CAPABILITIES: ReadonlyArray<{
  planMode: TrainingPlanMode;
  milestone1GenerationEnabled: boolean;
  typedWorkoutGenerationEnabled: true;
}> = [
  { planMode: 'event_based', milestone1GenerationEnabled: false, typedWorkoutGenerationEnabled: true },
  { planMode: 'continuous', milestone1GenerationEnabled: true, typedWorkoutGenerationEnabled: true },
  { planMode: 'maintenance', milestone1GenerationEnabled: false, typedWorkoutGenerationEnabled: true },
  { planMode: 'return_to_training', milestone1GenerationEnabled: false, typedWorkoutGenerationEnabled: true },
];

const BY_SESSION_TYPE = new Map(
  TRAINING_WORKOUT_CAPABILITY_REGISTRY.map((entry) => [entry.sessionType, entry]),
);

export function resolveTrainingWorkoutCapability(rawSessionType: unknown):
  | TrainingWorkoutCapability
  | {
    sessionType: string;
    canonical: false;
    presentationFamily: 'unknown';
    presentationLabel: 'Unknown workout type';
    milestone1GenerationEnabled: false;
    typedWorkoutGenerationEnabled: false;
  } {
  const sessionType = String(rawSessionType ?? '').trim() || 'unknown';
  return BY_SESSION_TYPE.get(sessionType as SessionType) ?? {
    sessionType,
    canonical: false,
    presentationFamily: 'unknown',
    presentationLabel: 'Unknown workout type',
    milestone1GenerationEnabled: false,
    typedWorkoutGenerationEnabled: false,
  };
}
