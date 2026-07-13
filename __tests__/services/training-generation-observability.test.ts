import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
  incrementTrainingGenerationCounter,
  recordTrainingM4CandidateOutcome,
  recordTrainingM4ReviewFeedback,
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

  it('tracks M4 outcomes only by closed mode and discipline taxonomy', () => {
    recordTrainingM4CandidateOutcome('event_based', 'marathon', 'VALID');
    recordTrainingM4CandidateOutcome('continuous', 'hybrid', 'INVALID');
    recordTrainingM4CandidateOutcome('private-event-name', 'private-profile-note', 'INVALID');
    const snapshot = getTrainingGenerationObservabilitySnapshot();
    expect(snapshot.counters.m4_candidate_valid_total).toBe(1);
    expect(snapshot.counters.m4_candidate_invalid_total).toBe(2);
    expect(snapshot.m4_candidate_outcomes).toEqual({
      'event_based:marathon:VALID': 1,
      'continuous:hybrid:INVALID': 1,
      'unknown:unknown:INVALID': 1,
    });
    expect(snapshot.counters.m4_event_phase_review_total).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|user|event name|profile/i);
  });

  it('accepts only closed review-feedback outcomes', () => {
    recordTrainingM4ReviewFeedback('CONFIRMED');
    recordTrainingM4ReviewFeedback('FALSE_POSITIVE');
    expect(getTrainingGenerationObservabilitySnapshot().counters.m4_false_positive_review_feedback_total).toBe(1);
  });
});
