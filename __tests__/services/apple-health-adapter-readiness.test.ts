// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Garmin syncs sleep, steps, workouts and resting heart rate to Apple Health
 * but NOT HRV Status, so a Garmin-only iOS user has no HRV rows at all.
 *
 * This covers `deriveAdapterReadinessScore`, the composite behind
 * `AppleHealthAdapter.getReadiness`. It was previously inline in the adapter,
 * inside a block guarded by `require('../readiness-scorer')` — added to dodge
 * the adapter → readiness-scorer → wearable-service → adapter cycle. Under
 * vitest that `require` throws and the surrounding catch swallows it, so the
 * composite silently produced `null` and none of this arithmetic was reachable
 * from a test. The adapter also pulls its helpers through that `require`,
 * which types them `any` — so `strict: true` does not check arithmetic on a
 * possibly-null HRV score. These cases stand in for that missing type check.
 */

import { describe, expect, it } from 'vitest';
import { deriveAdapterReadinessScore } from '../../src/services/readiness-scorer';

describe('deriveAdapterReadinessScore', () => {
  const goodSleep = { sleepScore: 85, sleepDurationHours: 8, bodyBatteryScore: 80 };

  it('uses HRV when it was measured today', () => {
    // 90*0.30 + scoreSleep(8, 85)=85*0.30 + 80*0.20 + 60*0.20 = 27+25.5+16+12
    expect(deriveAdapterReadinessScore({ hrvScore: 90, ...goodSleep })).toBe(81);
  });

  it('redistributes rather than collapsing the term to zero when HRV is absent', () => {
    // `null * 0.30` is 0 in JavaScript, not a skipped term. Left unguarded it
    // reports a catastrophic recovery score off a perfectly normal night.
    const withoutHrv = deriveAdapterReadinessScore({ hrvScore: null, ...goodSleep });

    // (25.5 + 16 + 12) / 0.70 = 76.43 -> 76
    expect(withoutHrv).toBe(76);
    expect(withoutHrv).toBeGreaterThan(60);
  });

  it('never returns the zero-collapse value for an otherwise healthy day', () => {
    // What the unguarded arithmetic would have produced: 0 + 25.5 + 16 + 12.
    const collapsed = Math.round(0 * 0.30 + 85 * 0.30 + 80 * 0.20 + 60 * 0.20);
    expect(deriveAdapterReadinessScore({ hrvScore: null, ...goodSleep })).not.toBe(collapsed);
  });

  it('still tracks the measured signals once HRV drops out', () => {
    const poor = deriveAdapterReadinessScore({
      hrvScore: null, sleepScore: 20, sleepDurationHours: 3, bodyBatteryScore: 25,
    });
    const good = deriveAdapterReadinessScore({ hrvScore: null, ...goodSleep });

    expect(good).toBeGreaterThan(poor);
  });

  it('falls back to a neutral sleep term rather than zero when sleep is absent', () => {
    const noSleep = deriveAdapterReadinessScore({
      hrvScore: null, sleepScore: null, sleepDurationHours: 0, bodyBatteryScore: 60,
    });

    // Everything neutral -> (60*0.30 + 60*0.20 + 60*0.20) / 0.70 = 60.
    expect(noSleep).toBe(60);
  });

  it('clamps into 0-100', () => {
    const high = deriveAdapterReadinessScore({
      hrvScore: 100, sleepScore: 100, sleepDurationHours: 9, bodyBatteryScore: 100,
    });
    const low = deriveAdapterReadinessScore({
      hrvScore: 0, sleepScore: 0, sleepDurationHours: 0, bodyBatteryScore: 0,
    });

    expect(high).toBeLessThanOrEqual(100);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});
