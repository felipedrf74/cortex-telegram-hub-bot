// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type EnvLike = Record<string, string | undefined>;

export type TrainingOperation =
  | 'plan_generation'
  | 'calendar_writes'
  | 'outlook_calendar_writes'
  | 'cross_skill_signals';

export type TrainingCalendarWriteSource = 'google' | 'outlook';

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

export function isTrainingOutlookCalendarWritesEnabled(env: EnvLike = process.env): boolean {
  // 2026-05-25 fix — Outlook is now ON by default, matching Google.
  // Pre-fix this required an explicit `TRAINING_CALENDAR_OUTLOOK_ENABLED=true`
  // env opt-in that originated from a defensive release gate in commit
  // `7130f867 fix(training): complete calendar reliability audit`. The
  // gate has since been validated implicitly: the same Outlook adapter
  // (`secretary-unified-calendar-provider-adapter`) has been writing
  // training-owned events to Outlook in production for months via the
  // secretary-agenda path. Blocking explicit Outlook selection in the
  // New Plan iOS flow while implicitly writing to Outlook everywhere
  // else is the wrong contract. The kill switch
  // (`TRAINING_CALENDAR_OUTLOOK_DISABLED=1`) is retained for fast
  // emergency rollback without a redeploy.
  return isTrainingCalendarWritesEnabled(env)
    && !isTruthyDisabledFlag(env.TRAINING_CALENDAR_OUTLOOK_DISABLED)
    && !isExplicitlyDisabled(env.TRAINING_CALENDAR_OUTLOOK_ENABLED, env.TRAINING_CALENDAR_OUTLOOK_DISABLED);
}

export function isTrainingCalendarSourceWritesEnabled(
  source: TrainingCalendarWriteSource,
  env: EnvLike = process.env,
): boolean {
  if (source === 'outlook') return isTrainingOutlookCalendarWritesEnabled(env);
  return isTrainingCalendarWritesEnabled(env);
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

export function assertTrainingCalendarSourceWritesEnabled(
  source: TrainingCalendarWriteSource,
  env: EnvLike = process.env,
): void {
  if (isTrainingCalendarSourceWritesEnabled(source, env)) return;
  throw new TrainingOperationDisabledError(source === 'outlook' ? 'outlook_calendar_writes' : 'calendar_writes');
}

export function trainingOperationDisabledMessage(operation: TrainingOperation): string {
  switch (operation) {
    case 'plan_generation':
      return 'Training plan generation is temporarily disabled.';
    case 'calendar_writes':
      return 'Training calendar sync is temporarily disabled.';
    case 'outlook_calendar_writes':
      return 'Training Outlook calendar sync is temporarily disabled.';
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

function isTruthyEnabledFlag(value: string | undefined): boolean {
  if (value == null) return false;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
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
