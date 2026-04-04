// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Whoop Adapter — OAuth-based, recovery + sleep + workouts.
 *
 * Whoop's API v1 provides excellent recovery/readiness data
 * with a native 0–100% recovery score. No daily step count.
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

const WHOOP_API = 'https://api.prod.whoop.com/developer/v1';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

function getWhoopConfig() {
  return {
    tokenUrl: WHOOP_TOKEN_URL,
    clientId: process.env.WHOOP_CLIENT_ID || '',
    clientSecret: process.env.WHOOP_CLIENT_SECRET || '',
  };
}

// ─── Type Mapping ──────────────────────────────────────────────────

/** Whoop sport_id → normalized type. See Whoop API docs for full list. */
const WHOOP_SPORT_MAP: Record<number, ActivityType> = {
  0: 'run',        // Running
  1: 'ride',       // Cycling
  33: 'swim',      // Swimming
  43: 'strength',  // Weightlifting
  63: 'walk',      // Walking
  52: 'hike',      // Hiking
  42: 'yoga',      // Yoga
  71: 'rowing',    // Rowing
};

function mapWhoopSport(sportId: number): ActivityType {
  return WHOOP_SPORT_MAP[sportId] ?? 'other';
}

// ─── Adapter ───────────────────────────────────────────────────────

export class WhoopAdapter implements WearableAdapter {
  readonly provider: WearableProvider = 'whoop';
  readonly capabilities: ProviderCapabilities = {
    activities: true,
    sleep: true,
    readiness: true,
    dailySummary: false,
  };

  async isConfigured(userId: number): Promise<boolean> {
    return isConnected(userId, 'whoop');
  }

  async getActivities(userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]> {
    const token = await ensureFreshToken(userId, 'whoop', getWhoopConfig());

    const url = `${WHOOP_API}/activity/workout?start=${startDate}T00:00:00.000Z&end=${endDate}T23:59:59.999Z&limit=50`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Whoop workouts fetch failed');
      return [];
    }

    const data = await response.json() as any;
    const records: any[] = data.records ?? [];

    return records.map((w): NormalizedActivity => {
      const start = w.start;
      const end = w.end;
      const durationMs = start && end ? new Date(end).getTime() - new Date(start).getTime() : 0;

      return {
        id: `whoop-${w.id}`,
        provider: 'whoop',
        type: mapWhoopSport(w.sport_id ?? -1),
        name: w.score?.strain ? `Whoop Workout (strain ${w.score.strain.toFixed(1)})` : 'Whoop Workout',
        startTime: start,
        endTime: end ?? null,
        durationSeconds: Math.round(durationMs / 1000),
        distanceMeters: w.score?.distance_meter ?? null,
        calories: w.score?.kilojoule ? Math.round(w.score.kilojoule / 4.184) : null,
        avgHeartRate: w.score?.average_heart_rate ?? null,
        maxHeartRate: w.score?.max_heart_rate ?? null,
        avgCadence: null,
        avgSpeedMps: null,
        elevationGainMeters: null,
        raw: w,
      };
    });
  }

  async getSleep(userId: number, date: string): Promise<NormalizedSleep | null> {
    const token = await ensureFreshToken(userId, 'whoop', getWhoopConfig());

    const url = `${WHOOP_API}/activity/sleep?start=${date}T00:00:00.000Z&end=${date}T23:59:59.999Z&limit=1`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Whoop sleep fetch failed');
      return null;
    }

    const data = await response.json() as any;
    const records: any[] = data.records ?? [];
    if (records.length === 0) return null;

    const s = records[0];
    const score = s.score ?? {};
    const stages = score.stage_summary ?? {};

    return {
      provider: 'whoop',
      date,
      totalSleepSeconds: stages.total_in_bed_time_milli ? Math.round(stages.total_in_bed_time_milli / 1000) : null,
      deepSleepSeconds: stages.total_slow_wave_sleep_time_milli ? Math.round(stages.total_slow_wave_sleep_time_milli / 1000) : null,
      lightSleepSeconds: stages.total_light_sleep_time_milli ? Math.round(stages.total_light_sleep_time_milli / 1000) : null,
      remSleepSeconds: stages.total_rem_sleep_time_milli ? Math.round(stages.total_rem_sleep_time_milli / 1000) : null,
      awakeSleepSeconds: stages.total_awake_time_milli ? Math.round(stages.total_awake_time_milli / 1000) : null,
      sleepScore: score.sleep_performance_percentage ?? null,
      bedTimeStart: s.start ?? null,
      bedTimeEnd: s.end ?? null,
      raw: s,
    };
  }

  async getReadiness(userId: number, date: string): Promise<NormalizedReadiness | null> {
    const token = await ensureFreshToken(userId, 'whoop', getWhoopConfig());

    const url = `${WHOOP_API}/recovery?start=${date}T00:00:00.000Z&end=${date}T23:59:59.999Z&limit=1`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Whoop recovery fetch failed');
      return null;
    }

    const data = await response.json() as any;
    const records: any[] = data.records ?? [];
    if (records.length === 0) return null;

    const r = records[0];
    const score = r.score ?? {};

    return {
      provider: 'whoop',
      date,
      readinessScore: score.recovery_score != null ? Math.round(score.recovery_score) : null,
      hrvMs: score.hrv_rmssd_milli ?? null,
      restingHeartRate: score.resting_heart_rate ?? null,
      bodyBattery: null,
      recoveryScore: score.recovery_score ?? null,
      raw: r,
    };
  }

  async getDailySummary(_userId: number, _date: string): Promise<NormalizedDailySummary | null> {
    return null; // Whoop has no daily step/calorie summary
  }
}
