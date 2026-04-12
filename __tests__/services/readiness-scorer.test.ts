/**
 * Tests for src/services/readiness-scorer.ts
 *
 * Tests the individual factor scorers (pure functions) and the
 * composite readiness calculation with mocked Garmin data.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config', () => ({
  config: { garmin: { email: '', password: '' }, financeEncryption: { enabled: false, masterKey: '' } },
}));

// Mock Garmin functions — use vi.hoisted to ensure availability before vi.mock
const mockGarmin = vi.hoisted(() => ({
  isGarminConfigured: vi.fn(() => true),
  getHrvData: vi.fn(),
  getSleepData: vi.fn(),
  getBodyBatteryEvents: vi.fn(),
  getTrainingReadiness: vi.fn(),
  getActivitiesByDate: vi.fn(),
}));

vi.mock('../../src/services/garmin', () => mockGarmin);

import {
  scoreHrv, scoreSleep, scoreBodyBattery, scoreAcwr,
  calculateReadiness, persistReadinessScore, getRecentReadinessScores,
} from '../../src/services/readiness-scorer';

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

    it('uses Garmin quality score when available', () => {
      expect(scoreSleep(5, 85)).toBe(85);
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
  });
});

// ── Integration Tests: Composite Score ──

describe('readiness-scorer — calculateReadiness', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    vi.clearAllMocks();
    mockGarmin.isGarminConfigured.mockReturnValue(true);
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
    mockGarmin.isGarminConfigured.mockReturnValue(false);
    // With no Apple Health data either (mock DB returns empty), falls to neutral
    const result = await calculateReadiness(1);
    expect(result.score).toBe(60);
    expect(result.recommendation).toBe('full_intensity');
    expect(result.reasoning).toContain('No wearable connected');
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
});

// ── Persistence Tests ──

describe('readiness-scorer — persistence', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
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
