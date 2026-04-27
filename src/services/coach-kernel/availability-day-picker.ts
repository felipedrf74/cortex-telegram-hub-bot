// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Availability-aware day picker — slice 4.F.
 *
 * Closes Phase 0 audit Layer-3 finding (High): the running, cycling,
 * and swimming engines hardcoded day slots
 * (`'tuesday'`, `'wednesday'`, `'saturday'`, etc.) without checking
 * the user's availability windows. A user with availability declared
 * only on weekends would still get a Tuesday-key-run scheduled —
 * resulting in an unrunnable session and a hard re-prompt loop in
 * the planner's downstream guardrails.
 *
 * Contract:
 *
 *   - `pickAvailableDay(athlete, sport, preferences)` returns the
 *     first preferred day where the user has at least one
 *     availability window for that sport (or sport-agnostic). When
 *     no availability matches a preferred day, falls back to
 *     `preferences[0]` so the engine still produces a session — the
 *     planner's downstream scheduling layer (slice 1.B
 *     `scheduleSessionWindow`) handles the actual time placement
 *     and surfaces a `preferred_time_unavailable` flag if needed.
 *
 *   - `pickAvailableDays(athlete, sport, preferences)` returns ALL
 *     preferred days the user has windows for, in preference order,
 *     with hardcoded preferences used as fallback when the
 *     availability table is sparse or empty.
 *
 *   - When `availability.weeklyWindows` is empty, treats every day
 *     as available (matches the pre-slice behavior). This keeps
 *     existing tests + brand-new users (no availability declared)
 *     working without code changes.
 */

import type { AthleteState, DayOfWeek, Sport } from './types';

/**
 * Return true if the athlete has at least one availability window
 * on `dayOfWeek` that's either compatible with `sport` or has no
 * sport restriction (sport-agnostic). When the athlete has no
 * weeklyWindows at all, returns true (legacy default).
 */
export function isDayAvailableForSport(
  athlete: AthleteState,
  dayOfWeek: DayOfWeek,
  sport: Sport,
): boolean {
  const windows = athlete.availability?.weeklyWindows ?? [];
  if (windows.length === 0) return true;
  return windows.some((window) => {
    if (window.dayOfWeek !== dayOfWeek) return false;
    // No `sports` array means the window applies to any sport.
    if (!window.sports || window.sports.length === 0) return true;
    return window.sports.includes(sport);
  });
}

/**
 * Pick the first day from `preferences` where the athlete has an
 * availability window for `sport`. Falls back to `preferences[0]`
 * when no preferred day matches — that gives the engine a
 * deterministic answer even on a fully-busy week, and the
 * downstream scheduler will still attempt to find a time slot.
 */
export function pickAvailableDay(
  athlete: AthleteState,
  sport: Sport,
  preferences: ReadonlyArray<DayOfWeek>,
): DayOfWeek {
  if (preferences.length === 0) return 'monday';
  const match = preferences.find((day) => isDayAvailableForSport(athlete, day, sport));
  return match ?? preferences[0];
}

/**
 * Pick days from `preferences` that have availability for the sport,
 * preserving order. Days without availability are dropped UNLESS
 * dropping them would leave fewer than `minimumCount` days — in
 * which case the original preference order is returned untouched
 * (a partially-busy week still gets the hardcoded fallback rather
 * than a too-short session list).
 *
 * `minimumCount` defaults to the length of `preferences` so callers
 * who supply a tight day list (e.g. a 3-element preference array)
 * never lose days they rely on.
 */
export function pickAvailableDays(
  athlete: AthleteState,
  sport: Sport,
  preferences: ReadonlyArray<DayOfWeek>,
  minimumCount: number = preferences.length,
): DayOfWeek[] {
  const filtered = preferences.filter((day) => isDayAvailableForSport(athlete, day, sport));
  if (filtered.length >= minimumCount) {
    return [...filtered];
  }
  return [...preferences];
}

/**
 * Pick a key-session day (e.g. tuesday for the running engine's
 * key workout). Same semantics as `pickAvailableDay` but defaults
 * are encoded inline so engines don't have to repeat them.
 *
 * The hardcoded order matches the pre-slice-4.F engine defaults:
 *   - running key: tuesday → wednesday → thursday → ...
 *   - cycling key: wednesday → tuesday → thursday → ...
 *
 * Sport-specific defaults are passed by the engine.
 */
export function pickKeyDay(
  athlete: AthleteState,
  sport: Sport,
  defaultOrder: ReadonlyArray<DayOfWeek>,
): DayOfWeek {
  return pickAvailableDay(athlete, sport, defaultOrder);
}
