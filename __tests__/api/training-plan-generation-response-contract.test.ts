import { describe, expect, it } from 'vitest';
import {
  TRAINING_PLAN_GENERATION_RESPONSE_SCHEMA_VERSION,
  buildTrainingPlanGenerationResponseDiscriminator,
  resolveTrainingPlanGenerationHttpContract,
  type TrainingPlanGenerationOutcome,
} from '../../src/api/routes/training-plan-generation-response-contract';

const OUTCOMES = [
  'needs_profile',
  'preview',
  'created',
  'needs_clarification',
  'plan_quality_blocked',
  'cancellation_failed',
] as const satisfies readonly TrainingPlanGenerationOutcome[];

describe('training plan generation public response contract', () => {
  it('adds one versioned discriminator for every public generation result variant', () => {
    expect(OUTCOMES.map((outcome) => buildTrainingPlanGenerationResponseDiscriminator(outcome))).toEqual(
      OUTCOMES.map((status) => ({
        schemaVersion: TRAINING_PLAN_GENERATION_RESPONSE_SCHEMA_VERSION,
        status,
      })),
    );
  });

  it.each([
    ['preview', 'needs_profile', undefined, 200, 'success', undefined],
    ['preview', 'needs_clarification', undefined, 200, 'success', undefined],
    ['preview', 'preview', undefined, 200, 'success', undefined],
    ['preview', 'created', undefined, 409, 'error', 'INVALID_PLAN_PREVIEW_STATE'],
    ['preview', 'plan_quality_blocked', undefined, 422, 'error', 'TRAINING_PLAN_QUALITY_BLOCKED'],
    ['preview', 'cancellation_failed', undefined, 409, 'error', 'CANCELLATION_FAILED'],
    ['generate', 'needs_profile', undefined, 200, 'success', undefined],
    ['generate', 'needs_clarification', undefined, 200, 'success', undefined],
    ['generate', 'preview', undefined, 409, 'error', 'INVALID_PLAN_GENERATION_STATE'],
    ['generate', 'created', undefined, 201, 'success', undefined],
    ['generate', 'plan_quality_blocked', undefined, 422, 'error', 'TRAINING_PLAN_QUALITY_BLOCKED'],
    ['generate', 'cancellation_failed', undefined, 409, 'error', 'CANCELLATION_FAILED'],
    ['preview', 'needs_profile', 'RACE_DATE_BEFORE_PLAN_START', 422, 'error', 'RACE_DATE_BEFORE_PLAN_START'],
    ['generate', 'needs_profile', 'PAST_RACE_DATE', 422, 'error', 'PAST_RACE_DATE'],
  ] as const)(
    '%s maps %s (%s) to HTTP %i %s',
    (surface, outcome, validationErrorCode, status, envelope, errorCode) => {
      expect(resolveTrainingPlanGenerationHttpContract({
        surface,
        outcome,
        validationErrorCode,
      })).toEqual({ status, envelope, ...(errorCode ? { errorCode } : {}) });
    },
  );

  it('keeps the status matrix exhaustive on both public routes', () => {
    for (const surface of ['preview', 'generate'] as const) {
      const mapped = OUTCOMES.map((outcome) => resolveTrainingPlanGenerationHttpContract({ surface, outcome }));
      expect(mapped).toHaveLength(OUTCOMES.length);
      expect(mapped.every(({ status }) => status !== 500)).toBe(true);
    }
  });
});
