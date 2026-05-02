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
    // "rookie" isn't in the known vocabulary (May 2 2026 expansion
    // added experienced/veteran/expert/avançado/etc. so the prior
    // test value "expert" now matches as advanced). The resolver
    // moves on to gym_profile rather than returning fitness_profile-
    // tagged fallback. This is intentional: gym_profile MIGHT have
    // recognizable vocabulary even when fitness_profile doesn't.
    const r = resolveExperienceLevelWithSource(
      { experience_level: 'rookie' },
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
    // "rookie" and "semi-pro" aren't in the known list (May 2 2026
    // expansion added experienced/veteran/expert/avançado/etc., so
    // the prior test value "expert" now matches advanced). This
    // case is the strongest argument for the slice 3.I refactor: a
    // human looked at the user's onboarding and TYPED words —
    // they're definitely not a beginner — but the planner can't
    // tell, so it errs novice and the audit-trail logger flags
    // the new vocabulary for the resolver to absorb.
    const r = resolveExperienceLevelWithSource(
      { experience_level: 'rookie' },
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

/**
 * May 2 2026 expansion (Felipe-reported): the original 8-token
 * vocabulary recognized only "advanced", "5+", "intermediate",
 * "1-3", "3-5", "novice", "beginner", "<1". A pt-PT user with 5+
 * years of gym experience writing "5 years" or "experiente" or
 * "avançado" was silently downgraded to novice via the fallback,
 * and downstream slice 2.A's `BEGINNER_SAFE_SUBSTITUTIONS`
 * collapsed their plan to beginner-safe exercises.
 *
 * The expansion adds:
 *   - English synonyms: experienced, veteran, expert
 *   - Portuguese (pt-BR / pt-PT): experiente, veterano, avançado,
 *     intermediário, iniciante, principiante, novato (and the
 *     accent-stripped variants for users without diacritics)
 *   - Numeric year patterns: "5 years", "10 anos", "3 yrs" etc.
 *     mapping ≥5y → advanced, 1-4y → intermediate, <1y → novice
 *
 * These tests pin every new branch.
 */
describe('resolveExperienceLevelWithSource expansion (May 2 2026)', () => {
  // ── English synonyms ──
  it('recognizes "experienced" as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'experienced' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'experienced',
    });
  });

  it('recognizes "veteran" as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Veteran lifter' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'veteran',
    });
  });

  it('recognizes "expert" as advanced (was unrecognized before May 2 2026)', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Expert' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'expert',
    });
  });

  // ── Portuguese (pt-BR / pt-PT) synonyms ──
  it('recognizes "experiente" (pt) as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Experiente' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'experiente',
    });
  });

  it('recognizes "veterano" (pt) as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Veterano' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'veterano',
    });
  });

  it('recognizes "avançado" (pt) as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'avançado' }, null);
    expect(r.value).toBe('advanced');
    expect(r.source).toBe('fitness_profile.experience_level');
  });

  it('recognizes accent-stripped "avancado" (pt) as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'avancado' }, null);
    expect(r.value).toBe('advanced');
  });

  it('recognizes "intermediário" (pt) as intermediate', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Intermediário' }, null);
    expect(r.value).toBe('intermediate');
  });

  it('recognizes "iniciante" (pt) as novice', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: 'Iniciante' }, null);
    expect(r.value).toBe('novice');
  });

  // ── Numeric year patterns ──
  it('recognizes "5 years" as advanced (≥5 → advanced)', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '5 years' }, null);
    expect(r.value).toBe('advanced');
  });

  it('recognizes "10 anos" (pt) as advanced', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '10 anos de academia' }, null);
    expect(r.value).toBe('advanced');
  });

  it('recognizes "3 years" as intermediate (1-4 → intermediate)', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '3 years' }, null);
    expect(r.value).toBe('intermediate');
  });

  it('recognizes "0 years" as novice', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '0 years' }, null);
    expect(r.value).toBe('novice');
  });

  it('handles "5 yrs" as advanced (yrs is a recognized abbreviation)', () => {
    const r = resolveExperienceLevelWithSource({ experience_level: '5 yrs of training' }, null);
    expect(r.value).toBe('advanced');
  });

  // ── Source-precedence interaction ──
  it('explicit "advanced" still beats numeric pattern (existing token wins)', () => {
    // "Advanced (3 years)" should match "advanced" first, not the
    // numeric "3 years" → intermediate. The explicit-token check
    // runs before the numeric pattern, preserving the behavior of
    // pre-existing tests.
    const r = resolveExperienceLevelWithSource({ experience_level: 'Advanced (3 years)' }, null);
    expect(r).toEqual({
      value: 'advanced',
      source: 'fitness_profile.experience_level',
      matchedKeyword: 'advanced',
    });
  });

  // ── Felipe's exact scenario (the user-reported bug) ──
  it('Felipe scenario: gym training_age "5+ years" + run experience "3 years" → advanced', () => {
    // Mirrors Felipe's reported profile: 5+ years gym, 3+ years
    // running. The gym track-age is the primary input for
    // strength experience. With the prior 8-token vocabulary, if
    // the profile string was "5 years" (not literal "5+"), it
    // fell through to novice. The expansion makes both forms
    // work.
    const r = resolveExperienceLevelWithSource(
      null,
      { training_age: '5 years gym + 3 years running' },
    );
    expect(r.value).toBe('advanced');
    expect(r.source).toBe('gym_profile.training_age');
  });
});
