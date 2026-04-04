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

      return {
        provider: 'apple_health',
        date,
        totalSleepSeconds: s.totalSleepSeconds ?? null,
        deepSleepSeconds: s.deepSleepSeconds ?? null,
        lightSleepSeconds: s.coreSleepSeconds ?? null,
        remSleepSeconds: s.remSleepSeconds ?? null,
        awakeSleepSeconds: s.awakeSleepSeconds ?? null,
        sleepScore: null, // Apple Health doesn't compute a score
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

      return {
        provider: 'apple_health',
        date,
        readinessScore: null,
        hrvMs: hrv?.value ?? null,
        restingHeartRate: rhr?.value ?? null,
        bodyBattery: null,
        recoveryScore: null,
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
