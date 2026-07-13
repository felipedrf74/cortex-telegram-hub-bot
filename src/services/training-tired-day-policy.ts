// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { TrainingPlanRevisionWorkout } from './training-plan-revision-candidate-builder';
import { findLowerComplexitySubstitution } from './training-substitution-service';
import {
  cloneTrainingDocument,
  findTargetWorkout,
  resetBlockPositions,
  targetWorkoutKeysForScope,
  workoutSummary,
  type InternalTrainingAdaptationOption,
  type TrainingAdaptationPolicyContext,
  type TrainingAdaptationScope,
} from './training-adaptation-types';

export function buildTiredDayOptions(
  context: TrainingAdaptationPolicyContext,
): InternalTrainingAdaptationOption[] {
  if (context.input.kind !== 'TIRED_DAY'
      || context.input.selfReport !== 'MORE_TIRED_THAN_EXPECTED') {
    throw new Error('TRAINING_TIRED_DAY_EXPLICIT_INPUT_REQUIRED');
  }
  const target = findTargetWorkout(context.document, context.target.workoutKey);
  if (!target) throw new Error('TRAINING_ADAPTATION_WORKOUT_NOT_FOUND');
  const repeated = Math.max(1, context.authoritativeFreshTiredReportCount ?? 1);
  const weekThreshold = boundedThreshold(context.tiredWeekThreshold, 2);
  const phaseThreshold = Math.max(weekThreshold + 1, boundedThreshold(context.tiredPhaseThreshold, 3));
  const allowedScope: TrainingAdaptationScope = repeated >= phaseThreshold
    ? 'PHASE' : repeated >= weekThreshold ? 'WEEK' : 'SESSION';
  if (context.requestedScope === 'FULL_PLAN'
      || scopeRank(context.requestedScope) > scopeRank(allowedScope)) {
    throw new Error('TRAINING_TIRED_DAY_SCOPE_EVIDENCE_INSUFFICIENT');
  }
  return [
    reduceVolumeOption(context, target.workout, context.requestedScope, repeated),
    reduceIntensityOption(context, target.workout),
    lowerComplexityOption(context, target.workout),
    rescheduleOption(context, target.workout),
    keepOption(target.workout),
  ];
}

function reduceVolumeOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
  scope: TrainingAdaptationScope,
  repeatedCount: number,
): InternalTrainingAdaptationOption {
  const document = cloneTrainingDocument(context.document);
  const immutable = new Set(context.immutableWorkoutKeys ?? []);
  const workoutKeys = targetWorkoutKeysForScope(document, current.workoutKey, scope)
    .filter((key) => !immutable.has(key));
  const differences: InternalTrainingAdaptationOption['exactDifferences'] = [];
  for (const key of workoutKeys) {
    const workout = findTargetWorkout(document, key)!.workout;
    for (const block of workout.blocks) {
      if (block.priority !== 'RECOMMENDED') continue;
      const before = block.plannedDurationMinutes;
      const after = Math.max(block.minimumDurationMinutes, Math.floor(before * 0.75));
      if (after >= before) continue;
      block.plannedDurationMinutes = after;
      alignDurationPrescription(block);
      differences.push({
        path: `workouts.${key}.blocks.${block.blockId}.plannedDurationMinutes`, before, after,
      });
    }
    if (!differences.some((entry) => entry.path.startsWith(`workouts.${key}.`))) {
      const primary = workout.blocks.find((block) => block.priority === 'ESSENTIAL'
        && block.blockType === 'PRIMARY_WORK' && block.exercises?.some((exercise) => exercise.prescription.sets > 1));
      const exercise = primary?.exercises?.find((entry) => entry.prescription.sets > 1);
      if (exercise) {
        const before = exercise.prescription.sets;
        exercise.prescription.sets = before - 1;
        differences.push({
          path: `workouts.${key}.blocks.${primary!.blockId}.exercises.${exercise.exerciseId}.sets`,
          before, after: exercise.prescription.sets,
        });
      }
    }
    resetBlockPositions(workout);
  }
  if (differences.length === 0) return unavailable('REDUCE_VOLUME', current, 'No volume can be reduced without crossing an essential minimum.');
  const proposed = findTargetWorkout(document, current.workoutKey)!.workout;
  return {
    optionId: '', optionKind: 'REDUCE_VOLUME', scope, eligible: true, suppressionReason: null,
    currentState: workoutSummary(current), proposedState: workoutSummary(proposed), exactDifferences: differences,
    rationale: 'Respond to the explicit tiredness report by reducing work volume without diagnosing a condition.',
    evidence: [`explicit_tired_input:true`, `fresh_report_count:${repeatedCount}`, `scope:${scope}`],
    expectedBenefit: 'Reduces today’s training load while preserving each workout’s primary objective.',
    possibleDownside: 'The planned progression stimulus is smaller.',
    reversibility: 'The source revision remains immutable; only uncompleted sessions in the declared scope change.',
    futureSessionEffect: scope === 'SESSION'
      ? 'Only today’s session changes.'
      : scope === 'WEEK' ? 'Remaining matching workouts in the current week carry reduced volume.'
        : 'Matching uncompleted workouts in the current phase carry reduced volume.',
    approvalRequired: true, objectivePreserved: true, proposedDocument: document,
    materialKey: `tired:volume:${scope}:${current.workoutKey}:${repeatedCount}`,
  };
}

function reduceIntensityOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
): InternalTrainingAdaptationOption {
  const document = cloneTrainingDocument(context.document);
  const proposed = findTargetWorkout(document, current.workoutKey)!.workout;
  const differences: InternalTrainingAdaptationOption['exactDifferences'] = [];
  for (const block of proposed.blocks) {
    const before = JSON.parse(JSON.stringify(block.prescription)) as unknown;
    const blockChanged = reducePrescriptionIntensity(block.prescription);
    if (blockChanged) {
      differences.push({
        path: `workouts.${current.workoutKey}.blocks.${block.blockId}.prescription`,
        before,
        after: block.prescription,
      });
    }
    for (const exercise of block.exercises ?? []) {
      const exerciseBefore = JSON.parse(JSON.stringify(exercise.prescription)) as unknown;
      if (!reducePrescriptionIntensity(exercise.prescription)) continue;
      differences.push({
        path: `workouts.${current.workoutKey}.blocks.${block.blockId}.exercises.${exercise.exerciseId}.prescription`,
        before: exerciseBefore,
        after: exercise.prescription,
      });
    }
  }
  if (differences.length === 0) return unavailable('REDUCE_INTENSITY', current, 'This workout has no safely reducible intensity target.');
  return {
    optionId: '', optionKind: 'REDUCE_INTENSITY', scope: 'SESSION', eligible: true, suppressionReason: null,
    currentState: workoutSummary(current), proposedState: workoutSummary(proposed), exactDifferences: differences,
    rationale: 'Lower today’s prescribed effort from explicit user input without inferring a diagnosis.',
    evidence: ['explicit_tired_input:true', 'scope:SESSION'],
    expectedBenefit: 'Preserves the workout structure at a lower effort target.',
    possibleDownside: 'The high-intensity stimulus is reduced for this session.',
    reversibility: 'Only this uncompleted session changes and the source revision remains immutable.',
    futureSessionEffect: 'The current week and future phase remain unchanged.', approvalRequired: true,
    objectivePreserved: true, proposedDocument: document,
    materialKey: `tired:intensity:SESSION:${current.workoutKey}`,
  };
}

function lowerComplexityOption(
  context: TrainingAdaptationPolicyContext,
  current: TrainingPlanRevisionWorkout,
): InternalTrainingAdaptationOption {
  const input = context.input.kind === 'TIRED_DAY' ? context.input : null;
  const source = current.blocks.flatMap((block) => (block.exercises ?? []).map((exercise) => ({ block, exercise })))[0];
  if (!source || !source.block.objectiveId) {
    return unavailable('LOWER_COMPLEXITY_SUBSTITUTION', current, 'No objective-bound exercise is available for a lower-complexity substitution.');
  }
  const alternative = findLowerComplexitySubstitution(
    source.exercise.exerciseId,
    intersectEquipment(
      context.authoritativeEquipmentIds ?? [],
      input?.availableEquipmentIds,
    ),
    [...new Set([...(context.authoritativeExclusions ?? []), ...(input?.exclusions ?? [])])],
  );
  if (!alternative) {
    return unavailable('LOWER_COMPLEXITY_SUBSTITUTION', current, 'No lower-complexity compatible exercise preserves the same movement role and objective.');
  }
  const document = cloneTrainingDocument(context.document);
  const proposed = findTargetWorkout(document, current.workoutKey)!.workout;
  const block = proposed.blocks.find((entry) => entry.blockId === source.block.blockId)!;
  const exercise = block.exercises!.find((entry) => entry.exerciseId === source.exercise.exerciseId)!;
  const before = JSON.parse(JSON.stringify(exercise)) as unknown;
  exercise.exerciseId = alternative.id;
  exercise.name = alternative.name;
  exercise.selectionReasons = [
    `preserves objective ${source.block.objectiveId}`,
    `uses a lower-complexity ${alternative.movementPattern} movement`,
    'responds only to explicit tiredness input',
  ];
  return {
    optionId: '', optionKind: 'LOWER_COMPLEXITY_SUBSTITUTION', scope: 'SESSION', eligible: true,
    suppressionReason: null, currentState: workoutSummary(current), proposedState: workoutSummary(proposed),
    exactDifferences: [{ path: `workouts.${current.workoutKey}.blocks.${block.blockId}.exercises.${source.exercise.exerciseId}`, before, after: exercise }],
    rationale: 'Use a lower-complexity movement that preserves the block objective and movement role.',
    evidence: [`objective_id:${source.block.objectiveId}`, 'explicit_tired_input:true'],
    expectedBenefit: 'Reduces skill demand while keeping the intended movement role.',
    possibleDownside: 'The alternative may provide a smaller skill-specific stimulus.',
    reversibility: 'Only this uncompleted session changes.', futureSessionEffect: 'Future sessions remain unchanged.',
    approvalRequired: true, objectivePreserved: true, proposedDocument: document,
    materialKey: `tired:complexity:${source.block.objectiveId}:${source.exercise.exerciseId}:${alternative.id}`,
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

function keepOption(current: TrainingPlanRevisionWorkout): InternalTrainingAdaptationOption {
  return {
    optionId: '', optionKind: 'KEEP_ORIGINAL', scope: 'SESSION', eligible: true, suppressionReason: null,
    currentState: workoutSummary(current), proposedState: workoutSummary(current), exactDifferences: [],
    rationale: 'Keep the current workout without applying a material change.', evidence: ['explicit_tired_input:true'],
    expectedBenefit: 'Preserves the complete planned stimulus.', possibleDownside: 'It may not match today’s self-reported energy.',
    reversibility: 'No change is made.', futureSessionEffect: 'No future session changes.', approvalRequired: false,
    objectivePreserved: true, proposedDocument: null, materialKey: `tired:keep:${current.workoutKey}`,
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
    evidence: ['explicit_tired_input:true'], expectedBenefit: 'No unsafe change is proposed.',
    possibleDownside: 'This option is unavailable.', reversibility: 'No change is made.',
    futureSessionEffect: 'No future session changes.', approvalRequired: false, objectivePreserved: true,
    proposedDocument: null, materialKey: `tired:unavailable:${optionKind}:${current.workoutKey}`,
  };
}

function reducePrescriptionIntensity(prescription: TrainingPlanRevisionWorkout['blocks'][number]['prescription']): boolean {
  if (prescription.kind === 'strength') {
    prescription.targetRpe = Math.max(1, prescription.targetRpe - 1);
    prescription.targetRir = Math.min(10, prescription.targetRir + 1);
    prescription.loadGuidance = `Use a lighter load than originally planned. ${prescription.loadGuidance}`;
    return true;
  }
  if (prescription.kind === 'intervals') {
    prescription.targetIntensity = `Reduced target: ${prescription.targetIntensity}`;
    return true;
  }
  if (prescription.kind === 'steady_endurance' || prescription.kind === 'cycling') {
    prescription.effortZone = `One zone below ${prescription.effortZone}`;
    return true;
  }
  if (prescription.kind === 'swimming') {
    prescription.targetIntensity = `Easy version of ${prescription.targetIntensity}`;
    return true;
  }
  return false;
}

function alignDurationPrescription(block: TrainingPlanRevisionWorkout['blocks'][number]): void {
  if ((block.prescription.kind === 'steady_endurance' || block.prescription.kind === 'cycling')
      && block.prescription.durationMinutes != null) block.prescription.durationMinutes = block.plannedDurationMinutes;
  if (block.prescription.kind === 'recovery') block.prescription.durationMinutes = block.plannedDurationMinutes;
}

function scopeRank(scope: TrainingAdaptationScope): number {
  return scope === 'SESSION' ? 1 : scope === 'WEEK' ? 2 : scope === 'PHASE' ? 3 : 4;
}

function boundedThreshold(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 2 && Number(value) <= 20
    ? Number(value) : fallback;
}

function intersectEquipment(authoritative: string[], explicit: string[] | undefined): string[] {
  if (!explicit?.length) return authoritative;
  const allowed = new Set(explicit);
  return authoritative.filter((equipmentId) => allowed.has(equipmentId));
}
