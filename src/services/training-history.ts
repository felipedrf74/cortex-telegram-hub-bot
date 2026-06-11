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
 *   - Scoped to (tenant_id, user_id, completed_at) — won't bleed
 *     across tenants even if a stale plan_id slipped through
 *     somewhere else. Missing tenantId fails closed to no-history.
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
import type {
  FatigueCost,
  IntensityZone,
  RecentSession,
  SessionType,
  Sport,
  StrengthExerciseCompletionSignal,
} from './coach-kernel/types';

export interface TrainingHistoryReadOptions {
  /**
   * Anchor date for the "now" boundary. Defaults to the current
   * server clock. Tests pass a fixed date for determinism.
   */
  asOf?: Date;
  tenantId?: number;
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
  recentSessions: RecentSession[];
}

const SPORTS: ReadonlyArray<Sport> = ['running', 'strength', 'cycling', 'swimming'];

/**
 * Session-type vocabulary per canonical sport. Single source of truth
 * for both `normalizeSessionTypeToSport` (JS-side normalization) and
 * the SQL `IN (…)` sport filter in `getTrainingHistoryPage` — deriving
 * the IN-list from this table means the SQL filter can never drift
 * from the JS mapping.
 */
const SESSION_TYPE_TOKENS_BY_SPORT: Record<Sport, ReadonlyArray<string>> = {
  strength: ['gym', 'strength', 'lifting', 'weights', 'weight',
    'strength_hypertrophy', 'strength_max', 'strength_maintenance'],
  running: ['run', 'running', 'corrida', 'easy_run', 'long_run', 'threshold_run', 'interval_run', 'recovery_run', 'brick'],
  cycling: ['ride', 'bike', 'biking', 'cycle', 'cycling', 'ciclismo', 'pedal',
    'endurance_ride', 'tempo_ride', 'threshold_ride', 'vo2_ride', 'recovery_ride'],
  swimming: ['swim', 'swimming', 'natacao', 'natação',
    'technique_swim', 'aerobic_swim', 'threshold_swim', 'speed_swim', 'recovery_swim'],
};

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
  for (const sport of SPORTS) {
    if (SESSION_TYPE_TOKENS_BY_SPORT[sport].includes(value)) return sport;
  }
  return null;
}

function normalizeSessionTypeToKernelType(sessionType: string | null | undefined): SessionType | null {
  if (!sessionType) return null;
  const value = sessionType.toLowerCase().trim();
  if (['gym', 'strength', 'lifting', 'weights', 'weight'].includes(value)) return 'strength_hypertrophy';
  if (['run', 'running', 'corrida', 'easy_run'].includes(value)) return 'easy_run';
  if (['long_run'].includes(value)) return 'long_run';
  if (['threshold_run', 'tempo_run'].includes(value)) return 'threshold_run';
  if (['interval_run'].includes(value)) return 'interval_run';
  if (['recovery_run'].includes(value)) return 'recovery_run';
  if (['ride', 'bike', 'biking', 'cycle', 'cycling', 'ciclismo', 'pedal', 'endurance_ride'].includes(value)) return 'endurance_ride';
  if (['tempo_ride'].includes(value)) return 'tempo_ride';
  if (['threshold_ride'].includes(value)) return 'threshold_ride';
  if (['vo2_ride'].includes(value)) return 'vo2_ride';
  if (['recovery_ride'].includes(value)) return 'recovery_ride';
  if (['swim', 'swimming', 'natacao', 'natação', 'aerobic_swim'].includes(value)) return 'aerobic_swim';
  if (['technique_swim'].includes(value)) return 'technique_swim';
  if (['threshold_swim'].includes(value)) return 'threshold_swim';
  if (['speed_swim'].includes(value)) return 'speed_swim';
  if (['recovery_swim'].includes(value)) return 'recovery_swim';
  if (['strength_hypertrophy', 'strength_max', 'strength_maintenance', 'brick', 'mobility', 'rest'].includes(value)) return value as SessionType;
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
  const tenantId = typeof options.tenantId === 'number' && Number.isFinite(options.tenantId)
    ? Math.trunc(options.tenantId)
    : null;

  if (tenantId === null) {
    logger.warn(
      { userId },
      'readTrainingHistoryFromCompletions: missing tenantId; refusing user-only completion history read',
    );
    return emptyHistory();
  }

  const db = getDb();

  // Single query joins completion → session → plan to get the
  // (sport, completed_at, duration) tuple per row, scoped to the
  // user via the plan's user_id. Plan FK CASCADE means cancelled
  // plans don't appear here (their completions were cascaded
  // away), which is the right behavior — they're historical
  // residue, not coaching signal.
  let rows: Array<{
    session_id: number;
    session_type: string | null;
    completed_at: string;
    planned_duration_minutes: number | null;
    actual_duration_minutes: number | null;
    rpe_overall: number | null;
    soreness_level: number | null;
    energy_level: number | null;
    actual_exercises_json: string | null;
    completed_sets_json: string | null;
    completed_reps_json: string | null;
    completed_load_json: string | null;
    rir: number | null;
    pain_score: number | null;
    pain_location: string | null;
    technical_success_score: number | null;
  }> = [];
  try {
    rows = db.prepare(`
      SELECT ts.session_type AS session_type,
             ts.id AS session_id,
             tc.completed_at AS completed_at,
             ts.duration_minutes AS planned_duration_minutes,
             COALESCE(tc.duration_minutes, ts.duration_minutes, 0) AS actual_duration_minutes,
             tc.rpe_overall AS rpe_overall,
             tc.soreness_level AS soreness_level,
             tc.energy_level AS energy_level,
             tc.actual_exercises_json AS actual_exercises_json,
             tc.completed_sets_json AS completed_sets_json,
             tc.completed_reps_json AS completed_reps_json,
             tc.completed_load_json AS completed_load_json,
             tc.rir AS rir,
             tc.pain_score AS pain_score,
             tc.pain_location AS pain_location,
             tc.technical_success_score AS technical_success_score
      FROM training_completions tc
      JOIN training_sessions ts ON ts.id = tc.session_id
      JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
      WHERE ftp.user_id = ? AND ftp.tenant_id = ?
        AND tc.completed_at >= ?
        AND tc.completed_at < ?
      ORDER BY tc.completed_at ASC
    `).all(
      userId,
      tenantId,
      windowStart,
      asOf.toISOString(),
    ) as typeof rows;
  } catch (err) {
    logger.warn(
      { err, userId, tenantId },
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
    const minutes = Math.max(0, Math.round(row.actual_duration_minutes ?? 0));
    perSportPerWeek[sport][weekIndex] += minutes;
    perSportHasAny[sport] = true;
  }

  const trailing4WeekMinutesBySport: RealTrainingHistory['trailing4WeekMinutesBySport'] = {};
  const lastWeekMinutesBySport: RealTrainingHistory['lastWeekMinutesBySport'] = {};
  const recentSessions: RecentSession[] = [];
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

  for (const row of rows.slice(-12)) {
    const sport = normalizeSessionTypeToSport(row.session_type);
    const sessionType = normalizeSessionTypeToKernelType(row.session_type);
    if (!sport || !sessionType) continue;
    const completedAt = normalizeCompletionTimestamp(row.completed_at);
    if (!completedAt) continue;
    const actualMinutes = Math.max(0, Math.round(row.actual_duration_minutes ?? 0));
    const plannedMinutes = Math.max(0, Math.round(row.planned_duration_minutes ?? actualMinutes));
    const distanceKm = extractDistanceKm(row.actual_exercises_json);
    recentSessions.push({
      id: `completion-${row.session_id}-${completedAt}`,
      sport,
      sessionType,
      completedAt,
      durationMinutes: actualMinutes,
      plannedDurationMinutes: plannedMinutes,
      actualDurationMinutes: actualMinutes,
      intensityZone: inferIntensityZone(sessionType),
      fatigueCost: inferFatigueCost(sessionType),
      rpe: row.rpe_overall ?? undefined,
      rir: row.rir ?? undefined,
      sorenessLevel: row.soreness_level ?? undefined,
      energyLevel: row.energy_level ?? undefined,
      distanceKm: distanceKm > 0 ? distanceKm : undefined,
      completionStatus: plannedMinutes > 0 && actualMinutes < plannedMinutes * 0.72 ? 'partial' : 'completed',
      completed: true,
      keySession: isLikelyKeySession(sessionType),
      feedbackTags: inferFeedbackTags(row, plannedMinutes, actualMinutes),
      strengthExerciseSignals: sport === 'strength'
        ? extractStrengthExerciseSignals(row, completedAt, plannedMinutes)
        : undefined,
    });
  }

  return {
    lastWeekMinutesBySport,
    trailing4WeekMinutesBySport,
    hasAnyHistory: SPORTS.some((s) => perSportHasAny[s]),
    rawCompletionCount: rows.length,
    recentSessions,
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
  if (!Number.isFinite(completedAt.getTime()) || !Number.isFinite(asOf.getTime())) return -1;
  const deltaMs = asOf.getTime() - completedAt.getTime();
  const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
  if (deltaDays < 0) return -1;
  if (deltaDays >= 28) return -1;
  return Math.floor(deltaDays / 7);
}

function normalizeCompletionTimestamp(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function emptyHistory(): RealTrainingHistory {
  return {
    lastWeekMinutesBySport: {},
    trailing4WeekMinutesBySport: {},
    hasAnyHistory: false,
    rawCompletionCount: 0,
    recentSessions: [],
  };
}

function inferIntensityZone(sessionType: SessionType): IntensityZone {
  if (sessionType.includes('recovery') || sessionType === 'mobility' || sessionType === 'rest') return 'recovery';
  if (sessionType.includes('threshold')) return 'threshold';
  if (sessionType.includes('interval') || sessionType === 'vo2_ride' || sessionType === 'speed_swim') return 'vo2';
  if (sessionType.includes('tempo')) return 'tempo';
  return 'aerobic';
}

function inferFatigueCost(sessionType: SessionType): FatigueCost {
  if (sessionType.includes('recovery') || sessionType === 'mobility' || sessionType === 'rest') return 'low';
  if (sessionType.includes('threshold') || sessionType.includes('interval') || sessionType === 'vo2_ride') return 'high';
  if (sessionType === 'long_run' || sessionType === 'endurance_ride' || sessionType === 'strength_max') return 'high';
  return 'medium';
}

function isLikelyKeySession(sessionType: SessionType): boolean {
  return sessionType === 'long_run'
    || sessionType === 'threshold_run'
    || sessionType === 'interval_run'
    || sessionType === 'threshold_ride'
    || sessionType === 'vo2_ride'
    || sessionType === 'strength_max';
}

function inferFeedbackTags(
  row: {
    rpe_overall: number | null;
    soreness_level: number | null;
    actual_exercises_json: string | null;
    pain_score?: number | null;
  },
  plannedMinutes: number,
  actualMinutes: number,
): RecentSession['feedbackTags'] {
  const tags = new Set<NonNullable<RecentSession['feedbackTags']>[number]>();
  if (row.rpe_overall != null && row.rpe_overall >= 9) tags.add('too_hard');
  if (row.rpe_overall != null && row.rpe_overall <= 5) tags.add('too_easy');
  if ((row.soreness_level != null && row.soreness_level >= 8) || (row.pain_score != null && row.pain_score >= 4)) tags.add('pain');
  if (plannedMinutes > 0 && actualMinutes >= plannedMinutes * 1.25) tags.add('too_long');
  const raw = row.actual_exercises_json?.toLowerCase() ?? '';
  if (raw.includes('substitut')) tags.add('substitution');
  if (raw.includes('travel') || raw.includes('hotel')) tags.add('travel');
  return Array.from(tags);
}

function extractStrengthExerciseSignals(
  row: {
    actual_exercises_json: string | null;
    completed_sets_json?: string | null;
    completed_reps_json?: string | null;
    completed_load_json?: string | null;
    rpe_overall?: number | null;
    rir?: number | null;
    soreness_level?: number | null;
    pain_score?: number | null;
    pain_location?: string | null;
    technical_success_score?: number | null;
  },
  completedAt: string,
  plannedMinutes: number,
): StrengthExerciseCompletionSignal[] | undefined {
  const exercises = parseExerciseEntries(row.actual_exercises_json);
  const completedReps = parseNumberArray(row.completed_reps_json);
  const completedSets = parseSetEntries(row.completed_sets_json);
  if (exercises.length === 0 && completedReps.length === 0 && completedSets.length === 0) return undefined;

  const maxCompletedFromParallel = completedReps.length > 0 ? Math.max(...completedReps) : null;
  const signals: StrengthExerciseCompletionSignal[] = [];
  const entryCount = Math.max(exercises.length, completedSets.length > 0 ? 1 : 0);
  for (let index = 0; index < entryCount; index++) {
    const entry = exercises[index] as Record<string, unknown> | undefined;
    const perExerciseSets = Array.isArray(entry?.sets) ? parseSetEntries(JSON.stringify(entry?.sets)) : [];
    const completedTop = maxFinite([
      maxCompletedFromParallel,
      maxCompletedRepsFromSets(perExerciseSets),
      maxCompletedRepsFromSets(completedSets),
      numberFromUnknown(entry?.completedReps),
      numberFromUnknown(entry?.completed_reps),
      numberFromUnknown(entry?.repsDone),
      numberFromUnknown(entry?.reps_done),
      numberFromUnknown(entry?.reps),
    ]);
    const prescribedTop = maxFinite([
      numberFromUnknown(entry?.prescribedReps),
      numberFromUnknown(entry?.targetReps),
      numberFromUnknown(entry?.target_reps),
      numberFromUnknown(entry?.plannedReps),
      numberFromUnknown(entry?.planned_reps),
      maxRepsFromText(entry?.prescribed_reps ?? entry?.reps),
      completedTop,
    ]);
    if (!completedTop || !prescribedTop) continue;

    signals.push({
      exerciseId: stringFromUnknown(entry?.exerciseId ?? entry?.exercise_id ?? entry?.id),
      exerciseName: stringFromUnknown(entry?.name ?? entry?.exercise),
      completedRepsTopSet: completedTop,
      prescribedRepsTopSet: prescribedTop,
      rpeTopSet: row.rpe_overall ?? undefined,
      rir: row.rir ?? undefined,
      sorenessLevel: row.soreness_level ?? undefined,
      technicalSuccessScore: row.technical_success_score ?? undefined,
      painScore: row.pain_score ?? undefined,
      painLocation: row.pain_location ?? undefined,
      completedAt,
    });
  }

  if (signals.length > 0) return signals;
  if (plannedMinutes <= 0) return undefined;
  return undefined;
}

function parseExerciseEntries(rawJson: string | null): unknown[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    return [];
  }
  return [];
}

function parseNumberArray(rawJson?: string | null): number[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(numberFromUnknown)
      .filter((value): value is number => value != null && value > 0);
  } catch {
    return [];
  }
}

function parseSetEntries(rawJson?: string | null): Array<Record<string, unknown>> {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value)
    );
  } catch {
    return [];
  }
}

function maxCompletedRepsFromSets(sets: Array<Record<string, unknown>>): number | null {
  return maxFinite(sets.map((set) => numberFromUnknown(set.reps ?? set.completedReps ?? set.completed_reps)));
}

function maxRepsFromText(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.round(value));
  if (typeof value !== 'string') return null;
  const matches = value.match(/\d+/g);
  if (!matches) return null;
  return Math.max(...matches.map(Number));
}

function maxFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  return finite.length > 0 ? Math.round(Math.max(...finite)) : null;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractDistanceKm(rawJson: string | null): number {
  if (!rawJson) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return 0;
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed, (parsed as Record<string, unknown>).metrics].filter(Boolean)
      : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    const directKm = numberFromUnknown(value.distance_km ?? value.distanceKm ?? value.km);
    if (directKm != null && directKm > 0) return directKm;
    const distance = numberFromUnknown(value.distance);
    if (distance != null && distance > 0) {
      const unit = typeof value.unit === 'string' ? value.unit.toLowerCase() : 'km';
      if (unit === 'm' || unit === 'meters' || unit === 'metres') return distance / 1000;
      if (unit === 'mi' || unit === 'mile' || unit === 'miles') return distance * 1.609344;
      return distance;
    }
  }
  return 0;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Training history page — GET /api/v1/training/history (Training redesign
// Phase 0, item 5).
//
// Unified, keyset-paginated log of what actually happened: completed
// entries from `training_completions` plus skipped sessions from
// `training_sessions` (status = 'skipped'). Both arms are tenant-scoped
// through `fitness_training_plans` (user_id AND tenant_id) like every
// other read in this module.
//
// Ordering is (date key DESC, completion-before-skipped, row id DESC).
// Skipped sessions have no completion timestamp, so `ts.updated_at` is
// used as their approximate date. Skipped rows intentionally carry no
// `reason` field — no such column exists (decided v1 deviation;
// `training_completions.missed_reason` only exists for logged
// completions, not bare skipped sessions).
// ---------------------------------------------------------------------------

const TRAINING_HISTORY_DEFAULT_LIMIT = 20;
const TRAINING_HISTORY_MAX_LIMIT = 50;

/**
 * Threshold mirroring `RecentSession.completionStatus` above: a
 * completion is 'partial' when the athlete did less than 72% of the
 * planned duration.
 */
const TRAINING_HISTORY_PARTIAL_RATIO = 0.72;

export interface TrainingHistoryCursor {
  /**
   * Raw date key exactly as stored in the source row (`completed_at`
   * for completions, `updated_at` for skipped sessions). Kept raw —
   * not re-normalized — so SQL string comparisons in the keyset
   * filter match ORDER BY semantics exactly.
   */
  date: string;
  type: 'completion' | 'skipped';
  id: number;
}

export interface TrainingHistoryItem {
  id: string;
  type: 'completion' | 'skipped';
  sessionId: number;
  date: string;
  sport: Sport | null;
  sessionType: string | null;
  title: string | null;
  status: 'completed' | 'partial' | 'skipped';
  plannedDurationMin: number | null;
  actualDurationMin: number | null;
  actualDistanceKm: number | null;
  rpe: number | null;
  energy: number | null;
  soreness: number | null;
  notes: string | null;
  planName: string | null;
  weekNumber: number | null;
}

export interface TrainingHistoryPage {
  items: TrainingHistoryItem[];
  nextCursor: string | null;
}

export interface TrainingHistoryPageOptions {
  /** Page size, clamped to 1..50. Defaults to 20. */
  limit?: number;
  /** Decoded keyset cursor from a previous page, or null for page 1. */
  cursor?: TrainingHistoryCursor | null;
  /** Optional canonical-sport filter (see SESSION_TYPE_TOKENS_BY_SPORT). */
  sport?: Sport | null;
}

export function encodeTrainingHistoryCursor(cursor: TrainingHistoryCursor): string {
  return Buffer.from(`${cursor.date}|${cursor.type}|${cursor.id}`, 'utf8').toString('base64');
}

/**
 * Decode a base64 "dateIso|type|id" keyset token. Returns null for
 * anything malformed — callers should treat null as a 400, never as
 * "start from page 1" (silent restarts would make pagination lie).
 */
export function decodeTrainingHistoryCursor(raw: string): TrainingHistoryCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('|');
  if (parts.length < 3) return null;
  const idRaw = parts[parts.length - 1];
  const type = parts[parts.length - 2];
  const date = parts.slice(0, -2).join('|');
  if (type !== 'completion' && type !== 'skipped') return null;
  if (date.length === 0) return null;
  if (!/^\d+$/.test(idRaw)) return null;
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { date, type, id };
}

interface TrainingHistoryCompletionRow {
  completion_id: number;
  session_id: number;
  date_key: string;
  session_type: string | null;
  title: string | null;
  planned_duration_minutes: number | null;
  actual_duration_minutes: number | null;
  completed_distance_meters: number | null;
  rpe_overall: number | null;
  energy_level: number | null;
  soreness_level: number | null;
  notes: string | null;
  plan_name: string | null;
  week_number: number | null;
}

interface TrainingHistorySkippedRow {
  session_id: number;
  date_key: string;
  session_type: string | null;
  title: string | null;
  planned_duration_minutes: number | null;
  plan_name: string | null;
  week_number: number | null;
}

interface TrainingHistoryMergedRow {
  dateKey: string;
  type: 'completion' | 'skipped';
  rowId: number;
  item: TrainingHistoryItem;
}

/**
 * Total order for the merged history stream: date key DESC, then
 * completions before skipped rows on ties, then row id DESC. The
 * keyset WHERE clauses below are derived from this comparator — they
 * must change together.
 */
function compareTrainingHistoryRows(a: TrainingHistoryMergedRow, b: TrainingHistoryMergedRow): number {
  if (a.dateKey !== b.dateKey) return a.dateKey > b.dateKey ? -1 : 1;
  if (a.type !== b.type) return a.type === 'completion' ? -1 : 1;
  return b.rowId - a.rowId;
}

export function getTrainingHistoryPage(
  userId: number,
  tenantId: number,
  options: TrainingHistoryPageOptions = {},
): TrainingHistoryPage {
  const safeTenantId = typeof tenantId === 'number' && Number.isFinite(tenantId)
    ? Math.trunc(tenantId)
    : null;
  if (safeTenantId === null) {
    logger.warn(
      { userId },
      'getTrainingHistoryPage: missing tenantId; refusing user-only history read',
    );
    return { items: [], nextCursor: null };
  }

  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.min(TRAINING_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(options.limit)))
    : TRAINING_HISTORY_DEFAULT_LIMIT;
  const cursor = options.cursor ?? null;
  const sport = options.sport ?? null;
  const sportTokens = sport ? SESSION_TYPE_TOKENS_BY_SPORT[sport] : null;
  const sportClause = sportTokens
    ? ` AND LOWER(TRIM(ts.session_type)) IN (${sportTokens.map(() => '?').join(', ')})`
    : '';
  const sportParams: unknown[] = sportTokens ? [...sportTokens] : [];

  // Keyset clauses derived from compareTrainingHistoryRows: at an
  // equal date key, completions sort before skipped rows, so a
  // skipped cursor excludes same-date completions entirely while a
  // completion cursor still admits same-date skipped rows.
  let completionCursorClause = '';
  const completionCursorParams: unknown[] = [];
  let skippedCursorClause = '';
  const skippedCursorParams: unknown[] = [];
  if (cursor) {
    if (cursor.type === 'completion') {
      completionCursorClause = ' AND (tc.completed_at < ? OR (tc.completed_at = ? AND tc.id < ?))';
      completionCursorParams.push(cursor.date, cursor.date, cursor.id);
      skippedCursorClause = ' AND ts.updated_at <= ?';
      skippedCursorParams.push(cursor.date);
    } else {
      completionCursorClause = ' AND tc.completed_at < ?';
      completionCursorParams.push(cursor.date);
      skippedCursorClause = ' AND (ts.updated_at < ? OR (ts.updated_at = ? AND ts.id < ?))';
      skippedCursorParams.push(cursor.date, cursor.date, cursor.id);
    }
  }

  const db = getDb();
  // Fetch limit+1 per arm: enough to fill the page from either arm
  // alone and to know whether a next page exists after the merge.
  const fetchCount = limit + 1;

  const completionRows = db.prepare(`
    SELECT tc.id AS completion_id,
           tc.session_id AS session_id,
           tc.completed_at AS date_key,
           ts.session_type AS session_type,
           ts.title AS title,
           ts.duration_minutes AS planned_duration_minutes,
           tc.duration_minutes AS actual_duration_minutes,
           tc.completed_distance_meters AS completed_distance_meters,
           tc.rpe_overall AS rpe_overall,
           tc.energy_level AS energy_level,
           tc.soreness_level AS soreness_level,
           tc.notes AS notes,
           ftp.name AS plan_name,
           tw.week_number AS week_number
    FROM training_completions tc
    JOIN training_sessions ts ON ts.id = tc.session_id
    JOIN training_weeks tw ON tw.id = ts.week_id
    JOIN fitness_training_plans ftp ON ftp.id = tc.plan_id
    WHERE ftp.user_id = ? AND ftp.tenant_id = ?${sportClause}${completionCursorClause}
    ORDER BY tc.completed_at DESC, tc.id DESC
    LIMIT ?
  `).all(
    userId,
    safeTenantId,
    ...sportParams,
    ...completionCursorParams,
    fetchCount,
  ) as TrainingHistoryCompletionRow[];

  const skippedRows = db.prepare(`
    SELECT ts.id AS session_id,
           ts.updated_at AS date_key,
           ts.session_type AS session_type,
           ts.title AS title,
           ts.duration_minutes AS planned_duration_minutes,
           ftp.name AS plan_name,
           tw.week_number AS week_number
    FROM training_sessions ts
    JOIN training_weeks tw ON tw.id = ts.week_id
    JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
    WHERE ftp.user_id = ? AND ftp.tenant_id = ? AND ts.status = 'skipped'${sportClause}${skippedCursorClause}
    ORDER BY ts.updated_at DESC, ts.id DESC
    LIMIT ?
  `).all(
    userId,
    safeTenantId,
    ...sportParams,
    ...skippedCursorParams,
    fetchCount,
  ) as TrainingHistorySkippedRow[];

  const merged: TrainingHistoryMergedRow[] = [];

  for (const row of completionRows) {
    const planned = row.planned_duration_minutes;
    const actual = row.actual_duration_minutes;
    const status: TrainingHistoryItem['status'] =
      planned != null && planned > 0 && actual != null && actual < planned * TRAINING_HISTORY_PARTIAL_RATIO
        ? 'partial'
        : 'completed';
    merged.push({
      dateKey: row.date_key,
      type: 'completion',
      rowId: row.completion_id,
      item: {
        id: `completion-${row.completion_id}`,
        type: 'completion',
        sessionId: row.session_id,
        date: row.date_key,
        sport: normalizeSessionTypeToSport(row.session_type),
        sessionType: row.session_type,
        title: row.title,
        status,
        plannedDurationMin: planned,
        actualDurationMin: actual,
        actualDistanceKm: row.completed_distance_meters != null
          ? row.completed_distance_meters / 1000
          : null,
        rpe: row.rpe_overall,
        energy: row.energy_level,
        soreness: row.soreness_level,
        notes: row.notes,
        planName: row.plan_name,
        weekNumber: row.week_number,
      },
    });
  }

  for (const row of skippedRows) {
    merged.push({
      dateKey: row.date_key,
      type: 'skipped',
      rowId: row.session_id,
      item: {
        id: `skipped-${row.session_id}`,
        type: 'skipped',
        sessionId: row.session_id,
        date: row.date_key,
        sport: normalizeSessionTypeToSport(row.session_type),
        sessionType: row.session_type,
        title: row.title,
        status: 'skipped',
        plannedDurationMin: row.planned_duration_minutes,
        actualDurationMin: null,
        actualDistanceKm: null,
        rpe: null,
        energy: null,
        soreness: null,
        notes: null,
        planName: row.plan_name,
        weekNumber: row.week_number,
      },
    });
  }

  merged.sort(compareTrainingHistoryRows);
  const page = merged.slice(0, limit);
  const last = page.length > 0 ? page[page.length - 1] : null;
  const hasMore = merged.length > limit;

  return {
    items: page.map((row) => row.item),
    nextCursor: hasMore && last
      ? encodeTrainingHistoryCursor({ date: last.dateKey, type: last.type, id: last.rowId })
      : null,
  };
}
