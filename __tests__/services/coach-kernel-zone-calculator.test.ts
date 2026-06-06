/**
 * Slice A2 — ZoneSet calculator tests.
 *
 * Pins:
 *   - Power zones via Coggan %FTP (FTP=250 → recovery 0-138, ..., neuromuscular 300+)
 *   - Running pace zones via Daniels VDOT (T-pace=240s/km → threshold band)
 *   - Swim pace zones via %CSS (CSS=100s/100m → threshold band)
 *   - HR zones prefer LTHR over HRmax
 *   - HR zones return undefined when both anchors missing
 *   - computeZoneSet returns undefined for sports with missing anchor
 *   - Intensity factor (IF) calculations for B1
 *   - Defensive throws on invalid anchors (0, negative, NaN)
 */

import { describe, expect, it } from 'vitest';
import {
  computeBikePowerZones,
  computeHeartRateZones,
  computeIntensityFactorForZone,
  computeRunningPaceZones,
  computeSwimPaceZones,
  computeZoneSet,
  isValueInZoneRange,
} from '../../src/services/coach-kernel/zone-calculator';

describe('computeBikePowerZones — Coggan %FTP', () => {
  it('computes all six zones from FTP=250', () => {
    const zones = computeBikePowerZones(250);
    // recovery: 0-55% → 0-138 watts
    expect(zones.recovery.min).toBe(0);
    expect(zones.recovery.max).toBe(138); // 55% of 250 = 137.5 → 138 rounded
    // aerobic: 55-75% → 138-188 watts
    expect(zones.aerobic.min).toBe(138);
    expect(zones.aerobic.max).toBe(188);
    // tempo: 75-90% → 188-225 watts
    expect(zones.tempo.min).toBe(188);
    expect(zones.tempo.max).toBe(225);
    // threshold: 90-105% → 225-263 watts (FTP=250 sits at upper threshold)
    expect(zones.threshold.min).toBe(225);
    expect(zones.threshold.max).toBe(263);
    // vo2: 105-120% → 263-300
    expect(zones.vo2.min).toBe(263);
    expect(zones.vo2.max).toBe(300);
    // neuromuscular: 120-200% → 300-500
    expect(zones.neuromuscular.min).toBe(300);
    expect(zones.neuromuscular.max).toBe(500);
  });

  it('FTP=200 produces proportional zones', () => {
    const zones = computeBikePowerZones(200);
    expect(zones.threshold.min).toBe(180); // 90% of 200
    expect(zones.threshold.max).toBe(210); // 105% of 200
  });

  it('throws on non-positive FTP', () => {
    expect(() => computeBikePowerZones(0)).toThrow(/positive/);
    expect(() => computeBikePowerZones(-50)).toThrow(/positive/);
    expect(() => computeBikePowerZones(NaN)).toThrow(/positive/);
    expect(() => computeBikePowerZones(Infinity)).toThrow(/positive/);
  });
});

describe('computeRunningPaceZones — Daniels VDOT', () => {
  it('produces correct min/max for T-pace=240 sec/km (4:00 min/km)', () => {
    const zones = computeRunningPaceZones(240);
    // threshold: 95-105% of T-pace → 228-252 sec/km
    expect(zones.threshold.min).toBe(228); // faster (smaller)
    expect(zones.threshold.max).toBe(252); // slower (larger)
    // vo2: 88-95% of T-pace → 211-228 sec/km (faster than threshold)
    expect(zones.vo2.min).toBe(211);
    expect(zones.vo2.max).toBe(228);
    // recovery: 130-150% of T-pace → 312-360 sec/km (slowest)
    expect(zones.recovery.min).toBe(312);
    expect(zones.recovery.max).toBe(360);
  });

  it('min < max in all zones (pace direction sanity check)', () => {
    const zones = computeRunningPaceZones(300);
    for (const zone of ['recovery', 'aerobic', 'tempo', 'threshold', 'vo2', 'neuromuscular'] as const) {
      expect(zones[zone].min).toBeLessThanOrEqual(zones[zone].max);
    }
  });

  it('throws on invalid T-pace', () => {
    expect(() => computeRunningPaceZones(0)).toThrow();
    expect(() => computeRunningPaceZones(NaN)).toThrow();
  });
});

describe('computeSwimPaceZones — %CSS', () => {
  it('produces correct zones for CSS=100 sec/100m', () => {
    const zones = computeSwimPaceZones(100);
    // threshold: 95-105% of CSS → 95-105 sec/100m (CSS itself sits in this band)
    expect(zones.threshold.min).toBe(95);
    expect(zones.threshold.max).toBe(105);
    // vo2: 88-95% of CSS → 88-95 (faster than threshold)
    expect(zones.vo2.min).toBe(88);
    expect(zones.vo2.max).toBe(95);
    // recovery: 125-140% of CSS → 125-140 (slowest)
    expect(zones.recovery.min).toBe(125);
    expect(zones.recovery.max).toBe(140);
  });

  it('throws on invalid CSS', () => {
    expect(() => computeSwimPaceZones(0)).toThrow();
    expect(() => computeSwimPaceZones(-10)).toThrow();
  });
});

describe('computeHeartRateZones — LTHR vs HRmax fallback', () => {
  it('prefers LTHR when available', () => {
    const zones = computeHeartRateZones({ thresholdHeartRate: 170, maxHeartRate: 190 });
    // threshold: 94-100% LTHR → 160-170 bpm
    expect(zones?.threshold.min).toBe(160); // 94% of 170 = 159.8 → 160
    expect(zones?.threshold.max).toBe(170); // 100% of 170
  });

  it('falls back to HRmax when LTHR missing', () => {
    const zones = computeHeartRateZones({ maxHeartRate: 190 });
    // threshold: 87-93% HRmax → 165-177 bpm
    expect(zones?.threshold.min).toBe(165); // 87% of 190 = 165.3 → 165
    expect(zones?.threshold.max).toBe(177); // 93% of 190 = 176.7 → 177
  });

  it('returns undefined when both anchors missing', () => {
    expect(computeHeartRateZones({})).toBeUndefined();
  });

  it('returns undefined when both anchors are 0/invalid', () => {
    expect(computeHeartRateZones({ maxHeartRate: 0 })).toBeUndefined();
    expect(computeHeartRateZones({ thresholdHeartRate: -10 })).toBeUndefined();
  });
});

describe('computeZoneSet', () => {
  it('returns full ZoneSet with all four tables when all anchors present', () => {
    const set = computeZoneSet({
      thresholdPaceSecondsPerKm: 240,
      cyclingFtpWatts: 250,
      swimCssSecondsPer100m: 100,
      thresholdHeartRate: 170,
    });
    expect(set.runningPaceSecondsPerKm).toBeDefined();
    expect(set.bikePowerWatts).toBeDefined();
    expect(set.swimPaceSecondsPer100m).toBeDefined();
    expect(set.heartRateBpm).toBeDefined();
  });

  it('returns sport-specific tables undefined when anchors missing', () => {
    const set = computeZoneSet({
      cyclingFtpWatts: 250, // only cycling anchor
    });
    expect(set.runningPaceSecondsPerKm).toBeUndefined();
    expect(set.bikePowerWatts).toBeDefined();
    expect(set.swimPaceSecondsPer100m).toBeUndefined();
    expect(set.heartRateBpm).toBeUndefined();
  });

  it('returns all tables undefined for empty profile', () => {
    const set = computeZoneSet({});
    expect(set.runningPaceSecondsPerKm).toBeUndefined();
    expect(set.bikePowerWatts).toBeUndefined();
    expect(set.swimPaceSecondsPer100m).toBeUndefined();
    expect(set.heartRateBpm).toBeUndefined();
  });
});

describe('isValueInZoneRange — half-open boundaries', () => {
  it('assigns shared power boundaries to the higher zone once', () => {
    const zones = computeBikePowerZones(250);
    expect(isValueInZoneRange(138, 'recovery', zones)).toBe(false);
    expect(isValueInZoneRange(138, 'aerobic', zones)).toBe(true);
  });

  it('assigns shared pace boundaries to the slower zone once', () => {
    const zones = computeRunningPaceZones(240);
    expect(isValueInZoneRange(228, 'vo2', zones)).toBe(false);
    expect(isValueInZoneRange(228, 'threshold', zones)).toBe(true);
  });
});

describe('computeIntensityFactorForZone — IF for B1 TSS calculation', () => {
  it('cycling: threshold zone IF ≈ 0.975 (mid 90-105%)', () => {
    const ifVal = computeIntensityFactorForZone('threshold', 'cycling', { cyclingFtpWatts: 250 });
    expect(ifVal).toBeCloseTo(0.975, 3);
  });

  it('cycling: tempo zone IF ≈ 0.825 (mid 75-90%)', () => {
    const ifVal = computeIntensityFactorForZone('tempo', 'cycling', { cyclingFtpWatts: 250 });
    expect(ifVal).toBeCloseTo(0.825, 3);
  });

  it('cycling: vo2 zone IF ≈ 1.125 (mid 105-120%)', () => {
    const ifVal = computeIntensityFactorForZone('vo2', 'cycling', { cyclingFtpWatts: 250 });
    expect(ifVal).toBeCloseTo(1.125, 3);
  });

  it('running: threshold zone IF ≈ 1.0 (mid of 95-105% T-pace)', () => {
    // Running IF is T-pace / actual pace. Midpoint of 95-105% is 100%,
    // so threshold IF ≈ 1.0.
    const ifVal = computeIntensityFactorForZone('threshold', 'running', { thresholdPaceSecondsPerKm: 240 });
    expect(ifVal).toBeCloseTo(1.0, 2);
  });

  it('running: vo2 zone IF > 1.0 (faster than threshold)', () => {
    // VO2 zone midpoint is ~91.5% of T-pace (faster), so IF > 1.
    const ifVal = computeIntensityFactorForZone('vo2', 'running', { thresholdPaceSecondsPerKm: 240 });
    expect(ifVal).toBeGreaterThan(1.0);
  });

  it('running: recovery zone IF < 1.0 (slower than threshold)', () => {
    const ifVal = computeIntensityFactorForZone('recovery', 'running', { thresholdPaceSecondsPerKm: 240 });
    expect(ifVal).toBeLessThan(1.0);
  });

  it('swim: threshold zone IF ≈ 1.0', () => {
    const ifVal = computeIntensityFactorForZone('threshold', 'swimming', { swimCssSecondsPer100m: 100 });
    expect(ifVal).toBeCloseTo(1.0, 2);
  });

  it('returns undefined when sport-specific anchor missing', () => {
    expect(computeIntensityFactorForZone('threshold', 'cycling', {})).toBeUndefined();
    expect(computeIntensityFactorForZone('threshold', 'running', { cyclingFtpWatts: 250 })).toBeUndefined();
    expect(computeIntensityFactorForZone('threshold', 'swimming', {})).toBeUndefined();
  });

  it('returns undefined for neuromuscular steady-state IF', () => {
    expect(computeIntensityFactorForZone('neuromuscular', 'cycling', { cyclingFtpWatts: 250 })).toBeUndefined();
    expect(computeIntensityFactorForZone('neuromuscular', 'running', { thresholdPaceSecondsPerKm: 240 })).toBeUndefined();
    expect(computeIntensityFactorForZone('neuromuscular', 'swimming', { swimCssSecondsPer100m: 100 })).toBeUndefined();
  });
});
