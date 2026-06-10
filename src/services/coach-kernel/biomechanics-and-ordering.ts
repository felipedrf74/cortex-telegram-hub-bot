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
  getExerciseIsUnilateral,
  getExercisePrimaryPurpose,
  getExerciseSpinalLoading,
} from './exercise-metadata';

// ─────────────────────────────────────────────────────────────────
// Pain-aware substitution
// ─────────────────────────────────────────────────────────────────

export interface BiomechanicsSafetyContext {
  availableEquipment?: ReadonlySet<string> | ReadonlyArray<string>;
  sessionRole?: string;
  durationMinutes?: number;
}

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
  context: BiomechanicsSafetyContext = {},
): BiomechanicsSubstitutionResult {
  const painAreas = (athlete.readiness?.painFlags ?? [])
    .map((flag) => flag.area ?? '')
    .filter((area) => area.length > 0);

  const hasRiskSignal = prescriptions.some((prescription) => {
    const exercise = exerciseCatalog.find((item) => item.id === prescription.exerciseId);
    return Boolean(exercise && shouldConsiderSafetySubstitution(exercise, athlete, painAreas, context));
  });

  if (!hasRiskSignal) {
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
    if (!shouldConsiderSafetySubstitution(exercise, athlete, painAreas, context)) {
      return { ...prescription };
    }

    const candidate = selectBestSafetySubstitute({
      original: exercise,
      catalog,
      athlete,
      painAreas,
      context,
    });

    if (candidate) {
      swappedFromIds.push(prescription.exerciseId);
      return {
        ...prescription,
        exerciseId: candidate.id,
        name: candidate.name,
        notes: prescription.notes
          ? `${prescription.notes} | ${substitutionNote(prescription.name, exercise, candidate, athlete, painAreas, context)}`
          : substitutionNote(prescription.name, exercise, candidate, athlete, painAreas, context),
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

function shouldConsiderSafetySubstitution(
  exercise: Exercise,
  athlete: AthleteState,
  painAreas: string[],
  context: BiomechanicsSafetyContext,
): boolean {
  if (exerciseConflictsWithUserPain(exercise, painAreas)) return true;
  if (!canPerformExercise(exercise, resolveEquipment(context.availableEquipment, athlete))) return true;

  const complexity = getExerciseComplexity(exercise);
  const spinalLoading = getExerciseSpinalLoading(exercise);
  const fatigued = athlete.readiness?.level === 'red'
    || athlete.readiness?.level === 'orange'
    || athlete.readiness?.soreness === 'high'
    || (athlete.readiness?.score ?? 100) < 55;
  const novice = athlete.profile.experienceLevel === 'novice';
  const shortWindow = typeof context.durationMinutes === 'number' && context.durationMinutes < 25;

  if (novice && (complexity === 'advanced' || complexity === 'expert')) return true;
  if (fatigued && (exercise.fatigueCost === 'high' || exercise.fatigueCost === 'very_high')) return true;
  if (fatigued && spinalLoading === 'high') return true;
  if (shortWindow && (exercise.fatigueCost === 'very_high' || complexity === 'expert')) return true;

  return false;
}

function selectBestSafetySubstitute(args: {
  original: Exercise;
  catalog: ReadonlyMap<string, Exercise>;
  athlete: AthleteState;
  painAreas: string[];
  context: BiomechanicsSafetyContext;
}): Exercise | null {
  const equipment = resolveEquipment(args.context.availableEquipment, args.athlete);
  const directCandidates = collectSafetyCandidates(args.original, args.catalog)
    .map((candidate) => ({
      candidate,
      score: scoreSafetyCandidate({
        original: args.original,
        candidate,
        athlete: args.athlete,
        painAreas: args.painAreas,
        equipment,
        context: args.context,
      }),
    }))
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.score - left.score);

  if (directCandidates[0]) return directCandidates[0].candidate;

  const fallbackCandidates = collectPatternFallbackCandidates(args.original, args.catalog)
    .map((candidate) => ({
      candidate,
      score: scoreSafetyCandidate({
        original: args.original,
        candidate,
        athlete: args.athlete,
        painAreas: args.painAreas,
        equipment,
        context: args.context,
      }),
    }))
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.score - left.score);

  return fallbackCandidates[0]?.candidate ?? null;
}

function collectSafetyCandidates(
  original: Exercise,
  catalog: ReadonlyMap<string, Exercise>,
): Exercise[] {
  const queued = [...(original.substitutions ?? [])];
  const seen = new Set<string>([original.id]);
  const candidates: Exercise[] = [];

  while (queued.length > 0) {
    const id = queued.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const exercise = catalog.get(id);
    if (!exercise) continue;
    candidates.push(exercise);
    queued.push(...(exercise.substitutions ?? []));
  }

  return candidates;
}

function collectPatternFallbackCandidates(
  original: Exercise,
  catalog: ReadonlyMap<string, Exercise>,
): Exercise[] {
  const directIds = new Set(collectSafetyCandidates(original, catalog).map((exercise) => exercise.id));
  return Array.from(catalog.values()).filter((exercise) =>
    exercise.id !== original.id
    && !directIds.has(exercise.id)
    && exercise.movementPattern === original.movementPattern
  );
}

function scoreSafetyCandidate(args: {
  original: Exercise;
  candidate: Exercise;
  athlete: AthleteState;
  painAreas: string[];
  equipment: ReadonlySet<string>;
  context: BiomechanicsSafetyContext;
}): number {
  if (!canPerformExercise(args.candidate, args.equipment)) return Number.NEGATIVE_INFINITY;
  if (exerciseConflictsWithUserPain(args.candidate, args.painAreas)) return Number.NEGATIVE_INFINITY;

  const originalPurpose = getExercisePrimaryPurpose(args.original);
  const candidatePurpose = getExercisePrimaryPurpose(args.candidate);
  const complexity = getExerciseComplexity(args.candidate);
  const spinalLoading = getExerciseSpinalLoading(args.candidate);
  const fatigued = args.athlete.readiness?.level === 'red'
    || args.athlete.readiness?.level === 'orange'
    || args.athlete.readiness?.soreness === 'high'
    || (args.athlete.readiness?.score ?? 100) < 55;
  const novice = args.athlete.profile.experienceLevel === 'novice';
  const shortWindow = typeof args.context.durationMinutes === 'number' && args.context.durationMinutes < 25;
  const role = (args.context.sessionRole ?? '').toLowerCase();

  let score = 100;
  if (args.candidate.movementPattern === args.original.movementPattern) score += 18;
  if (candidatePurpose === originalPurpose) score += 10;
  if (candidatePurpose === 'stability' && fatigued) score += 6;
  if (candidatePurpose === 'mobility' && (fatigued || shortWindow)) score += 5;
  if (role.includes('hypertrophy') && candidatePurpose === 'hypertrophy') score += 6;
  if (role.includes('strength') && candidatePurpose === 'strength') score += 6;

  if (complexity === 'beginner') score += novice || fatigued ? 14 : 3;
  if (complexity === 'intermediate') score += novice ? -8 : 2;
  if (complexity === 'advanced') score -= novice ? 32 : fatigued ? 14 : 0;
  if (complexity === 'expert') score -= novice ? 60 : fatigued ? 32 : 10;

  if (spinalLoading === 'high') score -= fatigued ? 38 : novice ? 20 : 4;
  if (spinalLoading === 'moderate') score -= fatigued ? 10 : novice ? 6 : 0;
  if (spinalLoading === 'low') score += fatigued || novice ? 10 : 2;

  if (args.candidate.fatigueCost === 'low') score += fatigued || shortWindow ? 12 : 2;
  if (args.candidate.fatigueCost === 'high') score -= fatigued ? 24 : shortWindow ? 10 : 2;
  if (args.candidate.fatigueCost === 'very_high') score -= fatigued ? 48 : 16;

  if (getExerciseIsUnilateral(args.candidate)) {
    score += args.original.movementPattern === 'single_leg' ? 8 : 0;
    score -= shortWindow ? 4 : 0;
  }

  return score;
}

function substitutionNote(
  originalName: string,
  original: Exercise,
  candidate: Exercise,
  athlete: AthleteState,
  painAreas: string[],
  context: BiomechanicsSafetyContext,
): string {
  const reasons: string[] = [];
  if (exerciseConflictsWithUserPain(original, painAreas)) reasons.push('pain area / discomfort flag');
  if (!canPerformExercise(original, resolveEquipment(context.availableEquipment, athlete))) reasons.push('equipment');
  const fatigued = athlete.readiness?.level === 'red'
    || athlete.readiness?.level === 'orange'
    || athlete.readiness?.soreness === 'high'
    || (athlete.readiness?.score ?? 100) < 55;
  if (fatigued && (getExerciseSpinalLoading(original) === 'high' || original.fatigueCost === 'high' || original.fatigueCost === 'very_high')) {
    reasons.push('fatigue safety');
  }
  if (athlete.profile.experienceLevel === 'novice' && (getExerciseComplexity(original) === 'advanced' || getExerciseComplexity(original) === 'expert')) {
    reasons.push('skill match');
  }
  if (typeof context.durationMinutes === 'number' && context.durationMinutes < 25) reasons.push('short-window fit');

  const reason = reasons.length > 0 ? reasons.join(', ') : 'safety fit';
  return `Substituted for ${originalName} (${reason}: ${candidate.name})`;
}

function resolveEquipment(
  provided: BiomechanicsSafetyContext['availableEquipment'],
  athlete: AthleteState,
): ReadonlySet<string> {
  if (provided instanceof Set) return provided;
  if (Array.isArray(provided)) return new Set(provided);
  const equipment = new Set<string>();
  const hasFullGymCapabilities = athlete.equipment.hasGym
    && athlete.equipment.hasBarbell
    && athlete.equipment.hasDumbbells;
  if (athlete.equipment.hasGym) {
    equipment.add('bench');
    equipment.add('pullup_bar');
    if (hasFullGymCapabilities) {
      equipment.add('lat_pulldown');
      equipment.add('leg_press');
      equipment.add('cable_stack');
      equipment.add('chest_press_machine');
    }
  }
  if (athlete.equipment.hasBarbell) {
    equipment.add('barbell');
    equipment.add('rack');
  }
  if (athlete.equipment.hasDumbbells) {
    equipment.add('dumbbells');
    equipment.add('kettlebells');
  }
  if (athlete.equipment.hasBikeTrainer) equipment.add('bike_trainer');
  if (athlete.equipment.hasPool) equipment.add('pool');
  if (athlete.equipment.hasTrack) equipment.add('track');
  return equipment;
}

function canPerformExercise(exercise: Exercise, equipment: ReadonlySet<string>): boolean {
  return exercise.equipment.every((requirement) => equipment.has(requirement));
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
