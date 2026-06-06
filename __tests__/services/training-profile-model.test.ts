import { describe, expect, it } from 'vitest';

import {
  buildAthleteStateFromTrainingProfiles,
  buildCoachKernelTrainingPlan,
} from '../../src/services/training-coach-kernel-plan-generator';
import { buildWeekPlan } from '../../src/services/coach-kernel';
import type { CoachKernelTrainingPlanInput } from '../../src/services/training-coach-kernel-plan-generator';

function baseInput(overrides: Partial<CoachKernelTrainingPlanInput> = {}): CoachKernelTrainingPlanInput {
  return {
    userId: 91001,
    objective: 'Muscle Building',
    durationWeeks: 4,
    startDate: '2026-05-04',
    sessionsPerWeek: 4,
    strengthSessionsPerWeek: 3,
    preferredTime: '12:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '12:00',
    longWorkoutDay: 'Saturday',
    notes: null,
    fitnessProfile: {
      experience_level: 'Intermediate (1-3 years)',
      weekly_frequency: '4-5 days',
      training_goals: 'Hypertrophy',
      injuries: 'none',
      available_equipment: 'Full gym',
      session_duration_minutes: '60',
    },
    gymProfile: {
      training_age: '1-3 years',
      primary_goal: 'Hypertrophy',
      equipment_access: 'Full commercial gym',
      sessions_per_week: '3',
      session_duration_minutes: '60',
    },
    runProfile: null,
    currentReadiness: {
      score: 78,
      sleepHours: 7.4,
      hrvStatus: 'normal',
      energyReserve: 72,
    },
    ...overrides,
  };
}

describe('training profile model overhaul', () => {
  it('extracts a structured normalized profile with quality scores and no raw-questionnaire masquerade', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput());

    expect(athlete.normalizedTrainingProfile).toMatchObject({
      athleteId: 91001,
      goals: { primaryFocus: 'strength', strengthGoal: 'hypertrophy' },
      experience: { level: 'intermediate', source: 'provided' },
      availableSessionDurations: { genericMinutes: 60, strengthMinutes: 60 },
      equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, source: 'provided' },
      recoveryBaseline: { source: 'wearable', score: 78 },
    });
    expect(athlete.profileQuality?.completenessScore).toBeGreaterThanOrEqual(80);
    expect(athlete.profileQuality?.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(athlete.profileQuality?.missingCriticalData).toHaveLength(0);
  });

  it('uses profile differences to produce materially different strength plans', () => {
    const beginner = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91002,
      fitnessProfile: {
        experience_level: 'Beginner (< 1 year)',
        weekly_frequency: '3 days',
        training_goals: 'General fitness',
        injuries: 'none',
        available_equipment: 'Bodyweight only',
        session_duration_minutes: '30',
      },
      gymProfile: {
        training_age: '< 1 year',
        primary_goal: 'General fitness',
        equipment_access: 'Bodyweight only',
        sessions_per_week: '3',
        session_duration_minutes: '30',
      },
      currentReadiness: { score: 72 },
    }));
    const advanced = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91003,
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        weekly_frequency: '4-5 days',
        training_goals: 'Hypertrophy',
        injuries: 'none',
        available_equipment: 'Full gym',
        session_duration_minutes: '60',
      },
      gymProfile: {
        training_age: '5+ years',
        primary_goal: 'Hypertrophy',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '4',
        session_duration_minutes: '60',
      },
      strengthSessionsPerWeek: 4,
      currentReadiness: { score: 85 },
    }));

    const beginnerPlan = buildWeekPlan(beginner, '2026-05-04');
    const advancedPlan = buildWeekPlan(advanced, '2026-05-04');
    const beginnerStrength = beginnerPlan.sessions.filter((session) => session.sport === 'strength');
    const advancedStrength = advancedPlan.sessions.filter((session) => session.sport === 'strength');
    const beginnerExerciseIds = new Set(beginnerStrength.flatMap((session) => session.exercises?.map((exercise) => exercise.exerciseId) ?? []));
    const advancedExerciseIds = new Set(advancedStrength.flatMap((session) => session.exercises?.map((exercise) => exercise.exerciseId) ?? []));

    expect(beginner.availability.weeklyWindows.find((window) => window.sports?.includes('strength'))?.end).toBe('12:30');
    expect(advanced.availability.weeklyWindows.find((window) => window.sports?.includes('strength'))?.end).toBe('13:00');
    expect(beginnerStrength.every((session) => session.durationMinutes <= 35)).toBe(true);
    expect(advancedStrength.length).toBeGreaterThan(beginnerStrength.length);
    expect([...advancedExerciseIds]).not.toEqual([...beginnerExerciseIds]);
    expect([...beginnerExerciseIds].some((id) => ['push_up', 'bear_crawl', 'dead_bug', 'hollow_hold'].includes(id))).toBe(true);
    expect([...advancedExerciseIds].some((id) => ['front_squat', 'bench_press', 'pull_up', 'dumbbell_overhead_press'].includes(id))).toBe(true);
  });

  it('triggers targeted follow-up questions when critical profile data is missing', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91004,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
    }));
    const ids = athlete.profileQuality?.followUpQuestions.map((question) => question.id) ?? [];
    const criticalKeys = athlete.profileQuality?.missingCriticalData.map((item) => item.key) ?? [];

    expect(athlete.profileQuality?.completenessScore).toBeLessThan(50);
    expect(athlete.profileQuality?.confidenceBand).toBe('low');
    expect(athlete.profileQuality?.planQualityLimited).toBe(true);
    expect(athlete.profileQuality?.planningRiskFlags).toEqual(expect.arrayContaining([
      'goals:primary_goal',
      'duration:session_duration',
      'equipment:equipment',
    ]));
    expect(criticalKeys).toEqual(expect.arrayContaining([
      'primary_goal',
      'session_duration',
      'equipment',
      'injury_limitations',
      'modality_priority',
    ]));
    expect(ids).toEqual(expect.arrayContaining([
      'equipment_clarification',
      'session_duration_clarification',
      'injury_limitation_clarification',
      'modality_priority_clarification',
    ]));
    expect(athlete.profileQuality?.followUpQuestions.find((question) => question.id === 'equipment_clarification')).toMatchObject({
      planningRisk: expect.stringContaining('equipment'),
      resolvesMissingKeys: ['equipment'],
    });
  });

  it('surfaces profile follow-up needs in weekly plan notes without blocking plan generation', () => {
    const plan = buildCoachKernelTrainingPlan(baseInput({
      userId: 91005,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
    }));

    expect(plan.weeks[0].sessions.length).toBeGreaterThan(0);
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91005,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
    }));
    const weeklyPlan = buildWeekPlan(athlete, '2026-05-04');
    expect(weeklyPlan.notes.some((note) => note.startsWith('Profile follow-up:'))).toBe(true);
    expect(weeklyPlan.notes.some((note) => note.startsWith('Profile confidence:'))).toBe(true);
    expect(plan.profileQuality).toMatchObject({
      confidenceBand: 'low',
      planQualityLimited: true,
    });
  });

  it('uses conservative duration windows when profile duration is missing', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91009,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
    }));

    const maxWindowMinutes = Math.max(...athlete.availability.weeklyWindows.map((window) => {
      const [startHour, startMinute] = window.start.split(':').map(Number);
      const [endHour, endMinute] = window.end.split(':').map(Number);
      return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
    }));

    expect(athlete.profileQuality?.planQualityLimited).toBe(true);
    expect(maxWindowMinutes).toBeLessThanOrEqual(45);
  });

  it('improves confidence and materially changes the plan when follow-up answers are provided', () => {
    const weakInput = baseInput({
      userId: 91010,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
    });
    const answeredInput = baseInput({
      userId: 91010,
      objective: 'Strength hypertrophy with running support',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 3,
      notes: 'Strength is priority. Avoid nothing specific.',
      fitnessProfile: {
        experience_level: 'Intermediate (1-3 years)',
        weekly_frequency: '5 days',
        training_goals: 'Strength hypertrophy first, running support second',
        injuries: 'none',
        available_equipment: 'Full gym',
        session_duration_minutes: '60',
        preferences: 'Lunch gym sessions',
      },
      gymProfile: {
        training_age: '1-3 years',
        primary_goal: 'Hypertrophy',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '3',
        session_duration_minutes: '60',
      },
      runProfile: {
        weekly_mileage_km: '18',
        easy_pace_min_per_km: '6:15',
        weekly_availability_days: '2',
      },
      currentReadiness: { score: 78 },
    });

    const weakAthlete = buildAthleteStateFromTrainingProfiles(weakInput);
    const answeredAthlete = buildAthleteStateFromTrainingProfiles(answeredInput);
    const weakPlan = buildWeekPlan(weakAthlete, '2026-05-04');
    const answeredPlan = buildWeekPlan(answeredAthlete, '2026-05-04');

    expect(answeredAthlete.profileQuality!.confidenceScore).toBeGreaterThan(weakAthlete.profileQuality!.confidenceScore);
    expect(answeredAthlete.profileQuality!.planQualityLimited).toBe(false);
    expect(weakPlan.notes.some((note) => note.startsWith('Profile confidence:'))).toBe(true);
    expect(answeredPlan.notes.some((note) => note.startsWith('Profile confidence:'))).toBe(false);
    expect(Math.max(...answeredPlan.sessions.map((session) => session.durationMinutes))).toBeGreaterThan(
      Math.max(...weakPlan.sessions.map((session) => session.durationMinutes)),
    );
    expect(answeredPlan.sessions.map((session) => session.title)).not.toEqual(weakPlan.sessions.map((session) => session.title));
  });

  it('prompts for limitation clarification when discomfort is hinted but not explicitly answered', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91011,
      notes: 'Sometimes my knee feels sensitive after running.',
      fitnessProfile: {
        experience_level: 'Intermediate (1-3 years)',
        weekly_frequency: '4 days',
        training_goals: 'Running and gym',
        available_equipment: 'Full gym',
        session_duration_minutes: '45',
      },
      gymProfile: {
        training_age: '1-3 years',
        primary_goal: 'Athletic',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '2',
        session_duration_minutes: '45',
      },
      runProfile: null,
    }));

    expect(athlete.profileQuality?.followUpQuestions.map((question) => question.id)).toContain('injury_limitation_clarification');
  });

  it('prompts for a marathon race date instead of silently producing an undated marathon build', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91013,
      objective: 'Marathon training',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 2,
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        weekly_frequency: '6 days',
        training_goals: 'Marathon',
        injuries: 'none',
        available_equipment: 'Full gym',
        session_duration_minutes: '60',
      },
      gymProfile: {
        training_age: '5 years',
        primary_goal: 'Strength support',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '2',
        session_duration_minutes: '45',
      },
      runProfile: {
        target_race: 'Marathon',
        weekly_availability_days: '6 days',
        weekly_mileage_km: '45',
        easy_pace_min_per_km: '5:20',
      },
    }));

    const promptIds = athlete.profileQuality?.followUpQuestions.map((question) => question.id) ?? [];
    const criticalKeys = athlete.profileQuality?.missingCriticalData.map((item) => item.key) ?? [];

    expect(promptIds).toContain('race_date_clarification');
    expect(criticalKeys).toContain('race_date');
    expect(athlete.profileQuality?.planningRiskFlags).toContain('goals:race_date');
  });

  it('does not ask for race date when marathon target date is already provided', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91014,
      objective: 'Marathon training',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 2,
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        weekly_frequency: '6 days',
        training_goals: 'Marathon',
        injuries: 'none',
        available_equipment: 'Full gym',
        session_duration_minutes: '60',
      },
      gymProfile: {
        training_age: '5 years',
        primary_goal: 'Strength support',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '2',
        session_duration_minutes: '45',
      },
      runProfile: {
        target_race: 'Marathon',
        target_race_date: '2026-11-01',
        weekly_availability_days: '6 days',
        weekly_mileage_km: '45',
        easy_pace_min_per_km: '5:20',
      },
    }));

    const promptIds = athlete.profileQuality?.followUpQuestions.map((question) => question.id) ?? [];
    const criticalKeys = athlete.profileQuality?.missingCriticalData.map((item) => item.key) ?? [];

    expect(promptIds).not.toContain('race_date_clarification');
    expect(criticalKeys).not.toContain('race_date');
  });

  it('does not repeat a recently asked unresolved prompt while keeping the missing-data risk visible', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91012,
      objective: '',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: null,
      recentlyAskedFollowUpIds: ['equipment_clarification'],
    }));
    const promptIds = athlete.profileQuality?.followUpQuestions.map((question) => question.id) ?? [];

    expect(promptIds).not.toContain('equipment_clarification');
    expect(new Set(promptIds).size).toBe(promptIds.length);
    expect(athlete.profileQuality?.missingCriticalData.map((item) => item.key)).toContain('equipment');
    expect(athlete.profileQuality?.planningRiskFlags).toContain('equipment:equipment');
  });

  it('does not make sex/gender-based training assumptions without explicit relevant context', () => {
    const female = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91006,
      fitnessProfile: {
        ...baseInput().fitnessProfile,
        sex_gender: 'female',
      },
    }));
    const male = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91007,
      fitnessProfile: {
        ...baseInput().fitnessProfile,
        sex_gender: 'male',
      },
    }));

    const femalePlan = buildWeekPlan(female, '2026-05-04');
    const malePlan = buildWeekPlan(male, '2026-05-04');
    const signature = (plan: ReturnType<typeof buildWeekPlan>) => plan.sessions.map((session) => ({
      dayOfWeek: session.dayOfWeek,
      sport: session.sport,
      sessionType: session.sessionType,
      title: session.title,
      durationMinutes: session.durationMinutes,
      exercises: session.exercises?.map((exercise) => exercise.exerciseId),
    }));

    expect(female.normalizedTrainingProfile?.sexGenderContext).toMatchObject({
      value: 'female',
      planningUse: 'not_used_by_default',
    });
    expect(signature(femalePlan)).toEqual(signature(malePlan));
    expect(femalePlan.notes.join(' ')).not.toMatch(/female|male|sex|gender/i);
  });

  it('keeps explicit limitation answers from triggering unnecessary injury follow-ups', () => {
    const athlete = buildAthleteStateFromTrainingProfiles(baseInput({
      userId: 91008,
      fitnessProfile: {
        ...baseInput().fitnessProfile,
        injuries: 'none',
      },
      runProfile: {
        injury_history: 'none',
        weekly_mileage_km: '20',
        easy_pace_min_per_km: '6:00',
      },
    }));

    const ids = athlete.profileQuality?.followUpQuestions.map((question) => question.id) ?? [];
    expect(ids).not.toContain('injury_limitation_clarification');
  });
});
