import { describe, expect, it } from 'vitest';

import { resolveStrengthGoalWithSource } from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the discriminated-union output of
 * `resolveStrengthGoalWithSource` introduced by coach-engine
 * slice 3.L (Layer 1 audit follow-up).
 *
 * Before slice 3.L the resolver matched the
 * `gym_profile.primary_goal` string against four keywords
 * (`'hypertrophy'`, `'powerlifting'`, `'strength'`, `'support'`)
 * and silently returned `'athletic'` when none matched. Since
 * `Goals['strengthGoal']` drives strength prescription template
 * selection — `'hypertrophy'` / `'max_strength'` / `'athletic'` /
 * `'maintenance'` produce different rep ranges, intensity, and
 * exercise selection — a silent fallback to `'athletic'` for a
 * user typing `"powerbuilding"` / `"general fitness"` / `"tone"`
 * was a real plan-shape difference, not just a labeling concern.
 *
 * Slice 3.L applies the slice 3.J template: same vocabulary and
 * same fallback value (`'athletic'`), but the `source`
 * discriminator distinguishes recognized from
 * `reason: 'missing'` / `reason: 'unrecognized'` so the
 * call-site logger can emit actionable signals.
 */
describe('resolveStrengthGoalWithSource (slice 3.L)', () => {
  // MARK: - Recognized vocabulary

  it('returns hypertrophy when gym_profile says "Hypertrophy"', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Hypertrophy' });
    expect(r).toEqual({
      value: 'hypertrophy',
      source: 'gym_profile.primary_goal',
      matchedKeyword: 'hypertrophy',
    });
  });

  it('returns hypertrophy with prefix/suffix context', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Off-season hypertrophy block' });
    expect(r).toMatchObject({ value: 'hypertrophy', matchedKeyword: 'hypertrophy' });
  });

  it('returns max_strength when gym_profile says "Powerlifting"', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Powerlifting peak' });
    expect(r).toEqual({
      value: 'max_strength',
      source: 'gym_profile.primary_goal',
      matchedKeyword: 'powerlifting',
    });
  });

  it('returns max_strength when gym_profile says "Strength"', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Pure strength training' });
    expect(r).toEqual({
      value: 'max_strength',
      source: 'gym_profile.primary_goal',
      matchedKeyword: 'strength',
    });
  });

  it('matches "powerlifting" before "strength" when both substrings are present (more specific intent wins)', () => {
    // "Powerlifting strength block" contains both keywords. The
    // table orders 'powerlifting' first because it carries
    // stronger user-intent signal — a powerlifter typing both is
    // more specific than a generalist saying "strength".
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Powerlifting strength block' });
    expect(r.source).toBe('gym_profile.primary_goal');
    if (r.source !== 'gym_profile.primary_goal') return;
    expect(r.value).toBe('max_strength');
    expect(r.matchedKeyword).toBe('powerlifting');
  });

  it('returns maintenance when gym_profile says "Support"', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Support cardio block' });
    expect(r).toEqual({
      value: 'maintenance',
      source: 'gym_profile.primary_goal',
      matchedKeyword: 'support',
    });
  });

  // MARK: - Match precedence: keyword order in the table

  it('matches hypertrophy before strength when both substrings appear', () => {
    // "hypertrophy" appears before "strength" in the table
    // because hypertrophy is its own bucket, not a max_strength
    // synonym. A user typing "Strength + hypertrophy" should map
    // to hypertrophy as the more specific block intent.
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Strength + hypertrophy' });
    expect(r.matchedKeyword).toBe('hypertrophy');
    expect(r.value).toBe('hypertrophy');
  });

  // MARK: - Fallback: missing

  it('fallback with reason="missing" when gym_profile is null', () => {
    const r = resolveStrengthGoalWithSource(null);
    expect(r).toEqual({
      value: 'athletic',
      source: 'fallback',
      reason: 'missing',
    });
  });

  it('fallback with reason="missing" when gym_profile lacks primary_goal', () => {
    const r = resolveStrengthGoalWithSource({ training_age: '5+' });
    expect(r).toEqual({
      value: 'athletic',
      source: 'fallback',
      reason: 'missing',
    });
  });

  it('fallback with reason="missing" when primary_goal is empty string', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: '' });
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
    expect(r.rawInput).toBeUndefined();
  });

  it('fallback with reason="missing" when primary_goal is whitespace only', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: '   ' });
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
  });

  // MARK: - Fallback: unrecognized — the slice 3.L fix

  it('fallback with reason="unrecognized" + rawInput when primary_goal says "powerbuilding"', () => {
    // The audit-flagged case. "Powerbuilding" is a real strength
    // training paradigm (hybrid of powerlifting + bodybuilding)
    // not yet in STRENGTH_GOAL_KEYWORDS. Before slice 3.L the
    // user got 'athletic' silently. Now the call-site logger
    // sees "powerbuilding" and operators can absorb it.
    const r = resolveStrengthGoalWithSource({ primary_goal: 'powerbuilding' });
    expect(r).toEqual({
      value: 'athletic',
      source: 'fallback',
      reason: 'unrecognized',
      rawInput: 'powerbuilding',
    });
  });

  it('fallback with reason="unrecognized" when primary_goal says "general fitness"', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 'general fitness' });
    expect(r).toMatchObject({
      value: 'athletic',
      source: 'fallback',
      reason: 'unrecognized',
      rawInput: 'general fitness',
    });
  });

  it('fallback with reason="unrecognized" preserves the raw input verbatim (no toLowerCase)', () => {
    // The lowercase normalization happens INSIDE the matcher loop,
    // not on rawInput. The log line carries the user's original
    // capitalization so operators see exactly what was typed.
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Tone & Sculpt' });
    expect(r).toMatchObject({
      reason: 'unrecognized',
      rawInput: 'Tone & Sculpt',
    });
  });

  it('fallback with reason="unrecognized" when primary_goal is the literal word "maintenance"', () => {
    // Slice-scope discipline: even though "maintenance" looks
    // semantically equivalent to "support", it's NOT in the
    // existing keyword set and slice 3.L deliberately preserves
    // the existing vocabulary. Adding "maintenance" would shift
    // inputs from 'athletic' to 'maintenance' — a real behavior
    // change that belongs in a separate vocabulary-expansion
    // slice. This test pins that scope guarantee.
    const r = resolveStrengthGoalWithSource({ primary_goal: 'Maintenance season' });
    expect(r).toMatchObject({
      value: 'athletic',
      source: 'fallback',
      reason: 'unrecognized',
      rawInput: 'Maintenance season',
    });
  });

  // MARK: - Type robustness

  it('fallback with reason="missing" when primary_goal is a non-string type', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: 5 });
    expect(r).toMatchObject({
      value: 'athletic',
      source: 'fallback',
      reason: 'missing',
    });
  });

  it('fallback with reason="missing" when primary_goal is an object', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: { kind: 'hypertrophy' } });
    expect(r).toMatchObject({
      value: 'athletic',
      source: 'fallback',
      reason: 'missing',
    });
  });

  // MARK: - Whitespace + case handling

  it('handles whitespace and mixed case in recognized vocabulary', () => {
    const r = resolveStrengthGoalWithSource({ primary_goal: '   HYPERTROPHY  ' });
    expect(r.source).toBe('gym_profile.primary_goal');
    if (r.source !== 'gym_profile.primary_goal') return;
    expect(r.matchedKeyword).toBe('hypertrophy');
  });

  // MARK: - Fallback shape sanity

  it('fallback value is always "athletic" regardless of reason', () => {
    expect(resolveStrengthGoalWithSource(null).value).toBe('athletic');
    expect(resolveStrengthGoalWithSource({}).value).toBe('athletic');
    expect(resolveStrengthGoalWithSource({ primary_goal: 'powerbuilding' }).value).toBe('athletic');
    expect(resolveStrengthGoalWithSource({ primary_goal: '' }).value).toBe('athletic');
  });
});
