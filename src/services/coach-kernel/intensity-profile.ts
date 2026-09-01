// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Intensity profile builder — slice A2b of the Week-Level
 * Adaptability + Periodization plan (v2.1).
 *
 * Produces `SessionIntensityProfile` and `IntensitySummary` from a
 * WorkoutTemplate + duration + AthleteProfile triple. The profile is
 * the substrate that B1 (TSS via IF), B4 (segment-time-in-zone
 * distribution), and B6 (intensity-aware progression) all read.
 *
 * Design contracts:
 *
 *   - Pure. No DB reads, no module state. Engines call this once per
 *     session candidate and attach the result to `Session`.
 *
 *   - Defensive. When athlete anchors are missing, the function
 *     still returns a profile — segments + distribution work from
 *     `targetZone` alone; `estimatedLoad` is undefined and B1 will
 *     fill it with the sRPE × duration fallback when completion
 *     data arrives.
 *
 *   - Heuristic segment generation. For steady aerobic sessions
 *     (recovery_run, easy_run, endurance_ride, etc.) we emit a
 *     single 'steady' segment matching the session's primaryZone.
 *     For interval-style sessions (threshold_run, vo2_ride,
 *     interval_run) we emit warmup + N×(interval + recovery) +
 *     cooldown with conventional time-shares. Engine slices can
 *     override by passing pre-computed segments to
 *     `buildIntensityProfileFromSegments`.
 *
 *   - Math conventions:
 *       - intensityDistribution values sum to 1.0 (proportions).
 *       - estimatedLoad uses Coggan's TSS = duration_hours × IF² × 100
 *         summed over segments, with each segment's IF computed via
 *         `computeIntensityFactorForZone` from slice A2.
 */

import type {
  AthleteProfile,
  IntensitySegment,
  IntensitySegmentRole,
  IntensitySummary,
  IntensityZone,
  SessionIntensityProfile,
  Sport,
  WorkoutTemplate,
} from './types';
import { computeIntensityFactorForZone } from './zone-calculator';

// ---------- Segment-template heuristics ----------

/**
 * Conventional time-shares for steady-vs-interval workouts. Values
 * are proportions of the total session duration assigned to warmup,
 * main work, and cooldown.
 */
const TIME_SHARES = {
  steadyWarmup: 0.1,
  steadyCooldown: 0.1,
  intervalWarmup: 0.2,
  intervalCooldown: 0.15,
} as const;

/** Default work:rest ratios for interval-style sessions per primary zone. */
const INTERVAL_DEFAULTS: Partial<Record<IntensityZone, {
  reps: number;
  workSec: number;
  recoverySec: number;
  recoveryZone: IntensityZone;
}>> = {
  vo2: { reps: 5, workSec: 240, recoverySec: 90, recoveryZone: 'recovery' },
  threshold: { reps: 4, workSec: 480, recoverySec: 180, recoveryZone: 'recovery' },
  tempo: { reps: 2, workSec: 900, recoverySec: 300, recoveryZone: 'aerobic' },
  neuromuscular: { reps: 8, workSec: 30, recoverySec: 120, recoveryZone: 'recovery' },
};

const STEADY_SESSION_TYPES = new Set<string>([
  'easy_run',
  'long_run',
  'recovery_run',
  'endurance_ride',
  'aerobic_swim',
  'technique_swim',
  'recovery_swim',
]);

function isSteadyTemplate(template: WorkoutTemplate): boolean {
  return STEADY_SESSION_TYPES.has(template.sessionType);
}

function sportOf(template: WorkoutTemplate): Sport {
  return template.sport;
}

/**
 * Build segments for a steady aerobic session — one segment matching
 * the template's primaryZone for the entire duration. We don't bother
 * splitting warmup/cooldown for steady sessions since the whole
 * session sits in one zone; the IF/load math comes out the same.
 */
function buildSteadySegments(
  template: WorkoutTemplate,
  durationMinutes: number,
): IntensitySegment[] {
  return [
    {
      role: 'steady',
      modality: sportOf(template),
      durationSec: Math.round(durationMinutes * 60),
      targetZone: template.primaryZone,
    },
  ];
}

/**
 * Build segments for an interval-style session. Layout:
 *   - warmup (20% of duration, aerobic zone)
 *   - N × (work segment in primaryZone + recovery segment in recovery zone)
 *   - cooldown (15% of duration, recovery zone)
 *
 * The number of reps and work/recovery duration come from
 * INTERVAL_DEFAULTS keyed by the template's primaryZone. Canonical pairs
 * are kept whole whenever at least one pair fits. Any positive time left
 * after those pairs becomes aerobic steady work so the profile always
 * closes to the requested duration. When even one pair cannot fit, one
 * pair is proportionally shortened while preserving its work:recovery
 * ratio.
 */
function buildIntervalSegments(
  template: WorkoutTemplate,
  durationMinutes: number,
): IntensitySegment[] {
  const totalSec = Math.round(durationMinutes * 60);
  const warmupSec = Math.round(totalSec * TIME_SHARES.intervalWarmup);
  const cooldownSec = Math.round(totalSec * TIME_SHARES.intervalCooldown);
  const intervalBudgetSec = Math.max(0, totalSec - warmupSec - cooldownSec);

  const defaults = INTERVAL_DEFAULTS[template.primaryZone] ?? INTERVAL_DEFAULTS.threshold!;
  const pairSec = defaults.workSec + defaults.recoverySec;
  const reps = Math.min(defaults.reps, Math.floor(intervalBudgetSec / pairSec));
  const fittedPair = reps === 0 && intervalBudgetSec > 0
    ? {
        workSec: Math.round(intervalBudgetSec * (defaults.workSec / pairSec)),
        recoverySec: 0,
      }
    : null;
  if (fittedPair) {
    // Assign rounding drift to recovery so the fitted pair is byte-for-byte
    // duration-closed without changing the canonical work:recovery ratio by
    // more than one second.
    fittedPair.recoverySec = intervalBudgetSec - fittedPair.workSec;
  }

  const segments: IntensitySegment[] = [];
  segments.push({
    role: 'warmup',
    modality: sportOf(template),
    durationSec: warmupSec,
    targetZone: 'aerobic',
  });
  for (let i = 0; i < reps; i++) {
    segments.push({
      role: 'interval',
      modality: sportOf(template),
      durationSec: defaults.workSec,
      reps: 1,
      targetZone: template.primaryZone,
    });
    segments.push({
      role: 'recovery',
      modality: sportOf(template),
      durationSec: defaults.recoverySec,
      targetZone: defaults.recoveryZone,
    });
  }
  if (fittedPair) {
    if (fittedPair.workSec > 0) {
      segments.push({
        role: 'interval',
        modality: sportOf(template),
        durationSec: fittedPair.workSec,
        reps: 1,
        targetZone: template.primaryZone,
      });
    }
    if (fittedPair.recoverySec > 0) {
      segments.push({
        role: 'recovery',
        modality: sportOf(template),
        durationSec: fittedPair.recoverySec,
        targetZone: defaults.recoveryZone,
      });
    }
  }
  const residualSec = intervalBudgetSec - (reps * pairSec) - (fittedPair ? intervalBudgetSec : 0);
  if (residualSec > 0) {
    segments.push({
      role: 'steady',
      modality: sportOf(template),
      durationSec: residualSec,
      targetZone: 'aerobic',
    });
  }
  segments.push({
    role: 'cooldown',
    modality: sportOf(template),
    durationSec: cooldownSec,
    targetZone: 'recovery',
  });

  return segments;
}

/**
 * Default segment builder: dispatches on sessionType to either steady
 * or interval layout. Engines can call this directly or override by
 * computing their own segments and passing them to
 * `buildIntensityProfileFromSegments`.
 */
export function buildDefaultSegments(
  template: WorkoutTemplate,
  durationMinutes: number,
): IntensitySegment[] {
  if (isSteadyTemplate(template)) {
    return buildSteadySegments(template, durationMinutes);
  }
  return buildIntervalSegments(template, durationMinutes);
}

// ---------- Distribution + load math ----------

/**
 * Time-weighted intensity distribution. For each zone, returns the
 * proportion of total session duration spent in that zone. Values
 * sum to 1.0 (within rounding error); missing zones are absent
 * from the returned record.
 *
 * Distance-based segments are converted to duration using the
 * segment's target zone midpoint pace (when athlete anchors allow)
 * or skipped from the distribution otherwise.
 */
export function computeIntensityDistribution(
  segments: readonly IntensitySegment[],
): Partial<Record<IntensityZone, number>> {
  const zoneSec: Record<string, number> = {};
  let totalSec = 0;
  for (const seg of segments) {
    if (!seg.targetZone) continue;
    const dur = seg.durationSec ?? 0;
    if (dur <= 0) continue;
    const reps = seg.reps ?? 1;
    const segTotal = dur * reps;
    zoneSec[seg.targetZone] = (zoneSec[seg.targetZone] ?? 0) + segTotal;
    totalSec += segTotal;
  }
  if (totalSec === 0) return {};
  const out: Partial<Record<IntensityZone, number>> = {};
  for (const [zone, sec] of Object.entries(zoneSec)) {
    out[zone as IntensityZone] = sec / totalSec;
  }
  return out;
}

/**
 * Estimated load (TSS-equivalent) for a session, computed by
 * Coggan's formula `TSS = duration_hours × IF² × 100` summed over
 * each segment. Returns undefined when the relevant sport anchor is
 * missing — B1 will fill in via sRPE × duration when completion
 * data arrives.
 */
export function computeEstimatedLoad(
  segments: readonly IntensitySegment[],
  sport: Sport,
  profile: Pick<
    AthleteProfile,
    'thresholdPaceSecondsPerKm' | 'cyclingFtpWatts' | 'swimCssSecondsPer100m'
  >,
): number | undefined {
  if (sport !== 'running' && sport !== 'cycling' && sport !== 'swimming') return undefined;
  let total = 0;
  let anyComputed = false;
  for (const seg of segments) {
    if (!seg.targetZone) continue;
    const dur = seg.durationSec ?? 0;
    if (dur <= 0) continue;
    const reps = seg.reps ?? 1;
    const ifVal = computeIntensityFactorForZone(seg.targetZone, sport, profile);
    if (ifVal === undefined) continue;
    const segDurationHours = (dur * reps) / 3600;
    total += segDurationHours * ifVal * ifVal * 100;
    anyComputed = true;
  }
  return anyComputed ? Math.round(total) : undefined;
}

// ---------- Summary view ----------

const LOW_ZONES: ReadonlySet<IntensityZone> = new Set(['recovery', 'aerobic']);
const MODERATE_ZONES: ReadonlySet<IntensityZone> = new Set(['tempo']);
const HIGH_ZONES: ReadonlySet<IntensityZone> = new Set(['threshold', 'vo2', 'neuromuscular']);

/**
 * Roll a full distribution into the 3-bucket low/moderate/high view
 * for the iOS-facing IntensitySummary. The buckets match the
 * intensity-distribution-model literature (polarized = 80/0/20,
 * pyramidal = 75/20/5, threshold-focused = 65/25/10).
 */
export function rollDistributionToBuckets(
  distribution: Partial<Record<IntensityZone, number>>,
): { lowPct: number; moderatePct: number; highPct: number } {
  let low = 0;
  let mod = 0;
  let high = 0;
  for (const [zone, pct] of Object.entries(distribution)) {
    if (LOW_ZONES.has(zone as IntensityZone)) low += pct;
    else if (MODERATE_ZONES.has(zone as IntensityZone)) mod += pct;
    else if (HIGH_ZONES.has(zone as IntensityZone)) high += pct;
  }
  return { lowPct: low, moderatePct: mod, highPct: high };
}

/**
 * Build the compact `IntensitySummary` from a full profile. iOS
 * adopts this immediately; full segment rendering can land in a
 * later schemaVersion.
 */
export function buildIntensitySummary(
  profile: SessionIntensityProfile,
  targetSummaryText?: string,
): IntensitySummary {
  const buckets = rollDistributionToBuckets(profile.intensityDistribution);
  return {
    primaryZone: profile.primaryZone,
    lowPct: buckets.lowPct,
    moderatePct: buckets.moderatePct,
    highPct: buckets.highPct,
    estimatedLoad: profile.estimatedLoad,
    targetSummaryText,
  };
}

// ---------- Top-level helpers ----------

/**
 * Build a SessionIntensityProfile from pre-computed segments.
 * Engines that want to override the default segment layout (custom
 * interval patterns, brick sessions, over-unders) call this directly.
 */
export function buildIntensityProfileFromSegments(
  primaryZone: IntensityZone,
  segments: IntensitySegment[],
  sport: Sport,
  profile: Pick<
    AthleteProfile,
    'thresholdPaceSecondsPerKm' | 'cyclingFtpWatts' | 'swimCssSecondsPer100m'
  >,
): SessionIntensityProfile {
  const distribution = computeIntensityDistribution(segments);
  const estimatedLoad = computeEstimatedLoad(segments, sport, profile);
  return {
    primaryZone,
    segments,
    intensityDistribution: distribution,
    estimatedLoad,
  };
}

/**
 * Build a full SessionIntensityProfile from a WorkoutTemplate +
 * duration + athlete anchors. The default segment heuristics produce
 * a sensible profile for most workouts; engines override only when
 * they have richer information.
 */
export function buildSessionIntensityProfile(
  template: WorkoutTemplate,
  durationMinutes: number,
  profile: Pick<
    AthleteProfile,
    'thresholdPaceSecondsPerKm' | 'cyclingFtpWatts' | 'swimCssSecondsPer100m'
  >,
): SessionIntensityProfile {
  const segments = buildDefaultSegments(template, durationMinutes);
  return buildIntensityProfileFromSegments(
    template.primaryZone,
    segments,
    template.sport,
    profile,
  );
}

// Re-export segment role for downstream code that wants to construct
// segments without importing from types directly.
export type { IntensitySegmentRole };
