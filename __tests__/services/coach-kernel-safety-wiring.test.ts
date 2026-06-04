/**
 * Slice A4 — safety wiring tests.
 *
 * Pins:
 *   - Typed structured intake + hard-pause trigger → effectiveSeverity 'block'
 *   - Inferred/free-text input → effectiveSeverity 'warning' only
 *   - HealthSignal pain consent → pain maps to acuteSessionPain
 *   - HealthSignal fever symptom → feverPresent route
 *   - HealthSignal RED-S high risk → energy availability path
 *   - HealthSignal without consent → fields stripped (no leakage)
 *   - User-facing copy uses seek_professional_support phrasing
 *   - Internal code remains medical_referral
 *   - Empty HealthSignal → pass status, no decision reasons
 */

import { describe, expect, it } from 'vitest';
import type { HealthSignal } from '../../src/services/coach-kernel/types';
import {
  SEEK_PROFESSIONAL_SUPPORT_COPY,
  deriveSafetyTriggerFromSignal,
  mapHealthSignalToSafetyInput,
  wireHealthSignalToSafety,
} from '../../src/services/coach-kernel/safety-wiring';

function makeSignal(overrides: Partial<HealthSignal> = {}): HealthSignal {
  return {
    capturedAt: '2026-05-23T08:00:00Z',
    consentScope: ['pain', 'illness', 'red_s_screening', 'injury'],
    ...overrides,
  };
}

describe('mapHealthSignalToSafetyInput — consent gating', () => {
  it('maps pain score + location when pain consent present', () => {
    const signal = makeSignal({ painScore: 8, painLocation: 'left knee' });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.acuteSessionPain?.bodyArea).toBe('left knee');
    expect(input.acuteSessionPain?.severity).toBe('high');
  });

  it('does NOT map pain when consent missing', () => {
    const signal = makeSignal({
      painScore: 8,
      painLocation: 'left knee',
      consentScope: ['illness'], // pain not consented
    });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.acuteSessionPain).toBeUndefined();
  });

  it('classifies pain severity by score', () => {
    expect(mapHealthSignalToSafetyInput(makeSignal({ painScore: 8, painLocation: 'a' }))
      .acuteSessionPain?.severity).toBe('high');
    expect(mapHealthSignalToSafetyInput(makeSignal({ painScore: 5, painLocation: 'a' }))
      .acuteSessionPain?.severity).toBe('moderate');
    expect(mapHealthSignalToSafetyInput(makeSignal({ painScore: 2, painLocation: 'a' }))
      .acuteSessionPain?.severity).toBe('low');
  });

  it('maps fever symptoms to feverPresent flag', () => {
    const signal = makeSignal({ illnessSymptoms: ['fever', 'fatigue'] });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.selfReportedFlags?.feverPresent).toBe(true);
  });

  it('maps non-fever illness symptoms to fatigue pattern', () => {
    const signal = makeSignal({ illnessSymptoms: ['cough', 'congestion', 'sore_throat'] });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.selfReportedFlags?.feverPresent).toBeUndefined();
    expect(input.fatiguePattern?.consecutiveLowEnergyDays).toBeGreaterThan(0);
  });

  it('maps RED-S high risk to energyAvailabilityRisk', () => {
    const signal = makeSignal({ energyAvailabilityRisk: 'high' });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.selfReportedFlags?.energyAvailabilityRisk).toBe('high');
  });

  it('does NOT map RED-S when consent missing', () => {
    const signal = makeSignal({
      energyAvailabilityRisk: 'high',
      consentScope: ['pain'],
    });
    const input = mapHealthSignalToSafetyInput(signal);
    expect(input.selfReportedFlags?.energyAvailabilityRisk).toBeUndefined();
  });
});

describe('wireHealthSignalToSafety — typed hard-pause vs inferred warning', () => {
  it('derives severe structured pain with a location as a hard-pause trigger', () => {
    const signal = makeSignal({
      source: 'structured_intake',
      painScore: 9,
      painLocation: 'left knee',
    });
    const trigger = deriveSafetyTriggerFromSignal(signal);
    expect(trigger).toEqual({
      source: 'structured_intake',
      triggerType: 'worsening_localized_pain',
    });

    const out = wireHealthSignalToSafety({ signal, ...trigger });
    expect(out.effectiveSeverity).toBe('block');
  });

  it('derives severe structured chest location as chest_pain', () => {
    const signal = makeSignal({
      source: 'structured_intake',
      painScore: 9,
      painLocation: 'chest tightness',
    });
    expect(deriveSafetyTriggerFromSignal(signal)).toEqual({
      source: 'structured_intake',
      triggerType: 'chest_pain',
    });
  });

  it('lets chest-pain copy win when acute injury is co-reported', () => {
    const signal = makeSignal({
      source: 'structured_intake',
      injuryStatus: 'acute',
      painScore: 9,
      painLocation: 'chest tightness',
    });

    expect(deriveSafetyTriggerFromSignal(signal)).toEqual({
      source: 'structured_intake',
      triggerType: 'chest_pain',
    });
  });

  it('keeps acute-injury copy for acute non-chest high pain', () => {
    const signal = makeSignal({
      source: 'structured_intake',
      injuryStatus: 'acute',
      painScore: 9,
      painLocation: 'ankle',
    });

    expect(deriveSafetyTriggerFromSignal(signal)).toEqual({
      source: 'structured_intake',
      triggerType: 'acute_injury',
    });
  });

  it('keeps non-acute non-chest high pain on worsening-localized-pain copy', () => {
    const signal = makeSignal({
      source: 'structured_intake',
      injuryStatus: 'returning',
      painScore: 9,
      painLocation: 'ankle',
    });

    expect(deriveSafetyTriggerFromSignal(signal)).toEqual({
      source: 'structured_intake',
      triggerType: 'worsening_localized_pain',
    });
  });

  it('structured block findings hard-pause even when trigger derivation was omitted', () => {
    const signal = makeSignal({
      painScore: 9,
      painLocation: 'left knee',
    });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
    });
    expect(out.effectiveSeverity).toBe('block');
  });

  it('typed chest_pain via structured intake → BLOCK effective severity', () => {
    const signal = makeSignal({
      painScore: 9,
      painLocation: 'chest',
    });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'chest_pain',
    });
    expect(out.effectiveSeverity).toBe('block');
    const medicalReason = out.decisionReasons.find((r) => r.code === 'medical_referral');
    expect(medicalReason).toBeDefined();
    expect(medicalReason!.severity).toBe('block');
    expect(medicalReason!.text).toBe(SEEK_PROFESSIONAL_SUPPORT_COPY);
  });

  it('same finding via free-text → WARNING only (not block)', () => {
    const signal = makeSignal({
      painScore: 9,
      painLocation: 'chest',
    });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'inferred_text',
    });
    expect(out.effectiveSeverity).toBe('warning');
  });

  it('non-hard-pause trigger via structured intake still warning-only', () => {
    const signal = makeSignal({
      painScore: 4,
      painLocation: 'lower back',
    });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'general_soreness', // NOT in HARD_PAUSE_TYPED_TRIGGERS
    });
    expect(out.effectiveSeverity).toBe('warning');
  });

  it('fever (typed) → block via structured intake', () => {
    const signal = makeSignal({ illnessSymptoms: ['fever'] });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'fever_or_systemic_illness',
    });
    expect(out.effectiveSeverity).toBe('block');
  });

  it('high RED-S risk via structured intake → block', () => {
    const signal = makeSignal({ energyAvailabilityRisk: 'high' });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'red_s_high_risk',
    });
    expect(out.effectiveSeverity).toBe('block');
  });

  it('moderate RED-S → warning only (not block)', () => {
    const signal = makeSignal({ energyAvailabilityRisk: 'moderate' });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
    });
    expect(out.effectiveSeverity).toBe('warning');
  });

  it('empty signal (no risk factors) → pass status, no decision reasons', () => {
    const signal = makeSignal();
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
    });
    expect(out.effectiveSeverity).toBe('pass');
    expect(out.decisionReasons.length).toBe(0);
  });
});

describe('decision-reason emission shape', () => {
  it('every emitted reason has source=safety constraint', () => {
    const signal = makeSignal({ painScore: 8, painLocation: 'knee' });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'worsening_localized_pain',
    });
    for (const r of out.decisionReasons) {
      expect(r.sourceConstraint?.type).toBe('safety');
    }
  });

  it('evidence array carries source + trigger metadata', () => {
    const signal = makeSignal({ painScore: 8, painLocation: 'knee' });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'worsening_localized_pain',
      affectedDate: '2026-05-23',
    });
    const r = out.decisionReasons[0];
    expect(r.evidence?.some((e) => e.includes('source=structured_intake'))).toBe(true);
    expect(r.evidence?.some((e) => e.includes('trigger=worsening_localized_pain'))).toBe(true);
  });

  it('block-severity reason uses seek_professional_support copy', () => {
    const signal = makeSignal({ painScore: 9, painLocation: 'chest' });
    const out = wireHealthSignalToSafety({
      signal,
      source: 'structured_intake',
      triggerType: 'chest_pain',
    });
    const blockReason = out.decisionReasons.find((r) => r.severity === 'block');
    expect(blockReason?.text).toBe(SEEK_PROFESSIONAL_SUPPORT_COPY);
    // Internal code constant preserved (for ledger queries).
    expect(blockReason?.code).toBe('medical_referral');
  });
});
