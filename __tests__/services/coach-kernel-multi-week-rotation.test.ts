import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  STRENGTH_SUPPORT_VARIANT_COUNT,
  buildStrengthSupportVariant,
} from '../../src/services/coach-kernel/support-session-builder';

/**
 * Slice 4.C — multi-week variant rotation pin tests.
 *
 * The audit flagged that pre-slice the strength-engine slot rotation
 * was indexed only on within-week position, so Week 1 day 1 = Week 5
 * day 1 = Week 12 day 1 across an 8-week plan. Slice 4.C adds a
 * weekIndex shift so successive weeks rotate the (slot → variant)
 * mapping.
 *
 * `strengthVariantFor` is internal to the strength engine. The
 * support-session-builder exposes the same shift mechanism via
 * `buildStrengthSupportVariant(slotIndex, knowledge?, weekIndex?)`,
 * which is what these tests pin. The strength-engine's variant table
 * is structurally analogous and the same slot-shift formula is in
 * place; pinning the support-builder's external behavior gives us
 * the visible coverage.
 */

const knowledge = loadCoachKnowledge();

describe('coach-kernel/support-session-builder — multi-week rotation (slice 4.C)', () => {
  it('week 0 produces the canonical [Lower A, Upper A, Lower B, Upper B] order', () => {
    const titles = [0, 1, 2, 3].map((i) => buildStrengthSupportVariant(i, knowledge, 0).title);
    expect(titles).toEqual([
      'Lower Body Strength A',
      'Upper Body Strength A',
      'Lower Body Strength B',
      'Upper Body Strength B',
    ]);
  });

  it('week 1 shifts the rotation by 1: slot 0 picks the variant week 0 had at slot 1', () => {
    const week0Slot0 = buildStrengthSupportVariant(0, knowledge, 0).title;
    const week0Slot1 = buildStrengthSupportVariant(1, knowledge, 0).title;
    const week1Slot0 = buildStrengthSupportVariant(0, knowledge, 1).title;
    expect(week1Slot0).toBe(week0Slot1);
    expect(week1Slot0).not.toBe(week0Slot0);
  });

  it('successive weeks at the same slot pick distinct variants for 4 weeks', () => {
    const slot0Across4Weeks = [0, 1, 2, 3].map((week) =>
      buildStrengthSupportVariant(0, knowledge, week).title,
    );
    expect(new Set(slot0Across4Weeks).size).toBe(4);
  });

  it('rotation cycles after STRENGTH_SUPPORT_VARIANT_COUNT weeks', () => {
    const week0 = buildStrengthSupportVariant(0, knowledge, 0).title;
    const week4 = buildStrengthSupportVariant(0, knowledge, STRENGTH_SUPPORT_VARIANT_COUNT).title;
    const week8 = buildStrengthSupportVariant(0, knowledge, STRENGTH_SUPPORT_VARIANT_COUNT * 2).title;
    expect(week4).toBe(week0);
    expect(week8).toBe(week0);
  });

  it('within a single week, slot rotation still alternates body region (no regression on slice 4.B)', () => {
    for (const week of [0, 1, 2, 3]) {
      const regions = [0, 1, 2, 3].map((i) => {
        const variant = buildStrengthSupportVariant(i, knowledge, week);
        return variant.tags.includes('lower_body')
          ? 'lower'
          : variant.tags.includes('upper_body')
            ? 'upper'
            : 'other';
      });
      // Consecutive slots must alternate even with the week shift applied.
      for (let i = 1; i < regions.length; i++) {
        expect(regions[i]).not.toBe(regions[i - 1]);
      }
    }
  });

  it('an 8-week plan with 4 strength/week produces ≥4 distinct variants per slot', () => {
    // Audit's acceptance criterion: at least 4 distinct variants
    // appear at any given slot across 8 weeks.
    for (const slot of [0, 1, 2, 3]) {
      const acrossWeeks = Array.from({ length: 8 }, (_, week) =>
        buildStrengthSupportVariant(slot, knowledge, week).title,
      );
      expect(new Set(acrossWeeks).size).toBeGreaterThanOrEqual(4);
    }
  });

  it('omitting weekIndex preserves the pre-slice-4.C behavior (backward compatible)', () => {
    const withoutWeek = buildStrengthSupportVariant(0, knowledge).title;
    const week0 = buildStrengthSupportVariant(0, knowledge, 0).title;
    expect(withoutWeek).toBe(week0);
  });

  it('negative weekIndex is clamped to 0 (no overflow into past)', () => {
    const negTitle = buildStrengthSupportVariant(0, knowledge, -3).title;
    const week0 = buildStrengthSupportVariant(0, knowledge, 0).title;
    expect(negTitle).toBe(week0);
  });

  it('large weekIndex still lands deterministically inside the rotation pool', () => {
    const week0Title = buildStrengthSupportVariant(0, knowledge, 0).title;
    const farFutureTitle = buildStrengthSupportVariant(0, knowledge, 1_000_004).title;
    // 1_000_004 mod 4 = 0 → same as week 0.
    expect(farFutureTitle).toBe(week0Title);
  });
});
