import { describe, expect, it } from 'vitest';

import { resolvePrimaryFocusWithSource } from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the discriminated-union output of
 * `resolvePrimaryFocusWithSource` introduced by coach-engine
 * slice 3.K (Layer 1 audit follow-up).
 *
 * Before slice 3.K the resolver matched the objective string
 * against six regex patterns and silently returned `'hybrid'`
 * when none matched. `resolveWeeklyTargets`, `resolveRaceCalendar`,
 * and `resolvePriorityOrder` all switch on `primaryFocus`, so a
 * silent fallback to `'hybrid'` produced a globally different
 * plan shape compared to a recognized objective — same input
 * weekly volume, totally different output.
 *
 * Slice 3.K introduces the `source` discriminator distinguishing
 * three runtime cases: recognized keyword, intentional volume-
 * split inference, and silent fallback (missing vs unrecognized).
 * The keyword vocabulary moved from regex literals to a sorted
 * lookup table (`OBJECTIVE_KEYWORDS`), naturally fixing a typo
 * where the previous `/70\\.3/` regex matched a literal backslash
 * instead of the dot — a user typing just "70.3" used to fall
 * through to hybrid.
 */
describe('resolvePrimaryFocusWithSource (slice 3.K)', () => {
  // MARK: - Triathlon vocabulary

  it('matches "Ironman" → triathlon', () => {
    const r = resolvePrimaryFocusWithSource('Ironman Lake Placid', 7, 2);
    expect(r).toEqual({ value: 'triathlon', source: 'objective_keyword', matchedKeyword: 'ironman' });
  });

  it('matches "Half Ironman" before "ironman" (more specific wins)', () => {
    const r = resolvePrimaryFocusWithSource('Half Ironman 70.3', 7, 2);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.value).toBe('triathlon');
    expect(r.matchedKeyword).toBe('half ironman');
  });

  it('matches "70.3" → triathlon (fixes the legacy backslash regex bug)', () => {
    // The pre-slice-3.K regex was /70\\.3/ which matched a literal
    // backslash (the double-escape was a typo). A user typing
    // just "70.3" used to fall through to the hybrid fallback.
    // The substring rewrite naturally fixes this.
    const r = resolvePrimaryFocusWithSource('70.3 in October', 6, 1);
    expect(r).toEqual({ value: 'triathlon', source: 'objective_keyword', matchedKeyword: '70.3' });
  });

  it('matches "triathlon"', () => {
    const r = resolvePrimaryFocusWithSource('Sprint triathlon goal', 7, 2);
    expect(r).toEqual({ value: 'triathlon', source: 'objective_keyword', matchedKeyword: 'triathlon' });
  });

  it('matches Portuguese "triatlo"', () => {
    const r = resolvePrimaryFocusWithSource('Treinar para triatlo', 6, 2);
    expect(r).toEqual({ value: 'triathlon', source: 'objective_keyword', matchedKeyword: 'triatlo' });
  });

  // MARK: - Marathon vocabulary

  it('matches "marathon" → marathon', () => {
    const r = resolvePrimaryFocusWithSource('Berlin Marathon 2026', 5, 1);
    expect(r).toEqual({ value: 'marathon', source: 'objective_keyword', matchedKeyword: 'marathon' });
  });

  it('matches "half marathon" before plain "marathon" (more specific wins)', () => {
    const r = resolvePrimaryFocusWithSource('Sub-1:30 half marathon', 5, 1);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.value).toBe('marathon');
    expect(r.matchedKeyword).toBe('half marathon');
  });

  it('matches Portuguese "meia maratona" before plain "maratona/marathon"', () => {
    const r = resolvePrimaryFocusWithSource('Meia maratona em outubro', 5, 1);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.matchedKeyword).toBe('meia maratona');
  });

  // MARK: - Running vocabulary

  it('matches "running" → running', () => {
    const r = resolvePrimaryFocusWithSource('General running fitness', 4, 1);
    expect(r).toEqual({ value: 'running', source: 'objective_keyword', matchedKeyword: 'running' });
  });

  it('matches "5k", "10k", "trail", "ultra" → running', () => {
    expect(resolvePrimaryFocusWithSource('Sub-20 5k', 4, 1)).toMatchObject({ value: 'running', matchedKeyword: '5k' });
    expect(resolvePrimaryFocusWithSource('Fast 10k', 4, 1)).toMatchObject({ value: 'running', matchedKeyword: '10k' });
    expect(resolvePrimaryFocusWithSource('Trail running', 4, 1)).toMatchObject({ value: 'running', matchedKeyword: 'trail' });
    expect(resolvePrimaryFocusWithSource('Ultra training', 4, 1)).toMatchObject({ value: 'running', matchedKeyword: 'ultra' });
  });

  it('matches "running" before "run" (more specific wins)', () => {
    // "running" contains "run", so a naive matcher could lock on
    // "run" first. The OBJECTIVE_KEYWORDS table orders "running"
    // first to ensure the specific match.
    const r = resolvePrimaryFocusWithSource('Running training plan', 4, 1);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.matchedKeyword).toBe('running');
  });

  // MARK: - Cycling vocabulary

  it('matches "cycling", "bike", "ciclismo" → cycling', () => {
    expect(resolvePrimaryFocusWithSource('Cycling base', 5, 1)).toMatchObject({ value: 'cycling', matchedKeyword: 'cycling' });
    expect(resolvePrimaryFocusWithSource('Bike fitness', 5, 1)).toMatchObject({ value: 'cycling', matchedKeyword: 'bike' });
    expect(resolvePrimaryFocusWithSource('Treino de ciclismo', 5, 1)).toMatchObject({ value: 'cycling', matchedKeyword: 'ciclismo' });
  });

  // MARK: - Swimming vocabulary

  it('matches "swimming" before "swim" (more specific wins)', () => {
    const r = resolvePrimaryFocusWithSource('Swimming endurance', 4, 0);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.matchedKeyword).toBe('swimming');
  });

  it('matches "swim" alone → swimming', () => {
    const r = resolvePrimaryFocusWithSource('Open water swim', 4, 0);
    expect(r).toMatchObject({ value: 'swimming', matchedKeyword: 'swim' });
  });

  it('matches Portuguese "natação" / "natacao" → swimming', () => {
    expect(resolvePrimaryFocusWithSource('Natação 4x semana', 4, 0)).toMatchObject({ value: 'swimming', matchedKeyword: 'natação' });
    expect(resolvePrimaryFocusWithSource('Natacao basica', 4, 0)).toMatchObject({ value: 'swimming', matchedKeyword: 'natacao' });
  });

  // MARK: - Strength vocabulary

  it('matches strength keywords → strength', () => {
    expect(resolvePrimaryFocusWithSource('Hypertrophy block', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'hypertrophy' });
    expect(resolvePrimaryFocusWithSource('Hipertrofia', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'hipertrofia' });
    expect(resolvePrimaryFocusWithSource('Bodybuilding cycle', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'bodybuilding' });
    expect(resolvePrimaryFocusWithSource('Build muscle', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'muscle' });
    expect(resolvePrimaryFocusWithSource('Pure strength', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'strength' });
    expect(resolvePrimaryFocusWithSource('Ganho de massa', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'massa' });
    expect(resolvePrimaryFocusWithSource('Foco em força', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'força' });
    expect(resolvePrimaryFocusWithSource('Musculação', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'muscula' });
    expect(resolvePrimaryFocusWithSource('Gym focus', 4, 4)).toMatchObject({ value: 'strength', matchedKeyword: 'gym' });
  });

  // MARK: - Volume-split inference (intentional hybrid)

  it('returns hybrid via volume-split inference when objective is unrecognized BUT user has both endurance and strength sessions', () => {
    // 5 total sessions, 2 strength → 3 endurance + 2 strength.
    // Volume signal supports hybrid even though objective text
    // is unrecognized. Distinct from fallback because there's
    // signal supporting the call.
    const r = resolvePrimaryFocusWithSource('General fitness goals', 5, 2);
    expect(r).toEqual({ value: 'hybrid', source: 'inferred_volume_split' });
  });

  it('returns hybrid via volume-split when sessions=4 and strength=1 (3 endurance + 1 strength)', () => {
    const r = resolvePrimaryFocusWithSource('Stay healthy', 4, 1);
    expect(r).toEqual({ value: 'hybrid', source: 'inferred_volume_split' });
  });

  it('does NOT trigger volume-split when strength=0 (zero strength means cardio-only)', () => {
    // strengthSessionsPerWeek === 0 fails the volume-split
    // condition, so this falls through to the unrecognized
    // fallback rather than tagging as inferred hybrid.
    const r = resolvePrimaryFocusWithSource('General fitness', 4, 0);
    expect(r.source).toBe('fallback');
  });

  it('does NOT trigger volume-split when sessionsPerWeek === strengthSessionsPerWeek (pure strength)', () => {
    // sessions=4 and strength=4 → no endurance sessions, so the
    // volume-split inference (which requires more total than
    // strength) doesn't fire.
    const r = resolvePrimaryFocusWithSource('General training', 4, 4);
    expect(r.source).toBe('fallback');
  });

  // MARK: - Fallback: missing

  it('fallback with reason="missing" when objective is empty string', () => {
    const r = resolvePrimaryFocusWithSource('', 4, 0);
    expect(r).toEqual({ value: 'hybrid', source: 'fallback', reason: 'missing' });
  });

  it('fallback with reason="missing" when objective is whitespace only', () => {
    const r = resolvePrimaryFocusWithSource('   ', 4, 0);
    expect(r).toEqual({ value: 'hybrid', source: 'fallback', reason: 'missing' });
  });

  // MARK: - Fallback: unrecognized — the slice 3.K fix

  it('fallback with reason="unrecognized" + rawInput when objective contains vocabulary not in OBJECTIVE_KEYWORDS', () => {
    // The audit-flagged case: a real user with a clear goal types
    // something the keyword table doesn't cover. Before slice 3.K
    // they got 'hybrid' silently and the entire plan shape changed
    // versus a recognized objective. Now the call-site logger
    // sees "Spartan race" and operators can absorb the new word.
    const r = resolvePrimaryFocusWithSource('Spartan race in spring', 4, 0);
    expect(r).toEqual({
      value: 'hybrid',
      source: 'fallback',
      reason: 'unrecognized',
      rawInput: 'Spartan race in spring',
    });
  });

  it('fallback with reason="unrecognized" trims whitespace from rawInput', () => {
    const r = resolvePrimaryFocusWithSource('   General wellness   ', 4, 0);
    expect(r).toEqual({
      value: 'hybrid',
      source: 'fallback',
      reason: 'unrecognized',
      rawInput: 'General wellness',
    });
  });

  // MARK: - Match precedence: keyword > volume-split > fallback

  it('prefers keyword match over volume-split inference', () => {
    // Both could fire: "marathon" keyword + 5 sessions / 2
    // strength = volume split could say hybrid. Keyword wins.
    const r = resolvePrimaryFocusWithSource('Berlin Marathon training', 5, 2);
    expect(r.source).toBe('objective_keyword');
    if (r.source !== 'objective_keyword') return;
    expect(r.value).toBe('marathon');
  });

  // MARK: - Case insensitivity

  it('matches case-insensitively', () => {
    expect(resolvePrimaryFocusWithSource('IRONMAN', 7, 2)).toMatchObject({ matchedKeyword: 'ironman' });
    expect(resolvePrimaryFocusWithSource('Marathon', 5, 1)).toMatchObject({ matchedKeyword: 'marathon' });
    expect(resolvePrimaryFocusWithSource('STRENGTH GAINS', 4, 4)).toMatchObject({ matchedKeyword: 'strength' });
  });
});
