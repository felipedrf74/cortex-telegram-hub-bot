import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import { strengthEngine } from '../../src/services/coach-kernel/engines/strength-engine';
import { sampleHybridAthlete, sampleMarathonAthlete } from '../../src/services/coach-kernel/seed/sample-athletes';
import type { AthleteState } from '../../src/services/coach-kernel/types';

function buildStrengthSessions(athlete: AthleteState, weekStart = '2026-05-04') {
  return strengthEngine.buildCandidateSessions({
    athlete,
    phase: athlete.currentBlock.phase,
    knowledge: loadCoachKnowledge(),
    weekStart,
  });
}

describe('coach-kernel strength engine', () => {
  it('uses explicit strength windows instead of a hardcoded thursday slot', () => {
    const sessions = buildStrengthSessions(sampleMarathonAthlete);

    expect(sessions.map((session) => session.dayOfWeek)).toEqual(['monday', 'wednesday']);
  });

  it('substitutes barbell and pull-up work when the athlete only has dumbbells', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      equipment: {
        ...sampleHybridAthlete.equipment,
        hasGym: false,
        hasBarbell: false,
        hasDumbbells: true,
      },
      goals: {
        ...sampleHybridAthlete.goals,
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 1,
        },
      },
    };

    const [session] = buildStrengthSessions(athlete);
    const exerciseIds = session.exercises?.map((exercise) => exercise.exerciseId) ?? [];

    expect(exerciseIds).toContain('goblet_squat');
    expect(exerciseIds).toContain('one_arm_dumbbell_row');
    expect(exerciseIds).toContain('dumbbell_bench_press');
    expect(exerciseIds).not.toContain('front_squat');
    expect(exerciseIds).not.toContain('pull_up');
    expect(exerciseIds).not.toContain('bench_press');
    expect(session.exercises?.some((exercise) => (exercise.notes ?? '').includes('Adjusted from'))).toBe(true);
  });

  it('uses hypertrophy-specific prescriptions when hypertrophy is the strength goal', () => {
    const [session] = buildStrengthSessions(sampleHybridAthlete);
    const mainLift = session.exercises?.find((exercise) => exercise.exerciseId === 'front_squat');

    expect(session.sessionType).toBe('strength_hypertrophy');
    expect(session.tags).toContain('hypertrophy');
    expect(session.exercises?.length).toBeGreaterThanOrEqual(5);
    expect(mainLift).toMatchObject({
      sets: 3,
      reps: '6-10',
      rir: 1,
      restSec: 90,
    });
  });

  it('rotates four weekly strength sessions instead of cloning the same generic lift', () => {
    const sessions = buildStrengthSessions(sampleHybridAthlete);
    const titles = sessions.map((session) => session.title);
    const exerciseFingerprints = sessions.map((session) =>
      (session.exercises ?? []).map((exercise) => exercise.exerciseId).join('|')
    );

    expect(sessions).toHaveLength(4);
    expect(new Set(titles).size).toBe(4);
    expect(new Set(exerciseFingerprints).size).toBe(4);
    expect(sessions.every((session) => (session.exercises?.length ?? 0) >= 5)).toBe(true);
  });

  it('scales prescriptions by strength experience level', () => {
    // Slice 2.A (coach-engine refactor 2026-04-27) — novices now also get
    // exercise-level differentiation, not just sets/reps tuning. The
    // beginner-safe substitution layer swaps front_squat → goblet_squat
    // (same squat pattern, lower technique cost). Advanced lifters keep
    // front_squat. Both branches still apply experience-aware sets/reps.
    const novice = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
    })[0];
    const advanced = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'advanced',
      },
    })[0];

    const noviceSquat = novice.exercises?.find((exercise) => exercise.exerciseId === 'goblet_squat');
    const advancedSquat = advanced.exercises?.find((exercise) => exercise.exerciseId === 'front_squat');

    // Novice gets goblet squat (safer pattern teaching tool) with the
    // gentler hypertrophy prescription.
    expect(noviceSquat).toMatchObject({ sets: 3, reps: '8-12', rir: 2 });
    // Advanced keeps the front squat with the heavier prescription.
    expect(advancedSquat).toMatchObject({ sets: 4, reps: '6-10', rir: 1 });
    // Sanity: novices should NOT receive front_squat anywhere in the session.
    expect(novice.exercises?.find((ex) => ex.exerciseId === 'front_squat')).toBeUndefined();
    // Advanced should NOT receive the beginner replacement.
    expect(advanced.exercises?.find((ex) => ex.exerciseId === 'goblet_squat')).toBeUndefined();
  });

  it('routes novice lifters to beginner-safe substitutions across the variant catalog', () => {
    // Direct contract test for the beginner substitution layer. Pinning
    // each pattern's swap so a future regression (e.g. accidentally
    // serving advanced exercises to a novice) trips this test instead
    // of leaking into production plans.
    const novice = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
    })[0];

    const noviceIds = (novice.exercises ?? []).map((ex) => ex.exerciseId);

    // squat pattern: goblet_squat instead of front_squat
    expect(noviceIds).toContain('goblet_squat');
    expect(noviceIds).not.toContain('front_squat');

    // The session must also be tagged so downstream renderers can flag
    // beginner-safe sessions in the iOS UI.
    expect(novice.tags).toContain('beginner_safe');
  });

  it('keeps intermediate lifters on the standard variant (no beginner substitutions)', () => {
    const intermediate = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'intermediate',
      },
    })[0];

    const ids = (intermediate.exercises ?? []).map((ex) => ex.exerciseId);
    // Intermediate keeps the original variant exercises (front_squat is
    // the canonical squat in the hypertrophy lower-body variant).
    expect(ids).toContain('front_squat');
    expect(intermediate.tags).not.toContain('beginner_safe');
  });

  it('trims duration to the real strength window instead of overflowing the day', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      availability: {
        ...sampleHybridAthlete.availability,
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '12:00', end: '12:35', sports: ['strength'] },
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

    const [session] = buildStrengthSessions(athlete);

    expect(session.dayOfWeek).toBe('monday');
    expect(session.durationMinutes).toBe(35);
  });
});
