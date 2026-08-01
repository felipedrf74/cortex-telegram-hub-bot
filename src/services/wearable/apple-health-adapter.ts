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
import { deriveAdapterReadinessScore } from '../readiness-scorer';
import { appleHealthJsonSelectColumns, parseAppleHealthDataJson } from '../apple-health-encryption';
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

type AppleHealthJsonRow = {
  data_json: string;
  encrypted_data_json?: string | null;
};

type AppleHealthTypedRow = AppleHealthJsonRow & {
  data_type: string;
};

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
      const healthJsonColumns = appleHealthJsonSelectColumns(db);
      const rows = db.prepare(
        `SELECT ${healthJsonColumns}, data_type FROM apple_health_data
         WHERE user_id = ? AND data_type IN ('workout', 'workouts') AND date BETWEEN ? AND ?
         ORDER BY date ASC`
      ).all(userId, startDate, endDate) as AppleHealthTypedRow[];

      return rows.flatMap((row, rowIndex) => {
        const parsed = parseAppleHealthDataJson(row, userId);
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
      const healthJsonColumns = appleHealthJsonSelectColumns(db);
      const row = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'sleep' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      if (!row) return null;
      const s = parseAppleHealthDataJson(row, userId);
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
      const healthJsonColumns = appleHealthJsonSelectColumns(db);
      const hrvRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'hrv' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      const rhrRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      const summaryRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'daily_summary' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      const caloriesRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'calories' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      const stepsRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'steps' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      const exerciseRow = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'exercise_minutes' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      if (!hrvRow && !rhrRow) return null;

      const hrv = hrvRow ? parseAppleHealthDataJson(hrvRow, userId) : null;
      const rhr = rhrRow ? parseAppleHealthDataJson(rhrRow, userId) : null;
      const summary = summaryRow ? parseAppleHealthDataJson(summaryRow, userId) : null;
      const calories = caloriesRow ? parseAppleHealthDataJson(caloriesRow, userId) : null;
      const steps = stepsRow ? parseAppleHealthDataJson(stepsRow, userId) : null;
      const exercise = exerciseRow ? parseAppleHealthDataJson(exerciseRow, userId) : null;

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
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type = 'hrv' AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as AppleHealthJsonRow[];
        const hrvValues = hrvHistory
          .map(r => parseMetricValue(parseAppleHealthDataJson(r, userId), 'value', 'sdnn_ms') ?? 0)
          .filter((v: number) => v > 0);
        const hrvBaseline = hrvValues.length > 0 ? hrvValues.reduce((a: number, b: number) => a + b) / hrvValues.length : (hrvMs ?? 60);

        // Sleep data for today
        const sleepRow = db.prepare(
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type = 'sleep' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as AppleHealthJsonRow | undefined;

        const sleep = sleepRow ? parseAppleHealthDataJson(sleepRow, userId) : null;
        const totalSleepMin = sleep ? ((parseMetricValue(sleep, 'totalSleepSeconds') ?? ((parseMetricValue(sleep, 'totalMinutes') ?? 0) * 60)) / 60) : 0;
        const deepSleepMin = sleep ? ((parseMetricValue(sleep, 'deepSleepSeconds') ?? ((parseMetricValue(sleep, 'deepMinutes') ?? 0) * 60)) / 60) : 0;
        const remSleepMin = sleep ? ((parseMetricValue(sleep, 'remSleepSeconds') ?? ((parseMetricValue(sleep, 'remMinutes') ?? 0) * 60)) / 60) : 0;

        // Garmin does not publish HRV Status to Apple Health, so a Garmin-only
        // iOS user has no HRV rows at all. `scoreHrv(60, ...)` hands back a
        // healthy-looking number that the energy-reserve derivation would then
        // consume as measured; pass null so it redistributes instead.
        // TODAY's reading only. A present 7-day baseline with no row for today
        // previously kept this true, so `scoreHrv(60, baseline)` judged a
        // fabricated 60 ms against a real baseline — for a 100 ms athlete that
        // lands in the worst HRV bucket off one missed sync.
        const hasMeasuredHrv = (hrvMs ?? 0) > 0;
        const hrvScoreVal = hasMeasuredHrv ? scoreHrv(hrvMs ?? 60, hrvBaseline) : null;
        const sleepScore = totalSleepMin > 0
          ? deriveAppleHealthSleepScore(totalSleepMin, deepSleepMin, remSleepMin)
          : null;

        // RHR baseline
        const rhrHistory = db.prepare(
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as AppleHealthJsonRow[];
        const rhrValues = rhrHistory
          .map(r => parseMetricValue(parseAppleHealthDataJson(r, userId), 'value', 'bpm') ?? 0)
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

        // Derive readiness: same 30/30/20/20 weighting.
        //
        // The arithmetic lives in `deriveAdapterReadinessScore` so it is
        // reachable from tests. It used to sit inline here, inside a block
        // whose `require` throws under vitest — the catch below swallowed it
        // and the composite silently produced null, so none of it was ever
        // covered.
        if (hrvMs != null || sleepScore != null) {
          const { scoreBodyBattery } = require('../readiness-scorer');
          const bbScore = currentEnergyReserve != null ? scoreBodyBattery(currentEnergyReserve) : 60;
          readinessScore = deriveAdapterReadinessScore({
            hrvScore: hrvScoreVal,
            sleepScore,
            sleepDurationHours: totalSleepMin / 60,
            bodyBatteryScore: bbScore,
          });
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
      const healthJsonColumns = appleHealthJsonSelectColumns(db);
      const row = db.prepare(
        `SELECT ${healthJsonColumns} FROM apple_health_data
         WHERE user_id = ? AND data_type = 'daily_summary' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as AppleHealthJsonRow | undefined;

      let d = row ? parseAppleHealthDataJson(row, userId) : null;
      if (!d) {
        const stepsRow = db.prepare(
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type = 'steps' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as AppleHealthJsonRow | undefined;
        const caloriesRow = db.prepare(
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type = 'calories' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as AppleHealthJsonRow | undefined;
        const rhrRow = db.prepare(
          `SELECT ${healthJsonColumns} FROM apple_health_data
           WHERE user_id = ? AND data_type IN ('resting_heart_rate', 'resting_hr') AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as AppleHealthJsonRow | undefined;
        if (!stepsRow && !caloriesRow && !rhrRow) return null;
        d = {
          steps: stepsRow ? parseMetricValue(parseAppleHealthDataJson(stepsRow, userId), 'count') : null,
          activeCalories: caloriesRow ? parseMetricValue(parseAppleHealthDataJson(caloriesRow, userId), 'kcal') : null,
          restingHeartRate: rhrRow ? parseMetricValue(parseAppleHealthDataJson(rhrRow, userId), 'value', 'bpm') : null,
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
