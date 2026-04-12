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
        `SELECT data_json FROM apple_health_data
         WHERE user_id = ? AND data_type = 'workout' AND date BETWEEN ? AND ?
         ORDER BY date ASC`
      ).all(userId, startDate, endDate) as Array<{ data_json: string }>;

      return rows.map((row, idx) => {
        const a = JSON.parse(row.data_json);
        return {
          id: `apple-${a.workoutId ?? idx}`,
          provider: 'apple_health' as WearableProvider,
          type: mapAppleType(a.workoutActivityType ?? ''),
          name: a.workoutActivityType?.replace('HKWorkoutActivityType', '') ?? 'Workout',
          startTime: a.startDate ?? '',
          endTime: a.endDate ?? null,
          durationSeconds: a.duration ?? 0,
          distanceMeters: a.totalDistance ?? null,
          calories: a.totalEnergyBurned ?? null,
          avgHeartRate: a.averageHeartRate ?? null,
          maxHeartRate: a.maxHeartRate ?? null,
          avgCadence: null,
          avgSpeedMps: null,
          elevationGainMeters: a.elevationAscended ?? null,
          raw: a,
        };
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

      // Derive sleep score from stage proportions (April 2026)
      let derivedSleepScore: number | null = null;
      try {
        const totalMin = (s.totalSleepSeconds ?? 0) / 60;
        const deepMin = (s.deepSleepSeconds ?? 0) / 60;
        const remMin = (s.remSleepSeconds ?? 0) / 60;
        if (totalMin > 0) {
          const { deriveAppleHealthSleepScore } = require('../readiness-scorer');
          derivedSleepScore = deriveAppleHealthSleepScore(totalMin, deepMin, remMin);
        }
      } catch { /* scoring functions unavailable */ }

      return {
        provider: 'apple_health',
        date,
        totalSleepSeconds: s.totalSleepSeconds ?? null,
        deepSleepSeconds: s.deepSleepSeconds ?? null,
        lightSleepSeconds: s.coreSleepSeconds ?? null,
        remSleepSeconds: s.remSleepSeconds ?? null,
        awakeSleepSeconds: s.awakeSleepSeconds ?? null,
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
         WHERE user_id = ? AND data_type = 'resting_heart_rate' AND date = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(userId, date) as { data_json: string } | undefined;

      if (!hrvRow && !rhrRow) return null;

      const hrv = hrvRow ? JSON.parse(hrvRow.data_json) : null;
      const rhr = rhrRow ? JSON.parse(rhrRow.data_json) : null;

      // ── Derived readiness and body battery (April 2026) ──────────
      // Apple Health has no native readiness or body battery metrics.
      // We derive them using the same scoring logic as the Garmin path
      // so Apple Health users see real values, not nulls.
      let readinessScore: number | null = null;
      let bodyBatteryEquiv: number | null = null;

      try {
        const {
          scoreHrv, deriveAppleHealthSleepScore, deriveBodyBatteryEquivalent,
        } = require('../readiness-scorer');

        const hrvMs = hrv?.value ?? null;

        // HRV baseline (7-day average)
        const hrvHistory = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'hrv' AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as Array<{ data_json: string }>;
        const hrvValues = hrvHistory.map(r => JSON.parse(r.data_json)?.value ?? 0).filter((v: number) => v > 0);
        const hrvBaseline = hrvValues.length > 0 ? hrvValues.reduce((a: number, b: number) => a + b) / hrvValues.length : (hrvMs ?? 60);

        // Sleep data for today
        const sleepRow = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'sleep' AND date = ?
           ORDER BY created_at DESC LIMIT 1`
        ).get(userId, date) as { data_json: string } | undefined;

        const sleep = sleepRow ? JSON.parse(sleepRow.data_json) : null;
        const totalSleepMin = sleep ? (sleep.totalSleepSeconds ?? 0) / 60 : 0;
        const deepSleepMin = sleep ? (sleep.deepSleepSeconds ?? 0) / 60 : 0;
        const remSleepMin = sleep ? (sleep.remSleepSeconds ?? 0) / 60 : 0;

        const hrvScoreVal = scoreHrv(hrvMs ?? 60, hrvBaseline);
        const sleepScore = totalSleepMin > 0
          ? deriveAppleHealthSleepScore(totalSleepMin, deepSleepMin, remSleepMin)
          : null;

        // RHR baseline
        const rhrHistory = db.prepare(
          `SELECT data_json FROM apple_health_data
           WHERE user_id = ? AND data_type = 'resting_heart_rate' AND date < ? AND date > date(?, '-8 days')
           ORDER BY date DESC LIMIT 7`
        ).all(userId, date, date) as Array<{ data_json: string }>;
        const rhrValues = rhrHistory.map(r => JSON.parse(r.data_json)?.value ?? 0).filter((v: number) => v > 0);
        const rhrBaseline = rhrValues.length > 0 ? rhrValues.reduce((a: number, b: number) => a + b) / rhrValues.length : null;

        if (sleepScore != null) {
          bodyBatteryEquiv = deriveBodyBatteryEquivalent(sleepScore, hrvScoreVal, rhr?.value ?? null, rhrBaseline);
        }

        // Derive readiness: same 30/30/20/20 weighting
        if (hrvMs != null || sleepScore != null) {
          const { scoreBodyBattery, scoreAcwr } = require('../readiness-scorer');
          const bbScore = bodyBatteryEquiv != null ? scoreBodyBattery(bodyBatteryEquiv) : 60;
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
        hrvMs: hrv?.value ?? null,
        restingHeartRate: rhr?.value ?? null,
        bodyBattery: bodyBatteryEquiv,
        recoveryScore: readinessScore, // use readiness as recovery proxy
        raw: { hrv, rhr },
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

      if (!row) return null;
      const d = JSON.parse(row.data_json);

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
