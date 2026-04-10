// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Body Battery synthesis — computes a Garmin-like 0-100 score from
// Apple Health signals when the user doesn't have a Garmin device.
//
// ## What is Body Battery?
//
// Garmin's Body Battery is a proprietary 0-100 energy reserve score
// that trends DOWN during stress/activity and UP during sleep/rest.
// Apple Health has no equivalent, so we synthesize one from the
// available signals:
//
//   HRV (SDNN)     → parasympathetic recovery indicator
//   Resting HR      → lower = better recovery
//   Sleep duration   → more sleep = more recharge
//   Sleep quality    → deep+REM ratio
//   Activity load    → more activity = more drain
//
// ## Algorithm overview (simplified Garmin approximation)
//
// We use a weighted composite model where:
//
//   1. HRV score (0-30): higher HRV relative to personal baseline = better
//   2. RHR score (0-20): lower RHR relative to personal baseline = better
//   3. Sleep score (0-30): combination of duration + deep+REM ratio
//   4. Activity drain (0-20): less intense activity in last 24h = higher battery
//
// Each component is normalized to its own 0-N range, then summed to
// give a 0-100 composite. The "personal baseline" is approximated by
// a 7-day rolling average — a proper Garmin-style baseline would need
// 21 days of data, but for the beta we start useful results on day 2.
//
// This is deliberately SIMPLE. The goal is to give Apple Health users
// a "battery" metaphor that's useful for training decisions, not to
// replicate Garmin's exact Firstbeat algorithm (which uses raw IBI
// data we don't have access to via HealthKit).

import { logger } from '../../utils/logger';
import { getDb } from '../database';

interface BodyBatteryInput {
  userId: number;
  date: string; // YYYY-MM-DD
}

interface BodyBatteryResult {
  score: number;        // 0-100 composite
  components: {
    hrv: number;        // 0-30
    rhr: number;        // 0-20
    sleep: number;      // 0-30
    activity: number;   // 0-20
  };
  trend: 'charging' | 'draining' | 'stable';
  confidence: 'low' | 'medium' | 'high'; // Based on data availability
}

/**
 * Compute a synthesized Body Battery score from Apple Health data
 * in the `apple_health_data` table.
 *
 * Returns null if there's insufficient data (e.g., user just
 * connected HealthKit and only has 1 day of history).
 */
export function computeBodyBattery(input: BodyBatteryInput): BodyBatteryResult | null {
  const { userId, date } = input;
  const db = getDb();

  // ── Fetch today's data ─────────────────────────────────────
  const todayData = fetchDayData(db, userId, date);
  if (!todayData.hrv && !todayData.sleep && !todayData.rhr) {
    // Not enough data for any meaningful score
    return null;
  }

  // ── Fetch 7-day baseline (for relative scoring) ────────────
  const baseline = fetch7DayBaseline(db, userId, date);

  // ── Component 1: HRV score (0-30) ─────────────────────────
  // Higher HRV = better recovery. Score relative to 7-day average.
  let hrvScore = 15; // neutral default
  if (todayData.hrv != null) {
    if (baseline.avgHrv > 0) {
      // Ratio-based: HRV 20% above average → full 30, 20% below → 0
      const ratio = todayData.hrv / baseline.avgHrv;
      hrvScore = Math.round(Math.min(30, Math.max(0, (ratio - 0.8) * 75)));
    } else {
      // No baseline yet — use absolute population norms
      // Average adult HRV is ~30-60ms. Map to 0-30 score.
      hrvScore = Math.round(Math.min(30, Math.max(0, (todayData.hrv - 15) * 0.75)));
    }
  }

  // ── Component 2: RHR score (0-20) ──────────────────────────
  // Lower RHR = better recovery. Inverse relationship.
  let rhrScore = 10; // neutral
  if (todayData.rhr != null) {
    if (baseline.avgRhr > 0) {
      // RHR 10% below average → full 20, 10% above → 0
      const ratio = todayData.rhr / baseline.avgRhr;
      rhrScore = Math.round(Math.min(20, Math.max(0, (1.1 - ratio) * 200)));
    } else {
      // Population norms: 60-80 bpm resting is average
      rhrScore = Math.round(Math.min(20, Math.max(0, (80 - todayData.rhr) * 0.5)));
    }
  }

  // ── Component 3: Sleep score (0-30) ────────────────────────
  // Combination of duration + quality (deep + REM ratio).
  let sleepScore = 15; // neutral
  if (todayData.sleep) {
    const { totalMinutes, deepMinutes, remMinutes } = todayData.sleep;

    // Duration score (0-15): 7-9h is optimal (420-540 min)
    const durationNorm = Math.min(1, Math.max(0, (totalMinutes - 240) / 300)); // 4h→0, 9h→1
    const durationScore = Math.round(durationNorm * 15);

    // Quality score (0-15): deep+REM should be ~40% of total sleep
    const qualityRatio = totalMinutes > 0 ? (deepMinutes + remMinutes) / totalMinutes : 0;
    const qualityNorm = Math.min(1, qualityRatio / 0.4); // 40% deep+REM → full score
    const qualityScore = Math.round(qualityNorm * 15);

    sleepScore = durationScore + qualityScore;
  }

  // ── Component 4: Activity drain (0-20) ─────────────────────
  // Less intense activity in last 24h = higher battery (resting)
  // More activity = lower battery (spent energy)
  let activityScore = 15; // moderate default (some activity is normal)
  if (todayData.calories != null) {
    // Active calories: 0-200 kcal → high battery (rest day),
    // 200-600 → moderate, 600+ → low (hard training day)
    if (todayData.calories < 100) activityScore = 20;
    else if (todayData.calories < 300) activityScore = 15;
    else if (todayData.calories < 600) activityScore = 10;
    else activityScore = 5;
  }

  // ── Composite ──────────────────────────────────────────────
  const score = Math.min(100, Math.max(0, hrvScore + rhrScore + sleepScore + activityScore));

  // ── Trend (compared to yesterday's score) ──────────────────
  const yesterdayDate = subtractDay(date);
  const yesterdayResult = fetchStoredScore(db, userId, yesterdayDate);
  let trend: 'charging' | 'draining' | 'stable' = 'stable';
  if (yesterdayResult != null) {
    const delta = score - yesterdayResult;
    if (delta > 5) trend = 'charging';
    else if (delta < -5) trend = 'draining';
  }

  // ── Confidence ─────────────────────────────────────────────
  let dataPoints = 0;
  if (todayData.hrv != null) dataPoints++;
  if (todayData.rhr != null) dataPoints++;
  if (todayData.sleep) dataPoints++;
  if (todayData.calories != null) dataPoints++;
  const confidence: 'low' | 'medium' | 'high' =
    dataPoints >= 3 ? 'high' : dataPoints >= 2 ? 'medium' : 'low';

  // ── Persist for trend tracking ─────────────────────────────
  try {
    db.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'body_battery', ?, 'computed')
      ON CONFLICT(user_id, date, data_type)
      DO UPDATE SET data_json = excluded.data_json, synced_at = datetime('now')
    `).run(userId, date, JSON.stringify({ score, components: { hrv: hrvScore, rhr: rhrScore, sleep: sleepScore, activity: activityScore }, trend, confidence }));
  } catch (err) {
    logger.warn({ err }, 'Failed to persist body battery score (non-critical)');
  }

  return { score, components: { hrv: hrvScore, rhr: rhrScore, sleep: sleepScore, activity: activityScore }, trend, confidence };
}

// ── Data fetchers ────────────────────────────────────────────────

interface DayData {
  hrv: number | null;
  rhr: number | null;
  sleep: { totalMinutes: number; deepMinutes: number; remMinutes: number } | null;
  calories: number | null;
  steps: number | null;
}

function fetchDayData(db: ReturnType<typeof getDb>, userId: number, date: string): DayData {
  const rows = db.prepare(`
    SELECT data_type, data_json FROM apple_health_data
    WHERE user_id = ? AND date = ? AND data_type IN ('hrv', 'resting_hr', 'sleep', 'calories', 'steps')
  `).all(userId, date) as Array<{ data_type: string; data_json: string }>;

  const result: DayData = { hrv: null, rhr: null, sleep: null, calories: null, steps: null };
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json);
      switch (row.data_type) {
        case 'hrv': result.hrv = data.sdnn_ms; break;
        case 'resting_hr': result.rhr = data.bpm; break;
        case 'sleep': result.sleep = { totalMinutes: data.totalMinutes, deepMinutes: data.deepMinutes, remMinutes: data.remMinutes }; break;
        case 'calories': result.calories = data.kcal; break;
        case 'steps': result.steps = data.count; break;
      }
    } catch { /* skip malformed JSON */ }
  }
  return result;
}

interface Baseline {
  avgHrv: number;
  avgRhr: number;
}

function fetch7DayBaseline(db: ReturnType<typeof getDb>, userId: number, date: string): Baseline {
  const startDate = subtractDays(date, 7);
  const hrvRows = db.prepare(`
    SELECT data_json FROM apple_health_data
    WHERE user_id = ? AND date >= ? AND date < ? AND data_type = 'hrv'
    ORDER BY date DESC
  `).all(userId, startDate, date) as Array<{ data_json: string }>;

  const rhrRows = db.prepare(`
    SELECT data_json FROM apple_health_data
    WHERE user_id = ? AND date >= ? AND date < ? AND data_type = 'resting_hr'
    ORDER BY date DESC
  `).all(userId, startDate, date) as Array<{ data_json: string }>;

  const hrvValues = hrvRows.map(r => { try { return JSON.parse(r.data_json).sdnn_ms; } catch { return null; } }).filter((v): v is number => v != null);
  const rhrValues = rhrRows.map(r => { try { return JSON.parse(r.data_json).bpm; } catch { return null; } }).filter((v): v is number => v != null);

  return {
    avgHrv: hrvValues.length > 0 ? hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length : 0,
    avgRhr: rhrValues.length > 0 ? rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length : 0,
  };
}

function fetchStoredScore(db: ReturnType<typeof getDb>, userId: number, date: string): number | null {
  const row = db.prepare(`
    SELECT data_json FROM apple_health_data
    WHERE user_id = ? AND date = ? AND data_type = 'body_battery'
  `).get(userId, date) as { data_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.data_json).score; } catch { return null; }
}

// ── Date helpers ─────────────────────────────────────────────────

function subtractDay(dateStr: string): string {
  return subtractDays(dateStr, 1);
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
