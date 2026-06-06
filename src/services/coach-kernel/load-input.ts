// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Load-source normalization — slice B0 of the Week-Level Adaptability
 * + Periodization plan (v2.1).
 *
 * Multi-source, multi-dimensional load estimation. Per the v2.1
 * critique, load is NOT a single number — it is four parallel
 * dimensions that should never be collapsed early:
 *
 *   1. **External load** — what the body did mechanically: power
 *      output (cycling), pace × distance (running), strokes × pace
 *      (swim), tonnage (strength). Measurable from devices.
 *
 *   2. **Internal load** — perceived/physiological stress: sRPE ×
 *      duration (Foster 2001), TRIMP from HR (Banister 1991).
 *      Always available when the athlete logs.
 *
 *   3. **Strength load** — separate dimension because tonnage +
 *      hard-set count + RPE/RIR aren't comparable to TSS. Folding
 *      strength into a single endurance-style load misleads CTL/ATL.
 *
 *   4. **Impact / musculoskeletal load** — running, plyometrics,
 *      downhill work. Bone-stress and connective-tissue injury
 *      risk scale with impact, not cardiovascular load. Swimming
 *      has zero impact even at high internal load; running has
 *      high impact even at low intensity.
 *
 * Slice B0 returns a `SessionLoadEstimate` carrying whichever
 * dimensions are present, with a per-dimension `LoadConfidence` and
 * a `sourceQualityFlags` array surfacing what's missing. Slice B1
 * (load model) then aggregates across sessions into CTL/ATL/TSB
 * **per dimension** (so running CTL doesn't include swim load).
 *
 * Design contracts:
 *
 *   - Pure. No DB reads. Caller hydrates inputs from
 *     `training_completions` (slice A0c columns) + planned session
 *     `intensityProfile.estimatedLoad` (slice A2b).
 *
 *   - Defensive. Missing fields yield missing dimensions, not zeros.
 *     A planned session with no anchors has `plannedExternalLoad =
 *     undefined`, not 0.
 *
 *   - sRPE × duration is the universal fallback. Foster 2001 / 2017
 *     review confirms it as a low-cost, validated internal-load
 *     monitoring tool. When the athlete logs `session_rpe` (or
 *     `rpe_overall`, the existing column from migration 023) and any
 *     duration, we always emit `completedInternalLoad`.
 */

import type { AthleteProfile, Sport } from './types';

// ---------- Types ----------

export type LoadConfidence = 'high' | 'medium' | 'low';

export type LoadSource =
  | 'planned'
  | 'device_power'
  | 'device_hr'
  | 'pace'
  | 'session_rpe'
  | 'strength_tonnage'
  | 'impact_count';

export type LoadUnit =
  | 'tss'
  | 'srpe_au'
  | 'trimp_au'
  | 'tonnage_kg'
  | 'hard_set_count'
  | 'impact_au';

export interface LoadValue {
  score: number;
  unit: LoadUnit;
  source: LoadSource;
  confidence: LoadConfidence;
}

export interface SessionLoadEstimate {
  /** Forecasted external load before the session is done. */
  plannedExternalLoad?: LoadValue;
  /** External load actually achieved (device data or pace × distance). */
  completedExternalLoad?: LoadValue;
  /** Internal load from sRPE × duration or HR-derived TRIMP. */
  completedInternalLoad?: LoadValue;
  /** Strength-specific load (tonnage + hard-set count). */
  strengthLoad?: LoadValue;
  /** Musculoskeletal/impact load (running, plyometrics). */
  impactLoad?: LoadValue;
  /** Worst-case across the dimensions present. */
  confidence: LoadConfidence;
  /** Diagnostic flags — what was missing or low-quality. */
  sourceQualityFlags: string[];
}

/**
 * Input describing a session for which we want a load estimate.
 * Caller assembles this from `training_completions` (A0c) +
 * `session.intensityProfile.estimatedLoad` (A2b) + athlete profile.
 */
export interface LoadEstimateInput {
  sport: Sport;
  /** Estimated TSS from `session.intensityProfile.estimatedLoad` (A2b). */
  plannedTss?: number;
  /** Actual completion data — present after the session is logged. */
  completion?: CompletionData;
  /** Athlete anchors for IF/pace math. */
  athlete?: Pick<
    AthleteProfile,
    | 'bodyWeightKg'
    | 'cyclingFtpWatts'
    | 'thresholdPaceSecondsPerKm'
    | 'swimCssSecondsPer100m'
  >;
}

export interface CompletionData {
  /** Foster CR-10 session RPE (0-10). The `rpe_overall` column from migration 023 is canonical. */
  sessionRpe?: number;
  /** Reps in reserve (Zourdos scale, 0-5). Optional. */
  rir?: number;
  durationSec?: number;
  distanceMeters?: number;
  /** Cycling normalized power if available (Wattbike, smart trainers). */
  normalizedPowerWatts?: number;
  /** HR-derived TRIMP if pre-computed by an integration. */
  trimpAu?: number;
  /** Strength: sum of all working-set tonnage in kg. */
  strengthTonnageKg?: number;
  /** Strength: count of working sets at or above the prescribed RPE/RIR. */
  hardSetCount?: number;
}

// ---------- Computation ----------

/** Foster sRPE × duration internal-load. Duration in minutes. */
function computeSrpeLoad(rpe: number, durationMinutes: number): number {
  return Math.round(rpe * durationMinutes);
}

/**
 * Confidence assignment heuristics:
 *
 *   - planned forecast based on athlete anchors → 'medium' (forecast is approximate)
 *   - device-power TSS → 'high'
 *   - pace-derived TSS with known T-pace → 'high'
 *   - sRPE × duration with logged session_rpe → 'medium'
 *   - HR-derived TRIMP → 'medium'
 *   - strength tonnage with reported sets/reps/weight → 'high'
 *   - strength hard-set count without RPE/RIR → 'low'
 *   - impact count derived from distance only → 'low'
 */

/**
 * Estimate planned external load. Returns undefined when no planned
 * TSS is provided (athlete anchors missing → A2b couldn't compute IF).
 */
function estimatePlannedExternalLoad(input: LoadEstimateInput): LoadValue | undefined {
  if (input.plannedTss === undefined) return undefined;
  return {
    score: Math.round(input.plannedTss),
    unit: 'tss',
    source: 'planned',
    confidence: 'medium',
  };
}

/**
 * Estimate completed external load. Preference order:
 *   1. Cycling normalized power (NP) → NP/FTP-derived TSS (high confidence)
 *   2. Running/swimming completed pace × distance → pace-derived TSS (high)
 *   3. Otherwise undefined (no device data → fall through to internal)
 */
function estimateCompletedExternalLoad(input: LoadEstimateInput): LoadValue | undefined {
  const completion = input.completion;
  if (!completion?.durationSec || completion.durationSec <= 0) return undefined;

  const durationHours = completion.durationSec / 3600;

  // Cycling power → Coggan TSS via NP/FTP
  if (input.sport === 'cycling' && completion.normalizedPowerWatts && input.athlete?.cyclingFtpWatts) {
    const intensityFactor = completion.normalizedPowerWatts / input.athlete.cyclingFtpWatts;
    return {
      score: Math.round(durationHours * intensityFactor * intensityFactor * 100),
      unit: 'tss',
      source: 'device_power',
      confidence: 'high',
    };
  }

  // Running pace → avg pace / T-pace → IF
  if (
    input.sport === 'running' &&
    completion.distanceMeters &&
    completion.distanceMeters > 0 &&
    input.athlete?.thresholdPaceSecondsPerKm
  ) {
    const completedPaceSecPerKm = completion.durationSec / (completion.distanceMeters / 1000);
    const intensityFactor = input.athlete.thresholdPaceSecondsPerKm / completedPaceSecPerKm;
    return {
      score: Math.round(durationHours * intensityFactor * intensityFactor * 100),
      unit: 'tss',
      source: 'pace',
      confidence: 'high',
    };
  }

  // Swim pace
  if (
    input.sport === 'swimming' &&
    completion.distanceMeters &&
    completion.distanceMeters > 0 &&
    input.athlete?.swimCssSecondsPer100m
  ) {
    const completedPaceSecPer100m = completion.durationSec / (completion.distanceMeters / 100);
    const intensityFactor = input.athlete.swimCssSecondsPer100m / completedPaceSecPer100m;
    return {
      score: Math.round(durationHours * intensityFactor * intensityFactor * 100),
      unit: 'tss',
      source: 'pace',
      confidence: 'high',
    };
  }

  return undefined;
}

/**
 * Estimate completed internal load. sRPE × duration is the universal
 * fallback (Foster 2001) — always emitted when sRPE + duration both
 * present. TRIMP from integration data is preferred when present.
 */
function estimateCompletedInternalLoad(input: LoadEstimateInput): LoadValue | undefined {
  const completion = input.completion;
  if (!completion) return undefined;

  // Prefer pre-computed TRIMP from integration if present.
  if (completion.trimpAu !== undefined && completion.trimpAu >= 0) {
    return {
      score: Math.round(completion.trimpAu),
      unit: 'trimp_au',
      source: 'device_hr',
      confidence: 'medium',
    };
  }

  // sRPE × duration fallback. Foster 2001.
  if (completion.sessionRpe !== undefined && completion.durationSec && completion.durationSec > 0) {
    const durationMin = completion.durationSec / 60;
    return {
      score: computeSrpeLoad(completion.sessionRpe, durationMin),
      unit: 'srpe_au',
      source: 'session_rpe',
      confidence: 'medium',
    };
  }

  return undefined;
}

/**
 * Estimate strength load. Returns undefined for non-strength sports
 * or when no strength-specific data is provided. Tonnage is kept in
 * its own dimension — never folded into TSS.
 */
function estimateStrengthLoad(input: LoadEstimateInput): LoadValue | undefined {
  if (input.sport !== 'strength') return undefined;
  const completion = input.completion;
  if (!completion) return undefined;

  // Tonnage is the canonical strength load. Hard-set count is a
  // secondary signal; report whichever is most informative.
  if (completion.strengthTonnageKg !== undefined && completion.strengthTonnageKg >= 0) {
    return {
      score: Math.round(completion.strengthTonnageKg),
      unit: 'tonnage_kg',
      source: 'strength_tonnage',
      confidence: completion.sessionRpe !== undefined || completion.rir !== undefined ? 'high' : 'medium',
    };
  }
  if (completion.hardSetCount !== undefined && completion.hardSetCount >= 0) {
    return {
      score: completion.hardSetCount,
      unit: 'hard_set_count',
      source: 'strength_tonnage',
      confidence: 'low', // sets without weight = low resolution
    };
  }
  return undefined;
}

/**
 * Estimate impact load. Runs/plyometrics only. Uses a simple
 * `distance × pace_factor × body_mass_factor` proxy — not a precise
 * bone-stress model, but useful for relative comparisons within an
 * athlete. Future slices may swap this for a GCT-aware accelerometer-
 * derived value when device data supports it.
 *
 * Returns undefined for non-running sports.
 */
function estimateImpactLoad(input: LoadEstimateInput): LoadValue | undefined {
  if (input.sport !== 'running') return undefined;
  const completion = input.completion;
  if (!completion?.distanceMeters || completion.distanceMeters <= 0) return undefined;
  if (!completion.durationSec || completion.durationSec <= 0) return undefined;

  // Steps per km × distance × mass factor. ~1300 steps/km for adults at moderate pace.
  // We use a simplified proxy: distance_km × 1.3 (per-km step count proxy normalized).
  const distanceKm = completion.distanceMeters / 1000;
  const massFactor = input.athlete?.bodyWeightKg
    ? input.athlete.bodyWeightKg / 70 // normalize to 70kg reference athlete
    : 1;
  const paceSecPerKm = completion.durationSec / distanceKm;
  const paceFactor = Math.min(1.4, Math.max(0.75, 300 / paceSecPerKm));
  const impactScore = Math.round(distanceKm * 1.3 * massFactor * paceFactor * 10);
  return {
    score: impactScore,
    unit: 'impact_au',
    source: 'impact_count',
    confidence: input.athlete?.bodyWeightKg ? 'medium' : 'low',
  };
}

// ---------- Public API ----------

/**
 * Build a multi-dimensional `SessionLoadEstimate` from whatever data
 * is available. Each dimension is computed independently and emitted
 * with its own confidence + source provenance. Quality flags surface
 * what's missing so callers (slice B1's CTL/ATL aggregation) can
 * downweight or skip low-quality rows.
 *
 * Never collapses into a single number — the four-dimensional shape
 * is the point. If a caller wants a single scalar for backwards
 * compat, call `pickPreferredLoadScore(estimate)` separately and
 * make the loss explicit at the call-site.
 */
export function estimateSessionLoad(input: LoadEstimateInput): SessionLoadEstimate {
  const plannedExt = estimatePlannedExternalLoad(input);
  const completedExt = estimateCompletedExternalLoad(input);
  const completedInt = estimateCompletedInternalLoad(input);
  const strength = estimateStrengthLoad(input);
  const impact = estimateImpactLoad(input);

  const flags: string[] = [];
  if (input.plannedTss === undefined) flags.push('planned_load_unavailable');
  if (input.completion) {
    if (input.completion.sessionRpe === undefined) flags.push('srpe_missing');
    if (!input.completion.durationSec) flags.push('completion_duration_missing');
    if (input.sport === 'cycling' && completedExt?.source !== 'device_power') {
      flags.push('cycling_power_absent');
    }
    if (input.sport === 'running' && !input.athlete?.thresholdPaceSecondsPerKm) {
      flags.push('running_anchor_missing');
    }
    if (input.sport === 'strength' && !strength) {
      flags.push('strength_completion_missing');
    }
  } else {
    flags.push('completion_data_absent');
  }

  const dims = [plannedExt, completedExt, completedInt, strength, impact].filter(
    (d): d is LoadValue => d !== undefined,
  );
  const confidence = dims.length === 0
    ? 'low'
    : dims.some((d) => d.confidence === 'low')
      ? 'low'
      : dims.every((d) => d.confidence === 'high')
        ? 'high'
        : 'medium';

  return {
    plannedExternalLoad: plannedExt,
    completedExternalLoad: completedExt,
    completedInternalLoad: completedInt,
    strengthLoad: strength,
    impactLoad: impact,
    confidence,
    sourceQualityFlags: flags,
  };
}

/**
 * For backwards-compat with single-load consumers: pick the preferred
 * load score using a deterministic preference order. The result is
 * NOT a normalized cross-source number — it's the "best signal we
 * have" for this session in its native unit. Slice B1 will use the
 * full estimate; this helper is for legacy reads only.
 *
 * Preference order:
 *   1. completedExternalLoad (device data, highest signal)
 *   2. completedInternalLoad (sRPE/TRIMP fallback)
 *   3. plannedExternalLoad (forecast)
 *   4. strengthLoad (tonnage)
 *   5. impactLoad
 *
 * Returns undefined when no dimension has a value.
 */
export function pickPreferredLoadScore(
  estimate: SessionLoadEstimate,
): LoadValue | undefined {
  return (
    estimate.completedExternalLoad ??
    estimate.completedInternalLoad ??
    estimate.plannedExternalLoad ??
    estimate.strengthLoad ??
    estimate.impactLoad ??
    undefined
  );
}
