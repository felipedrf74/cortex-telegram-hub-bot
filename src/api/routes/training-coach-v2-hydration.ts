// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Codex R2 P1 fix — real hydration helpers for the v2 routes.
 *
 * Replaces the cosmetic-wiring placeholders (`sport: 'running'`,
 * `intensityZone: 'aerobic'`, `keySession: false`) with values
 * inferred from real DB session metadata. Also resolves athlete
 * level from `preferences_json` (when present) so the mesocycle
 * resolver picks the right block template for the athlete.
 *
 * These helpers are deliberately pure + small so the route layer
 * stays readable. Tests assert each inference: session_type → sport
 * → intensityZone → keySession → fatigueCost.
 */

import type {
  FatigueCost,
  IntensityZone,
  RaceEvent,
  Session,
  Sport,
} from '../../services/coach-kernel/types';

export interface DbSessionRow {
  id: number;
  day_of_week: string;
  session_type: string;
  title: string;
  duration_minutes: number;
  intensity_text: string;
  status: string;
}

/** Infer the sport for a session given the `session_type` string. */
export function inferSportFromSessionType(sessionType: string, planSport: string): Sport {
  const t = (sessionType ?? '').toLowerCase();
  const p = (planSport ?? '').toLowerCase();

  // R5 P1 fix — Codex caught that `('gym', 'gym')` returned 'running'.
  // The v1 schema records gym sessions with session_type = 'gym' and
  // plan.sport = 'gym', neither of which matched the strength branch.
  // The fallback then ignored 'gym' as a plan sport and defaulted to
  // 'running'. Now: detect every strength vocabulary up front, AND
  // accept 'gym'/'strength' as plan-sport fallback values, AND keep
  // the kernel's `Sport` enum as a closed set ('running'|'cycling'|
  // 'swimming'|'strength') — 'gym' maps to 'strength'.
  if (
    t.includes('strength') ||
    t.includes('lift') ||
    t.includes('weights') ||
    t.includes('weight_') ||
    t.includes('gym') ||
    t.includes('resistance') ||
    t.includes('squat') ||
    t.includes('deadlift') ||
    t.includes('press') ||
    t.includes('mobility')
  ) return 'strength';
  if (t.includes('run') || t.startsWith('threshold_run') || t.startsWith('interval_run')) return 'running';
  if (t.includes('ride') || t.includes('bike') || t.includes('cycl')) return 'cycling';
  if (t.includes('swim')) return 'swimming';
  // Fallback to the plan's sport column when session type is generic.
  // Plan sport 'gym' is canonicalized to the kernel's 'strength' enum.
  if (p === 'gym' || p === 'strength' || p === 'weights' || p === 'lifting') return 'strength';
  if (p === 'running' || p === 'cycling' || p === 'swimming') return p;
  // Last-resort default kept as 'running' — backward-compat with the
  // pre-R5 contract. The bug Codex flagged (`('gym','gym') → 'running'`)
  // is fixed by the explicit strength branches above; this default
  // now only fires when neither session_type nor plan_sport carries
  // a recognizable token at all.
  return 'running';
}

/**
 * Infer the IntensityZone from the session_type / intensity_text.
 * The v1 schema uses `intensity_text` as a free-form string
 * ("RPE 7", "Zone 2", "80% 1RM"); v2 surfaces the canonical zone.
 */
export function inferIntensityZone(sessionType: string, intensityText: string | null): IntensityZone {
  const t = sessionType.toLowerCase();
  const i = (intensityText ?? '').toLowerCase();
  if (i.includes('zone 1') || t.includes('recovery')) return 'recovery';
  if (i.includes('zone 2') || t.includes('easy') || t.includes('aerobic') || t.includes('endurance') || t.includes('long_')) return 'aerobic';
  if (i.includes('zone 3') || t.includes('tempo')) return 'tempo';
  if (i.includes('zone 4') || t.includes('threshold')) return 'threshold';
  if (i.includes('zone 5') || t.includes('vo2') || t.includes('interval')) return 'vo2';
  if (t.includes('sprint') || t.includes('neuromuscular') || t.includes('strides')) return 'neuromuscular';
  return 'aerobic';
}

/** A session is "key" when it's a hard endurance touchpoint or a planned race. */
export function inferKeySession(sessionType: string, title: string): boolean {
  const t = sessionType.toLowerCase();
  const titleLc = title.toLowerCase();
  return (
    t.startsWith('threshold_') ||
    t.startsWith('interval_') ||
    t.startsWith('vo2_') ||
    t.startsWith('long_') ||
    t.includes('race') ||
    titleLc.includes('key') ||
    titleLc.includes('race')
  );
}

/** Map an intensity zone to a fatigue-cost band (rough proxy until A2b is universal). */
export function inferFatigueCost(zone: IntensityZone): FatigueCost {
  if (zone === 'recovery' || zone === 'aerobic') return 'low';
  if (zone === 'tempo') return 'medium';
  if (zone === 'threshold') return 'high';
  return 'very_high';
}

const DAY_NAMES: Record<string, Session['dayOfWeek']> = {
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday',
};

/**
 * Hydrate a Session object from a DB row + the plan's sport. Codex
 * R2 P1 fix — replaces hardcoded `aerobic` / `low` / `keySession:
 * false` placeholders with real inferences.
 */
export function dbRowToSession(row: DbSessionRow, planSport: string): Session {
  const sport = inferSportFromSessionType(row.session_type, planSport);
  const zone = inferIntensityZone(row.session_type, row.intensity_text);
  return {
    id: String(row.id),
    sport,
    sessionType: row.session_type as Session['sessionType'],
    title: row.title,
    description: '',
    dayOfWeek: DAY_NAMES[row.day_of_week.toLowerCase()] ?? 'monday',
    durationMinutes: row.duration_minutes ?? 60,
    intensityZone: zone,
    fatigueCost: inferFatigueCost(zone),
    keySession: inferKeySession(row.session_type, row.title),
    plannedLoad: 0,
    tags: [],
  };
}

export type AthleteLevel = 'novice' | 'intermediate' | 'advanced';

/**
 * Resolve athlete experience level from a plan's `preferences_json`.
 * When the JSON is missing OR doesn't carry an experience hint, we
 * return 'intermediate' with `inferred: true`. Codex R2 P1 — the
 * route surface must EXPOSE that the default was used; downstream
 * tests can pin the inferred flag in the response.
 */
export function resolveAthleteLevelFromPlan(
  preferencesJson: string | null,
): { level: AthleteLevel; inferred: boolean } {
  if (!preferencesJson) return { level: 'intermediate', inferred: true };
  try {
    const parsed = JSON.parse(preferencesJson) as Record<string, unknown>;
    const candidates: unknown[] = [
      parsed.experienceLevel,
      parsed.experience_level,
      parsed.athleteLevel,
      parsed.level,
    ];
    for (const c of candidates) {
      if (typeof c === 'string') {
        const lc = c.toLowerCase();
        if (lc.includes('novice') || lc.includes('beginner')) return { level: 'novice', inferred: false };
        if (lc.includes('advanced') || lc.includes('elite')) return { level: 'advanced', inferred: false };
        if (lc.includes('intermediate')) return { level: 'intermediate', inferred: false };
      }
    }
  } catch {
    /* fall through */
  }
  return { level: 'intermediate', inferred: true };
}

/**
 * R3 P3 fix — strict enum validation + count cap. Previously this
 * function accepted ANY string for `discipline` and `priority` and
 * cast it into the `RaceEvent` union, so malformed preferences
 * could reach taper logic with garbage values. Also: unbounded
 * array length could blow up the planner / response payload.
 *
 * Hard rules now:
 *   - discipline ∈ {'running'|'cycling'|'swimming'|'triathlon'}
 *   - priority   ∈ {'a'|'b'|'c'}
 *   - subtype    ∈ allowed RaceEvent subtype enum (or undefined)
 *   - raceFormat ∈ {'single'|'multisport'} (or undefined)
 *   - taperImportance ∈ {'high'|'standard'|'mini'} (or undefined)
 *   - hard cap at MAX_RACE_CALENDAR_ENTRIES rows; extras silently dropped
 *     with a debug log (intentional — better to truncate than to
 *     bloat the response or slow B3's resolver to a crawl).
 */
const ALLOWED_DISCIPLINES: ReadonlySet<RaceEvent['discipline']> = new Set([
  'running', 'cycling', 'swimming', 'triathlon',
]);
const ALLOWED_PRIORITIES: ReadonlySet<RaceEvent['priority']> = new Set(['a', 'b', 'c']);
const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set([
  '5k', '10k', 'half_marathon', 'marathon', 'sprint', 'olympic', '70.3', 'ironman',
]);
const ALLOWED_RACE_FORMATS: ReadonlySet<string> = new Set(['single', 'multisport']);
const ALLOWED_TAPER_IMPORTANCE: ReadonlySet<string> = new Set(['high', 'standard', 'mini']);
export const MAX_RACE_CALENDAR_ENTRIES = 50;

/**
 * R4 P3 — surfaced drop-reason codes. The resolver now produces a
 * companion report (see `resolveRaceCalendarFromPlanWithReport`)
 * carrying the count + reason for every dropped entry so the route
 * layer can surface them on the response and operators can debug
 * "why doesn't my race show up?" complaints.
 */
export type RaceCalendarDropReason =
  | 'invalid_entry_shape'
  | 'missing_required_field'
  | 'unknown_discipline'
  | 'unknown_priority';

export interface RaceCalendarResolveReport {
  /** Successfully parsed + enum-validated race events. */
  races: RaceEvent[];
  /** Count of entries dropped during parsing (any reason). */
  droppedCount: number;
  /** Per-reason breakdown — sums to droppedCount. */
  dropReasons: Record<RaceCalendarDropReason, number>;
  /** True if the input array was longer than the MAX cap. */
  capApplied: boolean;
  /** Number of entries silently truncated by the cap. */
  capTruncatedCount: number;
}

function emptyDropReasons(): Record<RaceCalendarDropReason, number> {
  return {
    invalid_entry_shape: 0,
    missing_required_field: 0,
    unknown_discipline: 0,
    unknown_priority: 0,
  };
}

/**
 * Resolve the race calendar AND report how many entries were dropped
 * / capped + why. Use this from any surface that wants to tell the
 * caller their input was partially accepted (R4 P3 fix). The simple
 * `resolveRaceCalendarFromPlan` delegates here and discards the
 * report for backward-compat call sites.
 */
export function resolveRaceCalendarFromPlanWithReport(
  preferencesJson: string | null,
): RaceCalendarResolveReport {
  const report: RaceCalendarResolveReport = {
    races: [],
    droppedCount: 0,
    dropReasons: emptyDropReasons(),
    capApplied: false,
    capTruncatedCount: 0,
  };
  if (!preferencesJson) return report;
  let raw: unknown;
  try {
    const parsed = JSON.parse(preferencesJson) as Record<string, unknown>;
    raw = parsed.raceCalendar;
  } catch {
    return report;
  }
  if (!Array.isArray(raw)) return report;
  if (raw.length > MAX_RACE_CALENDAR_ENTRIES) {
    report.capApplied = true;
    report.capTruncatedCount = raw.length - MAX_RACE_CALENDAR_ENTRIES;
  }
  const bounded = raw.slice(0, MAX_RACE_CALENDAR_ENTRIES);
  for (const entry of bounded) {
    if (!entry || typeof entry !== 'object') {
      report.droppedCount++;
      report.dropReasons.invalid_entry_shape++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : undefined;
    const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : undefined;
    const disciplineRaw = typeof e.discipline === 'string' ? e.discipline : undefined;
    const date = typeof e.date === 'string' && e.date.length > 0 ? e.date : undefined;
    const priorityRaw = typeof e.priority === 'string' ? e.priority : undefined;
    if (!id || !name || !disciplineRaw || !date || !priorityRaw) {
      report.droppedCount++;
      report.dropReasons.missing_required_field++;
      continue;
    }
    if (!ALLOWED_DISCIPLINES.has(disciplineRaw as RaceEvent['discipline'])) {
      report.droppedCount++;
      report.dropReasons.unknown_discipline++;
      continue;
    }
    if (!ALLOWED_PRIORITIES.has(priorityRaw as RaceEvent['priority'])) {
      report.droppedCount++;
      report.dropReasons.unknown_priority++;
      continue;
    }
    const subtype = typeof e.subtype === 'string' && ALLOWED_SUBTYPES.has(e.subtype)
      ? (e.subtype as RaceEvent['subtype'])
      : undefined;
    const taperImportance = typeof e.taperImportance === 'string' && ALLOWED_TAPER_IMPORTANCE.has(e.taperImportance)
      ? (e.taperImportance as RaceEvent['taperImportance'])
      : undefined;
    const raceFormat = typeof e.raceFormat === 'string' && ALLOWED_RACE_FORMATS.has(e.raceFormat)
      ? (e.raceFormat as RaceEvent['raceFormat'])
      : undefined;
    report.races.push({
      id,
      name,
      discipline: disciplineRaw as RaceEvent['discipline'],
      date,
      priority: priorityRaw as RaceEvent['priority'],
      subtype,
      notes: typeof e.notes === 'string' ? e.notes : undefined,
      expectedDurationSec: typeof e.expectedDurationSec === 'number' && Number.isFinite(e.expectedDurationSec) ? e.expectedDurationSec : undefined,
      taperImportance,
      recoveryDaysAfter: typeof e.recoveryDaysAfter === 'number' && Number.isFinite(e.recoveryDaysAfter) ? e.recoveryDaysAfter : undefined,
      disciplines: Array.isArray(e.disciplines)
        ? (e.disciplines as unknown[]).filter((d): d is 'running' | 'cycling' | 'swimming' =>
            d === 'running' || d === 'cycling' || d === 'swimming')
        : undefined,
      raceFormat,
    });
  }
  return report;
}

/**
 * Parse a stored RaceEvent[] from `preferences_json.raceCalendar`.
 * Empty when not present, NOT synthesized. R3 P3 — enum-validates
 * every field and caps array length at MAX_RACE_CALENDAR_ENTRIES.
 *
 * R4 P3 — delegates to `resolveRaceCalendarFromPlanWithReport` so the
 * drop accounting is identical across surfaces. Use the *WithReport
 * variant whenever you want to surface drops to the caller; this
 * thin wrapper exists for legacy call sites that don't care.
 */
export function resolveRaceCalendarFromPlan(preferencesJson: string | null): RaceEvent[] {
  return resolveRaceCalendarFromPlanWithReport(preferencesJson).races;
}
