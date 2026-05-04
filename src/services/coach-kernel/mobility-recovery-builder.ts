// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Mobility recovery exercise list builder (P2 follow-up to the
// 2026-05-03 `time_volume_coherence` recovery-variant fix).
//
// The 2026-05-03 fix made the planner HONEST: empty-block mobility
// recovery sessions had their claimed `durationMinutes` shrunk to
// the warmup+cooldown floor (~13 min) so we no longer claim 25 min
// while delivering 0 minutes of content. That closed the credibility
// gap.
//
// This module closes the EQUITY gap: instead of shrinking the claim,
// we now actually populate the session with mobility exercises pulled
// from the coach catalog so the variant can credibly claim 18-25 min
// AND deliver that content. Only fires for the `mobility` recovery
// scenario in `poor-recovery-variation.ts`.
//
// Design choices:
//
//  1. **Catalog-grounded.** Every exercise in the output is a real
//     `Exercise` row in `knowledge/entities/exercises.json` with
//     `movementPattern === 'mobility'`. The selection is deterministic
//     (no random seed) because session-coherence math depends on
//     stable durations.
//
//  2. **Time-aware.** The builder targets a specific minute count by
//     adjusting set/rep counts. The session-coherence estimator is
//     `~2.5 sec/rep + 5 sec setup` for mobility-pattern exercises;
//     this builder mirrors that math when picking sets/reps so the
//     final claim matches estimated content within ±2 minutes.
//
//  3. **Movement-pattern variety.** A mobility flow that's "all hip
//     flexor stretch" is no better than an empty block. The selector
//     spans ≥3 distinct `warmupNeeds` (e.g. spine, hip, thoracic) so
//     the user actually moves through different planes of motion.
//
//  4. **Beginner-safe by default.** Mobility variants happen on
//     poor-recovery days. We pick `complexity: 'beginner'` exercises
//     with `fatigueCost: 'low'` to avoid prescribing a Jefferson Curl
//     (intermediate, moderate spinal loading) at the same moment we're
//     downshifting because the athlete is tired.

import type { CoachKnowledgeBase, Exercise, ExercisePrescription } from './types';

/**
 * The minute range this builder is designed to credibly fill. Below
 * `MOBILITY_TARGET_MIN_MINUTES` we let the session-coherence shrink
 * fire instead — there's no value in a 12-min flow that's barely
 * different from warmup+cooldown. Above `MOBILITY_TARGET_MAX_MINUTES`
 * we cap at the upper bound; the user is fatigued, so a 35-min
 * mobility block is overkill.
 */
export const MOBILITY_TARGET_MIN_MINUTES = 18;
export const MOBILITY_TARGET_MAX_MINUTES = 25;

/**
 * Per-set wall time for a mobility exercise (matches the
 * session-coherence estimator's secPerRep=2.5 for mobility pattern,
 * plus 5s setup). The builder uses this to size sets.
 */
export const MOBILITY_SECONDS_PER_REP = 2.5;
export const MOBILITY_SETUP_SECONDS = 5;
export const MOBILITY_REST_BETWEEN_SETS_SECONDS = 30;
export const MOBILITY_TRANSITION_BETWEEN_EXERCISES_SECONDS = 30;

/**
 * Default warmup + cooldown wrapper minutes the session-coherence
 * estimator assumes. Kept here so the builder can compute a target
 * "exercise budget" without re-importing the constants.
 */
export const MOBILITY_WARMUP_MINUTES = 8;
export const MOBILITY_COOLDOWN_MINUTES = 5;

/**
 * Estimate seconds for one mobility exercise prescription using the
 * same math the session-coherence estimator uses. Exposed for tests.
 */
export function estimateMobilityExerciseSeconds(prescription: {
  sets: number;
  reps: string;
  isUnilateral: boolean;
}): number {
  const numReps = parseRepsForBuilderMath(prescription.reps);
  const secPerRep = MOBILITY_SECONDS_PER_REP;
  let workSec = MOBILITY_SETUP_SECONDS + numReps * secPerRep;
  if (prescription.isUnilateral) workSec *= 2;
  // sets × set-time + rest-between-sets × (sets - 1)
  const setSec = workSec;
  const restSec = MOBILITY_REST_BETWEEN_SETS_SECONDS;
  return prescription.sets * setSec + Math.max(0, prescription.sets - 1) * restSec;
}

/**
 * Local rep parser. Mirrors `parseRepsForTimeEstimate` in
 * `session-coherence.ts` exactly — duplicated rather than imported
 * to keep the builder a leaf module (no cycles). The two parsers MUST
 * stay in lock-step; the test suite asserts this.
 */
function parseRepsForBuilderMath(reps: string): number {
  const matches = reps.toLowerCase().match(/\d+/g);
  if (!matches || matches.length === 0) return 10;
  return Math.max(...matches.map(Number));
}

/**
 * Pure-mobility candidates from the catalog. Filters for:
 *   - movementPattern === 'mobility' (excludes squat/single_leg
 *     entries that have mobility primaryPurpose; those are still
 *     loaded movements).
 *   - primaryPurpose === 'mobility'
 *   - complexity === 'beginner' (poor-recovery is not the time for
 *     advanced patterns).
 *   - fatigueCost === 'low'
 *
 * Sorted deterministically by id so two callers with the same input
 * get the same output.
 */
export function selectMobilityRecoveryCandidates(
  knowledge: CoachKnowledgeBase,
): Exercise[] {
  return knowledge.exercises
    .filter((e: Exercise) =>
      e.movementPattern === 'mobility'
      && e.primaryPurpose === 'mobility'
      && e.complexity === 'beginner'
      && e.fatigueCost === 'low',
    )
    .sort((a: Exercise, b: Exercise) => a.id.localeCompare(b.id));
}

/**
 * Build a mobility-recovery exercise list whose session-coherence
 * estimate lands in [MOBILITY_TARGET_MIN_MINUTES,
 * MOBILITY_TARGET_MAX_MINUTES]. Returns `null` when the catalog has
 * insufficient candidates — the caller falls back to empty-block.
 *
 * Algorithm:
 *  1. Compute `exerciseBudgetSec = (targetMinutes -
 *     warmup - cooldown) * 60` minus per-transition overhead.
 *  2. Pick 4-5 distinct candidates spanning ≥3 `warmupNeeds`.
 *  3. Prescribe each at 2 sets × 10 reps (15-side reps if
 *     unilateral). With mobility math: 2 sets × (5+10×2.5) =
 *     2×30=60s + 30s rest = 90s per exercise. Plus 30s transition.
 *     5 exercises ≈ 5×90 + 4×30 = 570s ≈ 9.5 min.
 *  4. Together with warmup (8min) + cooldown (5min): 22.5 min.
 *  5. If still short of target, increment sets on one bilateral
 *     exercise; if over, drop the last one.
 */
export function buildMobilityRecoveryExerciseList(
  knowledge: CoachKnowledgeBase,
  targetMinutes: number,
): ExercisePrescription[] | null {
  const candidates = selectMobilityRecoveryCandidates(knowledge);
  if (candidates.length < 4) {
    // Too few catalog options to span 3 distinct warmup needs.
    return null;
  }

  // Target the middle of the band when caller asks for a value
  // outside our credible range.
  const clampedTarget = Math.max(
    MOBILITY_TARGET_MIN_MINUTES,
    Math.min(MOBILITY_TARGET_MAX_MINUTES, targetMinutes),
  );

  // Subtract warmup+cooldown to get the exercise wall-time budget.
  const wrapperSec = (MOBILITY_WARMUP_MINUTES + MOBILITY_COOLDOWN_MINUTES) * 60;
  const budgetSec = clampedTarget * 60 - wrapperSec;

  // Pick candidates in two passes:
  //  Pass 1: greedy — only accept candidates that introduce a new
  //          warmupNeeds bucket (max 4 picks here).
  //  Pass 2: fill — add remaining candidates regardless of bucket
  //          overlap until we have 4-5 total.
  // This guarantees ≥3 distinct buckets when the catalog supports it
  // AND avoids the "exhausted-novel-buckets-but-still-only-3-picks"
  // dead-end the previous strict-no-overlap pass produced.
  const picked: Exercise[] = [];
  const pickedIds = new Set<string>();
  const seenWarmupNeeds = new Set<string>();
  for (const cand of candidates) {
    if (picked.length >= 5) break;
    const needs = cand.warmupNeeds ?? [];
    const addsNewBucket = needs.some((n: string) => !seenWarmupNeeds.has(n));
    if (addsNewBucket || picked.length === 0) {
      picked.push(cand);
      pickedIds.add(cand.id);
      needs.forEach((n: string) => seenWarmupNeeds.add(n));
    }
  }

  // Fill pass: pad to 4-5 picks if greedy ran short.
  for (const cand of candidates) {
    if (picked.length >= 5) break;
    if (pickedIds.has(cand.id)) continue;
    picked.push(cand);
    pickedIds.add(cand.id);
    (cand.warmupNeeds ?? []).forEach((n: string) => seenWarmupNeeds.add(n));
  }

  if (picked.length < 4 || seenWarmupNeeds.size < 3) {
    // Either too few picks or too few distinct buckets — fall back to
    // empty-block. The session-coherence shrink path will keep the
    // duration claim credible.
    return null;
  }

  // Default prescription: 2 sets × 10 reps.
  const baseSets = 2;
  const baseReps = 10;
  const prescriptions: ExercisePrescription[] = picked.map((ex) => ({
    exerciseId: ex.id,
    name: ex.name,
    sets: baseSets,
    reps: ex.unilateral ? `${baseReps} per side` : String(baseReps),
    restSec: MOBILITY_REST_BETWEEN_SETS_SECONDS,
    notes: 'Mobility recovery flow — keep tempo controlled, no breath-holding.',
  }));

  // Estimate total seconds.
  const estTotalSec = prescriptions.reduce((sum, p, i) => {
    const exMeta = picked[i];
    const exSec = estimateMobilityExerciseSeconds({
      sets: p.sets,
      reps: p.reps,
      isUnilateral: Boolean(exMeta.unilateral),
    });
    const transitionSec =
      i < prescriptions.length - 1 ? MOBILITY_TRANSITION_BETWEEN_EXERCISES_SECONDS : 0;
    return sum + exSec + transitionSec;
  }, 0);

  // If under target by >120s, add one more set on the first bilateral exercise.
  if (estTotalSec + 120 < budgetSec && prescriptions.length > 0) {
    const bilateralIdx = picked.findIndex((p) => !p.unilateral);
    if (bilateralIdx >= 0) {
      prescriptions[bilateralIdx].sets += 1;
    }
  }

  // If over target by >120s, drop the last picked exercise.
  if (estTotalSec - 120 > budgetSec && prescriptions.length > 4) {
    prescriptions.pop();
  }

  return prescriptions;
}
