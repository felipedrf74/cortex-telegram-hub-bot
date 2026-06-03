/**
 * Slice B7 — day-level taper engine tests.
 *
 * Pins:
 *   - Outside taper window → multiplier 1.0
 *   - Race day → multiplier ≈ (1 - volumeDropPct/100)
 *   - Quadratic curve: middle of taper ≈ 75% volume reduction toward end
 *   - A-priority taper window is 14 days
 *   - B-priority is 7 days
 *   - C-priority is 3 days
 *   - Intensity preserved at 100% throughout
 *   - Strength cutoff fires at the right day for each priority
 *   - Missed taper sessions are dropped (never crammed)
 *   - Missed sessions outside taper are not auto-dropped
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import { decideTaper, shouldDropMissedTaperSession } from '../../src/services/coach-kernel/taper';

const knowledge = loadCoachKnowledge();
const principles = knowledge.principles;

describe('decideTaper — window boundaries', () => {
  it('outside taper window: multiplier 1.0', () => {
    const d = decideTaper({ daysToRace: 30, priority: 'A' }, principles);
    expect(d.inTaperWindow).toBe(false);
    expect(d.volumeMultiplier).toBe(1.0);
  });

  it('A-priority: 14-day window', () => {
    expect(decideTaper({ daysToRace: 14, priority: 'A' }, principles).inTaperWindow).toBe(true);
    expect(decideTaper({ daysToRace: 15, priority: 'A' }, principles).inTaperWindow).toBe(false);
  });

  it('B-priority: 7-day window', () => {
    expect(decideTaper({ daysToRace: 7, priority: 'B' }, principles).inTaperWindow).toBe(true);
    expect(decideTaper({ daysToRace: 8, priority: 'B' }, principles).inTaperWindow).toBe(false);
  });

  it('C-priority: 3-day window', () => {
    expect(decideTaper({ daysToRace: 3, priority: 'C' }, principles).inTaperWindow).toBe(true);
    expect(decideTaper({ daysToRace: 4, priority: 'C' }, principles).inTaperWindow).toBe(false);
  });

  it('past race: outside window', () => {
    expect(decideTaper({ daysToRace: -1, priority: 'A' }, principles).inTaperWindow).toBe(false);
  });
});

describe('decideTaper — volume curve', () => {
  it('A-priority race day (daysToRace=0): volume drops to ~45% (1 - 55%)', () => {
    const d = decideTaper({ daysToRace: 0, priority: 'A' }, principles);
    expect(d.volumeMultiplier).toBeCloseTo(0.45, 2);
  });

  it('A-priority taper start (daysToRace=14): volume respects the JSON max-volume clamp', () => {
    const d = decideTaper({ daysToRace: 14, priority: 'A' }, principles);
    expect(d.volumeMultiplier).toBeCloseTo(0.6, 2);
  });

  it('A-priority mid-taper (daysToRace=7): quadratic gives ~58.75%', () => {
    // (1 - 0.55) + 0.55 * (7/14)^2 = 0.45 + 0.55 * 0.25 = 0.5875
    const d = decideTaper({ daysToRace: 7, priority: 'A' }, principles);
    expect(d.volumeMultiplier).toBeCloseTo(0.5875, 2);
  });

  it('clamps taper volume to configured min and max percentages', () => {
    const maxClamped = decideTaper({ daysToRace: 3, priority: 'C' }, principles);
    const minClamped = decideTaper({
      daysToRace: 0,
      priority: 'A',
      overrideCoefficients: {
        durationDays: 14,
        volumeDropPct: 90,
        intensityPreservedPct: 100,
        strengthCutoffDaysBeforeRace: 7,
        minimumVolumePct: 40,
        maximumVolumePct: 60,
      },
    }, principles);

    expect(maxClamped.volumeMultiplier).toBe(0.6);
    expect(minClamped.volumeMultiplier).toBe(0.4);
  });

  it('intensity preserved at 100% throughout taper', () => {
    expect(decideTaper({ daysToRace: 14, priority: 'A' }, principles).intensityPreservedPct).toBe(100);
    expect(decideTaper({ daysToRace: 1, priority: 'A' }, principles).intensityPreservedPct).toBe(100);
    expect(decideTaper({ daysToRace: 0, priority: 'A' }, principles).intensityPreservedPct).toBe(100);
  });
});

describe('decideTaper — strength cutoff', () => {
  it('A-priority: cutoff active 7 days before race', () => {
    expect(decideTaper({ daysToRace: 8, priority: 'A' }, principles).strengthCutoffActive).toBe(false);
    expect(decideTaper({ daysToRace: 7, priority: 'A' }, principles).strengthCutoffActive).toBe(true);
    expect(decideTaper({ daysToRace: 1, priority: 'A' }, principles).strengthCutoffActive).toBe(true);
  });

  it('B-priority: cutoff active 3 days before race', () => {
    expect(decideTaper({ daysToRace: 4, priority: 'B' }, principles).strengthCutoffActive).toBe(false);
    expect(decideTaper({ daysToRace: 3, priority: 'B' }, principles).strengthCutoffActive).toBe(true);
  });

  it('C-priority: cutoff active 2 days before race', () => {
    expect(decideTaper({ daysToRace: 3, priority: 'C' }, principles).strengthCutoffActive).toBe(false);
    expect(decideTaper({ daysToRace: 2, priority: 'C' }, principles).strengthCutoffActive).toBe(true);
  });
});

describe('shouldDropMissedTaperSession', () => {
  it('missed session inside taper → dropped (never crammed)', () => {
    expect(shouldDropMissedTaperSession(5, 'A', principles).dropped).toBe(true);
    expect(shouldDropMissedTaperSession(2, 'B', principles).dropped).toBe(true);
  });

  it('missed session outside taper → not auto-dropped', () => {
    expect(shouldDropMissedTaperSession(30, 'A', principles).dropped).toBe(false);
    expect(shouldDropMissedTaperSession(15, 'B', principles).dropped).toBe(false);
  });
});
