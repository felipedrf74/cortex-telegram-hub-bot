import { describe, expect, it } from 'vitest';

import {
  TrainingOperationDisabledError,
  assertTrainingCalendarWritesEnabled,
  isTrainingCalendarWritesEnabled,
  isTrainingCrossSkillSignalsEnabled,
  isTrainingPlanGenerationEnabled,
  trainingOperationDisabledMessage,
} from '../../src/services/training-operational-switches';

describe('training-operational-switches', () => {
  it('defaults Training operations to enabled', () => {
    expect(isTrainingPlanGenerationEnabled({})).toBe(true);
    expect(isTrainingCalendarWritesEnabled({})).toBe(true);
    expect(isTrainingCrossSkillSignalsEnabled({})).toBe(true);
  });

  it('supports a global TRAINING_ENGINE_DISABLED emergency switch', () => {
    const env = { TRAINING_ENGINE_DISABLED: '1' };

    expect(isTrainingPlanGenerationEnabled(env)).toBe(false);
    expect(isTrainingCalendarWritesEnabled(env)).toBe(false);
    expect(isTrainingCrossSkillSignalsEnabled(env)).toBe(false);
  });

  it('supports explicit per-surface disabled switches', () => {
    expect(isTrainingPlanGenerationEnabled({ TRAINING_PLAN_GENERATION_DISABLED: 'true' })).toBe(false);
    expect(isTrainingCalendarWritesEnabled({ TRAINING_CALENDAR_WRITES_DISABLED: 'yes' })).toBe(false);
    expect(isTrainingCalendarWritesEnabled({ TRAINING_CALENDAR_SYNC_DISABLED: 'on' })).toBe(false);
    expect(isTrainingCrossSkillSignalsEnabled({ TRAINING_CROSS_SKILL_SIGNALS_DISABLED: '1' })).toBe(false);
  });

  it('supports enabled=false style per-surface switches', () => {
    expect(isTrainingPlanGenerationEnabled({ TRAINING_PLAN_GENERATION_ENABLED: 'false' })).toBe(false);
    expect(isTrainingCalendarWritesEnabled({ TRAINING_CALENDAR_SYNC_ENABLED: '0' })).toBe(false);
    expect(isTrainingCrossSkillSignalsEnabled({ TRAINING_CROSS_SKILL_SIGNALS_ENABLED: 'off' })).toBe(false);
  });

  it('throws a typed disabled error for calendar writes', () => {
    expect(() => assertTrainingCalendarWritesEnabled({ TRAINING_CALENDAR_WRITES_ENABLED: 'false' }))
      .toThrow(TrainingOperationDisabledError);

    try {
      assertTrainingCalendarWritesEnabled({ TRAINING_CALENDAR_WRITES_DISABLED: '1' });
      throw new Error('Expected disabled error');
    } catch (err) {
      expect(err).toBeInstanceOf(TrainingOperationDisabledError);
      expect((err as TrainingOperationDisabledError).operation).toBe('calendar_writes');
    }
  });

  it('keeps disabled messages stable for iOS and ops runbooks', () => {
    expect(trainingOperationDisabledMessage('plan_generation')).toContain('Training plan generation');
    expect(trainingOperationDisabledMessage('calendar_writes')).toContain('Training calendar sync');
    expect(trainingOperationDisabledMessage('cross_skill_signals')).toContain('Training cross-skill signals');
  });
});
