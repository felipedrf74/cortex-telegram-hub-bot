import { beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_TRAINING_SESSION_TYPES } from '../../src/services/training-workout-capability-registry';
import {
  buildCanonicalTrainingWorkout,
  buildUnknownTrainingWorkoutFallback,
} from '../../src/services/training-modality-workout-builder';
import { validateTrainingTypedWorkout } from '../../src/services/training-typed-workout-v1';
import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
} from '../../src/services/training-generation-observability';

describe('training modality workout builder', () => {
  beforeEach(() => _resetTrainingGenerationObservabilityForTests());

  it('generates valid structured blocks and modality prescriptions for all 21 canonical types', () => {
    for (const sessionType of CANONICAL_TRAINING_SESSION_TYPES) {
      const workout = buildCanonicalTrainingWorkout({
        sessionType,
        workoutKey: `all-21-${sessionType}`,
        dayOfWeek: 'monday',
        durationMinutes: sessionType === 'rest' ? 0 : 60,
        phaseType: 'BUILD',
        phaseKey: 'phase-build',
      });
      expect(() => validateTrainingTypedWorkout(workout), sessionType).not.toThrow();
      expect(workout.sessionTypeClassification).toBe('CANONICAL');
      expect(workout.blocks.map((block) => block.position))
        .toEqual(workout.blocks.map((_, index) => index + 1));
      expect(workout.blocks.some((block) => block.priority === 'ESSENTIAL')).toBe(true);
      expect(workout.blocks.every((block) => block.objectiveId?.length)).toBe(true);
      expect(workout.blocks.reduce((sum, block) => sum + block.plannedDurationMinutes, 0))
        .toBe(workout.plannedDurationMinutes);
    }
    expect(getTrainingGenerationObservabilitySnapshot().counters.typed_unknown_fallback_total).toBe(0);
  });

  it('keeps standalone mobility phase-free', () => {
    const workout = buildCanonicalTrainingWorkout({
      sessionType: 'mobility', workoutKey: 'standalone-mobility', dayOfWeek: 'sunday',
      durationMinutes: 20, phaseType: 'RECOVERY', phaseKey: null, isStandalone: true,
    });
    expect(workout.phaseKey).toBeNull();
    expect(workout.isStandalone).toBe(true);
    expect(() => buildCanonicalTrainingWorkout({
      sessionType: 'mobility', workoutKey: 'invalid', dayOfWeek: 'sunday',
      durationMinutes: 20, phaseType: 'RECOVERY', phaseKey: 'fabricated', isStandalone: true,
    })).toThrow(/STANDALONE_PHASE_FORBIDDEN/);
  });

  it('uses an honest non-prescribable fallback for unknown types', () => {
    const workout = buildUnknownTrainingWorkoutFallback({
      rawSessionType: 'future_modal_xyz', workoutKey: 'unknown-1', dayOfWeek: 'friday', durationMinutes: 35,
    });
    expect(workout).toMatchObject({
      sessionType: 'future_modal_xyz', sessionTypeClassification: 'UNKNOWN', isStandalone: true, phaseKey: null,
      blocks: [{ prescription: { kind: 'unknown', newlyPrescribable: false, rawPrescriptionType: 'future_modal_xyz' } }],
    });
    expect(getTrainingGenerationObservabilitySnapshot().counters.typed_unknown_fallback_total).toBe(1);
  });

  it('keeps objective IDs stable across revisions and validates them only when the v2 contract requires them', () => {
    const build = (workoutKey: string) => buildCanonicalTrainingWorkout({
      sessionType: 'threshold_run', workoutKey, dayOfWeek: 'tuesday', durationMinutes: 45,
      phaseType: 'BUILD', phaseKey: 'phase-build',
    });
    const first = build('revision-1');
    const second = build('revision-2');
    expect(first.blocks.map((block) => block.objectiveId))
      .toEqual(second.blocks.map((block) => block.objectiveId));

    const legacyCompatible = structuredClone(first);
    delete legacyCompatible.blocks[0].objectiveId;
    expect(() => validateTrainingTypedWorkout(legacyCompatible)).not.toThrow();
    expect(() => validateTrainingTypedWorkout(legacyCompatible, { requireObjectiveIds: true }))
      .toThrow(/TYPED_BLOCK_OBJECTIVE_ID_INVALID/);
  });
});
