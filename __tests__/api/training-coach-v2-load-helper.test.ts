/**
 * R5 P2 #7 — strength load model hydrates V2 sets/reps/load JSON.
 *
 * Codex caught that the prior coach-analysis SQL didn't pull the
 * V2 strength columns (`completed_sets_json`, `completed_reps_json`,
 * `completed_load_json`), so even when an athlete had logged real
 * tonnage, the load model collapsed to the duration*RPE proxy.
 *
 * The fix extracted `computeStrengthTonnageKg(...)` in the load
 * helper. These tests pin the canonical parsing behavior across
 * the two accepted JSON shapes + edge cases.
 */
import { describe, expect, it } from 'vitest';
import { computeStrengthTonnageKg } from '../../src/api/routes/training-coach-v2-load-helper';

describe('R5 P2 — computeStrengthTonnageKg', () => {
  it('returns undefined when no JSON is supplied', () => {
    expect(computeStrengthTonnageKg(null, null, null)).toBeUndefined();
    expect(computeStrengthTonnageKg('', '', '')).toBeUndefined();
  });

  it('Shape A — completedSetsJson with {reps, load} entries sums to tonnage', () => {
    const sets = JSON.stringify([
      { reps: 5, load: 100 }, // 500
      { reps: 5, load: 100 }, // 500
      { reps: 3, load: 110 }, // 330
    ]);
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(1330);
  });

  it('Shape A — invalid entries are skipped (negative reps, NaN load)', () => {
    const sets = JSON.stringify([
      { reps: 5, load: 100 }, // 500
      { reps: -1, load: 100 }, // skipped (negative reps)
      { reps: 5, load: Number.NaN }, // skipped (NaN — not valid JSON, but defensive)
      { reps: 3, load: 110 }, // 330
    ]);
    // The NaN entry can't even survive JSON.stringify (becomes null);
    // the defensive path still skips it.
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(830);
  });

  it('Shape A — empty array → undefined (no signal)', () => {
    expect(computeStrengthTonnageKg('[]', null, null)).toBeUndefined();
  });

  it('Shape B — parallel reps[]/load[] arrays sum to tonnage', () => {
    const reps = JSON.stringify([8, 8, 6]);
    const load = JSON.stringify([80, 80, 90]);
    // 8*80 + 8*80 + 6*90 = 640 + 640 + 540 = 1820
    expect(computeStrengthTonnageKg(null, reps, load)).toBe(1820);
  });

  it('Shape B — mismatched array lengths → undefined (refuse ambiguous data)', () => {
    expect(computeStrengthTonnageKg(null, '[5,5]', '[100,100,100]')).toBeUndefined();
  });

  it('Shape B — empty parallel arrays → undefined', () => {
    expect(computeStrengthTonnageKg(null, '[]', '[]')).toBeUndefined();
  });

  it('Shape A takes precedence over Shape B (canonical-form preference)', () => {
    const setsA = JSON.stringify([{ reps: 1, load: 1 }]);
    const reps = JSON.stringify([5]);
    const load = JSON.stringify([100]);
    // Shape A returns 1; Shape B would return 500. Pin that the
    // canonical form wins.
    expect(computeStrengthTonnageKg(setsA, reps, load)).toBe(1);
  });

  it('malformed JSON in shape A falls back gracefully to undefined (no throw)', () => {
    expect(computeStrengthTonnageKg('{not-json}', null, null)).toBeUndefined();
  });

  it('malformed JSON in shape B falls back gracefully to undefined (no throw)', () => {
    expect(computeStrengthTonnageKg(null, 'oops', 'oops')).toBeUndefined();
  });

  it('zero-load entries (bodyweight) → 0 tonnage but still "saw" → not undefined', () => {
    // Bodyweight squat × 10 reps × 0 kg load.
    const sets = JSON.stringify([{ reps: 10, load: 0 }, { reps: 10, load: 0 }]);
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(0);
  });
});
