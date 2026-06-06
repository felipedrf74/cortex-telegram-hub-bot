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
    expect(exerciseIds.some((id) => id.startsWith('dumbbell_') || id === 'goblet_squat' || id === 'side_plank')).toBe(true);
  });

  it('uses hypertrophy-specific prescriptions when hypertrophy is the strength goal', () => {
    // Slice 4.C — multi-week rotation shifts the day→variant
    // mapping by `currentBlock.weekIndex`. With the 2026-05-23
    // slot-modulo fix (variants.length instead of targetSessions),
    // the 6-variant hypertrophy pool reaches all 6 variants across a
    // 6-week macro-rotation. front_squat lives in variant 0 (Quad
    // Bias); for a 4-session week it surfaces at weekIndex ∈ {0,3,4,5}
    // and is unreachable at weekIndex ∈ {1,2}. Pin weekIndex=0 here so
    // this test asserts the prescription shape on a week where the
    // Quad Bias variant fires. Macro-rotation coverage (all 6 variants
    // reachable across the cycle) is pinned by a separate test below.
    const sessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex: 0 },
    });
    const sessionWithFrontSquat = sessions.find((session) =>
      session.exercises?.some((ex) => ex.exerciseId === 'front_squat'),
    );
    expect(sessionWithFrontSquat).toBeDefined();
    const mainLift = sessionWithFrontSquat!.exercises?.find((ex) => ex.exerciseId === 'front_squat');

    expect(sessionWithFrontSquat!.sessionType).toBe('strength_hypertrophy');
    expect(sessionWithFrontSquat!.tags).toContain('hypertrophy');
    expect(sessionWithFrontSquat!.exercises?.length).toBeGreaterThanOrEqual(5);
    expect(mainLift).toMatchObject({
      reps: '6-12',
      rir: 1,
      restSec: 105,
    });
    expect(mainLift!.sets).toBeGreaterThanOrEqual(3);
    expect(mainLift!.sets).toBeLessThanOrEqual(5);
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

  it('honors an advanced marathon athlete requesting five strength sessions outside peak/taper', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      profile: {
        ...sampleMarathonAthlete.profile,
        experienceLevel: 'advanced',
      },
      goals: {
        ...sampleMarathonAthlete.goals,
        strengthGoal: 'hypertrophy',
        raceCalendar: [],
        weeklySessionsTarget: {
          ...sampleMarathonAthlete.goals.weeklySessionsTarget,
          strength: 5,
        },
      },
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'base',
        weekIndex: 1,
      },
    };

    const sessions = buildStrengthSessions(athlete, '2026-05-04');
    const titles = sessions.map((session) => session.title);
    const strengthDays = sessions.map((session) => session.dayOfWeek);

    expect(sessions).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
    expect(new Set(strengthDays).size).toBe(5);
    expect(sessions.every((session) => session.sessionType === 'strength_hypertrophy')).toBe(true);
    expect(sessions.every((session) => !session.tags.includes('beginner_safe'))).toBe(true);
  });

  it('keeps marathon strength at maintenance dose when race day is close', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      goals: {
        ...sampleMarathonAthlete.goals,
        raceCalendar: [{ id: 'near-race', name: 'Near Marathon', discipline: 'running', subtype: 'marathon', date: '2026-06-01', priority: 'a' }],
        weeklySessionsTarget: {
          ...sampleMarathonAthlete.goals.weeklySessionsTarget,
          strength: 5,
        },
      },
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'build',
        weekIndex: 1,
      },
    };

    const sessions = buildStrengthSessions(athlete, '2026-05-04');

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.sessionType === 'strength_maintenance')).toBe(true);
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
    // Pin weekIndex=0 so the rotation lands on variant 0 (Quad Bias)
    // which contains the front_squat → goblet_squat substitution path
    // both branches of this test inspect. See the "uses hypertrophy-
    // specific prescriptions" test above for the rotation explanation.
    const noviceSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
      currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex: 0 },
    });
    const advancedSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'advanced',
      },
      currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex: 0 },
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
    expect(advancedSquat).toMatchObject({ sets: 5, reps: '6-12', rir: 1 });
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
    // Pin weekIndex=0 so the rotation lands on variant 0 (Quad Bias)
    // which is where the front_squat → goblet_squat beginner-safe
    // substitution is observable. See the rotation explanation in
    // the "uses hypertrophy-specific prescriptions" test above.
    const noviceSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'novice',
      },
      currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex: 0 },
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
    // Pin weekIndex=0 so the rotation lands on variant 0 (Quad Bias)
    // where the canonical front_squat lift surfaces for intermediates.
    // See the rotation explanation in the "uses hypertrophy-specific
    // prescriptions" test above.
    const intermediateSessions = buildStrengthSessions({
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        experienceLevel: 'intermediate',
      },
      currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex: 0 },
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

  // ── Hybrid profile + per-profile 3/2-session variants (2026-05-23) ──
  //
  // Layer-3 goal→split mapping audit closeout. Added a fifth StrengthProfile
  // ('hybrid') routed from `Goals.strengthGoal === 'hybrid'`, and made the
  // 3-session and 2-session variant tables profile-specific (previously
  // they shared exerciseIds across all profiles). These tests pin the
  // wiring + variant title contracts that the audit asked for.

  it('routes Goals.strengthGoal=hybrid to the Full Body Hybrid variant family at 4-session weeks', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        strengthGoal: 'hybrid',
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 4,
        },
      },
    };

    const sessions = buildStrengthSessions(athlete);

    expect(sessions.length).toBeGreaterThan(0);
    // All hybrid 4-session titles start with "Full Body Hybrid - ".
    for (const session of sessions) {
      expect(session.title).toMatch(/^Full Body Hybrid -/);
      expect(session.tags).toContain('hybrid');
    }
  });

  it('routes Goals.strengthGoal=hybrid to a Full×3 hybrid variant family at 3-session weeks', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        strengthGoal: 'hybrid',
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 3,
        },
      },
    };

    const sessions = buildStrengthSessions(athlete);

    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      // 3-session hybrid titles also start with "Full Body Hybrid - ".
      expect(session.title).toMatch(/^Full Body Hybrid -/);
      expect(session.tags).toContain('hybrid');
    }
  });

  it('routes Goals.strengthGoal=hybrid to Full×2 hybrid variants at 2-session weeks', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        strengthGoal: 'hybrid',
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 2,
        },
      },
    };

    const sessions = buildStrengthSessions(athlete);

    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.title).toMatch(/^Full Body Hybrid -/);
      expect(session.tags).toContain('hybrid');
    }
  });

  it('hypertrophy 3-session weeks now yield hypertrophy-specific titles (was shared variants)', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        strengthGoal: 'hypertrophy',
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 3,
        },
      },
    };

    const sessions = buildStrengthSessions(athlete);

    expect(sessions.length).toBeGreaterThan(0);
    // Hypertrophy 3-session titles all carry 'Hypertrophy' as the
    // variant family — distinct from the shared 3-session catalog
    // that existed before the 2026-05-23 refactor.
    for (const session of sessions) {
      expect(session.title).toMatch(/Hypertrophy/);
    }
  });

  it('max_strength 2-session weeks now yield strength-specific titles (was shared variants)', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        strengthGoal: 'max_strength',
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          strength: 2,
        },
      },
    };

    const sessions = buildStrengthSessions(athlete);

    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.title).toMatch(/^Full Body Strength -/);
    }
  });

  // ── 2026-05-23 codex follow-up: macro-rotation slot-modulo fix ──
  //
  // Before the fix, `strengthVariantFor` computed the slot as
  // `(index + weekShift) % targetSessions`. For a 4-session week the
  // modulo was always 4, so the 5th and 6th variants in any pool larger
  // than 4 were unreachable. The fix changed the modulo to use
  // `variants.length` so all variants in each pool surface across a
  // multi-week macro-rotation cycle. These tests pin the new contract.

  it('hybrid 4-session macro-rotation reaches all 6 variant titles across weekIndex 0..5', () => {
    const seenTitles = new Set<string>();
    for (let weekIndex = 0; weekIndex < 8; weekIndex++) {
      const athlete: AthleteState = {
        ...sampleHybridAthlete,
        goals: {
          ...sampleHybridAthlete.goals,
          strengthGoal: 'hybrid',
          weeklySessionsTarget: {
            ...sampleHybridAthlete.goals.weeklySessionsTarget,
            strength: 4,
          },
        },
        currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex },
      };
      for (const session of buildStrengthSessions(athlete)) {
        seenTitles.add(session.title);
      }
    }
    expect(seenTitles.size).toBe(6);
    expect(seenTitles).toContain('Full Body Hybrid - Durability');
    expect(seenTitles).toContain('Full Body Hybrid - Pulling Emphasis');
    expect(seenTitles).toContain('Full Body Hybrid - Single-Leg Power');
    expect(seenTitles).toContain('Full Body Hybrid - Posterior Chain');
    expect(seenTitles).toContain('Full Body Hybrid - Athletic Trunk');
    expect(seenTitles).toContain('Full Body Hybrid - Recovery Volume');
  });

  it('hypertrophy 4-session macro-rotation reaches all 6 pool variants across weekIndex 0..5', () => {
    const seenTitles = new Set<string>();
    for (let weekIndex = 0; weekIndex < 8; weekIndex++) {
      const athlete: AthleteState = {
        ...sampleHybridAthlete,
        goals: {
          ...sampleHybridAthlete.goals,
          strengthGoal: 'hypertrophy',
          weeklySessionsTarget: {
            ...sampleHybridAthlete.goals.weeklySessionsTarget,
            strength: 4,
          },
        },
        currentBlock: { ...sampleHybridAthlete.currentBlock, weekIndex },
      };
      for (const session of buildStrengthSessions(athlete)) {
        seenTitles.add(session.title);
      }
    }
    // Existing hypertrophy 4-session pool has 6 variants; pre-2026-05-23
    // the slot modulo was `targetSessions=4` which left variants 4 and 5
    // (Upper Delts/Arms, Lower Glutes/Calves) unreachable at runtime.
    expect(seenTitles.size).toBe(6);
    expect(seenTitles).toContain('Lower Hypertrophy - Quad Bias');
    expect(seenTitles).toContain('Upper Hypertrophy - Push/Pull');
    expect(seenTitles).toContain('Lower Hypertrophy - Posterior Chain');
    expect(seenTitles).toContain('Upper Hypertrophy - Pull/Trunk');
    expect(seenTitles).toContain('Upper Hypertrophy - Delts/Arms');
    expect(seenTitles).toContain('Lower Hypertrophy - Glutes/Calves');
  });
});
