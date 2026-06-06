/**
 * Slice B4 — intensity distribution selection + measurement.
 *
 * Pins:
 *   - pickIntensityDistribution honors policy preference
 *   - race week overrides to polarized 95/0/5
 *   - deload week overrides to polarized 90/10/0
 *   - post-race week → all aerobic
 *   - measureWeeklyDistribution uses segment_time_in_zone (default)
 *   - session_goal accounting collapses to count-based bucketing
 *   - assessDistributionDelta emits warnings beyond tolerance
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import type { Session, WeekIntent } from '../../src/services/coach-kernel/types';
import {
  assessDistributionDelta,
  measureWeeklyDistribution,
  pickIntensityDistribution,
} from '../../src/services/coach-kernel/intensity-distribution';
import { intentFromKind } from '../../src/services/coach-kernel/week-intent';

const knowledge = loadCoachKnowledge();
const principles = knowledge.principles;

function makeWeekIntent(kind: WeekIntent['kind']): WeekIntent {
  return intentFromKind(kind, principles);
}

describe('pickIntensityDistribution', () => {
  it('race week → polarized 95/0/5 (dress rehearsal only)', () => {
    const result = pickIntensityDistribution({
      sport: 'running',
      level: 'intermediate',
      weekIntent: makeWeekIntent('race'),
      principles,
    });
    expect(result.target.low).toBeCloseTo(0.95, 2);
    expect(result.target.high).toBeCloseTo(0.05, 2);
  });

  it('deload week → 90/10/0', () => {
    const result = pickIntensityDistribution({
      sport: 'running',
      level: 'intermediate',
      weekIntent: makeWeekIntent('deload'),
      principles,
    });
    expect(result.target.low).toBeCloseTo(0.9, 2);
    expect(result.target.high).toBe(0);
  });

  it('post_race_recovery → all aerobic (1.0/0/0)', () => {
    const result = pickIntensityDistribution({
      sport: 'running',
      level: 'intermediate',
      weekIntent: makeWeekIntent('post_race_recovery'),
      principles,
    });
    expect(result.target.low).toBe(1.0);
    expect(result.target.high).toBe(0);
  });

  it('CoachPlanPolicy preference wins over defaults', () => {
    const result = pickIntensityDistribution({
      sport: 'running',
      level: 'intermediate',
      weekIntent: makeWeekIntent('accumulation'),
      policy: {
        intensityDistributionPreference: 'thresholdFocused',
        progressionAggressiveness: 'standard',
        deloadStrategy: 'hybrid',
        missedSessionPolicy: 'drop_low_priority',
        taperStrategy: 'auto',
        schemaVersion: 1,
      },
      principles,
    });
    expect(result.model).toBe('thresholdFocused');
    expect(result.rationale).toContain('User-selected');
  });

  it('falls back to sport+level default when policy is auto', () => {
    const result = pickIntensityDistribution({
      sport: 'running',
      level: 'intermediate',
      weekIntent: makeWeekIntent('accumulation'),
      policy: {
        intensityDistributionPreference: 'auto',
        progressionAggressiveness: 'standard',
        deloadStrategy: 'hybrid',
        missedSessionPolicy: 'drop_low_priority',
        taperStrategy: 'auto',
        schemaVersion: 1,
      },
      principles,
    });
    expect(result.model).toBe('polarized'); // default for running
  });
});

describe('measureWeeklyDistribution', () => {
  function makeSession(zone: Session['intensityZone'], durationMinutes: number): Session {
    return {
      id: `s-${Math.random()}`,
      sport: 'running',
      sessionType: 'easy_run',
      title: 'test',
      description: '',
      dayOfWeek: 'monday',
      durationMinutes,
      intensityZone: zone,
      fatigueCost: 'low',
      keySession: false,
      plannedLoad: 0,
      tags: [],
    };
  }

  it('session_goal accounting: counts sessions per bucket', () => {
    const sessions = [
      makeSession('aerobic', 60),
      makeSession('aerobic', 90),
      makeSession('tempo', 60),
      makeSession('threshold', 45),
      makeSession('vo2', 45),
    ];
    const result = measureWeeklyDistribution(sessions, 'session_goal');
    // 2 low + 1 mod + 2 high = 5 sessions. low=2/5=0.4, mod=1/5=0.2, high=2/5=0.4
    expect(result.low).toBeCloseTo(0.4, 2);
    expect(result.moderate).toBeCloseTo(0.2, 2);
    expect(result.high).toBeCloseTo(0.4, 2);
  });

  it('segment_time_in_zone (default): time-weighted distribution', () => {
    // 5 sessions, each 60 minutes:
    // 3 aerobic (180 min low) + 1 tempo (60 min mod) + 1 threshold (60 min high)
    const sessions = [
      makeSession('aerobic', 60),
      makeSession('aerobic', 60),
      makeSession('aerobic', 60),
      makeSession('tempo', 60),
      makeSession('threshold', 60),
    ];
    const result = measureWeeklyDistribution(sessions, 'segment_time_in_zone');
    // total = 300 min. low=180/300=0.6, mod=60/300=0.2, high=60/300=0.2
    expect(result.low).toBeCloseTo(0.6, 2);
    expect(result.moderate).toBeCloseTo(0.2, 2);
    expect(result.high).toBeCloseTo(0.2, 2);
  });

  it('empty sessions → zero distribution', () => {
    const result = measureWeeklyDistribution([]);
    expect(result.low).toBe(0);
    expect(result.high).toBe(0);
  });
});

describe('assessDistributionDelta', () => {
  it('within tolerance → no warnings', () => {
    const delta = assessDistributionDelta(
      { low: 0.78, moderate: 0.07, high: 0.15 },
      { low: 0.80, moderate: 0.05, high: 0.15 },
      0.10,
    );
    expect(delta.warnings).toHaveLength(0);
  });

  it('low-intensity over target → warning', () => {
    const delta = assessDistributionDelta(
      { low: 0.95, moderate: 0.02, high: 0.03 },
      { low: 0.80, moderate: 0.05, high: 0.15 },
      0.10,
    );
    expect(delta.warnings.some((w) => /low-intensity over/.test(w))).toBe(true);
    expect(delta.warnings.some((w) => /high-intensity under/.test(w))).toBe(true);
  });

  it('totalAbsDelta sums absolute per-bucket deltas', () => {
    const delta = assessDistributionDelta(
      { low: 0.90, moderate: 0.05, high: 0.05 },
      { low: 0.80, moderate: 0.05, high: 0.15 },
    );
    expect(delta.totalAbsDelta).toBeCloseTo(0.20, 2);
  });

  it('race/taper options tighten tolerance to 5 percentage points', () => {
    const delta = assessDistributionDelta(
      { low: 0.89, moderate: 0.03, high: 0.08 },
      { low: 0.95, moderate: 0, high: 0.05 },
      { weekIntentKind: 'race' },
    );
    expect(delta.warnings.some((w) => /low-intensity under/.test(w))).toBe(true);
  });

  it('deload/recovery options use a middle tolerance', () => {
    const delta = assessDistributionDelta(
      { low: 0.82, moderate: 0.18, high: 0 },
      { low: 0.90, moderate: 0.10, high: 0 },
      { weekIntentKind: 'deload' },
    );
    expect(delta.warnings.some((w) => /low-intensity under/.test(w))).toBe(true);
  });
});
