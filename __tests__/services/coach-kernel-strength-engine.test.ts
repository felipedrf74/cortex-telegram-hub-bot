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
    expect(mainLift).toMatchObject({
      sets: 4,
      reps: '6-10',
      rir: 1,
    });
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
