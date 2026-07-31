/**
 * Tests for src/services/readiness-scorer.ts
 *
 * Tests the individual factor scorers (pure functions) and the
 * composite readiness calculation with mocked Garmin data.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: {
    garmin: { email: '', password: '' },
    financeEncryption: { enabled: false, masterKey: '' },
    telegram: { allowedUserIds: [1] },
  },
}));

// Mock Garmin functions — use vi.hoisted to ensure availability before vi.mock
const mockGarmin = vi.hoisted(() => ({
  isGarminConfigured: vi.fn(() => true),
  getHrvData: vi.fn(),
  getSleepData: vi.fn(),
  getBodyBatteryEvents: vi.fn(),
  getTrainingReadiness: vi.fn(),
  getDailySummary: vi.fn(),
  getActivitiesByDate: vi.fn(),
}));

const mockWearableService = vi.hoisted(() => ({
  getReadiness: vi.fn(),
}));

vi.mock('../../src/services/garmin', () => mockGarmin);
vi.mock('../../src/services/wearable/wearable-service', () => mockWearableService);

import {
  scoreHrv, scoreSleep, scoreBodyBattery, scoreAcwr,
  calculateReadiness, persistReadinessScore, getRecentReadinessScores,
  computeAcwr,
} from '../../src/services/readiness-scorer';
import { getCurrentContext } from '../../src/utils/request-context';

// ── Unit Tests: Individual Factor Scorers ──

describe('readiness-scorer — factor scorers', () => {
  describe('scoreHrv', () => {
    it('returns 30 when today is >20% below average', () => {
      expect(scoreHrv(40, 60)).toBe(30); // 40/60 = 0.67
    });

    it('returns 70 when within 10% of average', () => {
      expect(scoreHrv(58, 60)).toBe(70);
    });

    it('returns 90 when above average', () => {
      expect(scoreHrv(70, 60)).toBe(90);
    });

    it('returns 60 when no baseline (avg=0)', () => {
      expect(scoreHrv(50, 0)).toBe(60);
    });
  });

  describe('scoreSleep', () => {
    it('returns 20 for less than 5 hours', () => {
      expect(scoreSleep(4.5, null)).toBe(20);
    });

    it('returns 80 for 7-8 hours', () => {
      expect(scoreSleep(7.5, null)).toBe(80);
    });

    it('returns 90 for more than 8 hours', () => {
      expect(scoreSleep(8.5, null)).toBe(90);
    });

    it('uses Garmin quality score but keeps sleep duration as a safety floor', () => {
      expect(scoreSleep(7.5, 85)).toBe(80);
      expect(scoreSleep(3, 95)).toBe(20);
    });
  });

  describe('scoreBodyBattery', () => {
    it('returns 10 for depleted (<20)', () => {
      expect(scoreBodyBattery(15)).toBe(10);
    });

    it('returns 80 for good (60-80)', () => {
      expect(scoreBodyBattery(75)).toBe(80);
    });

    it('returns 95 for excellent (>80)', () => {
      expect(scoreBodyBattery(90)).toBe(95);
    });
  });

  describe('scoreAcwr', () => {
    it('returns 20 for injury risk (>1.5)', () => {
      expect(scoreAcwr(1.6)).toBe(20);
    });

    it('returns 85 for sweet spot (0.8-1.2)', () => {
      expect(scoreAcwr(1.0)).toBe(85);
    });

    it('returns 70 for under-training (<0.8)', () => {
      expect(scoreAcwr(0.5)).toBe(70);
    });

    it('returns 50 for moderate risk (1.2-1.5)', () => {
      expect(scoreAcwr(1.3)).toBe(50);
    });

    it('treats non-finite ACWR as neutral instead of high risk', () => {
      expect(scoreAcwr(Number.NaN)).toBe(60);
      expect(scoreAcwr(Number.POSITIVE_INFINITY)).toBe(60);
    });

    it('pins ACWR band boundaries', () => {
      expect(scoreAcwr(0.8)).toBe(85);
      expect(scoreAcwr(1.2)).toBe(85);
      expect(scoreAcwr(1.2001)).toBe(50);
      expect(scoreAcwr(1.5)).toBe(50);
      expect(scoreAcwr(1.5001)).toBe(20);
    });
  });

  describe('computeAcwr', () => {
    it('uses the same UTC-calendar-day window for displayed loads and ratio inputs', () => {
      const now = new Date('2026-06-03T12:00:00.000Z');
      const chronicDays = Array.from({ length: 14 }, (_, index) => ({
        startTimeGMT: `2026-05-${String(7 + index).padStart(2, '0')}T01:00:00.000Z`,
        trainingLoad: 10,
      }));
      const result = computeAcwr([
        { startTimeGMT: '2026-05-06T01:00:00.000Z', trainingLoad: 280 },
        ...chronicDays,
        { startTimeGMT: '2026-06-01T01:00:00.000Z', trainingLoad: 70 },
        { startTimeGMT: '2026-06-02T01:00:00.000Z', trainingLoad: 70 },
      ], now);

      expect(result.chronicLoad).toBe(280);
      expect(result.acuteLoad).toBe(140);
      expect(Number.isFinite(result.acwr)).toBe(true);
      expect(result.acwr).toBeGreaterThan(0);
    });
  });
});

// ── Integration Tests: Composite Score ──

describe('readiness-scorer — calculateReadiness', () => {
  function seedActiveGarminSession(userId: number, email = `athlete-${userId}@example.com`): void {
    testDb.prepare(`
      INSERT OR REPLACE INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status, updated_at)
      VALUES (?, ?, '{}', 'active', datetime('now'))
    `).run(userId, email);
    testDb.prepare(`
      INSERT OR REPLACE INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json, last_refreshed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(userId, '{"token":"oauth1"}', '{"token":"oauth2"}');
  }

  /**
   * Disconnect a user from Garmin.
   *
   * Garmin availability is per-user connection state, not deployment config.
   * These cases used to fake "no Garmin" by flipping the global
   * `isGarminConfigured()` env flag, which also disabled every *other*
   * connected user. That conjunct is gone, so the switch is real data.
   */
  function clearGarminConnection(userId: number): void {
    testDb.prepare('DELETE FROM garmin_user_tokens WHERE user_id = ?').run(userId);
    testDb.prepare('DELETE FROM garmin_sessions WHERE user_id = ?').run(userId);
  }

  function seedAppleHealthData(
    userId: number,
    types: Array<'hrv' | 'sleep' | 'rhr' | 'summary'> = ['hrv', 'sleep', 'rhr', 'summary'],
  ): void {
    const today = new Date().toISOString().slice(0, 10);
    const rows: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (types.includes('hrv')) rows.push({ type: 'hrv', data: { value: 60 } });
    if (types.includes('sleep')) {
      rows.push({
        type: 'sleep',
        data: { totalSleepSeconds: 28800, deepSleepSeconds: 5400, remSleepSeconds: 7200 },
      });
    }
    if (types.includes('rhr')) rows.push({ type: 'resting_heart_rate', data: { value: 52 } });
    if (types.includes('summary')) {
      rows.push({
        type: 'daily_summary',
        data: { activeCalories: 120, exerciseMinutes: 20, steps: 3500 },
      });
    }

    const insert = testDb.prepare(`
      INSERT OR REPLACE INTO apple_health_data (user_id, data_type, date, data_json, source_name)
      VALUES (?, ?, ?, ?, 'test')
    `);
    for (const row of rows) {
      insert.run(userId, row.type, today, JSON.stringify(row.data));
    }
  }

  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    vi.clearAllMocks();
    mockWearableService.getReadiness.mockResolvedValue(null);
    try {
      testDb.prepare("INSERT OR IGNORE INTO users (id, first_name, tier, auth_provider, status) VALUES (1, 'Test', 'owner', 'test', 'active')").run();
      testDb.prepare("INSERT OR IGNORE INTO users (id, first_name, tier, auth_provider, status) VALUES (2, 'Connected', 'pro', 'test', 'active')").run();
      seedActiveGarminSession(1, 'owner@example.com');
    } catch { /* table may not exist in minimal test db */ }
  });
  afterEach(() => { testDb.close(); });

  it('returns score between 0 and 100', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 55, weeklyAvg: 50 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 80 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 70 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    const result = await calculateReadiness(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('weights: HRV 30%, sleep 30%, body battery 20%, training load 20%', async () => {
    // Set all factors to known scores: HRV=90, sleep=80, BB=60, load=85
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 70, weeklyAvg: 60 } }); // above avg → 90
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 27000, overallSleepScore: 80 } }); // 80
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 55 }]); // 40-60 → 60
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]); // ACWR ~1.0 → 85

    const result = await calculateReadiness(1);
    // Expected: 90*0.3 + 80*0.3 + 60*0.2 + 85*0.2 = 27 + 24 + 12 + 17 = 80
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.score).toBeLessThanOrEqual(85);
  });

  it('returns rest_day when score < 35', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 20, weeklyAvg: 60 } }); // 30
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 14400 } }); // 4h → 20
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 10 }]); // 10
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue(
      Array.from({ length: 14 }, () => ({ duration: 7200, startTimeLocal: new Date().toISOString() }))
    ); // high ACWR → 20

    const result = await calculateReadiness(1);
    expect(result.score).toBeLessThan(35);
    expect(result.recommendation).toBe('rest_day');
  });

  it('returns full_intensity when score >= 80', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 70, weeklyAvg: 60 } }); // 90
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 30600, overallSleepScore: 92 } }); // 92
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 85 }]); // 95
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]); // ACWR sweet spot → 85

    const result = await calculateReadiness(1);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.recommendation).toBe('full_intensity');
  });

  it('returns neutral (60) when no wearable configured', async () => {
    clearGarminConnection(1);
    // With no Apple Health data either (mock DB returns empty), falls to neutral
    const result = await calculateReadiness(1);
    expect(result.score).toBe(60);
    expect(result.recommendation).toBe('reduce_25pct');
    expect(result.reasoning).toContain('conservative default readiness');
  });

  it('uses actual Garmin training load values instead of a constant stress score', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 60, weeklyAvg: 60 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 90 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 80 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([
      { activityTrainingLoad: 180, startTimeLocal: daysAgo(1), duration: 3600 },
      { activityTrainingLoad: 120, startTimeLocal: daysAgo(5), duration: 3600 },
      { activityTrainingLoad: 90, startTimeLocal: daysAgo(10), duration: 3600 },
    ]);

    const result = await calculateReadiness(1);
    expect(result.factors.trainingLoad.acuteLoad).toBe(300);
    expect(result.factors.trainingLoad.chronicLoad).toBe(390);
    expect(result.factors.trainingLoad.acwr).toBe(1);
  });

  it('uses uncoupled ACWR for stable Garmin activity history', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
    const activities = [
      ...Array.from({ length: 21 }, (_, index) => ({
        activityTrainingLoad: 50,
        startTimeLocal: daysAgo(27 - index),
        duration: 3600,
      })),
      ...Array.from({ length: 7 }, (_, index) => ({
        activityTrainingLoad: 100,
        startTimeLocal: daysAgo(6 - index),
        duration: 3600,
      })),
    ];
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 60, weeklyAvg: 60 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 90 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 80 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue(activities);

    const result = await calculateReadiness(1);

    expect(result.factors.trainingLoad.acuteLoad).toBe(700);
    expect(result.factors.trainingLoad.chronicLoad).toBe(1750);
    expect(result.factors.trainingLoad.acwr).toBe(2);
  });

  it('handles missing data gracefully (uses fallback per factor)', async () => {
    mockGarmin.getHrvData.mockRejectedValue(new Error('Garmin unavailable'));
    mockGarmin.getSleepData.mockRejectedValue(new Error('timeout'));
    mockGarmin.getBodyBatteryEvents.mockRejectedValue(new Error('error'));
    mockGarmin.getTrainingReadiness.mockRejectedValue(new Error('error'));
    mockGarmin.getActivitiesByDate.mockRejectedValue(new Error('error'));

    // Should not throw — uses fallbacks
    const result = await calculateReadiness(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('uses Garmin readiness for a non-owner user with an active Garmin connection', async () => {
    seedActiveGarminSession(2, 'connected@example.com');

    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 68, weeklyAvg: 60 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 84 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 82 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({ score: 74 });
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    const result = await calculateReadiness(2);
    expect(result.score).toBeGreaterThan(0);
    expect(result.factors.bodyBattery.current).toBe(82);
  });

  it('binds Garmin readiness reads to the requested user scope', async () => {
    seedActiveGarminSession(2, 'connected@example.com');

    const scopedUserIds: Array<number | undefined> = [];
    const captureScope = <T>(value: T) => {
      scopedUserIds.push(getCurrentContext()?.userId);
      return Promise.resolve(value);
    };

    mockGarmin.getHrvData.mockImplementation(() =>
      captureScope({ hrvSummary: { lastNightAvg: 68, weeklyAvg: 60 } })
    );
    mockGarmin.getSleepData.mockImplementation(() =>
      captureScope({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 84 } })
    );
    mockGarmin.getBodyBatteryEvents.mockImplementation(() =>
      captureScope([{ bodyBatteryLevel: 82 }])
    );
    mockGarmin.getTrainingReadiness.mockImplementation(() =>
      captureScope({ score: 74 })
    );
    mockGarmin.getActivitiesByDate.mockImplementation(() =>
      captureScope([])
    );
    mockGarmin.getDailySummary.mockImplementation(() =>
      captureScope(null)
    );

    await calculateReadiness(2);

    expect(scopedUserIds).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('falls back to neutral when Garmin is configured globally but this user is not connected', async () => {
    const result = await calculateReadiness(2);
    expect(result.score).toBe(60);
    expect(result.reasoning).toContain('No wearable connected');
  });

  it('does not publish low_sleep when Garmin sleep data is missing', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 68, weeklyAvg: 60 } });
    mockGarmin.getSleepData.mockResolvedValue(null);
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 82 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({ score: 74 });
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    await calculateReadiness(1);

    const row = testDb.prepare(
      "SELECT signal_type, payload FROM agent_signals WHERE user_id = ? AND signal_type = 'low_sleep'"
    ).get(1) as { signal_type: string; payload: string } | undefined;

    expect(row).toBeUndefined();
  });

  it('uses WHOOP readiness when Garmin is unavailable but WHOOP is connected', async () => {
    clearGarminConnection(1);
    mockWearableService.getReadiness.mockResolvedValue({
      provider: 'whoop',
      date: '2026-04-16',
      readinessScore: 81,
      hrvMs: 64,
      restingHeartRate: 49,
      bodyBattery: null,
      recoveryScore: 81,
      raw: {},
    });

    const result = await calculateReadiness(1);
    expect(result.score).toBe(81);
    expect(result.recommendation).toBe('full_intensity');
    expect(result.reasoning).toContain('WHOOP');
    expect(result.factors.bodyBattery.current).toBe(81);
  });

  it('uses Apple Health energy reserve when connected Garmin lacks body battery', async () => {
    seedAppleHealthData(1);

    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 55, weeklyAvg: 50 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 80 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([]);
    mockGarmin.getDailySummary.mockResolvedValue(null);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    const result = await calculateReadiness(1);
    expect(result.factors.bodyBattery.current).toBeGreaterThan(0);
    expect(result.factors.bodyBattery.morningPeak).toBeGreaterThan(0);
    expect(result.reasoning).toContain('Apple Health filled Body Battery');
  });

  it('derives Apple Health body battery from activity-only HealthKit data', async () => {
    clearGarminConnection(1);
    seedAppleHealthData(1, ['summary']);

    const result = await calculateReadiness(1);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasoning).toContain('Apple Health');
    expect(result.factors.bodyBattery.current).toBeGreaterThan(0);
    expect(result.factors.bodyBattery.morningPeak).toBeGreaterThan(0);
  });

  it.each([
    ['hrvOnly', ['hrv']],
    ['sleepOnly', ['sleep']],
    ['rhrOnly', ['rhr']],
    ['hrvSleep', ['hrv', 'sleep']],
    ['hrvRhr', ['hrv', 'rhr']],
    ['sleepRhr', ['sleep', 'rhr']],
  ] as const)('derives Apple Health body battery from partial HealthKit data: %s', async (_caseName, types) => {
    clearGarminConnection(1);
    seedAppleHealthData(1, [...types]);

    const result = await calculateReadiness(1);

    expect(result.reasoning).toContain('Apple Health');
    expect(result.factors.bodyBattery.current).toBeGreaterThan(0);
    expect(result.factors.bodyBattery.morningPeak).toBeGreaterThan(0);
    expect(result.factors.bodyBattery.score).toBeGreaterThan(0);
  });

  it('does not synthesize a fake 50 body battery when Garmin events are missing', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 55, weeklyAvg: 50 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 80 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([]);
    mockGarmin.getDailySummary.mockResolvedValue(null);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    const result = await calculateReadiness(1);
    expect(result.factors.bodyBattery.current).toBe(0);
    expect(result.factors.bodyBattery.score).toBe(60);
  });

  // ── Provenance: source + asOf (Training redesign Phase 0) ──

  it('stamps source garmin and a compute-time asOf on the Garmin composite path', async () => {
    mockGarmin.getHrvData.mockResolvedValue({ hrvSummary: { lastNightAvg: 55, weeklyAvg: 50 } });
    mockGarmin.getSleepData.mockResolvedValue({ dailySleepDTO: { sleepTimeSeconds: 28800, overallSleepScore: 80 } });
    mockGarmin.getBodyBatteryEvents.mockResolvedValue([{ bodyBatteryLevel: 70 }]);
    mockGarmin.getTrainingReadiness.mockResolvedValue({});
    mockGarmin.getActivitiesByDate.mockResolvedValue([]);

    const before = Date.now();
    const result = await calculateReadiness(1);
    const after = Date.now();

    expect(result.source).toBe('garmin');
    expect(typeof result.asOf).toBe('string');
    const asOfMs = Date.parse(result.asOf!);
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  it('stamps source whoop on the WHOOP fallback path', async () => {
    clearGarminConnection(1);
    mockWearableService.getReadiness.mockResolvedValue({
      provider: 'whoop',
      date: '2026-04-16',
      readinessScore: 81,
      hrvMs: 64,
      restingHeartRate: 49,
      bodyBattery: null,
      recoveryScore: 81,
      raw: {},
    });

    const result = await calculateReadiness(1);
    expect(result.source).toBe('whoop');
    expect(Number.isFinite(Date.parse(result.asOf ?? ''))).toBe(true);
  });

  it('stamps source apple_health on the Apple Health derived path', async () => {
    clearGarminConnection(1);
    seedAppleHealthData(1);

    const result = await calculateReadiness(1);
    expect(result.reasoning).toContain('Apple Health');
    expect(result.source).toBe('apple_health');
    expect(Number.isFinite(Date.parse(result.asOf ?? ''))).toBe(true);
  });

  it('stamps source estimated on the neutral no-wearable fallback', async () => {
    clearGarminConnection(1);

    const result = await calculateReadiness(1);
    expect(result.score).toBe(60);
    expect(result.reasonCode).toBe('WEARABLE_INTEGRATION_MISSING');
    expect(result.source).toBe('estimated');
    expect(Number.isFinite(Date.parse(result.asOf ?? ''))).toBe(true);
  });
});

// ── Persistence Tests ──

describe('readiness-scorer — persistence', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('persists score to readiness_scores table', () => {
    persistReadinessScore(1, {
      score: 75,
      factors: {} as any,
      recommendation: 'reduce_10pct',
      reasoning: 'test',
    });

    const row = testDb.prepare('SELECT * FROM readiness_scores WHERE user_id = 1').get() as any;
    expect(row).toBeTruthy();
    expect(row.score).toBe(75);
    expect(row.recommendation).toBe('reduce_10pct');
  });

  it('getRecentReadinessScores returns history', () => {
    persistReadinessScore(1, { score: 70, factors: {} as any, recommendation: 'reduce_10pct', reasoning: '' });

    const scores = getRecentReadinessScores(1);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(70);
  });
});
