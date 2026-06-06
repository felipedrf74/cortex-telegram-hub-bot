import { describe, expect, it } from 'vitest';

import {
  TrainingOperationDisabledError,
  assertTrainingCalendarSourceWritesEnabled,
  assertTrainingCalendarWritesEnabled,
  isTrainingCalendarSourceWritesEnabled,
  isTrainingCalendarWritesEnabled,
  isTrainingCrossSkillSignalsEnabled,
  isTrainingOutlookCalendarWritesEnabled,
  isTrainingPlanGenerationEnabled,
  trainingOperationDisabledMessage,
} from '../../src/services/training-operational-switches';

describe('training-operational-switches', () => {
  it('defaults Training operations to enabled', () => {
    expect(isTrainingPlanGenerationEnabled({})).toBe(true);
    expect(isTrainingCalendarWritesEnabled({})).toBe(true);
    expect(isTrainingCalendarSourceWritesEnabled('google', {})).toBe(true);
    // 2026-05-25 fix — Outlook now defaults to enabled, matching Google.
    expect(isTrainingOutlookCalendarWritesEnabled({})).toBe(true);
    expect(isTrainingCrossSkillSignalsEnabled({})).toBe(true);
  });

  // 2026-05-25 fix — Outlook is now ON by default, matching Google.
  // The kill switch TRAINING_CALENDAR_OUTLOOK_DISABLED is retained for
  // fast emergency rollback without a redeploy. The previously-required
  // opt-in TRAINING_CALENDAR_OUTLOOK_ENABLED still works but is no
  // longer required for Outlook to be reachable.
  it('R-2026-05-25 — allows Outlook calendar writes by default (no env opt-in required)', () => {
    expect(isTrainingOutlookCalendarWritesEnabled({})).toBe(true);
    expect(isTrainingCalendarSourceWritesEnabled('outlook', {})).toBe(true);
    expect(() => assertTrainingCalendarSourceWritesEnabled('outlook', {})).not.toThrow();
  });

  it('R-2026-05-25 — still respects the TRAINING_CALENDAR_OUTLOOK_DISABLED kill switch', () => {
    expect(isTrainingOutlookCalendarWritesEnabled({ TRAINING_CALENDAR_OUTLOOK_DISABLED: '1' })).toBe(false);
    expect(isTrainingCalendarSourceWritesEnabled('outlook', { TRAINING_CALENDAR_OUTLOOK_DISABLED: '1' })).toBe(false);
    expect(() => assertTrainingCalendarSourceWritesEnabled('outlook', { TRAINING_CALENDAR_OUTLOOK_DISABLED: 'true' }))
      .toThrow(TrainingOperationDisabledError);
  });

  it('R-2026-05-25 — kill switch beats an explicit ENABLED opt-in', () => {
    // Both flags set: DISABLED wins. Lets operators flip Outlook off
    // even if the deployment env still has the legacy ENABLED flag set.
    expect(isTrainingOutlookCalendarWritesEnabled({
      TRAINING_CALENDAR_OUTLOOK_ENABLED: 'true',
      TRAINING_CALENDAR_OUTLOOK_DISABLED: '1',
    })).toBe(false);
  });

  it('R-2026-05-25 — honors an explicit ENABLED=false (back-compat with prior code path)', () => {
    // A deployment that previously had TRAINING_CALENDAR_OUTLOOK_ENABLED=false
    // intentionally set to disable Outlook keeps that semantic — the
    // shared `isExplicitlyDisabled` helper treats the falsy ENABLED
    // value as a disable signal even without the explicit DISABLED flag.
    expect(isTrainingOutlookCalendarWritesEnabled({ TRAINING_CALENDAR_OUTLOOK_ENABLED: 'false' })).toBe(false);
    expect(isTrainingOutlookCalendarWritesEnabled({ TRAINING_CALENDAR_OUTLOOK_ENABLED: '0' })).toBe(false);
  });

  it('R-2026-05-25 — global TRAINING_ENGINE_DISABLED still beats default-enabled Outlook', () => {
    expect(isTrainingOutlookCalendarWritesEnabled({ TRAINING_ENGINE_DISABLED: '1' })).toBe(false);
  });

  it('R-2026-05-25 — legacy explicit ENABLED=true is still accepted (deployments that already set it keep working)', () => {
    expect(isTrainingOutlookCalendarWritesEnabled({ TRAINING_CALENDAR_OUTLOOK_ENABLED: 'true' })).toBe(true);
    expect(isTrainingCalendarSourceWritesEnabled('outlook', { TRAINING_CALENDAR_OUTLOOK_ENABLED: 'true' })).toBe(true);
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
    expect(trainingOperationDisabledMessage('outlook_calendar_writes')).toContain('Outlook');
    expect(trainingOperationDisabledMessage('cross_skill_signals')).toContain('Training cross-skill signals');
  });
});
