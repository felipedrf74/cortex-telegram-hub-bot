// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Race calendar read model — slice B2a of the Week-Level Adaptability
 * + Periodization plan (v2.1).
 *
 * Pure functions over a `RaceEvent[]` array. Engines (B3 mesocycle,
 * B5 deload, B7 taper, B8 post-race recovery) consume these to make
 * race-aware decisions:
 *
 *   - "Is there a race in the next N days?" (B7 taper trigger)
 *   - "Did we just finish a race in the last N days?" (B8 post-race)
 *   - "What's the priority of the next race?" (B7 taper depth)
 *   - "Is this a multisport race?" (B8 brick recovery)
 *
 * No DB access — the caller hydrates RaceEvent[] from the plan's
 * goals.raceCalendar field.
 */

import type {
  RaceEvent,
  RacePriorityNormalized,
} from './coach-kernel/types';

/**
 * Normalize the lowercase a/b/c priority used in RaceEvent.priority
 * to the uppercase A/B/C used by engines + periodization JSON.
 */
export function normalizeRacePriority(priority: RaceEvent['priority']): RacePriorityNormalized {
  return priority.toUpperCase() as RacePriorityNormalized;
}

/**
 * Find the next race after a given date. Returns undefined when no
 * future races exist.
 */
export function findNextRace(
  calendar: readonly RaceEvent[],
  asOfISODate: string,
): RaceEvent | undefined {
  const asOf = Date.parse(asOfISODate);
  if (!Number.isFinite(asOf)) return undefined;
  const futures = calendar
    .filter((r) => Date.parse(r.date) > asOf)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return futures[0];
}

/**
 * Find the most recent past race. Returns undefined when no past
 * races exist.
 */
export function findMostRecentPastRace(
  calendar: readonly RaceEvent[],
  asOfISODate: string,
): RaceEvent | undefined {
  const asOf = Date.parse(asOfISODate);
  if (!Number.isFinite(asOf)) return undefined;
  const pasts = calendar
    .filter((r) => Date.parse(r.date) <= asOf)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return pasts[0];
}

/**
 * Days from `fromDate` to a race. Returns negative if the race is in
 * the past, positive if in the future. Returns undefined for
 * malformed dates.
 */
export function daysToRace(race: RaceEvent, fromDate: string): number | undefined {
  const start = Date.parse(fromDate);
  const end = Date.parse(race.date);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.round((end - start) / (24 * 3600 * 1000));
}

/**
 * Is the athlete in the post-race recovery window for the most
 * recent race? Uses `RaceEvent.recoveryDaysAfter` (defaults from
 * priority when unset).
 */
export function isInPostRaceRecovery(
  calendar: readonly RaceEvent[],
  asOfISODate: string,
): { inRecovery: boolean; race?: RaceEvent; daysSince?: number } {
  const recent = findMostRecentPastRace(calendar, asOfISODate);
  if (!recent) return { inRecovery: false };
  const days = daysToRace(recent, asOfISODate);
  if (days === undefined) return { inRecovery: false };
  const daysSince = -days; // recent race is in the past, so days is negative
  const recoveryDays = recent.recoveryDaysAfter ?? defaultRecoveryDays(recent);
  return {
    inRecovery: daysSince >= 0 && daysSince <= recoveryDays,
    race: recent,
    daysSince,
  };
}

/**
 * Is the athlete in the taper window for the next race? Uses
 * priority to determine taper window length (A=14d, B=7d, C=3d).
 */
export function isInTaperWindow(
  calendar: readonly RaceEvent[],
  asOfISODate: string,
): { inTaper: boolean; race?: RaceEvent; daysToRace?: number; taperWindowDays?: number } {
  const next = findNextRace(calendar, asOfISODate);
  if (!next) return { inTaper: false };
  const dtr = daysToRace(next, asOfISODate);
  if (dtr === undefined || dtr < 0) return { inTaper: false };
  const window = defaultTaperWindowDays(next);
  return {
    inTaper: dtr <= window,
    race: next,
    daysToRace: dtr,
    taperWindowDays: window,
  };
}

/**
 * Default recovery-days-after for a race. Used when
 * RaceEvent.recoveryDaysAfter is unset. Scales with priority + format.
 */
function defaultRecoveryDays(race: RaceEvent): number {
  const isMulti = race.raceFormat === 'multisport' || race.discipline === 'triathlon';
  if (race.priority === 'a') {
    // Long course tris get the longest recovery (Ironman 14, 70.3 10).
    if (isMulti && race.subtype === 'ironman') return 14;
    if (isMulti && race.subtype === '70.3') return 10;
    if (isMulti) return 7; // sprint / olympic
    if (race.subtype === 'marathon') return 10;
    return 5;
  }
  if (race.priority === 'b') return 3;
  return 1; // 'c' priority — brief tune-up
}

/** Default taper-window length in days based on race priority. */
function defaultTaperWindowDays(race: RaceEvent): number {
  if (race.priority === 'a') return 14;
  if (race.priority === 'b') return 7;
  return 3;
}

/**
 * Resolve disciplines for a race, defaulting to the single discipline
 * for non-multisport races and a sensible default for triathlon.
 */
export function resolveRaceDisciplines(
  race: RaceEvent,
): Array<'running' | 'cycling' | 'swimming'> {
  if (race.disciplines && race.disciplines.length > 0) return race.disciplines;
  if (race.discipline === 'triathlon') return ['swimming', 'cycling', 'running'];
  if (race.discipline === 'running' || race.discipline === 'cycling' || race.discipline === 'swimming') {
    return [race.discipline];
  }
  return [];
}
