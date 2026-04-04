// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wearable abstraction layer — clean barrel export.
 */

export * from './types';
export type { WearableAdapter } from './adapter-interface';
export {
  getUserProviders,
  getPrimaryReadinessProvider,
  getActivities,
  getReadiness,
  getSleep,
  getDailySummary,
  deduplicateActivities,
} from './wearable-service';

// Named adapter exports for direct use
export { GarminAdapter } from './garmin-adapter';
export { StravaAdapter } from './strava-adapter';
export { WhoopAdapter } from './whoop-adapter';
export { FitbitAdapter } from './fitbit-adapter';
export { AppleHealthAdapter } from './apple-health-adapter';
