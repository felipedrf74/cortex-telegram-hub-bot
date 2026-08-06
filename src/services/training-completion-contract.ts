// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type TrainingCompletionState = 'completed' | 'partial' | 'skipped';

export class TrainingCompletionContractError extends Error {
  constructor(
    readonly code: 'TRAINING_COMPLETION_STATE_CONFLICT' | 'TRAINING_COMPLETION_FEEDBACK_CONFLICT' | 'BAD_INPUT',
    message: string,
    readonly statusCode: 400 | 422,
  ) {
    super(message);
    this.name = 'TrainingCompletionContractError';
  }
}

export interface NormalizedTrainingCompletionFeedback {
  completionState: TrainingCompletionState;
  stateWasExplicit: boolean;
  readinessLevel: number | null;
  difficultyFeedback: string | null;
  durationFeedback: string | null;
  discomfortFlag: boolean;
  discomfortFlags: string[];
  discomfortLocations: string[];
  discomfortDetails: string | null;
  substitutionsUsed: string[];
  missedReason: string | null;
  feltTooHard: boolean;
  feltTooEasy: boolean;
  feltTooLong: boolean;
  feltTooShort: boolean;
  modality: string | null;
  sessionRole: string | null;
  hasRichFeedback: boolean;
}

const COMPLETION_STATES = new Set<TrainingCompletionState>(['completed', 'partial', 'skipped']);

export function normalizeTrainingCompletionFeedback(
  body: Record<string, unknown>,
  defaultState: TrainingCompletionState,
): NormalizedTrainingCompletionFeedback {
  const canonicalState = optionalState(body.completionState, 'completionState');
  const releasedState = optionalState(body.status, 'status');
  if (canonicalState && releasedState && canonicalState !== releasedState) {
    throw new TrainingCompletionContractError(
      'TRAINING_COMPLETION_STATE_CONFLICT',
      `completionState (${canonicalState}) conflicts with status (${releasedState}).`,
      422,
    );
  }
  const completionState = canonicalState ?? releasedState ?? defaultState;
  if (defaultState === 'skipped' && completionState !== 'skipped') {
    throw new TrainingCompletionContractError(
      'TRAINING_COMPLETION_STATE_CONFLICT',
      `The skip endpoint requires completionState/status to be skipped, not ${completionState}.`,
      422,
    );
  }

  const difficulty = optionalString(body.difficulty, 'difficulty', 128);
  const difficultyFeedback = optionalString(body.difficultyFeedback, 'difficultyFeedback', 128);
  if (difficulty && difficultyFeedback && difficulty !== difficultyFeedback) {
    throw feedbackConflict('difficulty', 'difficultyFeedback');
  }
  const skippedReason = optionalString(body.skippedReason, 'skippedReason', 256);
  const missedReason = optionalString(body.missedReason, 'missedReason', 256);
  if (skippedReason && missedReason && skippedReason !== missedReason) {
    throw feedbackConflict('skippedReason', 'missedReason');
  }

  const readinessLevel = optionalNumber(body.readinessLevel, 'readinessLevel', 0, 10);
  const durationFeedback = optionalString(body.durationFeedback, 'durationFeedback', 128);
  const discomfortFlags = optionalStringArray(body.discomfortFlags, 'discomfortFlags');
  const discomfortLocations = optionalStringArray(body.discomfortLocations, 'discomfortLocations');
  const discomfortDetails = optionalString(body.discomfortDetails, 'discomfortDetails', 1024);
  const substitutionsUsed = optionalStringArray(body.substitutionsUsed, 'substitutionsUsed');
  const explicitDiscomfort = optionalBoolean(body.discomfortFlag, 'discomfortFlag');
  const feltTooHard = optionalBoolean(body.feltTooHard, 'feltTooHard') ?? false;
  const feltTooEasy = optionalBoolean(body.feltTooEasy, 'feltTooEasy') ?? false;
  const feltTooLong = optionalBoolean(body.feltTooLong, 'feltTooLong') ?? false;
  const feltTooShort = optionalBoolean(body.feltTooShort, 'feltTooShort') ?? false;
  const modality = optionalString(body.modality, 'modality', 128);
  const sessionRole = optionalString(body.sessionRole, 'sessionRole', 128);
  const resolvedMissedReason = skippedReason ?? missedReason;
  const resolvedDifficulty = difficultyFeedback ?? difficulty;
  const discomfortFlag = explicitDiscomfort === true
    || discomfortFlags.length > 0
    || discomfortLocations.length > 0
    || discomfortDetails !== null;

  const hasRichFeedback = completionState !== 'completed'
    || readinessLevel !== null
    || resolvedDifficulty !== null
    || durationFeedback !== null
    || discomfortFlag
    || substitutionsUsed.length > 0
    || resolvedMissedReason !== null
    || feltTooHard
    || feltTooEasy
    || feltTooLong
    || feltTooShort
    || modality !== null
    || sessionRole !== null;

  return {
    completionState,
    stateWasExplicit: canonicalState !== null || releasedState !== null,
    readinessLevel,
    difficultyFeedback: resolvedDifficulty,
    durationFeedback,
    discomfortFlag,
    discomfortFlags,
    discomfortLocations,
    discomfortDetails,
    substitutionsUsed,
    missedReason: resolvedMissedReason,
    feltTooHard,
    feltTooEasy,
    feltTooLong,
    feltTooShort,
    modality,
    sessionRole,
    hasRichFeedback,
  };
}

function optionalState(value: unknown, field: string): TrainingCompletionState | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !COMPLETION_STATES.has(value as TrainingCompletionState)) {
    throw new TrainingCompletionContractError(
      'BAD_INPUT',
      `${field} must be one of completed, partial, or skipped.`,
      400,
    );
  }
  return value as TrainingCompletionState;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TrainingCompletionContractError('BAD_INPUT', `${field} must be a string.`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TrainingCompletionContractError('BAD_INPUT', `${field} must be at most ${maxLength} characters.`, 400);
  }
  return normalized || null;
}

function optionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TrainingCompletionContractError(
      'BAD_INPUT',
      `${field} must be a finite number between ${min} and ${max}.`,
      400,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new TrainingCompletionContractError('BAD_INPUT', `${field} must be a boolean.`, 400);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new TrainingCompletionContractError(
      'BAD_INPUT',
      `${field} must be an array of at most 32 strings.`,
      400,
    );
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new TrainingCompletionContractError('BAD_INPUT', `${field} must contain only strings.`, 400);
    }
    const item = entry.trim();
    if (!item || item.length > 128) {
      throw new TrainingCompletionContractError(
        'BAD_INPUT',
        `${field} entries must contain 1 to 128 characters.`,
        400,
      );
    }
    return item;
  });
  return [...new Set(normalized)];
}

function feedbackConflict(left: string, right: string): TrainingCompletionContractError {
  return new TrainingCompletionContractError(
    'TRAINING_COMPLETION_FEEDBACK_CONFLICT',
    `${left} conflicts with ${right}.`,
    422,
  );
}
