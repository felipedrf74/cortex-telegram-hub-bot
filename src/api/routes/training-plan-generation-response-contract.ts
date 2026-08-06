// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const TRAINING_PLAN_GENERATION_RESPONSE_SCHEMA_VERSION =
  'training_plan_generation_response.v1' as const;

export type TrainingPlanGenerationOutcome =
  | 'needs_profile'
  | 'preview'
  | 'created'
  | 'needs_clarification'
  | 'plan_quality_blocked'
  | 'cancellation_failed';

export type TrainingPlanGenerationResponseDiscriminator<
  Outcome extends TrainingPlanGenerationOutcome = TrainingPlanGenerationOutcome,
> = {
  schemaVersion: typeof TRAINING_PLAN_GENERATION_RESPONSE_SCHEMA_VERSION;
  status: Outcome;
};

export type TrainingPlanGenerationRouteSurface = 'preview' | 'generate';

export type TrainingPlanGenerationHttpContract =
  | { status: 200 | 201; envelope: 'success' }
  | { status: 409 | 422; envelope: 'error'; errorCode: string };

export function buildTrainingPlanGenerationResponseDiscriminator<
  Outcome extends TrainingPlanGenerationOutcome,
>(outcome: Outcome): TrainingPlanGenerationResponseDiscriminator<Outcome> {
  return {
    schemaVersion: TRAINING_PLAN_GENERATION_RESPONSE_SCHEMA_VERSION,
    status: outcome,
  };
}

/**
 * Canonical F27 HTTP policy. The route passes a validation code only when a
 * `needs_profile` result is actually a semantic request rejection; ordinary
 * questionnaire/profile handoffs remain successful 200 responses.
 */
export function resolveTrainingPlanGenerationHttpContract(input: {
  surface: TrainingPlanGenerationRouteSurface;
  outcome: TrainingPlanGenerationOutcome;
  validationErrorCode?: string;
}): TrainingPlanGenerationHttpContract {
  if (input.outcome === 'needs_profile' && input.validationErrorCode) {
    return {
      status: 422,
      envelope: 'error',
      errorCode: input.validationErrorCode,
    };
  }

  switch (input.outcome) {
    case 'needs_profile':
    case 'needs_clarification':
      return { status: 200, envelope: 'success' };
    case 'preview':
      return input.surface === 'preview'
        ? { status: 200, envelope: 'success' }
        : { status: 409, envelope: 'error', errorCode: 'INVALID_PLAN_GENERATION_STATE' };
    case 'created':
      return input.surface === 'generate'
        ? { status: 201, envelope: 'success' }
        : { status: 409, envelope: 'error', errorCode: 'INVALID_PLAN_PREVIEW_STATE' };
    case 'plan_quality_blocked':
      return { status: 422, envelope: 'error', errorCode: 'TRAINING_PLAN_QUALITY_BLOCKED' };
    case 'cancellation_failed':
      return { status: 409, envelope: 'error', errorCode: 'CANCELLATION_FAILED' };
  }
}
