// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Apple Health Adapter — reads from local SQLite cache.
 *
 * Apple Health has no API. Data arrives via XML export upload,
 * parsed and stored in the `apple_health_data` table. This adapter
 * reads from that cached data.
 */

import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { scoreSleep } from '../readiness-scorer';
import { deriveIntradayEnergyReserve } from './energy-reserve';
import type { WearableAdapter } from './adapter-interface';
import type {
  WearableProvider,
  ProviderCapabilities,
  NormalizedActivity,
  NormalizedSleep,
  NormalizedReadiness,
  NormalizedDailySummary,
  ActivityType,
} from './types';

// ─── Type Mapping ──────────────────────────────────────────────────

const APPLE_TYPE_MAP: Record<string, ActivityType> = {
  HKWorkoutActivityTypeRunning: 'run',
  HKWorkoutActivityTypeCycling: 'ride',
  HKWorkoutActivityTypeSwimming: 'swim',
  HKWorkoutActivityTypeTraditionalStrengthTraining: 'strength',
  HKWorkoutActivityTypeFunctionalStrengthTraining: 'strength',
  HKWorkoutActivityTypeWalking: 'walk',
  HKWorkoutActivityTypeHiking: 'hike',
  HKWorkoutActivityTypeYoga: 'yoga',
  HKWorkoutActivityTypeElliptical: 'elliptical',
  HKWorkoutActivityTypeRowing: 'rowing',
};

function mapAppleType(type: string): ActivityType {
  return APPLE_TYPE_MAP[type] ?? 'other';
}

function parseMetricValue(payload: any, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

// ─── Adapter ───────────────────────────────────────────────────────

export class AppleHealthAdapter implements WearableAdapter {
  readonly provider: WearableProvider = 'apple_health';
  readonly capabilities: ProviderCapabilities = {
    activities: true,
    sleep: true,
    readiness: true,
    dailySummary: true,
  };

  async isConfigured(userId: number): Promise<boolean> {
    try {
      const db = getDb();
      // Check if there's any data for this user within the last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];
      const row = db.prepare(
        'SELECT 1 FROM apple_health_data WHERE user_id = ? AND date >= ? LIMIT 1'
      ).get(userId, thirtyDaysAgo);
      return !!row;
    } catch {
      return false;
    }
  }

  async getActivities(userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]> {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT data_json, data_type FROM apple_health_data
         WHERE user_id = ? AND data_type IN ('workout', 'workouts') AND date BETWEEN ? AND ?
         ORDER BY date ASC`
      ).all(userId, startDate, endDate) as Array<{ data_json: string; data_type: string }>;

      return rows.flatMap((row, rowIndex) => {
        const parsed = JSON.parse(row.data_json);
        const workouts = Array.isArray(parsed) ? parsed : [parsed];

        return workouts.map((workout, workoutIndex) => {
          const workoutType = workout.workoutActivityType ?? workout.activityTypeName ?? workout.activityType ?? '';
          const durationMinutes = workout.durationMinutes ?? workout.duration ?? 0;
          return {
            id: `apple-${workout.workoutId ?? `${rowIndex}-${workoutIndex}`}`,
            provider: 'apple_health' as WearableProvider,
            type: mapAppleType(workoutType),
            name: workoutType.replace('HKWorkoutActivityType', '') || 'Workout',
            startTime: workout.startDate ?? workout.start ?? '',
            endTime: workout.endDate ?? workout.end ?? null,
            durationSeconds: Math.round(durationMinutes * 60),
            distanceMeters: workout.totalDistance ?? null,
            calories: workout.totalEnergyBurned ?? null,
            avgHeartRate: workout.averageHeartRate ?? null,
            maxHeartRate: workout.maxHeartRate ?? null,
            avgCadence: null,
            avgSpeedMps: null,
            elevationGainMeters: workout.elevationAscended ?? null,
            raw: workout,
          };
        });
      });
    } catch (err) {
      logger.warn({ err, userId }, 'Apple Health activities read failed');
      return [];
    }
  }

  async getSleep(userId: number, date: string): Promise<NormalizedSleep | null> {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'sleep' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      if (!row) return null;
      const s = JSON.parse(row.data_json);
      const totalSleepSeconds = parseMetricValue(s, 'totalSleepSeconds')
        ?? ((parseMetricValue(s, 'totalMinutes') ?? 0) * 60);
      const deepSleepSeconds = parseMetricValue(s, 'deepSleepSeconds')
        ?? ((parseMetricValue(s, 'deepMinutes') ?? 0) * 60);
      const remSleepSeconds = parseMetricValue(s, 'remSleepSeconds')
        ?? ((parseMetricValue(s, 'remMinutes') ?? 0) * 60);
      const awakeSleepSeconds = parseMetricValue(s, 'awakeSleepSeconds');
      const lightSleepSeconds = parseMetricValue(s, 'coreSleepSeconds', 'lightSleepSeconds')
        ?? Math.max(0, totalSleepSeconds - deepSleepSeconds - remSleepSeconds - (awakeSleepSeconds ?? 0));

      // Derive sleep score from stage proportions (April 2026)
      let derivedSleepScore: number | null = null;
      try {
        const totalMin = totalSleepSeconds / 60;
        const deepMin = deepSleepSeconds / 60;
        const remMin = remSleepSeconds / 60;
        if (totalMin > 0) {
          const { deriveAppleHealthSleepScore } = require('../readiness-scorer');
          derivedSleepScore = deriveAppleHealthSleepScore(totalMin, deepMin, remMin);
        }
      } catch { /* scoring functions unavailable */ }

      return {
        provider: 'apple_health',
        date,
        totalSleepSeconds: totalSleepSeconds || null,
        deepSleepSeconds: deepSleepSeconds || null,
        lightSleepSeconds: lightSleepSeconds || null,
        remSleepSeconds: remSleepSeconds || null,
        awakeSleepSeconds: awakeSleepSeconds,
        sleepScore: derivedSleepScore,
        bedTimeStart: s.startDate ?? null,
        bedTimeEnd: s.endDate ?? null,
        raw: s,
      };
    } catch (err) {
      logger.warn({ err, userId }, 'Apple Health sleep read failed');
      return null;
    }
  }

  async getReadiness(userId: number, date: string): Promise<NormalizedReadiness | null> {
    try {
      const db = getDb();
      const hrvRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'hrv' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      const rhrRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      const summaryRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'daily_summary' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      const caloriesRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'calories' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      const stepsRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'steps' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      const exerciseRow = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'exercise_minutes' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      if (!hrvRow && !rhrRow) return null;

      const hrv = hrvRow ? JSON.parse(hrvRow.data_json) : null;
      const rhr = rhrRow ? JSON.parse(rhrRow.data_json) : null;
      const summary = summaryRow ? JSON.parse(summaryRow.data_json) : null;
      const calories = caloriesRow ? JSON.parse(caloriesRow.data_json) : null;
      const steps = stepsRow ? JSON.parse(stepsRow.data_json) : null;
      const exercise = exerciseRow ? JSON.parse(exerciseRow.data_json) : null;

      // ── Derived readiness and body battery (April 2026) ──────────
      // Apple Health has no native readiness or body battery metrics.
      // We derive them using the same scoring logic as the Garmin path
      // so Apple Health users see real values, not nulls.
      let readinessScore: number | null = null;
      let bodyBatteryEquiv: number | null = null;
      let currentEnergyReserve: number | null = null;
      const hrvMs = parseMetricValue(hrv, 'value', 'sdnn_ms');
      const restingHeartRate = parseMetricValue(rhr, 'value', 'bpm');

      try {
        const {
          scoreHrv, deriveAppleHealthSleepScore, deriveBodyBatteryEquivalent,
        } = require('../readiness-scorer');

        // HRV baseline (7-day average)
        const hrvHistory = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'hrv' AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as Array<{ data_json: string }>;
        const hrvValues = hrvHistory
          .map(r => parseMetricValue(JSON.parse(r.data_json), 'value', 'sdnn_ms') ?? 0)
          .filter((v: number) => v > 0);
        const hrvBaseline = hrvValues.length > 0 ? hrvValues.reduce((a: number, b: number) => a + b) / hrvValues.length : (hrvMs ?? 60);

        // Sleep data for today
        const sleepRow = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'sleep' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as { data_json: string } | undefined;

        const sleep = sleepRow ? JSON.parse(sleepRow.data_json) : null;
        const totalSleepMin = sleep ? ((parseMetricValue(sleep, 'totalSleepSeconds') ?? ((parseMetricValue(sleep, 'totalMinutes') ?? 0) * 60)) / 60) : 0;
        const deepSleepMin = sleep ? ((parseMetricValue(sleep, 'deepSleepSeconds') ?? ((parseMetricValue(sleep, 'deepMinutes') ?? 0) * 60)) / 60) : 0;
        const remSleepMin = sleep ? ((parseMetricValue(sleep, 'remSleepSeconds') ?? ((parseMetricValue(sleep, 'remMinutes') ?? 0) * 60)) / 60) : 0;

        const hrvScoreVal = scoreHrv(hrvMs ?? 60, hrvBaseline);
        const sleepScore = totalSleepMin > 0
          ? deriveAppleHealthSleepScore(totalSleepMin, deepSleepMin, remSleepMin)
          : null;

        // RHR baseline
        const rhrHistory = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as Array<{ data_json: string }>;
        const rhrValues = rhrHistory
          .map(r => parseMetricValue(JSON.parse(r.data_json), 'value', 'bpm') ?? 0)
          .filter((v: number) => v > 0);
        const rhrBaseline = rhrValues.length > 0 ? rhrValues.reduce((a: number, b: number) => a + b) / rhrValues.length : null;

        if (sleepScore != null) {
          bodyBatteryEquiv = deriveBodyBatteryEquivalent(sleepScore, hrvScoreVal, restingHeartRate, rhrBaseline);
        }

        currentEnergyReserve = deriveIntradayEnergyReserve({
          morningPeak: bodyBatteryEquiv,
          activeCalories: parseMetricValue(summary, 'activeCalories') ?? parseMetricValue(calories, 'kcal'),
          exerciseMinutes: parseMetricValue(summary, 'exerciseMinutes') ?? parseMetricValue(exercise, 'minutes'),
          steps: parseMetricValue(summary, 'steps') ?? parseMetricValue(steps, 'count'),
        }) ?? bodyBatteryEquiv;

        // Derive readiness: same 30/30/20/20 weighting
        if (hrvMs != null || sleepScore != null) {
          const { scoreBodyBattery, scoreAcwr } = require('../readiness-scorer');
          const bbScore = currentEnergyReserve != null ? scoreBodyBattery(currentEnergyReserve) : 60;
          readinessScore = Math.round(
            hrvScoreVal * 0.30 +
            (sleepScore != null ? scoreSleep(totalSleepMin / 60, sleepScore) : 60) * 0.30 +
            bbScore * 0.20 +
            60 * 0.20  // ACWR needs workout data — use neutral for getReadiness
          );
        }
      } catch {
        // Scoring functions unavailable — leave as null (backward compat)
      }

      return {
        provider: 'apple_health',
        date,
        readinessScore,
        hrvMs,
        restingHeartRate,
        bodyBattery: currentEnergyReserve ?? bodyBatteryEquiv,
        recoveryScore: readinessScore, // use readiness as recovery proxy
        raw: { hrv, rhr, dailySummary: summary },
      };
    } catch (err) {
      logger.warn({ err, userId }, 'Apple Health readiness read failed');
      return null;
    }
  }

  async getDailySummary(userId: number, date: string): Promise<NormalizedDailySummary | null> {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'daily_summary' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      let d = row ? JSON.parse(row.data_json) : null;
      if (!d) {
        const stepsRow = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'steps' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as { data_json: string } | undefined;
        const caloriesRow = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'calories' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as { data_json: string } | undefined;
        const rhrRow = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as { data_json: string } | undefined;
        if (!stepsRow && !caloriesRow && !rhrRow) return null;
        d = {
          steps: stepsRow ? parseMetricValue(JSON.parse(stepsRow.data_json), 'count') : null,
          activeCalories: caloriesRow ? parseMetricValue(JSON.parse(caloriesRow.data_json), 'kcal') : null,
          restingHeartRate: rhrRow ? parseMetricValue(JSON.parse(rhrRow.data_json), 'value', 'bpm') : null,
        };
      }

      return {
        provider: 'apple_health',
        date,
        steps: d.steps ?? null,
        distanceMeters: d.distanceMeters ?? null,
        activeCalories: d.activeCalories ?? null,
        totalCalories: d.totalCalories ?? null,
        restingHeartRate: d.restingHeartRate ?? null,
        avgHeartRate: null,
        maxHeartRate: null,
        avgStressLevel: null,
        bodyBatteryHigh: null,
        bodyBatteryLow: null,
        raw: d,
      };
    } catch (err) {
      logger.warn({ err, userId }, 'Apple Health daily summary read failed');
      return null;
    }
  }
}
