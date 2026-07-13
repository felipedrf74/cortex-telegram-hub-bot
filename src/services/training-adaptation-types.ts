// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DayOfWeek } from './coach-kernel/types';
import type {
  TrainingPlanRevisionDocument,
  TrainingPlanRevisionWorkout,
} from './training-plan-revision-candidate-builder';

export const TRAINING_ADAPTATION_POLICY_VERSION = 'training-adaptation-policy.v1' as const;
export const TRAINING_ADAPTATION_API_SCHEMA = 'training_adaptation_api.v1' as const;

export type TrainingAdaptationScope = 'SESSION' | 'WEEK' | 'PHASE' | 'FULL_PLAN';
export type TrainingAdaptationTriggerKind = 'BUSY_DAY' | 'TIRED_DAY' | 'SUBSTITUTION' | 'REFLOW';
export type TrainingAdaptationOptionKind =
  | 'SHORTEN_MINIMUM_EFFECTIVE'
  | 'RESCHEDULE'
  | 'SPLIT_SESSION'
  | 'KEEP_ORIGINAL'
  | 'REDUCE_VOLUME'
  | 'REDUCE_INTENSITY'
  | 'LOWER_COMPLEXITY_SUBSTITUTION'
  | 'PURPOSEFUL_SUBSTITUTION';

export interface TrainingAdaptationTarget {
  workoutKey: string;
  sessionId?: string;
  blockId?: string;
  exerciseId?: string;
}

export type TrainingAdaptationExplicitInput =
  | {
    kind: 'BUSY_DAY';
    availableMinutes: number;
    secondWindowMinutes?: number;
    secondWindowGapMinutes?: number;
    rescheduleDay?: DayOfWeek;
    authoritativeScheduleVersion?: string;
  }
  | {
    kind: 'TIRED_DAY';
    selfReport: 'MORE_TIRED_THAN_EXPECTED';
    reportedLevel?: 'SLIGHTLY' | 'MORE_THAN_EXPECTED' | 'VERY_TIRED';
    availableEquipmentIds?: string[];
    exclusions?: string[];
    rescheduleDay?: DayOfWeek;
    authoritativeScheduleVersion?: string;
  }
  | {
    kind: 'SUBSTITUTION';
    reason: 'EQUIPMENT' | 'EXCLUSION';
    originalExerciseId: string;
    unavailableEquipmentIds: string[];
    exclusions: string[];
    proposedExerciseId?: string;
  }
  | {
    kind: 'REFLOW';
  };

export interface TrainingAdaptationDifference {
  path: string;
  before: unknown;
  after: unknown;
}

export interface TrainingAdaptationOption {
  optionId: string;
  optionKind: TrainingAdaptationOptionKind;
  scope: TrainingAdaptationScope;
  eligible: boolean;
  suppressionReason: string | null;
  currentState: unknown;
  proposedState: unknown;
  exactDifferences: TrainingAdaptationDifference[];
  rationale: string;
  evidence: string[];
  expectedBenefit: string;
  possibleDownside: string;
  reversibility: string;
  futureSessionEffect: string;
  approvalRequired: boolean;
  objectivePreserved: boolean;
}

export interface InternalTrainingAdaptationOption extends TrainingAdaptationOption {
  proposedDocument: TrainingPlanRevisionDocument | null;
  materialKey: string;
}

export interface TrainingAdaptationPolicyContext {
  document: TrainingPlanRevisionDocument;
  target: TrainingAdaptationTarget;
  requestedScope: TrainingAdaptationScope;
  input: TrainingAdaptationExplicitInput;
  authoritativeFreshTiredReportCount?: number;
  tiredWeekThreshold?: number;
  tiredPhaseThreshold?: number;
  immutableWorkoutKeys?: string[];
  authoritativeEquipmentIds?: string[];
  authoritativeExclusions?: string[];
  authoritativePreferences?: string[];
}

export function findTargetWorkout(
  document: TrainingPlanRevisionDocument,
  workoutKey: string,
): { weekIndex: number; workoutIndex: number; workout: TrainingPlanRevisionWorkout } | null {
  for (const [weekIndex, week] of document.weeks.entries()) {
    const workoutIndex = week.workouts.findIndex((entry) => entry.workoutKey === workoutKey);
    if (workoutIndex >= 0) return { weekIndex, workoutIndex, workout: week.workouts[workoutIndex] };
  }
  return null;
}

export function cloneTrainingDocument(document: TrainingPlanRevisionDocument): TrainingPlanRevisionDocument {
  return JSON.parse(JSON.stringify(document)) as TrainingPlanRevisionDocument;
}

export function workoutSummary(workout: TrainingPlanRevisionWorkout): Record<string, unknown> {
  return {
    workoutKey: workout.workoutKey,
    dayOfWeek: workout.dayOfWeek,
    title: workout.title,
    objective: workout.objective,
    plannedDurationMinutes: workout.plannedDurationMinutes,
    scheduledDate: workout.scheduledDate ?? null,
    scheduledStartAt: workout.scheduledStartAt ?? null,
    scheduledEndAt: workout.scheduledEndAt ?? null,
    scheduleTimeZone: workout.scheduleTimeZone ?? null,
    blocks: workout.blocks,
  };
}

export function resetBlockPositions(workout: TrainingPlanRevisionWorkout): void {
  workout.blocks = workout.blocks.map((block, index) => ({ ...block, position: index + 1 }));
  workout.plannedDurationMinutes = workout.blocks.reduce(
    (total, block) => total + block.plannedDurationMinutes,
    0,
  );
}

export function targetWorkoutKeysForScope(
  document: TrainingPlanRevisionDocument,
  targetWorkoutKey: string,
  scope: TrainingAdaptationScope,
): string[] {
  const target = findTargetWorkout(document, targetWorkoutKey);
  if (!target) return [];
  if (scope === 'SESSION') return [targetWorkoutKey];
  if (scope === 'WEEK') return document.weeks[target.weekIndex].workouts.map((entry) => entry.workoutKey);
  if (scope === 'PHASE') {
    const phaseKey = document.weeks[target.weekIndex].phaseKey;
    return document.weeks
      .filter((week) => week.phaseKey === phaseKey)
      .flatMap((week) => week.workouts.map((entry) => entry.workoutKey));
  }
  return document.weeks.flatMap((week) => week.workouts.map((entry) => entry.workoutKey));
}
