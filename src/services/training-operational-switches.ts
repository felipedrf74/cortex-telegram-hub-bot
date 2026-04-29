// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type EnvLike = Record<string, string | undefined>;

export type TrainingOperation =
  | 'plan_generation'
  | 'calendar_writes'
  | 'cross_skill_signals';

export class TrainingOperationDisabledError extends Error {
  readonly operation: TrainingOperation;

  constructor(operation: TrainingOperation) {
    super(trainingOperationDisabledMessage(operation));
    this.name = 'TrainingOperationDisabledError';
    this.operation = operation;
  }
}

export function isTrainingPlanGenerationEnabled(env: EnvLike = process.env): boolean {
  return !isExplicitlyDisabled(env.TRAINING_ENGINE_ENABLED, env.TRAINING_ENGINE_DISABLED)
    && !isExplicitlyDisabled(env.TRAINING_PLAN_GENERATION_ENABLED, env.TRAINING_PLAN_GENERATION_DISABLED);
}

export function isTrainingCalendarWritesEnabled(env: EnvLike = process.env): boolean {
  return !isExplicitlyDisabled(env.TRAINING_ENGINE_ENABLED, env.TRAINING_ENGINE_DISABLED)
    && !isExplicitlyDisabled(env.TRAINING_CALENDAR_WRITES_ENABLED, env.TRAINING_CALENDAR_WRITES_DISABLED)
    && !isExplicitlyDisabled(env.TRAINING_CALENDAR_SYNC_ENABLED, env.TRAINING_CALENDAR_SYNC_DISABLED);
}

export function isTrainingCrossSkillSignalsEnabled(env: EnvLike = process.env): boolean {
  return !isExplicitlyDisabled(env.TRAINING_ENGINE_ENABLED, env.TRAINING_ENGINE_DISABLED)
    && !isExplicitlyDisabled(env.TRAINING_CROSS_SKILL_SIGNALS_ENABLED, env.TRAINING_CROSS_SKILL_SIGNALS_DISABLED);
}

export function assertTrainingCalendarWritesEnabled(env: EnvLike = process.env): void {
  if (!isTrainingCalendarWritesEnabled(env)) {
    throw new TrainingOperationDisabledError('calendar_writes');
  }
}

export function trainingOperationDisabledMessage(operation: TrainingOperation): string {
  switch (operation) {
    case 'plan_generation':
      return 'Training plan generation is temporarily disabled.';
    case 'calendar_writes':
      return 'Training calendar sync is temporarily disabled.';
    case 'cross_skill_signals':
      return 'Training cross-skill signals are temporarily disabled.';
  }
}

function isExplicitlyDisabled(enabledValue: string | undefined, disabledValue: string | undefined): boolean {
  if (isTruthyDisabledFlag(disabledValue)) return true;
  if (enabledValue == null || enabledValue.trim() === '') return false;
  return isFalsyEnabledFlag(enabledValue);
}

function isTruthyDisabledFlag(value: string | undefined): boolean {
  if (value == null) return false;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'disabled':
      return true;
    default:
      return false;
  }
}

function isFalsyEnabledFlag(value: string): boolean {
  switch (value.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return true;
    default:
      return false;
  }
}
