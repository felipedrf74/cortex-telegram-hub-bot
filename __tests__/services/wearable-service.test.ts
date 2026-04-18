import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all adapters
vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: vi.fn().mockReturnValue(false),
  getActivitiesByDate: vi.fn().mockResolvedValue([]),
  getSleepData: vi.fn().mockResolvedValue(null),
  getHrvData: vi.fn().mockResolvedValue(null),
  getBodyBatteryEvents: vi.fn().mockResolvedValue(null),
  getTrainingReadiness: vi.fn().mockResolvedValue(null),
  getDailySummary: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: vi.fn().mockReturnValue(false),
  getTokens: vi.fn().mockReturnValue(null),
  updateAccessToken: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
    }),
  }),
}));

vi.mock('../../src/services/garmin-session-store', () => ({
  hasActiveGarminConnection: vi.fn().mockReturnValue(false),
}));

import * as garmin from '../../src/services/garmin';
import { hasActiveGarminConnection } from '../../src/services/garmin-session-store';
import { isConnected } from '../../src/services/oauth-store';
import {
  getUserProviders,
  getPrimaryReadinessProvider,
  getActivities,
  getReadiness,
  deduplicateActivities,
} from '../../src/services/wearable/wearable-service';
import type { NormalizedActivity, NormalizedReadiness } from '../../src/services/wearable/types';

const mockedGarmin = vi.mocked(garmin);
const mockedHasActiveGarminConnection = vi.mocked(hasActiveGarminConnection);
const mockedIsConnected = vi.mocked(isConnected);

describe('WearableService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset to default "not connected" state
    mockedGarmin.isGarminConfigured.mockReturnValue(false);
    mockedGarmin.getActivitiesByDate.mockResolvedValue([]);
    mockedGarmin.getSleepData.mockResolvedValue(null);
    mockedGarmin.getHrvData.mockResolvedValue(null);
    mockedGarmin.getBodyBatteryEvents.mockResolvedValue(null);
    mockedGarmin.getTrainingReadiness.mockResolvedValue(null);
    mockedGarmin.getDailySummary.mockResolvedValue(null);
    mockedHasActiveGarminConnection.mockReturnValue(false);
    mockedIsConnected.mockReturnValue(false);
  });

  describe('getUserProviders', () => {
    it('returns garmin when configured', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      const providers = await getUserProviders(123);
      expect(providers).toContain('garmin');
    });

    it('returns strava when connected', async () => {
      mockedIsConnected.mockImplementation((_userId, provider) => provider === 'strava');
      const providers = await getUserProviders(123);
      expect(providers).toContain('strava');
    });

    it('returns multiple connected providers', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      mockedIsConnected.mockImplementation((_userId, provider) =>
        provider === 'strava' || provider === 'whoop'
      );
      const providers = await getUserProviders(123);
      expect(providers).toContain('garmin');
      expect(providers).toContain('strava');
      expect(providers).toContain('whoop');
      expect(providers).not.toContain('fitbit');
    });

    it('returns empty when nothing connected', async () => {
      const providers = await getUserProviders(123);
      expect(providers).toEqual([]);
    });
  });

  describe('getPrimaryReadinessProvider', () => {
    it('returns whoop before garmin when both connected', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      mockedIsConnected.mockImplementation((_userId, provider) => provider === 'whoop');

      const primary = await getPrimaryReadinessProvider(123);
      expect(primary).toBe('whoop');
    });

    it('returns garmin when whoop not connected', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      const primary = await getPrimaryReadinessProvider(123);
      expect(primary).toBe('garmin');
    });

    it('returns null when no readiness provider is connected', async () => {
      // Only strava connected (no readiness capability)
      mockedIsConnected.mockImplementation((_userId, provider) => provider === 'strava');
      const primary = await getPrimaryReadinessProvider(123);
      expect(primary).toBeNull();
    });

    it('returns fitbit when only fitbit connected', async () => {
      mockedIsConnected.mockImplementation((_userId, provider) => provider === 'fitbit');
      const primary = await getPrimaryReadinessProvider(123);
      expect(primary).toBe('fitbit');
    });
  });

  describe('deduplicateActivities', () => {
    it('removes duplicate activities with same type and similar start time', () => {
      const activities: NormalizedActivity[] = [
        {
          id: 'garmin-1', provider: 'garmin', type: 'run', name: 'Morning Run',
          startTime: '2025-01-15T07:00:00Z', endTime: '2025-01-15T08:00:00Z',
          durationSeconds: 3600, distanceMeters: 10000, calories: 600,
          avgHeartRate: 150, maxHeartRate: 175, avgCadence: 170,
          avgSpeedMps: 2.78, elevationGainMeters: 50,
        },
        {
          id: 'strava-1', provider: 'strava', type: 'run', name: 'Morning Run',
          startTime: '2025-01-15T07:02:00Z', endTime: '2025-01-15T08:02:00Z', // 2 min later
          durationSeconds: 3600, distanceMeters: 10100, calories: 610,
          avgHeartRate: 148, maxHeartRate: 173, avgCadence: 171,
          avgSpeedMps: 2.81, elevationGainMeters: 52,
        },
      ];

      const deduped = deduplicateActivities(activities);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].provider).toBe('garmin'); // garmin has higher priority
    });

    it('keeps activities of different types even at same time', () => {
      const activities: NormalizedActivity[] = [
        {
          id: 'garmin-1', provider: 'garmin', type: 'run', name: 'Run',
          startTime: '2025-01-15T07:00:00Z', endTime: null,
          durationSeconds: 3600, distanceMeters: null, calories: null,
          avgHeartRate: null, maxHeartRate: null, avgCadence: null,
          avgSpeedMps: null, elevationGainMeters: null,
        },
        {
          id: 'garmin-2', provider: 'garmin', type: 'strength', name: 'Weights',
          startTime: '2025-01-15T07:00:00Z', endTime: null,
          durationSeconds: 3600, distanceMeters: null, calories: null,
          avgHeartRate: null, maxHeartRate: null, avgCadence: null,
          avgSpeedMps: null, elevationGainMeters: null,
        },
      ];

      const deduped = deduplicateActivities(activities);
      expect(deduped).toHaveLength(2);
    });

    it('keeps activities of same type but different times (>5min apart)', () => {
      const activities: NormalizedActivity[] = [
        {
          id: 'garmin-1', provider: 'garmin', type: 'run', name: 'Morning Run',
          startTime: '2025-01-15T07:00:00Z', endTime: null,
          durationSeconds: 3600, distanceMeters: null, calories: null,
          avgHeartRate: null, maxHeartRate: null, avgCadence: null,
          avgSpeedMps: null, elevationGainMeters: null,
        },
        {
          id: 'strava-1', provider: 'strava', type: 'run', name: 'Evening Run',
          startTime: '2025-01-15T18:00:00Z', endTime: null,
          durationSeconds: 2400, distanceMeters: null, calories: null,
          avgHeartRate: null, maxHeartRate: null, avgCadence: null,
          avgSpeedMps: null, elevationGainMeters: null,
        },
      ];

      const deduped = deduplicateActivities(activities);
      expect(deduped).toHaveLength(2);
    });

    it('handles empty array', () => {
      expect(deduplicateActivities([])).toEqual([]);
    });
  });

  describe('getActivities', () => {
    it('merges activities from multiple providers', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      mockedGarmin.getActivitiesByDate.mockResolvedValue([
        {
          activityId: 1, activityName: 'Garmin Run',
          activityType: { typeKey: 'running' },
          startTimeLocal: '2025-01-15T07:00:00',
          duration: 3600, distance: 10000,
        },
      ]);

      // Strava not connected in this test — only garmin
      const activities = await getActivities(123, '2025-01-15', '2025-01-15');
      expect(activities.length).toBeGreaterThanOrEqual(1);
      expect(activities.some(a => a.provider === 'garmin')).toBe(true);
    });
  });

  describe('getReadiness', () => {
    it('falls back to next provider if primary fails', async () => {
      // Connect both whoop and garmin
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      mockedIsConnected.mockImplementation((_userId, provider) => provider === 'whoop');

      // Whoop will fail (no real token), garmin will succeed
      mockedGarmin.getHrvData.mockResolvedValue({ hrvSummary: { weeklyAvg: 50 } });
      mockedGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 70 }]);
      mockedGarmin.getTrainingReadiness.mockResolvedValue({ score: 60 });

      const readiness = await getReadiness(123, '2025-01-15');
      // Should get garmin data since whoop will fail (no token)
      expect(readiness).not.toBeNull();
      expect(readiness!.provider).toBe('garmin');
    });

    it('returns null when no providers are connected', async () => {
      const readiness = await getReadiness(123, '2025-01-15');
      expect(readiness).toBeNull();
    });
  });
});
