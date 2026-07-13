// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getExerciseComplexity, getExercisePrimaryPurpose } from './coach-kernel/exercise-metadata';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import type { Exercise } from './coach-kernel/types';
import {
  cloneTrainingDocument,
  findTargetWorkout,
  workoutSummary,
  type InternalTrainingAdaptationOption,
  type TrainingAdaptationPolicyContext,
} from './training-adaptation-types';

export function buildPurposefulSubstitutionOptions(
  context: TrainingAdaptationPolicyContext,
): InternalTrainingAdaptationOption[] {
  if (context.input.kind !== 'SUBSTITUTION') throw new Error('TRAINING_SUBSTITUTION_EXPLICIT_INPUT_REQUIRED');
  const input = context.input;
  const target = findTargetWorkout(context.document, context.target.workoutKey);
  if (!target) throw new Error('TRAINING_ADAPTATION_WORKOUT_NOT_FOUND');
  const block = target.workout.blocks.find((entry) => entry.blockId === context.target.blockId);
  if (!block?.objectiveId || !block.exercises?.length || !context.target.exerciseId) {
    return [unavailable(context, 'A stable block objective, block ID, and original exercise ID are required.')];
  }
  const originalPrescription = block.exercises.find((entry) => entry.exerciseId === context.target.exerciseId);
  if (!originalPrescription) return [unavailable(context, 'The original exercise is not part of the targeted block.')];
  const catalog = loadCoachKnowledge().exercises;
  const original = catalog.find((entry) => entry.id === originalPrescription.exerciseId);
  if (!original) return [unavailable(context, 'The original exercise has no canonical catalog identity.')];
  const allExclusions = [...new Set([...(context.authoritativeExclusions ?? []), ...input.exclusions])];
  const exclusionSet = new Set(allExclusions.map(normalized));
  const unavailableEquipment = new Set(input.unavailableEquipmentIds.map(normalizedEquipment));
  const equipment = new Set((context.authoritativeEquipmentIds ?? [])
    .filter((entry) => !unavailableEquipment.has(normalizedEquipment(entry))));
  const originalExcluded = exclusionSet.has(normalized(original.id)) || exclusionSet.has(normalized(original.name));
  const originalEquipmentCompatible = original.equipment.every((entry) => equipment.has(entry));
  if (input.reason === 'EQUIPMENT' && originalEquipmentCompatible) {
    return [unavailable(context, 'The original exercise already matches the explicitly supplied equipment.')];
  }
  if (input.reason === 'EXCLUSION' && !originalExcluded) {
    return [unavailable(context, 'The original exercise is not present in the explicit exclusion list.')];
  }

  const candidates = rankedCandidates(original, catalog)
    .filter((candidate) => candidate.id !== original.id)
    .filter((candidate) => candidate.movementPattern === original.movementPattern)
    .filter((candidate) => candidate.equipment.every((entry) => equipment.has(entry)))
    .filter((candidate) => !exclusionSet.has(normalized(candidate.id))
      && !exclusionSet.has(normalized(candidate.name)))
    .filter((candidate) => getExercisePrimaryPurpose(candidate) === getExercisePrimaryPurpose(original));
  const selected = input.proposedExerciseId
    ? candidates.find((entry) => entry.id === input.proposedExerciseId)
    : candidates[0];
  if (!selected) return [unavailable(context, 'No equipment-compatible, exclusion-safe alternative preserves the movement role and objective.')];

  const document = cloneTrainingDocument(context.document);
  const proposedWorkout = findTargetWorkout(document, target.workout.workoutKey)!.workout;
  const proposedBlock = proposedWorkout.blocks.find((entry) => entry.blockId === block.blockId)!;
  const index = proposedBlock.exercises!.findIndex((entry) => entry.exerciseId === original.id);
  const difficulty = difficultyRelationship(original, selected);
  const prescription = {
    ...proposedBlock.exercises![index].prescription,
    ...(difficulty === 'HARDER'
      ? { sets: Math.max(1, proposedBlock.exercises![index].prescription.sets - 1) }
      : {}),
  };
  proposedBlock.exercises![index] = {
    ...proposedBlock.exercises![index],
    exerciseId: selected.id,
    name: selected.name,
    prescription,
    selectionReasons: [
      `preserves objective ${block.objectiveId}`,
      `preserves the ${original.movementPattern} movement role`,
      input.reason === 'EQUIPMENT' ? 'fits the explicitly available equipment' : 'respects the explicit exclusion',
    ],
  };
  const changedPrescription = JSON.stringify(prescription) === JSON.stringify(originalPrescription.prescription)
    ? 'Keep the original sets, repetitions, effort, tempo, and rest with the compatible alternative.'
    : `Use ${prescription.sets} sets of ${prescription.repetitions} at the original effort, tempo, and rest guidance.`;
  const substitution = {
    originalExercise: { exerciseId: original.id, name: original.name, equipmentIds: original.equipment },
    proposedAlternative: { exerciseId: selected.id, name: selected.name, equipmentIds: selected.equipment },
    reason: input.reason,
    originalObjectiveId: block.objectiveId,
    preservedObjectiveId: block.objectiveId,
    movementRole: original.movementPattern,
    equipmentCompatible: true,
    difficultySkillRelationship: difficulty,
    changedPrescription,
    exclusionsConsidered: [...allExclusions].sort(),
    preferencesConsidered: [
      ...(context.authoritativePreferences ?? []),
      ...(input.reason === 'EQUIPMENT'
        ? [...input.unavailableEquipmentIds].sort().map((entry) => `unavailable:${entry}`)
        : []),
    ],
  };
  return [{
    optionId: '', optionKind: 'PURPOSEFUL_SUBSTITUTION', scope: 'SESSION', eligible: true,
    suppressionReason: null,
    currentState: { workout: workoutSummary(target.workout), originalExercise: substitution.originalExercise },
    proposedState: { workout: workoutSummary(proposedWorkout), substitution },
    exactDifferences: [{
      path: `workouts.${target.workout.workoutKey}.blocks.${block.blockId}.exercises.${original.id}`,
      before: originalPrescription,
      after: proposedBlock.exercises![index],
    }],
    rationale: input.reason === 'EQUIPMENT'
      ? 'Replace unavailable equipment with the highest-ranked compatible exercise that preserves objective and movement role.'
      : 'Respect the explicit exclusion with a compatible exercise that preserves objective and movement role.',
    evidence: [
      `objective_id:${block.objectiveId}`,
      `movement_role:${original.movementPattern}`,
      `substitution_reason:${input.reason}`,
    ],
    expectedBenefit: 'Keeps the intended training objective while making the exercise executable for the stated constraint.',
    possibleDownside: difficulty === 'SAME'
      ? 'The movement may feel unfamiliar even though its role and difficulty are comparable.'
      : `The alternative is ${difficulty.toLowerCase()}, so the prescription was reviewed for compatibility.`,
    reversibility: 'Only this uncompleted session changes and the original revision remains immutable.',
    futureSessionEffect: 'Later sessions remain unchanged; repeated substitutions do not silently rewrite the profile.',
    approvalRequired: true, objectivePreserved: true, proposedDocument: document,
    materialKey: `substitution:${input.reason}:${block.objectiveId}:${original.id}:${selected.id}`,
  }];
}

export function findLowerComplexitySubstitution(
  exerciseId: string,
  availableEquipmentIds: readonly string[],
  exclusions: readonly string[] = [],
): Exercise | null {
  const catalog = loadCoachKnowledge().exercises;
  const original = catalog.find((entry) => entry.id === exerciseId);
  if (!original) return null;
  const originalRank = complexityRank(original);
  const equipment = new Set(availableEquipmentIds);
  const excluded = new Set(exclusions.map(normalized));
  return rankedCandidates(original, catalog)
    .filter((entry) => entry.id !== original.id
      && entry.movementPattern === original.movementPattern
      && getExercisePrimaryPurpose(entry) === getExercisePrimaryPurpose(original)
      && complexityRank(entry) < originalRank
      && entry.equipment.every((equipmentId) => equipment.has(equipmentId))
      && !excluded.has(normalized(entry.id))
      && !excluded.has(normalized(entry.name)))[0] ?? null;
}

function rankedCandidates(original: Exercise, catalog: Exercise[]): Exercise[] {
  const preferred = new Map(original.substitutions.map((id, index) => [id, index]));
  return [...catalog].sort((left, right) => {
    const preferredLeft = preferred.get(left.id) ?? 10_000;
    const preferredRight = preferred.get(right.id) ?? 10_000;
    return preferredLeft - preferredRight
      || Math.abs(complexityRank(original) - complexityRank(left))
        - Math.abs(complexityRank(original) - complexityRank(right))
      || left.id.localeCompare(right.id);
  });
}

function difficultyRelationship(original: Exercise, alternative: Exercise): 'EASIER' | 'SAME' | 'HARDER' {
  const difference = complexityRank(alternative) - complexityRank(original);
  return difference < 0 ? 'EASIER' : difference > 0 ? 'HARDER' : 'SAME';
}

function complexityRank(exercise: Exercise): number {
  const complexity = getExerciseComplexity(exercise);
  return complexity === 'beginner' ? 1 : complexity === 'intermediate' ? 2 : complexity === 'advanced' ? 3 : 4;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizedEquipment(value: string): string {
  const key = normalized(value);
  const aliases: Record<string, string> = {
    dumbbells: 'dumbbell',
    barbells: 'barbell',
    kettlebells: 'kettlebell',
    resistance_bands: 'band',
    bands: 'band',
  };
  return aliases[key] ?? key;
}

function unavailable(
  context: TrainingAdaptationPolicyContext,
  reason: string,
): InternalTrainingAdaptationOption {
  const workout = findTargetWorkout(context.document, context.target.workoutKey)?.workout;
  return {
    optionId: '', optionKind: 'PURPOSEFUL_SUBSTITUTION', scope: 'SESSION', eligible: false,
    suppressionReason: reason, currentState: workout ? workoutSummary(workout) : null,
    proposedState: null, exactDifferences: [], rationale: reason, evidence: [],
    expectedBenefit: 'No random or incompatible alternative is proposed.',
    possibleDownside: 'The original exercise remains unchanged.', reversibility: 'No change is made.',
    futureSessionEffect: 'No future session changes.', approvalRequired: false, objectivePreserved: false,
    proposedDocument: null, materialKey: `substitution:unavailable:${context.target.workoutKey}`,
  };
}
