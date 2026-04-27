import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel';
import {
  repairUnderfilledStrengthSession,
  strengthEngine,
} from '../../src/services/coach-kernel/engines/strength-engine';
import {
  estimateStrengthSessionMinutes,
  validateSessionCoherence,
} from '../../src/services/coach-kernel/session-coherence';
import { sampleHybridAthlete, sampleMarathonAthlete } from '../../src/services/coach-kernel/seed/sample-athletes';
import type { AthleteState, Session } from '../../src/services/coach-kernel/types';

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
    // Slice 4.C — multi-week rotation shifts the day→variant
    // mapping by `currentBlock.weekIndex - 1`. sampleHybridAthlete
    // is at weekIndex=2 so slot 0 lands on Upper-Body-A, not
    // Lower-Body-A. Look across ALL sessions for the front_squat
    // lift rather than pinning it to a specific slot — the
    // semantic intent is "advanced lifters with hypertrophy goal
    // receive front_squat with hypertrophy prescription somewhere
    // in the week", not "at session 0".
    const sessions = buildStrengthSessions(sampleHybridAthlete);
    const sessionWithFrontSquat = sessions.find((session) =>
      session.exercises?.some((ex) => ex.exerciseId === 'front_squat'),
    );
    expect(sessionWithFrontSquat).toBeDefined();
    const mainLift = sessionWithFrontSquat!.exercises?.find((ex) => ex.exerciseId === 'front_squat');

    expect(sessionWithFrontSquat!.sessionType).toBe('strength_hypertrophy');
    expect(sessionWithFrontSquat!.tags).toContain('hypertrophy');
    expect(sessionWithFrontSquat!.exercises?.length).toBeGreaterThanOrEqual(5);
    expect(mainLift).toMatchObject({
      reps: '6-10',
      rir: 1,
      restSec: 90,
    });
    expect(mainLift!.sets).toBeGreaterThanOrEqual(3);
    expect(mainLift!.sets).toBeLessThanOrEqual(4);
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
    //
    // Slice 4.C — search ACROSS all sessions for the squat-pattern
    // lift; multi-week rotation can land it on any of the slots.
    const noviceSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
    });
    const advancedSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'advanced',
      },
    });

    const noviceSquat = noviceSessions
      .flatMap((s) => s.exercises ?? [])
      .find((ex) => ex.exerciseId === 'goblet_squat');
    const advancedSquat = advancedSessions
      .flatMap((s) => s.exercises ?? [])
      .find((ex) => ex.exerciseId === 'front_squat');

    // Novice gets goblet squat (safer pattern teaching tool) with the
    // gentler hypertrophy prescription.
    expect(noviceSquat).toMatchObject({ sets: 3, reps: '8-12', rir: 2 });
    // Advanced keeps the front squat with the heavier prescription.
    expect(advancedSquat).toMatchObject({ sets: 4, reps: '6-10', rir: 1 });
    // Sanity: novices should NOT receive front_squat anywhere in any session.
    expect(noviceSessions.flatMap((s) => s.exercises ?? []).find((ex) => ex.exerciseId === 'front_squat')).toBeUndefined();
    // Note: advanced lifters DO receive goblet_squat as the canonical
    // Lower-Body-B squat (it's not a beginner substitution there;
    // both novice and advanced share the Lower-B variant which uses
    // goblet_squat). The beginner-safe layer only swaps Lower-Body-A's
    // front_squat → goblet_squat, which is verified by the noviceSquat
    // assertion above and the front_squat sanity check.
  });

  it('routes novice lifters to beginner-safe substitutions across the variant catalog', () => {
    // Direct contract test for the beginner substitution layer. Pinning
    // each pattern's swap so a future regression (e.g. accidentally
    // serving advanced exercises to a novice) trips this test instead
    // of leaking into production plans.
    //
    // Slice 4.C — multi-week rotation means slot 0 is no longer
    // guaranteed to be Lower-Body-A. Look across all sessions of
    // the week instead.
    const noviceSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
    });

    const noviceIds = noviceSessions.flatMap((s) => (s.exercises ?? []).map((ex) => ex.exerciseId));

    // squat pattern: goblet_squat instead of front_squat — must
    // appear somewhere in the week.
    expect(noviceIds).toContain('goblet_squat');
    expect(noviceIds).not.toContain('front_squat');

    // Every session in a novice's week must carry the
    // beginner_safe tag — downstream renderers use this to flag
    // beginner-safe sessions in the iOS UI.
    for (const session of noviceSessions) {
      expect(session.tags).toContain('beginner_safe');
    }
  });

  it('keeps intermediate lifters on the standard variant (no beginner substitutions)', () => {
    // Slice 4.C — search across the week's sessions; rotation can
    // land front_squat on any slot.
    const intermediateSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'intermediate',
      },
    });

    const ids = intermediateSessions.flatMap((s) => (s.exercises ?? []).map((ex) => ex.exerciseId));
    // Intermediate keeps the original variant exercises (front_squat is
    // the canonical squat in the hypertrophy lower-body variant).
    expect(ids).toContain('front_squat');
    // No session should carry the beginner_safe tag for intermediates.
    for (const session of intermediateSessions) {
      expect(session.tags).not.toContain('beginner_safe');
    }
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

  it('rebuilds a sparse high-duration strength session instead of only shrinking the label', () => {
    const knowledge = loadCoachKnowledge();
    const template = knowledge.workoutTemplates.find((item) => item.sessionType === 'strength_hypertrophy');
    expect(template).toBeDefined();
    const sparseSession: Session = {
      id: 'sparse-strength',
      sport: 'strength',
      sessionType: 'strength_hypertrophy',
      title: 'Lower Body Strength A',
      description: 'Sparse regression case.',
      dayOfWeek: 'monday',
      durationMinutes: 48,
      intensityZone: 'aerobic',
      fatigueCost: 'medium',
      keySession: false,
      plannedLoad: 100,
      sourceTemplateId: 'strength_hypertrophy',
      tags: ['lower_body', 'hypertrophy'],
      exercises: [
        { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 2, reps: '10-15', restSec: 60 },
      ],
      alternatives: [],
    };

    const repaired = repairUnderfilledStrengthSession(
      sparseSession,
      template!,
      {
        athlete: sampleHybridAthlete,
        phase: sampleHybridAthlete.currentBlock.phase,
        knowledge,
        weekStart: '2026-05-04',
      },
    );
    const estimated = estimateStrengthSessionMinutes(repaired, knowledge);
    const verdict = validateSessionCoherence(repaired, knowledge);

    expect(repaired.exercises?.length).toBeGreaterThanOrEqual(4);
    expect(repaired.tags).toContain('coherence_rebuilt');
    expect(repaired.durationMinutes).toBe(48);
    expect(estimated).toBeGreaterThanOrEqual(38);
    expect(verdict.ok).toBe(true);
    expect(new Set((repaired.exercises ?? []).map((exercise) => exercise.exerciseId)).size).toBe(repaired.exercises?.length);
  });
});
