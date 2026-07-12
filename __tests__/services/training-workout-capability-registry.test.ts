// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_TRAINING_SESSION_TYPES,
  TRAINING_PLAN_MODE_CAPABILITIES,
  TRAINING_WORKOUT_CAPABILITY_REGISTRY,
  resolveTrainingWorkoutCapability,
} from '../../src/services/training-workout-capability-registry';

describe('training-workout-capability-registry', () => {
  it('enumerates every canonical SessionType exactly once', () => {
    expect(CANONICAL_TRAINING_SESSION_TYPES).toHaveLength(21);
    expect(new Set(CANONICAL_TRAINING_SESSION_TYPES)).toHaveLength(21);
    expect(TRAINING_WORKOUT_CAPABILITY_REGISTRY.map((entry) => entry.sessionType)).toEqual(
      CANONICAL_TRAINING_SESSION_TYPES,
    );
  });

  it('limits Milestone 1 generation to the approved four session types', () => {
    expect(
      TRAINING_WORKOUT_CAPABILITY_REGISTRY
        .filter((entry) => entry.milestone1GenerationEnabled)
        .map((entry) => entry.sessionType),
    ).toEqual([
      'strength_hypertrophy',
      'strength_maintenance',
      'mobility',
      'rest',
    ]);
  });

  it('keeps all plan modes visible while enabling only continuous in Milestone 1', () => {
    expect(TRAINING_PLAN_MODE_CAPABILITIES.map((entry) => entry.planMode)).toEqual([
      'event_based',
      'continuous',
      'maintenance',
      'return_to_training',
    ]);
    expect(
      TRAINING_PLAN_MODE_CAPABILITIES.filter((entry) => entry.milestone1GenerationEnabled),
    ).toEqual([
      expect.objectContaining({ planMode: 'continuous' }),
    ]);
  });

  it('returns an honest unknown fallback without strength or planned labels', () => {
    expect(resolveTrainingWorkoutCapability('future_modal_xyz')).toEqual({
      sessionType: 'future_modal_xyz',
      canonical: false,
      presentationFamily: 'unknown',
      presentationLabel: 'Unknown workout type',
      milestone1GenerationEnabled: false,
    });
  });
});
