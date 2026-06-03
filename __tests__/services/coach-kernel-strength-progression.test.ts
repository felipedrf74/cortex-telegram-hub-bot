/**
 * Slice B6 — strength progression gating tests.
 *
 * Pins:
 *   - All target reps hit + RPE OK + no gates → load_progression +2.5%
 *   - volume_then_load adds 1 rep
 *   - intent_then_load adds 1s eccentric tempo
 *   - Reps missed → consistency
 *   - RPE ≥ 8 → consistency
 *   - Pain in same region → consistency
 *   - High soreness ≥7 → consistency
 *   - Technical failure <6 → consistency
 *   - Novelty <2 exposures → consistency
 *   - Same pattern <48h → consistency
 *   - Key endurance <6h ahead → consistency (interference)
 *   - Equipment unavailable → consistency
 *   - Unknown progressionTarget defaults to load_progression
 */

import { describe, expect, it } from 'vitest';
import { decideStrengthProgression } from '../../src/services/coach-kernel/strength-progression';

describe('progression vectors', () => {
  it('clean state + load_progression target → +2.5%', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
      priorSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('load_progression');
    expect(d.loadDeltaPct).toBe(0.025);
    expect(d.gatesFired).toHaveLength(0);
  });

  it('volume_then_load target → +1 rep', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'volume_then_load',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 6 },
    });
    expect(d.vector).toBe('volume_then_load');
    expect(d.repsDelta).toBe(1);
  });

  it('intent_then_load target → +1s eccentric', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'intent_then_load',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('intent_then_load');
    expect(d.tempoEccentricSec).toBe(1);
  });

  it('unknown target defaults to load_progression', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'mystery_vector',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
      priorSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('load_progression');
  });
});

describe('gating signals', () => {
  it('reps missed → consistency_preservation', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 5, prescribedRepsTopSet: 8, rpeTopSet: 8 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('reps_missed');
  });

  it('RPE ≥ 8 → consistency_preservation', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 8 },
      priorSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('rpe_too_high');
  });

  it('missing prior confirmation blocks direct load progression', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('two_session_confirmation_missing');
  });

  it('prior session must also clear reps and RPE < 8', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
      priorSession: { completedRepsTopSet: 7, prescribedRepsTopSet: 8, rpeTopSet: 8 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('prior_reps_missed');
    expect(d.gatesFired).toContain('prior_rpe_not_clear');
  });

  it('pain in same region → consistency_preservation', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      painSameRegionLast7d: true,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('pain_same_region');
  });

  it('high soreness ≥7 → consistency', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7, sorenessLevel: 8 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('soreness_high');
  });

  it('technical failure <6 → consistency', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7, technicalSuccessScore: 4 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('technical_failure');
  });

  it('novelty <2 exposures → consistency (grooving phase)', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 1,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('novelty_grooving');
  });

  it('same pattern <48h → consistency', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      hoursSinceSamePattern: 36,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('pattern_recency');
  });

  it('key endurance <6h away → consistency (interference)', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      hoursUntilNextKeyEndurance: 4,
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('interference_window');
  });

  it('equipment unavailable → consistency', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 5,
      equipmentBucket: 'full_gym',
      availableEquipment: ['bodyweight_only'],
      lastSession: { completedRepsTopSet: 8, prescribedRepsTopSet: 8, rpeTopSet: 7 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired).toContain('equipment_unavailable');
  });

  it('multiple gates compose into single consistency decision', () => {
    const d = decideStrengthProgression({
      progressionTarget: 'load_progression',
      priorExposureCount: 1,
      painSameRegionLast7d: true,
      lastSession: { completedRepsTopSet: 5, prescribedRepsTopSet: 8, rpeTopSet: 9 },
    });
    expect(d.vector).toBe('consistency_preservation');
    expect(d.gatesFired.length).toBeGreaterThanOrEqual(3);
  });
});
