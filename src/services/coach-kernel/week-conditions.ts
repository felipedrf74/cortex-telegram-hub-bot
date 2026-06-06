// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WeekConditions aggregator — slice C7 of the Week-Level Adaptability
 * + Periodization plan (v2.1).
 *
 * Pure function over the signals produced by C1/C2/C4/C5/A4 + A3
 * lifecycle state. Returns a complete `WeekConditions` record that
 * the scenario classifier (C8) uses to dispatch its modifiers.
 *
 * Wires `athlete-lifecycle-state.ts` (kept in PR 3 §D2, 15 tests)
 * as the lifecycle-signal layer feeding the scenario classifier.
 */

import type {
  HealthSignal,
  WeekConditions,
} from './types';
import type { GapSignal } from '../gap-detector';
import type { MissedSessionSignal } from '../missed-session-sweep';
import type { AdherenceTrendResult } from '../adherence-trend';
import type { TravelWindowRow } from '../travel-windows';
import { computeTravelStressScore } from '../travel-windows';
import {
  deriveAthleteLifecycleState,
  type AthleteLifecycleVerdict,
} from './athlete-lifecycle-state';
import type { AthleteState } from './types';

export interface AggregateWeekConditionsInput {
  weekIndex: number;
  /** Missed-session signals from C1 for this week. */
  missedSessionSignals?: readonly MissedSessionSignal[];
  /** Travel windows from C2 active for this week. */
  travelWindows?: readonly TravelWindowRow[];
  /** Optional equipment override JSON from C3. */
  equipmentOverride?: Record<string, unknown>;
  /** Gap signal from C4 (when applicable). */
  gapSignal?: GapSignal | null;
  /** Adherence trend from C5. */
  adherenceTrend?: AdherenceTrendResult;
  /** Health signal from A0c (consumed by A4 + here). */
  healthSignal?: HealthSignal;
  /** True when a deload was recommended by B5. */
  deloadDue?: boolean;
  /** Lifecycle classifier input — full AthleteState (PR 3 §D2 module). */
  athleteState?: AthleteState;
}

/**
 * Aggregate per-week derived signals into the `WeekConditions`
 * shape the scenario classifier (C8) consumes.
 *
 * The aggregator is deliberately defensive: when a signal is
 * missing, the corresponding field is left undefined. C8 then
 * treats missing fields as "no override" and falls through to
 * mesocycle position + WeekIntent defaults.
 */
export function aggregateWeekConditions(
  input: AggregateWeekConditionsInput,
): WeekConditions {
  const conditions: WeekConditions = {
    weekIndex: input.weekIndex,
  };

  // C1 — missed sessions this week. Capture both the count (for
  // summaries / analytics) AND the actual session IDs so C8 acts on
  // the specific sessions rather than "every session in the week".
  // Codex P2 fix.
  if (input.missedSessionSignals && input.missedSessionSignals.length > 0) {
    conditions.missedSessionsThisWeek = input.missedSessionSignals.length;
    conditions.missedSessionIds = input.missedSessionSignals.map((s) => String(s.sessionId));
  }

  // C2 — travel.
  if (input.travelWindows && input.travelWindows.length > 0) {
    conditions.isTravelWeek = true;
    const score = Math.max(...input.travelWindows.map(computeTravelStressScore));
    conditions.travelStress = {
      timeZoneShiftHours: maxAbsDefined(input.travelWindows.map((window) => window.time_zone_shift_hours)),
      flightDurationHours: maxDefined(input.travelWindows.map((window) => window.flight_duration_hours)),
      sleepDisruptionExpected: input.travelWindows.some((window) => window.sleep_disruption_expected === 1),
      walkingLoadExpected: input.travelWindows.some((window) => window.walking_load_expected === 1),
      heatStress: input.travelWindows.some((window) => window.heat_stress === 1),
    };
    // Surface score under a custom field for C8 (it inspects this
    // via `travelStressScore` on a downstream extension).
    (conditions as WeekConditions & { travelStressScore?: number }).travelStressScore = score;
  }

  // C3 — equipment override.
  if (input.equipmentOverride) {
    conditions.equipmentOverride = input.equipmentOverride;
  }

  // C4 — return-from-gap protocol.
  if (input.gapSignal) {
    conditions.returnProtocol = input.gapSignal.protocol;
  }

  // C5 — low-adherence trend.
  if (input.adherenceTrend?.trendLow) {
    conditions.lowAdherenceTrend = true;
  }

  // B5 — deload due.
  if (input.deloadDue) {
    conditions.deloadDue = true;
  }

  // A3 lifecycle state (wires PR 3 §D2 athlete-lifecycle-state).
  if (input.athleteState) {
    const lifecycle: AthleteLifecycleVerdict = deriveAthleteLifecycleState(input.athleteState);
    conditions.lifecycleState = lifecycle.state;
  }

  return conditions;
}

function maxDefined(values: Array<number | null | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numeric.length > 0 ? Math.max(...numeric) : undefined;
}

function maxAbsDefined(values: Array<number | null | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numeric.length === 0) return undefined;
  return numeric.reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, numeric[0]);
}
