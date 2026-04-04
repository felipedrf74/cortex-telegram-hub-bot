// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Garmin Adapter — wraps the existing garmin.ts service (no modifications).
 *
 * Maps Garmin-proprietary data structures into the normalized wearable types.
 * Garmin uses credential-based auth (not OAuth), so isConfigured does not
 * depend on the user — it checks global configuration via garmin.isGarminConfigured().
 */

import * as garmin from '../garmin';
import type { GarminActivity } from '../garmin';
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

const GARMIN_TYPE_MAP: Record<string, ActivityType> = {
  running: 'run',
  trail_running: 'run',
  treadmill_running: 'run',
  track_running: 'run',
  cycling: 'ride',
  road_biking: 'ride',
  mountain_biking: 'ride',
  indoor_cycling: 'ride',
  virtual_ride: 'ride',
  gravel_cycling: 'ride',
  swimming: 'swim',
  lap_swimming: 'swim',
  open_water_swimming: 'swim',
  pool_swimming: 'swim',
  strength_training: 'strength',
  walking: 'walk',
  hiking: 'hike',
  yoga: 'yoga',
  elliptical: 'elliptical',
  indoor_rowing: 'rowing',
  rowing: 'rowing',
};

export function mapGarminActivityType(typeKey: string): ActivityType {
  return GARMIN_TYPE_MAP[typeKey] ?? 'other';
}

/** Add seconds to an ISO datetime string and return a new ISO string. */
function addSecondsToISO(iso: string, seconds: number): string {
  const d = new Date(iso);
  d.setSeconds(d.getSeconds() + seconds);
  return d.toISOString();
}

// ─── Adapter ───────────────────────────────────────────────────────

export class GarminAdapter implements WearableAdapter {
  readonly provider: WearableProvider = 'garmin';
  readonly capabilities: ProviderCapabilities = {
    activities: true,
    sleep: true,
    readiness: true,
    dailySummary: true,
  };

  async isConfigured(_userId: number): Promise<boolean> {
    return garmin.isGarminConfigured();
  }

  async getActivities(_userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]> {
    const activities = await garmin.getActivitiesByDate(startDate, endDate);
    return activities.map(mapGarminActivity);
  }

  async getSleep(_userId: number, date: string): Promise<NormalizedSleep | null> {
    const raw = await garmin.getSleepData(date) as any;
    if (!raw) return null;

    const daily = raw.dailySleepDTO ?? raw;
    return {
      provider: 'garmin',
      date,
      totalSleepSeconds: daily.sleepTimeSeconds ?? null,
      deepSleepSeconds: daily.deepSleepSeconds ?? null,
      lightSleepSeconds: daily.lightSleepSeconds ?? null,
      remSleepSeconds: daily.remSleepSeconds ?? null,
      awakeSleepSeconds: daily.awakeSleepSeconds ?? null,
      sleepScore: daily.sleepScores?.overallScore ?? daily.overallScore ?? null,
      bedTimeStart: daily.sleepStartTimestampGMT
        ? new Date(daily.sleepStartTimestampGMT).toISOString()
        : null,
      bedTimeEnd: daily.sleepEndTimestampGMT
        ? new Date(daily.sleepEndTimestampGMT).toISOString()
        : null,
      raw: daily,
    };
  }

  async getReadiness(_userId: number, date: string): Promise<NormalizedReadiness | null> {
    const [hrv, bb, readiness] = await Promise.allSettled([
      garmin.getHrvData(date),
      garmin.getBodyBatteryEvents(date),
      garmin.getTrainingReadiness(date),
    ]);

    const hrvData = hrv.status === 'fulfilled' ? hrv.value as any : null;
    const bbData = bb.status === 'fulfilled' ? bb.value as any : null;
    const readinessData = readiness.status === 'fulfilled' ? readiness.value as any : null;

    // Extract body battery current value from events array
    let bodyBattery: number | null = null;
    if (Array.isArray(bbData)) {
      const last = bbData[bbData.length - 1];
      bodyBattery = last?.bodyBatteryLevel ?? null;
    } else if (bbData?.bodyBatteryLevel != null) {
      bodyBattery = bbData.bodyBatteryLevel;
    }

    // Extract readiness score
    let readinessScore: number | null = null;
    if (readinessData) {
      // Training readiness may be a single object or have nested score
      readinessScore = readinessData.score ?? readinessData.trainingReadinessScore ?? null;
    }

    return {
      provider: 'garmin',
      date,
      readinessScore,
      hrvMs: hrvData?.hrvSummary?.weeklyAvg ?? hrvData?.lastNightAvg ?? null,
      restingHeartRate: hrvData?.startTimestampLocal ? null : null, // RHR comes from daily summary
      bodyBattery,
      recoveryScore: null, // Garmin doesn't have a native recovery score
      raw: { hrv: hrvData, bodyBattery: bbData, readiness: readinessData },
    };
  }

  async getDailySummary(_userId: number, date: string): Promise<NormalizedDailySummary | null> {
    const raw = await garmin.getDailySummary(date);
    if (!raw) return null;

    return {
      provider: 'garmin',
      date,
      steps: raw.totalSteps ?? null,
      distanceMeters: raw.totalDistanceMeters ?? null,
      activeCalories: raw.activeKilocalories ?? null,
      totalCalories: raw.totalKilocalories ?? null,
      restingHeartRate: raw.restingHeartRate ?? null,
      avgHeartRate: raw.averageHeartRate ?? null,
      maxHeartRate: raw.maxHeartRate ?? null,
      avgStressLevel: raw.averageStressLevel ?? null,
      bodyBatteryHigh: raw.bodyBatteryHighestValue ?? null,
      bodyBatteryLow: raw.bodyBatteryLowestValue ?? null,
      raw: raw as Record<string, unknown>,
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function mapGarminActivity(a: GarminActivity): NormalizedActivity {
  return {
    id: `garmin-${a.activityId}`,
    provider: 'garmin',
    type: mapGarminActivityType(a.activityType?.typeKey ?? ''),
    name: a.activityName ?? '',
    startTime: a.startTimeLocal,
    endTime: a.duration ? addSecondsToISO(a.startTimeLocal, a.duration) : null,
    durationSeconds: a.duration ?? 0,
    distanceMeters: a.distance ?? null,
    calories: a.calories ?? null,
    avgHeartRate: a.averageHR ?? null,
    maxHeartRate: a.maxHR ?? null,
    avgCadence: a.averageRunningCadenceInStepsPerMinute ?? null,
    avgSpeedMps: a.averageSpeed ?? null,
    elevationGainMeters: a.elevationGain ?? null,
    raw: a as unknown as Record<string, unknown>,
  };
}
