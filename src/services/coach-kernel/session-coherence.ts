// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Session coherence — Slice 4.A of the Training engine + agenda
 * orchestration overhaul (see
 * `docs/training/training-engine-orchestration-overhaul-spec.md`).
 *
 * The pre-Slice-4.A engine had two parallel pipelines that never
 * reconciled:
 *
 *   1. `resolveDurationForDay(...)` picked a `durationMinutes` from
 *      the template's `durationOptionsMinutes` largest fitting the
 *      user's availability window (default 90-min strength window).
 *   2. `targetExerciseCount(durationMinutes, experience)` (slice 3.H)
 *      capped exercise count from that duration.
 *   3. `resolveExercises(...)` produced the exercise list, possibly
 *      below the cap if the variant was sparse.
 *
 * Nothing checked whether the produced exercise list at realistic
 * set / rest / transition times actually filled the claimed duration.
 * The visible symptom: a "Lower Body Strength A" session reported
 * ~48 min total but contained essentially one small exercise block
 * (Dead Bug 2×10–15) plus generic warm-up/cool-down. That session
 * estimates to ~15 min of real work — under-filled by 33 min.
 *
 * Slice 4.A introduces the gate. The estimator is rule-based and
 * deterministic; the validator returns a discriminated verdict; the
 * `suggestCorrection` helper says either "accept", "shrink the
 * claim", "trim trailing accessory work", or "rebuild with more
 * exercises". The engine wires the verdict into
 * `strengthEngine.buildCandidateSessions` so any session whose
 * estimated minutes diverge from claimed by more than the tolerance
 * (default 20%) is corrected before surfacing.
 *
 * The validator stays pure: it reports when a rebuild is required.
 * The strength engine owns the catalog-aware repair pass that adds
 * compatible exercises or set volume before falling back to a smaller
 * truthful duration.
 *
 * Other modalities (running, cycling, swimming): the duration of a
 * run/ride/swim is BY DEFINITION the session length — there is no
 * "exercise list takes X minutes" question for them. The validator
 * short-circuits to `ok` for non-strength sports.
 *
 * Pinned by `__tests__/services/coach-kernel-session-coherence.test.ts`.
 */

import type {
  CoachKnowledgeBase,
  Exercise,
  ExercisePrescription,
  Session,
} from './types';

// ─────────────────────────────────────────────────────────────────
// Tunable constants
// ─────────────────────────────────────────────────────────────────

/**
 * Default tolerance for the deviation between claimed and
 * estimated minutes. 20% means a 60-min session must estimate
 * within [48, 72] min of work (incl. warmup + cooldown). Below
 * 48 → underfilled. Above 72 → overstuffed.
 *
 * The tolerance accommodates real-world variance in user pace,
 * rest discipline, and transition speed without rejecting every
 * session for being a few minutes off.
 */
export const DEFAULT_COHERENCE_TOLERANCE_PCT = 0.20;

/**
 * Default warmup duration assumed for any strength session. The
 * engine's `WorkoutTemplate.instructions` typically include warmup
 * guidance worth ~8 min (5 min walk/bike + movement prep + 1 light
 * warmup set per main lift). We bake that into the estimator so a
 * session's claimed minutes have to credibly include it.
 */
export const DEFAULT_WARMUP_MINUTES = 8;

/**
 * Default cooldown duration. Most strength templates prescribe ~5
 * min of mobility work for the muscles trained.
 */
export const DEFAULT_COOLDOWN_MINUTES = 5;

/**
 * Transition time between exercises (rack changes, station moves,
 * water break). 30s per transition is conservative for a typical
 * gym setup.
 */
export const DEFAULT_TRANSITION_SEC = 30;

/**
 * Default rest between sets when an exercise prescription doesn't
 * specify one. 90s is a typical hypertrophy default.
 */
export const DEFAULT_REST_SEC = 90;

/**
 * Minimum credible duration for a strength session. Below this we
 * flag a "rebuild" because no reasonable strength block fits
 * meaningful warmup + work + cooldown in less time. Used as the
 * threshold for distinguishing "shrink the claim" from "rebuild
 * with more exercises".
 */
export const MIN_CREDIBLE_STRENGTH_MINUTES = 25;

// ─────────────────────────────────────────────────────────────────
// Per-exercise time estimation
// ─────────────────────────────────────────────────────────────────

/**
 * Parse a reps string into a numeric upper-bound for time
 * estimation. Examples and their interpretations:
 *
 *   "8"            → 8 reps
 *   "8-12"         → 12 reps (use upper bound — assumes user
 *                    completes the prescribed range)
 *   "10-15"        → 15 reps
 *   "10 each side" → 10 reps × 2 (unilateral)
 *   "AMRAP"        → fallback to 10 reps (no number; assume
 *                    moderate-set time-bounded effort)
 *   "30 sec hold"  → fallback to 10 (single-rep-equivalent;
 *                    actual hold time captured via secPerRep)
 *
 * The estimator deliberately uses the upper bound of a range
 * because under-estimating real session time is the worse error
 * (it's what produced the 48-min Dead Bug regression). Round-up
 * matches a coach's expectation of "this exercise will take at
 * MOST N minutes".
 */
export function parseRepsForTimeEstimate(reps: string): { numReps: number; isUnilateral: boolean } {
  const lower = reps.toLowerCase();
  const isUnilateral = lower.includes('each') || lower.includes('per side') || lower.includes('per leg') || lower.includes('per arm');
  const matches = lower.match(/\d+/g);
  if (!matches || matches.length === 0) {
    return { numReps: 10, isUnilateral };
  }
  const numReps = Math.max(...matches.map(Number));
  return { numReps, isUnilateral };
}

/**
 * Estimate the time in seconds for one set of an exercise. The
 * heuristic uses three factors:
 *
 *   1. Number of reps (parsed from the prescription)
 *   2. Movement pattern (from the exercise metadata, when available)
 *   3. Whether the movement is unilateral (doubles the working time)
 *
 * Per-rep time depends on the rep range:
 *   - 1-5 reps  (heavy compound, max strength): ~4 sec/rep
 *   - 6-14 reps (hypertrophy): ~3 sec/rep
 *   - 15+ reps  (high-volume, endurance, isolation): ~2 sec/rep
 *
 * Core movements (dead_bug, plank, etc.) are slower-controlled, so
 * they bias toward 2.5 sec/rep regardless of count.
 *
 * Setup time (5 sec) is added per set — wraps grip, stance, and
 * brace phases that don't scale with rep count.
 */
export function estimateExerciseSetSeconds(
  prescription: ExercisePrescription,
  exerciseMeta: Exercise | undefined,
): number {
  const { numReps, isUnilateral } = parseRepsForTimeEstimate(prescription.reps);

  let secPerRep: number;
  if (exerciseMeta?.movementPattern === 'core' || exerciseMeta?.movementPattern === 'mobility') {
    // Slow + controlled — dead_bug, plank-family, hollow_hold, etc.
    // The pre-Slice-4.A bug specifically misjudged Dead Bug as
    // contributing 48 min worth of work; estimating it slowly is
    // correct (slow + controlled) but the TOTAL session time
    // requires accumulating multiple movements.
    secPerRep = 2.5;
  } else if (numReps <= 5) {
    secPerRep = 4; // heavy compound
  } else if (numReps >= 15) {
    secPerRep = 2; // light/endurance
  } else {
    secPerRep = 3; // hypertrophy default
  }

  const setupSec = 5;
  let workingTimeSec = setupSec + numReps * secPerRep;
  if (isUnilateral) {
    workingTimeSec *= 2; // both sides
  }
  return workingTimeSec;
}

/**
 * Estimate the total time in seconds for an entire exercise (all
 * its sets including the rest periods between sets, but NOT the
 * transition to the next exercise — that's added at the session
 * level).
 *
 * Rest formula: `(sets - 1) * restSec` because rest happens
 * BETWEEN sets, not after the last set. The transition out of the
 * last set is captured by the session-level transition counter.
 */
export function estimateExerciseTotalSeconds(
  prescription: ExercisePrescription,
  exerciseMeta: Exercise | undefined,
): number {
  const setSec = estimateExerciseSetSeconds(prescription, exerciseMeta);
  const restSec = prescription.restSec ?? DEFAULT_REST_SEC;
  return prescription.sets * setSec + Math.max(0, prescription.sets - 1) * restSec;
}

// ─────────────────────────────────────────────────────────────────
// Session-level estimation
// ─────────────────────────────────────────────────────────────────

export interface SessionEstimateOptions {
  warmupMinutes?: number;
  cooldownMinutes?: number;
  transitionSec?: number;
}

/**
 * Estimate the total minutes for a strength session given its
 * exercise list + the coach knowledge (for movement-pattern lookup).
 * Includes warmup + exercises + transitions + cooldown.
 *
 * Returns minutes (rounded). Used by `validateSessionCoherence` and
 * exported so callers can reason about expected session length
 * directly (e.g. for UI hints or planning constraints).
 */
export function estimateStrengthSessionMinutes(
  session: Pick<Session, 'exercises'>,
  knowledge: CoachKnowledgeBase,
  options: SessionEstimateOptions = {},
): number {
  const exercises = session.exercises ?? [];
  const warmupSec = (options.warmupMinutes ?? DEFAULT_WARMUP_MINUTES) * 60;
  const cooldownSec = (options.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60;
  const transitionSec = options.transitionSec ?? DEFAULT_TRANSITION_SEC;

  if (exercises.length === 0) {
    return Math.round((warmupSec + cooldownSec) / 60);
  }

  const exerciseMetaById = new Map<string, Exercise>(knowledge.exercises.map((ex: Exercise) => [ex.id, ex]));
  let totalSec = warmupSec + cooldownSec;
  for (let i = 0; i < exercises.length; i++) {
    totalSec += estimateExerciseTotalSeconds(exercises[i], exerciseMetaById.get(exercises[i].exerciseId));
    if (i < exercises.length - 1) {
      totalSec += transitionSec;
    }
  }
  return Math.round(totalSec / 60);
}

// ─────────────────────────────────────────────────────────────────
// Coherence verdict
// ─────────────────────────────────────────────────────────────────

export type CoherenceVerdict =
  | { ok: true; estimatedMinutes: number; claimedMinutes: number }
  | {
      ok: false;
      reason: 'underfilled' | 'overstuffed';
      estimatedMinutes: number;
      claimedMinutes: number;
      deviationPct: number;
    };

/**
 * Validate that a session's exercise content matches its claimed
 * `durationMinutes`. Returns a discriminated verdict.
 *
 * Non-strength sports (running, cycling, swimming) short-circuit to
 * `ok` because the duration of a run/ride/swim IS the session
 * length — there's no "exercise list" to validate against.
 *
 * Tolerance is symmetric: a session within `tolerancePct` of the
 * claimed minutes (in either direction) returns `ok`. Below
 * tolerance → `underfilled`. Above → `overstuffed`.
 */
export function validateSessionCoherence(
  session: Session,
  knowledge: CoachKnowledgeBase,
  tolerancePct: number = DEFAULT_COHERENCE_TOLERANCE_PCT,
  options?: SessionEstimateOptions,
): CoherenceVerdict {
  if (session.sport !== 'strength') {
    return {
      ok: true,
      estimatedMinutes: session.durationMinutes,
      claimedMinutes: session.durationMinutes,
    };
  }

  const estimatedMinutes = estimateStrengthSessionMinutes(session, knowledge, options);
  const claimedMinutes = session.durationMinutes;

  if (claimedMinutes <= 0) {
    // Defensive: zero-duration sessions can't be validated against
    // tolerance. Treat as ok (the planner will reject zero-duration
    // sessions via other paths).
    return { ok: true, estimatedMinutes, claimedMinutes };
  }

  const deviation = Math.abs(estimatedMinutes - claimedMinutes) / claimedMinutes;
  if (deviation <= tolerancePct) {
    return { ok: true, estimatedMinutes, claimedMinutes };
  }

  return {
    ok: false,
    reason: estimatedMinutes < claimedMinutes ? 'underfilled' : 'overstuffed',
    estimatedMinutes,
    claimedMinutes,
    deviationPct: Number(deviation.toFixed(3)),
  };
}

// ─────────────────────────────────────────────────────────────────
// Corrective actions
// ─────────────────────────────────────────────────────────────────

export type CorrectiveAction =
  | { type: 'accept' }
  | { type: 'shrinkDuration'; newDurationMinutes: number; reason: string }
  | { type: 'rebuild'; targetExtraExercises: number; reason: string }
  | { type: 'trimContent'; keepExerciseCount: number; reason: string };

/**
 * Suggest a corrective action for a coherence verdict.
 *
 * Decision tree:
 *   - verdict `ok`             → `accept`
 *   - underfilled, est ≥ MIN   → `shrinkDuration` (lower the claim
 *                                to match content)
 *   - underfilled, est < MIN   → `rebuild` (add more exercises so
 *                                the session is at least credible)
 *   - overstuffed              → `trimContent` (keep the most
 *                                important leading exercises, drop
 *                                trailing accessories)
 *
 * The "rebuild" path is structural. Callers should try a catalog-
 * aware repair before falling back to MIN_CREDIBLE_STRENGTH_MINUTES.
 *
 * For `trimContent`, the keep count is computed from the estimated
 * minutes: if the session is 50% over the claim, drop the bottom
 * ~25% of the exercise list (which is typically accessory work the
 * resolveExercises filler logic appended). Always keep at least
 * the first 2 exercises so the session retains its primary focus.
 */
export function suggestCorrection(
  verdict: CoherenceVerdict,
  session: Session,
): CorrectiveAction {
  if (verdict.ok) {
    return { type: 'accept' };
  }

  if (verdict.reason === 'underfilled') {
    if (verdict.estimatedMinutes >= MIN_CREDIBLE_STRENGTH_MINUTES) {
      return {
        type: 'shrinkDuration',
        newDurationMinutes: verdict.estimatedMinutes,
        reason: `Session content estimated at ${verdict.estimatedMinutes}min; claimed ${verdict.claimedMinutes}min. Shrinking claim to match content (deviation ${(verdict.deviationPct * 100).toFixed(0)}%).`,
      };
    }
    return {
      type: 'rebuild',
      targetExtraExercises: 2,
      reason: `Session estimated at only ${verdict.estimatedMinutes}min for a ${verdict.claimedMinutes}min slot — below MIN_CREDIBLE_STRENGTH_MINUTES (${MIN_CREDIBLE_STRENGTH_MINUTES}min). Caller should try a catalog-aware rebuild before falling back to shrinkDuration.`,
    };
  }

  // overstuffed — trim trailing accessories
  const currentCount = session.exercises?.length ?? 0;
  const overflowRatio = (verdict.estimatedMinutes - verdict.claimedMinutes) / verdict.claimedMinutes;
  // Drop ~25% per 50% overflow, but always keep at least 2
  const dropCount = Math.max(1, Math.floor(currentCount * (overflowRatio / 2)));
  const keepExerciseCount = Math.max(2, currentCount - dropCount);
  return {
    type: 'trimContent',
    keepExerciseCount,
    reason: `Session estimated at ${verdict.estimatedMinutes}min for a ${verdict.claimedMinutes}min slot (${(verdict.deviationPct * 100).toFixed(0)}% over). Trimming trailing accessory work to the first ${keepExerciseCount} exercises.`,
  };
}

export interface TrimOverstuffedStrengthOptions {
  minimumExerciseCount?: number;
  tag?: string;
  alternative?: string;
}

export function trimOverstuffedStrengthSessionToDuration(
  session: Session,
  knowledge: CoachKnowledgeBase,
  options: TrimOverstuffedStrengthOptions = {},
): { session: Session; changed: boolean; verdict: CoherenceVerdict } {
  const initialVerdict = validateSessionCoherence(session, knowledge);
  if (
    session.sport !== 'strength'
    || !session.exercises?.length
    || initialVerdict.ok
    || initialVerdict.reason !== 'overstuffed'
  ) {
    return { session, changed: false, verdict: initialVerdict };
  }

  const minimumExerciseCount = options.minimumExerciseCount
    ?? (session.durationMinutes <= 30 ? 2 : session.durationMinutes <= 45 ? 3 : 4);
  let exercises = session.exercises.map((exercise) => ({ ...exercise }));
  let next: Session = { ...session, exercises };
  let verdict: CoherenceVerdict = initialVerdict;
  let changed = false;

  for (let iteration = 0; iteration < 12; iteration++) {
    if (verdict.ok || verdict.reason !== 'overstuffed') break;

    if (exercises.length > minimumExerciseCount) {
      exercises = exercises.slice(0, -1);
      changed = true;
    } else {
      const reducerIndex = lastExerciseWithReducibleSets(exercises);
      if (reducerIndex < 0) break;
      exercises = exercises.map((exercise, index) => index === reducerIndex
        ? reduceExerciseForTimeCap(exercise)
        : exercise);
      changed = true;
    }

    next = { ...next, exercises };
    verdict = validateSessionCoherence(next, knowledge);
  }

  if (!changed) return { session, changed: false, verdict };

  return {
    session: {
      ...next,
      tags: [...new Set([...next.tags, options.tag ?? 'duration_coherent'])],
      alternatives: [
        ...new Set([
          ...(next.alternatives ?? []),
          options.alternative ?? 'Trailing strength volume was trimmed so the session matches the scheduled duration.',
        ]),
      ],
    },
    changed: true,
    verdict,
  };
}

function lastExerciseWithReducibleSets(exercises: ExercisePrescription[]): number {
  for (let index = exercises.length - 1; index >= 0; index--) {
    if (exercises[index].sets > 1) return index;
  }
  return -1;
}

function reduceExerciseForTimeCap(exercise: ExercisePrescription): ExercisePrescription {
  return {
    ...exercise,
    sets: Math.max(1, exercise.sets - 1),
    restSec: Math.min(exercise.restSec ?? 60, 60),
    rir: exercise.rir != null ? Math.max(exercise.rir, 3) : 3,
    notes: exercise.notes
      ? `${exercise.notes} Time cap: reduced set volume to keep the session honest.`
      : 'Time cap: reduced set volume to keep the session honest.',
  };
}
