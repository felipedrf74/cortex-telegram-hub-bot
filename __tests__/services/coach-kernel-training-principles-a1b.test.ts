/**
 * Slice A1b — periodization policy accessors.
 *
 * Pins:
 *   - sciencePolicyVersion is read from JSON
 *   - Content hash excludes the version field itself
 *   - WeekIntent defaults, block templates, intensity distribution
 *     models, taper coefficients, ACWR thresholds, risk weights,
 *     deload cadence, return-from-gap ramps, missed-session policy
 *     defaults, minimum-viable-week templates all parse correctly
 *   - Defaults fall through when missing
 *   - pickDefaultIntensityDistribution priority order works
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import {
  computeSciencePolicyContentHash,
  getAcwrThresholds,
  getBlockTemplate,
  getIntensityDistribution,
  getMesocycleLength,
  getMinimumViableWeekTemplate,
  getMissedSessionPolicy,
  getReturnFromGapRamp,
  getRiskScoreWeights,
  getSciencePolicyVersion,
  getScheduledDeloadCadence,
  getTaperCoefficients,
  getWeekIntentDefaults,
  pickDefaultIntensityDistribution,
} from '../../src/services/coach-kernel/training-principles';

describe('A1b — sciencePolicyVersion + content hash', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('reads the sciencePolicyVersion from JSON', () => {
    expect(getSciencePolicyVersion(principles)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns fallback "0.0.0" when missing', () => {
    expect(getSciencePolicyVersion({})).toBe('0.0.0');
  });

  it('content hash excludes sciencePolicyVersion field', () => {
    const a = computeSciencePolicyContentHash({ ...principles, sciencePolicyVersion: '1.0.0' });
    const b = computeSciencePolicyContentHash({ ...principles, sciencePolicyVersion: '99.9.9' });
    expect(a).toBe(b);
  });

  it('content hash is stable across key reorderings', () => {
    const a = computeSciencePolicyContentHash({ foo: 1, bar: 2 });
    const b = computeSciencePolicyContentHash({ bar: 2, foo: 1 });
    expect(a).toBe(b);
  });

  it('content hash CHANGES when content changes', () => {
    const a = computeSciencePolicyContentHash(principles);
    const b = computeSciencePolicyContentHash({
      ...principles,
      mesocycleLengths: { default: 99 },
    });
    expect(a).not.toBe(b);
  });
});

describe('A1b — mesocycle + block templates', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('getMesocycleLength returns per-level defaults', () => {
    expect(getMesocycleLength(principles, 'novice')).toBe(5);
    expect(getMesocycleLength(principles, 'intermediate')).toBe(4);
    expect(getMesocycleLength(principles, 'advanced')).toBe(3);
  });

  it('getMesocycleLength falls back to 4 on empty principles', () => {
    expect(getMesocycleLength({}, 'intermediate')).toBe(4);
  });

  it('getBlockTemplate returns WeekIntent[] for known names', () => {
    const standard = getBlockTemplate(principles, 'accumulation_4wk');
    expect(standard).toEqual(['accumulation', 'accumulation', 'accumulation', 'deload']);
    const advanced = getBlockTemplate(principles, 'accumulation_3wk_advanced');
    expect(advanced).toEqual(['accumulation', 'accumulation', 'deload']);
    const novice = getBlockTemplate(principles, 'accumulation_5wk_novice');
    expect(novice?.length).toBe(5);
  });

  it('getBlockTemplate returns undefined for unknown names', () => {
    expect(getBlockTemplate(principles, 'nonsense_block')).toBeUndefined();
  });
});

describe('A1b — WeekIntent defaults', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('reads accumulation defaults', () => {
    const acc = getWeekIntentDefaults(principles, 'accumulation');
    expect(acc?.volumeMultiplier).toBe(1.0);
    expect(acc?.primaryQuality).toBe('volume');
  });

  it('reads deload defaults (lower volume multiplier)', () => {
    const dl = getWeekIntentDefaults(principles, 'deload');
    expect(dl?.volumeMultiplier).toBeLessThan(1);
    expect(dl?.sorenessSensitive).toBe(true);
  });

  it('reads taper defaults', () => {
    const t = getWeekIntentDefaults(principles, 'taper');
    expect(t?.primaryQuality).toBe('sharpness');
    expect(t?.volumeMultiplier).toBeLessThan(0.6);
  });

  it('reads post_race_recovery defaults', () => {
    const pr = getWeekIntentDefaults(principles, 'post_race_recovery');
    expect(pr?.primaryQuality).toBe('recovery');
  });

  it('returns undefined for unknown intent', () => {
    // @ts-expect-error testing defensive behavior
    expect(getWeekIntentDefaults(principles, 'bogus')).toBeUndefined();
  });
});

describe('A1b — intensity distribution', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('polarized = 80/5/15 (Seiler)', () => {
    const p = getIntensityDistribution(principles, 'polarized');
    expect(p?.low).toBe(0.80);
    expect(p?.moderate).toBe(0.05);
    expect(p?.high).toBe(0.15);
  });

  it('pyramidal = 75/20/5', () => {
    const p = getIntensityDistribution(principles, 'pyramidal');
    expect(p?.low).toBe(0.75);
    expect(p?.moderate).toBe(0.20);
    expect(p?.high).toBe(0.05);
  });

  it('thresholdFocused = 65/25/10', () => {
    const p = getIntensityDistribution(principles, 'thresholdFocused');
    expect(p?.low).toBe(0.65);
    expect(p?.high).toBe(0.10);
  });

  it('pickDefaultIntensityDistribution prefers sport over level', () => {
    // running → polarized (sport override); even if level is 'novice'.
    expect(pickDefaultIntensityDistribution(principles, 'running', 'novice')).toBe('polarized');
  });

  it('falls back to level when sport missing', () => {
    expect(pickDefaultIntensityDistribution(principles, 'unknown_sport', 'novice')).toBe('pyramidal');
    expect(pickDefaultIntensityDistribution(principles, 'unknown_sport', 'advanced')).toBe('polarized');
  });

  it('falls back to polarized when both missing', () => {
    expect(pickDefaultIntensityDistribution({}, 'running', 'novice')).toBe('polarized');
  });
});

describe('A1b — taper coefficients', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('A priority has the longest taper window', () => {
    const a = getTaperCoefficients(principles, 'A');
    const b = getTaperCoefficients(principles, 'B');
    const c = getTaperCoefficients(principles, 'C');
    expect(a!.durationDays).toBeGreaterThan(b!.durationDays);
    expect(b!.durationDays).toBeGreaterThan(c!.durationDays);
  });

  it('volume drop is in the 41-60% Bosquet 2007 range for A', () => {
    const a = getTaperCoefficients(principles, 'A');
    expect(a!.volumeDropPct).toBeGreaterThanOrEqual(41);
    expect(a!.volumeDropPct).toBeLessThanOrEqual(60);
  });

  it('intensity is preserved at 100% during taper', () => {
    const a = getTaperCoefficients(principles, 'A');
    expect(a!.intensityPreservedPct).toBe(100);
  });
});

describe('A1b — ACWR thresholds + risk weights', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('lowRisk band is 0.8-1.3 (Gabbett)', () => {
    const t = getAcwrThresholds(principles);
    expect(t?.lowRisk).toEqual({ min: 0.8, max: 1.3 });
  });

  it('highRisk band starts at 1.5', () => {
    const t = getAcwrThresholds(principles);
    expect(t?.highRisk.min).toBe(1.5);
  });

  it('risk score weights include all 7 signals', () => {
    const w = getRiskScoreWeights(principles);
    expect(w?.painElevated).toBeGreaterThan(0);
    expect(w?.acwrElevated).toBeGreaterThan(0);
    expect(w?.hrvDropPersisted).toBeGreaterThan(0);
  });

  it('painElevated has the highest weight (safety priority)', () => {
    const w = getRiskScoreWeights(principles)!;
    const others = [w.acwrElevated, w.hrvDropPersisted, w.sleepDeficit, w.adherenceCollapse, w.rapidLoadRamp, w.recentGapOrIllness];
    for (const o of others) expect(w.painElevated).toBeGreaterThanOrEqual(o);
  });
});

describe('A1b — deload cadence + return-from-gap protocols', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('scheduled cadence varies by level (novice longer, advanced shorter)', () => {
    expect(getScheduledDeloadCadence(principles, 'novice')).toBeGreaterThanOrEqual(
      getScheduledDeloadCadence(principles, 'advanced'),
    );
  });

  it('all 6 ReturnProtocol classes present', () => {
    const protocols = [
      'vacation_or_life_gap',
      'minor_illness_resolved',
      'febrile_or_systemic_illness',
      'injury_localized',
      'post_exertional_symptom_risk',
      'unknown_conservative',
    ] as const;
    for (const p of protocols) {
      const ramp = getReturnFromGapRamp(principles, p);
      expect(ramp).toBeDefined();
      expect(ramp!.weekOnePct).toBeGreaterThan(0);
      expect(ramp!.weeklyIncreasePct).toBeGreaterThan(0);
    }
  });

  it('febrile illness has slower ramp than vacation', () => {
    const vacation = getReturnFromGapRamp(principles, 'vacation_or_life_gap')!;
    const febrile = getReturnFromGapRamp(principles, 'febrile_or_systemic_illness')!;
    expect(vacation.weekOnePct).toBeGreaterThan(febrile.weekOnePct);
    expect(vacation.weeklyIncreasePct).toBeGreaterThan(febrile.weeklyIncreasePct);
  });

  it('post-exertional has the slowest ramp', () => {
    const postExert = getReturnFromGapRamp(principles, 'post_exertional_symptom_risk')!;
    const febrile = getReturnFromGapRamp(principles, 'febrile_or_systemic_illness')!;
    expect(postExert.weekOnePct).toBeLessThan(febrile.weekOnePct);
  });
});

describe('A1b — missed-session policies + minimum viable week', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('taper sessions are NEVER crammed (drop_never_cram)', () => {
    expect(getMissedSessionPolicy(principles, 'taper_session')).toBe('drop_never_cram');
  });

  it('easy aerobic sessions usually drop', () => {
    expect(getMissedSessionPolicy(principles, 'easy_aerobic')).toBe('drop');
  });

  it('key interval sessions reschedule with recovery window', () => {
    expect(getMissedSessionPolicy(principles, 'key_interval_tempo')).toBe('reschedule_if_recovery_window');
  });

  it('minimum viable week for endurance athlete has 3 sessions', () => {
    const mvw = getMinimumViableWeekTemplate(principles, 'endurance_athlete');
    expect(mvw?.length).toBeGreaterThanOrEqual(3);
  });

  it('strength athlete MVW prioritizes key lift', () => {
    const mvw = getMinimumViableWeekTemplate(principles, 'strength_athlete');
    expect(mvw?.[0].role).toMatch(/key|lift/);
  });
});
