// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Fitbit Adapter — OAuth-based, full health data.
 *
 * Fitbit provides activities, sleep, HRV, heart rate, and daily summaries.
 */

import { isConnected } from '../oauth-store';
import { ensureFreshToken } from './oauth-helper';
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

// ─── Config ────────────────────────────────────────────────────────

const FITBIT_API = 'https://api.fitbit.com/1.2/user/-';
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';

function getFitbitConfig() {
  return {
    tokenUrl: FITBIT_TOKEN_URL,
    clientId: process.env.FITBIT_CLIENT_ID || '',
    clientSecret: process.env.FITBIT_CLIENT_SECRET || '',
  };
}

// ─── Type Mapping ──────────────────────────────────────────────────

const FITBIT_TYPE_MAP: Record<string, ActivityType> = {
  Run: 'run',
  Running: 'run',
  Bike: 'ride',
  Cycling: 'ride',
  Swim: 'swim',
  Swimming: 'swim',
  Weights: 'strength',
  'Weight Training': 'strength',
  Walk: 'walk',
  Walking: 'walk',
  Hike: 'hike',
  Hiking: 'hike',
  Yoga: 'yoga',
  Elliptical: 'elliptical',
  Rowing: 'rowing',
};

function mapFitbitType(name: string): ActivityType {
  return FITBIT_TYPE_MAP[name] ?? 'other';
}

// ─── Adapter ───────────────────────────────────────────────────────

export class FitbitAdapter implements WearableAdapter {
  readonly provider: WearableProvider = 'fitbit';
  readonly capabilities: ProviderCapabilities = {
    activities: true,
    sleep: true,
    readiness: true,
    dailySummary: true,
  };

  async isConfigured(userId: number): Promise<boolean> {
    return isConnected(userId, 'fitbit');
  }

  async getActivities(userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]> {
    const token = await ensureFreshToken(userId, 'fitbit', getFitbitConfig());

    // Fitbit uses /1/user/-/activities/list.json with afterDate + sort + limit
    const url = `https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${startDate}&sort=asc&offset=0&limit=50`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Fitbit activities fetch failed');
      return [];
    }

    const data = await response.json() as any;
    const activities: any[] = data.activities ?? [];

    // Filter to endDate
    const endMs = new Date(endDate + 'T23:59:59Z').getTime();
    return activities
      .filter(a => new Date(a.startTime ?? a.originalStartTime).getTime() <= endMs)
      .map((a): NormalizedActivity => ({
        id: `fitbit-${a.logId}`,
        provider: 'fitbit',
        type: mapFitbitType(a.activityName ?? ''),
        name: a.activityName ?? '',
        startTime: a.startTime ?? a.originalStartTime,
        endTime: a.startTime && a.activeDuration
          ? new Date(new Date(a.startTime).getTime() + a.activeDuration).toISOString()
          : null,
        durationSeconds: a.activeDuration ? Math.round(a.activeDuration / 1000) : a.duration ? Math.round(a.duration / 1000) : 0,
        distanceMeters: a.distance ? a.distance * 1000 : null, // Fitbit returns km
        calories: a.calories ?? null,
        avgHeartRate: a.averageHeartRate ?? null,
        maxHeartRate: null, // Not in list endpoint
        avgCadence: null,
        avgSpeedMps: a.speed ? a.speed / 3.6 : null, // km/h to m/s
        elevationGainMeters: a.elevationGain ?? null,
        raw: a,
      }));
  }

  async getSleep(userId: number, date: string): Promise<NormalizedSleep | null> {
    const token = await ensureFreshToken(userId, 'fitbit', getFitbitConfig());

    const url = `${FITBIT_API}/sleep/date/${date}.json`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Fitbit sleep fetch failed');
      return null;
    }

    const data = await response.json() as any;
    const sleepLogs: any[] = data.sleep ?? [];
    if (sleepLogs.length === 0) return null;

    const main = sleepLogs.find((s: any) => s.isMainSleep) ?? sleepLogs[0];
    const summary = main.levels?.summary ?? {};

    return {
      provider: 'fitbit',
      date,
      totalSleepSeconds: main.duration ? Math.round(main.duration / 1000) : null,
      deepSleepSeconds: summary.deep?.minutes ? summary.deep.minutes * 60 : null,
      lightSleepSeconds: summary.light?.minutes ? summary.light.minutes * 60 : null,
      remSleepSeconds: summary.rem?.minutes ? summary.rem.minutes * 60 : null,
      awakeSleepSeconds: summary.wake?.minutes ? summary.wake.minutes * 60 : null,
      sleepScore: data.summary?.overallScore ?? main.efficiency ?? null,
      bedTimeStart: main.startTime ?? null,
      bedTimeEnd: main.endTime ?? null,
      raw: main,
    };
  }

  async getReadiness(userId: number, date: string): Promise<NormalizedReadiness | null> {
    const token = await ensureFreshToken(userId, 'fitbit', getFitbitConfig());

    // Fetch HRV data
    const hrvUrl = `https://api.fitbit.com/1/user/-/hrv/date/${date}.json`;
    const hrvResp = await fetch(hrvUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let hrvMs: number | null = null;
    if (hrvResp.ok) {
      const hrvData = await hrvResp.json() as any;
      const hrvEntries = hrvData.hrv ?? [];
      if (hrvEntries.length > 0) {
        hrvMs = hrvEntries[0].value?.dailyRmssd ?? null;
      }
    }

    // Fetch resting heart rate from heart rate endpoint
    const hrUrl = `https://api.fitbit.com/1/user/-/activities/heart/date/${date}/1d.json`;
    const hrResp = await fetch(hrUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let rhr: number | null = null;
    if (hrResp.ok) {
      const hrData = await hrResp.json() as any;
      rhr = hrData['activities-heart']?.[0]?.value?.restingHeartRate ?? null;
    }

    return {
      provider: 'fitbit',
      date,
      readinessScore: null, // Fitbit doesn't have a native readiness score
      hrvMs,
      restingHeartRate: rhr,
      bodyBattery: null,
      recoveryScore: null,
      raw: { hrvMs, restingHeartRate: rhr },
    };
  }

  async getDailySummary(userId: number, date: string): Promise<NormalizedDailySummary | null> {
    const token = await ensureFreshToken(userId, 'fitbit', getFitbitConfig());

    const url = `https://api.fitbit.com/1/user/-/activities/date/${date}.json`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Fitbit daily summary fetch failed');
      return null;
    }

    const data = await response.json() as any;
    const summary = data.summary ?? {};

    return {
      provider: 'fitbit',
      date,
      steps: summary.steps ?? null,
      distanceMeters: summary.distances?.find((d: any) => d.activity === 'total')?.distance
        ? summary.distances.find((d: any) => d.activity === 'total').distance * 1000
        : null,
      activeCalories: summary.activityCalories ?? null,
      totalCalories: summary.caloriesOut ?? null,
      restingHeartRate: summary.restingHeartRate ?? null,
      avgHeartRate: null, // Not in daily summary
      maxHeartRate: null,
      avgStressLevel: null,
      bodyBatteryHigh: null,
      bodyBatteryLow: null,
      raw: data,
    };
  }
}
