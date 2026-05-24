/**
 * Slice A2b — intensity profile builder tests.
 *
 * Pins:
 *   - Steady sessions emit a single 'steady' segment in primaryZone
 *   - Interval sessions emit warmup + N×(work+recovery) + cooldown
 *   - Number of intervals scales with duration (60-min vs 30-min)
 *   - Intensity distribution sums to ~1.0 (within rounding)
 *   - Distribution respects time-in-zone weighting (not session-goal)
 *   - Estimated load uses A2's IF math
 *   - Estimated load is undefined when sport anchor missing
 *   - Summary buckets roll the 6-zone distribution into low/mod/high
 *   - buildSessionIntensityProfile top-level helper composes correctly
 */

import { describe, expect, it } from 'vitest';
import type { IntensitySegment, WorkoutTemplate } from '../../src/services/coach-kernel/types';
import {
  buildDefaultSegments,
  buildIntensityProfileFromSegments,
  buildIntensitySummary,
  buildSessionIntensityProfile,
  computeEstimatedLoad,
  computeIntensityDistribution,
  rollDistributionToBuckets,
} from '../../src/services/coach-kernel/intensity-profile';

function tmpl(overrides: Partial<WorkoutTemplate> = {}): WorkoutTemplate {
  return {
    id: 'test_template',
    sport: 'running',
    sessionType: 'easy_run',
    title: 'Test',
    phaseTags: ['base'],
    goalTags: [],
    durationOptionsMinutes: [45, 60],
    primaryZone: 'aerobic',
    fatigueCost: 'low',
    keySession: false,
    instructions: [],
    constraints: [],
    ...overrides,
  };
}

describe('buildDefaultSegments — steady sessions', () => {
  it('easy_run emits a single steady segment in primaryZone', () => {
    const segs = buildDefaultSegments(tmpl({ sessionType: 'easy_run', primaryZone: 'aerobic' }), 60);
    expect(segs.length).toBe(1);
    expect(segs[0].role).toBe('steady');
    expect(segs[0].targetZone).toBe('aerobic');
    expect(segs[0].durationSec).toBe(3600);
  });

  it('long_run emits one steady segment for entire duration', () => {
    const segs = buildDefaultSegments(tmpl({ sessionType: 'long_run', primaryZone: 'aerobic' }), 120);
    expect(segs.length).toBe(1);
    expect(segs[0].durationSec).toBe(7200);
  });

  it('endurance_ride emits one steady segment', () => {
    const segs = buildDefaultSegments(
      tmpl({ sport: 'cycling', sessionType: 'endurance_ride', primaryZone: 'aerobic' }),
      90,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].role).toBe('steady');
  });
});

describe('buildDefaultSegments — interval sessions', () => {
  it('threshold_run emits warmup + intervals + cooldown', () => {
    const segs = buildDefaultSegments(
      tmpl({ sessionType: 'threshold_run', primaryZone: 'threshold' }),
      60,
    );
    // 60min = 3600s; warmup 20% = 720s; cooldown 15% = 540s; budget 2340s.
    // Threshold default: 4 reps × (480 work + 180 recovery) = 4 × 660 = 2640s
    // Fits 2340 / 660 = 3 reps. So 1 warmup + 6 (3 pairs) + 1 cooldown = 8 segments.
    expect(segs[0].role).toBe('warmup');
    expect(segs[segs.length - 1].role).toBe('cooldown');
    const intervals = segs.filter((s) => s.role === 'interval');
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    intervals.forEach((s) => expect(s.targetZone).toBe('threshold'));
  });

  it('vo2_ride emits more reps than threshold (shorter work intervals)', () => {
    const threshold = buildDefaultSegments(
      tmpl({ sport: 'cycling', sessionType: 'threshold_ride', primaryZone: 'threshold' }),
      60,
    );
    const vo2 = buildDefaultSegments(
      tmpl({ sport: 'cycling', sessionType: 'vo2_ride', primaryZone: 'vo2' }),
      60,
    );
    const thresholdReps = threshold.filter((s) => s.role === 'interval').length;
    const vo2Reps = vo2.filter((s) => s.role === 'interval').length;
    expect(vo2Reps).toBeGreaterThanOrEqual(thresholdReps);
  });

  it('shorter session = fewer reps', () => {
    const short = buildDefaultSegments(
      tmpl({ sessionType: 'threshold_run', primaryZone: 'threshold' }),
      30,
    );
    const long = buildDefaultSegments(
      tmpl({ sessionType: 'threshold_run', primaryZone: 'threshold' }),
      90,
    );
    const shortReps = short.filter((s) => s.role === 'interval').length;
    const longReps = long.filter((s) => s.role === 'interval').length;
    expect(longReps).toBeGreaterThanOrEqual(shortReps);
  });
});

describe('computeIntensityDistribution', () => {
  it('single steady segment yields 100% in that zone', () => {
    const segs: IntensitySegment[] = [
      { role: 'steady', modality: 'running', durationSec: 3600, targetZone: 'aerobic' },
    ];
    const dist = computeIntensityDistribution(segs);
    expect(dist.aerobic).toBe(1);
  });

  it('warmup+intervals+cooldown distributes across zones', () => {
    const segs: IntensitySegment[] = [
      { role: 'warmup', modality: 'running', durationSec: 600, targetZone: 'aerobic' },
      { role: 'interval', modality: 'running', durationSec: 240, targetZone: 'vo2' },
      { role: 'recovery', modality: 'running', durationSec: 60, targetZone: 'recovery' },
      { role: 'interval', modality: 'running', durationSec: 240, targetZone: 'vo2' },
      { role: 'recovery', modality: 'running', durationSec: 60, targetZone: 'recovery' },
      { role: 'cooldown', modality: 'running', durationSec: 300, targetZone: 'recovery' },
    ];
    // Total: 600+240+60+240+60+300 = 1500s
    // aerobic: 600/1500 = 0.4
    // vo2: 480/1500 = 0.32
    // recovery: 420/1500 = 0.28
    const dist = computeIntensityDistribution(segs);
    expect(dist.aerobic).toBeCloseTo(0.4, 3);
    expect(dist.vo2).toBeCloseTo(0.32, 3);
    expect(dist.recovery).toBeCloseTo(0.28, 3);
    const sum = (dist.aerobic ?? 0) + (dist.vo2 ?? 0) + (dist.recovery ?? 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('handles reps multiplier', () => {
    const segs: IntensitySegment[] = [
      { role: 'interval', modality: 'cycling', durationSec: 60, reps: 5, targetZone: 'vo2' },
      { role: 'recovery', modality: 'cycling', durationSec: 120, reps: 5, targetZone: 'recovery' },
    ];
    // 5x60 = 300s vo2; 5x120 = 600s recovery; total 900s
    const dist = computeIntensityDistribution(segs);
    expect(dist.vo2).toBeCloseTo(300 / 900, 3);
    expect(dist.recovery).toBeCloseTo(600 / 900, 3);
  });

  it('returns empty object when no valid segments', () => {
    expect(computeIntensityDistribution([])).toEqual({});
    expect(computeIntensityDistribution([
      { role: 'warmup', modality: 'running' }, // no duration, no zone
    ])).toEqual({});
  });
});

describe('computeEstimatedLoad — Coggan TSS via IF', () => {
  it('1-hour threshold run produces TSS ≈ 100', () => {
    const segs: IntensitySegment[] = [
      { role: 'steady', modality: 'running', durationSec: 3600, targetZone: 'threshold' },
    ];
    const load = computeEstimatedLoad(segs, 'running', { thresholdPaceSecondsPerKm: 240 });
    // Threshold IF ≈ 1.0; 1h × 1² × 100 = 100.
    expect(load).toBeCloseTo(100, 0);
  });

  it('1-hour aerobic run produces lower TSS', () => {
    const segs: IntensitySegment[] = [
      { role: 'steady', modality: 'running', durationSec: 3600, targetZone: 'aerobic' },
    ];
    const load = computeEstimatedLoad(segs, 'running', { thresholdPaceSecondsPerKm: 240 });
    // Aerobic IF ≈ 0.82; 1h × 0.82² × 100 ≈ 67.
    expect(load).toBeGreaterThan(50);
    expect(load).toBeLessThan(80);
  });

  it('1-hour vo2 ride produces higher TSS than threshold', () => {
    const segs: IntensitySegment[] = [
      { role: 'steady', modality: 'cycling', durationSec: 3600, targetZone: 'vo2' },
    ];
    const load = computeEstimatedLoad(segs, 'cycling', { cyclingFtpWatts: 250 });
    // VO2 IF ≈ 1.125; 1h × 1.125² × 100 ≈ 126.5.
    expect(load).toBeGreaterThan(100);
  });

  it('returns undefined when sport anchor missing', () => {
    const segs: IntensitySegment[] = [
      { role: 'steady', modality: 'running', durationSec: 3600, targetZone: 'threshold' },
    ];
    expect(computeEstimatedLoad(segs, 'running', {})).toBeUndefined();
  });

  it('sums load across mixed-zone segments', () => {
    const segs: IntensitySegment[] = [
      { role: 'warmup', modality: 'cycling', durationSec: 600, targetZone: 'aerobic' },
      { role: 'interval', modality: 'cycling', durationSec: 240, reps: 5, targetZone: 'vo2' },
      { role: 'recovery', modality: 'cycling', durationSec: 60, reps: 5, targetZone: 'recovery' },
      { role: 'cooldown', modality: 'cycling', durationSec: 300, targetZone: 'aerobic' },
    ];
    const load = computeEstimatedLoad(segs, 'cycling', { cyclingFtpWatts: 250 });
    expect(load).toBeGreaterThan(50);
    expect(load).toBeLessThan(150);
  });
});

describe('rollDistributionToBuckets', () => {
  it('aerobic + recovery → low bucket', () => {
    const buckets = rollDistributionToBuckets({ aerobic: 0.6, recovery: 0.2, tempo: 0.2 });
    expect(buckets.lowPct).toBeCloseTo(0.8, 3);
    expect(buckets.moderatePct).toBeCloseTo(0.2, 3);
    expect(buckets.highPct).toBe(0);
  });

  it('threshold + vo2 + neuromuscular → high bucket', () => {
    const buckets = rollDistributionToBuckets({
      aerobic: 0.5,
      threshold: 0.2,
      vo2: 0.2,
      neuromuscular: 0.1,
    });
    expect(buckets.lowPct).toBeCloseTo(0.5, 3);
    expect(buckets.highPct).toBeCloseTo(0.5, 3);
  });

  it('polarized 80/20 split (slice B4 model)', () => {
    const buckets = rollDistributionToBuckets({ aerobic: 0.8, vo2: 0.15, threshold: 0.05 });
    expect(buckets.lowPct).toBeCloseTo(0.8, 3);
    expect(buckets.highPct).toBeCloseTo(0.2, 3);
    expect(buckets.moderatePct).toBe(0);
  });
});

describe('buildSessionIntensityProfile — top-level composition', () => {
  it('produces a complete profile from template + duration + anchors', () => {
    const profile = buildSessionIntensityProfile(
      tmpl({ sessionType: 'threshold_run', primaryZone: 'threshold' }),
      60,
      { thresholdPaceSecondsPerKm: 240 },
    );
    expect(profile.primaryZone).toBe('threshold');
    expect(profile.segments.length).toBeGreaterThan(1);
    const dist = profile.intensityDistribution;
    const sum = Object.values(dist).reduce<number>((acc, n) => acc + (n ?? 0), 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(profile.estimatedLoad).toBeGreaterThan(0);
  });

  it('estimatedLoad undefined when anchors missing', () => {
    const profile = buildSessionIntensityProfile(
      tmpl({ sessionType: 'threshold_run', primaryZone: 'threshold' }),
      60,
      {},
    );
    expect(profile.estimatedLoad).toBeUndefined();
  });
});

describe('buildIntensitySummary — iOS read-model', () => {
  it('rolls distribution to low/moderate/high + carries estimatedLoad', () => {
    const profile = buildIntensityProfileFromSegments(
      'aerobic',
      [{ role: 'steady', modality: 'running', durationSec: 3600, targetZone: 'aerobic' }],
      'running',
      { thresholdPaceSecondsPerKm: 240 },
    );
    const summary = buildIntensitySummary(profile, 'Easy 1-hour aerobic run');
    expect(summary.primaryZone).toBe('aerobic');
    expect(summary.lowPct).toBe(1);
    expect(summary.highPct).toBe(0);
    expect(summary.estimatedLoad).toBeDefined();
    expect(summary.targetSummaryText).toBe('Easy 1-hour aerobic run');
  });
});
