// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { TrainingPlanRevisionWorkout } from './training-plan-revision-candidate-builder';
import {
  cloneTrainingDocument,
  findTargetWorkout,
  resetBlockPositions,
  workoutSummary,
  type InternalTrainingAdaptationOption,
  type TrainingAdaptationPolicyContext,
} from './training-adaptation-types';

export function buildBusyDayOptions(
  context: TrainingAdaptationPolicyContext,
): InternalTrainingAdaptationOption[] {
  if (context.input.kind !== 'BUSY_DAY') throw new Error('TRAINING_BUSY_DAY_EXPLICIT_INPUT_REQUIRED');
  const target = findTargetWorkout(context.document, context.target.workoutKey);
  if (!target) throw new Error('TRAINING_ADAPTATION_WORKOUT_NOT_FOUND');
  const current = target.workout;
  const available = context.input.availableMinutes;
  if (!Number.isSafeInteger(available) || available <= 0) {
    throw new Error('TRAINING_BUSY_DAY_AVAILABLE_MINUTES_INVALID');
  }
  const options = [shortenOption(context, current, available)];
  options.push(rescheduleOption(context, current));
  options.push(splitOption(context, current, available));
  options.push(keepOption(current, 'BUSY_DAY'));
  return options;
}

function shortenOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
  availableMinutes: number,
): InternalTrainingAdaptationOption {
  const essentialMinimum = current.blocks
    .filter((block) => block.priority === 'ESSENTIAL')
    .reduce((total, block) => total + block.minimumDurationMinutes, 0);
  if (availableMinutes >= current.plannedDurationMinutes) {
    return unavailable('SHORTEN_MINIMUM_EFFECTIVE', current, 'The original workout already fits the available time.');
  }
  if (availableMinutes < essentialMinimum) {
    return unavailable(
      'SHORTEN_MINIMUM_EFFECTIVE',
      current,
      `Shortening is unavailable because ${availableMinutes} minutes is below the ${essentialMinimum}-minute essential minimum.`,
    );
  }
  const document = cloneTrainingDocument(context.document);
  const proposed = findTargetWorkout(document, current.workoutKey)!.workout;
  const removed: Array<{ blockId: string; priority: string; minutes: number }> = [];
  const reduced: Array<{ blockId: string; before: number; after: number }> = [];
  const prescriptionDifferences: InternalTrainingAdaptationOption['exactDifferences'] = [];

  for (let index = proposed.blocks.length - 1; index >= 0
    && totalDuration(proposed) > availableMinutes; index -= 1) {
    const block = proposed.blocks[index];
    if (block.priority !== 'OPTIONAL') continue;
    removed.push({ blockId: block.blockId, priority: block.priority, minutes: block.plannedDurationMinutes });
    proposed.blocks.splice(index, 1);
  }
  for (let index = proposed.blocks.length - 1; index >= 0
    && totalDuration(proposed) > availableMinutes; index -= 1) {
    const block = proposed.blocks[index];
    if (block.priority !== 'RECOMMENDED') continue;
    const excess = totalDuration(proposed) - availableMinutes;
    const reducible = block.plannedDurationMinutes - block.minimumDurationMinutes;
    const reduction = Math.min(excess, reducible);
    if (reduction <= 0) continue;
    const before = block.plannedDurationMinutes;
    const after = before - reduction;
    const aligned = compressBlockPrescription(block, after, current.workoutKey);
    if (!aligned) continue;
    prescriptionDifferences.push(...aligned);
    reduced.push({ blockId: block.blockId, before, after: block.plannedDurationMinutes });
    if (block.plannedDurationMinutes === 0 && block.minimumDurationMinutes === 0) {
      removed.push({ blockId: block.blockId, priority: block.priority, minutes: before });
      proposed.blocks.splice(index, 1);
    }
  }
  for (let index = proposed.blocks.length - 1; index >= 0
    && totalDuration(proposed) > availableMinutes; index -= 1) {
    const block = proposed.blocks[index];
    if (block.priority !== 'ESSENTIAL') continue;
    const excess = totalDuration(proposed) - availableMinutes;
    const reducible = block.plannedDurationMinutes - block.minimumDurationMinutes;
    const reduction = Math.min(excess, reducible);
    if (reduction <= 0) continue;
    const before = block.plannedDurationMinutes;
    const after = before - reduction;
    const aligned = compressBlockPrescription(block, after, current.workoutKey);
    if (!aligned) continue;
    prescriptionDifferences.push(...aligned);
    reduced.push({ blockId: block.blockId, before, after: block.plannedDurationMinutes });
  }
  resetBlockPositions(proposed);
  if (proposed.plannedDurationMinutes > availableMinutes) {
    return unavailable(
      'SHORTEN_MINIMUM_EFFECTIVE', current,
      'Optional and recommended work cannot be reduced enough without cutting essential work below its minimum.',
    );
  }
  const differences = [
    { path: `workouts.${current.workoutKey}.plannedDurationMinutes`, before: current.plannedDurationMinutes, after: proposed.plannedDurationMinutes },
    ...removed.map((entry) => ({ path: `workouts.${current.workoutKey}.blocks.${entry.blockId}`, before: entry, after: null })),
    ...reduced.map((entry) => ({ path: `workouts.${current.workoutKey}.blocks.${entry.blockId}.plannedDurationMinutes`, before: entry.before, after: entry.after })),
    ...prescriptionDifferences,
  ];
  return {
    optionId: '', optionKind: 'SHORTEN_MINIMUM_EFFECTIVE', scope: 'SESSION', eligible: true,
    suppressionReason: null, currentState: workoutSummary(current), proposedState: workoutSummary(proposed),
    exactDifferences: differences,
    rationale: 'Fit today’s session to the explicit time limit while preserving every essential block at or above its minimum.',
    evidence: [`explicit_available_minutes:${availableMinutes}`, `essential_minimum_minutes:${essentialMinimum}`, 'priority_order:OPTIONAL_BEFORE_RECOMMENDED'],
    expectedBenefit: `Completes the workout’s primary objective in ${proposed.plannedDurationMinutes} minutes.`,
    possibleDownside: 'Accessory volume may be lower than originally planned.',
    reversibility: 'Only this uncompleted session changes; the original revision remains immutable.',
    futureSessionEffect: 'No work is carried forward automatically; later sessions remain unchanged.',
    approvalRequired: true, objectivePreserved: true, proposedDocument: document,
    materialKey: `busy:shorten:${current.workoutKey}:${availableMinutes}`,
  };
}

function rescheduleOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
): InternalTrainingAdaptationOption {
  void context;
  return unavailable(
    'RESCHEDULE',
    current,
    'Reschedule remains unavailable until the backend verifies a fresh replacement window and calendar ownership.',
  );
}

function splitOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
  firstWindowMinutes: number,
): InternalTrainingAdaptationOption {
  void context;
  void firstWindowMinutes;
  return unavailable(
    'SPLIT_SESSION',
    current,
    'Split remains unavailable until two server-authoritative windows and a split projection contract are verified.',
  );
}

function keepOption(current: TrainingPlanRevisionWorkout, trigger: string): InternalTrainingAdaptationOption {
  return {
    optionId: '', optionKind: 'KEEP_ORIGINAL', scope: 'SESSION', eligible: true, suppressionReason: null,
    currentState: workoutSummary(current), proposedState: workoutSummary(current), exactDifferences: [],
    rationale: 'Keep the current immutable workout exactly as approved.', evidence: [`explicit_trigger:${trigger}`],
    expectedBenefit: 'Preserves the complete planned stimulus.', possibleDownside: 'It may not fit today’s stated constraint.',
    reversibility: 'No change is made.', futureSessionEffect: 'No future session changes.',
    approvalRequired: false, objectivePreserved: true, proposedDocument: null,
    materialKey: `${trigger.toLowerCase()}:keep:${current.workoutKey}`,
  };
}

function unavailable(
  optionKind: InternalTrainingAdaptationOption['optionKind'],
  current: TrainingPlanRevisionWorkout,
  reason: string,
): InternalTrainingAdaptationOption {
  return {
    optionId: '', optionKind, scope: 'SESSION', eligible: false, suppressionReason: reason,
    currentState: workoutSummary(current), proposedState: null, exactDifferences: [], rationale: reason,
    evidence: [], expectedBenefit: 'No unsafe change is proposed.', possibleDownside: 'This option is unavailable.',
    reversibility: 'No change is made.', futureSessionEffect: 'No future session changes.',
    approvalRequired: false, objectivePreserved: true, proposedDocument: null,
    materialKey: `unavailable:${optionKind}:${current.workoutKey}`,
  };
}

function totalDuration(workout: TrainingPlanRevisionWorkout): number {
  return workout.blocks.reduce((total, block) => total + block.plannedDurationMinutes, 0);
}

function compressBlockPrescription(
  block: TrainingPlanRevisionWorkout['blocks'][number],
  resultingMinutes: number,
  workoutKey: string,
): InternalTrainingAdaptationOption['exactDifferences'] | null {
  const candidate = JSON.parse(JSON.stringify(block)) as typeof block;
  const beforePrescription = JSON.parse(JSON.stringify(block.prescription)) as unknown;
  const beforeExercises = JSON.parse(JSON.stringify(block.exercises ?? [])) as typeof block.exercises;
  const ratio = resultingMinutes / Math.max(1, block.plannedDurationMinutes);
  candidate.plannedDurationMinutes = resultingMinutes;
  if (candidate.prescription.kind === 'steady_endurance' || candidate.prescription.kind === 'cycling') {
    if (candidate.prescription.durationMinutes == null) return null;
    candidate.prescription.durationMinutes = resultingMinutes;
  } else if (candidate.prescription.kind === 'recovery') {
    candidate.prescription.durationMinutes = resultingMinutes;
  } else if (candidate.prescription.kind === 'strength') {
    candidate.prescription.sets = Math.max(1, Math.floor(candidate.prescription.sets * ratio));
    for (const exercise of candidate.exercises ?? []) {
      exercise.prescription.sets = Math.max(1, Math.floor(exercise.prescription.sets * ratio));
    }
  } else if (candidate.prescription.kind === 'intervals') {
    candidate.prescription.repetitions = Math.max(1, Math.floor(candidate.prescription.repetitions * ratio));
  } else if (candidate.prescription.kind === 'swimming') {
    const distancePerRepeat = Math.max(
      25,
      Math.floor(candidate.prescription.totalDistanceMeters / Math.max(1, candidate.prescription.repetitions)),
    );
    candidate.prescription.repetitions = Math.max(1, Math.floor(candidate.prescription.repetitions * ratio));
    candidate.prescription.totalDistanceMeters = Math.max(
      distancePerRepeat,
      candidate.prescription.repetitions * distancePerRepeat,
    );
  } else if (candidate.prescription.kind === 'mobility') {
    candidate.prescription.durationSecondsPerSide = Math.max(
      10,
      Math.floor(candidate.prescription.durationSecondsPerSide * ratio),
    );
  } else {
    return null;
  }
  const prescriptionChanged = JSON.stringify(beforePrescription) !== JSON.stringify(candidate.prescription);
  const exercisesChanged = JSON.stringify(beforeExercises) !== JSON.stringify(candidate.exercises ?? []);
  if (!prescriptionChanged && !exercisesChanged) return null;
  Object.assign(block, candidate);
  const prefix = `workouts.${workoutKey}.blocks.${block.blockId}`;
  return [
    ...(prescriptionChanged ? [{ path: `${prefix}.prescription`, before: beforePrescription, after: candidate.prescription }] : []),
    ...(exercisesChanged ? [{ path: `${prefix}.exercises`, before: beforeExercises, after: candidate.exercises ?? [] }] : []),
  ];
}
