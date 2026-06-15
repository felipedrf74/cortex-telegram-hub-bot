import { describe, expect, it } from 'vitest';
import {
  containsUnsafeTrainingDisplayCopy,
  sanitizeTrainingDisplayCopy,
  sanitizeTrainingUserFacingPayload,
} from '../../src/services/training-copy-sanitizer';

describe('training copy sanitizer', () => {
  it('replaces raw JSON and debug-shaped display text with stable copy', () => {
    expect(sanitizeTrainingDisplayCopy('{"symptoms":["chest_pain"],"severity":"medical_referral"}'))
      .toBe('Training update');
    expect(sanitizeTrainingDisplayCopy('selector_trace failed for catalog_version v3'))
      .toBe('Training update');
    expect(sanitizeTrainingDisplayCopy('Coach said undefined for this plan'))
      .toBe('Training update');
    expect(containsUnsafeTrainingDisplayCopy('[object Object]')).toBe(true);
  });

  it('humanizes raw enum tokens without dropping normal coach copy', () => {
    expect(sanitizeTrainingDisplayCopy('Move threshold_run after recovery_ride.'))
      .toBe('Move threshold run after recovery ride.');
    expect(sanitizeTrainingDisplayCopy('Keep today easy because sleep was light.'))
      .toBe('Keep today easy because sleep was light.');
  });

  it('sanitizes display fields while preserving machine contract fields', () => {
    const payload = sanitizeTrainingUserFacingPayload({
      hero: {
        state: 'recovery',
        title: '{"raw":"bad"}',
        primaryAction: {
          id: 'hero-safety-review',
          target: 'openWeekPlan',
          title: 'medical_referral',
        },
      },
      meta: {
        source: 'server',
        reasonCodes: ['COACH_STALE', 'medical_referral'],
      },
    });

    expect(payload.hero.state).toBe('recovery');
    expect(payload.hero.primaryAction.id).toBe('hero-safety-review');
    expect(payload.hero.primaryAction.target).toBe('openWeekPlan');
    expect(payload.meta.reasonCodes).toEqual(['COACH_STALE', 'medical_referral']);
    expect(payload.hero.title).toBe('Training update');
    expect(payload.hero.primaryAction.title).toBe('Training update');
  });
});
