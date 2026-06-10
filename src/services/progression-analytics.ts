// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Progression Analytics — Phase 4 Slice D
 *
 * Extracts longitudinal strength progression from the user's logged
 * session completions. Turns a pile of `actual_exercises_json` blobs
 * into a trajectory per main lift (Back Squat, Bench Press, Deadlift,
 * Overhead Press): start estimate, current estimate, delta, trend.
 *
 * The coach reads this via an `<athlete_progression>` context block so
 * its prescriptions have memory. Instead of "here's this week's squat
 * session", the coach can say "your squat has gone 140 → 152.5kg over
 * 8 weeks — keep the progression" or "you've been stuck at 100kg on
 * bench for 3 weeks, let's add a variation".
 *
 * ZERO LLM calls. Pure SQL read + in-memory parsing + math. Runs on
 * every training tab open (cached briefly), and is injected into
 * coach context on every triathlon message.
 *
 * Data source: `training_completions.actual_exercises_json`. This is
 * LLM-generated JSON from the `log_training_completion` tool, so the
 * parser is defensive — it handles multiple shapes (array, nested
 * sets, flat set, weight vs weight_kg, etc.) and silently skips
 * anything it can't make sense of. The goal is best-effort
 * extraction, not strict validation.
 */

import { getDb } from './database';
import { now } from '../utils/date-parser';
import { DateTime } from 'luxon';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

// ─── Types ──────────────────────────────────────────────────────

/** A canonical lift name — normalized from whatever the user typed. */
export type CanonicalLift =
  | 'Back Squat'
  | 'Front Squat'
  | 'Bench Press'
  | 'Deadlift'
  | 'Overhead Press';

/** One (completion, lift) data point after normalization. */
export interface StrengthDataPoint {
  /** ISO date (YYYY-MM-DD) of the completion. */
  date: string;
  lift: CanonicalLift;
  /** Heaviest weight used in any set of this lift in the completion. */
  weightKg: number;
  /** Rep count at that heaviest weight. */
  reps: number;
  /** Epley-formula 1RM estimate (kg). Rounded to 1 decimal. */
  estimatedOneRm: number;
}

/**
 * Trajectory across the window for a single lift. `null` fields
 * indicate insufficient data — fewer than 2 data points means no
 * trend can be computed.
 */
export interface LiftProgression {
  lift: CanonicalLift;
  dataPoints: StrengthDataPoint[];
  startOneRm: number | null;
  currentOneRm: number | null;
  deltaKg: number | null;
  deltaPct: number | null;
  /**
   * Trend classification:
   *  - `up`               → current > start by more than 2.5%
   *  - `down`             → current < start by more than 2.5%
   *  - `flat`             → within 2.5% band
   *  - `insufficient_data`→ fewer than 2 data points
   */
  trend: 'up' | 'down' | 'flat' | 'insufficient_data';
}

export interface StrengthProgressionReport {
  userId: number;
  windowWeeks: number;
  /** ISO 8601 timestamp of the window start (inclusive). */
  windowStart: string;
  /** Only lifts with at least one data point are included. */
  lifts: LiftProgression[];
}

// ─── Lift name normalization ────────────────────────────────────

/**
 * Map a user-typed exercise name to a canonical lift, or null if
 * the exercise isn't one of the tracked main lifts. The matcher is
 * case-insensitive and tolerates common prefixes/suffixes:
 *
 *   "back squat", "Back Squat", "BB Back Squat" → "Back Squat"
 *   "front squat"                                → "Front Squat"
 *   "bench press", "bench", "flat bench"         → "Bench Press"
 *   "deadlift", "conventional deadlift", "DL"    → "Deadlift"
 *   "OHP", "overhead press", "military press"    → "Overhead Press"
 *
 * Accessories and variations (goblet squat, incline bench, RDL,
 * push press, etc.) are intentionally EXCLUDED — they're not main
 * lifts and their progression curves look different. Track them in
 * a future slice if needed.
 */
export function normalizeLiftName(raw: string): CanonicalLift | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.toLowerCase().trim();

  // Squat variants. The `\bsquats?\b` alternation catches both
  // singular and plural forms — `\bsquat\b` alone misses "squats"
  // because the trailing `s` breaks the word boundary.
  if (/\bsquats?\b/.test(s)) {
    // Exclude accessory variants we're not tracking as main lifts.
    if (/goblet|bulgarian|split|pistol|hack|zercher|box/.test(s)) return null;
    if (/\bfront\b/.test(s)) return 'Front Squat';
    // Everything else maps to Back Squat: explicit back/BB/low-bar,
    // bare "squat"/"squats", or any non-excluded variant.
    return 'Back Squat';
  }

  // Bench variants
  if (/\bbench\b/.test(s)) {
    // Exclude variations that aren't flat barbell bench
    if (/incline|decline|close[- ]?grip|dumbbell|db\b|floor|spoto|larsen/.test(s)) return null;
    return 'Bench Press';
  }

  // Deadlift variants
  if (/\bdeadlift\b|\bdeadlifts\b|\bdl\b/.test(s)) {
    // Exclude variations
    if (/romanian|rdl|stiff[- ]?leg|deficit|sumo|trap[- ]?bar|snatch[- ]?grip|rack pull/.test(s)) return null;
    return 'Deadlift';
  }

  // Overhead press variants
  if (/\bohp\b|overhead press|military press|strict press/.test(s)) {
    // Exclude push press (different lift — leg drive)
    if (/push press|jerk/.test(s)) return null;
    return 'Overhead Press';
  }

  return null;
}

// ─── 1RM estimation ─────────────────────────────────────────────

/**
 * Epley-formula 1RM estimate.
 *
 *   1RM = weight × (1 + reps/30)
 *
 * Accurate for reps ≤ 10. For reps > 10 the estimate drifts high
 * and most practitioners refuse to trust it. Callers should filter
 * to reps ≤ 10 before calling.
 *
 * Returns the estimate rounded to 1 decimal for display stability.
 */
export function estimateOneRm(weightKg: number, reps: number): number {
  if (weightKg <= 0 || reps <= 0) return 0;
  if (reps === 1) return Number(weightKg.toFixed(1));
  const estimate = weightKg * (1 + reps / 30);
  return Number(estimate.toFixed(1));
}

// ─── JSON parsing ───────────────────────────────────────────────

/**
 * Safely unwrap an `actual_exercises_json` blob into an array of
 * exercise entries. Accepts several shapes the LLM tends to emit:
 *
 *   - An array of exercises: [{name, sets, reps, weight}, ...]
 *   - A single exercise object: {name, sets, reps, weight}
 *   - Nested sets: {name, sets: [{weight, reps}, ...]}
 *   - String (returns empty — user typed free-form notes, not JSON)
 *
 * Returns an empty array for anything unparseable — we never throw.
 */
function parseExercisesJson(raw: string | null): unknown[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

/**
 * From one exercise entry, find the heaviest (weight, reps) pair.
 * Handles three shapes:
 *
 *   1. Flat:  { weight: 140, reps: 5, sets: 3 }       → 140kg × 5
 *   2. Array: { sets: [{weight: 140, reps: 5}, ...] } → max by 1RM
 *   3. Top-level weight_kg alias: { weight_kg: 140, reps: 5 }
 *
 * Also filters out reps > 10 since Epley is unreliable there.
 */
function extractHeaviestSet(entry: unknown): { weightKg: number; reps: number } | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  // Shape 3: nested sets array with per-set weights
  if (Array.isArray(e.sets)) {
    let best: { weightKg: number; reps: number; oneRm: number } | null = null;
    for (const set of e.sets) {
      if (!set || typeof set !== 'object') continue;
      const s = set as Record<string, unknown>;
      const weightKg = extractNumber(s.weight ?? s.weight_kg ?? s.kg);
      const reps = extractNumber(s.reps);
      if (weightKg == null || reps == null) continue;
      if (weightKg <= 0 || reps <= 0 || reps > 10) continue;
      const oneRm = estimateOneRm(weightKg, reps);
      if (!best || oneRm > best.oneRm) {
        best = { weightKg, reps, oneRm };
      }
    }
    return best ? { weightKg: best.weightKg, reps: best.reps } : null;
  }

  // Shape 1 & 2: flat entry with a single weight+reps pair
  const weightKg = extractNumber(e.weight ?? e.weight_kg ?? e.kg);
  const reps = extractNumber(e.reps);
  if (weightKg == null || reps == null) return null;
  if (weightKg <= 0 || reps <= 0 || reps > 10) return null;
  return { weightKg, reps };
}

/** Coerce a mixed JSON value into a finite number, or null. */
function extractNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── Data extraction ────────────────────────────────────────────

interface CompletionRow {
  completed_at: string;
  actual_exercises_json: string | null;
}

/**
 * Walk the user's training_completions inside the window and emit
 * one `StrengthDataPoint` per (completion × tracked lift). Within a
 * single completion the heaviest set per lift wins — so a completion
 * with 5 squat sets produces exactly one Back Squat data point.
 */
export function extractStrengthDataPoints(
  userId: number,
  tenantId: number,
  windowWeeks: number,
  referenceDate?: DateTime,
): StrengthDataPoint[] {
  const scopedTenantId = requireTenantIdParam(tenantId, 'extractStrengthDataPoints');
  const ref = referenceDate ?? now();
  const windowStart = ref.minus({ weeks: windowWeeks }).startOf('day').toISO()!;
  const db = getDb();

  let rows: CompletionRow[] = [];
  try {
    rows = db.prepare(`
      SELECT tc.completed_at, tc.actual_exercises_json
      FROM training_completions tc
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ? AND ftp.tenant_id = ?
        AND tc.completed_at >= ?
      ORDER BY tc.completed_at ASC
    `).all(userId, scopedTenantId, windowStart) as CompletionRow[];
  } catch (err) {
    logger.debug({ err, userId, tenantId: scopedTenantId }, 'strength progression query failed — returning empty set');
    return [];
  }

  const dataPoints: StrengthDataPoint[] = [];

  for (const row of rows) {
    const exercises = parseExercisesJson(row.actual_exercises_json);
    if (exercises.length === 0) continue;

    // Pick the best set per canonical lift within this completion.
    // A session might have both Back Squat and Front Squat entries —
    // each produces its own data point.
    const bestByLift = new Map<CanonicalLift, { weightKg: number; reps: number; oneRm: number }>();

    for (const entry of exercises) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const rawName = typeof e.name === 'string' ? e.name : typeof e.exercise === 'string' ? e.exercise : null;
      if (!rawName) continue;
      const lift = normalizeLiftName(rawName);
      if (!lift) continue;

      const heaviest = extractHeaviestSet(entry);
      if (!heaviest) continue;
      const oneRm = estimateOneRm(heaviest.weightKg, heaviest.reps);
      if (oneRm <= 0) continue;

      const existing = bestByLift.get(lift);
      if (!existing || oneRm > existing.oneRm) {
        bestByLift.set(lift, { ...heaviest, oneRm });
      }
    }

    // Emit one data point per lift that the completion touched.
    const date = row.completed_at.slice(0, 10); // YYYY-MM-DD
    for (const [lift, best] of bestByLift) {
      dataPoints.push({
        date,
        lift,
        weightKg: best.weightKg,
        reps: best.reps,
        estimatedOneRm: best.oneRm,
      });
    }
  }

  return dataPoints;
}

// ─── Aggregation ────────────────────────────────────────────────

/**
 * Tracked main lifts — always in this order when emitted. The report
 * includes every lift that has at least one data point; insufficient
 * coverage produces a `trend: 'insufficient_data'` entry rather than
 * omitting the lift entirely (the coach still learns the user doesn't
 * train that movement).
 */
const TRACKED_LIFTS: CanonicalLift[] = [
  'Back Squat',
  'Front Squat',
  'Bench Press',
  'Deadlift',
  'Overhead Press',
];

const TREND_BAND_PCT = 2.5;

/**
 * Build the full strength progression report over the given window
 * (defaults to 8 weeks). Groups data points by lift, computes
 * start/current/delta/trend per lift, and returns lifts that have
 * any activity in the window.
 */
export function getStrengthProgression(
  userId: number,
  tenantId: number,
  windowWeeks: number = 8,
  referenceDate?: DateTime,
): StrengthProgressionReport {
  const scopedTenantId = requireTenantIdParam(tenantId, 'getStrengthProgression');
  const ref = referenceDate ?? now();
  const windowStart = ref.minus({ weeks: windowWeeks }).startOf('day').toISO()!;
  const dataPoints = extractStrengthDataPoints(userId, scopedTenantId, windowWeeks, ref);

  // Group by lift, preserving date-ascending order from extraction.
  const byLift = new Map<CanonicalLift, StrengthDataPoint[]>();
  for (const dp of dataPoints) {
    const arr = byLift.get(dp.lift) ?? [];
    arr.push(dp);
    byLift.set(dp.lift, arr);
  }

  const lifts: LiftProgression[] = [];
  for (const lift of TRACKED_LIFTS) {
    const points = byLift.get(lift);
    if (!points || points.length === 0) continue;

    if (points.length < 2) {
      lifts.push({
        lift,
        dataPoints: points,
        startOneRm: points[0].estimatedOneRm,
        currentOneRm: points[0].estimatedOneRm,
        deltaKg: null,
        deltaPct: null,
        trend: 'insufficient_data',
      });
      continue;
    }

    const startOneRm = points[0].estimatedOneRm;
    const currentOneRm = points[points.length - 1].estimatedOneRm;
    const deltaKg = Number((currentOneRm - startOneRm).toFixed(1));
    const deltaPct = startOneRm > 0
      ? Number(((deltaKg / startOneRm) * 100).toFixed(1))
      : 0;

    let trend: 'up' | 'down' | 'flat';
    if (deltaPct > TREND_BAND_PCT) trend = 'up';
    else if (deltaPct < -TREND_BAND_PCT) trend = 'down';
    else trend = 'flat';

    lifts.push({
      lift,
      dataPoints: points,
      startOneRm,
      currentOneRm,
      deltaKg,
      deltaPct,
      trend,
    });
  }

  return {
    userId,
    windowWeeks,
    windowStart,
    lifts,
  };
}

// ─── Prompt formatting ──────────────────────────────────────────

/**
 * Format a strength progression report as an `<athlete_progression>`
 * block for the triathlon coach state context. Returns empty string
 * when there's nothing to show so the caller can conditionally
 * prepend without adding whitespace.
 *
 * Example output:
 *
 *   <athlete_progression window_weeks="8">
 *   Past 8 weeks of strength training:
 *   - Back Squat: 140kg → 152.5kg (+12.5kg, +9%), trending UP
 *   - Bench Press: 100kg → 102.5kg (+2.5kg, +2.5%), FLAT
 *   - Deadlift: 180kg → 180kg (0kg, 0%), FLAT — 3 sessions without PR
 *   </athlete_progression>
 */
export function formatStrengthProgressionForPrompt(report: StrengthProgressionReport): string {
  if (report.lifts.length === 0) return '';
  const lines: string[] = [];
  lines.push(`<athlete_progression window_weeks="${report.windowWeeks}">`);
  lines.push(`Past ${report.windowWeeks} weeks of strength training:`);

  for (const lift of report.lifts) {
    if (lift.trend === 'insufficient_data') {
      lines.push(`- ${lift.lift}: one session only — insufficient data for a trend.`);
      continue;
    }
    const deltaSign = (lift.deltaKg ?? 0) >= 0 ? '+' : '';
    const pctSign = (lift.deltaPct ?? 0) >= 0 ? '+' : '';
    const trendLabel = lift.trend.toUpperCase();
    lines.push(
      `- ${lift.lift}: ${lift.startOneRm}kg → ${lift.currentOneRm}kg (${deltaSign}${lift.deltaKg}kg, ${pctSign}${lift.deltaPct}%), trending ${trendLabel}`,
    );
  }

  lines.push('</athlete_progression>');
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
// Phase 4 Slice F — Cardio progression (running + cycling)
// ══════════════════════════════════════════════════════════════

/** Sports the cardio extractor understands. */
export type CardioSport = 'running' | 'cycling';

/**
 * One week of cardio activity. Emitted by the aggregator, not stored.
 * `durationMin` is always available (from `training_completions.duration_minutes`).
 * `distanceKm` is parsed from `actual_exercises_json` and may be 0 if
 * the user didn't log it structurally.
 */
export interface WeeklyCardioMetric {
  /** ISO date (YYYY-MM-DD) of the Monday that starts the week. */
  weekStart: string;
  /** Total km for the week across all sessions (0 if not logged). */
  distanceKm: number;
  /** Total minutes for the week (from training_completions.duration_minutes). */
  durationMin: number;
  /** Session count (distinct completions in the week). */
  sessions: number;
  /** Longest single session distance in km (0 if none logged). */
  longestKm: number;
}

/**
 * Full cardio progression report — one sport, multiple weeks.
 * Mirrors the shape of `StrengthProgressionReport` but with
 * aggregate-per-week metrics rather than per-lift trajectories.
 */
export interface CardioProgressionReport {
  userId: number;
  sport: CardioSport;
  windowWeeks: number;
  windowStart: string;
  /** One entry per ISO week in the window, newest last. Empty weeks omitted. */
  weeks: WeeklyCardioMetric[];
  /** First-week total km. Null when fewer than 2 weeks of data. */
  startWeeklyKm: number | null;
  /** Last-week total km. Null when no data. */
  currentWeeklyKm: number | null;
  /** Week-over-window delta in km (current − start). Null if < 2 weeks. */
  deltaKm: number | null;
  /** Percent change relative to start. Null if start is 0 or < 2 weeks. */
  deltaPct: number | null;
  /** Total km across the window. */
  totalKm: number;
  /** Total minutes across the window. */
  totalDurationMin: number;
  /** Total sessions across the window. */
  totalSessions: number;
  /**
   * Trend classification using the same ±2.5% band as strength.
   * `insufficient_data` fires when fewer than 2 weeks have any activity.
   */
  trend: 'up' | 'down' | 'flat' | 'insufficient_data';
}

// ─── Raw row types ──────────────────────────────────────────────

interface CardioCompletionRow {
  completed_at: string;
  duration_minutes: number | null;
  actual_exercises_json: string | null;
  session_type: string;
}

/**
 * Normalize a raw `session_type` value to the cardio sport bucket it
 * belongs to, or null if the session isn't a cardio activity.
 * Mirrors the mapping in session-analytics.ts but returns only the
 * two sports this module cares about.
 */
function cardioSportFromSessionType(sessionType: string): CardioSport | null {
  const t = sessionType.toLowerCase().trim();
  if (['running', 'run', 'jog'].includes(t)) return 'running';
  if (['cycling', 'cycle', 'bike', 'ride'].includes(t)) return 'cycling';
  return null;
}

/**
 * Parse `actual_exercises_json` and extract the best-effort distance
 * in km for the entry. Supports several shapes:
 *
 *   1. { distance_km: 10 }
 *   2. { distance: 10, unit: 'km' }
 *   3. { distance: 10000, unit: 'm' }
 *   4. [{ distance_km: 10, ... }]  ← array-wrapped
 *   5. { metrics: { distance_km: 10 } }  ← nested under metrics key
 *
 * Returns 0 when no distance can be found — callers should treat 0
 * as "unlogged" rather than "ran zero".
 */
function extractCardioDistanceKm(rawJson: string | null): number {
  if (!rawJson) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return 0;
  }

  // Flatten to a list of candidate objects we can probe.
  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) {
    candidates.push(...parsed);
  } else if (parsed && typeof parsed === 'object') {
    candidates.push(parsed);
    // Also probe a nested `metrics` object if present
    const maybeMetrics = (parsed as Record<string, unknown>).metrics;
    if (maybeMetrics && typeof maybeMetrics === 'object') {
      candidates.push(maybeMetrics);
    }
  }

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;

    // Direct distance_km key (preferred)
    const directKm = extractNumber(obj.distance_km ?? obj.distanceKm ?? obj.km);
    if (directKm != null && directKm > 0) return directKm;

    // distance + unit fallback
    const distance = extractNumber(obj.distance);
    if (distance != null && distance > 0) {
      const unit = typeof obj.unit === 'string' ? obj.unit.toLowerCase() : 'km';
      if (unit === 'm' || unit === 'meters' || unit === 'metres') {
        return distance / 1000;
      }
      if (unit === 'mi' || unit === 'miles' || unit === 'mile') {
        return distance * 1.609344;
      }
      // Default to km if unit is unknown but distance looks plausible
      return distance;
    }
  }

  return 0;
}

/**
 * Extract cardio data points for the user's completions within the
 * window. Each completion produces AT MOST one data point per
 * (sport, date) combination — a completion that logs both a bike
 * and a brick run would produce two points. Session type is the
 * primary sport filter; the caller passes the sport they want.
 */
export function extractCardioDataPoints(
  userId: number,
  tenantId: number,
  sport: CardioSport,
  windowWeeks: number,
  referenceDate?: DateTime,
): Array<{ date: string; distanceKm: number; durationMin: number }> {
  const scopedTenantId = requireTenantIdParam(tenantId, 'extractCardioDataPoints');
  const ref = referenceDate ?? now();
  const windowStart = ref.minus({ weeks: windowWeeks }).startOf('day').toISO()!;
  const db = getDb();

  let rows: CardioCompletionRow[] = [];
  try {
    rows = db.prepare(`
      SELECT tc.completed_at, tc.duration_minutes, tc.actual_exercises_json, ts.session_type
      FROM training_completions tc
      JOIN training_sessions ts ON ts.id = tc.session_id
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ? AND ftp.tenant_id = ?
        AND tc.completed_at >= ?
      ORDER BY tc.completed_at ASC
    `).all(userId, scopedTenantId, windowStart) as CardioCompletionRow[];
  } catch (err) {
    logger.debug({ err, userId, tenantId: scopedTenantId, sport }, 'cardio progression query failed');
    return [];
  }

  const dataPoints: Array<{ date: string; distanceKm: number; durationMin: number }> = [];

  for (const row of rows) {
    if (cardioSportFromSessionType(row.session_type) !== sport) continue;

    const distanceKm = extractCardioDistanceKm(row.actual_exercises_json);
    const durationMin = row.duration_minutes ?? 0;

    // Skip rows with neither distance nor duration — nothing to aggregate
    if (distanceKm <= 0 && durationMin <= 0) continue;

    dataPoints.push({
      date: row.completed_at.slice(0, 10), // YYYY-MM-DD
      distanceKm,
      durationMin,
    });
  }

  return dataPoints;
}

/**
 * Aggregate cardio data points into weekly buckets. Returns
 * newest-last, ISO-week-keyed metrics. Weeks with no activity are
 * omitted from the output.
 */
function aggregateByWeek(
  dataPoints: Array<{ date: string; distanceKm: number; durationMin: number }>,
): WeeklyCardioMetric[] {
  const buckets = new Map<string, WeeklyCardioMetric>();

  for (const dp of dataPoints) {
    const dt = DateTime.fromFormat(dp.date, 'yyyy-LL-dd');
    if (!dt.isValid) continue;
    const weekStart = dt.startOf('week').toFormat('yyyy-LL-dd');

    const existing = buckets.get(weekStart);
    if (existing) {
      existing.distanceKm = Number((existing.distanceKm + dp.distanceKm).toFixed(2));
      existing.durationMin += dp.durationMin;
      existing.sessions += 1;
      if (dp.distanceKm > existing.longestKm) {
        existing.longestKm = Number(dp.distanceKm.toFixed(2));
      }
    } else {
      buckets.set(weekStart, {
        weekStart,
        distanceKm: Number(dp.distanceKm.toFixed(2)),
        durationMin: dp.durationMin,
        sessions: 1,
        longestKm: Number(dp.distanceKm.toFixed(2)),
      });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Build the cardio progression report for a user + sport. Handles
 * empty state, single-week state, and multi-week trend classification
 * using the same ±2.5% band as strength progression.
 */
export function getCardioProgression(
  userId: number,
  tenantId: number,
  sport: CardioSport,
  windowWeeks: number = 8,
  referenceDate?: DateTime,
): CardioProgressionReport {
  const scopedTenantId = requireTenantIdParam(tenantId, 'getCardioProgression');
  const ref = referenceDate ?? now();
  const windowStart = ref.minus({ weeks: windowWeeks }).startOf('day').toISO()!;

  const dataPoints = extractCardioDataPoints(userId, scopedTenantId, sport, windowWeeks, ref);
  const weeks = aggregateByWeek(dataPoints);

  const totalKm = Number(
    weeks.reduce((s, w) => s + w.distanceKm, 0).toFixed(2),
  );
  const totalDurationMin = weeks.reduce((s, w) => s + w.durationMin, 0);
  const totalSessions = weeks.reduce((s, w) => s + w.sessions, 0);

  // Trend: compare first week vs last week of the aggregation.
  // Insufficient data when fewer than 2 weeks have activity OR when
  // the first week's distance is 0 (can't compute percentage).
  let startWeeklyKm: number | null = null;
  let currentWeeklyKm: number | null = null;
  let deltaKm: number | null = null;
  let deltaPct: number | null = null;
  let trend: CardioProgressionReport['trend'];

  if (weeks.length >= 2) {
    startWeeklyKm = weeks[0].distanceKm;
    currentWeeklyKm = weeks[weeks.length - 1].distanceKm;
    deltaKm = Number((currentWeeklyKm - startWeeklyKm).toFixed(2));

    if (startWeeklyKm > 0) {
      deltaPct = Number(((deltaKm / startWeeklyKm) * 100).toFixed(1));
      if (deltaPct > TREND_BAND_PCT) trend = 'up';
      else if (deltaPct < -TREND_BAND_PCT) trend = 'down';
      else trend = 'flat';
    } else {
      // Start week had no distance (maybe duration-only) — fall back
      // to duration trend if available.
      const startMin = weeks[0].durationMin;
      const currentMin = weeks[weeks.length - 1].durationMin;
      if (startMin > 0) {
        const durationDeltaPct = ((currentMin - startMin) / startMin) * 100;
        if (durationDeltaPct > TREND_BAND_PCT) trend = 'up';
        else if (durationDeltaPct < -TREND_BAND_PCT) trend = 'down';
        else trend = 'flat';
      } else {
        trend = 'insufficient_data';
      }
    }
  } else if (weeks.length === 1) {
    startWeeklyKm = weeks[0].distanceKm;
    currentWeeklyKm = weeks[0].distanceKm;
    trend = 'insufficient_data';
  } else {
    trend = 'insufficient_data';
  }

  return {
    userId,
    sport,
    windowWeeks,
    windowStart,
    weeks,
    startWeeklyKm,
    currentWeeklyKm,
    deltaKm,
    deltaPct,
    totalKm,
    totalDurationMin,
    totalSessions,
    trend,
  };
}

/**
 * Format a cardio progression report as lines for the triathlon
 * coach state context. Returns empty string when there's nothing
 * to show. Callers stitch multiple sports together inside the
 * same `<athlete_progression>` block.
 *
 * Example for running with 8 weeks of data:
 *
 *   Running — past 8 weeks:
 *   - Total: 240km across 40 sessions (26h 15m)
 *   - Weekly km: 25km → 38km (+13km, +52%), trending UP
 *   - Longest run: 18km
 */
export function formatCardioProgressionForPrompt(report: CardioProgressionReport): string {
  if (report.weeks.length === 0) return '';
  const sportLabel = report.sport === 'running' ? 'Running' : 'Cycling';
  const lines: string[] = [];
  lines.push(`${sportLabel} — past ${report.windowWeeks} weeks:`);

  const hours = Math.floor(report.totalDurationMin / 60);
  const minutes = report.totalDurationMin % 60;
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  lines.push(
    `- Total: ${report.totalKm}km across ${report.totalSessions} sessions (${durationLabel})`,
  );

  if (report.trend === 'insufficient_data' || report.deltaKm == null) {
    lines.push('- Weekly km: not enough weeks for a trend yet.');
  } else {
    const deltaSign = report.deltaKm >= 0 ? '+' : '';
    const pctSign = (report.deltaPct ?? 0) >= 0 ? '+' : '';
    const trendLabel = report.trend.toUpperCase();
    lines.push(
      `- Weekly km: ${report.startWeeklyKm}km → ${report.currentWeeklyKm}km (${deltaSign}${report.deltaKm}km, ${pctSign}${report.deltaPct}%), trending ${trendLabel}`,
    );
  }

  const longest = Math.max(...report.weeks.map((w) => w.longestKm));
  if (longest > 0) {
    lines.push(`- Longest session: ${longest}km`);
  }

  return lines.join('\n');
}
