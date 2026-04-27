import { describe, expect, it } from 'vitest';

import {
  resolveCyclingWeeklyMinutesWithSource,
  resolveRunningWeeklyMinutesWithSource,
} from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the discriminated-union output of
 * `resolveRunningWeeklyMinutesWithSource` and
 * `resolveCyclingWeeklyMinutesWithSource` introduced by
 * coach-engine slice 3.M (Layer 1 audit follow-up).
 *
 * Before slice 3.M the running/cycling weekly-minutes resolution
 * was an inline ternary inside `resolveTrainingHistory` that
 * silently fell back to `targets × constant` (45min/session for
 * running, 55min/session for cycling) when real volume data was
 * missing from the profile. That silent inference fed ACWR load
 * math; if the heuristic was too high, ramp-up got suppressed
 * (overtraining concern); too low, ramp-up became too aggressive.
 * Operators had no way to tell which users were on real data vs
 * heuristic.
 *
 * Slice 3.M splits the ternaries into pure exported functions
 * returning a three-branch discriminated union — `profile_data`
 * (real volume from the user's profile), `inferred_from_targets`
 * (silent fallback fired), or `no_volume` (neither real data nor
 * a non-zero weekly target).
 */
describe('resolveRunningWeeklyMinutesWithSource (slice 3.M)', () => {
  // MARK: - profile_data path

  it('returns profile_data when run_profile.weekly_mileage_km is a positive number', () => {
    // 50km × (360s/km / 60) = 50 × 6 = 300min. Above the 60min floor.
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: 50 },
      4,  // target ignored when profile data is present
      360,  // pace s/km
    );
    expect(r).toEqual({
      value: 300,
      source: 'profile_data',
      rawInputField: 'run_profile.weekly_mileage_km',
      rawInputValue: 50,
    });
  });

  it('clamps profile_data result to a 60-minute floor', () => {
    // Tiny mileage: 5km × (300s/km / 60) = 5 × 5 = 25min.
    // Floor kicks in → 60min.
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: 5 },
      4,
      300,
    );
    expect(r.source).toBe('profile_data');
    if (r.source !== 'profile_data') return;
    expect(r.value).toBe(60);
    expect(r.rawInputValue).toBe(5);
  });

  it('uses pace to convert mileage to minutes (faster pace = fewer minutes)', () => {
    // 30km at 240s/km (4:00 min/km — fast) = 30 × 4 = 120min.
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: 30 },
      4,
      240,
    );
    expect(r.value).toBe(120);
  });

  it('accepts mileage as a numeric string', () => {
    // numericOrUndefined coerces strings — so "40" → 40.
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: '40' },
      4,
      360,
    );
    expect(r.source).toBe('profile_data');
    if (r.source !== 'profile_data') return;
    expect(r.rawInputValue).toBe(40);
    expect(r.value).toBe(240);
  });

  // MARK: - inferred_from_targets path (the slice 3.M fix)

  it('falls back to inferred_from_targets when weekly_mileage_km is absent', () => {
    const r = resolveRunningWeeklyMinutesWithSource(
      { other_field: 'x' },
      4,
      360,
    );
    expect(r).toEqual({
      value: 180,  // 4 × 45
      source: 'inferred_from_targets',
      weeklyTarget: 4,
      minutesPerSession: 45,
    });
  });

  it('falls back to inferred_from_targets when weekly_mileage_km is null', () => {
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: null },
      6,
      360,
    );
    expect(r).toMatchObject({
      value: 270,  // 6 × 45
      source: 'inferred_from_targets',
      weeklyTarget: 6,
    });
  });

  it('falls back to inferred_from_targets when weekly_mileage_km is zero', () => {
    // numericOrUndefined returns undefined for 0 (must be > 0),
    // so this triggers the inference path.
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: 0 },
      3,
      360,
    );
    expect(r).toMatchObject({
      value: 135,  // 3 × 45
      source: 'inferred_from_targets',
    });
  });

  it('falls back to inferred_from_targets when runProfile is null', () => {
    const r = resolveRunningWeeklyMinutesWithSource(null, 5, 360);
    expect(r).toMatchObject({
      value: 225,  // 5 × 45
      source: 'inferred_from_targets',
    });
  });

  it('falls back to inferred_from_targets when weekly_mileage_km is a non-numeric string', () => {
    const r = resolveRunningWeeklyMinutesWithSource(
      { weekly_mileage_km: 'forty' },
      4,
      360,
    );
    expect(r.source).toBe('inferred_from_targets');
  });

  // MARK: - no_volume path

  it('returns no_volume when both real data is missing AND target is 0', () => {
    const r = resolveRunningWeeklyMinutesWithSource(null, 0, 360);
    expect(r).toEqual({ value: undefined, source: 'no_volume' });
  });

  it('returns no_volume when target is negative (defensive)', () => {
    const r = resolveRunningWeeklyMinutesWithSource(null, -1, 360);
    expect(r).toEqual({ value: undefined, source: 'no_volume' });
  });
});

describe('resolveCyclingWeeklyMinutesWithSource (slice 3.M)', () => {
  // MARK: - profile_data path

  it('returns profile_data when run_profile.weekly_hours is "10+"', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: '10+' }, 3);
    expect(r).toEqual({
      value: 660,  // weeklyHoursToMinutes('10+')
      source: 'profile_data',
      rawInputField: 'run_profile.weekly_hours',
      rawInputValue: 660,
    });
  });

  it('returns profile_data for "6-10" bucket', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: '6-10 hours' }, 3);
    expect(r).toMatchObject({ value: 480, source: 'profile_data' });
  });

  it('returns profile_data for "3-6" bucket', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: '3-6' }, 3);
    expect(r).toMatchObject({ value: 270, source: 'profile_data' });
  });

  it('returns profile_data for "< 3" bucket', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: '< 3' }, 3);
    expect(r).toMatchObject({ value: 120, source: 'profile_data' });
  });

  // MARK: - inferred_from_targets path (the slice 3.M fix)

  it('falls back to inferred_from_targets when weekly_hours is absent', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ other: 'x' }, 3);
    expect(r).toEqual({
      value: 165,  // 3 × 55
      source: 'inferred_from_targets',
      weeklyTarget: 3,
      minutesPerSession: 55,
    });
  });

  it('falls back to inferred_from_targets when weekly_hours is an unrecognized string', () => {
    // weeklyHoursToMinutes only matches "10+" / "6-10" / "3-6" /
    // "< 3". Anything else returns undefined → inference fires.
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: 'a few hours' }, 4);
    expect(r).toMatchObject({
      value: 220,  // 4 × 55
      source: 'inferred_from_targets',
    });
  });

  it('falls back to inferred_from_targets when runProfile is null', () => {
    const r = resolveCyclingWeeklyMinutesWithSource(null, 2);
    expect(r).toMatchObject({
      value: 110,  // 2 × 55
      source: 'inferred_from_targets',
    });
  });

  // MARK: - no_volume path

  it('returns no_volume when both real data is missing AND target is 0', () => {
    const r = resolveCyclingWeeklyMinutesWithSource(null, 0);
    expect(r).toEqual({ value: undefined, source: 'no_volume' });
  });

  it('returns no_volume when weekly_hours is unrecognized AND target is 0', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: 'maybe?' }, 0);
    expect(r).toEqual({ value: undefined, source: 'no_volume' });
  });

  // MARK: - case insensitivity

  it('handles mixed-case weekly_hours', () => {
    const r = resolveCyclingWeeklyMinutesWithSource({ weekly_hours: '6-10 HOURS' }, 3);
    expect(r.source).toBe('profile_data');
  });
});
