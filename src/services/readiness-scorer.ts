// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Readiness Scorer — aggregates Garmin HRV, sleep, body battery, and training load
 * into a 0-100 composite score with intensity recommendations.
 *
 * Weights: HRV 30%, Sleep 30%, Body Battery 20%, Training Load (ACWR) 20%.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  isGarminConfigured,
  getHrvData, getSleepData, getBodyBatteryEvents,
  getTrainingReadiness, getActivitiesByDate,
} from './garmin';
import {
  publishLowSleep,
  publishLowHrv,
  publishLowReadiness,
} from './training-signals';

// ── Types ───────────────────────────────────────────────────────────

export interface ReadinessFactors {
  hrv: { todayMs: number; sevenDayAvgMs: number; trend: 'up' | 'stable' | 'down'; score: number };
  sleep: { durationHours: number; qualityScore: number; score: number };
  bodyBattery: { current: number; morningPeak: number; score: number };
  trainingLoad: { acuteLoad: number; chronicLoad: number; acwr: number; score: number };
}

export type ReadinessRecommendation = 'full_intensity' | 'reduce_10pct' | 'reduce_25pct' | 'active_recovery' | 'rest_day';

export interface ReadinessResult {
  score: number;
  factors: ReadinessFactors;
  recommendation: ReadinessRecommendation;
  reasoning: string;
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
  if (garminQuality != null && garminQuality > 0) {
    return clamp(garminQuality, 0, 100);
  }
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
  if (acwr > 1.5) return 20;     // injury risk — deload
  if (acwr > 1.2) return 50;     // moderate risk
  if (acwr >= 0.8) return 85;    // sweet spot
  return 70;                      // under-training
}

function computeAcwr(activities: any[]): { acuteLoad: number; chronicLoad: number; acwr: number } {
  const now = Date.now();
  const msPerDay = 86400000;

  let acuteLoad = 0;
  let chronicLoad = 0;

  for (const a of activities) {
    const actDate = new Date(a.startTimeLocal || a.startTimeGMT || a.beginTimestamp).getTime();
    const daysAgo = (now - actDate) / msPerDay;
    const stress = a.activityTrainingLoad || a.trainingEffectLabel ? 50 : (a.duration ? a.duration / 60 : 30);

    if (daysAgo <= 7) acuteLoad += stress;
    if (daysAgo <= 28) chronicLoad += stress;
  }

  // Normalize to per-day averages
  const acuteAvg = acuteLoad / 7;
  const chronicAvg = chronicLoad / 28;
  const acwr = chronicAvg > 0 ? acuteAvg / chronicAvg : 1.0;

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
 * Derive a "body battery equivalent" (energy reserve) from Apple Health signals.
 * Garmin's Body Battery is proprietary. We approximate it using:
 *   - Sleep quality (40%) — good sleep = high morning energy
 *   - HRV status (30%) — high HRV = good recovery = high energy
 *   - RHR trend (30%) — low RHR = good cardiovascular fitness = efficient energy
 */
export function deriveBodyBatteryEquivalent(
  sleepScore: number,
  hrvScore: number,
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
async function calculateAppleHealthReadiness(userId: number): Promise<ReadinessResult | null> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Read HRV (today)
    const hrvRow = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'hrv' AND date = ? ORDER BY created_at DESC LIMIT 1",
    ).get(userId, today) as { data_json: string } | undefined;

    // Read HRV baseline (7-day average)
    const hrvHistory = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'hrv' AND date > ? ORDER BY date DESC LIMIT 7",
    ).all(userId, subtractDays(today, 8)) as Array<{ data_json: string }>;

    // Read sleep (today)
    const sleepRow = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'sleep' AND date = ? ORDER BY created_at DESC LIMIT 1",
    ).get(userId, today) as { data_json: string } | undefined;

    // Read RHR (today)
    const rhrRow = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'resting_heart_rate' AND date = ? ORDER BY created_at DESC LIMIT 1",
    ).get(userId, today) as { data_json: string } | undefined;

    // Read RHR baseline (7-day average)
    const rhrHistory = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'resting_heart_rate' AND date > ? ORDER BY date DESC LIMIT 7",
    ).all(userId, subtractDays(today, 8)) as Array<{ data_json: string }>;

    // Read workouts for ACWR (28 days)
    const workoutRows = db.prepare(
      "SELECT data_json FROM apple_health_data WHERE user_id = ? AND data_type = 'workout' AND date > ? ORDER BY date ASC",
    ).all(userId, subtractDays(today, 29)) as Array<{ data_json: string }>;

    // If no data at all, can't compute
    if (!hrvRow && !sleepRow && !rhrRow) return null;

    // ── HRV ──
    const todayHrv = hrvRow ? (JSON.parse(hrvRow.data_json)?.value ?? 0) : 0;
    const hrvValues = hrvHistory.map(r => JSON.parse(r.data_json)?.value ?? 0).filter((v: number) => v > 0);
    const weeklyHrv = hrvValues.length > 0 ? hrvValues.reduce((a: number, b: number) => a + b, 0) / hrvValues.length : todayHrv;
    const hrvTrend: 'up' | 'stable' | 'down' = todayHrv > weeklyHrv * 1.05 ? 'up' : todayHrv < weeklyHrv * 0.95 ? 'down' : 'stable';
    const hrvScoreVal = scoreHrv(todayHrv || 60, weeklyHrv || 60);

    // ── Sleep ──
    const sleepData = sleepRow ? JSON.parse(sleepRow.data_json) : null;
    const totalSleepMin = sleepData ? (sleepData.totalSleepSeconds ?? 0) / 60 : 0;
    const deepSleepMin = sleepData ? (sleepData.deepSleepSeconds ?? 0) / 60 : 0;
    const remSleepMin = sleepData ? (sleepData.remSleepSeconds ?? 0) / 60 : 0;
    const derivedSleepScore = totalSleepMin > 0
      ? deriveAppleHealthSleepScore(totalSleepMin, deepSleepMin, remSleepMin)
      : 60;
    const sleepScoreVal = scoreSleep(totalSleepMin / 60, derivedSleepScore);

    // ── RHR ──
    const todayRhr = rhrRow ? (JSON.parse(rhrRow.data_json)?.value ?? null) : null;
    const rhrValues = rhrHistory.map(r => JSON.parse(r.data_json)?.value ?? 0).filter((v: number) => v > 0);
    const rhrBaseline = rhrValues.length > 0 ? rhrValues.reduce((a: number, b: number) => a + b, 0) / rhrValues.length : null;

    // ── Derived Body Battery ──
    const derivedBB = deriveBodyBatteryEquivalent(derivedSleepScore, hrvScoreVal, todayRhr, rhrBaseline);
    const bbScore = scoreBodyBattery(derivedBB);

    // ── ACWR from workouts ──
    const activities = workoutRows.map(r => {
      const w = JSON.parse(r.data_json);
      return {
        startTimeLocal: w.startDate ?? w.start,
        duration: w.duration ?? w.durationMinutes * 60,
      };
    });
    const { acuteLoad, chronicLoad, acwr } = computeAcwr(activities);
    const loadScore = scoreAcwr(acwr);

    // ── Composite ──
    const compositeScore = clamp(Math.round(
      hrvScoreVal * 0.30 +
      sleepScoreVal * 0.30 +
      bbScore * 0.20 +
      loadScore * 0.20
    ), 0, 100);

    const factors: ReadinessFactors = {
      hrv: { todayMs: todayHrv, sevenDayAvgMs: weeklyHrv, trend: hrvTrend, score: hrvScoreVal },
      sleep: { durationHours: totalSleepMin / 60, qualityScore: derivedSleepScore, score: sleepScoreVal },
      bodyBattery: { current: derivedBB, morningPeak: derivedBB, score: bbScore },
      trainingLoad: { acuteLoad, chronicLoad, acwr, score: loadScore },
    };

    const recommendation = getRecommendation(compositeScore);
    const reasoning = buildReasoning(factors, recommendation);

    // Publish signals (same as Garmin path)
    try {
      if (sleepScoreVal < 50 || totalSleepMin / 60 < 6) {
        publishLowSleep({ userId, score: Math.round(sleepScoreVal), totalHours: totalSleepMin / 60 });
      }
      if (hrvTrend === 'down' && hrvScoreVal < 50 && weeklyHrv > 0) {
        publishLowHrv({ userId, hrv_ms: todayHrv, baseline_ms: weeklyHrv });
      }
      if (compositeScore < 40) {
        publishLowReadiness({ userId, score: compositeScore, reason: reasoning });
      }
    } catch (err) {
      logger.warn({ err, userId }, 'training-signals publish failed after Apple Health readiness');
    }

    logger.info({ userId, score: compositeScore, provider: 'apple_health' }, 'Apple Health readiness calculated');
    return { score: compositeScore, factors, recommendation, reasoning };
  } catch (err) {
    logger.warn({ err, userId }, 'Apple Health readiness calculation failed');
    return null;
  }
}

// ── Main Calculator ─────────────────────────────────────────────────

export async function calculateReadiness(userId: number): Promise<ReadinessResult> {
  // ── Provider priority: Garmin (owner only) → Apple Health (per-user) → neutral ──
  // Garmin data is server-level (single Garmin account connected to the backend).
  // Only the owner should see Garmin data. Other users get Apple Health or neutral.
  const ownerTelegramIds = config.telegram?.allowedUserIds || [];
  let isGarminOwner = ownerTelegramIds.includes(userId);
  if (!isGarminOwner) {
    try {
      const db = require('./database').getDb();
      const user = db.prepare('SELECT telegram_id, tier FROM users WHERE id = ?').get(userId) as any;
      if (user?.telegram_id && ownerTelegramIds.includes(user.telegram_id)) isGarminOwner = true;
      if (user?.tier === 'owner') isGarminOwner = true;
    } catch {}
  }

  if (!isGarminConfigured() || !isGarminOwner) {
    // Try Apple Health derived readiness
    const appleResult = await calculateAppleHealthReadiness(userId);
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
      recommendation: 'full_intensity',
      reasoning: 'No wearable connected — using default readiness. Connect Garmin or Apple Health for personalized adjustments.',
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  const [hrvResult, sleepResult, bbResult, , activitiesResult] = await Promise.allSettled([
    getHrvData(today),
    getSleepData(today),
    getBodyBatteryEvents(today),
    getTrainingReadiness(today),
    getActivitiesByDate(subtractDays(today, 28), today),
  ]);

  // ── Extract HRV ──
  const hrvRaw = hrvResult.status === 'fulfilled' ? hrvResult.value as any : null;
  const todayHrv = hrvRaw?.hrvSummary?.lastNightAvg ?? hrvRaw?.lastNightAvg ?? 0;
  const weeklyHrv = hrvRaw?.hrvSummary?.weeklyAvg ?? hrvRaw?.weeklyAvg ?? todayHrv;
  const hrvTrend: 'up' | 'stable' | 'down' = todayHrv > weeklyHrv * 1.05 ? 'up' : todayHrv < weeklyHrv * 0.95 ? 'down' : 'stable';
  const hrvScore = scoreHrv(todayHrv || 60, weeklyHrv || 60);

  // ── Extract Sleep ──
  const sleepRaw = sleepResult.status === 'fulfilled' ? sleepResult.value as any : null;
  const sleepDuration = (sleepRaw?.dailySleepDTO?.sleepTimeSeconds ?? sleepRaw?.sleepTimeSeconds ?? 0) / 3600;
  const garminSleepQuality = sleepRaw?.dailySleepDTO?.overallSleepScore ?? sleepRaw?.overallSleepScore ?? null;
  const sleepScore = scoreSleep(sleepDuration, garminSleepQuality);

  // ── Extract Body Battery ──
  const bbRaw = bbResult.status === 'fulfilled' ? bbResult.value as any : null;
  const bbEvents = Array.isArray(bbRaw) ? bbRaw : (bbRaw?.bodyBatteryEvents ?? bbRaw?.events ?? []);
  const bbValues = bbEvents.map((e: any) => e.bodyBatteryLevel ?? e.value ?? 0).filter((v: number) => v > 0);
  const bbCurrent = bbValues.length > 0 ? bbValues[bbValues.length - 1] : 50;
  const bbMorningPeak = bbValues.length > 0 ? Math.max(...bbValues.slice(0, Math.ceil(bbValues.length / 3))) : 50;
  const bbScore = scoreBodyBattery(bbCurrent);

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
  const reasoning = buildReasoning(factors, recommendation);

  // ─── Phase 1 Slice B — Signal B publishing ───
  // Fan out per-factor wellness signals so sport coaches can adapt
  // their prescriptions without re-running the full Garmin pipeline.
  // Wrapped in try/catch — signal publishing must never break scoring.
  try {
    // low_sleep: trigger when sleep score is poor OR total hours are short
    if (sleepScore < 50 || sleepDuration < 6) {
      publishLowSleep({
        userId,
        score: Math.round(sleepScore),
        totalHours: sleepDuration,
      });
    }
    // low_hrv: trigger when HRV is down vs baseline AND scored poor
    if (hrvTrend === 'down' && hrvScore < 50 && weeklyHrv > 0) {
      publishLowHrv({
        userId,
        hrv_ms: todayHrv,
        baseline_ms: weeklyHrv,
      });
    }
    // low_readiness: composite below the reduce_25pct cutoff (40)
    if (compositeScore < 40) {
      publishLowReadiness({
        userId,
        score: compositeScore,
        reason: reasoning,
      });
    }
  } catch (err) {
    logger.warn({ err, userId }, 'training-signals publish failed after calculateReadiness');
  }

  return { score: compositeScore, factors, recommendation, reasoning };
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
