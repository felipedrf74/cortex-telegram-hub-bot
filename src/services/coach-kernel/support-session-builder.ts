// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Strength support session builder — slice 4.B.
 *
 * Replaces the legacy `strengthSupportVariants()` text-string dump in
 * `services/training-plan-volume-enforcement.ts` with a typed,
 * catalog-grounded variant selector.
 *
 * Why this exists:
 *
 *   - The old helper returned exercises as `{ name: 'Front Squat /
 *     Goblet Squat', sets: 4, reps: '6-8', rpe: '7', rest_sec: 90 }`
 *     — slashed compound names, snake_case fields, no `exerciseId`,
 *     no path back to the catalog. Duration was hardcoded
 *     (50/48/45/45) and the planner trusted it blindly.
 *
 *   - That meant the slice 4.A coherence gate never saw a real
 *     exercise list it could reason about, downstream UIs couldn't
 *     resolve substitutions, and the variants couldn't participate
 *     in the equipment-aware fallback that the Coach engine applies
 *     elsewhere.
 *
 *   - It also shipped regression #2 from the Phase 0 audit: with only
 *     two of the four variants ever instantiated (because the modulo
 *     index started at 0 and the planner only inserted up to 2-3
 *     support sessions per week), the same Lower-A/Upper-A pair
 *     appeared on consecutive days, looking like "3 identical strength
 *     days" to the user. Real catalog IDs let the rotator be honest
 *     about which slot it's filling and the per-variant tag set lets
 *     downstream renderers express the rotation in the UI.
 *
 * Contract:
 *
 *   - `buildStrengthSupportVariant(slotIndex, knowledge?)` is pure.
 *     It takes the support-session slot number (0-indexed) and the
 *     loaded `CoachKnowledgeBase` and returns a fully-typed
 *     `StrengthSupportVariant`.
 *
 *   - `durationMinutes` is COMPUTED via the slice 4.A
 *     `estimateStrengthSessionMinutes` whenever knowledge is
 *     supplied — never declared. If knowledge is absent (e.g. a
 *     test that doesn't load the catalog), we fall back to the
 *     `MIN_CREDIBLE_STRENGTH_MINUTES` floor so the planner never
 *     ships a comically short claim.
 *
 *   - Variants use beginner-safe defaults consistent with slice 2.A
 *     (goblet over front, dumbbell bench over barbell, lat pulldown
 *     over pull-up, hip-hinge-band over RDL, split-squat over
 *     single-leg-RDL). Any further substitution should be applied by
 *     the caller using the equipment-aware substitution logic in
 *     `engines/strength-engine.ts` — this builder only seeds the
 *     starting prescription.
 */

import type { CoachKnowledgeBase, ExercisePrescription } from './types';
import {
  estimateStrengthSessionMinutes,
  MIN_CREDIBLE_STRENGTH_MINUTES,
} from './session-coherence';

export interface StrengthSupportVariant {
  /** Human-readable title (no sport-prefix; caller may decorate). */
  title: string;
  /** Honest, estimator-derived minutes — never a hardcoded claim. */
  durationMinutes: number;
  /** Catalog-grounded prescriptions with `exerciseId` always set. */
  exercises: ExercisePrescription[];
  /**
   * Stable tag list so downstream consumers can render variant
   * provenance ("Lower B", "Upper A") without parsing the title.
   */
  tags: string[];
}

interface SupportVariantBlueprint {
  title: string;
  tags: string[];
  exercises: ExercisePrescription[];
}

/**
 * Four-week rotation chosen so consecutive support slots never share
 * a primary movement pattern. Slot 0 → squat/hinge, slot 1 →
 * push/pull, slot 2 → squat/hinge variation, slot 3 → push/pull
 * variation. The audit-confirmed regression #2 was the planner using
 * the same Lower-A/Upper-A pair across the week; this rotation makes
 * "two consecutive identical strength sessions" structurally
 * impossible.
 */
const VARIANT_BLUEPRINTS: SupportVariantBlueprint[] = [
  // Variant 0 — Lower A (squat + hinge primary)
  {
    title: 'Lower Body Strength A',
    tags: ['support', 'strength', 'lower_body', 'variant_lower_a'],
    exercises: [
      { exerciseId: 'goblet_squat', name: 'Goblet Squat', sets: 4, reps: '8-10', rir: 2, restSec: 90 },
      { exerciseId: 'hip_hinge_band', name: 'Banded Hip Hinge', sets: 3, reps: '10-12', rir: 2, restSec: 75 },
      { exerciseId: 'split_squat', name: 'Split Squat', sets: 3, reps: '8 each side', rir: 2, restSec: 75 },
      { exerciseId: 'farmer_carry', name: 'Farmer Carry', sets: 3, reps: '40m', rir: 2, restSec: 60 },
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 3, reps: '10 each side', rir: 3, restSec: 30 },
    ],
  },
  // Variant 1 — Upper A (push + pull primary)
  {
    title: 'Upper Body Strength A',
    tags: ['support', 'strength', 'upper_body', 'variant_upper_a'],
    exercises: [
      { exerciseId: 'dumbbell_bench_press', name: 'Dumbbell Bench Press', sets: 4, reps: '8-10', rir: 2, restSec: 90 },
      { exerciseId: 'lat_pulldown', name: 'Lat Pulldown', sets: 4, reps: '8-10', rir: 2, restSec: 90 },
      { exerciseId: 'one_arm_dumbbell_row', name: 'One-Arm Dumbbell Row', sets: 3, reps: '10 each side', rir: 2, restSec: 60 },
      { exerciseId: 'suitcase_carry', name: 'Suitcase Carry', sets: 3, reps: '30m each side', rir: 2, restSec: 60 },
      { exerciseId: 'hollow_hold', name: 'Hollow Hold', sets: 3, reps: '25-35s', rir: 3, restSec: 30 },
    ],
  },
  // Variant 2 — Lower B (single-leg + hinge variation)
  {
    title: 'Lower Body Strength B',
    tags: ['support', 'strength', 'lower_body', 'variant_lower_b'],
    exercises: [
      { exerciseId: 'goblet_squat', name: 'Goblet Squat', sets: 3, reps: '10-12', rir: 2, restSec: 75 },
      { exerciseId: 'single_leg_rdl', name: 'Single-Leg RDL', sets: 3, reps: '8 each side', rir: 2, restSec: 75 },
      { exerciseId: 'lunging_iso_hold', name: 'Lunging Iso Hold', sets: 3, reps: '25s each side', rir: 2, restSec: 60 },
      { exerciseId: 'hip_hinge_band', name: 'Banded Hip Hinge', sets: 3, reps: '12', rir: 3, restSec: 45 },
      { exerciseId: 'bear_crawl', name: 'Bear Crawl', sets: 3, reps: '20m', rir: 3, restSec: 45 },
    ],
  },
  // Variant 3 — Upper B (push + pull variation, mid-rep)
  {
    title: 'Upper Body Strength B',
    tags: ['support', 'strength', 'upper_body', 'variant_upper_b'],
    exercises: [
      { exerciseId: 'dumbbell_bench_press', name: 'Dumbbell Bench Press', sets: 3, reps: '10-12', rir: 2, restSec: 75 },
      { exerciseId: 'lat_pulldown', name: 'Lat Pulldown', sets: 3, reps: '10-12', rir: 2, restSec: 75 },
      { exerciseId: 'push_up', name: 'Push-Up', sets: 3, reps: '10-12', rir: 2, restSec: 60 },
      { exerciseId: 'sandbag_hold', name: 'Sandbag Hold', sets: 3, reps: '30-40s', rir: 2, restSec: 60 },
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 3, reps: '10 each side', rir: 3, restSec: 30 },
    ],
  },
];

/**
 * Number of distinct support variants. Exposed so callers can
 * reason about the rotation period without importing the array.
 */
export const STRENGTH_SUPPORT_VARIANT_COUNT = VARIANT_BLUEPRINTS.length;

/**
 * Build a support-session variant from its rotation slot index.
 *
 * Pure. Negative indices are absolute-valued so the modulo always
 * lands in range. Returns a fresh object on every call (no shared
 * references back to the blueprint table).
 *
 * `durationMinutes` is computed by the slice 4.A estimator when
 * `knowledge` is supplied; otherwise the floor is returned. The
 * estimator already accounts for warmup + transitions + cooldown,
 * so the returned number is a real claim the coherence gate can
 * trust.
 */
export function buildStrengthSupportVariant(
  slotIndex: number,
  knowledge?: CoachKnowledgeBase,
): StrengthSupportVariant {
  const safeIndex = Math.abs(Math.trunc(slotIndex || 0));
  const blueprint = VARIANT_BLUEPRINTS[safeIndex % VARIANT_BLUEPRINTS.length];
  const exercises: ExercisePrescription[] = blueprint.exercises.map((ex) => ({ ...ex }));

  let durationMinutes: number;
  if (knowledge) {
    const estimate = estimateStrengthSessionMinutes({ exercises }, knowledge);
    durationMinutes = Math.max(estimate, MIN_CREDIBLE_STRENGTH_MINUTES);
  } else {
    durationMinutes = MIN_CREDIBLE_STRENGTH_MINUTES;
  }

  return {
    title: blueprint.title,
    durationMinutes,
    exercises,
    tags: [...blueprint.tags],
  };
}
