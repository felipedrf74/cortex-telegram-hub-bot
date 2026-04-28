import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  loadCoachKnowledge,
  trainingEvalPersonaBank,
  type AthleteState,
  type Session,
} from '../../src/services/coach-kernel';

function personaAthlete(id: string): AthleteState {
  const persona = trainingEvalPersonaBank.find((item) => item.id === id);
  if (!persona) throw new Error(`Missing eval persona ${id}`);
  return JSON.parse(JSON.stringify(persona.athlete)) as AthleteState;
}

function keySessionTitle(planSessions: Session[], tag: string): string {
  const session = planSessions.find((item) => item.tags.includes(tag));
  if (!session) throw new Error(`Missing session with tag ${tag}`);
  return session.title;
}

describe('coach-kernel catalog depth upgrade', () => {
  it('loads richer strength, running, and cycling archetypes from source knowledge', () => {
    const knowledge = loadCoachKnowledge();
    const templateIds = new Set(knowledge.workoutTemplates.map((template) => template.id));
    const exerciseIds = new Set(knowledge.exercises.map((exercise) => exercise.id));

    expect([...templateIds]).toEqual(expect.arrayContaining([
      'strength_hypertrophy',
      'run_walk_beginner',
      'run_tempo_progression',
      'run_fartlek_controlled',
      'run_hill_repeats',
      'run_strides_aerobic',
      'run_hybrid_flush',
      'run_travel_treadmill_easy',
      'ride_endurance_short',
      'ride_hybrid_flush',
      'ride_tempo_sweet_spot',
      'ride_vo2_over_under',
      'ride_cadence_technique',
      'ride_travel_hotel_spin',
    ]));
    expect([...exerciseIds]).toEqual(expect.arrayContaining([
      'bodyweight_squat',
      'leg_press',
      'cable_pull_through',
      'machine_chest_press',
      'seated_cable_row',
      'band_row',
      'pallof_press',
      'dumbbell_overhead_press',
      'dumbbell_floor_press',
      'dumbbell_reverse_lunge',
      'glute_bridge',
      'side_plank',
      'kettlebell_swing',
      'inverted_row',
    ]));
  });

  it('keeps catalog metadata complete enough for deterministic selection', () => {
    const knowledge = loadCoachKnowledge();
    const exerciseIds = new Set(knowledge.exercises.map((exercise) => exercise.id));

    for (const exercise of knowledge.exercises) {
      expect(exercise.complexity, `${exercise.id} complexity`).toBeTruthy();
      expect(exercise.spinalLoading, `${exercise.id} spinalLoading`).toBeTruthy();
      expect(typeof exercise.unilateral, `${exercise.id} unilateral`).toBe('boolean');
      expect(exercise.primaryPurpose, `${exercise.id} primaryPurpose`).toBeTruthy();
      expect(Array.isArray(exercise.warmupNeeds), `${exercise.id} warmupNeeds`).toBe(true);
      for (const substitutionId of exercise.substitutions) {
        expect(exerciseIds.has(substitutionId), `${exercise.id} substitution ${substitutionId}`).toBe(true);
        expect(substitutionId, `${exercise.id} should not substitute to itself`).not.toBe(exercise.id);
      }
    }

    for (const template of knowledge.workoutTemplates.filter((item) => ['running', 'cycling', 'strength'].includes(item.sport))) {
      expect(template.sessionRole, `${template.id} sessionRole`).toBeTruthy();
      expect(template.experienceFit?.length, `${template.id} experienceFit`).toBeGreaterThan(0);
      expect(template.equipmentProfile?.length, `${template.id} equipmentProfile`).toBeGreaterThan(0);
      expect(template.variantTags?.length, `${template.id} variantTags`).toBeGreaterThan(0);
      expect(template.timeRangeMinutes?.min, `${template.id} timeRangeMinutes.min`).toBeGreaterThan(0);
      expect(template.timeRangeMinutes?.max, `${template.id} timeRangeMinutes.max`).toBeGreaterThanOrEqual(
        template.timeRangeMinutes?.min ?? 0,
      );
      expect(template.progressionTarget, `${template.id} progressionTarget`).toBeTruthy();
      expect(template.substitutionFamily, `${template.id} substitutionFamily`).toBeTruthy();
    }
  });

  it('generates a four-day hypertrophy plan with distinct upper/lower session roles', () => {
    const athlete = personaAthlete('intermediate-hypertrophy-full-gym');
    const plan = buildWeekPlan(athlete, '2026-04-27');
    const strength = plan.sessions.filter((session) => session.sport === 'strength');

    expect(strength).toHaveLength(4);
    expect(new Set(strength.map((session) => session.title)).size).toBe(4);
    expect(strength.some((session) => session.tags.includes('upper_body'))).toBe(true);
    expect(strength.some((session) => session.tags.includes('lower_body'))).toBe(true);
    expect(strength.every((session) => (session.exercises ?? []).length >= 4)).toBe(true);
    expect(strength.every((session) => session.sessionType === 'strength_hypertrophy')).toBe(true);
  });

  it('uses limited-equipment strength variants instead of barbell or machine-first prescriptions', () => {
    const athlete = personaAthlete('equipment-limited-home');
    const plan = buildWeekPlan(athlete, '2026-04-27');
    const strength = plan.sessions.filter((session) => session.sport === 'strength');
    const exerciseIds = strength.flatMap((session) => session.exercises?.map((exercise) => exercise.exerciseId) ?? []);

    expect(strength.length).toBeGreaterThanOrEqual(2);
    expect(strength.every((session) => session.tags.includes('limited_equipment'))).toBe(true);
    expect(exerciseIds).not.toEqual(expect.arrayContaining([
      'front_squat',
      'bench_press',
      'leg_press',
      'machine_chest_press',
      'seated_cable_row',
    ]));
    expect(exerciseIds).toEqual(expect.arrayContaining(['bodyweight_squat', 'band_row']));
  });

  it('uses beginner run-walk support when running profile is novice', () => {
    const base = personaAthlete('runner-half-marathon');
    const athlete: AthleteState = {
      ...base,
      profile: {
        ...base.profile,
        experienceLevel: 'novice',
      },
      goals: {
        ...base.goals,
        raceCalendar: [],
      },
      currentBlock: {
        ...base.currentBlock,
        phase: 'base',
      },
    };
    const plan = buildWeekPlan(athlete, '2026-04-27');

    expect(plan.sessions.some((session) => session.sourceTemplateId === 'run_walk_beginner')).toBe(true);
    expect(plan.sessions.some((session) => session.sourceTemplateId === 'run_fartlek_controlled')).toBe(true);
  });

  it('rotates running key archetypes across build weeks without randomization', () => {
    const base = personaAthlete('runner-half-marathon');
    const titles = [1, 2, 3].map((weekIndex) => {
      const athlete: AthleteState = {
        ...base,
        currentBlock: {
          ...base.currentBlock,
          phase: 'build',
          weekIndex,
        },
      };
      const plan = buildWeekPlan(athlete, '2026-04-27');
      return keySessionTitle(plan.sessions, 'key_run');
    });

    expect(titles).toEqual(['Interval Run', 'Tempo Progression Run', 'Hill Repeats']);
  });

  it('rotates cycling key archetypes across build weeks without flattening every ride to threshold', () => {
    const base = personaAthlete('cyclist-ftp-build');
    const titles = [1, 2, 3].map((weekIndex) => {
      const athlete: AthleteState = {
        ...base,
        currentBlock: {
          ...base.currentBlock,
          phase: 'build',
          weekIndex,
        },
      };
      const plan = buildWeekPlan(athlete, '2026-04-27');
      return keySessionTitle(plan.sessions, 'key_ride');
    });

    expect(titles).toEqual(['Threshold Ride', 'Tempo / Sweet Spot Ride', 'VO2 Over-Under Ride']);
  });

  it('honors gym + cycling hybrid intent instead of silently substituting running', () => {
    const athlete = personaAthlete('hybrid-gym-cycling');
    const plan = buildWeekPlan(athlete, '2026-04-27');
    const sports = new Set(plan.sessions.map((session) => session.sport));

    expect(sports.has('cycling')).toBe(true);
    expect(sports.has('strength')).toBe(true);
    expect(sports.has('running')).toBe(false);
    expect(plan.notes.some((note) => /Hybrid|priority|balance|endurance/i.test(note))).toBe(true);
  });

  it('uses hybrid cycling support and travel running variants when the week context calls for them', () => {
    const cyclingHybrid = personaAthlete('hybrid-gym-cycling');
    const cyclingPlan = buildWeekPlan(cyclingHybrid, '2026-04-27');
    expect(cyclingPlan.sessions.some((session) => session.sourceTemplateId === 'ride_hybrid_flush')).toBe(true);

    const travel = personaAthlete('travel-week-hotel-gym');
    const travelPlan = buildWeekPlan(travel, '2026-04-27');
    expect(travelPlan.sessions.some((session) => session.sourceTemplateId === 'run_travel_treadmill_easy')).toBe(true);
    expect(travelPlan.sessions.some((session) => session.tags.includes('limited_equipment'))).toBe(true);
  });
});
