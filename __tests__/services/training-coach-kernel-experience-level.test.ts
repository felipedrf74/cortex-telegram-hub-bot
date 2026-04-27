import { describe, expect, it } from 'vitest';

import { resolveExperienceLevelWithSource } from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the discriminated-union output of `resolveExperienceLevelWithSource`
 * introduced by coach-engine slice 3.I (Layer 1 audit follow-up).
 *
 * Before slice 3.I the resolver returned only the experience-level
 * value, conflating three runtime cases:
 *
 *   1. The profile EXPLICITLY recorded "novice" / "beginner" → return
 *      novice
 *   2. The profile recorded an UNRECOGNIZED vocabulary word
 *      (e.g. "expert", "semi-pro") → return novice
 *   3. The profile had NOTHING → return novice
 *
 * All three produced the same novice output. Downstream slice 2.A's
 * `BEGINNER_SAFE_SUBSTITUTIONS` layer fires on
 * `experienceLevel === 'novice'`, so case (3) — a fresh user with no
 * profile data — got the same exercise-substitution treatment as a
 * confirmed novice. The new resolver separates these via the
 * `source` discriminator so the call-site logger can warn on
 * fallbacks while preserving identical planner output.
 */
describe('resolveExperienceLevelWithSource (slice 3.I)', () => {
  // MARK: - Recognized vocabulary, fitness_profile source

  it('returns advanced when fitness_profile says "advanced"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Advanced' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'advanced',
    });
  });

  it('returns advanced when fitness_profile contains "5+"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '5+ years lifting' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: '5+',
    });
  });

  it('returns intermediate when fitness_profile says "intermediate"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Intermediate' }, null);
    expect(r).toEqual({
      value: 'intermediate',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'intermediate',
    });
  });

  it('returns intermediate when fitness_profile says "1-3 years"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '1-3 years' }, null);
    expect(r).toEqual({
      value: 'intermediate',
      source: 'fitness_profile.experience_level',
      matchedKeyword: '1-3',
    });
  });

  it('returns intermediate when fitness_profile says "3-5 years"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '3-5 years' }, null);
    expect(r).toEqual({
      value: 'intermediate',
      source: 'fitness_profile.experience_level',
      matchedKeyword: '3-5',
    });
  });

  it('returns novice when fitness_profile EXPLICITLY says "novice" — distinguishable from missing', () => {
    // The point of slice 3.I: an explicit novice and a missing
    // profile both yield value=novice but DIFFERENT sources. This
    // test pins the distinction.
    const r = resolveExperienceLevelWithSource({ experience_level: 'novice lifter' }, null);
    expect(r).toEqual({
      value: 'novice',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'novice',
    });
  });

  it('returns novice when fitness_profile says "beginner"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Beginner' }, null);
    expect(r).toEqual({
      value: 'novice',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'beginner',
    });
  });

  it('returns novice when fitness_profile says "<1 year"', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '<1 year' }, null);
    expect(r).toEqual({
      value: 'novice',
      source: 'fitness_profile.experience_level',
      matchedKeyword: '<1',
    });
  });

  // MARK: - fitness_profile preferred over gym_profile

  it('prefers fitness_profile over gym_profile when both are present and recognized', () => {
    const r = resolveExperienceLevelWithSource(
      { experience_level: 'advanced' },
      { training_age: '1-3 years' },
    );
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'advanced',
    });
  });

  // MARK: - gym_profile fallback source

  it('falls back to gym_profile when fitness_profile is absent', () => {
    const r = resolveExperienceLevelWithSource(null, { training_age: 'Intermediate' });
    expect(r).toEqual({
      value: 'intermediate',
      source: 'gym_profile.training_age',
      matchedKeyword: 'intermediate',
    });
  });

  it('falls back to gym_profile when fitness_profile is empty string', () => {
    // An empty string for fitness profile should NOT block the
    // gym_profile from contributing — empty strings are equivalent
    // to absent for resolver purposes.
    const r = resolveExperienceLevelWithSource(
      { experience_level: '' },
      { training_age: '5+ years' },
    );
    expect(r).toEqual({
      value: 'advanced',
      source: 'gym_profile.training_age',
      matchedKeyword: '5+',
    });
  });

  it('falls back to gym_profile when fitness_profile has unrecognized vocabulary', () => {
    // "expert" isn't in the known vocabulary. The resolver moves on
    // to gym_profile rather than returning fitness_profile-tagged
    // fallback. This is intentional: gym_profile MIGHT have
    // recognizable vocabulary even when fitness_profile doesn't.
    const r = resolveExperienceLevelWithSource(
      { experience_level: 'expert' },
      { training_age: 'beginner' },
    );
    expect(r).toEqual({
      value: 'novice',
      source: 'gym_profile.training_age',
      matchedKeyword: 'beginner',
    });
  });

  // MARK: - Fallback case (the slice 3.I fix)

  it('falls back to novice with source=fallback when both profiles are null', () => {
    const r = resolveExperienceLevelWithSource(null, null);
    expect(r).toEqual({ value: 'novice', source: 'fallback' });
  });

  it('falls back to novice with source=fallback when both profiles are missing the relevant field', () => {
    const r = resolveExperienceLevelWithSource({ weight_kg: 75 }, { gym_type: 'home' });
    expect(r).toEqual({ value: 'novice', source: 'fallback' });
  });

  it('falls back to novice with source=fallback when both profiles have unrecognized vocabulary', () => {
    // "expert" and "semi-pro" aren't in the known list. This case
    // is the strongest argument for the slice 3.I refactor: a
    // human looked at the user's onboarding and TYPED words —
    // they're definitely not a beginner — but the planner can't
    // tell, so it errs novice and the audit-trail logger flags
    // the new vocabulary for the resolver to absorb.
    const r = resolveExperienceLevelWithSource(
      { experience_level: 'expert' },
      { training_age: 'semi-pro' },
    );
    expect(r).toEqual({ value: 'novice', source: 'fallback' });
  });

  it('falls back to novice when profile fields are non-string types', () => {
    // Numbers, booleans, objects — none of these can match the
    // string-vocabulary tokens. Slice 3.I makes this explicit
    // rather than relying on `String(...)` coercion (which would
    // produce "[object Object]" and accidentally match nothing).
    const r = resolveExperienceLevelWithSource(
      { experience_level: 5 },
      { training_age: { years: 3 } },
    );
    expect(r).toEqual({ value: 'novice', source: 'fallback' });
  });

  // MARK: - Whitespace / case handling

  it('handles whitespace and mixed case in the recognized vocabulary', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '   ADVANCED   ' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'advanced',
    });
  });
});
