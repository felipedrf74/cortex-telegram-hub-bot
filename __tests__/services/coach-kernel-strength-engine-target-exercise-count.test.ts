import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  strengthEngine,
  targetExerciseCount,
} from '../../src/services/coach-kernel/engines/strength-engine';
import { sampleHybridAthlete } from '../../src/services/coach-kernel/seed/sample-athletes';
import type { AthleteState } from '../../src/services/coach-kernel/types';

/**
 * Pin the duration tiers in `targetExerciseCount` introduced by
 * coach-engine slice 3.H. The function caps a strength session's
 * exercise list at a duration-appropriate count; before slice 3.H
 * it floored at 4 even for a 15-min "express" block, which produced
 * over-prescribed sessions athletes would either rush or abandon.
 *
 * The new tiers add tight-window awareness (under 30 minutes) WITHOUT
 * touching the existing 30+ minute behavior. Every "unchanged"
 * assertion below pins that scope guarantee — if a future change
 * accidentally shifts a 30+ minute case, the regression surfaces as a
 * boundary test failure here, not as a quietly-different plan in
 * production.
 */
describe('coach-kernel strength engine — targetExerciseCount tiers (slice 3.H)', () => {
  // MARK: - New low-end tiers

  it('returns 2 for a 15-min express block regardless of experience', () => {
    expect(targetExerciseCount(15, 'novice')).toBe(2);
    expect(targetExerciseCount(15, 'intermediate')).toBe(2);
    expect(targetExerciseCount(15, 'advanced')).toBe(2);
  });

  it('returns 2 for a 20-min block', () => {
    expect(targetExerciseCount(20, 'novice')).toBe(2);
    expect(targetExerciseCount(20, 'advanced')).toBe(2);
  });

  it('returns 2 at the boundary just below 25 (24 min)', () => {
    expect(targetExerciseCount(24, 'novice')).toBe(2);
  });

  it('returns 3 at exactly 25 min (lower edge of express tier)', () => {
    // Boundary semantics: `duration < 25 → 2`, so 25 is in the next
    // tier. Pin both edges so a future `< 26` typo is caught.
    expect(targetExerciseCount(25, 'novice')).toBe(3);
    expect(targetExerciseCount(25, 'advanced')).toBe(3);
  });

  it('returns 3 mid-range at 27 min', () => {
    expect(targetExerciseCount(27, 'intermediate')).toBe(3);
  });

  it('returns 3 at the upper edge just below 30 (29 min)', () => {
    expect(targetExerciseCount(29, 'novice')).toBe(3);
  });

  // MARK: - Existing tiers preserved (regression guards)

  it('returns 4 at exactly 30 min — boundary of the unchanged tier', () => {
    // Slice 3.H scope guarantee: 30 min behavior was NOT touched.
    // If this returns 3, the new tier accidentally absorbed the
    // existing range; if it returns 5, the upper boundary leaked
    // downward.
    expect(targetExerciseCount(30, 'novice')).toBe(4);
    expect(targetExerciseCount(30, 'intermediate')).toBe(4);
    expect(targetExerciseCount(30, 'advanced')).toBe(4);
  });

  it('returns 4 at 35 min (the existing test fixture window)', () => {
    // The existing strength-engine test "trims duration to the
    // real strength window" pins a 35-min session; slice 3.H must
    // keep that intact or the integration test downstream breaks.
    expect(targetExerciseCount(35, 'intermediate')).toBe(4);
  });

  it('returns 4 at 39 min (just below the 40-min tier)', () => {
    expect(targetExerciseCount(39, 'advanced')).toBe(4);
  });

  it('returns 5 at exactly 40 min', () => {
    expect(targetExerciseCount(40, 'novice')).toBe(5);
    expect(targetExerciseCount(40, 'advanced')).toBe(5);
  });

  it('returns 5 at 54 min (just below the 55-min experience-aware tier)', () => {
    expect(targetExerciseCount(54, 'advanced')).toBe(5);
  });

  it('returns experience-aware count at exactly 55 min', () => {
    // `>= 55` is the gate; pin both branches.
    expect(targetExerciseCount(55, 'novice')).toBe(5);
    expect(targetExerciseCount(55, 'intermediate')).toBe(5);
    expect(targetExerciseCount(55, 'advanced')).toBe(6);
  });

  it('returns experience-aware count at 90 min (sample athlete window)', () => {
    // Sample athletes have 90-min strength windows. Pin so the
    // upper-end tiering decisions stay explicit; if a future slice
    // expands beyond 6 for advanced, this test fails first.
    expect(targetExerciseCount(90, 'novice')).toBe(5);
    expect(targetExerciseCount(90, 'intermediate')).toBe(5);
    expect(targetExerciseCount(90, 'advanced')).toBe(6);
  });
});

describe('coach-kernel strength engine — integration with tight strength windows', () => {
  /**
   * End-to-end check: the planner respects the new tier when a
   * tight window forces a short session. Before slice 3.H, a
   * 20-min strength window would still produce 4 exercises;
   * after, it produces 2.
   */
  it('produces a 2-exercise prescription when the strength window is only 20 min', () => {
    const athlete = makeAthleteWithStrengthWindow('06:30', '06:50');
    const [session] = strengthEngine.buildCandidateSessions({
      athlete,
      phase: athlete.currentBlock.phase,
      knowledge: loadCoachKnowledge(),
      weekStart: '2026-05-04',
    });

    expect(session.durationMinutes).toBe(20);
    expect(session.exercises?.length ?? 0).toBe(2);
  });

  /**
   * End-to-end check: a 25-min window produces a 3-exercise
   * prescription. The boundary case where the new low-end tiering
   * matters most for real users with a tight pre-work block.
   */
  it('produces a 3-exercise prescription when the strength window is exactly 25 min', () => {
    const athlete = makeAthleteWithStrengthWindow('06:30', '06:55');
    const [session] = strengthEngine.buildCandidateSessions({
      athlete,
      phase: athlete.currentBlock.phase,
      knowledge: loadCoachKnowledge(),
      weekStart: '2026-05-04',
    });

    expect(session.durationMinutes).toBe(25);
    expect(session.exercises?.length ?? 0).toBe(3);
  });
});

/**
 * Build a minimal hybrid athlete with a single strength-only
 * window on Monday between `start` and `end`. Mirrors the existing
 * "trims duration to the real strength window" test fixture so the
 * new boundary tests stay close to the integration shape Codex's
 * adaptation/scheduler tests already exercise.
 */
function makeAthleteWithStrengthWindow(start: string, end: string): AthleteState {
  return {
    ...sampleHybridAthlete,
    availability: {
      ...sampleHybridAthlete.availability,
      weeklyWindows: [
        { dayOfWeek: 'monday', start, end, sports: ['strength'] },
      ],
    },
    goals: {
      ...sampleHybridAthlete.goals,
      weeklySessionsTarget: {
        ...sampleHybridAthlete.goals.weeklySessionsTarget,
        strength: 1,
      },
    },
  };
}
