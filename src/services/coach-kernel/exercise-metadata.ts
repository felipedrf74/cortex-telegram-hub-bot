// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Exercise metadata helpers — slice 4.G.
 *
 * Closes Phase 0 audit Layer-2 finding (High, blocks Layer 5/7
 * quality): exercises.json was shallow — only `movementPattern`,
 * `equipment`, `fatigueCost`, and `substitutions` per row. Slice
 * 4.G adds the audit-required fields (`complexity`, `spinalLoading`,
 * `unilateral`, `primaryPurpose`, `contraindicationFlags`,
 * `warmupNeeds`) as OPTIONAL on the Exercise type and provides
 * deterministic defaults so existing callers + un-seeded exercises
 * get sensible values.
 *
 * Why defaults instead of mandatory fields:
 *
 *   - 24 exercises in the catalog today; the cost of pinning every
 *     field per row before any consumer exists is high.
 *   - Slice 4.H will be the first consumer (biomechanics-aware
 *     substitution + session-order). Its tests will exercise both
 *     the "explicit value" and "derived default" paths.
 *   - Exercises that warrant explicit values (e.g. front_squat
 *     definitely should be marked spinalLoading: 'high', complexity:
 *     'advanced') get them in the JSON. Everything else gets a
 *     conservative default that won't bias the substitution layer
 *     against an exercise the engine should still pick.
 *
 * Default-derivation rules:
 *
 *   - complexity:
 *     - barbell + rack equipment → 'advanced'
 *     - barbell-only → 'intermediate'
 *     - dumbbells/kettlebells → 'intermediate'
 *     - bands or bodyweight → 'beginner'
 *     - mobility movements → 'beginner'
 *
 *   - spinalLoading:
 *     - movementPattern === 'hinge' AND barbell equipment → 'high'
 *     - movementPattern === 'squat' AND barbell equipment → 'high'
 *     - movementPattern in ['squat', 'hinge'] (non-barbell) → 'moderate'
 *     - movementPattern === 'carry' → 'moderate'
 *     - default → 'low'
 *
 *   - unilateral:
 *     - movementPattern === 'single_leg' → true
 *     - id contains 'single_leg', 'one_arm', 'split_', 'lunging_' → true
 *     - default → false
 *
 *   - primaryPurpose:
 *     - movementPattern === 'mobility' → 'mobility'
 *     - movementPattern === 'core' → 'stability'
 *     - movementPattern === 'carry' → 'conditioning'
 *     - default → 'strength'
 *
 *   - contraindicationFlags: default empty array.
 *
 *   - warmupNeeds:
 *     - movementPattern === 'squat' → ['hip_mobility', 'ankle_mobility']
 *     - movementPattern === 'hinge' → ['hip_mobility', 'hamstring_warmup']
 *     - movementPattern === 'push' → ['shoulder_warmup']
 *     - movementPattern === 'pull' → ['shoulder_warmup', 'thoracic_rotation']
 *     - movementPattern === 'single_leg' → ['hip_mobility']
 *     - movementPattern === 'carry' → ['grip_warmup']
 *     - default → []
 */

import type { Exercise, ExerciseComplexity, ExercisePrimaryPurpose, SpinalLoading } from './types';

export function getExerciseComplexity(exercise: Exercise): ExerciseComplexity {
  if (exercise.complexity) return exercise.complexity;
  const equipment = exercise.equipment ?? [];
  if (equipment.includes('barbell') && equipment.includes('rack')) return 'advanced';
  if (equipment.includes('barbell')) return 'intermediate';
  if (equipment.includes('dumbbells') || equipment.includes('kettlebells')) return 'intermediate';
  if (exercise.movementPattern === 'mobility') return 'beginner';
  return 'beginner';
}

export function getExerciseSpinalLoading(exercise: Exercise): SpinalLoading {
  if (exercise.spinalLoading) return exercise.spinalLoading;
  const equipment = exercise.equipment ?? [];
  const isBarbell = equipment.includes('barbell');
  if (exercise.movementPattern === 'hinge') return isBarbell ? 'high' : 'moderate';
  if (exercise.movementPattern === 'squat') return isBarbell ? 'high' : 'moderate';
  if (exercise.movementPattern === 'carry') return 'moderate';
  return 'low';
}

export function getExerciseIsUnilateral(exercise: Exercise): boolean {
  if (typeof exercise.unilateral === 'boolean') return exercise.unilateral;
  if (exercise.movementPattern === 'single_leg') return true;
  const id = (exercise.id ?? '').toLowerCase();
  if (id.includes('single_leg')) return true;
  if (id.includes('one_arm')) return true;
  if (id.startsWith('split_')) return true;
  if (id.startsWith('lunging_')) return true;
  if (id.startsWith('suitcase_')) return true;
  return false;
}

export function getExercisePrimaryPurpose(exercise: Exercise): ExercisePrimaryPurpose {
  if (exercise.primaryPurpose) return exercise.primaryPurpose;
  if (exercise.movementPattern === 'mobility') return 'mobility';
  if (exercise.movementPattern === 'core') return 'stability';
  if (exercise.movementPattern === 'carry') return 'conditioning';
  return 'strength';
}

export function getExerciseContraindications(exercise: Exercise): string[] {
  return exercise.contraindicationFlags ?? [];
}

export function getExerciseWarmupNeeds(exercise: Exercise): string[] {
  if (exercise.warmupNeeds) return [...exercise.warmupNeeds];
  switch (exercise.movementPattern) {
    case 'squat':
      return ['hip_mobility', 'ankle_mobility'];
    case 'hinge':
      return ['hip_mobility', 'hamstring_warmup'];
    case 'push':
      return ['shoulder_warmup'];
    case 'pull':
      return ['shoulder_warmup', 'thoracic_rotation'];
    case 'single_leg':
      return ['hip_mobility'];
    case 'carry':
      return ['grip_warmup'];
    default:
      return [];
  }
}

/**
 * Returns true if the exercise has any of the contraindication flags
 * that match the user's declared injury areas. Used by slice 4.H.
 *
 * `userPainAreas` should be the lowercased list of pain area strings
 * from `athlete.readiness.painFlags[].area`. Matching tokenizes both
 * the flag and the pain area on whitespace/underscores/hyphens, then
 * declares a match when any flag token shares a 3+ char prefix with
 * any pain token (e.g. `'low_back'` matches `'lower back strain'`
 * because `'low'` is a prefix of `'lower'` and `'back'` matches
 * `'back'`).
 */
export function exerciseConflictsWithUserPain(
  exercise: Exercise,
  userPainAreas: ReadonlyArray<string>,
): boolean {
  if (userPainAreas.length === 0) return false;
  const flags = getExerciseContraindications(exercise);
  if (flags.length === 0) return false;
  const tokenize = (value: string): string[] =>
    value.toLowerCase().split(/[\s_\-]+/).filter((token) => token.length >= 3);
  const painTokens = userPainAreas.flatMap(tokenize);
  if (painTokens.length === 0) return false;
  return flags.some((flag) => {
    const flagTokens = tokenize(flag);
    return flagTokens.some((flagToken) =>
      painTokens.some((painToken) =>
        flagToken === painToken
        || flagToken.startsWith(painToken)
        || painToken.startsWith(flagToken),
      ),
    );
  });
}
