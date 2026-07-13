// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { buildTrainingPlanRevisionCandidate } from '../../src/services/training-plan-revision-candidate-builder';
import { buildBusyDayOptions } from '../../src/services/training-busy-day-policy';
import { buildTiredDayOptions } from '../../src/services/training-tired-day-policy';
import { buildPurposefulSubstitutionOptions } from '../../src/services/training-substitution-service';
import { findTargetWorkout } from '../../src/services/training-adaptation-types';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';

const allEquipment = [...new Set(loadCoachKnowledge().exercises.flatMap((exercise) => exercise.equipment))];

const document = buildTrainingPlanRevisionCandidate({
  planMode: 'continuous', goal: 'general_fitness', discipline: 'strength', horizonWeeks: 4,
  profile: {
    experienceLevel: 'intermediate', sessionsPerWeek: 3, sessionDurationMinutes: 60,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: allEquipment, location: 'gym',
  },
}, { typedWorkoutValidationEnabled: true }).document;

const workout = document.weeks.flatMap((week) => week.workouts)
  .find((entry) => entry.sessionType.startsWith('strength_'))!;
const optional = workout.blocks.find((block) => block.priority === 'OPTIONAL')!;
const recommended = {
  ...JSON.parse(JSON.stringify(optional)),
  blockId: 'test-secondary-work',
  position: optional.position,
  blockType: 'SECONDARY_WORK' as const,
  purpose: 'Test-only accessory work with a reducible minimum.',
  priority: 'RECOMMENDED' as const,
  minimumDurationMinutes: Math.min(3, optional.plannedDurationMinutes),
  plannedDurationMinutes: Math.max(5, optional.plannedDurationMinutes),
};
optional.position += 1;
workout.blocks.splice(optional.position - 2, 0, recommended);
workout.plannedDurationMinutes = workout.blocks.reduce((sum, block) => sum + block.plannedDurationMinutes, 0);

describe('Training adaptation policies', () => {
  it('removes OPTIONAL before reducing RECOMMENDED and never crosses an ESSENTIAL minimum', () => {
    const essentialMinimum = workout.blocks
      .filter((block) => block.priority === 'ESSENTIAL')
      .reduce((sum, block) => sum + block.minimumDurationMinutes, 0);
    const options = buildBusyDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'SESSION',
      input: { kind: 'BUSY_DAY', availableMinutes: essentialMinimum + 5 },
    });
    const shorten = options.find((entry) => entry.optionKind === 'SHORTEN_MINIMUM_EFFECTIVE')!;
    expect(shorten.eligible).toBe(true);
    const proposed = findTargetWorkout(shorten.proposedDocument!, workout.workoutKey)!.workout;
    for (const original of workout.blocks.filter((block) => block.priority === 'ESSENTIAL')) {
      const after = proposed.blocks.find((block) => block.blockId === original.blockId);
      expect(after?.plannedDurationMinutes).toBeGreaterThanOrEqual(original.minimumDurationMinutes);
    }
    const recommendedWasReduced = workout.blocks.some((block) => block.priority === 'RECOMMENDED'
      && (proposed.blocks.find((entry) => entry.blockId === block.blockId)?.plannedDurationMinutes ?? 0)
        < block.plannedDurationMinutes);
    if (recommendedWasReduced) {
      expect(proposed.blocks.filter((block) => block.priority === 'OPTIONAL')).toHaveLength(0);
      expect(shorten.exactDifferences.some((difference) =>
        difference.path.endsWith('.prescription') || difference.path.endsWith('.exercises'))).toBe(true);
    }
    expect(proposed.plannedDurationMinutes).toBeLessThanOrEqual(essentialMinimum + 5);
  });

  it('suppresses shortening below the essential minimum and split without authoritative recovery proof', () => {
    const essentialMinimum = workout.blocks
      .filter((block) => block.priority === 'ESSENTIAL')
      .reduce((sum, block) => sum + block.minimumDurationMinutes, 0);
    const below = buildBusyDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'SESSION',
      input: { kind: 'BUSY_DAY', availableMinutes: essentialMinimum - 1 },
    });
    expect(below.find((entry) => entry.optionKind === 'SHORTEN_MINIMUM_EFFECTIVE')).toMatchObject({
      eligible: false,
      suppressionReason: expect.stringContaining('essential minimum'),
    });
    expect(below.find((entry) => entry.optionKind === 'SPLIT_SESSION')).toMatchObject({
      eligible: false,
      suppressionReason: expect.stringContaining('authoritative'),
    });
  });

  it('requires explicit tired input and uses only server-authoritative fresh counts for scope escalation', () => {
    expect(() => buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'SESSION',
      input: { kind: 'BUSY_DAY', availableMinutes: 30 },
    })).toThrow(/EXPLICIT_INPUT_REQUIRED/);
    expect(() => buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'WEEK',
      input: { kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED' },
      authoritativeFreshTiredReportCount: 1, tiredWeekThreshold: 2, tiredPhaseThreshold: 3,
    })).toThrow(/SCOPE_EVIDENCE_INSUFFICIENT/);
    expect(buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'WEEK',
      input: { kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED' },
      authoritativeFreshTiredReportCount: 2, tiredWeekThreshold: 2, tiredPhaseThreshold: 3,
    }).find((entry) => entry.optionKind === 'REDUCE_VOLUME')).toMatchObject({ eligible: true, scope: 'WEEK' });
    expect(buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'PHASE',
      input: { kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED' },
      authoritativeFreshTiredReportCount: 3, tiredWeekThreshold: 2, tiredPhaseThreshold: 3,
    }).find((entry) => entry.optionKind === 'REDUCE_VOLUME')).toMatchObject({ eligible: true, scope: 'PHASE' });
    const intensity = buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'SESSION',
      input: { kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED' },
      authoritativeFreshTiredReportCount: 1, tiredWeekThreshold: 2, tiredPhaseThreshold: 3,
    }).find((entry) => entry.optionKind === 'REDUCE_INTENSITY')!;
    expect(intensity.exactDifferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('.exercises.') }),
    ]));
    expect(buildTiredDayOptions({
      document, target: { workoutKey: workout.workoutKey }, requestedScope: 'SESSION',
      input: {
        kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED',
        rescheduleDay: 'saturday', authoritativeScheduleVersion: 'schedule-v2',
      },
    }).find((entry) => entry.optionKind === 'RESCHEDULE')).toMatchObject({
      eligible: false,
      suppressionReason: expect.stringContaining('backend verifies'),
    });
  });

  it('produces an objective-preserving explicit exclusion substitution or honestly returns no safe alternative', () => {
    const candidates = workout.blocks.flatMap((block) => (block.exercises ?? []).map((exercise) => ({ block, exercise })));
    const successfulRecord = candidates.map(({ block, exercise }) => ({
      block,
      exercise,
      option: buildPurposefulSubstitutionOptions({
        document,
        target: { workoutKey: workout.workoutKey, blockId: block.blockId, exerciseId: exercise.exerciseId },
        requestedScope: 'SESSION',
        input: {
          kind: 'SUBSTITUTION', reason: 'EXCLUSION', originalExerciseId: exercise.exerciseId,
          unavailableEquipmentIds: [], exclusions: [exercise.exerciseId],
        },
        authoritativeEquipmentIds: allEquipment,
        authoritativeExclusions: [],
        authoritativePreferences: [],
      })[0],
    })).find((entry) => entry.option.eligible)!;
    const successful = successfulRecord.option;
    expect(successful).toMatchObject({
      optionKind: 'PURPOSEFUL_SUBSTITUTION', scope: 'SESSION', objectivePreserved: true,
      proposedState: { substitution: { equipmentCompatible: true } },
    });

    const first = candidates[0];
    const none = buildPurposefulSubstitutionOptions({
      document,
      target: { workoutKey: workout.workoutKey, blockId: first.block.blockId, exerciseId: first.exercise.exerciseId },
      requestedScope: 'SESSION',
      input: {
        kind: 'SUBSTITUTION', reason: 'EXCLUSION', originalExerciseId: first.exercise.exerciseId,
        unavailableEquipmentIds: ['dumbbell', 'barbell', 'band', 'bench', 'bodyweight', 'machine', 'cable'],
        exclusions: [first.exercise.exerciseId], proposedExerciseId: 'definitely_not_safe',
      },
      authoritativeEquipmentIds: allEquipment,
      authoritativeExclusions: [],
      authoritativePreferences: [],
    })[0];
    expect(none).toMatchObject({ eligible: false, objectivePreserved: false, proposedDocument: null });

    const dumbbellOnly = candidates.map(({ block, exercise }) => buildPurposefulSubstitutionOptions({
      document,
      target: { workoutKey: workout.workoutKey, blockId: block.blockId, exerciseId: exercise.exerciseId },
      requestedScope: 'SESSION',
      input: {
        kind: 'SUBSTITUTION', reason: 'EQUIPMENT', originalExerciseId: exercise.exerciseId,
        unavailableEquipmentIds: ['dumbbells'], exclusions: [],
      },
      authoritativeEquipmentIds: ['bodyweight', 'dumbbell'],
      authoritativeExclusions: [],
      authoritativePreferences: ['home_training'],
    })[0]).find((option) => option.eligible);
    expect(dumbbellOnly).toBeDefined();
    const substitution = (dumbbellOnly!.proposedState as any).substitution;
    expect(substitution.proposedAlternative.equipmentIds)
      .not.toEqual(expect.arrayContaining(['cable', 'machine']));
    expect(substitution.proposedAlternative.equipmentIds.every((id: string) => id === 'bodyweight')).toBe(true);

    const baselineSubstitution = (successful!.proposedState as any).substitution;
    const storedExcludedAlternative = baselineSubstitution.proposedAlternative.exerciseId as string;
    const respectsStoredExclusion = buildPurposefulSubstitutionOptions({
      document,
      target: {
        workoutKey: workout.workoutKey,
        blockId: successfulRecord.block.blockId,
        exerciseId: successfulRecord.exercise.exerciseId,
      },
      requestedScope: 'SESSION',
      input: {
        kind: 'SUBSTITUTION', reason: 'EXCLUSION', originalExerciseId: successfulRecord.exercise.exerciseId,
        unavailableEquipmentIds: [], exclusions: [successfulRecord.exercise.exerciseId],
      },
      authoritativeEquipmentIds: allEquipment,
      authoritativeExclusions: [storedExcludedAlternative],
      authoritativePreferences: [],
    })[0];
    if (respectsStoredExclusion.eligible) {
      expect((respectsStoredExclusion.proposedState as any).substitution.proposedAlternative.exerciseId)
        .not.toBe(storedExcludedAlternative);
    }
  });
});
