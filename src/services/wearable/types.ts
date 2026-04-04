// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Normalized wearable data types — provider-agnostic health/fitness data.
 *
 * All adapters map their proprietary formats to these shared types
 * so consumers never need to know which device the data came from.
 */

// ─── Provider Enum ─────────────────────────────────────────────────

export type WearableProvider = 'garmin' | 'strava' | 'whoop' | 'fitbit' | 'apple_health';

// ─── Capabilities ──────────────────────────────────────────────────

export interface ProviderCapabilities {
  activities: boolean;
  sleep: boolean;
  readiness: boolean;
  dailySummary: boolean;
}

// ─── Activity ──────────────────────────────────────────────────────

export type ActivityType =
  | 'run'
  | 'ride'
  | 'swim'
  | 'strength'
  | 'walk'
  | 'hike'
  | 'yoga'
  | 'elliptical'
  | 'rowing'
  | 'other';

export interface NormalizedActivity {
  id: string;
  provider: WearableProvider;
  type: ActivityType;
  name: string;
  startTime: string;          // ISO 8601
  endTime: string | null;     // ISO 8601
  durationSeconds: number;
  distanceMeters: number | null;
  calories: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgCadence: number | null;
  avgSpeedMps: number | null; // meters per second
  elevationGainMeters: number | null;
  raw?: Record<string, unknown>;
}

// ─── Sleep ──────────────────────────────────────────────────────────

export interface NormalizedSleep {
  provider: WearableProvider;
  date: string;               // YYYY-MM-DD
  totalSleepSeconds: number | null;
  deepSleepSeconds: number | null;
  lightSleepSeconds: number | null;
  remSleepSeconds: number | null;
  awakeSleepSeconds: number | null;
  sleepScore: number | null;  // 0–100 if available
  bedTimeStart: string | null; // ISO 8601
  bedTimeEnd: string | null;   // ISO 8601
  raw?: Record<string, unknown>;
}

// ─── Readiness ──────────────────────────────────────────────────────

export interface NormalizedReadiness {
  provider: WearableProvider;
  date: string;               // YYYY-MM-DD
  readinessScore: number | null; // 0–100
  hrvMs: number | null;       // HRV in milliseconds
  restingHeartRate: number | null;
  bodyBattery: number | null; // Garmin-specific, null for others
  recoveryScore: number | null; // Whoop-specific (0–100%), null for others
  raw?: Record<string, unknown>;
}

// ─── Daily Summary ──────────────────────────────────────────────────

export interface NormalizedDailySummary {
  provider: WearableProvider;
  date: string;               // YYYY-MM-DD
  steps: number | null;
  distanceMeters: number | null;
  activeCalories: number | null;
  totalCalories: number | null;
  restingHeartRate: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgStressLevel: number | null;
  bodyBatteryHigh: number | null;
  bodyBatteryLow: number | null;
  raw?: Record<string, unknown>;
}
