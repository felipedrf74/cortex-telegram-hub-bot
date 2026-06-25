import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
  incrementTrainingGenerationCounter,
  recordTrainingProgressionState,
} from '../../src/services/training-generation-observability';

describe('training-generation-observability', () => {
  beforeEach(() => {
    _resetTrainingGenerationObservabilityForTests();
  });

  it('tracks required generation counters without user data', () => {
    incrementTrainingGenerationCounter('equipment_default_conservative_total');
    incrementTrainingGenerationCounter('selector_no_candidate_total', 2);
    incrementTrainingGenerationCounter('final_validation_failure_total');
    incrementTrainingGenerationCounter('fallback_template_blocked_total');

    const snapshot = getTrainingGenerationObservabilitySnapshot();

    expect(snapshot.counters.equipment_default_conservative_total).toBe(1);
    expect(snapshot.counters.selector_no_candidate_total).toBe(2);
    expect(snapshot.counters.final_validation_failure_total).toBe(1);
    expect(snapshot.counters.fallback_template_blocked_total).toBe(1);
  });

  it('tracks progression states and ignores unknown values', () => {
    recordTrainingProgressionState('hold');
    recordTrainingProgressionState('build');
    recordTrainingProgressionState('future_state');

    const snapshot = getTrainingGenerationObservabilitySnapshot();

    expect(snapshot.progression_state_counts.hold).toBe(1);
    expect(snapshot.progression_state_counts.build).toBe(1);
    expect(snapshot.progression_state_counts.deload).toBe(0);
  });
});
