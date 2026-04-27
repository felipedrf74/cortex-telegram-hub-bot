import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  exerciseConflictsWithUserPain,
  getExerciseComplexity,
  getExerciseContraindications,
  getExerciseIsUnilateral,
  getExercisePrimaryPurpose,
  getExerciseSpinalLoading,
  getExerciseWarmupNeeds,
} from '../../src/services/coach-kernel/exercise-metadata';
import type { Exercise } from '../../src/services/coach-kernel/types';

/**
 * Slice 4.G — exercise metadata helpers + catalog enrichment pin tests.
 *
 * Closes Phase 0 audit Layer-2 finding (High). Pins:
 *   - explicit values from the JSON come through unchanged
 *   - smart defaults derived from movementPattern + equipment when
 *     fields are absent
 *   - exerciseConflictsWithUserPain matches normalized strings
 *   - the catalog itself has explicit values for the high-leverage
 *     exercises slice 4.H will reason about
 */

const knowledge = loadCoachKnowledge();
const byId = new Map<string, Exercise>(knowledge.exercises.map((ex) => [ex.id, ex]));

function lookup(id: string): Exercise {
  const exercise = byId.get(id);
  if (!exercise) throw new Error(`Test fixture missing exercise: ${id}`);
  return exercise;
}

describe('exercise-metadata — explicit values from catalog', () => {
  it('front_squat is advanced complexity, high spinal loading, low_back contraindication', () => {
    const front = lookup('front_squat');
    expect(getExerciseComplexity(front)).toBe('advanced');
    expect(getExerciseSpinalLoading(front)).toBe('high');
    expect(getExerciseContraindications(front)).toContain('low_back');
  });

  it('romanian_deadlift is high spinal loading with hamstring warmup needs', () => {
    const rdl = lookup('romanian_deadlift');
    expect(getExerciseSpinalLoading(rdl)).toBe('high');
    expect(getExerciseWarmupNeeds(rdl)).toContain('hamstring_warmup');
    expect(getExerciseContraindications(rdl)).toContain('low_back');
  });

  it('split_squat is unilateral', () => {
    expect(getExerciseIsUnilateral(lookup('split_squat'))).toBe(true);
  });

  it('single_leg_rdl is unilateral with stability primary purpose', () => {
    const exercise = lookup('single_leg_rdl');
    expect(getExerciseIsUnilateral(exercise)).toBe(true);
    expect(getExercisePrimaryPurpose(exercise)).toBe('stability');
  });

  it('goblet_squat is beginner complexity (slice 2.A swap target for novice front_squat)', () => {
    expect(getExerciseComplexity(lookup('goblet_squat'))).toBe('beginner');
  });

  it('one_arm_dumbbell_row is unilateral', () => {
    expect(getExerciseIsUnilateral(lookup('one_arm_dumbbell_row'))).toBe(true);
  });

  it('farmer_carry has grip_warmup need', () => {
    expect(getExerciseWarmupNeeds(lookup('farmer_carry'))).toContain('grip_warmup');
  });

  it('dead_bug has stability primary purpose, low spinal loading', () => {
    const dead = lookup('dead_bug');
    expect(getExercisePrimaryPurpose(dead)).toBe('stability');
    expect(getExerciseSpinalLoading(dead)).toBe('low');
  });

  it('bench_press has shoulder_impingement contraindication', () => {
    expect(getExerciseContraindications(lookup('bench_press'))).toContain('shoulder_impingement');
  });
});

describe('exercise-metadata — derived defaults for unseeded exercises', () => {
  function syntheticExercise(overrides: Partial<Exercise>): Exercise {
    return {
      id: overrides.id ?? 'synthetic',
      name: overrides.name ?? 'Synthetic',
      movementPattern: overrides.movementPattern ?? 'core',
      equipment: overrides.equipment ?? [],
      fatigueCost: overrides.fatigueCost ?? 'low',
      substitutions: overrides.substitutions ?? [],
      ...overrides,
    };
  }

  it('barbell + rack → advanced complexity', () => {
    const exercise = syntheticExercise({ equipment: ['barbell', 'rack'], movementPattern: 'squat' });
    expect(getExerciseComplexity(exercise)).toBe('advanced');
  });

  it('barbell-only → intermediate complexity', () => {
    const exercise = syntheticExercise({ equipment: ['barbell'], movementPattern: 'push' });
    expect(getExerciseComplexity(exercise)).toBe('intermediate');
  });

  it('dumbbells → intermediate complexity', () => {
    const exercise = syntheticExercise({ equipment: ['dumbbells'], movementPattern: 'push' });
    expect(getExerciseComplexity(exercise)).toBe('intermediate');
  });

  it('bodyweight + non-mobility → beginner complexity', () => {
    const exercise = syntheticExercise({ equipment: [], movementPattern: 'push' });
    expect(getExerciseComplexity(exercise)).toBe('beginner');
  });

  it('mobility movement → beginner complexity', () => {
    const exercise = syntheticExercise({ movementPattern: 'mobility' });
    expect(getExerciseComplexity(exercise)).toBe('beginner');
  });

  it('squat + barbell → high spinal loading', () => {
    const exercise = syntheticExercise({ movementPattern: 'squat', equipment: ['barbell'] });
    expect(getExerciseSpinalLoading(exercise)).toBe('high');
  });

  it('squat + dumbbells → moderate spinal loading', () => {
    const exercise = syntheticExercise({ movementPattern: 'squat', equipment: ['dumbbells'] });
    expect(getExerciseSpinalLoading(exercise)).toBe('moderate');
  });

  it('hinge + bodyweight → moderate spinal loading', () => {
    const exercise = syntheticExercise({ movementPattern: 'hinge', equipment: [] });
    expect(getExerciseSpinalLoading(exercise)).toBe('moderate');
  });

  it('carry pattern → moderate spinal loading', () => {
    const exercise = syntheticExercise({ movementPattern: 'carry' });
    expect(getExerciseSpinalLoading(exercise)).toBe('moderate');
  });

  it('core / push / pull patterns → low spinal loading by default', () => {
    expect(getExerciseSpinalLoading(syntheticExercise({ movementPattern: 'core' }))).toBe('low');
    expect(getExerciseSpinalLoading(syntheticExercise({ movementPattern: 'push' }))).toBe('low');
    expect(getExerciseSpinalLoading(syntheticExercise({ movementPattern: 'pull' }))).toBe('low');
  });

  it('movementPattern single_leg → unilateral by default', () => {
    expect(getExerciseIsUnilateral(syntheticExercise({ movementPattern: 'single_leg' }))).toBe(true);
  });

  it('id starting with split_/lunging_/suitcase_ → unilateral by default', () => {
    expect(getExerciseIsUnilateral(syntheticExercise({ id: 'split_squat', movementPattern: 'squat' }))).toBe(true);
    expect(getExerciseIsUnilateral(syntheticExercise({ id: 'lunging_iso_hold', movementPattern: 'core' }))).toBe(true);
    expect(getExerciseIsUnilateral(syntheticExercise({ id: 'suitcase_carry', movementPattern: 'carry' }))).toBe(true);
  });

  it('explicit unilateral=false beats id heuristic', () => {
    const exercise = syntheticExercise({ id: 'split_unrelated', movementPattern: 'core', unilateral: false });
    expect(getExerciseIsUnilateral(exercise)).toBe(false);
  });

  it('mobility pattern → mobility primary purpose', () => {
    expect(getExercisePrimaryPurpose(syntheticExercise({ movementPattern: 'mobility' }))).toBe('mobility');
  });

  it('core pattern → stability primary purpose', () => {
    expect(getExercisePrimaryPurpose(syntheticExercise({ movementPattern: 'core' }))).toBe('stability');
  });

  it('carry pattern → conditioning primary purpose', () => {
    expect(getExercisePrimaryPurpose(syntheticExercise({ movementPattern: 'carry' }))).toBe('conditioning');
  });

  it('squat/hinge/push/pull/single_leg default to strength', () => {
    for (const pattern of ['squat', 'hinge', 'push', 'pull', 'single_leg'] as const) {
      expect(getExercisePrimaryPurpose(syntheticExercise({ movementPattern: pattern }))).toBe('strength');
    }
  });

  it('squat warmup needs include hip_mobility + ankle_mobility', () => {
    const needs = getExerciseWarmupNeeds(syntheticExercise({ movementPattern: 'squat' }));
    expect(needs).toContain('hip_mobility');
    expect(needs).toContain('ankle_mobility');
  });

  it('hinge warmup needs include hamstring_warmup', () => {
    const needs = getExerciseWarmupNeeds(syntheticExercise({ movementPattern: 'hinge' }));
    expect(needs).toContain('hamstring_warmup');
  });

  it('pull warmup needs include thoracic_rotation', () => {
    expect(getExerciseWarmupNeeds(syntheticExercise({ movementPattern: 'pull' }))).toContain('thoracic_rotation');
  });

  it('contraindication flags default to empty array', () => {
    expect(getExerciseContraindications(syntheticExercise({}))).toEqual([]);
  });
});

describe('exercise-metadata — exerciseConflictsWithUserPain', () => {
  it('returns false when user has no pain areas', () => {
    expect(exerciseConflictsWithUserPain(lookup('front_squat'), [])).toBe(false);
  });

  it('returns false when exercise has no contraindication flags', () => {
    expect(exerciseConflictsWithUserPain(lookup('dead_bug'), ['lower back strain'])).toBe(false);
  });

  it('matches when a flag is contained in a normalized pain area string', () => {
    // Front squat has 'low_back'; user reports 'lower back strain' →
    // normalized to 'lower_back_strain' → contains 'low_back' substring.
    expect(exerciseConflictsWithUserPain(lookup('front_squat'), ['lower back strain'])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(exerciseConflictsWithUserPain(lookup('front_squat'), ['LOW BACK'])).toBe(true);
  });

  it('does not match unrelated pain areas', () => {
    expect(exerciseConflictsWithUserPain(lookup('front_squat'), ['shoulder soreness'])).toBe(false);
  });
});
