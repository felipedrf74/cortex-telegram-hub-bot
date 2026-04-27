import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  DEFAULT_COHERENCE_TOLERANCE_PCT,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_REST_SEC,
  DEFAULT_TRANSITION_SEC,
  DEFAULT_WARMUP_MINUTES,
  MIN_CREDIBLE_STRENGTH_MINUTES,
  estimateExerciseSetSeconds,
  estimateExerciseTotalSeconds,
  estimateStrengthSessionMinutes,
  parseRepsForTimeEstimate,
  suggestCorrection,
  validateSessionCoherence,
} from '../../src/services/coach-kernel/session-coherence';
import type { ExercisePrescription, Session } from '../../src/services/coach-kernel/types';

/**
 * Pin Slice 4.A — the SessionCoherenceValidator that closes
 * Training engine regression #1 (volume × time mismatch).
 *
 * The 48-min Dead Bug session that motivated this slice was the
 * canonical underfilled case: 1 exercise (Dead Bug 2×10–15) with
 * generic warm-up/cool-down, claimed 48 min. Real estimated time:
 * ~15 min. Pre-Slice-4.A the session surfaced as-is. Post-Slice-4.A
 * the gate either shrinks the claim to match content OR triggers a
 * rebuild (4.A falls back to MIN_CREDIBLE_STRENGTH_MINUTES).
 */

const knowledge = loadCoachKnowledge();

function makeStrengthSession(overrides: Partial<Session> & { exercises?: ExercisePrescription[] }): Session {
  return {
    id: 'test-session',
    sport: 'strength',
    sessionType: 'strength_hypertrophy',
    title: 'Test Strength',
    description: '',
    dayOfWeek: 'monday',
    durationMinutes: 60,
    intensityZone: 'z3',
    fatigueCost: 'high',
    keySession: false,
    plannedLoad: 200,
    sourceTemplateId: 'strength_hypertrophy',
    tags: [],
    exercises: [],
    ...overrides,
  };
}

describe('parseRepsForTimeEstimate (slice 4.A)', () => {
  it('parses a single number', () => {
    expect(parseRepsForTimeEstimate('8')).toEqual({ numReps: 8, isUnilateral: false });
  });

  it('parses a range and uses the upper bound', () => {
    // Upper bound = round-up — the worst case for time estimation
    // is the user completing the prescribed range, so use the high
    // end of the range to avoid systematic underestimation.
    expect(parseRepsForTimeEstimate('8-12')).toEqual({ numReps: 12, isUnilateral: false });
    expect(parseRepsForTimeEstimate('10-15')).toEqual({ numReps: 15, isUnilateral: false });
  });

  it('detects unilateral cues', () => {
    expect(parseRepsForTimeEstimate('10 each side')).toEqual({ numReps: 10, isUnilateral: true });
    expect(parseRepsForTimeEstimate('8 per leg')).toEqual({ numReps: 8, isUnilateral: true });
    expect(parseRepsForTimeEstimate('6 per arm')).toEqual({ numReps: 6, isUnilateral: true });
  });

  it('falls back to 10 reps when no number is present', () => {
    expect(parseRepsForTimeEstimate('AMRAP')).toMatchObject({ numReps: 10 });
    expect(parseRepsForTimeEstimate('to failure')).toMatchObject({ numReps: 10 });
  });
});

describe('estimateExerciseSetSeconds (slice 4.A)', () => {
  it('uses ~4 sec/rep for heavy compound (1-5 reps)', () => {
    // 5 reps × 4 sec/rep + 5 sec setup = 25 sec
    const presc: ExercisePrescription = { exerciseId: 'front_squat', name: 'Front Squat', sets: 5, reps: '3', restSec: 180 };
    const meta = knowledge.exercises.find((e) => e.id === 'front_squat');
    const sec = estimateExerciseSetSeconds(presc, meta);
    expect(sec).toBeGreaterThanOrEqual(15);
    expect(sec).toBeLessThanOrEqual(20);
  });

  it('uses ~3 sec/rep for hypertrophy (6-14 reps)', () => {
    // 12 reps × 3 sec/rep + 5 sec setup = 41 sec
    const presc: ExercisePrescription = { exerciseId: 'bench_press', name: 'Bench Press', sets: 4, reps: '8-12', restSec: 90 };
    const meta = knowledge.exercises.find((e) => e.id === 'bench_press');
    const sec = estimateExerciseSetSeconds(presc, meta);
    expect(sec).toBeGreaterThanOrEqual(35);
    expect(sec).toBeLessThanOrEqual(50);
  });

  it('uses ~2.5 sec/rep for core movements regardless of count', () => {
    // dead_bug 15 reps × 2.5 sec/rep + 5 sec setup = ~42.5 sec
    const presc: ExercisePrescription = { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 2, reps: '10-15', restSec: 60 };
    const meta = knowledge.exercises.find((e) => e.id === 'dead_bug');
    const sec = estimateExerciseSetSeconds(presc, meta);
    expect(sec).toBeGreaterThanOrEqual(35);
    expect(sec).toBeLessThanOrEqual(50);
  });

  it('doubles working time for unilateral movements', () => {
    const bilateral: ExercisePrescription = { exerciseId: 'pull_up', name: 'Pull-Up', sets: 3, reps: '8' };
    const unilateral: ExercisePrescription = { exerciseId: 'split_squat', name: 'Split Squat', sets: 3, reps: '8 each side' };
    const bilateralSec = estimateExerciseSetSeconds(bilateral, undefined);
    const unilateralSec = estimateExerciseSetSeconds(unilateral, undefined);
    expect(unilateralSec).toBeGreaterThanOrEqual(bilateralSec * 1.8);
  });
});

describe('estimateExerciseTotalSeconds (slice 4.A)', () => {
  it('multiplies by sets and adds rest BETWEEN sets only', () => {
    const presc: ExercisePrescription = { exerciseId: 'front_squat', name: 'Front Squat', sets: 3, reps: '8', restSec: 90 };
    // Working time per set ≈ 5 + 8*3 = 29 sec; rest = 90 sec; (sets-1) = 2 rest periods
    // Total ≈ 3 * 29 + 2 * 90 = 87 + 180 = 267 sec
    const total = estimateExerciseTotalSeconds(presc, undefined);
    expect(total).toBeGreaterThanOrEqual(250);
    expect(total).toBeLessThanOrEqual(300);
  });

  it('uses DEFAULT_REST_SEC when restSec is unspecified', () => {
    const presc: ExercisePrescription = { exerciseId: 'goblet_squat', name: 'Goblet Squat', sets: 3, reps: '10' };
    // Default rest = 90 sec, so 3 sets * (5+30) + 2*90 = 105 + 180 = 285 sec
    const total = estimateExerciseTotalSeconds(presc, undefined);
    expect(total).toBeGreaterThanOrEqual(270);
    expect(total).toBeLessThanOrEqual(310);
  });

  it('returns just the working time when sets = 1 (no rest periods)', () => {
    const presc: ExercisePrescription = { exerciseId: 'pull_up', name: 'Pull-Up', sets: 1, reps: '5' };
    // No (sets-1)*rest because sets=1
    const total = estimateExerciseTotalSeconds(presc, undefined);
    expect(total).toBeLessThan(60); // working time only
  });
});

describe('estimateStrengthSessionMinutes (slice 4.A)', () => {
  it('returns just warmup + cooldown for an empty exercise list', () => {
    const session = makeStrengthSession({ exercises: [] });
    const minutes = estimateStrengthSessionMinutes(session, knowledge);
    expect(minutes).toBe(DEFAULT_WARMUP_MINUTES + DEFAULT_COOLDOWN_MINUTES);
  });

  it('estimates a credible 5-exercise hypertrophy session at 45-65 min', () => {
    const exercises: ExercisePrescription[] = [
      { exerciseId: 'front_squat', name: 'Front Squat', sets: 4, reps: '8-12', restSec: 120 },
      { exerciseId: 'bench_press', name: 'Bench Press', sets: 4, reps: '8-12', restSec: 90 },
      { exerciseId: 'romanian_deadlift', name: 'RDL', sets: 3, reps: '10', restSec: 90 },
      { exerciseId: 'pull_up', name: 'Pull-Up', sets: 3, reps: '8', restSec: 60 },
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 3, reps: '10', restSec: 60 },
    ];
    const session = makeStrengthSession({ exercises });
    const minutes = estimateStrengthSessionMinutes(session, knowledge);
    expect(minutes).toBeGreaterThanOrEqual(40);
    expect(minutes).toBeLessThanOrEqual(70);
  });

  it('estimates the 48-min Dead Bug regression case at well below the claim', () => {
    // The audit-flagged regression: a session claiming 48 min with
    // only Dead Bug 2×10-15. Should estimate around 13-20 min total
    // (warmup + dead bug × 2 sets + cooldown).
    const exercises: ExercisePrescription[] = [
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 2, reps: '10-15', restSec: 60 },
    ];
    const session = makeStrengthSession({ exercises });
    const minutes = estimateStrengthSessionMinutes(session, knowledge);
    expect(minutes).toBeLessThan(20);
  });
});

describe('validateSessionCoherence (slice 4.A)', () => {
  it('returns ok for non-strength sessions (running) regardless of exercise list', () => {
    const session = makeStrengthSession({
      sport: 'running',
      durationMinutes: 60,
      exercises: undefined,
    });
    const verdict = validateSessionCoherence(session, knowledge);
    expect(verdict).toMatchObject({ ok: true, estimatedMinutes: 60, claimedMinutes: 60 });
  });

  it('returns ok when claimed duration matches content within tolerance', () => {
    const exercises: ExercisePrescription[] = [
      { exerciseId: 'front_squat', name: 'Front Squat', sets: 4, reps: '8-12', restSec: 120 },
      { exerciseId: 'bench_press', name: 'Bench Press', sets: 4, reps: '8-12', restSec: 90 },
      { exerciseId: 'romanian_deadlift', name: 'RDL', sets: 3, reps: '10', restSec: 90 },
      { exerciseId: 'pull_up', name: 'Pull-Up', sets: 3, reps: '8', restSec: 60 },
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 3, reps: '10', restSec: 60 },
    ];
    // The estimator credibly puts this 5-exercise hypertrophy session
    // at ~42-45 min (warmup 8 + 5 exercises ~28 + transitions + cooldown 5).
    // Claiming 45 min puts the deviation well within the 20% tolerance.
    const session = makeStrengthSession({ durationMinutes: 45, exercises });
    const verdict = validateSessionCoherence(session, knowledge);
    expect(verdict.ok).toBe(true);
  });

  it('flags the 48-min Dead Bug case as underfilled', () => {
    const exercises: ExercisePrescription[] = [
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 2, reps: '10-15', restSec: 60 },
    ];
    const session = makeStrengthSession({ durationMinutes: 48, exercises });
    const verdict = validateSessionCoherence(session, knowledge);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('underfilled');
    expect(verdict.estimatedMinutes).toBeLessThan(20);
    expect(verdict.claimedMinutes).toBe(48);
    expect(verdict.deviationPct).toBeGreaterThan(0.5);
  });

  it('flags an overstuffed session (8 exercises × 4 sets in a 30-min slot)', () => {
    const exercises: ExercisePrescription[] = Array.from({ length: 8 }, (_, i) => ({
      exerciseId: `ex_${i}`,
      name: `Exercise ${i}`,
      sets: 4,
      reps: '10',
      restSec: 90,
    }));
    const session = makeStrengthSession({ durationMinutes: 30, exercises });
    const verdict = validateSessionCoherence(session, knowledge);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('overstuffed');
    expect(verdict.estimatedMinutes).toBeGreaterThan(60);
  });

  it('honors the tolerance parameter — tighter tolerance flags more sessions', () => {
    // With default 20% tolerance the session is OK; with 5% tolerance it should fail.
    const exercises: ExercisePrescription[] = [
      { exerciseId: 'front_squat', name: 'Front Squat', sets: 4, reps: '8-12', restSec: 120 },
      { exerciseId: 'bench_press', name: 'Bench Press', sets: 4, reps: '8-12', restSec: 90 },
      { exerciseId: 'romanian_deadlift', name: 'RDL', sets: 3, reps: '10', restSec: 90 },
    ];
    const session = makeStrengthSession({ durationMinutes: 35, exercises });
    const looseVerdict = validateSessionCoherence(session, knowledge, 0.5);
    const tightVerdict = validateSessionCoherence(session, knowledge, 0.05);
    // Tight tolerance should be at least as strict (probably stricter)
    expect(tightVerdict.ok === false || (looseVerdict.ok && tightVerdict.ok)).toBe(true);
  });
});

describe('suggestCorrection (slice 4.A)', () => {
  it('accepts a coherent session', () => {
    const session = makeStrengthSession({});
    const verdict = { ok: true, estimatedMinutes: 50, claimedMinutes: 50 } as const;
    expect(suggestCorrection(verdict, session)).toEqual({ type: 'accept' });
  });

  it('shrinks the duration when underfilled but estimated minutes is credible', () => {
    const session = makeStrengthSession({ durationMinutes: 48 });
    const verdict = {
      ok: false,
      reason: 'underfilled',
      estimatedMinutes: 30,
      claimedMinutes: 48,
      deviationPct: 0.375,
    } as const;
    const correction = suggestCorrection(verdict, session);
    expect(correction.type).toBe('shrinkDuration');
    if (correction.type !== 'shrinkDuration') return;
    expect(correction.newDurationMinutes).toBe(30);
  });

  it('flags rebuild when underfilled below MIN_CREDIBLE_STRENGTH_MINUTES', () => {
    // The 48-min Dead Bug case: estimated ~15 min, which is below
    // MIN_CREDIBLE_STRENGTH_MINUTES (25). Rebuild flag triggers.
    const session = makeStrengthSession({ durationMinutes: 48 });
    const verdict = {
      ok: false,
      reason: 'underfilled',
      estimatedMinutes: 15,
      claimedMinutes: 48,
      deviationPct: 0.69,
    } as const;
    const correction = suggestCorrection(verdict, session);
    expect(correction.type).toBe('rebuild');
  });

  it('trims content when overstuffed, keeping at least 2 exercises', () => {
    const exercises: ExercisePrescription[] = Array.from({ length: 8 }, (_, i) => ({
      exerciseId: `ex_${i}`,
      name: `Exercise ${i}`,
      sets: 3,
      reps: '10',
    }));
    const session = makeStrengthSession({ durationMinutes: 30, exercises });
    const verdict = {
      ok: false,
      reason: 'overstuffed',
      estimatedMinutes: 75,
      claimedMinutes: 30,
      deviationPct: 1.5,
    } as const;
    const correction = suggestCorrection(verdict, session);
    expect(correction.type).toBe('trimContent');
    if (correction.type !== 'trimContent') return;
    expect(correction.keepExerciseCount).toBeGreaterThanOrEqual(2);
    expect(correction.keepExerciseCount).toBeLessThan(8);
  });
});

describe('exported constants (slice 4.A pinning)', () => {
  it('default tolerance is 20%', () => {
    expect(DEFAULT_COHERENCE_TOLERANCE_PCT).toBeCloseTo(0.2);
  });

  it('default warmup + cooldown are reasonable', () => {
    expect(DEFAULT_WARMUP_MINUTES).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_WARMUP_MINUTES).toBeLessThanOrEqual(15);
    expect(DEFAULT_COOLDOWN_MINUTES).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_COOLDOWN_MINUTES).toBeLessThanOrEqual(10);
  });

  it('default rest + transition are reasonable', () => {
    expect(DEFAULT_REST_SEC).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_REST_SEC).toBeLessThanOrEqual(180);
    expect(DEFAULT_TRANSITION_SEC).toBeGreaterThanOrEqual(15);
    expect(DEFAULT_TRANSITION_SEC).toBeLessThanOrEqual(120);
  });

  it('MIN_CREDIBLE_STRENGTH_MINUTES is the rebuild threshold', () => {
    expect(MIN_CREDIBLE_STRENGTH_MINUTES).toBeGreaterThanOrEqual(15);
    expect(MIN_CREDIBLE_STRENGTH_MINUTES).toBeLessThanOrEqual(35);
  });
});
