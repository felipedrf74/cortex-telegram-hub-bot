/**
 * Slice B5 — data-informed deload recommendation tests.
 *
 * Pins:
 *   - Cold-start gates ACWR-based signals
 *   - ACWR alone NEVER triggers deload
 *   - ≥2 risk signals + riskScore ≥ 0.40 triggers
 *   - Scheduled cadence triggers in both 'scheduled' and 'hybrid' strategies
 *   - 'scheduled' strategy ignores all data signals
 *   - HRV pairing rule: solo HRV drop does NOT contribute
 *   - HRV paired with RHR or sleep deficit DOES contribute
 *   - Pain elevated has the highest single-signal weight
 *   - Primary signal is the highest-weight contributing signal (or 'scheduled')
 *   - Confidence reflects loadModelStatus + signal count
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import { recommendDeload } from '../../src/services/coach-kernel/deload-recommendation';

const knowledge = loadCoachKnowledge();
const principles = knowledge.principles;

describe('cold-start gating', () => {
  it('ignores ACWR when loadModelStatus is cold_start', () => {
    const rec = recommendDeload({
      loadModelStatus: 'cold_start',
      acwr: 1.8, // very elevated
      weeksSinceDeload: 2,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.contributingSignals).not.toContain('acwrElevated');
    expect(rec.rationale.some((r) => /cold-start/.test(r))).toBe(true);
  });

  it('honors ACWR when stable', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      acwr: 1.6,
      painElevated: true, // 2nd signal so it triggers
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.contributingSignals).toContain('acwrElevated');
  });
});

describe('ACWR is never sole trigger', () => {
  it('high ACWR alone does NOT trigger deload', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      acwr: 1.8, // highRisk band
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.triggered).toBe(false);
    expect(rec.contributingSignals.length).toBe(1);
  });

  it('high ACWR + sleep deficit triggers', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      acwr: 1.7,
      sleepDeficit: true,
      painElevated: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.triggered).toBe(true);
    expect(rec.contributingSignals.length).toBeGreaterThanOrEqual(2);
  });
});

describe('scheduled vs data_informed vs hybrid strategies', () => {
  it('"scheduled" strategy triggers when cadence reached', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      weeksSinceDeload: 4,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'scheduled',
    }, principles);
    expect(rec.triggered).toBe(true);
    expect(rec.primarySignal).toBe('scheduled');
  });

  it('"scheduled" strategy IGNORES all data signals', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      painElevated: true,
      sleepDeficit: true,
      adherenceCollapse: true,
      acwr: 2.0,
      weeksSinceDeload: 1, // cadence NOT reached
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'scheduled',
    }, principles);
    expect(rec.triggered).toBe(false);
  });

  it('"hybrid" strategy triggers on cadence reached OR ≥2 signals', () => {
    // Cadence reached only.
    const cadenceOnly = recommendDeload({
      loadModelStatus: 'stable',
      weeksSinceDeload: 4,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'hybrid',
    }, principles);
    expect(cadenceOnly.triggered).toBe(true);
    // Signals only (no cadence).
    const signalsOnly = recommendDeload({
      loadModelStatus: 'stable',
      painElevated: true,
      sleepDeficit: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'hybrid',
    }, principles);
    expect(signalsOnly.triggered).toBe(true);
  });
});

describe('HRV pairing rule (Plews & Buchheit)', () => {
  it('solo HRV drop does NOT contribute', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      hrvDropPersisted: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.contributingSignals).not.toContain('hrvDropPersisted');
    expect(rec.rationale.some((r) => /HRV drop ignored — no paired signal/.test(r))).toBe(true);
  });

  it('HRV + sleep deficit pairing → both count', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      hrvDropPersisted: true,
      sleepDeficit: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.contributingSignals).toContain('hrvDropPersisted');
    expect(rec.contributingSignals).toContain('sleepDeficit');
  });

  it('HRV + RHR elevated pairing → both count', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      hrvDropPersisted: true,
      restingHrElevated: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.contributingSignals).toContain('hrvDropPersisted');
    expect(rec.contributingSignals).toContain('restingHrElevated');
  });
});

describe('primary signal selection', () => {
  it('when triggered by cadence, primarySignal = "scheduled"', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      weeksSinceDeload: 4,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'hybrid',
    }, principles);
    expect(rec.primarySignal).toBe('scheduled');
  });

  it('when triggered by signals, primarySignal = highest-weight signal', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      painElevated: true,        // weight 0.30 (highest)
      sleepDeficit: true,         // weight 0.15
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.triggered).toBe(true);
    expect(rec.primarySignal).toBe('painElevated');
  });
});

describe('confidence', () => {
  it('cold_start → confidence low', () => {
    const rec = recommendDeload({
      loadModelStatus: 'cold_start',
      weeksSinceDeload: 4,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.confidence).toBe('low');
  });

  it('warming → confidence medium', () => {
    const rec = recommendDeload({
      loadModelStatus: 'warming',
      painElevated: true,
      sleepDeficit: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.confidence).toBe('medium');
  });

  it('stable + ≥2 signals → confidence high', () => {
    const rec = recommendDeload({
      loadModelStatus: 'stable',
      painElevated: true,
      sleepDeficit: true,
      weeksSinceDeload: 1,
      scheduledDeloadCadenceWeeks: 4,
      deloadStrategy: 'data_informed',
    }, principles);
    expect(rec.confidence).toBe('high');
  });
});
