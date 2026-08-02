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

import type { AthleteState, DayOfWeek, Sport, TrainingDecisionReason } from './types';

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
  return pickAvailableDaysDetailed(athlete, sport, preferences, minimumCount).days;
}

/**
 * F9 (Phase 3): typed capacity conflict for insufficient declared
 * availability. Carried on decision reasons so iOS can render an honest
 * "your availability can't cover this frequency" banner instead of the
 * athlete discovering weekday sessions they never declared time for.
 */
export interface TrainingAvailabilityCapacityConflict {
  code: 'TRAINING_AVAILABILITY_INSUFFICIENT_FOR_FREQUENCY';
  sport: Sport;
  requiredCount: number;
  availableCount: number;
  availableDays: DayOfWeek[];
  requestedDays: DayOfWeek[];
}

export type AvailabilityDayPickOutcome =
  | {
    /** MISSING availability — the athlete never declared windows. Every day
     *  is treated as available (the legacy default for brand-new users).
     *  This is NOT a conflict: there is nothing to contradict. */
    kind: 'no_availability_declared';
    days: DayOfWeek[];
  }
  | {
    /** Declared windows cover the ask. */
    kind: 'available';
    days: DayOfWeek[];
  }
  | {
    /** INSUFFICIENT — windows are declared but cannot cover `minimumCount`.
     *  `days` keeps the legacy fallback (full preference list) so placement
     *  behaviour is unchanged; the typed conflict is the honest signal the
     *  legacy API silently swallowed. */
    kind: 'insufficient_availability';
    days: DayOfWeek[];
    unavailableDays: DayOfWeek[];
    conflict: TrainingAvailabilityCapacityConflict;
  };

/**
 * F9 (Phase 3): same day selection as `pickAvailableDays` — byte-identical
 * `days` in every case — but with MISSING and INSUFFICIENT availability
 * distinguished instead of collapsed into one silent fallback.
 */
export function pickAvailableDaysDetailed(
  athlete: AthleteState,
  sport: Sport,
  preferences: ReadonlyArray<DayOfWeek>,
  minimumCount: number = preferences.length,
): AvailabilityDayPickOutcome {
  const windows = athlete.availability?.weeklyWindows ?? [];
  if (windows.length === 0) {
    return { kind: 'no_availability_declared', days: [...preferences] };
  }
  const filtered = preferences.filter((day) => isDayAvailableForSport(athlete, day, sport));
  if (filtered.length >= minimumCount) {
    return { kind: 'available', days: [...filtered] };
  }
  return {
    kind: 'insufficient_availability',
    days: [...preferences],
    unavailableDays: preferences.filter((day) => !filtered.includes(day)),
    conflict: {
      code: 'TRAINING_AVAILABILITY_INSUFFICIENT_FOR_FREQUENCY',
      sport,
      requiredCount: minimumCount,
      availableCount: filtered.length,
      availableDays: [...filtered],
      requestedDays: [...preferences],
    },
  };
}

/**
 * F9: warning-severity decision reason engines attach to sessions placed on
 * days the athlete's declared availability does not cover. Severity is
 * deliberately 'warning' — surfacing, not blocking — because the fallback
 * placement is the released behaviour and blocking is a separate canary
 * decision.
 */
export function buildAvailabilityInsufficiencyDecisionReason(
  conflict: TrainingAvailabilityCapacityConflict,
  dayOfWeek: DayOfWeek,
): TrainingDecisionReason {
  const availableLabel = conflict.availableDays.length > 0
    ? conflict.availableDays.join(', ')
    : 'no days';
  return {
    code: 'availability_insufficient_for_frequency',
    severity: 'warning',
    text:
      `Your declared availability covers ${conflict.availableCount} of the ${conflict.requiredCount} `
      + `${conflict.sport} days this plan needs (${availableLabel}), so this session was placed on a day `
      + `you have not marked as available. Update your availability or lower the weekly frequency.`,
    affectedEntity: { type: 'session', dayOfWeek },
    sourceConstraint: {
      type: 'capacity',
      id: conflict.code,
      label: 'Declared weekly availability',
    },
    evidence: [
      `requiredCount=${conflict.requiredCount}`,
      `availableCount=${conflict.availableCount}`,
      `availableDays=${conflict.availableDays.join(',') || 'none'}`,
    ],
  };
}

/**
 * F9: annotate every session that landed on a day the athlete's declared
 * availability does not cover. No-op for the other outcomes, so engines can
 * apply it unconditionally after building their session lists.
 */
export function annotateSessionsOnUnavailableDays<
  T extends { dayOfWeek: DayOfWeek; decisionReasons?: TrainingDecisionReason[] },
>(sessions: T[], outcome: AvailabilityDayPickOutcome): T[] {
  if (outcome.kind !== 'insufficient_availability') return sessions;
  return sessions.map((session) => (
    outcome.unavailableDays.includes(session.dayOfWeek)
      ? {
        ...session,
        decisionReasons: [
          ...(session.decisionReasons ?? []),
          buildAvailabilityInsufficiencyDecisionReason(outcome.conflict, session.dayOfWeek),
        ],
      }
      : session
  ));
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
