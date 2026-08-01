// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Readiness Scorer — aggregates Garmin HRV, sleep, body battery, and training load
 * into a 0-100 composite score with intensity recommendations.
 *
 * Weights: HRV 30%, Sleep 30%, Body Battery 20%, Training Load (ACWR) 20%.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { runWithContext } from '../utils/request-context';
import { hasActiveGarminConnection } from './garmin-session-store';
import {
  getHrvData, getSleepData, getBodyBatteryEvents,
  getTrainingReadiness, getActivitiesByDate, getDailySummary,
  type GarminReadOptions,
} from './garmin';
import {
  publishLowSleep,
  publishLowHrv,
  publishLowReadiness,
} from './training-signals';
import { getReadiness as getWearableReadiness } from './wearable/wearable-service';
import type { NormalizedReadiness, WearableProvider } from './wearable/types';
import {
  deriveIntradayEnergyReserve,
  extractGarminBodyBatterySnapshot,
  resolveFallbackEnergyReserve,
} from './wearable/energy-reserve';
import { computeLoadModelForDimension } from './coach-kernel/load-model';
import { appleHealthJsonSelectColumns, parseAppleHealthDataJson } from './apple-health-encryption';
import { resolveCurrentTenantIdForUser } from './user-service';

// ── Types ───────────────────────────────────────────────────────────

export interface ReadinessFactors {
  hrv: { todayMs: number; sevenDayAvgMs: number; trend: 'up' | 'stable' | 'down'; score: number };
  sleep: { durationHours: number; qualityScore: number; score: number };
  bodyBattery: { current: number; morningPeak: number; score: number };
  trainingLoad: { acuteLoad: number; chronicLoad: number; acwr: number; score: number };
}

export type ReadinessRecommendation = 'full_intensity' | 'reduce_10pct' | 'reduce_25pct' | 'active_recovery' | 'rest_day';
export type ReadinessReasonCode = 'WEARABLE_INTEGRATION_MISSING';

/**
 * Placeholder reported for a factor that was not measured. It is shown so the
 * factor breakdown stays shape-stable for clients, but it is excluded from
 * composites — see the HRV handling in `calculateAppleHealthReadiness`.
 */
const NEUTRAL_FACTOR_SCORE = 60;
/**
 * `fitbit` is additive and currently RESERVED BUT UNREACHABLE.
 *
 * An earlier revision of this file claimed Fitbit readiness was "fetched and
 * silently discarded" by a `provider === 'whoop'` check. That was wrong:
 * `fitbit-adapter.getReadiness` returns `readinessScore: null` AND
 * `recoveryScore: null`, so there was never a score to discard. Accepting it
 * unconditionally was worse than dropping it — the shared fallback builder
 * defaults to 60, so a Fitbit user received a fabricated neutral score
 * labelled as a real Fitbit reading, replacing the honest `estimated` +
 * `WEARABLE_INTEGRATION_MISSING` signal. Snapshots now have to carry a usable
 * score to be accepted; see `calculateReadinessUncached`.
 *
 * The mapping itself is still correct and worth keeping: the builder used to
 * hardcode `source: 'whoop'` for every provider, which was a real bug.
 *
 * iOS decodes this field with `decodeIfPresent(String.self, forKey: .source)`
 * into `let source: String?` (`Models/TrainingSession.swift:1537`,
 * `ReadinessResponse`), so a new value cannot break client decoding.
 */
export type ReadinessSource = 'garmin' | 'whoop' | 'fitbit' | 'apple_health' | 'estimated';

export interface ReadinessResult {
  score: number;
  factors: ReadinessFactors;
  recommendation: ReadinessRecommendation;
  reasoning: string;
  reasonCode?: ReadinessReasonCode;
  /** Which provider produced this readiness snapshot. Optional — additive for old clients. */
  source?: ReadinessSource;
  /** ISO timestamp captured at compute time. Optional — additive for old clients. */
  asOf?: string;
  /**
   * Fraction (0-1) of the scoring model backed by real readings rather than
   * placeholders. A Garmin-only iOS user with just a sleep row scores on 0.5
   * coverage; a complete snapshot is 1. Optional — additive for old clients.
   */
  coverage?: number;
}

type AppleHealthJsonRow = {
  data_json: string;
  encrypted_data_json?: string | null;
};

function providerDisplayName(provider: NormalizedReadiness['provider']): string {
  switch (provider) {
  case 'whoop':
    return 'WHOOP';
  case 'apple_health':
    return 'Apple Health';
  case 'garmin':
    return 'Garmin';
  case 'fitbit':
    return 'Fitbit';
  default:
    return provider;
  }
}

function buildWearableFallbackReadiness(readiness: NormalizedReadiness): ReadinessResult {
  const score = clamp(
    Math.round(readiness.readinessScore ?? readiness.recoveryScore ?? 60),
    0,
    100,
  );
  const resolvedEnergyReserve = resolveFallbackEnergyReserve(
    readiness.bodyBattery,
    readiness.recoveryScore,
    readiness.readinessScore,
  );
  const bodyBatteryCurrent = resolvedEnergyReserve ?? 0;
  const factors: ReadinessFactors = {
    hrv: {
      todayMs: readiness.hrvMs ?? 0,
      sevenDayAvgMs: readiness.hrvMs ?? 0,
      trend: 'stable',
      score: readiness.hrvMs != null ? scoreHrv(readiness.hrvMs, readiness.hrvMs) : 60,
    },
    sleep: { durationHours: 0, qualityScore: 0, score: 60 },
    bodyBattery: {
      current: bodyBatteryCurrent,
      morningPeak: bodyBatteryCurrent,
      score: resolvedEnergyReserve != null ? scoreBodyBattery(resolvedEnergyReserve) : 60,
    },
    trainingLoad: { acuteLoad: 0, chronicLoad: 0, acwr: 1.0, score: 60 },
  };

  const providerName = providerDisplayName(readiness.provider);
  const recommendation = getRecommendation(score);
  const bodyBatteryReason = resolvedEnergyReserve != null
    ? `Current energy reserve ${resolvedEnergyReserve}.`
    : 'No body battery metric from this provider.';
  const recoveryReason = readiness.recoveryScore != null
    ? `Recovery score ${Math.round(readiness.recoveryScore)}.`
    : '';
  const reasoning = `${providerName} is driving today's readiness. ${bodyBatteryReason} ${recoveryReason}`.trim();

  return {
    score,
    factors,
    recommendation,
    reasoning,
    source: readinessSourceForProvider(readiness.provider),
    asOf: new Date().toISOString(),
  };
}

/**
 * Map the provider that actually produced a snapshot onto the reported source.
 *
 * This was hardcoded to `'whoop'`, so anything reaching the shared fallback
 * builder was mislabelled — including the Apple Health branches downstream
 * that key off `source === 'apple_health'`.
 */
function readinessSourceForProvider(provider: WearableProvider | undefined): ReadinessSource {
  switch (provider) {
    case 'whoop': return 'whoop';
    case 'fitbit': return 'fitbit';
    case 'garmin': return 'garmin';
    case 'apple_health': return 'apple_health';
    // Strava declares `readiness: false`, so it should never reach here.
    default: return 'estimated';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Individual Factor Scorers ───────────────────────────────────────

export function scoreHrv(todayMs: number, avgMs: number): number {
  if (avgMs <= 0) return 60; // no baseline
  const ratio = todayMs / avgMs;
  if (ratio < 0.8) return 30;    // >20% below average
  if (ratio < 0.9) return 50;
  if (ratio <= 1.1) return 70;   // within 10%
  return 90;                      // above average
}

export function scoreSleep(durationHours: number, garminQuality: number | null): number {
  const hasDuration = Number.isFinite(durationHours) && durationHours > 0;
  const durationScore = hasDuration ? scoreSleepDuration(durationHours) : null;
  if (garminQuality != null && garminQuality > 0) {
    // Garmin's quality score can look "good" after too little total sleep.
    // Keep duration as a hard safety floor so 3h of high-quality sleep does
    // not become a green recovery signal.
    const qualityScore = clamp(garminQuality, 0, 100);
    return durationScore != null ? Math.min(durationScore, qualityScore) : qualityScore;
  }
  return durationScore ?? 60;
}

function scoreSleepDuration(durationHours: number): number {
  if (durationHours < 5) return 20;
  if (durationHours < 6) return 40;
  if (durationHours < 7) return 60;
  if (durationHours < 8) return 80;
  return 90;
}

export function scoreBodyBattery(current: number): number {
  if (current < 20) return 10;
  if (current < 40) return 40;
  if (current < 60) return 60;
  if (current < 80) return 80;
  return 95;
}

export function scoreAcwr(acwr: number): number {
  if (!Number.isFinite(acwr)) return 60;
  if (acwr > 1.5) return 20;     // injury risk — deload
  if (acwr > 1.2) return 50;     // moderate risk
  if (acwr >= 0.8) return 85;    // sweet spot
  return 70;                      // under-training
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function metricValue(payload: any, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(payload?.[key]);
    if (value != null) return value;
  }
  return null;
}

function scoreTrainingEffectLabel(label: unknown): number | null {
  if (label == null) return null;
  const normalized = String(label).toLowerCase();
  if (/recovery|easy|base|aerobic/.test(normalized)) return 35;
  if (/tempo|threshold|sweet|sst/.test(normalized)) return 75;
  if (/vo2|anaerobic|sprint|interval|max/.test(normalized)) return 105;
  if (/maintaining|productive/.test(normalized)) return 55;
  return null;
}

function estimateTrainingStress(activity: any): number {
  const explicitLoad = toFiniteNumber(
    activity.activityTrainingLoad
      ?? activity.trainingLoad
      ?? activity.training_load
      ?? activity.trainingLoadValue
      ?? activity.training_stress_score
      ?? activity.tss,
  );
  if (explicitLoad != null && explicitLoad > 0) return explicitLoad;

  const effectValue = toFiniteNumber(
    activity.trainingEffect
      ?? activity.aerobicTrainingEffect
      ?? activity.trainingEffectValue,
  );
  if (effectValue != null && effectValue > 0) return clamp(effectValue * 25, 20, 130);

  const effectLabelScore = scoreTrainingEffectLabel(activity.trainingEffectLabel ?? activity.trainingEffect);
  if (effectLabelScore != null) return effectLabelScore;

  const durationSeconds = toFiniteNumber(
    activity.duration
      ?? activity.durationSeconds
      ?? activity.elapsedDuration
      ?? activity.movingDuration,
  );
  if (durationSeconds != null && durationSeconds > 0) {
    return clamp(durationSeconds / 60, 20, 240);
  }

  return 30;
}

export function computeAcwr(activities: any[], now: Date = new Date()): { acuteLoad: number; chronicLoad: number; acwr: number } {
  const msPerDay = 86400000;
  const nowMs = now.getTime();
  const todayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  let acuteLoad = 0;
  let chronicLoad = 0;
  const sampleDays = new Set<string>();
  const loadByDay = new Map<string, number>();

  for (const a of activities) {
    const rawDate = a.startTimeLocal || a.startTimeGMT || a.beginTimestamp || a.startDate || a.start;
    const actDate = new Date(rawDate).getTime();
    if (!Number.isFinite(actDate)) continue;
    const dayKey = new Date(actDate).toISOString().slice(0, 10);
    const dayStart = Date.UTC(
      new Date(actDate).getUTCFullYear(),
      new Date(actDate).getUTCMonth(),
      new Date(actDate).getUTCDate(),
    );
    const daysAgo = Math.floor((todayStart - dayStart) / msPerDay);
    if (actDate > nowMs || daysAgo < 0 || daysAgo >= 28) continue;
    sampleDays.add(dayKey);
    const stress = estimateTrainingStress(a);
    loadByDay.set(dayKey, (loadByDay.get(dayKey) ?? 0) + stress);

    if (daysAgo < 7) acuteLoad += stress;
    chronicLoad += stress;
  }

  // ACWR is unstable with sparse history. Preserve the real load totals for
  // display, but keep the ratio neutral until there is enough distinct-day
  // history to avoid fake precision for cold-start users.
  if (sampleDays.size < 14 || chronicLoad <= 0) {
    return { acuteLoad, chronicLoad, acwr: 1.0 };
  }

  const daily = Array.from({ length: 28 }, (_, index) => {
    const timestamp = todayStart - (27 - index) * msPerDay;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    return {
      date,
      value: loadByDay.get(date) ?? 0,
      confidence: 'high' as const,
    };
  });
  const loadModel = computeLoadModelForDimension({
    daily,
    dimension: 'external',
    ctlDays: 28,
    atlDays: 7,
  });
  const acwr = loadModel.acwrUncoupled > 0 ? loadModel.acwrUncoupled : 1.0;

  return { acuteLoad, chronicLoad, acwr };
}

// ── Recommendation Logic ────────────────────────────────────────────

function getRecommendation(score: number): ReadinessRecommendation {
  if (score >= 80) return 'full_intensity';
  if (score >= 65) return 'reduce_10pct';
  if (score >= 50) return 'reduce_25pct';
  if (score >= 35) return 'active_recovery';
  return 'rest_day';
}

function buildReasoning(factors: ReadinessFactors, recommendation: ReadinessRecommendation): string {
  const parts: string[] = [];

  if (factors.hrv.score < 50) parts.push(`HRV below baseline (${factors.hrv.todayMs}ms vs ${factors.hrv.sevenDayAvgMs}ms avg)`);
  if (factors.sleep.score < 50) parts.push(`Poor sleep (${factors.sleep.durationHours.toFixed(1)}h)`);
  if (factors.bodyBattery.score < 40) parts.push(`Low body battery (${factors.bodyBattery.current})`);
  if (factors.trainingLoad.acwr > 1.3) parts.push(`High training load (ACWR ${factors.trainingLoad.acwr.toFixed(2)})`);

  if (parts.length === 0) {
    return recommendation === 'full_intensity'
      ? 'All metrics green — go hard today.'
      : 'Metrics look acceptable but not peak — moderate effort recommended.';
  }

  return parts.join('; ') + '.';
}

// ── Apple Health Derived Metrics ─────────────────────────────────────
//
// When Garmin is not configured, try Apple Health data from the
// apple_health_data table. iOS syncs HRV, sleep stages, RHR, steps,
// and workouts daily. We apply the SAME scoring functions (scoreHrv,
// scoreSleep, scoreAcwr) to the raw Apple Health data to produce
// equivalent readiness values.
//
// Body Battery doesn't exist in Apple Health — we derive an equivalent
// from sleep quality + HRV status + RHR trend.

/**
 * Compute a derived sleep score from Apple Health sleep stages.
 * Apple Health provides totalSleepSeconds, deepSleepSeconds, remSleepSeconds.
 * The score weights duration (60%) and deep+REM proportion (40%).
 */
export function deriveAppleHealthSleepScore(
  totalSleepMinutes: number,
  deepSleepMinutes: number,
  remSleepMinutes: number,
): number {
  // Duration score: 8 hours (480 min) = 100, scales linearly
  const durationScore = clamp(Math.round((totalSleepMinutes / 480) * 100), 0, 100);

  // Quality score: deep + REM should be ~40-50% of total sleep
  let qualityScore = 50; // neutral default
  if (totalSleepMinutes > 0) {
    const deepRemPct = (deepSleepMinutes + remSleepMinutes) / totalSleepMinutes;
    // 40% deep+REM = 80 score, 50% = 100, 20% = 40
    qualityScore = clamp(Math.round(deepRemPct * 200), 0, 100);
  }

  return clamp(Math.round(durationScore * 0.6 + qualityScore * 0.4), 0, 100);
}

/**
 * Coarse readiness composite for the wearable-adapter entry point.
 *
 * Extracted from `apple-health-adapter` so it is reachable from tests. There
 * it sat inside a `try { const {...} = require('../readiness-scorer') }`
 * block added to dodge the
 * adapter → readiness-scorer → wearable-service → adapter cycle. Under vitest
 * that `require` throws, the surrounding catch swallows it, and the composite
 * silently produced `null` — so none of this arithmetic was ever exercised by
 * a test.
 *
 * `hrvScore == null` means HRV was not measured today. Multiplying null into
 * the sum yields 0 in JavaScript rather than skipping the term, which would
 * report a catastrophic recovery score off a normal night's sleep; the weight
 * is redistributed instead.
 *
 * Coarser than `calculateAppleHealthReadiness`: sleep falls back to a neutral
 * and the ACWR term is a fixed neutral because this entry point has no workout
 * data. Prefer the full path when coverage matters.
 */
export function deriveAdapterReadinessScore(input: {
  hrvScore: number | null;
  sleepScore: number | null;
  sleepDurationHours: number;
  bodyBatteryScore: number;
}): number {
  const sleepWeighted = (input.sleepScore != null
    ? scoreSleep(input.sleepDurationHours, input.sleepScore)
    : NEUTRAL_FACTOR_SCORE) * 0.30;
  const bbWeighted = input.bodyBatteryScore * 0.20;
  const loadWeighted = NEUTRAL_FACTOR_SCORE * 0.20;

  if (input.hrvScore == null) {
    return clamp(Math.round((sleepWeighted + bbWeighted + loadWeighted) / 0.70), 0, 100);
  }
  return clamp(
    Math.round(input.hrvScore * 0.30 + sleepWeighted + bbWeighted + loadWeighted),
    0,
    100,
  );
}

/**
 * Derive a "body battery equivalent" (energy reserve) from Apple Health signals.
 * Garmin's Body Battery is proprietary. We approximate it using:
 *   - Sleep quality (40%) — good sleep = high morning energy
 *   - HRV status (30%) — high HRV = good recovery = high energy
 *   - RHR trend (30%) — low RHR = good cardiovascular fitness = efficient energy
 */
export function deriveBodyBatteryEquivalent(
  sleepScore: number,
  hrvScore: number | null,
  rhrBpm: number | null,
  rhrBaselineBpm: number | null,
): number {
  // RHR component: lower is better. Score 100 = at/below baseline, 0 = 15+ above
  let rhrScore = 70; // neutral
  if (rhrBpm != null && rhrBaselineBpm != null && rhrBaselineBpm > 0) {
    const delta = rhrBpm - rhrBaselineBpm;
    // At baseline: 80, 5 above: 50, 10 above: 20, 5 below: 95
    rhrScore = clamp(Math.round(80 - delta * 6), 0, 100);
  }

  // Garmin does not publish HRV Status to Apple Health, so a Garmin-only iOS
  // user has no HRV rows at all. Redistribute HRV's weight over the remaining
  // terms rather than substituting a placeholder the composite would consume
  // as real.
  //
  // Note this redistributes over sleep + RHR, and `rhrScore` above still
  // defaults to 70 when RHR is absent — so with neither HRV nor RHR the
  // result leans on that default. The caller
  // (`calculateAppleHealthReadiness`) tracks measured-vs-placeholder per
  // pillar and reports `coverage`; this function only handles the HRV term.
  if (hrvScore == null) {
    const remainingWeight = 0.40 + 0.30;
    return clamp(Math.round((sleepScore * 0.40 + rhrScore * 0.30) / remainingWeight), 0, 100);
  }

  return clamp(Math.round(
    sleepScore * 0.40 +
    hrvScore * 0.30 +
    rhrScore * 0.30
  ), 0, 100);
}

/**
 * Calculate readiness from Apple Health data.
 * Reads from the apple_health_data table (populated by iOS HealthKit sync).
 * Returns the same ReadinessResult structure as the Garmin path.
 */
async function calculateAppleHealthReadiness(
  userId: number,
  opts: { tenantId: number; publishSignals?: boolean },
): Promise<ReadinessResult | null> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const healthJsonColumns = appleHealthJsonSelectColumns(db);
    // Read HRV (today)
    const hrvRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'hrv' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;

    // Read HRV baseline (7-day average)
    const hrvHistory = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'hrv' AND date > ? ORDER BY date DESC LIMIT 7`,
    ).all(userId, subtractDays(today, 8)) as AppleHealthJsonRow[];

    // Read sleep (today)
    const sleepRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'sleep' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;

    // Read RHR (today)
    const rhrRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;

    // Read RHR baseline (7-day average)
    const rhrHistory = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date > ? ORDER BY date DESC LIMIT 7`,
    ).all(userId, subtractDays(today, 8)) as AppleHealthJsonRow[];

    // Read workouts for ACWR (28 days)
    const workoutRows = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'workout' AND date > ? ORDER BY date ASC`,
    ).all(userId, subtractDays(today, 29)) as AppleHealthJsonRow[];

    const summaryRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'daily_summary' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;
    const caloriesRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'calories' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;
    const stepsRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'steps' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;
    const exerciseRow = db.prepare(
      `SELECT ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND data_type = 'exercise_minutes' AND date = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, today) as AppleHealthJsonRow | undefined;

    // If Apple Health has any useful signal, still provide the energy-reserve
    // fallback. Body Battery does not exist in HealthKit, but activity-only
    // snapshots are enough to produce an honest conservative estimate.
    const hasAppleHealthSignal = Boolean(
      hrvRow
      || sleepRow
      || rhrRow
      || summaryRow
      || caloriesRow
      || stepsRow
      || exerciseRow
      || workoutRows.length > 0,
    );
    if (!hasAppleHealthSignal) return null;

    // ── HRV ──
    const todayHrv = hrvRow ? (metricValue(parseAppleHealthDataJson(hrvRow, userId), 'value', 'sdnn_ms', 'ms') ?? 0) : 0;
    const hrvValues = hrvHistory
      .map(r => metricValue(parseAppleHealthDataJson(r, userId), 'value', 'sdnn_ms', 'ms') ?? 0)
      .filter((v: number) => v > 0);
    const weeklyHrv = hrvValues.length > 0 ? hrvValues.reduce((a: number, b: number) => a + b, 0) / hrvValues.length : todayHrv;
    const hrvTrend: 'up' | 'stable' | 'down' = todayHrv > weeklyHrv * 1.05 ? 'up' : todayHrv < weeklyHrv * 0.95 ? 'down' : 'stable';
    // Garmin syncs sleep, steps, workouts and RHR to Apple Health but NOT HRV
    // Status, so a Garmin-only iOS user has no HRV rows. `scoreHrv(60, 60)`
    // returns 70 — a healthy-looking number — which then fed both the composite
    // and the derived body battery as though it had been measured.
    // TODAY's reading, not "any reading in the last week". With a real
    // baseline but no row for today, the old check stayed true and the code
    // still scored a fabricated 60 ms against that baseline. For an athlete
    // whose baseline is 100 ms that lands in the WORST HRV bucket (30) and
    // reports trend 'down' — a missed HealthKit sync read as a collapse in
    // recovery. Absent today means unmeasured today.
    const hasMeasuredHrv = todayHrv > 0;
    const hrvScoreVal = hasMeasuredHrv ? scoreHrv(todayHrv || 60, weeklyHrv || 60) : NEUTRAL_FACTOR_SCORE;

    // ── Sleep ──
    const sleepData = sleepRow ? parseAppleHealthDataJson(sleepRow, userId) : null;
    const totalSleepMin = sleepData
      ? (metricValue(sleepData, 'totalSleepSeconds') ?? (metricValue(sleepData, 'totalMinutes') ?? 0) * 60) / 60
      : 0;
    const deepSleepMin = sleepData
      ? (metricValue(sleepData, 'deepSleepSeconds') ?? (metricValue(sleepData, 'deepMinutes') ?? 0) * 60) / 60
      : 0;
    const remSleepMin = sleepData
      ? (metricValue(sleepData, 'remSleepSeconds') ?? (metricValue(sleepData, 'remMinutes') ?? 0) * 60) / 60
      : 0;
    const derivedSleepScore = totalSleepMin > 0
      ? deriveAppleHealthSleepScore(totalSleepMin, deepSleepMin, remSleepMin)
      : 60;
    const sleepScoreVal = scoreSleep(totalSleepMin / 60, derivedSleepScore);

    // ── RHR ──
    const todayRhr = rhrRow ? metricValue(parseAppleHealthDataJson(rhrRow, userId), 'value', 'bpm') : null;
    const rhrValues = rhrHistory
      .map(r => metricValue(parseAppleHealthDataJson(r, userId), 'value', 'bpm') ?? 0)
      .filter((v: number) => v > 0);
    const rhrBaseline = rhrValues.length > 0 ? rhrValues.reduce((a: number, b: number) => a + b, 0) / rhrValues.length : null;

    // ── Derived Body Battery ──
    const derivedBB = deriveBodyBatteryEquivalent(
      derivedSleepScore,
      hasMeasuredHrv ? hrvScoreVal : null,
      todayRhr,
      rhrBaseline,
    );

    const summary = summaryRow ? parseAppleHealthDataJson(summaryRow, userId) : null;
    const calories = caloriesRow ? parseAppleHealthDataJson(caloriesRow, userId) : null;
    const steps = stepsRow ? parseAppleHealthDataJson(stepsRow, userId) : null;
    const exercise = exerciseRow ? parseAppleHealthDataJson(exerciseRow, userId) : null;
    const currentEnergyReserve = deriveIntradayEnergyReserve({
      morningPeak: derivedBB,
      activeCalories: summary?.activeCalories ?? calories?.kcal ?? null,
      exerciseMinutes: summary?.exerciseMinutes ?? exercise?.minutes ?? null,
      steps: summary?.steps ?? steps?.count ?? null,
    }) ?? derivedBB;
    const bbScore = scoreBodyBattery(currentEnergyReserve);

    // ── ACWR from workouts ──
    const activities = workoutRows.map(r => {
      const w = parseAppleHealthDataJson(r, userId);
      return {
        startTimeLocal: w.startDate ?? w.start,
        duration: w.duration ?? w.durationMinutes * 60,
      };
    });
    const { acuteLoad, chronicLoad, acwr } = computeAcwr(activities);
    const loadScore = scoreAcwr(acwr);

    // ── Composite ──
    //
    // Renormalise over the pillars that were ACTUALLY measured, not merely
    // over "everything except HRV". Dropping only HRV and dividing by 0.70
    // multiplied whatever survived by 1.43× — and `rhrScore` defaults to 70
    // while `scoreAcwr(NaN)` returns 60, so for the Garmin-only-on-iOS case
    // this work targets (one sleep row, no HRV, no RHR, no workouts) the
    // amplified terms were themselves placeholders. That produced a
    // confident-looking score built mostly from defaults.
    //
    // Body battery is derived from sleep and RHR, so it counts as measured
    // only when one of those exists. ACWR needs at least one workout.
    const measuredPillars = [
      { measured: hasMeasuredHrv, weight: 0.30, score: hrvScoreVal },
      { measured: totalSleepMin > 0, weight: 0.30, score: sleepScoreVal },
      { measured: totalSleepMin > 0 || todayRhr != null, weight: 0.20, score: bbScore },
      { measured: activities.length > 0, weight: 0.20, score: loadScore },
    ];
    const measuredWeight = measuredPillars.reduce((sum, p) => sum + (p.measured ? p.weight : 0), 0);
    const compositeScore = measuredWeight > 0
      ? clamp(Math.round(
        measuredPillars.reduce((sum, p) => sum + (p.measured ? p.score * p.weight : 0), 0) / measuredWeight,
      ), 0, 100)
      : NEUTRAL_FACTOR_SCORE;
    // Fraction of the scoring model backed by real readings, so a client can
    // show a degraded state rather than presenting a one-pillar score as
    // equivalent to a complete one.
    const coverage = Math.round(measuredWeight * 100) / 100;

    const factors: ReadinessFactors = {
      hrv: { todayMs: todayHrv, sevenDayAvgMs: weeklyHrv, trend: hrvTrend, score: hrvScoreVal },
      sleep: { durationHours: totalSleepMin / 60, qualityScore: derivedSleepScore, score: sleepScoreVal },
      bodyBattery: { current: currentEnergyReserve, morningPeak: derivedBB, score: bbScore },
      trainingLoad: { acuteLoad, chronicLoad, acwr, score: loadScore },
    };

    const recommendation = getRecommendation(compositeScore);
    // Say so when a pillar is missing. Garmin-only iOS users have no HRV in
    // HealthKit, and a score that silently rests on two of three recovery
    // signals should not read as confidently as a complete one.
    // Name only what was actually measured. The previous wording claimed
    // "sleep and resting heart rate" even when RHR was absent too.
    const measuredNames = [
      totalSleepMin > 0 ? 'sleep' : null,
      todayRhr != null ? 'resting heart rate' : null,
      activities.length > 0 ? 'training load' : null,
    ].filter(Boolean) as string[];
    const hrvCaveat = hasMeasuredHrv
      ? ''
      : measuredNames.length > 0
        ? ` No HRV in Apple Health today — recovery is inferred from ${measuredNames.join(' and ')} only (${Math.round(coverage * 100)}% signal coverage).`
        : ' No recovery signals in Apple Health today — this is a conservative default, not a measurement.';
    const reasoning = `Apple Health is driving today's readiness. ${buildReasoning(factors, recommendation)}${hrvCaveat}`;

    if (opts.publishSignals !== false) {
      // Publish signals (same as Garmin path)
      try {
        if (sleepScoreVal < 50 || totalSleepMin / 60 < 6) {
          publishLowSleep({ userId, tenantId: opts.tenantId, score: Math.round(sleepScoreVal), totalHours: totalSleepMin / 60 });
        }
        if (hrvTrend === 'down' && hrvScoreVal < 50 && weeklyHrv > 0) {
          publishLowHrv({ userId, tenantId: opts.tenantId, hrv_ms: todayHrv, baseline_ms: weeklyHrv });
        }
        if (compositeScore < 40) {
          publishLowReadiness({ userId, tenantId: opts.tenantId, score: compositeScore, reason: reasoning });
        }
      } catch (err) {
        logger.warn({ err, userId }, 'training-signals publish failed after Apple Health readiness');
      }
    }

    logger.info({ userId, score: compositeScore, provider: 'apple_health' }, 'Apple Health readiness calculated');
    return {
      score: compositeScore,
      factors,
      recommendation,
      reasoning,
      source: 'apple_health',
      coverage,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Apple Health readiness calculation failed');
    return null;
  }
}

// ── Main Calculator ─────────────────────────────────────────────────

// Short-lived per-user memo. Readiness inputs (sleep, HRV, body battery)
// change at most a few times per day, but three independent callers — the
// coach cron right after the briefing, weekly plan adjust, and the dashboard
// route — each re-fetched six Garmin endpoints (2026-07-03 audit). Garmin is
// rate-limit sensitive, so results are reused for 30 minutes unless the
// caller forces a refresh.
const READINESS_MEMO_TTL_MS = 30 * 60 * 1000;
const readinessMemo = new Map<string, { at: number; result: ReadinessResult }>();

export function _resetReadinessMemoForTests(): void {
  readinessMemo.clear();
}

export async function calculateReadiness(
  userId: number,
  opts: { tenantId?: number; garminSilent?: boolean; forceRefresh?: boolean } = {},
): Promise<ReadinessResult> {
  const tenantId = opts.tenantId ?? resolveCurrentTenantIdForUser(userId);
  const memoKey = `${tenantId}:${userId}`;
  // Memo is inert under vitest (same pattern as chat-action-retry-policy):
  // tests assert distinct results per scenario for the same userId.
  const memoDisabled = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  const memoized = readinessMemo.get(memoKey);
  if (!memoDisabled && !opts.forceRefresh && memoized && Date.now() - memoized.at < READINESS_MEMO_TTL_MS) {
    return memoized.result;
  }
  const result = await calculateReadinessUncached(userId, { ...opts, tenantId });
  if (!memoDisabled) readinessMemo.set(memoKey, { at: Date.now(), result });
  return result;
}

async function calculateReadinessUncached(
  userId: number,
  opts: { tenantId: number; garminSilent?: boolean },
): Promise<ReadinessResult> {
  // ── Provider priority: per-user Garmin → Apple Health → neutral ──
  // April 2026: Garmin is now a real per-user integration in iOS.
  // The old owner-only Telegram-era gate made Garmin appear connected
  // in the app while readiness/body battery stayed empty for non-owner
  // users. Only use Garmin when THIS user has an active Garmin session.
  //
  // July 2026: dropped the surviving `isGarminConfigured()` conjunct. That
  // read the deployment-wide GARMIN_EMAIL/GARMIN_PASSWORD pair, so unsetting
  // the owner's credentials silently downgraded every connected user to
  // Apple Health or a neutral score. Connection state is per-user truth.
  const canUseGarmin = hasActiveGarminConnection(userId);

  if (!canUseGarmin) {
    const today = new Date().toISOString().slice(0, 10);

    try {
      const wearableReadiness = await getWearableReadiness(userId, today);
      // Accept whichever provider the wearable service selected by its own
      // READINESS_PRIORITY. This used to demand `=== 'whoop'`, which threw
      // away a Fitbit snapshot the service had already fetched and dropped
      // the user to Apple Health or a neutral score. Apple Health keeps its
      // own richer derivation below, so it is not short-circuited here.
      // Require a usable score. Some adapters (Fitbit today) return a
      // snapshot with both `readinessScore` and `recoveryScore` null; the
      // fallback builder would turn that into a fabricated 60 stamped with
      // their provider name, hiding the honest "no wearable data" signal.
      const hasUsableScore = wearableReadiness != null
        && (wearableReadiness.readinessScore != null || wearableReadiness.recoveryScore != null);
      if (wearableReadiness && hasUsableScore && wearableReadiness.provider !== 'apple_health') {
        logger.info(
          { userId, score: wearableReadiness.readinessScore, provider: wearableReadiness.provider },
          'Wearable readiness calculated',
        );
        return buildWearableFallbackReadiness(wearableReadiness);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Wearable readiness fallback failed');
    }

    // Try Apple Health derived readiness
    const appleResult = await calculateAppleHealthReadiness(userId, { tenantId: opts.tenantId });
    if (appleResult) return appleResult;

    // No data from any provider — return neutral
    const neutralFactors: ReadinessFactors = {
      hrv: { todayMs: 0, sevenDayAvgMs: 0, trend: 'stable', score: 60 },
      sleep: { durationHours: 0, qualityScore: 0, score: 60 },
      bodyBattery: { current: 0, morningPeak: 0, score: 60 },
      trainingLoad: { acuteLoad: 0, chronicLoad: 0, acwr: 1.0, score: 60 },
    };
    return {
      score: 60,
      factors: neutralFactors,
      recommendation: getRecommendation(60),
      reasoning: 'No wearable connected — using conservative default readiness. Connect Garmin or Apple Health for personalized adjustments.',
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      source: 'estimated',
      asOf: new Date().toISOString(),
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  const garminReadOptions: GarminReadOptions = { silent: opts.garminSilent };
  const [hrvResult, sleepResult, bbResult, , activitiesResult, summaryResult] = await runWithContext(
    { source: 'manual', userId },
    () => Promise.allSettled([
      getHrvData(today, garminReadOptions),
      getSleepData(today, garminReadOptions),
      getBodyBatteryEvents(today, garminReadOptions),
      getTrainingReadiness(today, garminReadOptions),
      getActivitiesByDate(subtractDays(today, 28), today, garminReadOptions),
      getDailySummary(today, garminReadOptions),
    ]),
  );

  // ── Extract HRV ──
  const hrvRaw = hrvResult.status === 'fulfilled' ? hrvResult.value as any : null;
  const todayHrv = hrvRaw?.hrvSummary?.lastNightAvg ?? hrvRaw?.lastNightAvg ?? 0;
  const weeklyHrv = hrvRaw?.hrvSummary?.weeklyAvg ?? hrvRaw?.weeklyAvg ?? todayHrv;
  const hrvTrend: 'up' | 'stable' | 'down' = todayHrv > weeklyHrv * 1.05 ? 'up' : todayHrv < weeklyHrv * 0.95 ? 'down' : 'stable';
  const hrvScore = scoreHrv(todayHrv || 60, weeklyHrv || 60);

  // ── Extract Sleep ──
  const sleepRaw = sleepResult.status === 'fulfilled' ? sleepResult.value as any : null;
  const hasSleepData =
    sleepRaw?.dailySleepDTO?.sleepTimeSeconds != null
    || sleepRaw?.sleepTimeSeconds != null
    || sleepRaw?.dailySleepDTO?.overallSleepScore != null
    || sleepRaw?.overallSleepScore != null;
  const sleepDuration = (sleepRaw?.dailySleepDTO?.sleepTimeSeconds ?? sleepRaw?.sleepTimeSeconds ?? 0) / 3600;
  const garminSleepQuality = sleepRaw?.dailySleepDTO?.overallSleepScore ?? sleepRaw?.overallSleepScore ?? null;
  const sleepScore = scoreSleep(sleepDuration, garminSleepQuality);

  // ── Extract Body Battery ──
  const bbRaw = bbResult.status === 'fulfilled' ? bbResult.value as any : null;
  const summaryRaw = summaryResult.status === 'fulfilled' ? summaryResult.value as any : null;
  const bbSnapshot = extractGarminBodyBatterySnapshot(bbRaw, summaryRaw);
  const garminBodyBatteryCurrent = bbSnapshot.current != null && bbSnapshot.current > 0
    ? bbSnapshot.current
    : null;
  const appleHealthBodyBatteryFallback = garminBodyBatteryCurrent == null
    ? await calculateAppleHealthReadiness(userId, { tenantId: opts.tenantId, publishSignals: false })
    : null;
  const appleHealthBattery = appleHealthBodyBatteryFallback?.factors.bodyBattery ?? null;
  const appleHealthCurrent = appleHealthBattery?.current != null && appleHealthBattery.current > 0
    ? appleHealthBattery.current
    : null;
  const appleHealthMorningPeak = appleHealthBattery?.morningPeak != null && appleHealthBattery.morningPeak > 0
    ? appleHealthBattery.morningPeak
    : null;
  const garminMorningPeak = bbSnapshot.morningPeak != null && bbSnapshot.morningPeak > 0
    ? bbSnapshot.morningPeak
    : null;
  const garminHighest = bbSnapshot.highest != null && bbSnapshot.highest > 0
    ? bbSnapshot.highest
    : null;
  const bbCurrent = garminBodyBatteryCurrent ?? appleHealthCurrent ?? 0;
  const bbMorningPeak = garminMorningPeak ?? garminHighest ?? appleHealthMorningPeak ?? bbCurrent;
  const bbScore = bbCurrent > 0 ? scoreBodyBattery(bbCurrent) : 60;
  const usedAppleHealthBodyBatteryFallback = garminBodyBatteryCurrent == null && appleHealthCurrent != null;

  // ── Compute ACWR from activities ──
  const activities = activitiesResult.status === 'fulfilled' ? (activitiesResult.value as any[]) ?? [] : [];
  const { acuteLoad, chronicLoad, acwr } = computeAcwr(activities);
  const loadScore = scoreAcwr(acwr);

  // ── Composite Score ──
  const compositeScore = clamp(Math.round(
    hrvScore * 0.30 +
    sleepScore * 0.30 +
    bbScore * 0.20 +
    loadScore * 0.20
  ), 0, 100);

  const factors: ReadinessFactors = {
    hrv: { todayMs: todayHrv, sevenDayAvgMs: weeklyHrv, trend: hrvTrend, score: hrvScore },
    sleep: { durationHours: sleepDuration, qualityScore: garminSleepQuality ?? 0, score: sleepScore },
    bodyBattery: { current: bbCurrent, morningPeak: bbMorningPeak, score: bbScore },
    trainingLoad: { acuteLoad, chronicLoad, acwr, score: loadScore },
  };

  const recommendation = getRecommendation(compositeScore);
  const reasoning = usedAppleHealthBodyBatteryFallback
    ? `${buildReasoning(factors, recommendation)} Apple Health filled Body Battery because Garmin did not provide it today.`
    : buildReasoning(factors, recommendation);

  // ─── Phase 1 Slice B — Signal B publishing ───
  // Fan out per-factor wellness signals so sport coaches can adapt
  // their prescriptions without re-running the full Garmin pipeline.
  // Wrapped in try/catch — signal publishing must never break scoring.
  try {
    // low_sleep: trigger when sleep score is poor OR total hours are short
    if (hasSleepData && (sleepScore < 50 || sleepDuration < 6)) {
      publishLowSleep({
        userId,
        tenantId: opts.tenantId,
        score: Math.round(sleepScore),
        totalHours: sleepDuration,
      });
    }
    // low_hrv: trigger when HRV is down vs baseline AND scored poor
    if (hrvTrend === 'down' && hrvScore < 50 && weeklyHrv > 0) {
      publishLowHrv({
        userId,
        tenantId: opts.tenantId,
        hrv_ms: todayHrv,
        baseline_ms: weeklyHrv,
      });
    }
    // low_readiness: composite below the reduce_25pct cutoff (40)
    if (compositeScore < 40) {
      publishLowReadiness({
        userId,
        tenantId: opts.tenantId,
        score: compositeScore,
        reason: reasoning,
      });
    }
  } catch (err) {
    logger.warn({ err, userId }, 'training-signals publish failed after calculateReadiness');
  }

  return { score: compositeScore, factors, recommendation, reasoning, source: 'garmin', asOf: new Date().toISOString() };
}

// ── Persistence ─────────────────────────────────────────────────────

export function persistReadinessScore(userId: number, result: ReadinessResult): void {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT OR REPLACE INTO readiness_scores (user_id, date, score, factors, recommendation)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, today, result.score, JSON.stringify(result.factors), result.recommendation);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to persist readiness score');
  }
}

export function getRecentReadinessScores(userId: number, days = 7): Array<{ date: string; score: number; recommendation: string }> {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT date, score, recommendation FROM readiness_scores
      WHERE user_id = ? ORDER BY date DESC LIMIT ?
    `).all(userId, days) as any[];
  } catch {
    return [];
  }
}
