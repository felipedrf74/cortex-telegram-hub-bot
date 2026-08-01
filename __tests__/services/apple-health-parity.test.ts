/**
 * Apple Health Parity Tests — derived readiness, sleep score, body battery
 *
 * Verifies that Apple Health users see the same class of readiness/recovery
 * values as Garmin users by deriving scores from raw Apple Health signals.
 *
 * Covers:
 *   1. deriveAppleHealthSleepScore — sleep score from stage proportions
 *   2. deriveBodyBatteryEquivalent — energy reserve from sleep + HRV + RHR
 *   3. scoreHrv / scoreSleep / scoreBodyBattery — provider-agnostic scorers
 *   4. calculateReadiness falls through to Apple Health when Garmin not configured
 *   5. Structural: readiness-scorer uses Apple Health data
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/services/database', () => ({
  getDb: () => ({ prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }) }),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    app: { timezone: 'Europe/Lisbon' },
    garmin: { tokenPath: '/tmp/garmin-test', coachEnabled: false },
  },
}));
// Mock Garmin module to prevent real API calls and file access
vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: () => false,
  getHrvData: vi.fn(),
  getSleepData: vi.fn(),
  getBodyBatteryEvents: vi.fn(),
  getTrainingReadiness: vi.fn(),
  getActivitiesByDate: vi.fn(),
}));
// Mock training signals
vi.mock('../../src/services/training-signals', () => ({
  publishLowSleep: vi.fn(),
  publishLowHrv: vi.fn(),
  publishLowReadiness: vi.fn(),
}));

import {
  scoreHrv, scoreSleep, scoreBodyBattery, scoreAcwr,
  deriveAppleHealthSleepScore, deriveBodyBatteryEquivalent,
} from '../../src/services/readiness-scorer';

// ═══════════════════════════════════════════════════════════════════
// 1. Sleep Score Derivation
// ═══════════════════════════════════════════════════════════════════

describe('apple-health-parity: sleep score derivation', () => {
  it('8 hours with 40% deep+REM = high score', () => {
    const score = deriveAppleHealthSleepScore(480, 120, 72); // 8h, 2h deep, 1.2h REM
    expect(score).toBeGreaterThanOrEqual(75);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('5 hours with low deep+REM = low-moderate score', () => {
    const score = deriveAppleHealthSleepScore(300, 30, 20); // 5h, 30min deep, 20min REM
    // 300/480 = 62.5% duration, (30+20)/300 = 16.7% quality → ~51
    expect(score).toBeLessThan(60);
    expect(score).toBeGreaterThan(30);
  });

  it('7 hours with normal stages = moderate-good score', () => {
    const score = deriveAppleHealthSleepScore(420, 90, 60); // 7h, 1.5h deep, 1h REM
    expect(score).toBeGreaterThanOrEqual(60);
    expect(score).toBeLessThanOrEqual(90);
  });

  it('0 minutes returns low score (neutral quality fallback)', () => {
    const score = deriveAppleHealthSleepScore(0, 0, 0);
    // 0 duration × 60% + 50 neutral quality × 40% = 20
    expect(score).toBeLessThanOrEqual(20);
  });

  it('score is always 0-100', () => {
    const high = deriveAppleHealthSleepScore(600, 200, 200); // 10h, extreme stages
    const low = deriveAppleHealthSleepScore(60, 0, 0); // 1h, no stages
    expect(high).toBeLessThanOrEqual(100);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(100);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Body Battery Equivalent
// ═══════════════════════════════════════════════════════════════════

describe('apple-health-parity: body battery derivation', () => {
  it('good sleep + high HRV + low RHR = high body battery', () => {
    const bb = deriveBodyBatteryEquivalent(85, 80, 55, 60);
    expect(bb).toBeGreaterThanOrEqual(75);
  });

  it('poor sleep + low HRV + high RHR = low body battery', () => {
    const bb = deriveBodyBatteryEquivalent(30, 30, 75, 60);
    expect(bb).toBeLessThan(40);
  });

  it('neutral inputs = moderate body battery', () => {
    const bb = deriveBodyBatteryEquivalent(60, 60, null, null);
    expect(bb).toBeGreaterThanOrEqual(40);
    expect(bb).toBeLessThanOrEqual(75);
  });

  it('body battery is always 0-100', () => {
    const high = deriveBodyBatteryEquivalent(100, 100, 40, 60);
    const low = deriveBodyBatteryEquivalent(0, 0, 90, 60);
    expect(high).toBeLessThanOrEqual(100);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  // Garmin syncs sleep, steps, workouts and RHR to Apple Health but NOT HRV
  // Status, so a Garmin-only iOS user has no HRV rows at all.
  describe('when HRV was never measured', () => {
    it('redistributes HRV weight instead of scoring it as zero', () => {
      const withoutHrv = deriveBodyBatteryEquivalent(90, null, 55, 60);
      // Treating the missing pillar as 0 would drag this far below the
      // measured signals, which were both strong.
      expect(withoutHrv).toBeGreaterThan(70);
    });

    it('reflects only the measured signals', () => {
      // Sleep 90 (0.40) and RHR 55 vs 60 baseline -> rhrScore 110 clamped 100
      // (0.30). Renormalised over 0.70 that is (90*0.4 + 100*0.3) / 0.7 = 94.
      expect(deriveBodyBatteryEquivalent(90, null, 55, 60)).toBe(94);
    });

    it('does not inherit the placeholder a missing HRV used to contribute', () => {
      // Poor sleep and elevated RHR must not be propped up by a stand-in HRV.
      const poor = deriveBodyBatteryEquivalent(30, null, 75, 60);
      const poorWithNeutralHrv = deriveBodyBatteryEquivalent(30, 70, 75, 60);
      expect(poor).toBeLessThan(poorWithNeutralHrv);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Provider-Agnostic Scorers
// ═══════════════════════════════════════════════════════════════════

describe('apple-health-parity: provider-agnostic scorers', () => {
  it('scoreHrv works with raw Apple Health HRV values', () => {
    // Apple Health HRV is in milliseconds, same unit as Garmin
    // ratio = today/avg. <0.8→30, <0.9→50, ≤1.1→70, >1.1→90
    expect(scoreHrv(45, 50)).toBe(70); // 45/50=0.9, ≥0.9 ≤1.1 → 70
    expect(scoreHrv(50, 50)).toBe(70); // 50/50=1.0 → 70 (within 10%)
    expect(scoreHrv(60, 50)).toBe(90); // 60/50=1.2 → 90 (above avg)
    expect(scoreHrv(35, 50)).toBe(30); // 35/50=0.7 → 30 (>20% below)
    expect(scoreHrv(42, 50)).toBe(50); // 42/50=0.84 → 50 (<0.9 but ≥0.8)
  });

  it('scoreSleep works with derived Apple Health sleep score', () => {
    // When Apple Health provides a derived sleep score, scoreSleep uses it
    expect(scoreSleep(8, 85)).toBe(85);    // quality overrides duration
    expect(scoreSleep(5, null)).toBe(40);  // 5h (≥5, <6) → 40
    expect(scoreSleep(7.5, null)).toBe(80); // 7.5h (≥7, <8) → 80
    expect(scoreSleep(4, null)).toBe(20);   // 4h (<5) → 20
    expect(scoreSleep(8.5, null)).toBe(90); // 8.5h (≥8) → 90
  });

  it('scoreBodyBattery works with derived values', () => {
    expect(scoreBodyBattery(80)).toBe(95);
    expect(scoreBodyBattery(50)).toBe(60);
    expect(scoreBodyBattery(15)).toBe(10);
  });

  it('scoreAcwr works with Apple Health workout data', () => {
    expect(scoreAcwr(1.0)).toBe(85);  // sweet spot
    expect(scoreAcwr(1.4)).toBe(50);  // moderate risk
    expect(scoreAcwr(1.6)).toBe(20);  // injury risk
    expect(scoreAcwr(0.5)).toBe(70);  // under-training
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Structural: readiness-scorer uses Apple Health
// ═══════════════════════════════════════════════════════════════════

describe('apple-health-parity: structural', () => {
  it('readiness-scorer.ts exports deriveAppleHealthSleepScore', () => {
    expect(typeof deriveAppleHealthSleepScore).toBe('function');
  });

  it('readiness-scorer.ts exports deriveBodyBatteryEquivalent', () => {
    expect(typeof deriveBodyBatteryEquivalent).toBe('function');
  });

  it('readiness-scorer.ts has Apple Health calculation path', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/readiness-scorer.ts'),
      'utf8',
    );
    expect(source).toContain('calculateAppleHealthReadiness');
    expect(source).toContain('apple_health_data');
  });

  it('calculateReadiness falls through to Apple Health when Garmin not configured', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/readiness-scorer.ts'),
      'utf8',
    );
    expect(source).toContain('appleResult');
    expect(source).toContain('No wearable connected');
  });

  it('apple-health-adapter fills derived readiness and body battery', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/wearable/apple-health-adapter.ts'),
      'utf8',
    );
    expect(source).toContain('deriveBodyBatteryEquivalent');
    expect(source).toContain('deriveAppleHealthSleepScore');
    expect(source).not.toContain('readinessScore: null,');
  });

  it('apple-health-adapter derives sleep score instead of null', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/wearable/apple-health-adapter.ts'),
      'utf8',
    );
    expect(source).toContain('derivedSleepScore');
    expect(source).not.toContain("sleepScore: null, // Apple Health doesn't compute a score");
  });

  it('Garmin scoring functions are exported for reuse', () => {
    // These functions must be public so the Apple Health adapter can use them
    expect(typeof scoreHrv).toBe('function');
    expect(typeof scoreSleep).toBe('function');
    expect(typeof scoreBodyBattery).toBe('function');
    expect(typeof scoreAcwr).toBe('function');
  });
});
