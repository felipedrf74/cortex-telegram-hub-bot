// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WeekIntent resolver — slice B2 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Replaces `BlockPhase` as the planning unit. Each week has a
 * `WeekIntent` carrying volume + intensity + quality semantics; the
 * resolver picks the right intent based on (mesocycle, weekIndex,
 * raceCalendar, policy).
 *
 * Resolution precedence (highest to lowest):
 *   1. Race day in this week → 'race' intent
 *   2. In post-race recovery window → 'post_race_recovery' intent
 *   3. In pre-race taper window → 'taper' intent
 *   4. Mesocycle template position → 'accumulation' / 'deload' / etc.
 *   5. Fallback default → 'accumulation'
 *
 * Defaults are sourced from `training-principles.json`
 * (`weekIntentDefaults`, slice A1b). The resolver returns a fully-
 * populated WeekIntent — never undefined — so engines always have
 * something to dispatch on.
 */

import type {
  BlockPhase,
  IntensityZone,
  RaceEvent,
  WeekIntent,
  WeekIntentKindEnum,
} from './types';
import { getWeekIntentDefaults, type Principles } from './training-principles';
import {
  daysToRace,
  findMostRecentPastRace,
  findNextRace,
  isInPostRaceRecovery,
  isInTaperWindow,
} from '../race-calendar';

/**
 * Map a WeekIntentKind to the legacy BlockPhase string for backwards
 * compatibility with persistence + iOS contracts. Some kinds map
 * cleanly; others (recovery, post_race_recovery) collapse to the
 * closest BlockPhase.
 */
export function blockPhaseFromWeekIntent(kind: WeekIntentKindEnum): BlockPhase {
  switch (kind) {
    case 'accumulation': return 'base';
    case 'intensification': return 'build';
    case 'realization': return 'peak';
    case 'deload': return 'deload';
    case 'recovery': return 'deload';
    case 'taper': return 'taper';
    case 'race': return 'race';
    case 'post_race_recovery': return 'deload';
    default: return 'maintenance';
  }
}

/**
 * Read the WeekIntent defaults from training-principles.json (A1b)
 * and synthesize a complete WeekIntent. Falls back to safe inline
 * defaults if the JSON is missing the kind.
 */
export function intentFromKind(
  kind: WeekIntentKindEnum,
  principles: Principles,
): WeekIntent {
  const fromJson = getWeekIntentDefaults(principles, kind);
  if (fromJson) {
    return {
      kind,
      volumeMultiplier: fromJson.volumeMultiplier,
      intensityFloor: fromJson.intensityFloor as IntensityZone | 'race',
      intensityCeiling: fromJson.intensityCeiling as IntensityZone | 'race',
      primaryQuality: fromJson.primaryQuality as WeekIntent['primaryQuality'],
      sorenessSensitive: fromJson.sorenessSensitive,
    };
  }
  return inlineFallbackIntent(kind);
}

/**
 * Inline fallbacks when JSON is unavailable. Conservative — the
 * engine fails open by emitting valid intents even without the JSON.
 */
function inlineFallbackIntent(kind: WeekIntentKindEnum): WeekIntent {
  switch (kind) {
    case 'accumulation':
      return { kind, volumeMultiplier: 1.0, intensityFloor: 'aerobic', intensityCeiling: 'threshold', primaryQuality: 'volume' };
    case 'intensification':
      return { kind, volumeMultiplier: 0.9, intensityFloor: 'tempo', intensityCeiling: 'vo2', primaryQuality: 'intensity' };
    case 'realization':
      return { kind, volumeMultiplier: 0.85, intensityFloor: 'threshold', intensityCeiling: 'neuromuscular', primaryQuality: 'specificity', sorenessSensitive: true };
    case 'deload':
      return { kind, volumeMultiplier: 0.6, intensityFloor: 'recovery', intensityCeiling: 'tempo', primaryQuality: 'recovery', sorenessSensitive: true };
    case 'recovery':
      return { kind, volumeMultiplier: 0.5, intensityFloor: 'recovery', intensityCeiling: 'aerobic', primaryQuality: 'recovery', sorenessSensitive: true };
    case 'taper':
      return { kind, volumeMultiplier: 0.5, intensityFloor: 'tempo', intensityCeiling: 'vo2', primaryQuality: 'sharpness', sorenessSensitive: true };
    case 'race':
      return { kind, volumeMultiplier: 0.3, intensityFloor: 'race', intensityCeiling: 'race', primaryQuality: 'race', sorenessSensitive: true };
    case 'post_race_recovery':
      return { kind, volumeMultiplier: 0.4, intensityFloor: 'recovery', intensityCeiling: 'aerobic', primaryQuality: 'recovery', sorenessSensitive: true };
    default:
      return { kind: 'accumulation', volumeMultiplier: 1.0, intensityFloor: 'aerobic', intensityCeiling: 'threshold', primaryQuality: 'volume' };
  }
}

export interface ResolveWeekIntentInput {
  /** ISO date for the Monday of the week being resolved. */
  weekStartISODate: string;
  /** Optional mesocycle block template (A1b blockTemplates entry). */
  mesocycle?: WeekIntentKindEnum[];
  /** 0-based week-in-block position. */
  weekInBlock?: number;
  raceCalendar?: readonly RaceEvent[];
  principles: Principles;
}

/**
 * Resolve the WeekIntent for a specific week.
 *
 * Note: the existing `resolveWeekPhase` function in
 * `training-coach-kernel-plan-generator.ts:1771` continues to work and
 * returns BlockPhase strings for backwards compat. Slice B2 introduces
 * this new resolver; engines adopt it incrementally.
 */
export function resolveWeekIntent(input: ResolveWeekIntentInput): WeekIntent {
  const cal = input.raceCalendar ?? [];

  // 1. Race day in this week — check next 7 days INCLUDING today.
  //    (findNextRace uses strict-greater-than, so we also explicitly
  //    inspect any race whose date falls in [weekStart, weekStart+6].)
  const weekStartMs = Date.parse(input.weekStartISODate);
  if (Number.isFinite(weekStartMs)) {
    const weekEndMs = weekStartMs + 6 * 24 * 3600 * 1000;
    const raceThisWeek = cal.find((r) => {
      const d = Date.parse(r.date);
      return Number.isFinite(d) && d >= weekStartMs && d <= weekEndMs;
    });
    if (raceThisWeek) {
      return intentFromKind('race', input.principles);
    }
  }
  // Defensive: also use findNextRace for forward-compat.
  const next = findNextRace(cal, input.weekStartISODate);
  if (next) {
    const dtr = daysToRace(next, input.weekStartISODate);
    if (dtr !== undefined && dtr >= 0 && dtr <= 6) {
      return intentFromKind('race', input.principles);
    }
  }

  // 2. Post-race recovery — only when the most-recent race is in the
  //    past (NOT today). Race-day-itself is handled above.
  const postRace = isInPostRaceRecovery(cal, input.weekStartISODate);
  if (postRace.inRecovery && (postRace.daysSince ?? 0) > 0) {
    return intentFromKind('post_race_recovery', input.principles);
  }

  // 3. Pre-race taper.
  const taper = isInTaperWindow(cal, input.weekStartISODate);
  if (taper.inTaper) {
    return intentFromKind('taper', input.principles);
  }

  // 4. Mesocycle template position.
  if (input.mesocycle && input.weekInBlock !== undefined) {
    const kind = input.mesocycle[input.weekInBlock % input.mesocycle.length];
    if (kind) return intentFromKind(kind, input.principles);
  }

  // 5. Fallback default.
  return intentFromKind('accumulation', input.principles);
}
