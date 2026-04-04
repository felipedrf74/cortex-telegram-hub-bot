// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wearable Service — unified router for all wearable providers.
 *
 * Instantiates all adapters, discovers connected providers per user,
 * merges activities with deduplication, and routes readiness/sleep
 * queries to the best available provider.
 */

import { logger } from '../../utils/logger';
import type { WearableAdapter } from './adapter-interface';
import type {
  WearableProvider,
  NormalizedActivity,
  NormalizedSleep,
  NormalizedReadiness,
  NormalizedDailySummary,
} from './types';

import { GarminAdapter } from './garmin-adapter';
import { StravaAdapter } from './strava-adapter';
import { WhoopAdapter } from './whoop-adapter';
import { FitbitAdapter } from './fitbit-adapter';
import { AppleHealthAdapter } from './apple-health-adapter';

// ─── Adapter Registry ──────────────────────────────────────────────

const adapters: WearableAdapter[] = [
  new GarminAdapter(),
  new StravaAdapter(),
  new WhoopAdapter(),
  new FitbitAdapter(),
  new AppleHealthAdapter(),
];

/** Priority order for readiness data (best recovery metrics first). */
const READINESS_PRIORITY: WearableProvider[] = [
  'whoop',
  'garmin',
  'fitbit',
  'apple_health',
  'strava', // Strava has no readiness, but included for completeness
];

/** Priority order for sleep data. */
const SLEEP_PRIORITY: WearableProvider[] = [
  'whoop',
  'garmin',
  'fitbit',
  'apple_health',
  'strava',
];

// ─── Public API ────────────────────────────────────────────────────

/**
 * Get all wearable providers that are connected for the given user.
 */
export async function getUserProviders(userId: number): Promise<WearableProvider[]> {
  const results = await Promise.allSettled(
    adapters.map(async (a) => {
      const ok = await a.isConfigured(userId);
      return ok ? a.provider : null;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<WearableProvider | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((p): p is WearableProvider => p !== null);
}

/**
 * Return the best provider for readiness/recovery data.
 */
export async function getPrimaryReadinessProvider(userId: number): Promise<WearableProvider | null> {
  const connected = await getUserProviders(userId);
  for (const provider of READINESS_PRIORITY) {
    if (connected.includes(provider)) {
      const adapter = adapters.find(a => a.provider === provider);
      if (adapter?.capabilities.readiness) return provider;
    }
  }
  return null;
}

/**
 * Merge activities from ALL connected providers with deduplication.
 *
 * Dedup rule: two activities are considered duplicates if they share
 * the same activity type AND their start times are within 5 minutes.
 */
export async function getActivities(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<NormalizedActivity[]> {
  const connected = await getUserProviders(userId);
  const activeAdapters = adapters.filter(a => connected.includes(a.provider) && a.capabilities.activities);

  const results = await Promise.allSettled(
    activeAdapters.map(a => a.getActivities(userId, startDate, endDate))
  );

  const allActivities: NormalizedActivity[] = [];
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled') {
      allActivities.push(...r.value);
    } else {
      logger.warn({ provider: activeAdapters[idx].provider, err: r.reason }, 'Wearable: activity fetch failed');
    }
  });

  return deduplicateActivities(allActivities);
}

/**
 * Get readiness data from the best available provider.
 * Falls back to the next provider if the primary fails.
 */
export async function getReadiness(userId: number, date: string): Promise<NormalizedReadiness | null> {
  const connected = await getUserProviders(userId);
  const orderedAdapters = READINESS_PRIORITY
    .filter(p => connected.includes(p))
    .map(p => adapters.find(a => a.provider === p))
    .filter((a): a is WearableAdapter => a != null && a.capabilities.readiness);

  for (const adapter of orderedAdapters) {
    try {
      const result = await adapter.getReadiness(userId, date);
      if (result) return result;
    } catch (err) {
      logger.warn({ provider: adapter.provider, err }, 'Wearable: readiness fetch failed, trying next');
    }
  }
  return null;
}

/**
 * Get sleep data from the best available provider.
 * Falls back to the next provider if the primary fails.
 */
export async function getSleep(userId: number, date: string): Promise<NormalizedSleep | null> {
  const connected = await getUserProviders(userId);
  const orderedAdapters = SLEEP_PRIORITY
    .filter(p => connected.includes(p))
    .map(p => adapters.find(a => a.provider === p))
    .filter((a): a is WearableAdapter => a != null && a.capabilities.sleep);

  for (const adapter of orderedAdapters) {
    try {
      const result = await adapter.getSleep(userId, date);
      if (result) return result;
    } catch (err) {
      logger.warn({ provider: adapter.provider, err }, 'Wearable: sleep fetch failed, trying next');
    }
  }
  return null;
}

/**
 * Get daily summary from the best available provider.
 */
export async function getDailySummary(userId: number, date: string): Promise<NormalizedDailySummary | null> {
  const connected = await getUserProviders(userId);
  const candidates = adapters
    .filter(a => connected.includes(a.provider) && a.capabilities.dailySummary);

  for (const adapter of candidates) {
    try {
      const result = await adapter.getDailySummary(userId, date);
      if (result) return result;
    } catch (err) {
      logger.warn({ provider: adapter.provider, err }, 'Wearable: daily summary fetch failed, trying next');
    }
  }
  return null;
}

// ─── Deduplication ─────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Remove duplicate activities from multiple providers.
 * Two activities are duplicates if they have the same type
 * and their start times are within 5 minutes of each other.
 *
 * When duplicates are found, keep the one with more data (higher priority:
 * garmin > strava > whoop > fitbit > apple_health).
 */
export function deduplicateActivities(activities: NormalizedActivity[]): NormalizedActivity[] {
  const PROVIDER_PRIORITY: Record<WearableProvider, number> = {
    garmin: 5,
    strava: 4,
    whoop: 3,
    fitbit: 2,
    apple_health: 1,
  };

  // Sort by start time for easier comparison
  const sorted = [...activities].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  const kept: NormalizedActivity[] = [];

  for (const activity of sorted) {
    const existingIdx = kept.findIndex(existing =>
      existing.type === activity.type &&
      Math.abs(new Date(existing.startTime).getTime() - new Date(activity.startTime).getTime()) <= DEDUP_WINDOW_MS
    );

    if (existingIdx === -1) {
      kept.push(activity);
    } else {
      // Keep the one from the higher-priority provider
      const existing = kept[existingIdx];
      if ((PROVIDER_PRIORITY[activity.provider] ?? 0) > (PROVIDER_PRIORITY[existing.provider] ?? 0)) {
        kept[existingIdx] = activity;
      }
    }
  }

  return kept;
}
