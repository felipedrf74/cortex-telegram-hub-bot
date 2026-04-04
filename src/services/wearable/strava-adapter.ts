// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Strava Adapter — OAuth-based, activities only.
 *
 * Strava provides detailed activity data but has no native sleep,
 * readiness, or daily summary endpoints.
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

const STRAVA_API = 'https://www.strava.com/api/v3';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

function getStravaConfig() {
  return {
    tokenUrl: STRAVA_TOKEN_URL,
    clientId: process.env.STRAVA_CLIENT_ID || '',
    clientSecret: process.env.STRAVA_CLIENT_SECRET || '',
  };
}

// ─── Type Mapping ──────────────────────────────────────────────────

const STRAVA_TYPE_MAP: Record<string, ActivityType> = {
  Run: 'run',
  TrailRun: 'run',
  VirtualRun: 'run',
  Ride: 'ride',
  VirtualRide: 'ride',
  MountainBikeRide: 'ride',
  GravelRide: 'ride',
  EBikeRide: 'ride',
  Swim: 'swim',
  WeightTraining: 'strength',
  Walk: 'walk',
  Hike: 'hike',
  Yoga: 'yoga',
  Elliptical: 'elliptical',
  Rowing: 'rowing',
};

function mapStravaType(type: string): ActivityType {
  return STRAVA_TYPE_MAP[type] ?? 'other';
}

// ─── Adapter ───────────────────────────────────────────────────────

export class StravaAdapter implements WearableAdapter {
  readonly provider: WearableProvider = 'strava';
  readonly capabilities: ProviderCapabilities = {
    activities: true,
    sleep: false,
    readiness: false,
    dailySummary: false,
  };

  async isConfigured(userId: number): Promise<boolean> {
    return isConnected(userId, 'strava');
  }

  async getActivities(userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]> {
    const token = await ensureFreshToken(userId, 'strava', getStravaConfig());

    const after = Math.floor(new Date(startDate).getTime() / 1000);
    const before = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);

    const url = `${STRAVA_API}/athlete/activities?after=${after}&before=${before}&per_page=50`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Strava activities fetch failed');
      return [];
    }

    const activities = await response.json() as any[];
    return activities.map((a): NormalizedActivity => ({
      id: `strava-${a.id}`,
      provider: 'strava',
      type: mapStravaType(a.type ?? a.sport_type ?? ''),
      name: a.name ?? '',
      startTime: a.start_date_local ?? a.start_date,
      endTime: a.start_date && a.elapsed_time
        ? new Date(new Date(a.start_date).getTime() + a.elapsed_time * 1000).toISOString()
        : null,
      durationSeconds: a.moving_time ?? a.elapsed_time ?? 0,
      distanceMeters: a.distance ?? null,
      calories: a.calories ?? null,
      avgHeartRate: a.average_heartrate ?? null,
      maxHeartRate: a.max_heartrate ?? null,
      avgCadence: a.average_cadence ?? null,
      avgSpeedMps: a.average_speed ?? null,
      elevationGainMeters: a.total_elevation_gain ?? null,
      raw: a,
    }));
  }

  async getSleep(_userId: number, _date: string): Promise<NormalizedSleep | null> {
    return null; // Strava has no sleep data
  }

  async getReadiness(_userId: number, _date: string): Promise<NormalizedReadiness | null> {
    return null; // Strava has no readiness data
  }

  async getDailySummary(_userId: number, _date: string): Promise<NormalizedDailySummary | null> {
    return null; // Strava has no daily summary
  }
}
