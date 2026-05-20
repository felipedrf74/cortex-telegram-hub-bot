// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCoachKernelTrainingPlan,
  buildAthleteStateFromTrainingProfiles,
} from '../../src/services/training-coach-kernel-plan-generator';
import {
  lintPlan,
  type PlanLintSession,
} from '../../src/services/coach-kernel/plan-linter';
import {
  _resetCoachPlanStoreForTests,
  getWeeklyPlanCoveringDate,
  getWeeklyPlanForWeek,
} from '../../src/services/coach-plan-registry';

describe('buildCoachKernelTrainingPlan — side effects', () => {
  beforeEach(() => {
    _resetCoachPlanStoreForTests();
  });

  it('records one WeeklyPlan per week in the plan registry for later guardrail lookup', () => {
    // Without this side effect, the legacy `CoordinatedTrainingPlan`
    // return value has no `guardrailResults` field, meaning the home-view
    // `kernelAdjustments` contract would always be empty in production.
    // This test pins the registry write so that regression can't happen
    // silently.
    const plan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Run a marathon under 3:30',
      durationWeeks: 3,
      startDate: '2026-04-13', // Monday
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Sunday',
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    expect(plan.weeks).toHaveLength(3);

    // Each week-start must now be retrievable from the registry.
    const weekOne = getWeeklyPlanForWeek(99, '2026-04-13');
    const weekTwo = getWeeklyPlanForWeek(99, '2026-04-20');
    const weekThree = getWeeklyPlanForWeek(99, '2026-04-27');

    expect(weekOne).not.toBeNull();
    expect(weekTwo).not.toBeNull();
    expect(weekThree).not.toBeNull();

    // Guardrail results must be non-empty (the deterministic planner
    // always emits at least one — even a `pass` on readiness).
    expect(weekOne!.guardrailResults.length).toBeGreaterThan(0);
  });

  it('uses the neutral yellow fallback when currentReadiness is absent', () => {
    // Backward-compat pin: existing callers that don't know about the
    // new currentReadiness field MUST still get a sensible AthleteState
    // (yellow / score 70) rather than a crash or a zero score.
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 501,
      objective: '10k base',
      durationWeeks: 4,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    expect(athlete.readiness.level).toBe('yellow');
    expect(athlete.readiness.score).toBe(70);
    expect(athlete.readiness.confidence).toBe('no_data');
    expect(athlete.readiness.dataSource).toBe('fallback');
    expect(athlete.readiness.reasonCode).toBe('NO_READINESS_INPUT');
    expect(athlete.readiness.hrvStatus).toBeUndefined();
  });

  it('classifies English muscle-building objectives as strength focus', () => {
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 505,
      objective: 'Muscle Building',
      durationWeeks: 4,
      startDate: '2026-04-26',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: { equipment_access: 'Full gym' },
      runProfile: null,
    });

    expect(athlete.goals.primaryFocus).toBe('strength');
    expect(athlete.goals.weeklySessionsTarget).toMatchObject({ running: 3, strength: 2 });
  });

  it('builds muscle-building weeks with requested gym volume plus aerobic support', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 506,
      objective: 'Muscle Building',
      durationWeeks: 4,
      startDate: '2026-04-26',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 4,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: { equipment_access: 'Full gym' },
      runProfile: null,
    });

    expect(plan.sport).toBe('gym');
    expect(plan.weeks?.[0]?.sessions?.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
    expect(plan.weeks?.[0]?.sessions?.some((session) => session.sessionType === 'run')).toBe(true);
  });

  it('does not invent a long run for strength-dominant plans with one aerobic support slot', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 516,
      objective: 'Muscle Building',
      durationWeeks: 4,
      startDate: '2026-04-26',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      fitnessProfile: {
        experience_level: 'intermediate',
        training_goals: 'strength and hypertrophy',
        available_equipment: 'Full gym',
        session_duration_minutes: '60',
      },
      gymProfile: {
        training_age: '3 years',
        primary_goal: 'Hypertrophy',
        equipment_access: 'Full gym',
        sessions_per_week: '5',
        session_duration_minutes: '60',
      },
      runProfile: null,
      goalMode: 'continuous',
      trainingPriority: 'hybrid',
      twoADayPreference: 'preferred',
    });

    const weekOneSessions = plan.weeks?.[0]?.sessions ?? [];
    const aerobicSupport = weekOneSessions.filter((session) => session.sessionType === 'run');

    expect(plan.sport).toBe('gym');
    expect(weekOneSessions.filter((session) => session.sessionType === 'gym')).toHaveLength(5);
    expect(aerobicSupport).toHaveLength(1);
    expect(aerobicSupport[0]?.title).not.toMatch(/long run/i);
    expect(aerobicSupport[0]?.workout?.some((item) => /long run/i.test(`${item.name} ${item.details ?? ''}`)) ?? false).toBe(false);

    const lintResult = lintPlan({
      now: new Date('2026-04-22T08:00:00.000Z'),
      startDate: '2026-04-26',
      durationWeeks: 4,
      equipmentProfile: 'full_gym',
      weeks: [{
        weekNumber: 1,
        focus: plan.weeks?.[0]?.focus,
        sessions: weekOneSessions.map((session): PlanLintSession => {
          const title = session.title.toLowerCase();
          return {
            dayOfWeek: String(session.dayOfWeek || '').toLowerCase(),
            sessionType: String(session.sessionType || '').toLowerCase(),
            title: session.title,
            description: session.description,
            durationMinutes: session.durationMinutes,
            status: 'scheduled',
            isLowerHeavy: /lower|squat|deadlift|quad|posterior chain/.test(title),
            isLongRun: session.sessionType === 'long_run' || /\blong\s+run\b/i.test(session.title),
          };
        }),
      }],
    });
    expect(lintResult.blockers.map((blocker) => blocker.ruleId)).not.toContain('no_heavy_lower_before_long_run');
  });

  it('builds marathon weeks with five distinct strength sessions when explicitly requested', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 507,
      objective: 'Marathon training with full gym strength',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: 'Saturday',
      notes: 'Advanced runner and 5+ years gym. Full commercial gym. Prefer double sessions if needed.',
      fitnessProfile: {
        experience_level: 'advanced',
        weekly_frequency: '6 days',
        training_goals: 'marathon and strength',
        injuries: 'none',
        available_equipment: 'Full commercial gym',
        session_duration_minutes: '60',
      },
      gymProfile: {
        training_age: '5 years',
        primary_goal: 'Hypertrophy',
        equipment_access: 'Full commercial gym',
        sessions_per_week: '5',
        session_duration_minutes: '60',
      },
      runProfile: {
        weekly_availability_days: '6 days',
        weekly_mileage_km: '45',
        easy_pace_min_per_km: '5:20',
      },
      currentReadiness: { score: 82 },
      twoADayPreference: 'preferred',
    });

    const weekOneSessions = plan.weeks?.[0]?.sessions ?? [];
    const strengthSessions = weekOneSessions.filter((session) => session.sessionType === 'gym');
    const strengthTitles = strengthSessions.map((session) => session.title);

    expect(strengthSessions).toHaveLength(5);
    expect(new Set(strengthTitles).size).toBe(5);
    expect(weekOneSessions.some((session) => /long run/i.test(session.title))).toBe(true);
    expect(strengthSessions.every((session) => session.preferredStartTime === '12:00')).toBe(true);
  });

  it('uses app-supplied race date and priority intent in AthleteState goals', () => {
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 508,
      objective: 'Lisbon Marathon',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      fitnessProfile: { experience_level: 'advanced', available_equipment: 'Full commercial gym' },
      gymProfile: { training_age: '5 years', equipment_access: 'Full commercial gym' },
      runProfile: { weekly_mileage_km: '45' },
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });

    expect(athlete.goals.raceCalendar).toEqual([
      expect.objectContaining({
        date: '2026-10-18',
        name: 'Lisbon Marathon',
        subtype: 'marathon',
      }),
    ]);
    expect(athlete.goals.priorityOrder[0]).toBe('running');
  });

  it('marks maintenance and return-to-training goal modes in priority order', () => {
    const maintenanceAthlete = buildAthleteStateFromTrainingProfiles({
      userId: 509,
      objective: 'General Fitness',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym' },
      gymProfile: { equipment_access: 'Full gym' },
      runProfile: null,
      goalMode: 'maintenance',
      trainingPriority: 'strength',
    });

    expect(maintenanceAthlete.goals.strengthGoal).toBe('maintenance');
    expect(maintenanceAthlete.goals.priorityOrder[0]).toBe('maintenance');
    expect(maintenanceAthlete.goals.priorityOrder[1]).toBe('strength');

    const returnAthlete = buildAthleteStateFromTrainingProfiles({
      userId: 510,
      objective: 'Running consistency',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Bodyweight' },
      gymProfile: null,
      runProfile: { weekly_mileage_km: '15' },
      goalMode: 'return_to_training',
      trainingPriority: 'running',
    });

    expect(returnAthlete.goals.priorityOrder[0]).toBe('return');
    expect(returnAthlete.goals.priorityOrder[1]).toBe('running');
  });

  it('seeds AthleteState.readiness from currentReadiness when provided', () => {
    // This is the core fix for QW#2. When the route supplies real
    // wearable readiness data the planner must consume it so guardrails
    // like "cap volume on low HRV" fire with actual measurements.
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 502,
      objective: '10k base',
      durationWeeks: 4,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: {
        score: 48,
        sleepHours: 5.5,
        hrvStatus: 'low',
        energyReserve: 32,
        reasoning: 'Low HRV + poor sleep — reduce volume.',
      },
    });

    expect(athlete.readiness.score).toBe(48);
    expect(athlete.readiness.level).toBe('orange');
    expect(athlete.readiness.hrvStatus).toBe('low');
    expect(athlete.readiness.sleepHours).toBe(5.5);
    expect(athlete.readiness.energyReserve).toBe(32);
    expect(athlete.readiness.confidence).toBe('fresh_wearable');
    expect(athlete.readiness.dataSource).toBe('wearable');
    expect(athlete.readiness.isStale).toBe(false);
    // The reasoning line flows through as a planner note so downstream
    // briefings can surface "why" without re-deriving from factors.
    expect(athlete.readiness.notes?.some((note) => note.includes('Low HRV'))).toBe(true);
  });

  it('surfaces stale readiness confidence instead of pretending data is fresh', () => {
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 503,
      objective: '10k base',
      durationWeeks: 4,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: {
        score: 62,
        confidence: 'stale_provider',
        dataSource: 'wearable',
        isStale: true,
        reasonCode: 'PROVIDER_STALE',
        reasoning: 'Last wearable sync is stale.',
      },
    });

    expect(athlete.readiness.confidence).toBe('stale_provider');
    expect(athlete.readiness.isStale).toBe(true);
    expect(athlete.readiness.reasonCode).toBe('PROVIDER_STALE');
    expect(athlete.readiness.notes?.some((note) => note.includes('provider data is stale'))).toBe(true);
  });

  it('preserves manual check-in confidence instead of upgrading it to wearable truth', () => {
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 511,
      objective: '10k base',
      durationWeeks: 4,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: {
        score: 63,
        confidence: 'manual_check_in',
        dataSource: 'manual',
        reasonCode: 'MANUAL_CHECK_IN',
        reasoning: 'User reported tired legs after a hard work week.',
      },
    });

    expect(athlete.readiness.score).toBe(63);
    expect(athlete.readiness.confidence).toBe('manual_check_in');
    expect(athlete.readiness.dataSource).toBe('manual');
    expect(athlete.readiness.reasonCode).toBe('MANUAL_CHECK_IN');
    expect(athlete.readiness.notes?.some((note) => note.includes('tired legs'))).toBe(true);
  });

  it('maps score bands onto ReadinessLevel deterministically', () => {
    // Pin the exact thresholds that drive downstream guardrails so
    // changing the mapping requires updating the test intentionally.
    const make = (score: number) => buildAthleteStateFromTrainingProfiles({
      userId: 503,
      objective: '10k base',
      durationWeeks: 1,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 0,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: { score },
    });

    expect(make(85).readiness.level).toBe('green');
    expect(make(75).readiness.level).toBe('yellow');
    expect(make(55).readiness.level).toBe('orange');
    expect(make(30).readiness.level).toBe('red');
  });

  it('clamps out-of-range scores and ignores non-finite inputs gracefully', () => {
    const absurd = buildAthleteStateFromTrainingProfiles({
      userId: 504,
      objective: '10k base',
      durationWeeks: 1,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 0,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: null,
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
      currentReadiness: { score: 120 }, // impossible — clamp
    });

    expect(absurd.readiness.score).toBe(100);
    expect(absurd.readiness.level).toBe('green');
  });

  it('exposes mid-week date lookups through the registry after plan generation', () => {
    // This is the precise path `buildTrainingHomePayload` uses at
    // request time: "give me the plan that covers today" — so we
    // validate that the registry + date-scanning returns a plan when
    // today lands inside a generated week.
    buildCoachKernelTrainingPlan({
      userId: 101,
      objective: 'Half marathon base',
      durationWeeks: 2,
      startDate: '2026-04-13', // Monday
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:30',
      longWorkoutDay: 'Saturday',
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    // Wednesday of week 1 — should resolve to the Monday 2026-04-13 plan.
    const midWeek = getWeeklyPlanCoveringDate(101, '2026-04-15');
    expect(midWeek?.weekStart).toBe('2026-04-13');

    // Wednesday of week 2 — should resolve to 2026-04-20.
    const midWeek2 = getWeeklyPlanCoveringDate(101, '2026-04-22');
    expect(midWeek2?.weekStart).toBe('2026-04-20');
  });

  it('uses rolling base/build/deload phases without fake tapering when no event date exists', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 601,
      objective: 'General running base',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: 'Saturday',
      notes: null,
      fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Dumbbells' },
      gymProfile: { equipment_access: 'Dumbbells' },
      runProfile: { weekly_mileage_km: '30' },
      goalMode: 'continuous',
    });

    expect(plan.weeks?.map((week) => week.focus)).toEqual(['base', 'base', 'build', 'deload']);
    expect(plan.weeks?.map((week) => week.focus)).not.toContain('taper');
    expect(plan.decisionReasons?.map((reason) => reason.code)).toContain('continuous_plan_no_taper');
  });

  it('derives base/build/peak/taper/race phases from a real event date', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 602,
      objective: 'Lisbon Marathon',
      durationWeeks: 16,
      startDate: '2026-05-04',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: 'Sunday',
      notes: null,
      fitnessProfile: { experience_level: 'advanced', available_equipment: 'Full gym' },
      gymProfile: { equipment_access: 'Full gym' },
      runProfile: { weekly_mileage_km: '45' },
      goalMode: 'event_based',
      raceDate: '2026-08-23',
    });

    const phases = plan.weeks?.map((week) => week.focus) ?? [];
    expect(phases[0]).toBe('base');
    expect(phases).toContain('build');
    expect(phases).toContain('peak');
    expect(phases).toContain('taper');
    expect(phases[15]).toBe('race');
    expect(plan.decisionReasons?.map((reason) => reason.code)).not.toContain('event_based_missing_race_date');
  });
});
