// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Biomechanics-aware substitution + session-order logic — slice 4.H.
 *
 * Closes Phase 0 audit Layers 5+7 finding (Medium): "no
 * biomechanics-aware substitution; no exercise-order logic within a
 * session". Pre-slice the strength engine could prescribe a high
 * spinal-loading lift to a user with declared low-back pain (the
 * substitution graph only handled equipment availability + beginner
 * complexity), and exercises within a session were emitted in
 * variant-table order — a goblet squat could land BEFORE a heavy
 * front squat in a session, violating the compound-first principle.
 *
 * This module adds two passes:
 *
 *   1. `applyBiomechanicsSafetySubstitutions(prescriptions, athlete, knowledge)`
 *      — for each prescribed exercise that conflicts with the
 *      user's declared pain areas, walk the catalog substitutions
 *      to find a candidate that does NOT conflict. If no safe
 *      candidate is found, the original is kept and the caller
 *      can log a warning.
 *
 *   2. `orderExercisesForSession(prescriptions, knowledge)` —
 *      sort prescriptions so compound, high-spinal-loading work
 *      comes first, accessory + carry work mid, and core +
 *      mobility last. Within each phase, ties broken by
 *      complexity (advanced first) and primaryPurpose
 *      (strength > hypertrophy > stability > conditioning >
 *      mobility).
 *
 * Both functions are pure. Empty / single-exercise lists pass
 * through unchanged.
 */

import type { AthleteState, Exercise, ExercisePrescription } from './types';
import {
  exerciseConflictsWithUserPain,
  getExerciseComplexity,
  getExercisePrimaryPurpose,
  getExerciseSpinalLoading,
} from './exercise-metadata';

// ─────────────────────────────────────────────────────────────────
// Pain-aware substitution
// ─────────────────────────────────────────────────────────────────

interface BiomechanicsSubstitutionResult {
  prescriptions: ExercisePrescription[];
  /** IDs of exercises that were swapped due to a conflict. */
  swappedFromIds: string[];
  /** IDs that conflicted with user pain but had no safe substitute. */
  unresolvedConflictIds: string[];
}

/**
 * Walk the prescriptions list and replace any exercise whose
 * contraindication flags conflict with the athlete's pain areas
 * with the first non-conflicting candidate from its
 * `substitutions` chain.
 *
 * If no safe substitute is available the original is kept and the
 * id is reported in `unresolvedConflictIds` so the caller can log
 * a warning. (We don't drop the exercise: a session that's missing
 * a key lift is worse for the user than a flagged warning the
 * coach can read and adjust.)
 *
 * Pure. No mutation of inputs.
 */
export function applyBiomechanicsSafetySubstitutions(
  prescriptions: ReadonlyArray<ExercisePrescription>,
  athlete: AthleteState,
  exerciseCatalog: ReadonlyArray<Exercise>,
): BiomechanicsSubstitutionResult {
  const painAreas = (athlete.readiness?.painFlags ?? [])
    .map((flag) => flag.area ?? '')
    .filter((area) => area.length > 0);

  if (painAreas.length === 0) {
    return {
      prescriptions: prescriptions.map((p) => ({ ...p })),
      swappedFromIds: [],
      unresolvedConflictIds: [],
    };
  }

  const catalog = new Map(exerciseCatalog.map((ex) => [ex.id, ex]));
  const swappedFromIds: string[] = [];
  const unresolvedConflictIds: string[] = [];

  const next = prescriptions.map((prescription) => {
    const exercise = catalog.get(prescription.exerciseId);
    if (!exercise) return { ...prescription };
    if (!exerciseConflictsWithUserPain(exercise, painAreas)) {
      return { ...prescription };
    }

    // Try each substitution. First candidate that doesn't conflict
    // with the same pain areas wins.
    for (const subId of exercise.substitutions ?? []) {
      const candidate = catalog.get(subId);
      if (!candidate) continue;
      if (exerciseConflictsWithUserPain(candidate, painAreas)) continue;
      swappedFromIds.push(prescription.exerciseId);
      return {
        ...prescription,
        exerciseId: candidate.id,
        name: candidate.name,
        notes: prescription.notes
          ? `${prescription.notes} | Substituted for ${prescription.name} (pain area)`
          : `Substituted for ${prescription.name} (pain area)`,
      };
    }

    // No safe candidate — report the conflict and keep the
    // original so the session isn't gutted. Caller logs.
    unresolvedConflictIds.push(prescription.exerciseId);
    return { ...prescription };
  });

  return {
    prescriptions: next,
    swappedFromIds,
    unresolvedConflictIds,
  };
}

// ─────────────────────────────────────────────────────────────────
// Session ordering
// ─────────────────────────────────────────────────────────────────

/**
 * Phase order for in-session sorting:
 *   1 = compound + heavy (squat/hinge/push/pull, high or moderate
 *        spinal loading)
 *   2 = compound + light (push/pull with low spinal loading,
 *        single_leg)
 *   3 = carry (conditioning, often grip-fatiguing — should follow
 *        compounds while user is fresh enough but not before main
 *        lifts)
 *   4 = core / stability work
 *   5 = mobility / cooldown
 */
const PHASE_FOR_PATTERN: Record<Exercise['movementPattern'], number> = {
  squat: 1,
  hinge: 1,
  push: 2,
  pull: 2,
  single_leg: 2,
  carry: 3,
  core: 4,
  mobility: 5,
};

const SPINAL_LOADING_RANK: Record<'high' | 'moderate' | 'low', number> = {
  high: 0,
  moderate: 1,
  low: 2,
};

const COMPLEXITY_RANK: Record<'expert' | 'advanced' | 'intermediate' | 'beginner', number> = {
  expert: 0,
  advanced: 1,
  intermediate: 2,
  beginner: 3,
};

const PRIMARY_PURPOSE_RANK: Record<'strength' | 'hypertrophy' | 'power' | 'stability' | 'conditioning' | 'mobility', number> = {
  power: 0,
  strength: 1,
  hypertrophy: 2,
  stability: 3,
  conditioning: 4,
  mobility: 5,
};

/**
 * Re-order `prescriptions` so compound/high-loading lifts come
 * first, accessory + carry work next, core + mobility last.
 *
 * Stable within a phase — a callsite that explicitly placed two
 * compound lifts in a particular order keeps them in that order
 * relative to each other, and only the cross-phase positions
 * change.
 *
 * Pure. Returns a new array; doesn't mutate the input.
 */
export function orderExercisesForSession(
  prescriptions: ReadonlyArray<ExercisePrescription>,
  exerciseCatalog: ReadonlyArray<Exercise>,
): ExercisePrescription[] {
  if (prescriptions.length <= 1) return prescriptions.map((p) => ({ ...p }));
  const catalog = new Map(exerciseCatalog.map((ex) => [ex.id, ex]));

  // Decorate with sort keys + original index for stable sort.
  const decorated = prescriptions.map((prescription, originalIndex) => {
    const exercise = catalog.get(prescription.exerciseId);
    const phase = exercise ? (PHASE_FOR_PATTERN[exercise.movementPattern] ?? 4) : 4;
    const spinalRank = exercise ? SPINAL_LOADING_RANK[getExerciseSpinalLoading(exercise)] : 2;
    const complexityRank = exercise ? COMPLEXITY_RANK[getExerciseComplexity(exercise)] : 3;
    const purposeRank = exercise ? PRIMARY_PURPOSE_RANK[getExercisePrimaryPurpose(exercise)] : 5;
    return {
      prescription,
      phase,
      spinalRank,
      complexityRank,
      purposeRank,
      originalIndex,
    };
  });

  decorated.sort((left, right) => {
    if (left.phase !== right.phase) return left.phase - right.phase;
    if (left.spinalRank !== right.spinalRank) return left.spinalRank - right.spinalRank;
    if (left.complexityRank !== right.complexityRank) return left.complexityRank - right.complexityRank;
    if (left.purposeRank !== right.purposeRank) return left.purposeRank - right.purposeRank;
    return left.originalIndex - right.originalIndex;
  });

  return decorated.map((entry) => ({ ...entry.prescription }));
}
