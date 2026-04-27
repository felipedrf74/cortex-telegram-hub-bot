import { describe, expect, it } from 'vitest';

import { resolveEquipmentAccessWithSource } from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the discriminated-union output of
 * `resolveEquipmentAccessWithSource` introduced by coach-engine
 * slice 3.J (Layer 1 audit follow-up).
 *
 * Before slice 3.J the resolver string-matched against a known
 * keyword list (`'full gym'` / `'garage'` / `'home gym'` /
 * `'basic'` / `'bodyweight'` / `'band'`) and silently returned
 * `hasGym/hasBarbell/hasDumbbells: false` when the input didn't
 * match any keyword. A real-gym user typing "Crossfit box" or
 * "Hotel gym" got their barbell and dumbbell access stripped
 * silently, forcing the strength engine into bodyweight/band-only
 * patterns even though they had a fully-equipped facility.
 *
 * Slice 3.J keeps the planner output (the EquipmentAccess shape)
 * identical for every input — including the fallback — but adds a
 * `source` discriminator so the call-site logger can distinguish:
 *   - matched profile → name the field + list the matched keywords
 *   - unrecognized vocabulary → tag fallback with the raw input
 *     so operators can absorb the new word
 *   - missing data → tag fallback with `reason: 'missing'` so
 *     operators prompt the user to fill in equipment instead
 */
describe('resolveEquipmentAccessWithSource (slice 3.J)', () => {
  // MARK: - Recognized vocabulary, gym_profile source

  it('returns full gym capabilities when gym_profile says "Full Gym"', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Full Gym' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['full gym']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(true);
    expect(r.value.hasDumbbells).toBe(true);
    expect(r.value.hasTrack).toBe(true);
  });

  it('returns full gym capabilities when gym_profile says "Full Commercial"', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Full Commercial' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['full commercial']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(true);
    expect(r.value.hasDumbbells).toBe(true);
  });

  it('returns garage capabilities when gym_profile says "Garage gym"', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Garage gym' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['garage']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(true);
    expect(r.value.hasDumbbells).toBe(true);
  });

  it('returns home-basic capabilities (gym + dumbbells, NO barbell) when gym_profile says "Home gym"', () => {
    // The pre-slice-3.J behavior: home gym doesn't imply barbell
    // access. Pin so a future tweak that accidentally bundles
    // barbell with home gym fails here.
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Home gym' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['home gym']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(false);
    expect(r.value.hasDumbbells).toBe(true);
  });

  it('returns home-basic capabilities when gym_profile says "Basic equipment"', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Basic equipment' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['basic']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(false);
    expect(r.value.hasDumbbells).toBe(true);
  });

  // MARK: - Composite matches

  it('lists every matched keyword when multiple appear in the same string', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Full gym + bands' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['full gym', 'band']);
    expect(r.value.hasGym).toBe(true);
    expect(r.value.hasBarbell).toBe(true);
    expect(r.value.notes).toContain('Resistance bands available.');
  });

  it('matches "bodyweight" alone and adds the bodyweight-only note', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Bodyweight only' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['bodyweight']);
    expect(r.value.hasGym).toBe(false);
    expect(r.value.hasBarbell).toBe(false);
    expect(r.value.hasDumbbells).toBe(false);
    expect(r.value.notes).toContain('Bodyweight-only setup.');
  });

  // MARK: - Source preference: gym_profile beats fitness_profile

  it('prefers gym_profile over fitness_profile when both are present and recognized', () => {
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 'Garage gym' },
      { equipment_access: 'Full gym' },
    );
    expect(r.source).toBe('gym_profile.equipment_access');
  });

  // MARK: - fitness_profile fallback source

  it('falls back to fitness_profile when gym_profile is absent', () => {
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 'Full gym' },
      null,
    );
    expect(r.source).toBe('fitness_profile.available_equipment');
    if (r.source !== 'fitness_profile.available_equipment') return;
    expect(r.matchedKeywords).toEqual(['full gym']);
    expect(r.value.hasBarbell).toBe(true);
  });

  it('falls back to fitness_profile when gym_profile string is unrecognized', () => {
    // gym_profile says "Crossfit box" (unrecognized), fitness_profile
    // says "Garage" (recognized) — the resolver should still find
    // the recognized match in fitness_profile rather than tagging
    // fallback prematurely.
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 'Garage' },
      { equipment_access: 'Crossfit box' },
    );
    expect(r.source).toBe('fitness_profile.available_equipment');
    if (r.source !== 'fitness_profile.available_equipment') return;
    expect(r.matchedKeywords).toEqual(['garage']);
  });

  // MARK: - Fallback: missing

  it('fallback with reason="missing" when both profiles are null', () => {
    const r = resolveEquipmentAccessWithSource(null, null);
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
    expect(r.rawInput).toBeUndefined();
    expect(r.value.hasGym).toBe(false);
    expect(r.value.hasBarbell).toBe(false);
    expect(r.value.hasDumbbells).toBe(false);
    expect(r.value.hasTrack).toBe(true);
  });

  it('fallback with reason="missing" when both profiles lack the relevant field', () => {
    const r = resolveEquipmentAccessWithSource({ weight_kg: 75 }, { strength_goal: 'hypertrophy' });
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
  });

  it('fallback with reason="missing" when both fields are empty/whitespace strings', () => {
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: '   ' },
      { equipment_access: '' },
    );
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
  });

  // MARK: - Fallback: unrecognized — the slice 3.J fix

  it('fallback with reason="unrecognized" + rawInput when gym_profile says "Crossfit box"', () => {
    // The killer case the audit flagged. A real gym user typing
    // "Crossfit box" got their barbell/dumbbell access silently
    // stripped. Now the call-site logger sees the raw input and
    // can flag it for the matcher list to absorb.
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Crossfit box' });
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('unrecognized');
    expect(r.rawInput).toBe('Crossfit box');
  });

  it('fallback with reason="unrecognized" when gym_profile says "Hotel gym"', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: 'Hotel gym' });
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('unrecognized');
    expect(r.rawInput).toBe('Hotel gym');
  });

  it('fallback with reason="unrecognized" + concatenates BOTH raw inputs when both profiles say something unrecognized', () => {
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 'YMCA' },
      { equipment_access: 'University rec center' },
    );
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('unrecognized');
    // The rawInput joins both present strings so the operator
    // can see the full picture in one log line.
    expect(r.rawInput).toBe('University rec center | YMCA');
  });

  it('fallback with reason="unrecognized" when only fitness_profile has unrecognized text', () => {
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 'Boutique studio' },
      null,
    );
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('unrecognized');
    expect(r.rawInput).toBe('Boutique studio');
  });

  // MARK: - Non-string inputs are treated as missing

  it('fallback with reason="missing" when profile fields are non-string types', () => {
    // Numbers, booleans, objects can't carry recognized vocabulary.
    // Pre-slice-3.J `String(...)` coercion would produce "[object
    // Object]" / "5" / "true" — none of which match the keyword
    // list. Slice 3.J makes this explicit instead of relying on
    // accidental no-match behavior.
    const r = resolveEquipmentAccessWithSource(
      { available_equipment: 5 },
      { equipment_access: { gym: 'full' } },
    );
    expect(r.source).toBe('fallback');
    if (r.source !== 'fallback') return;
    expect(r.reason).toBe('missing');
  });

  // MARK: - Whitespace + case handling

  it('handles whitespace and mixed case in recognized vocabulary', () => {
    const r = resolveEquipmentAccessWithSource(null, { equipment_access: '   FULL GYM  ' });
    expect(r.source).toBe('gym_profile.equipment_access');
    if (r.source !== 'gym_profile.equipment_access') return;
    expect(r.matchedKeywords).toEqual(['full gym']);
  });

  // MARK: - Fallback shape sanity

  it('fallback value has hasTrack=true (running outdoors is universal) and everything else false', () => {
    const r = resolveEquipmentAccessWithSource(null, null);
    expect(r.value).toEqual({
      hasGym: false,
      hasBarbell: false,
      hasDumbbells: false,
      hasBikeTrainer: false,
      hasPool: false,
      hasTrack: true,
      notes: [],
    });
  });
});
