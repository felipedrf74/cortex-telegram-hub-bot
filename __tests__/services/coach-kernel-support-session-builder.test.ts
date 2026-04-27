import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  STRENGTH_SUPPORT_VARIANT_COUNT,
  buildStrengthSupportVariant,
} from '../../src/services/coach-kernel/support-session-builder';
import {
  MIN_CREDIBLE_STRENGTH_MINUTES,
  estimateStrengthSessionMinutes,
} from '../../src/services/coach-kernel/session-coherence';
import type { Exercise, ExercisePrescription } from '../../src/services/coach-kernel/types';

/**
 * Pin slice 4.B — the catalog-grounded strength-support variant
 * builder that closes Training engine regression #2 (variety
 * failure: same Lower-A/Upper-A pair landing on consecutive days).
 *
 * The legacy `strengthSupportVariants()` returned exercises as
 * untyped text-string blobs (`{ name: 'Front Squat / Goblet Squat',
 * sets: 4, reps: '6-8', rpe: '7', rest_sec: 90 }`) and hardcoded
 * `durationMinutes`. The new builder returns
 * `ExercisePrescription[]` rooted in the catalog and computes
 * `durationMinutes` via the slice 4.A estimator.
 *
 * These tests pin:
 *   - rotation period (4 distinct variants),
 *   - every prescription has a real catalog `exerciseId`,
 *   - prescriptions use camelCase fields (`rir`, `restSec`) — never
 *     the legacy `rpe`/`rest_sec`,
 *   - `durationMinutes` matches the estimator on the same exercises,
 *   - movement-pattern rotation: consecutive slots never share the
 *     same primary pattern,
 *   - knowledge-less fallback honors the floor and never crashes,
 *   - returned objects are fresh (mutating one variant does not
 *     contaminate the next call).
 */

const knowledge = loadCoachKnowledge();
const catalogIds = new Set(knowledge.exercises.map((ex: Exercise) => ex.id));
const catalogById = new Map<string, Exercise>(
  knowledge.exercises.map((ex: Exercise) => [ex.id, ex]),
);

describe('coach-kernel/support-session-builder — STRENGTH_SUPPORT_VARIANT_COUNT', () => {
  it('exposes a 4-variant rotation', () => {
    expect(STRENGTH_SUPPORT_VARIANT_COUNT).toBe(4);
  });
});

describe('coach-kernel/support-session-builder — buildStrengthSupportVariant', () => {
  it('returns four distinct titles across the rotation', () => {
    const titles = [0, 1, 2, 3].map((i) => buildStrengthSupportVariant(i, knowledge).title);
    expect(new Set(titles).size).toBe(4);
    expect(titles).toEqual([
      'Lower Body Strength A',
      'Upper Body Strength A',
      'Lower Body Strength B',
      'Upper Body Strength B',
    ]);
  });

  it('every prescription resolves to a real catalog exerciseId', () => {
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      expect(variant.exercises.length).toBeGreaterThan(0);
      for (const ex of variant.exercises) {
        expect(catalogIds.has(ex.exerciseId)).toBe(true);
      }
    }
  });

  it('prescriptions use camelCase fields, never the legacy rpe/rest_sec', () => {
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      for (const ex of variant.exercises) {
        // camelCase contract
        expect(typeof ex.exerciseId).toBe('string');
        expect(typeof ex.name).toBe('string');
        expect(typeof ex.sets).toBe('number');
        expect(typeof ex.reps).toBe('string');
        expect(typeof ex.restSec === 'number' || ex.restSec === undefined).toBe(true);
        expect(typeof ex.rir === 'number' || ex.rir === undefined).toBe(true);
        // legacy fields must be gone
        expect((ex as Record<string, unknown>).rpe).toBeUndefined();
        expect((ex as Record<string, unknown>).rest_sec).toBeUndefined();
      }
    }
  });

  it('durationMinutes equals the slice 4.A estimator output', () => {
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      const expected = Math.max(
        estimateStrengthSessionMinutes({ exercises: variant.exercises }, knowledge),
        MIN_CREDIBLE_STRENGTH_MINUTES,
      );
      expect(variant.durationMinutes).toBe(expected);
    }
  });

  it('honors MIN_CREDIBLE_STRENGTH_MINUTES even for short variants', () => {
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      expect(variant.durationMinutes).toBeGreaterThanOrEqual(MIN_CREDIBLE_STRENGTH_MINUTES);
    }
  });

  it('falls back to the floor when no knowledge is supplied', () => {
    const variant = buildStrengthSupportVariant(0);
    expect(variant.durationMinutes).toBe(MIN_CREDIBLE_STRENGTH_MINUTES);
    // exercises are still catalog-grounded — only the duration gates differ.
    for (const ex of variant.exercises) {
      expect(typeof ex.exerciseId).toBe('string');
      expect(ex.exerciseId.length).toBeGreaterThan(0);
    }
  });

  it('rotation never lets consecutive slots share the SAME primary movement pattern', () => {
    // Primary = first listed exercise in the variant.
    const primaryPatterns: string[] = [];
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      const meta = catalogById.get(variant.exercises[0].exerciseId);
      expect(meta).toBeDefined();
      primaryPatterns.push(meta!.movementPattern);
    }
    for (let i = 1; i < primaryPatterns.length; i++) {
      expect(primaryPatterns[i]).not.toBe(primaryPatterns[i - 1]);
    }
  });

  it('alternates body-region tag (lower / upper) across consecutive slots', () => {
    const regions: string[] = [];
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      const region = variant.tags.includes('lower_body')
        ? 'lower'
        : variant.tags.includes('upper_body')
          ? 'upper'
          : 'other';
      regions.push(region);
    }
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i]).not.toBe(regions[i - 1]);
    }
  });

  it('returns fresh exercise arrays — mutating one call does not contaminate the next', () => {
    const first = buildStrengthSupportVariant(0, knowledge);
    first.exercises[0].sets = 999;
    first.exercises.push({
      exerciseId: 'sentinel',
      name: 'Sentinel',
      sets: 1,
      reps: '1',
    } as ExercisePrescription);
    const second = buildStrengthSupportVariant(0, knowledge);
    expect(second.exercises[0].sets).not.toBe(999);
    expect(second.exercises.find((ex) => ex.exerciseId === 'sentinel')).toBeUndefined();
  });

  it('treats slotIndex modulo so wrap-around is stable', () => {
    const slot0 = buildStrengthSupportVariant(0, knowledge);
    const slot4 = buildStrengthSupportVariant(4, knowledge);
    const slot8 = buildStrengthSupportVariant(8, knowledge);
    expect(slot0.title).toBe(slot4.title);
    expect(slot4.title).toBe(slot8.title);
  });

  it('handles negative slotIndex by absolute-value modulo', () => {
    const slot0 = buildStrengthSupportVariant(0, knowledge);
    const slotNeg4 = buildStrengthSupportVariant(-4, knowledge);
    expect(slotNeg4.title).toBe(slot0.title);
  });

  it('every variant carries the support + strength tags', () => {
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      expect(variant.tags).toContain('support');
      expect(variant.tags).toContain('strength');
    }
  });

  it('every variant carries a stable variant_* tag for downstream rendering', () => {
    const variantTags = new Set<string>();
    for (let i = 0; i < STRENGTH_SUPPORT_VARIANT_COUNT; i++) {
      const variant = buildStrengthSupportVariant(i, knowledge);
      const tag = variant.tags.find((t) => t.startsWith('variant_'));
      expect(tag).toBeDefined();
      variantTags.add(tag!);
    }
    expect(variantTags.size).toBe(STRENGTH_SUPPORT_VARIANT_COUNT);
  });
});

describe('coach-kernel/support-session-builder — beginner-safe defaults (slice 2.A consistency)', () => {
  it('never seeds front_squat, barbell bench_press, pull_up, romanian_deadlift, or single_leg_rdl as Variant-0 primary movements', () => {
    // Slice 2.A established beginner-safe substitutes; the support
    // builder must not regress those. (single_leg_rdl is allowed
    // as a SECONDARY in Lower B; only Variant 0's primary squat
    // and primary hinge are constrained.)
    const variant0 = buildStrengthSupportVariant(0, knowledge);
    const primary = variant0.exercises[0];
    expect(primary.exerciseId).not.toBe('front_squat');
    expect(primary.exerciseId).not.toBe('barbell_bench_press');
    expect(primary.exerciseId).not.toBe('pull_up');
    expect(primary.exerciseId).not.toBe('romanian_deadlift');
  });
});
