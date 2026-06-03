import { describe, expect, it } from 'vitest';

import {
  readinessResultToSnapshot,
  scoreToReadinessLevel,
} from '../../src/services/coach-kernel/readiness-snapshot-adapter';

describe('coach-kernel/readiness-snapshot-adapter', () => {
  describe('scoreToReadinessLevel', () => {
    it('maps 80+ to green', () => {
      expect(scoreToReadinessLevel(80, false)).toBe('green');
      expect(scoreToReadinessLevel(95, false)).toBe('green');
    });

    it('maps 60-79 to yellow', () => {
      expect(scoreToReadinessLevel(60, false)).toBe('yellow');
      expect(scoreToReadinessLevel(79, false)).toBe('yellow');
    });

    it('maps 40-59 to orange', () => {
      expect(scoreToReadinessLevel(40, false)).toBe('orange');
      expect(scoreToReadinessLevel(59, false)).toBe('orange');
    });

    it('maps below 40 to red', () => {
      expect(scoreToReadinessLevel(0, false)).toBe('red');
      expect(scoreToReadinessLevel(39, false)).toBe('red');
    });

    it('caps green at orange when high-severity injury present', () => {
      expect(scoreToReadinessLevel(95, true)).toBe('orange');
      expect(scoreToReadinessLevel(80, true)).toBe('orange');
    });

    it('caps yellow-range scores at orange when high-severity injury present', () => {
      expect(scoreToReadinessLevel(65, true)).toBe('orange');
      expect(scoreToReadinessLevel(60, true)).toBe('orange');
    });

    it('does not lift the floor — red still red even with injury', () => {
      // High-injury caps at orange but does not RAISE a low score. A user
      // with an injury AND poor wearable signals should still see red so
      // the planner's deload-on-red branch fires.
      expect(scoreToReadinessLevel(35, true)).toBe('red');
    });

    it('falls back to neutral yellow on non-finite scores', () => {
      expect(scoreToReadinessLevel(NaN, false)).toBe('yellow');
      expect(scoreToReadinessLevel(Infinity, false)).toBe('yellow');
    });
  });

  describe('readinessResultToSnapshot', () => {
    const fixedNow = '2026-04-27T12:00:00.000Z';

    it('returns a neutral yellow snapshot when score is missing', () => {
      // Mirrors the no-wearable-connected branch in calculateReadiness:
      // the planner sees "conservative default" instead of green.
      const snap = readinessResultToSnapshot({ capturedAt: fixedNow });

      expect(snap.level).toBe('yellow');
      expect(snap.score).toBe(70);
      expect(snap.painFlags).toEqual([]);
      expect(snap.capturedAt).toBe(fixedNow);
    });

    it('rounds and clamps the score, then maps to a level', () => {
      const snap = readinessResultToSnapshot({
        score: 81.7,
        capturedAt: fixedNow,
      });

      expect(snap.score).toBe(82);
      expect(snap.level).toBe('green');
    });

    it('caps at orange when a high-severity injury is present', () => {
      const snap = readinessResultToSnapshot({
        score: 90,
        hasHighSeverityInjury: true,
        capturedAt: fixedNow,
      });

      expect(snap.level).toBe('orange');
      expect(snap.score).toBe(90); // raw score preserved for telemetry
      expect(snap.notes).toContain('Injury-aware progression enabled.');
    });

    it('forwards optional wearable signals as-is', () => {
      const snap = readinessResultToSnapshot({
        score: 65,
        sleepHours: 5.4,
        hrvStatus: 'low',
        energyReserve: 38,
        capturedAt: fixedNow,
      });

      expect(snap.sleepHours).toBe(5.4);
      expect(snap.hrvStatus).toBe('low');
      expect(snap.energyReserve).toBe(38);
    });

    it('attaches the reasoning string as a prefixed note', () => {
      const snap = readinessResultToSnapshot({
        score: 55,
        reasoning: 'Poor sleep (5.4h); HRV below baseline.',
        capturedAt: fixedNow,
      });

      expect(snap.notes).toBeDefined();
      expect(snap.notes!).toContainEqual(
        expect.stringContaining('Readiness: Poor sleep (5.4h); HRV below baseline.'),
      );
    });

    it('appends extraNotes after the readiness note and ignores blanks', () => {
      const snap = readinessResultToSnapshot({
        score: 70,
        reasoning: 'Metrics neutral.',
        extraNotes: ['Marathon block — base phase.', '   ', null, undefined, 'Carb-up Friday.'],
        capturedAt: fixedNow,
      });

      const notes = snap.notes ?? [];
      expect(notes).toContain('Readiness: Metrics neutral.');
      expect(notes).toContain('Marathon block — base phase.');
      expect(notes).toContain('Carb-up Friday.');
      // Trim-only blanks must NOT appear, but the current adapter only
      // filters by length. The test pins the contract: callers can rely on
      // empty/whitespace not surfacing as a visible bullet.
      expect(notes.find((n) => n.trim().length === 0)).toBeUndefined();
    });

    it('forwards painFlags from the caller (injury constraints)', () => {
      const snap = readinessResultToSnapshot({
        score: 60,
        painFlags: [{ area: 'left_knee', severity: 'moderate', impact: ['running'] }],
        capturedAt: fixedNow,
      });

      expect(snap.painFlags).toHaveLength(1);
      expect(snap.painFlags[0].area).toBe('left_knee');
    });
  });
});
