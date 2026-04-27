// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training History — slice 4.E.
 *
 * Closes Phase 0 audit Layer-8 finding (Critical: blocks credible
 * long-term coaching). Pre-slice the engine never read real
 * `training_completions` rows at plan generation time;
 * `tailored4WeekMinutesBySport` was four copies of one synthesized
 * value, making ACWR (acute:chronic workload ratio) comparisons
 * mathematically meaningless — the engine couldn't detect plateau,
 * under-recovery, or progression.
 *
 * This module reads the user's actual completion log per-sport per-
 * week for the trailing 4 weeks (and the current week) and produces
 * the same `TrainingHistory` shape the planner already consumes.
 * When real data is present for a sport it overrides the synthesized
 * value; when no completions exist (brand-new user) the caller falls
 * back to the synthesized fallback already in place.
 *
 * Contract:
 *
 *   - PURE READ. Never writes to the DB.
 *   - Scoped to (user_id, completed_at) — won't bleed across users
 *     even if a stale plan_id slipped through somewhere else.
 *   - Maps `training_sessions.session_type` → canonical sport via
 *     the same vocabulary the rest of the engine uses (see
 *     `normalizeSessionTypeToSport`).
 *   - Returns `undefined` per sport when no completions exist for
 *     that sport. The caller distinguishes "no real data" (fall back
 *     to synthesis) from "0 minutes" (genuinely no training, e.g.
 *     a deload week recorded as completed-but-zero — we treat that
 *     as 0, not undefined, so the planner can see it).
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { Sport } from './coach-kernel/types';

export interface TrainingHistoryReadOptions {
  /**
   * Anchor date for the "now" boundary. Defaults to the current
   * server clock. Tests pass a fixed date for determinism.
   */
  asOf?: Date;
}

export interface RealTrainingHistory {
  /**
   * Most-recent completed week's minutes per sport. `undefined` =
   * no completions in that week for that sport. The current week
   * (week 0) is index `lastWeekMinutesBySport`.
   */
  lastWeekMinutesBySport: {
    running?: number;
    strength?: number;
    cycling?: number;
    swimming?: number;
  };
  /**
   * Trailing 4-week series per sport, OLDEST FIRST. Length is always
   * 4 when the sport has any data; weeks with no completions are
   * returned as 0 (not undefined) so the planner sees the actual
   * pattern (e.g. one heavy week + 3 zero weeks for an untrained
   * user starting cycling).
   *
   * `undefined` for the entire sport = no completions ever in the
   * window — caller falls back to synthesis.
   */
  trailing4WeekMinutesBySport: {
    running?: number[];
    strength?: number[];
    cycling?: number[];
    swimming?: number[];
  };
  /**
   * Hint flags for the caller. Useful for log lines and downstream
   * "first plan vs. recurring user" branches without the caller
   * having to inspect the per-sport dictionaries.
   */
  hasAnyHistory: boolean;
  rawCompletionCount: number;
}

const SPORTS: ReadonlyArray<Sport> = ['running', 'strength', 'cycling', 'swimming'];

/**
 * Normalize a `training_sessions.session_type` value into the
 * canonical 4-sport enum. The same mapping table is used elsewhere
 * (see `session-analytics.ts > normalizeSessionTypeToSport`); we
 * re-implement here narrowly so this module has no upstream
 * dependency on analytics.
 *
 * `null` return = unknown sport (likely 'rest' / 'mobility' / a
 * legacy free-text value); the caller drops these from the
 * aggregation rather than guessing.
 */
function normalizeSessionTypeToSport(sessionType: string | null | undefined): Sport | null {
  if (!sessionType) return null;
  const value = sessionType.toLowerCase().trim();
  if (['gym', 'strength', 'lifting', 'weights', 'weight'].includes(value)) return 'strength';
  if (['run', 'running', 'corrida', 'easy_run', 'long_run', 'threshold_run', 'interval_run', 'recovery_run', 'brick'].includes(value)) return 'running';
  if (['ride', 'bike', 'biking', 'cycle', 'cycling', 'ciclismo', 'pedal',
       'endurance_ride', 'tempo_ride', 'threshold_ride', 'vo2_ride', 'recovery_ride'].includes(value)) return 'cycling';
  if (['swim', 'swimming', 'natacao', 'natação',
       'technique_swim', 'aerobic_swim', 'threshold_swim', 'speed_swim', 'recovery_swim'].includes(value)) return 'swimming';
  if (['strength_hypertrophy', 'strength_max', 'strength_maintenance'].includes(value)) return 'strength';
  return null;
}

/**
 * Compute a date string in ISO YYYY-MM-DD form, N days before
 * `from`. Used to build the inclusive [windowStart, asOf) bounds.
 * Day boundaries align to UTC; we never reason about user
 * timezones here because `completed_at` itself is recorded in UTC.
 */
function isoDateNDaysBefore(from: Date, days: number): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Read real per-sport per-week training history for a user.
 *
 * Window is the last 4 calendar weeks (28 days) ending at `asOf`.
 * Bucketing is by 7-day rolling windows from `asOf` going back, so:
 *   - week 0 (lastWeek): asOf-7 days < completed_at <= asOf
 *   - week 1: asOf-14 < completed_at <= asOf-7
 *   - week 2, week 3 similarly
 *
 * The returned `trailing4WeekMinutesBySport` is OLDEST FIRST, so:
 *   `[week3, week2, week1, week0]`
 * matching the existing `buildTrailingSeries` convention.
 */
export function readTrainingHistoryFromCompletions(
  userId: number,
  options: TrainingHistoryReadOptions = {},
): RealTrainingHistory {
  const asOf = options.asOf ?? new Date();
  const windowStart = isoDateNDaysBefore(asOf, 28);

  const db = getDb();

  // Single query joins completion → session → plan to get the
  // (sport, completed_at, duration) tuple per row, scoped to the
  // user via the plan's user_id. Plan FK CASCADE means cancelled
  // plans don't appear here (their completions were cascaded
  // away), which is the right behavior — they're historical
  // residue, not coaching signal.
  let rows: Array<{ session_type: string | null; completed_at: string; duration_minutes: number | null }> = [];
  try {
    rows = db.prepare(`
      SELECT ts.session_type AS session_type,
             tc.completed_at AS completed_at,
             COALESCE(tc.duration_minutes, ts.duration_minutes, 0) AS duration_minutes
      FROM training_completions tc
      JOIN training_sessions ts ON ts.id = tc.session_id
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ?
        AND tc.completed_at >= ?
        AND tc.completed_at < ?
      ORDER BY tc.completed_at ASC
    `).all(
      userId,
      windowStart,
      asOf.toISOString(),
    ) as typeof rows;
  } catch (err) {
    logger.warn(
      { err, userId },
      'readTrainingHistoryFromCompletions: query failed; falling back to no-history',
    );
    return emptyHistory();
  }

  if (rows.length === 0) {
    return emptyHistory();
  }

  // Build per-sport per-week-bucket sums.
  const perSportPerWeek: Record<Sport, [number, number, number, number]> = {
    running: [0, 0, 0, 0],
    strength: [0, 0, 0, 0],
    cycling: [0, 0, 0, 0],
    swimming: [0, 0, 0, 0],
  };
  const perSportHasAny: Record<Sport, boolean> = {
    running: false,
    strength: false,
    cycling: false,
    swimming: false,
  };

  for (const row of rows) {
    const sport = normalizeSessionTypeToSport(row.session_type);
    if (!sport) continue;
    const weekIndex = bucketWeekIndex(row.completed_at, asOf);
    if (weekIndex < 0 || weekIndex > 3) continue;
    const minutes = Math.max(0, Math.round(row.duration_minutes ?? 0));
    perSportPerWeek[sport][weekIndex] += minutes;
    perSportHasAny[sport] = true;
  }

  const trailing4WeekMinutesBySport: RealTrainingHistory['trailing4WeekMinutesBySport'] = {};
  const lastWeekMinutesBySport: RealTrainingHistory['lastWeekMinutesBySport'] = {};
  for (const sport of SPORTS) {
    if (!perSportHasAny[sport]) continue;
    // perSportPerWeek[sport] is [week0(latest), week1, week2, week3(oldest)]
    // We want OLDEST FIRST: [week3, week2, week1, week0].
    const series = [
      perSportPerWeek[sport][3],
      perSportPerWeek[sport][2],
      perSportPerWeek[sport][1],
      perSportPerWeek[sport][0],
    ];
    trailing4WeekMinutesBySport[sport] = series;
    lastWeekMinutesBySport[sport] = series[3]; // most-recent (week 0)
  }

  return {
    lastWeekMinutesBySport,
    trailing4WeekMinutesBySport,
    hasAnyHistory: SPORTS.some((s) => perSportHasAny[s]),
    rawCompletionCount: rows.length,
  };
}

/**
 * Bucket a `completed_at` ISO timestamp into one of 4 week buckets
 * relative to `asOf`. Bucket 0 = most recent 7 days. Returns -1
 * for timestamps outside the 28-day window (defensive — the SQL
 * already filters them, but we re-check at the row level).
 */
function bucketWeekIndex(completedAtIso: string, asOf: Date): number {
  const completedAt = new Date(completedAtIso);
  const deltaMs = asOf.getTime() - completedAt.getTime();
  const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
  if (deltaDays < 0) return -1;
  if (deltaDays >= 28) return -1;
  return Math.floor(deltaDays / 7);
}

function emptyHistory(): RealTrainingHistory {
  return {
    lastWeekMinutesBySport: {},
    trailing4WeekMinutesBySport: {},
    hasAnyHistory: false,
    rawCompletionCount: 0,
  };
}
