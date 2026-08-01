import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the garmin module BEFORE importing the adapter
vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: vi.fn(),
  getActivitiesByDate: vi.fn(),
  getSleepData: vi.fn(),
  getHrvData: vi.fn(),
  getBodyBatteryEvents: vi.fn(),
  getTrainingReadiness: vi.fn(),
  getDailySummary: vi.fn(),
}));

vi.mock('../../src/services/garmin-session-store', () => ({
  hasActiveGarminConnection: vi.fn(),
}));

import { GarminAdapter, mapGarminActivityType } from '../../src/services/wearable/garmin-adapter';
import * as garmin from '../../src/services/garmin';
import { hasActiveGarminConnection } from '../../src/services/garmin-session-store';

const mockedGarmin = vi.mocked(garmin);
const mockedHasActiveGarminConnection = vi.mocked(hasActiveGarminConnection);

describe('mapGarminActivityType', () => {
  it('maps running → run', () => {
    expect(mapGarminActivityType('running')).toBe('run');
  });

  it('maps trail_running → run', () => {
    expect(mapGarminActivityType('trail_running')).toBe('run');
  });

  it('maps cycling → ride', () => {
    expect(mapGarminActivityType('cycling')).toBe('ride');
  });

  it('maps road_biking → ride', () => {
    expect(mapGarminActivityType('road_biking')).toBe('ride');
  });

  it('maps swimming → swim', () => {
    expect(mapGarminActivityType('swimming')).toBe('swim');
  });

  it('maps lap_swimming → swim', () => {
    expect(mapGarminActivityType('lap_swimming')).toBe('swim');
  });

  it('maps strength_training → strength', () => {
    expect(mapGarminActivityType('strength_training')).toBe('strength');
  });

  it('maps walking → walk', () => {
    expect(mapGarminActivityType('walking')).toBe('walk');
  });

  it('maps hiking → hike', () => {
    expect(mapGarminActivityType('hiking')).toBe('hike');
  });

  it('maps yoga → yoga', () => {
    expect(mapGarminActivityType('yoga')).toBe('yoga');
  });

  it('maps unknown types to other', () => {
    expect(mapGarminActivityType('pickleball')).toBe('other');
    expect(mapGarminActivityType('')).toBe('other');
  });
});

describe('GarminAdapter', () => {
  let adapter: GarminAdapter;

  beforeEach(() => {
    adapter = new GarminAdapter();
    vi.clearAllMocks();
    mockedHasActiveGarminConnection.mockReturnValue(false);
  });

  it('has correct provider and capabilities', () => {
    expect(adapter.provider).toBe('garmin');
    expect(adapter.capabilities).toEqual({
      activities: true,
      sleep: true,
      readiness: true,
      dailySummary: true,
    });
  });

  describe('isConfigured', () => {
    it('requires only an active Garmin connection for this user', async () => {
      mockedHasActiveGarminConnection.mockReturnValue(true);
      expect(await adapter.isConfigured(123)).toBe(true);
      expect(mockedHasActiveGarminConnection).toHaveBeenCalledWith(123);
    });

    it('stays connected for this user even when the global credentials are unset', async () => {
      // GARMIN_EMAIL/GARMIN_PASSWORD are the owner's legacy credential
      // fallback. They previously ANDed into this check, so clearing them
      // disconnected every user who had linked their own Garmin account.
      mockedGarmin.isGarminConfigured.mockReturnValue(false);
      mockedHasActiveGarminConnection.mockReturnValue(true);
      expect(await adapter.isConfigured(123)).toBe(true);
      expect(mockedGarmin.isGarminConfigured).not.toHaveBeenCalled();
    });

    it('returns false when this user has no active connection', async () => {
      mockedGarmin.isGarminConfigured.mockReturnValue(true);
      mockedHasActiveGarminConnection.mockReturnValue(false);
      expect(await adapter.isConfigured(123)).toBe(false);
    });
  });

  describe('getActivities', () => {
    it('transforms GarminActivity to NormalizedActivity', async () => {
      mockedGarmin.getActivitiesByDate.mockResolvedValue([
        {
          activityId: 12345,
          activityName: 'Morning Run',
          activityType: { typeKey: 'running' },
          startTimeLocal: '2025-01-15T07:00:00',
          duration: 3600,
          distance: 10000,
          averageHR: 145,
          maxHR: 170,
          calories: 650,
          averageRunningCadenceInStepsPerMinute: 170,
          averageSpeed: 2.78,
          elevationGain: 50,
        },
      ]);

      const activities = await adapter.getActivities(123, '2025-01-15', '2025-01-15');

      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        id: 'garmin-12345',
        provider: 'garmin',
        type: 'run',
        name: 'Morning Run',
        startTime: '2025-01-15T07:00:00',
        durationSeconds: 3600,
        distanceMeters: 10000,
        calories: 650,
        avgHeartRate: 145,
        maxHeartRate: 170,
        avgCadence: 170,
        avgSpeedMps: 2.78,
        elevationGainMeters: 50,
      });
      // endTime should be startTime + duration
      expect(activities[0].endTime).toBeTruthy();
    });

    it('returns empty array when garmin returns empty', async () => {
      mockedGarmin.getActivitiesByDate.mockResolvedValue([]);
      const activities = await adapter.getActivities(123, '2025-01-15', '2025-01-15');
      expect(activities).toEqual([]);
    });
  });

  describe('getSleep', () => {
    it('extracts sleep data from Garmin response', async () => {
      mockedGarmin.getSleepData.mockResolvedValue({
        dailySleepDTO: {
          sleepTimeSeconds: 28800,
          deepSleepSeconds: 7200,
          lightSleepSeconds: 14400,
          remSleepSeconds: 5400,
          awakeSleepSeconds: 1800,
          sleepScores: { overallScore: 82 },
          sleepStartTimestampGMT: 1705276800000,
          sleepEndTimestampGMT: 1705305600000,
        },
      });

      const sleep = await adapter.getSleep(123, '2025-01-15');
      expect(sleep).not.toBeNull();
      expect(sleep!.provider).toBe('garmin');
      expect(sleep!.totalSleepSeconds).toBe(28800);
      expect(sleep!.deepSleepSeconds).toBe(7200);
      expect(sleep!.sleepScore).toBe(82);
    });

    it('returns null when no data', async () => {
      mockedGarmin.getSleepData.mockResolvedValue(null);
      const sleep = await adapter.getSleep(123, '2025-01-15');
      expect(sleep).toBeNull();
    });
  });

  describe('getReadiness', () => {
    it('combines HRV, body battery, and training readiness', async () => {
      mockedGarmin.getHrvData.mockResolvedValue({
        hrvSummary: { weeklyAvg: 55 },
      });
      mockedGarmin.getBodyBatteryEvents.mockResolvedValue([
        {
          bodyBatteryValuesArray: [
            [1713232800000, 'stable', 82],
            [1713236400000, 'draining', 78],
          ],
        },
      ]);
      mockedGarmin.getTrainingReadiness.mockResolvedValue({
        score: 65,
      });
      mockedGarmin.getDailySummary.mockResolvedValue({
        bodyBatteryHighestValue: 90,
        bodyBatteryLowestValue: 44,
      });

      const readiness = await adapter.getReadiness(123, '2025-01-15');
      expect(readiness).not.toBeNull();
      expect(readiness!.provider).toBe('garmin');
      expect(readiness!.hrvMs).toBe(55);
      expect(readiness!.bodyBattery).toBe(78);
      expect(readiness!.readinessScore).toBe(65);
      expect(readiness!.recoveryScore).toBeNull(); // Garmin has no recovery score
    });
  });

  describe('getDailySummary', () => {
    it('maps GarminDailySummary to NormalizedDailySummary', async () => {
      mockedGarmin.getDailySummary.mockResolvedValue({
        totalSteps: 12000,
        totalDistanceMeters: 9500,
        activeKilocalories: 450,
        totalKilocalories: 2200,
        restingHeartRate: 58,
        averageHeartRate: 72,
        maxHeartRate: 165,
        averageStressLevel: 35,
        bodyBatteryHighestValue: 95,
        bodyBatteryLowestValue: 20,
      });

      const summary = await adapter.getDailySummary(123, '2025-01-15');
      expect(summary).not.toBeNull();
      expect(summary!.steps).toBe(12000);
      expect(summary!.restingHeartRate).toBe(58);
      expect(summary!.bodyBatteryHigh).toBe(95);
    });
  });
});
