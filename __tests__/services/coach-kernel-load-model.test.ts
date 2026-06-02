/**
 * Slice B1 — multi-source load model (EWMA + cold-start).
 *
 * Pins:
 *   - CTL converges to constant load over time (EWMA stability)
 *   - ATL responds faster than CTL (shorter time constant)
 *   - TSB = CTL - ATL (positive when rested, negative when fatigued)
 *   - Cold-start (<14d) / warming (14-41d) / stable (42+d) classification
 *   - ACWR coupled vs uncoupled produce different values
 *   - ACWR uncoupled correctly excludes acute from chronic window
 *   - classifyAcwr maps values to Gabbett bands
 *   - Confidence rollup (worst-of)
 *   - Multi-dimension aggregation keeps dimensions separate
 */

import { describe, expect, it } from 'vitest';
import type { LoadConfidence } from '../../src/services/coach-kernel/load-input';
import type { DailyLoad } from '../../src/services/coach-kernel/load-model';
import {
  COLD_START_MAX_DAYS,
  DEFAULT_ATL_DAYS,
  DEFAULT_CTL_DAYS,
  classifyAcwr,
  computeLoadModelForDimension,
  computeMultiDimensionLoadModel,
} from '../../src/services/coach-kernel/load-model';

function makeDays(values: number[], confidence: LoadConfidence = 'high'): DailyLoad[] {
  return values.map((value, i) => ({
    date: `2026-${String(Math.floor(i / 31) + 1).padStart(2, '0')}-${String((i % 31) + 1).padStart(2, '0')}`,
    value,
    confidence,
  }));
}

describe('computeLoadModelForDimension — EWMA basics', () => {
  it('CTL converges toward sustained constant load', () => {
    // 300 days of TSS=80 — CTL should be very close to 80
    // (CTL has a 42-day time constant; ~7 time constants to converge
    // within 0.1% of steady state).
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(300).fill(80)),
      dimension: 'external',
    });
    expect(result.ctl).toBeGreaterThan(79);
    expect(result.ctl).toBeLessThan(81);
  });

  it('CTL approach is asymptotic — 100 days at constant 80 reaches ~72.5 (1 - exp(-100/42))', () => {
    // EWMA math: after n days at constant L, EWMA = L * (1 - exp(-n/T)).
    // For n=100, T=42: 80 * 0.906 ≈ 72.5.
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(100).fill(80)),
      dimension: 'external',
    });
    expect(result.ctl).toBeGreaterThan(70);
    expect(result.ctl).toBeLessThan(74);
  });

  it('ATL responds faster than CTL (shorter time constant)', () => {
    // 50 days at 0 then 14 days at 100 → ATL should be much higher than CTL.
    const days = [...Array(50).fill(0), ...Array(14).fill(100)];
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    expect(result.atl).toBeGreaterThan(result.ctl);
  });

  it('TSB = CTL - ATL', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(100).fill(50)),
      dimension: 'external',
    });
    expect(result.tsb).toBeCloseTo(result.ctl - result.atl, 1);
  });

  it('TSB negative when ramping load (fatigue dominates)', () => {
    // 30 days at 50, then 14 days at 120
    const days = [...Array(30).fill(50), ...Array(14).fill(120)];
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    expect(result.tsb).toBeLessThan(0);
  });

  it('TSB positive after taper (CTL preserved, ATL drops)', () => {
    // 60 days at 80, then 14 days at 30 (taper)
    const days = [...Array(60).fill(80), ...Array(14).fill(30)];
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    expect(result.tsb).toBeGreaterThan(0);
  });
});

describe('cold-start / warming / stable classification', () => {
  it('classifies <14 non-zero days as cold_start', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(10).fill(50)),
      dimension: 'external',
    });
    expect(result.completionCount).toBe(10);
    expect(result.loadModelStatus).toBe('cold_start');
  });

  it('classifies 14-41 non-zero days as warming', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(30).fill(50)),
      dimension: 'external',
    });
    expect(result.completionCount).toBe(30);
    expect(result.loadModelStatus).toBe('warming');
  });

  it('classifies 42+ non-zero days as stable', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(60).fill(50)),
      dimension: 'external',
    });
    expect(result.completionCount).toBe(60);
    expect(result.loadModelStatus).toBe('stable');
  });

  it('rest days do NOT count toward completion threshold', () => {
    // 50 days of array, half are rest days.
    const days = Array(50).fill(0).map((_, i) => i % 2 === 0 ? 50 : 0);
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    expect(result.completionCount).toBe(25);
    expect(result.loadModelStatus).toBe('warming');
  });

  it('threshold boundary at COLD_START_MAX_DAYS', () => {
    const justUnder = computeLoadModelForDimension({
      daily: makeDays(Array(COLD_START_MAX_DAYS - 1).fill(50)),
      dimension: 'external',
    });
    expect(justUnder.loadModelStatus).toBe('cold_start');
    const exactlyAt = computeLoadModelForDimension({
      daily: makeDays(Array(COLD_START_MAX_DAYS).fill(50)),
      dimension: 'external',
    });
    expect(exactlyAt.loadModelStatus).toBe('warming');
  });
});

describe('ACWR — coupled vs uncoupled', () => {
  it('coupled ACWR ≈ 1.0 when load is constant for many EWMA time-constants', () => {
    // ATL reaches steady state in ~5 × 7 = 35 days; CTL needs ~5 × 42 = 210 days.
    // We use 300 days to be safely past both.
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(300).fill(80)),
      dimension: 'external',
    });
    expect(result.acwrCoupled).toBeGreaterThan(0.95);
    expect(result.acwrCoupled).toBeLessThan(1.05);
  });

  it('coupled ACWR > 1 in the ramp phase (ATL converges faster than CTL)', () => {
    // 60 days isn't enough for CTL to catch up to ATL even with
    // constant load — ACWR will be elevated due to asymmetric time
    // constants. This is a real coaching insight, not a bug.
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(60).fill(80)),
      dimension: 'external',
    });
    expect(result.acwrCoupled).toBeGreaterThan(1.05);
    expect(result.acwrCoupled).toBeLessThan(1.5);
  });

  it('uncoupled ACWR > 1.0 after a load spike', () => {
    const days = [...Array(40).fill(40), ...Array(7).fill(120)];
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    expect(result.acwrUncoupled).toBeGreaterThan(2);
  });

  it('uncoupled chronic window EXCLUDES acute window', () => {
    // The acute window is the last 7 days. Chronic should be days
    // -42..-8 inclusive (i.e., not the recent 7).
    const constantChronic = 50;
    const spikedAcute = 200;
    const days = [...Array(35).fill(constantChronic), ...Array(7).fill(spikedAcute)];
    const result = computeLoadModelForDimension({
      daily: makeDays(days),
      dimension: 'external',
    });
    // Uncoupled ACWR = spikedAcute/constantChronic = 200/50 = 4.0
    expect(result.acwrUncoupled).toBeCloseTo(4, 1);
    // Coupled ACWR = (recent EWMA) / (overall EWMA); should be lower
    // because the chronic window in coupled form includes the spike.
    expect(result.acwrCoupled).toBeLessThan(result.acwrUncoupled);
  });

  it('returns 0 ACWR when chronic load is 0', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays(Array(60).fill(0)),
      dimension: 'external',
    });
    expect(result.acwrCoupled).toBe(0);
    expect(result.acwrUncoupled).toBe(0);
  });
});

describe('classifyAcwr — Gabbett bands', () => {
  const thresholds = {
    underTraining: { min: 0, max: 0.8 },
    lowRisk: { min: 0.8, max: 1.3 },
    moderateRisk: { min: 1.3, max: 1.5 },
    highRisk: { min: 1.5, max: 100 },
  };

  it('classifies values into the right bands', () => {
    expect(classifyAcwr(0.5, thresholds)).toBe('underTraining');
    expect(classifyAcwr(1.0, thresholds)).toBe('lowRisk');
    expect(classifyAcwr(1.2, thresholds)).toBe('lowRisk');
    expect(classifyAcwr(1.4, thresholds)).toBe('moderateRisk');
    expect(classifyAcwr(2.0, thresholds)).toBe('highRisk');
  });
});

describe('confidence rollup', () => {
  it('rolls up to worst (low) when any day is low', () => {
    const days = makeDays([50, 50, 50], 'high');
    days[1].confidence = 'low';
    const result = computeLoadModelForDimension({
      daily: days,
      dimension: 'external',
    });
    expect(result.confidence).toBe('low');
  });

  it('rolls up to high when all days are high', () => {
    const result = computeLoadModelForDimension({
      daily: makeDays([50, 60, 70], 'high'),
      dimension: 'external',
    });
    expect(result.confidence).toBe('high');
  });

  it('rolls up to medium when mix of high+medium (no low)', () => {
    const days = makeDays([50, 60, 70], 'high');
    days[1].confidence = 'medium';
    const result = computeLoadModelForDimension({
      daily: days,
      dimension: 'external',
    });
    expect(result.confidence).toBe('medium');
  });
});

describe('multi-dimension aggregation', () => {
  it('keeps load dimensions separate (never folded)', () => {
    const inputs = new Map<'external' | 'internal' | 'strength' | 'impact', DailyLoad[]>([
      ['external', makeDays(Array(50).fill(80))],
      ['internal', makeDays(Array(50).fill(40))],
      ['strength', makeDays(Array(50).fill(4000))], // tonnage_kg scale
      ['impact', makeDays(Array(50).fill(120))],
    ]);
    const results = computeMultiDimensionLoadModel(inputs);
    expect(results.size).toBe(4);
    // 50 days of constant load reaches ~70% of steady-state by EWMA math.
    expect(results.get('external')?.ctl).toBeGreaterThan(35);
    expect(results.get('external')?.ctl).toBeLessThan(80);
    expect(results.get('strength')?.ctl).toBeGreaterThan(1750);
    expect(results.get('strength')?.ctl).toBeLessThan(4000);
    // Different scales → CTL values are NOT equal (separation invariant).
    expect(results.get('strength')!.ctl).not.toBeCloseTo(results.get('external')!.ctl, 0);
    expect(results.get('internal')!.ctl).not.toBeCloseTo(results.get('external')!.ctl, 0);
  });
});

describe('default time constants', () => {
  it('DEFAULT_CTL_DAYS = 42 (Coggan)', () => {
    expect(DEFAULT_CTL_DAYS).toBe(42);
  });

  it('DEFAULT_ATL_DAYS = 7 (Coggan)', () => {
    expect(DEFAULT_ATL_DAYS).toBe(7);
  });
});
