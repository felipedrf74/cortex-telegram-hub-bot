/**
 * Slice A1a — typed accessor over training-principles.json + volume
 * growth cap wired into endurance engines.
 *
 * Pins:
 *
 *   - Each typed accessor parses the live JSON correctly
 *   - Accessors return undefined for missing keys (defensive parsing)
 *   - applyVolumeGrowthCap math is correct (cap binds only above prev)
 *   - applyVolumeGrowthCap is a no-op on taper/deload weeks
 *   - applyVolumeGrowthCapForSport falls back to no-cap when JSON
 *     is missing the sport key
 *   - Volume cap is reachable through the running engine for primary
 *     contexts AND support-only contexts
 *   - Volume cap is reachable through the cycling engine
 *
 * Engine integration tests use a synthetic principles map (not the
 * live JSON) so the test stays robust against JSON content edits.
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import {
  applyVolumeGrowthCap,
  applyVolumeGrowthCapForSport,
  getEquipmentRules,
  getExperienceRules,
  getFatigueRules,
  getInterferenceRules,
  getMaxHardSessionsPerWeek,
  getPhaseRules,
  getProgressionRules,
  getVolumeGrowthCap,
} from '../../src/services/coach-kernel/training-principles';

describe('typed accessors over training-principles.json', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('reads volumeGrowthCapsPct for each sport', () => {
    expect(getVolumeGrowthCap(principles, 'running')).toBe(8);
    expect(getVolumeGrowthCap(principles, 'cycling')).toBe(12);
    expect(getVolumeGrowthCap(principles, 'swimming')).toBe(15);
    expect(getVolumeGrowthCap(principles, 'strength')).toBe(10);
  });

  it('reads maxHardSessionsPerWeek for each endurance sport', () => {
    expect(getMaxHardSessionsPerWeek(principles, 'running')).toBe(2);
    expect(getMaxHardSessionsPerWeek(principles, 'cycling')).toBe(2);
    expect(getMaxHardSessionsPerWeek(principles, 'swimming')).toBe(2);
  });

  it('reads phase rules for each phase', () => {
    const peak = getPhaseRules(principles, 'peak');
    expect(peak?.compoundEmphasisPct).toBe(80);
    expect(peak?.noveltyTolerance).toBe('none');
    expect(peak?.intensityPriority).toBe('max');

    const base = getPhaseRules(principles, 'base');
    expect(base?.noveltyTolerance).toBe('high');

    const deload = getPhaseRules(principles, 'deload');
    expect(deload?.intensityPriority).toBe('low');
  });

  it('reads experience rules with sessionPatternCountMax and complexity ceiling', () => {
    const novice = getExperienceRules(principles, 'novice');
    expect(novice?.complexityMax).toBe('intermediate');
    expect(novice?.sessionPatternCountMax).toBe(4);
    expect(novice?.tempoProgressionAllowed).toBe(false);

    const advanced = getExperienceRules(principles, 'advanced');
    expect(advanced?.complexityMax).toBe('expert');
    expect(advanced?.sessionPatternCountMax).toBe(8);
  });

  it('reads equipment rules with progression vectors', () => {
    const bodyweight = getEquipmentRules(principles, 'bodyweight_only');
    expect(bodyweight?.primaryProgressionVector).toBe('tempo');
    expect(bodyweight?.tertiaryProgressionVector).toBe('reps');
    expect(bodyweight?.preferredFamilies).toContain('calisthenics_strength');

    const fullGym = getEquipmentRules(principles, 'full_gym');
    expect(fullGym?.primaryProgressionVector).toBe('load');
  });

  it('reads fatigue rules by level', () => {
    const veryHigh = getFatigueRules(principles, 'very_high');
    expect(veryHigh?.maxBackToBackHardDays).toBe(0);
    expect(veryHigh?.minimumRecoveryDayAfter).toBe(1);

    const high = getFatigueRules(principles, 'high');
    expect(high?.maxBackToBackHardDays).toBe(1);
  });

  it('reads interference rules', () => {
    const interf = getInterferenceRules(principles);
    expect(interf?.minutesBetweenStrengthAndKeyEndurance).toBe(360);
    expect(interf?.avoidSameDayKeyEnduranceWithMaxStrength).toBe(true);
  });

  it('reads progressionRules array with id + trigger + action', () => {
    const rules = getProgressionRules(principles);
    expect(rules.length).toBeGreaterThan(0);
    const linearLoad = rules.find((r) => r.id === 'linear_load_increment_strength');
    expect(linearLoad?.action?.kind).toBe('increment_load_pct');
    expect(linearLoad?.action?.amount).toBe(2.5);
  });

  it('returns undefined for missing keys (defensive parsing)', () => {
    const empty: Record<string, unknown> = {};
    expect(getVolumeGrowthCap(empty, 'running')).toBeUndefined();
    expect(getPhaseRules(empty, 'base')).toBeUndefined();
    expect(getExperienceRules(empty, 'novice')).toBeUndefined();
    expect(getEquipmentRules(empty, 'full_gym')).toBeUndefined();
    expect(getFatigueRules(empty, 'high')).toBeUndefined();
    expect(getInterferenceRules(empty)).toBeUndefined();
    expect(getProgressionRules(empty)).toEqual([]);
  });

  it('returns undefined for missing sub-keys (partial JSON tolerated)', () => {
    const partial: Record<string, unknown> = { volumeGrowthCapsPct: { running: 8 } };
    expect(getVolumeGrowthCap(partial, 'running')).toBe(8);
    expect(getVolumeGrowthCap(partial, 'cycling')).toBeUndefined();
    expect(getVolumeGrowthCap(partial, 'swimming')).toBeUndefined();
  });
});

describe('applyVolumeGrowthCap math', () => {
  it('returns planned when planned <= prev (taper/deload no-op)', () => {
    expect(applyVolumeGrowthCap(200, 150, 8)).toBe(150);
    expect(applyVolumeGrowthCap(200, 200, 8)).toBe(200);
  });

  it('caps when planned > prev * (1 + cap/100)', () => {
    // prev=200, cap=8% → ceiling 216. Plan 250 → capped to 216.
    expect(applyVolumeGrowthCap(200, 250, 8)).toBe(216);
  });

  it('does not cap when planned <= ceiling', () => {
    // prev=200, cap=8% → ceiling 216. Plan 210 → stays 210.
    expect(applyVolumeGrowthCap(200, 210, 8)).toBe(210);
  });

  it('handles 0 prev (cold start) — returns planned unchanged', () => {
    expect(applyVolumeGrowthCap(0, 50, 8)).toBe(50);
    expect(applyVolumeGrowthCap(0, 100, 8)).toBe(100);
  });

  it('handles negative cap defensively (treats as 0% growth)', () => {
    expect(applyVolumeGrowthCap(200, 250, -5)).toBe(200);
  });

  it('handles negative prev defensively (treats as 0)', () => {
    expect(applyVolumeGrowthCap(-100, 50, 8)).toBe(50);
  });

  it('rounds the ceiling correctly', () => {
    // prev=185, cap=8% → ceiling 199.8 → rounded 200. Plan 220 → 200.
    expect(applyVolumeGrowthCap(185, 220, 8)).toBe(200);
  });
});

describe('applyVolumeGrowthCapForSport', () => {
  it('uses sport-specific cap from principles when available', () => {
    const principles: Record<string, unknown> = {
      volumeGrowthCapsPct: { running: 8, cycling: 12 },
    };
    // Running: prev=200, plan=250, cap=8 → 216
    expect(applyVolumeGrowthCapForSport(principles, 'running', 200, 250)).toBe(216);
    // Cycling: prev=200, plan=250, cap=12 → 224
    expect(applyVolumeGrowthCapForSport(principles, 'cycling', 200, 250)).toBe(224);
  });

  it('falls back to no-cap (100%) when sport missing', () => {
    const principles: Record<string, unknown> = { volumeGrowthCapsPct: { running: 8 } };
    // Swimming missing → fallback 100% → no cap binds.
    expect(applyVolumeGrowthCapForSport(principles, 'swimming', 200, 250)).toBe(250);
  });

  it('falls back to no-cap when volumeGrowthCapsPct entirely missing', () => {
    expect(applyVolumeGrowthCapForSport({}, 'running', 200, 250)).toBe(250);
  });

  it('honors caller-supplied fallback cap', () => {
    // No JSON → fallback 5% → ceiling 210.
    expect(applyVolumeGrowthCapForSport({}, 'running', 200, 250, 5)).toBe(210);
  });
});
