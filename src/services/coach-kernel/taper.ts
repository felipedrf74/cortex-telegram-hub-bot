// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Day-level taper engine — slice B7 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Replaces the marathon special-case at `strength-engine.ts:1344`
 * with a generic taper engine that operates at DAY granularity (not
 * week-blanket multipliers as in v1).
 *
 * Algorithm (Mujika & Padilla 2003 + Bosquet 2007 meta):
 *   - Total taper window length scales with race priority (A=14d,
 *     B=7d, C=3d).
 *   - Volume drops EXPONENTIALLY toward the race day; from baseline
 *     1.0 down to (1 - volumeDropPct/100) by race day.
 *   - Intensity is PRESERVED at ~100% — a taper is a volume taper.
 *   - Strength is cut off N days before race (A=7d, B=3d, C=2d).
 *   - Missed sessions in the taper window are DROPPED, NEVER crammed.
 *
 * Inputs are pure: caller supplies daysToRace, priority, and (from
 * A1b) the taper coefficients. The engine returns a daily multiplier
 * + booleans for strength gating.
 */

import {
  getTaperCoefficients,
  type Principles,
  type RacePriority,
  type TaperPriorityCoefficients,
} from './training-principles';

export interface TaperDecisionInput {
  /** Days from today to race day. Negative = past race (return undefined). */
  daysToRace: number;
  /** Race priority (uppercase A/B/C from RaceEvent.priority). */
  priority: RacePriority;
  /** Optional override. When set, uses these instead of A1b defaults. */
  overrideCoefficients?: {
    durationDays: number;
    volumeDropPct: number;
    intensityPreservedPct: number;
    strengthCutoffDaysBeforeRace: number;
    minimumVolumePct?: number;
    maximumVolumePct?: number;
  };
}

export interface TaperDecision {
  /** True when daysToRace falls inside the taper window for this priority. */
  inTaperWindow: boolean;
  /**
   * Volume multiplier for today's session: 1.0 = full baseline, 0.4 =
   * 40% volume. Returns 1.0 when outside taper window.
   */
  volumeMultiplier: number;
  /** Intensity-preservation guidance — taper preserves intensity. */
  intensityPreservedPct: number;
  /** True when strength sessions should be downgraded or dropped today. */
  strengthCutoffActive: boolean;
  /** Number of days into the taper window (0 = first day, durationDays-1 = race eve). */
  dayInTaper: number;
  /** Number of days remaining in the taper. */
  daysRemainingInTaper: number;
  rationale: string;
}

const FALLBACK_COEFFICIENTS: Record<RacePriority, TaperPriorityCoefficients> = {
  A: { durationDays: 14, volumeDropPct: 55, intensityPreservedPct: 100, strengthCutoffDaysBeforeRace: 7 },
  B: { durationDays: 7, volumeDropPct: 45, intensityPreservedPct: 100, strengthCutoffDaysBeforeRace: 3 },
  C: { durationDays: 3, volumeDropPct: 35, intensityPreservedPct: 100, strengthCutoffDaysBeforeRace: 2 },
};

/**
 * Compute today's taper decision for an athlete with `daysToRace`
 * remaining. The engine returns a multiplier in [1 - volumeDropPct/100, 1.0].
 *
 * Volume drop is exponential: on day 0 (race day) volume = (1 -
 * volumeDropPct/100); on day `durationDays-1` (first taper day),
 * volume ≈ 1.0. Specifically:
 *   multiplier(daysToRace) = endMultiplier + (1 - endMultiplier) * (daysToRace / durationDays)^2
 * where endMultiplier = 1 - volumeDropPct/100.
 *
 * This quadratic curve fits the Bosquet 2007 meta-analysis profile:
 * gentle reduction early, steeper toward race day.
 */
export function decideTaper(
  input: TaperDecisionInput,
  principles: Principles,
): TaperDecision {
  const coeffs = input.overrideCoefficients
    ?? getTaperCoefficients(principles, input.priority)
    ?? FALLBACK_COEFFICIENTS[input.priority];

  // Outside taper window?
  if (input.daysToRace < 0 || input.daysToRace > coeffs.durationDays) {
    return {
      inTaperWindow: false,
      volumeMultiplier: 1.0,
      intensityPreservedPct: 100,
      strengthCutoffActive: false,
      dayInTaper: -1,
      daysRemainingInTaper: -1,
      rationale: `Outside taper window (${input.daysToRace}d to race, taper window ${coeffs.durationDays}d).`,
    };
  }

  const endMultiplier = 1 - coeffs.volumeDropPct / 100;
  // Quadratic curve from endMultiplier (at race day) up to ~1.0 (at start of taper).
  const t = input.daysToRace / coeffs.durationDays; // 0..1
  const rawVolumeMultiplier = endMultiplier + (1 - endMultiplier) * t * t;
  const minMultiplier = typeof coeffs.minimumVolumePct === 'number' ? coeffs.minimumVolumePct / 100 : 0;
  const maxMultiplier = typeof coeffs.maximumVolumePct === 'number' ? coeffs.maximumVolumePct / 100 : 1;
  const volumeMultiplier = Math.min(Math.max(rawVolumeMultiplier, minMultiplier), maxMultiplier);

  const dayInTaper = coeffs.durationDays - input.daysToRace;
  const daysRemainingInTaper = input.daysToRace;
  const strengthCutoffActive = input.daysToRace <= coeffs.strengthCutoffDaysBeforeRace;

  return {
    inTaperWindow: true,
    volumeMultiplier: Math.round(volumeMultiplier * 1000) / 1000,
    intensityPreservedPct: coeffs.intensityPreservedPct,
    strengthCutoffActive,
    dayInTaper,
    daysRemainingInTaper,
    rationale: [
      `Day ${dayInTaper}/${coeffs.durationDays} of priority-${input.priority} taper.`,
      `Volume ${Math.round(volumeMultiplier * 100)}% (curve toward ${Math.round(endMultiplier * 100)}% at race).`,
      `Intensity preserved at ${coeffs.intensityPreservedPct}%.`,
      strengthCutoffActive
        ? `Strength cutoff active (${input.daysToRace} ≤ ${coeffs.strengthCutoffDaysBeforeRace} days before race).`
        : `Strength still allowed (${input.daysToRace} > ${coeffs.strengthCutoffDaysBeforeRace} days before race).`,
    ].join(' '),
  };
}

/**
 * Decide whether a missed session in the taper window should be
 * crammed/rescheduled or dropped. Per v2.1 critique:
 *   - Taper sessions → NEVER cram. Drop them.
 *   - Outside taper → standard policy applies.
 */
export function shouldDropMissedTaperSession(
  daysToRace: number,
  priority: RacePriority,
  principles: Principles,
): { dropped: boolean; rationale: string } {
  const coeffs = getTaperCoefficients(principles, priority) ?? FALLBACK_COEFFICIENTS[priority];
  if (daysToRace >= 0 && daysToRace <= coeffs.durationDays) {
    return {
      dropped: true,
      rationale: `Missed session inside priority-${priority} taper (${daysToRace}d to race); dropping rather than cramming.`,
    };
  }
  return {
    dropped: false,
    rationale: `Missed session outside taper window (${daysToRace}d to race); standard policy applies.`,
  };
}
