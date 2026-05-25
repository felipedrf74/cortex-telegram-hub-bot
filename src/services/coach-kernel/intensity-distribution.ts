// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Configurable phase-aware intensity distribution — slice B4 of the
 * Week-Level Adaptability + Periodization plan (v2.1).
 *
 * Reads A1b's `intensityDistributionModels` (polarized / pyramidal /
 * thresholdFocused) and selects the right model for a given
 * (sport, level, weekIntent, policy) tuple. Then measures actual
 * planned distribution (from A2b segment data) against the target.
 *
 * Accounting (per v2.1 critique):
 *   - 'segment_time_in_zone' (default): proportion of total session
 *     duration in each intensity bucket. Most defensible — captures
 *     warmup/cooldown contribution.
 *   - 'session_goal': proportion of session count whose primaryZone
 *     falls into each bucket. Easier to read on a weekly summary
 *     screen but loses fidelity.
 *
 * Both views are surfaced; engines pick.
 */

import type {
  CoachPlanPolicy,
  IntensitySegment,
  Session,
  WeekIntent,
} from './types';
import {
  getIntensityDistribution,
  pickDefaultIntensityDistribution,
  type IntensityDistribution,
  type IntensityDistributionModelName,
  type Principles,
} from './training-principles';
import {
  computeIntensityDistribution,
  rollDistributionToBuckets,
} from './intensity-profile';

export type IntensityAccounting = 'segment_time_in_zone' | 'session_goal';

export interface PickIntensityDistributionInput {
  sport: string;
  level: 'novice' | 'intermediate' | 'advanced';
  weekIntent: WeekIntent;
  policy?: CoachPlanPolicy;
  principles: Principles;
}

export interface PickedIntensityDistribution {
  model: IntensityDistributionModelName;
  target: IntensityDistribution;
  rationale: string;
}

/**
 * Pick the intensity distribution for a given (sport, level,
 * weekIntent, policy) tuple. The policy preference wins if set;
 * otherwise the sport/level defaults apply. Some weekIntent kinds
 * override the model (race weeks → realization-style; deload weeks
 * → polarized-low-only).
 */
export function pickIntensityDistribution(
  input: PickIntensityDistributionInput,
): PickedIntensityDistribution {
  // Race / post-race / deload weeks override the model.
  if (input.weekIntent.kind === 'race') {
    return {
      model: 'polarized',
      target: { low: 0.95, moderate: 0, high: 0.05, evidence: 'race-week-default' },
      rationale: 'Race week — dress rehearsal only, mostly aerobic; one short opener stays high.',
    };
  }
  if (input.weekIntent.kind === 'post_race_recovery') {
    return {
      model: 'polarized',
      target: { low: 1.0, moderate: 0, high: 0, evidence: 'post-race recovery' },
      rationale: 'Post-race recovery — aerobic only.',
    };
  }
  if (input.weekIntent.kind === 'deload') {
    return {
      model: 'polarized',
      target: { low: 0.9, moderate: 0.1, high: 0, evidence: 'deload week' },
      rationale: 'Deload — drop high-intensity entirely; preserve aerobic baseline.',
    };
  }
  if (input.weekIntent.kind === 'recovery') {
    return {
      model: 'polarized',
      target: { low: 1.0, moderate: 0, high: 0, evidence: 'recovery week' },
      rationale: 'Recovery week — aerobic only.',
    };
  }

  // Policy preference wins.
  let modelName: IntensityDistributionModelName;
  let rationale: string;
  if (input.policy?.intensityDistributionPreference && input.policy.intensityDistributionPreference !== 'auto') {
    modelName = input.policy.intensityDistributionPreference;
    rationale = `User-selected ${modelName} via CoachPlanPolicy.`;
  } else {
    modelName = pickDefaultIntensityDistribution(input.principles, input.sport, input.level);
    rationale = `Default ${modelName} for ${input.sport} at ${input.level} level.`;
  }
  const target = getIntensityDistribution(input.principles, modelName) ?? {
    low: 0.80, moderate: 0.05, high: 0.15,
  };
  return { model: modelName, target, rationale };
}

/**
 * Measure actual distribution from A2b segments across all sessions
 * in a week. Returns the bucket proportions in the chosen accounting
 * convention.
 */
export function measureWeeklyDistribution(
  sessions: readonly Session[],
  accounting: IntensityAccounting = 'segment_time_in_zone',
): { low: number; moderate: number; high: number } {
  if (accounting === 'session_goal') {
    if (sessions.length === 0) return { low: 0, moderate: 0, high: 0 };
    let low = 0, mod = 0, high = 0;
    for (const s of sessions) {
      const zone = s.intensityZone;
      if (zone === 'recovery' || zone === 'aerobic') low++;
      else if (zone === 'tempo') mod++;
      else high++;
    }
    const total = low + mod + high;
    // R8 P2-8 — total is unreachable as 0 today because every
    // branch above increments at least one counter (the
    // `else high++` is a catch-all). Add an explicit guard so a
    // future refactor that adds a "skip" branch can't divide by zero.
    if (total === 0) return { low: 0, moderate: 0, high: 0 };
    return { low: low / total, moderate: mod / total, high: high / total };
  }
  // segment_time_in_zone (default)
  const allSegments: IntensitySegment[] = [];
  for (const s of sessions) {
    if (s.intensityProfile?.segments) {
      allSegments.push(...s.intensityProfile.segments);
    } else {
      // Synthesize a single steady segment from session-level intensityZone.
      allSegments.push({
        role: 'steady',
        modality: s.sport,
        durationSec: s.durationMinutes * 60,
        targetZone: s.intensityZone,
      });
    }
  }
  const dist = computeIntensityDistribution(allSegments);
  const buckets = rollDistributionToBuckets(dist);
  return { low: buckets.lowPct, moderate: buckets.moderatePct, high: buckets.highPct };
}

export interface DistributionDelta {
  low: number;
  moderate: number;
  high: number;
  /** Absolute sum of deltas — proxy for "how far off the model are we?". */
  totalAbsDelta: number;
  /** Soft warnings emitted when delta exceeds tolerance. */
  warnings: string[];
}

/**
 * Compare actual weekly distribution against the target model.
 * Returns per-bucket deltas + a list of warning strings.
 *
 * Tolerance defaults to 0.10 (10 percentage points) per bucket —
 * tighter for race/taper weeks (0.05). Configurable.
 */
export function assessDistributionDelta(
  actual: { low: number; moderate: number; high: number },
  target: IntensityDistribution,
  toleranceBucket = 0.10,
): DistributionDelta {
  const lowDelta = actual.low - target.low;
  const modDelta = actual.moderate - target.moderate;
  const highDelta = actual.high - target.high;
  const totalAbs = Math.abs(lowDelta) + Math.abs(modDelta) + Math.abs(highDelta);
  const warnings: string[] = [];
  if (Math.abs(lowDelta) > toleranceBucket) {
    warnings.push(`low-intensity ${lowDelta > 0 ? 'over' : 'under'} target by ${Math.round(Math.abs(lowDelta) * 100)}%`);
  }
  if (Math.abs(modDelta) > toleranceBucket) {
    warnings.push(`moderate-intensity ${modDelta > 0 ? 'over' : 'under'} target by ${Math.round(Math.abs(modDelta) * 100)}%`);
  }
  if (Math.abs(highDelta) > toleranceBucket) {
    warnings.push(`high-intensity ${highDelta > 0 ? 'over' : 'under'} target by ${Math.round(Math.abs(highDelta) * 100)}%`);
  }
  return {
    low: lowDelta,
    moderate: modDelta,
    high: highDelta,
    totalAbsDelta: totalAbs,
    warnings,
  };
}
