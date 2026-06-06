/**
 * Slice B0 — load-source normalization tests.
 *
 * Pins:
 *   - Four parallel dimensions (planned/completed-external/internal/strength/impact)
 *   - Never collapses into a single number
 *   - Cycling NP → device_power TSS (high confidence)
 *   - Running pace → pace-derived TSS
 *   - Swim pace → pace-derived TSS
 *   - sRPE × duration is the universal fallback
 *   - TRIMP from integration preferred over sRPE when present
 *   - Strength tonnage in its own dimension, never folded into TSS
 *   - Impact load only for running
 *   - Confidence rolls up to worst-case across present dimensions
 *   - Quality flags surface missing data
 *   - pickPreferredLoadScore preference order
 */

import { describe, expect, it } from 'vitest';
import {
  estimateSessionLoad,
  pickPreferredLoadScore,
} from '../../src/services/coach-kernel/load-input';

describe('estimateSessionLoad — separated dimensions', () => {
  it('cycling with FTP + normalized power → device_power TSS in completedExternalLoad', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 80,
      completion: {
        durationSec: 3600,
        normalizedPowerWatts: 225,
        sessionRpe: 6,
      },
      athlete: { cyclingFtpWatts: 250 },
    });
    expect(result.completedExternalLoad?.source).toBe('device_power');
    expect(result.completedExternalLoad?.unit).toBe('tss');
    // 1h × (225/250)² × 100 = 81
    expect(result.completedExternalLoad?.score).toBe(81);
    expect(result.completedExternalLoad?.confidence).toBe('high');
  });

  it('running with T-pace + distance + duration → pace-derived TSS', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: {
        durationSec: 3000, // 50 min
        distanceMeters: 12000, // 12 km → 250 sec/km
        sessionRpe: 7,
      },
      athlete: { thresholdPaceSecondsPerKm: 240 },
    });
    expect(result.completedExternalLoad?.source).toBe('pace');
    // IF = 240/250 = 0.96; 50/60 × 0.96² × 100 ≈ 77
    expect(result.completedExternalLoad?.score).toBeGreaterThan(70);
    expect(result.completedExternalLoad?.score).toBeLessThan(85);
    expect(result.completedExternalLoad?.confidence).toBe('high');
  });

  it('swim with CSS + distance + duration → pace-derived TSS', () => {
    const result = estimateSessionLoad({
      sport: 'swimming',
      completion: {
        durationSec: 1800, // 30 min
        distanceMeters: 1800, // → 100 sec/100m (CSS exactly)
        sessionRpe: 8,
      },
      athlete: { swimCssSecondsPer100m: 100 },
    });
    expect(result.completedExternalLoad?.source).toBe('pace');
    // IF = 100/100 = 1.0; 30/60 × 1² × 100 = 50
    expect(result.completedExternalLoad?.score).toBeCloseTo(50, 0);
  });

  it('cycling without power → no completedExternalLoad, only internal', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      completion: {
        durationSec: 3600,
        sessionRpe: 7,
      },
      athlete: { cyclingFtpWatts: 250 },
    });
    expect(result.completedExternalLoad).toBeUndefined();
    expect(result.completedInternalLoad?.source).toBe('session_rpe');
    expect(result.completedInternalLoad?.score).toBe(60 * 7); // 60 min × RPE 7 = 420
    expect(result.sourceQualityFlags).toContain('cycling_power_absent');
  });
});

describe('estimateSessionLoad — universal sRPE fallback', () => {
  it('sRPE × duration always emitted when sRPE + duration both present', () => {
    const result = estimateSessionLoad({
      sport: 'strength',
      completion: { sessionRpe: 8, durationSec: 2700 },
    });
    expect(result.completedInternalLoad?.score).toBe(45 * 8); // 45 min × 8 = 360
    expect(result.completedInternalLoad?.unit).toBe('srpe_au');
    expect(result.completedInternalLoad?.source).toBe('session_rpe');
  });

  it('TRIMP from integration preferred over sRPE', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: {
        sessionRpe: 7,
        durationSec: 3600,
        trimpAu: 95,
      },
    });
    expect(result.completedInternalLoad?.source).toBe('device_hr');
    expect(result.completedInternalLoad?.score).toBe(95);
    expect(result.completedInternalLoad?.unit).toBe('trimp_au');
  });

  it('no sRPE + no TRIMP → no internal load', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      completion: { durationSec: 3600 },
    });
    expect(result.completedInternalLoad).toBeUndefined();
    expect(result.sourceQualityFlags).toContain('srpe_missing');
  });
});

describe('estimateSessionLoad — separated strength', () => {
  it('strength tonnage NOT folded into TSS', () => {
    const result = estimateSessionLoad({
      sport: 'strength',
      completion: {
        durationSec: 3000,
        strengthTonnageKg: 4500,
        sessionRpe: 8,
        rir: 2,
      },
    });
    expect(result.strengthLoad?.unit).toBe('tonnage_kg');
    expect(result.strengthLoad?.score).toBe(4500);
    expect(result.strengthLoad?.confidence).toBe('high'); // tonnage + RPE/RIR
    // Internal load also present in parallel.
    expect(result.completedInternalLoad?.unit).toBe('srpe_au');
    // No external load for strength sessions.
    expect(result.completedExternalLoad).toBeUndefined();
  });

  it('strength returns undefined for non-strength sports', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: { strengthTonnageKg: 1000 },
    });
    expect(result.strengthLoad).toBeUndefined();
  });

  it('hard-set count without tonnage → lower confidence', () => {
    const result = estimateSessionLoad({
      sport: 'strength',
      completion: { durationSec: 2400, hardSetCount: 18 },
    });
    expect(result.strengthLoad?.score).toBe(18);
    expect(result.strengthLoad?.unit).toBe('hard_set_count');
    expect(result.strengthLoad?.confidence).toBe('low');
  });

  it('strength sport without tonnage or hard-set count emits quality flag', () => {
    const result = estimateSessionLoad({
      sport: 'strength',
      completion: { durationSec: 2400, sessionRpe: 7 },
    });
    expect(result.strengthLoad).toBeUndefined();
    expect(result.sourceQualityFlags).toContain('strength_completion_missing');
  });
});

describe('estimateSessionLoad — impact load only for running', () => {
  it('running with distance + duration → impact load with body-mass factor', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 70 },
    });
    expect(result.impactLoad?.unit).toBe('impact_au');
    expect(result.impactLoad?.confidence).toBe('medium');
    // 10km × 1.3 × 1.0 × 10 = 130
    expect(result.impactLoad?.score).toBe(130);
  });

  it('same distance at faster pace → higher impact load', () => {
    const slower = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 4200, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 70 },
    });
    const faster = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 2400, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 70 },
    });
    expect(faster.impactLoad!.score).toBeGreaterThan(slower.impactLoad!.score);
  });

  it('pace factor is bounded for extreme outliers', () => {
    const sprint = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 600, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 70 },
    });
    expect(sprint.impactLoad?.score).toBe(182); // 10km × 1.3 × 1.4 × 10
  });

  it('heavier athlete → higher impact load', () => {
    const light = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 60 },
    });
    const heavy = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 },
      athlete: { bodyWeightKg: 90 },
    });
    expect(heavy.impactLoad!.score).toBeGreaterThan(light.impactLoad!.score);
  });

  it('cycling → no impact load (zero-impact sport)', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      completion: { durationSec: 3600, distanceMeters: 30000 },
      athlete: { bodyWeightKg: 70 },
    });
    expect(result.impactLoad).toBeUndefined();
  });

  it('swimming → no impact load', () => {
    const result = estimateSessionLoad({
      sport: 'swimming',
      completion: { durationSec: 1800, distanceMeters: 2000 },
    });
    expect(result.impactLoad).toBeUndefined();
  });

  it('running without bodyWeight → low confidence', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 },
    });
    expect(result.impactLoad?.confidence).toBe('low');
  });
});

describe('estimateSessionLoad — planned forecast', () => {
  it('plannedTss flows into plannedExternalLoad', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 105,
    });
    expect(result.plannedExternalLoad?.source).toBe('planned');
    expect(result.plannedExternalLoad?.score).toBe(105);
    expect(result.plannedExternalLoad?.unit).toBe('tss');
    expect(result.plannedExternalLoad?.confidence).toBe('medium');
  });

  it('missing plannedTss emits quality flag', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      completion: { durationSec: 3600, sessionRpe: 6 },
    });
    expect(result.plannedExternalLoad).toBeUndefined();
    expect(result.sourceQualityFlags).toContain('planned_load_unavailable');
  });
});

describe('estimateSessionLoad — confidence rollup', () => {
  it('all-high → confidence high', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      completion: {
        durationSec: 3600,
        normalizedPowerWatts: 225,
        strengthTonnageKg: 0, // not strength sport so this dim is undefined
      },
      athlete: { cyclingFtpWatts: 250 },
    });
    // device_power is high. No other dims present (no sRPE, no impact for cycling).
    expect(result.confidence).toBe('high');
  });

  it('mixed → medium when any dim is medium', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 80, // medium
      completion: {
        durationSec: 3600,
        normalizedPowerWatts: 225, // high
      },
      athlete: { cyclingFtpWatts: 250 },
    });
    expect(result.confidence).toBe('medium');
  });

  it('any-low → confidence low', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 }, // no body weight → impact low
    });
    expect(result.confidence).toBe('low');
  });

  it('no dimensions present → confidence low', () => {
    const result = estimateSessionLoad({ sport: 'cycling' });
    expect(result.confidence).toBe('low');
  });
});

describe('pickPreferredLoadScore — preference order', () => {
  it('prefers completedExternalLoad when present', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 80,
      completion: {
        durationSec: 3600,
        normalizedPowerWatts: 225,
        sessionRpe: 7,
      },
      athlete: { cyclingFtpWatts: 250 },
    });
    const picked = pickPreferredLoadScore(result);
    expect(picked?.source).toBe('device_power');
  });

  it('falls back to completedInternalLoad when external missing', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 80,
      completion: { durationSec: 3600, sessionRpe: 7 },
    });
    const picked = pickPreferredLoadScore(result);
    expect(picked?.source).toBe('session_rpe');
  });

  it('falls back to plannedExternalLoad when nothing completed', () => {
    const result = estimateSessionLoad({
      sport: 'cycling',
      plannedTss: 80,
    });
    const picked = pickPreferredLoadScore(result);
    expect(picked?.source).toBe('planned');
  });

  it('returns undefined when no dimension present', () => {
    const result = estimateSessionLoad({ sport: 'cycling' });
    expect(pickPreferredLoadScore(result)).toBeUndefined();
  });

  it('strength path: tonnage when sport is strength + tonnage present', () => {
    const result = estimateSessionLoad({
      sport: 'strength',
      completion: { durationSec: 3000, strengthTonnageKg: 4000 },
    });
    const picked = pickPreferredLoadScore(result);
    // No external, no internal (no sRPE), no impact. Strength wins by preference order.
    expect(picked?.unit).toBe('tonnage_kg');
  });
});

describe('quality flags', () => {
  it('emits completion_data_absent when no completion provided', () => {
    const result = estimateSessionLoad({ sport: 'cycling', plannedTss: 80 });
    expect(result.sourceQualityFlags).toContain('completion_data_absent');
  });

  it('emits running_anchor_missing when running without T-pace', () => {
    const result = estimateSessionLoad({
      sport: 'running',
      completion: { durationSec: 3000, distanceMeters: 10000 },
    });
    expect(result.sourceQualityFlags).toContain('running_anchor_missing');
  });
});
