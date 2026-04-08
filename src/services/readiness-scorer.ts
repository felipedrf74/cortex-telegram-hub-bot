// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Readiness Scorer — aggregates Garmin HRV, sleep, body battery, and training load
 * into a 0-100 composite score with intensity recommendations.
 *
 * Weights: HRV 30%, Sleep 30%, Body Battery 20%, Training Load (ACWR) 20%.
 */

import { getDb } from './database';
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

// ── Main Calculator ─────────────────────────────────────────────────

export async function calculateReadiness(userId: number): Promise<ReadinessResult> {
  if (!isGarminConfigured()) {
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
      reasoning: 'Garmin not connected — using default readiness. Connect Garmin for personalized adjustments.',
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
