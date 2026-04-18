// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Session Analytics — Phase 4 Slice A
 *
 * Aggregates `training_completions` rows into longitudinal views the
 * coach can reason about: weekly activity per sport, current streak,
 * per-sport duration/RPE averages.
 *
 * PURE SQL + in-memory aggregation. No LLM calls. This is token-zero
 * infrastructure that feeds:
 *   - The iOS weekly activity card (Phase 4 Slice B)
 *   - Adherence signals (Phase 4 Slice C)
 *   - Progression-aware coach prompts (Phase 4 Slice D+)
 *
 * The schema comes from migration 023_fitness_training_plans.sql:
 *   fitness_training_plans  (user_id, sport, status, start_date, end_date)
 *   training_sessions       (plan_id, session_type, status, duration_minutes)
 *   training_completions    (session_id, plan_id, completed_at, rpe_overall, duration_minutes)
 *
 * User isolation: every query JOINs through fitness_training_plans so
 * one user never sees another's completion rows.
 *
 * Sport taxonomy: the raw `session_type` column uses values like
 * `strength`, `running`, `cycling`, `swim`, `recovery`, `mobility`. We
 * normalize this to our 4-sport persona enum (`gym`, `running`,
 * `cycling`, `swim`) + an `other` bucket for recovery/mobility/anything
 * unknown. That way the summary lines up with the Phase 1 Slice A
 * persona split.
 */

import { getDb } from './database';
import { now, startOfWeek, endOfWeek } from '../utils/date-parser';
import { DateTime } from 'luxon';
import { logger } from '../utils/logger';
import { getActivities } from './wearable/wearable-service';
import type { ActivityType, NormalizedActivity } from './wearable/types';

// ─── Types ──────────────────────────────────────────────────────────

/** Canonical sport key for the response. Matches sport classifier + personas. */
export type SportKey = 'gym' | 'running' | 'cycling' | 'swim' | 'other';

/** Aggregated stats for a single sport within a time window. */
export interface SportActivity {
  completions: number;
  totalDurationMin: number;
  /** Average RPE across completed sessions in the window. Null when no RPEs logged. */
  avgRpe: number | null;
}

/** Longest-run and current streak in days. */
export interface StreakInfo {
  /** Consecutive days ending today (or yesterday) with at least one completion. */
  currentDays: number;
  /** Longest consecutive-day run in the lookback window. */
  longestDays: number;
}

/** Response shape for getWeeklyActivitySummary. */
export interface WeeklyActivitySummary {
  userId: number;
  /** ISO 8601 timestamp (with timezone) at the start of the week window. */
  weekStart: string;
  /** ISO 8601 timestamp at the end of the week window. */
  weekEnd: string;
  totalCompletions: number;
  totalDurationMin: number;
  avgRpe: number | null;
  bySport: Record<SportKey, SportActivity>;
  streak: StreakInfo;
}

// ─── Phase 4 Slice C — Adherence ─────────────────────────────────

/**
 * Result of `computeWeeklyAdherence`. All fields are present even
 * when the user has no active plan — the caller checks `hasActivePlan`
 * before trusting the ratio.
 */
export interface WeeklyAdherence {
  userId: number;
  hasActivePlan: boolean;
  /** Plan name (for observability / signal payloads). Null if no plan. */
  planName: string | null;
  /** Plan sport as declared in fitness_training_plans.sport. Null if no plan. */
  planSport: string | null;
  /** Week start/end as ISO 8601 strings in the user's TZ. */
  weekStart: string;
  weekEnd: string;
  /** Sessions the plan scheduled for this week (rows in training_sessions). */
  planned: number;
  /** Planned sessions marked completed (status = 'completed'). */
  completed: number;
  /** Planned sessions the user explicitly skipped (status = 'skipped'). */
  skipped: number;
  /** Adherence ratio 0.0–1.0. Zero when planned = 0 (avoids NaN). */
  ratio: number;
  /** Same ratio as a 0–100 integer for display. */
  percentage: number;
}

// ─── Sport normalization ─────────────────────────────────────────────

/**
 * Map a raw `training_sessions.session_type` value to the canonical
 * sport key the persona system uses. Unknown or low-value types fall
 * into the `other` bucket so the response always has the same 5 keys.
 */
function normalizeSessionType(sessionType: string): SportKey {
  const t = sessionType.toLowerCase().trim();
  if (['strength', 'gym', 'lift', 'lifting', 'weights'].includes(t)) return 'gym';
  if (['running', 'run', 'jog'].includes(t)) return 'running';
  if (['cycling', 'cycle', 'bike', 'ride'].includes(t)) return 'cycling';
  if (['swim', 'swimming', 'pool'].includes(t)) return 'swim';
  return 'other';
}

/**
 * Empty SportActivity with zero counts. Used so every response
 * contains all 5 sport keys, even if the user didn't do that sport.
 */
function emptySportActivity(): SportActivity {
  return { completions: 0, totalDurationMin: 0, avgRpe: null };
}

function emptyBySport(): Record<SportKey, SportActivity> {
  return {
    gym: emptySportActivity(),
    running: emptySportActivity(),
    cycling: emptySportActivity(),
    swim: emptySportActivity(),
    other: emptySportActivity(),
  };
}

// ─── SQL row shapes ──────────────────────────────────────────────────

interface CompletionRow {
  session_type: string;
  completed_at: string;
  rpe_overall: number | null;
  duration_minutes: number | null;
}

interface DayCountRow {
  day: string;  // YYYY-MM-DD
  session_count: number;
}

interface CompletionAggregate {
  sport: SportKey;
  day: string;
  completions: number;
  totalDurationMin: number;
}

// ─── Streak computation ─────────────────────────────────────────────

/**
 * Given a list of dates (YYYY-MM-DD) that have at least one completion,
 * compute the current streak and longest streak.
 *
 * Current streak semantics:
 *   - If today has a completion → count includes today
 *   - If today is empty but yesterday has one → count starts at yesterday
 *     (same day is a gap you haven't broken yet — users train at night)
 *   - Otherwise → 0
 *
 * This mirrors the "don't punish the user for not having done today's
 * session yet by 10am" intent. It's slightly generous by one day, but
 * that's the friendlier read in the morning.
 */
export function computeStreaks(
  dayStrings: string[],
  referenceDate: DateTime = now(),
): StreakInfo {
  if (dayStrings.length === 0) {
    return { currentDays: 0, longestDays: 0 };
  }

  // Normalize to a Set for O(1) lookup, deduplicated.
  const daySet = new Set(dayStrings);
  const today = referenceDate.toFormat('yyyy-LL-dd');
  const yesterday = referenceDate.minus({ days: 1 }).toFormat('yyyy-LL-dd');

  // ── Current streak ────────────────────────────────────────────
  // Start at today (or yesterday if today is empty) and walk
  // backwards day by day until we hit a gap.
  let currentDays = 0;
  let cursor: DateTime;
  if (daySet.has(today)) {
    cursor = referenceDate;
  } else if (daySet.has(yesterday)) {
    cursor = referenceDate.minus({ days: 1 });
  } else {
    cursor = referenceDate;  // used as a no-op; loop exits immediately
  }
  while (daySet.has(cursor.toFormat('yyyy-LL-dd'))) {
    currentDays++;
    cursor = cursor.minus({ days: 1 });
  }

  // ── Longest streak ────────────────────────────────────────────
  // Sort dates ascending, walk through, count consecutive runs.
  const sorted = Array.from(daySet).sort();
  let longestDays = 0;
  let runLength = 0;
  let prevDate: DateTime | null = null;
  for (const dayStr of sorted) {
    const day = DateTime.fromFormat(dayStr, 'yyyy-LL-dd');
    if (prevDate && day.diff(prevDate, 'days').days === 1) {
      runLength++;
    } else {
      runLength = 1;
    }
    if (runLength > longestDays) longestDays = runLength;
    prevDate = day;
  }

  return { currentDays, longestDays };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build the weekly activity summary for a user.
 *
 * The "week" is a 7-day window. By default it's the CURRENT week
 * (Monday → Sunday in Europe/Lisbon time). Callers can pass a
 * `referenceDate` to request a different week — useful for rendering
 * "last week's summary" in the iOS history view later.
 *
 * Streaks are computed over a rolling 90-day lookback so a user who
 * took a 2-week vacation doesn't have their longest-ever streak
 * dropped from the response.
 */
export function getWeeklyActivitySummary(
  userId: number,
  referenceDate?: DateTime,
): WeeklyActivitySummary {
  const ref = referenceDate ?? now();
  const weekStart = startOfWeek(ref);
  const weekEnd = endOfWeek(ref);
  const rows = readWeeklyCompletionRows(userId, weekStart, weekEnd);
  return buildWeeklySummaryFromRows(userId, ref, weekStart, weekEnd, rows);
}

export async function getUnifiedWeeklyActivitySummary(
  userId: number,
  referenceDate?: DateTime,
): Promise<WeeklyActivitySummary> {
  const ref = referenceDate ?? now();
  const weekStart = startOfWeek(ref);
  const weekEnd = endOfWeek(ref);
  const rows = readWeeklyCompletionRows(userId, weekStart, weekEnd);
  const baseSummary = buildWeeklySummaryFromRows(userId, ref, weekStart, weekEnd, rows);

  try {
    const wearableActivities = await getActivities(
      userId,
      DateTime.fromISO(weekStart).toISODate() ?? ref.toISODate() ?? '',
      DateTime.fromISO(weekEnd).toISODate() ?? ref.toISODate() ?? '',
    );

    if (wearableActivities.length === 0) {
      return baseSummary;
    }

    const mergedBySport = mergeWeeklySportBuckets(rows, wearableActivities);
    for (const sport of Object.keys(mergedBySport) as SportKey[]) {
      mergedBySport[sport].avgRpe = baseSummary.bySport[sport].avgRpe;
    }
    const completionDayRows = readStreakDayRows(userId, ref);
    const wearableDays = new Set(
      wearableActivities
        .map((activity) => DateTime.fromISO(activity.startTime).toFormat('yyyy-LL-dd'))
        .filter(Boolean),
    );

    const mergedDayStrings = Array.from(new Set([
      ...completionDayRows.map((row) => row.day),
      ...wearableDays,
    ])).sort();

    const totalCompletions = Object.values(mergedBySport).reduce((sum, row) => sum + row.completions, 0);
    const totalDurationMin = Object.values(mergedBySport).reduce((sum, row) => sum + row.totalDurationMin, 0);

    return {
      ...baseSummary,
      totalCompletions,
      totalDurationMin,
      bySport: mergedBySport,
      streak: computeStreaks(mergedDayStrings, ref),
    };
  } catch (err) {
    logger.debug({ err, userId }, 'wearable weekly activity merge failed — falling back to completion-only summary');
    return baseSummary;
  }
}

function readWeeklyCompletionRows(
  userId: number,
  weekStart: string,
  weekEnd: string,
): CompletionRow[] {
  const db = getDb();

  try {
    return db.prepare(`
      SELECT
        ts.session_type AS session_type,
        tc.completed_at AS completed_at,
        tc.rpe_overall AS rpe_overall,
        tc.duration_minutes AS duration_minutes
      FROM training_completions tc
      JOIN training_sessions ts ON ts.id = tc.session_id
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ?
        AND tc.completed_at >= ?
        AND tc.completed_at <= ?
    `).all(userId, weekStart, weekEnd) as CompletionRow[];
  } catch (err) {
    logger.debug({ err, userId }, 'training_completions query failed — returning empty summary');
    return [];
  }
}

function buildWeeklySummaryFromRows(
  userId: number,
  ref: DateTime,
  weekStart: string,
  weekEnd: string,
  rows: CompletionRow[],
): WeeklyActivitySummary {
  const bySport = emptyBySport();
  const rpeSums: Record<SportKey, { sum: number; count: number }> = {
    gym: { sum: 0, count: 0 },
    running: { sum: 0, count: 0 },
    cycling: { sum: 0, count: 0 },
    swim: { sum: 0, count: 0 },
    other: { sum: 0, count: 0 },
  };
  let totalCompletions = 0;
  let totalDurationMin = 0;
  let overallRpeSum = 0;
  let overallRpeCount = 0;

  for (const row of rows) {
    const sport = normalizeSessionType(row.session_type);
    bySport[sport].completions++;
    if (row.duration_minutes != null) {
      bySport[sport].totalDurationMin += row.duration_minutes;
      totalDurationMin += row.duration_minutes;
    }
    if (row.rpe_overall != null) {
      rpeSums[sport].sum += row.rpe_overall;
      rpeSums[sport].count++;
      overallRpeSum += row.rpe_overall;
      overallRpeCount++;
    }
    totalCompletions++;
  }

  for (const sport of Object.keys(bySport) as SportKey[]) {
    const { sum, count } = rpeSums[sport];
    bySport[sport].avgRpe = count > 0 ? Number((sum / count).toFixed(1)) : null;
  }

  const overallAvgRpe = overallRpeCount > 0
    ? Number((overallRpeSum / overallRpeCount).toFixed(1))
    : null;

  const dayRows = readStreakDayRows(userId, ref);
  const dayStrings = dayRows.map((r) => r.day);
  const streak = computeStreaks(dayStrings, ref);

  return {
    userId,
    weekStart,
    weekEnd,
    totalCompletions,
    totalDurationMin,
    avgRpe: overallAvgRpe,
    bySport,
    streak,
  };
}

function readStreakDayRows(userId: number, ref: DateTime): DayCountRow[] {
  const db = getDb();
  const streakWindowStart = ref.minus({ days: 90 }).startOf('day').toISO();

  try {
    return db.prepare(`
      SELECT DATE(tc.completed_at) AS day,
             COUNT(*) AS session_count
      FROM training_completions tc
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ?
        AND tc.completed_at >= ?
      GROUP BY day
      ORDER BY day
    `).all(userId, streakWindowStart) as DayCountRow[];
  } catch (err) {
    logger.debug({ err, userId }, 'streak day-count query failed — returning empty streaks');
    return [];
  }
}

function normalizeWearableActivityType(type: ActivityType): SportKey {
  switch (type) {
  case 'strength':
    return 'gym';
  case 'run':
    return 'running';
  case 'ride':
    return 'cycling';
  case 'swim':
    return 'swim';
  default:
    return 'other';
  }
}

function mergeWeeklySportBuckets(
  completionRows: CompletionRow[],
  wearableActivities: NormalizedActivity[],
): Record<SportKey, SportActivity> {
  const bySport = emptyBySport();
  const completionBuckets = new Map<string, CompletionAggregate>();
  const wearableBuckets = new Map<string, CompletionAggregate>();

  for (const row of completionRows) {
    const sport = normalizeSessionType(row.session_type);
    const day = DateTime.fromISO(row.completed_at).toFormat('yyyy-LL-dd');
    const key = `${day}:${sport}`;
    const existing = completionBuckets.get(key) ?? {
      sport,
      day,
      completions: 0,
      totalDurationMin: 0,
    };
    existing.completions += 1;
    existing.totalDurationMin += row.duration_minutes ?? 0;
    completionBuckets.set(key, existing);
  }

  for (const activity of wearableActivities) {
    const sport = normalizeWearableActivityType(activity.type);
    const day = DateTime.fromISO(activity.startTime).toFormat('yyyy-LL-dd');
    const key = `${day}:${sport}`;
    const existing = wearableBuckets.get(key) ?? {
      sport,
      day,
      completions: 0,
      totalDurationMin: 0,
    };
    existing.completions += 1;
    existing.totalDurationMin += Math.max(0, Math.round((activity.durationSeconds ?? 0) / 60));
    wearableBuckets.set(key, existing);
  }

  const keys = new Set([
    ...completionBuckets.keys(),
    ...wearableBuckets.keys(),
  ]);

  for (const key of keys) {
    const completion = completionBuckets.get(key);
    const wearable = wearableBuckets.get(key);
    const sport = completion?.sport ?? wearable?.sport ?? 'other';
    bySport[sport].completions += Math.max(completion?.completions ?? 0, wearable?.completions ?? 0);
    bySport[sport].totalDurationMin += Math.max(completion?.totalDurationMin ?? 0, wearable?.totalDurationMin ?? 0);
  }

  return bySport;
}

// ─── Phase 4 Slice C — Weekly adherence against active plan ─────

interface ActivePlanRow {
  id: number;
  name: string;
  sport: string;
  start_date: string;
}

interface CurrentWeekRow {
  id: number;
  week_number: number;
}

interface SessionStatusRow {
  status: string;
}

/**
 * Compute this week's adherence for a user against their active
 * training plan. The ratio comes from:
 *
 *   completed sessions / planned sessions (in the current week only)
 *
 * The "current week" is determined by:
 *   1. Find the user's active plan (status = 'active', most recent
 *      by created_at as the tiebreaker if somehow multiple).
 *   2. Compute days elapsed since plan.start_date, divide by 7 to
 *      get the 0-indexed week number, then +1.
 *   3. Look up `training_weeks WHERE plan_id = ? AND week_number = ?`.
 *   4. Count sessions in that week by status.
 *
 * Returns a fully populated result even when no plan exists, with
 * `hasActivePlan: false` signaling the caller to skip adherence
 * publishing. This keeps the orchestrator logic branchless.
 */
export function computeWeeklyAdherence(
  userId: number,
  referenceDate?: DateTime,
): WeeklyAdherence {
  const ref = referenceDate ?? now();
  const weekStart = startOfWeek(ref);
  const weekEnd = endOfWeek(ref);
  const db = getDb();

  const empty: WeeklyAdherence = {
    userId,
    hasActivePlan: false,
    planName: null,
    planSport: null,
    weekStart,
    weekEnd,
    planned: 0,
    completed: 0,
    skipped: 0,
    ratio: 0,
    percentage: 0,
  };

  // 1. Find the active plan. If multiple (shouldn't happen but be
  // defensive), pick the most recently created.
  let plan: ActivePlanRow | null = null;
  try {
    plan = db.prepare(`
      SELECT id, name, sport, start_date
      FROM fitness_training_plans
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId) as ActivePlanRow | undefined ?? null;
  } catch (err) {
    logger.debug({ err, userId }, 'active plan lookup failed — returning empty adherence');
    return empty;
  }
  if (!plan) return empty;

  // 2. Figure out which plan week the reference date falls in.
  // Days since plan start / 7, rounded down, +1 for 1-indexed.
  const planStart = DateTime.fromISO(plan.start_date);
  if (!planStart.isValid) {
    logger.debug({ userId, startDate: plan.start_date }, 'plan start_date unparseable');
    return empty;
  }
  const daysSinceStart = Math.floor(ref.startOf('day').diff(planStart.startOf('day'), 'days').days);
  if (daysSinceStart < 0) {
    // Plan hasn't started yet — no adherence to report.
    return { ...empty, hasActivePlan: true, planName: plan.name, planSport: plan.sport };
  }
  const weekNumber = Math.floor(daysSinceStart / 7) + 1;

  // 3. Look up the training_weeks row.
  let weekRow: CurrentWeekRow | null = null;
  try {
    weekRow = db.prepare(`
      SELECT id, week_number
      FROM training_weeks
      WHERE plan_id = ? AND week_number = ?
    `).get(plan.id, weekNumber) as CurrentWeekRow | undefined ?? null;
  } catch (err) {
    logger.debug({ err, userId, planId: plan.id, weekNumber }, 'training_weeks lookup failed');
    return { ...empty, hasActivePlan: true, planName: plan.name, planSport: plan.sport };
  }
  if (!weekRow) {
    // Plan exists but this week's microcycle was never generated.
    // Treat as "plan paused" — no adherence signal.
    return { ...empty, hasActivePlan: true, planName: plan.name, planSport: plan.sport };
  }

  // 4. Count sessions by status in this week.
  let sessionRows: SessionStatusRow[] = [];
  try {
    sessionRows = db.prepare(`
      SELECT status
      FROM training_sessions
      WHERE week_id = ?
    `).all(weekRow.id) as SessionStatusRow[];
  } catch (err) {
    logger.debug({ err, weekId: weekRow.id }, 'training_sessions lookup failed');
    return { ...empty, hasActivePlan: true, planName: plan.name, planSport: plan.sport };
  }

  const planned = sessionRows.length;
  const completed = sessionRows.filter((r) => r.status === 'completed').length;
  const skipped = sessionRows.filter((r) => r.status === 'skipped').length;
  const ratio = planned > 0 ? completed / planned : 0;
  const percentage = Math.round(ratio * 100);

  return {
    userId,
    hasActivePlan: true,
    planName: plan.name,
    planSport: plan.sport,
    weekStart,
    weekEnd,
    planned,
    completed,
    skipped,
    ratio,
    percentage,
  };
}
