// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCoachKernelTrainingPlan,
  buildAthleteStateFromTrainingProfiles,
  normalizeTrainingPlanDurationWeeks,
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

  const dayOffsets: Record<string, number> = {
    monday: 0,
    tuesday: 1,
    wednesday: 2,
    thursday: 3,
    friday: 4,
    saturday: 5,
    sunday: 6,
  };

  function scheduledDateFor(startDate: string, weekNumber: number, dayOfWeek: string): string {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const offset = dayOffsets[dayOfWeek.trim().toLowerCase()] ?? 0;
    start.setUTCDate(start.getUTCDate() + ((weekNumber - 1) * 7) + offset);
    return start.toISOString();
  }

  function lintWeekSessions(args: {
    startDate: string;
    durationWeeks: number;
    weekNumber: number;
    focus?: string;
    hasPoolAccess?: boolean | null;
    sessions: NonNullable<ReturnType<typeof buildCoachKernelTrainingPlan>['weeks']>[number]['sessions'];
  }) {
    return lintPlan({
      now: new Date('2026-07-01T08:00:00.000Z'),
      startDate: args.startDate,
      durationWeeks: args.durationWeeks,
      equipmentProfile: 'full_gym',
      hasPoolAccess: args.hasPoolAccess,
      weeks: [{
        weekNumber: args.weekNumber,
        focus: args.focus,
        sessions: (args.sessions ?? []).map((session): PlanLintSession => {
          const text = `${session.title} ${session.description ?? ''}`.toLowerCase();
          return {
            dayOfWeek: String(session.dayOfWeek || '').toLowerCase(),
            sessionType: String(session.sessionType || '').toLowerCase(),
            title: session.title,
            description: session.description,
            durationMinutes: session.durationMinutes,
            status: 'scheduled',
            scheduledDate: scheduledDateFor(args.startDate, args.weekNumber, String(session.dayOfWeek || 'monday')),
            exerciseTokens: (session.exercises ?? [])
              .map((exercise) => `${exercise.exerciseId ?? ''} ${exercise.name ?? ''}`.trim())
              .filter(Boolean),
            isLowerHeavy: /lower|squat|deadlift|quad|posterior chain|lunge/.test(text),
            isLongRun: session.sessionType === 'run' && /\blong\s+run\b/i.test(session.title),
          };
        }),
      }],
    });
  }

  it('normalizes invalid durationWeeks defensively before allocating weeks', () => {
    expect(normalizeTrainingPlanDurationWeeks(-3)).toBe(4);
    expect(normalizeTrainingPlanDurationWeeks(0)).toBe(4);
    expect(normalizeTrainingPlanDurationWeeks(4.6)).toBe(5);
    expect(normalizeTrainingPlanDurationWeeks(999)).toBe(52);

    const plan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Run base',
      durationWeeks: -3,
      startDate: '2026-04-13',
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 1,
      preferredTime: '06:30',
      preferredCardioTime: '06:30',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Sunday',
      notes: null,
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    expect(plan.weeks).toHaveLength(4);
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
    expect(athlete.goals.weeklySessionsTarget).toMatchObject({ running: 2, strength: 2 });
  });

  it('caps unspecified-experience muscle-building weeks while keeping aerobic support', () => {
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
    expect(plan.weeks?.[0]?.sessions?.filter((session) => session.sessionType === 'gym')).toHaveLength(3);
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

  it('uses explicit triathlon modality targets when bike and swim counts are supplied', () => {
    const athlete = buildAthleteStateFromTrainingProfiles({
      userId: 518,
      objective: 'Olympic triathlon build',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 7,
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      fitnessProfile: { experience_level: 'advanced' },
      gymProfile: null,
      runProfile: null,
      goalMode: 'event_based',
      trainingPriority: 'triathlon',
    });

    expect(athlete.goals.primaryFocus).toBe('triathlon');
    expect(athlete.goals.weeklySessionsTarget).toMatchObject({
      running: 4,
      cycling: 3,
      swimming: 2,
      strength: 2,
    });
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
    const makeWith = (score: number) => buildAthleteStateFromTrainingProfiles({
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
      currentReadiness: { score },
    });

    // Out-of-range positive — clamp to 100.
    expect(makeWith(120).readiness.score).toBe(100);
    expect(makeWith(120).readiness.level).toBe('green');

    // Out-of-range negative — clamp to 0.
    expect(makeWith(-25).readiness.score).toBe(0);
    expect(makeWith(-25).readiness.level).toBe('red');

    // Non-finite — fall back to neutral 70 / yellow.
    // PR 2 §B2 acceptance: lock the generator-input-level behavior so the
    // adapter dedupe stays safe even if a future refactor adds another
    // caller that skips the clamp step.
    expect(makeWith(Number.NaN).readiness.score).toBe(70);
    expect(makeWith(Number.NaN).readiness.level).toBe('yellow');
    expect(makeWith(Number.POSITIVE_INFINITY).readiness.score).toBe(70);
    expect(makeWith(Number.POSITIVE_INFINITY).readiness.level).toBe('yellow');
    expect(makeWith(Number.NEGATIVE_INFINITY).readiness.score).toBe(70);
    expect(makeWith(Number.NEGATIVE_INFINITY).readiness.level).toBe('yellow');
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

  it('uses rolling base/build phases with scheduled deloads but no fake tapering when no event date exists', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 601,
      objective: 'General running base',
      durationWeeks: 8,
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

    expect(plan.weeks?.map((week) => week.focus)).toEqual(['base', 'base', 'build', 'deload', 'build', 'build', 'build', 'deload']);
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
    expect(phases).not.toContain('deload');
    expect(phases[15]).toBe('race');
    expect(plan.decisionReasons?.map((reason) => reason.code)).not.toContain('event_based_missing_race_date');
  });

  it('creates coherent app-facing plans for every supported training discipline', () => {
    const startDate = '2026-07-06'; // Monday
    const supportedPlanCases = [
      {
        label: 'running',
        objective: '10k running base',
        expectedPrimaryFocus: 'running',
        expectedPlanSport: 'running',
        expectedSessionTypes: ['run'],
        durationWeeks: 1,
        sessionsPerWeek: 4,
        strengthSessionsPerWeek: 1,
        fitnessProfile: { experience_level: 'beginner', available_equipment: 'Full gym' },
        gymProfile: { equipment_access: 'Full gym' },
        runProfile: { weekly_mileage_km: '12', weekly_availability_days: '4' },
      },
      {
        label: 'marathon',
        objective: 'Lisbon Marathon',
        expectedPrimaryFocus: 'marathon',
        expectedPlanSport: 'running',
        expectedSessionTypes: ['run'],
        durationWeeks: 16,
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
        goalMode: 'event_based',
        raceDate: '2026-10-25',
        fitnessProfile: { experience_level: 'advanced', available_equipment: 'Full gym' },
        gymProfile: { equipment_access: 'Full gym', training_age: '5 years' },
        runProfile: { weekly_mileage_km: '45', weekly_availability_days: '6' },
      },
      {
        label: 'cycling',
        objective: 'Cycling FTP build',
        expectedPrimaryFocus: 'cycling',
        expectedPlanSport: 'cycling',
        expectedSessionTypes: ['ride'],
        durationWeeks: 4,
        sessionsPerWeek: 4,
        strengthSessionsPerWeek: 1,
        fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym' },
        gymProfile: { equipment_access: 'Full gym' },
        runProfile: { ftp_watts: '250', weekly_hours: '4' },
      },
      {
        label: 'swimming',
        objective: 'Swimming technique build',
        expectedPrimaryFocus: 'swimming',
        expectedPlanSport: 'swimming',
        expectedSessionTypes: ['swim'],
        durationWeeks: 4,
        sessionsPerWeek: 3,
        strengthSessionsPerWeek: 1,
        fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym', swim_css_seconds_per_100m: '105' },
        gymProfile: { equipment_access: 'Full gym' },
        runProfile: null,
      },
      {
        label: 'strength',
        objective: 'Hypertrophy strength plan',
        expectedPrimaryFocus: 'strength',
        expectedPlanSport: 'gym',
        expectedSessionTypes: ['gym'],
        durationWeeks: 12,
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 4,
        fitnessProfile: { experience_level: 'advanced', available_equipment: 'Full gym' },
        gymProfile: { equipment_access: 'Full gym', training_age: '5 years', primary_goal: 'Hypertrophy' },
        runProfile: null,
      },
      {
        label: 'triathlon',
        objective: 'Olympic triathlon build',
        expectedPrimaryFocus: 'triathlon',
        expectedPlanSport: 'hybrid',
        expectedSessionTypes: ['run', 'ride', 'swim'],
        durationWeeks: 8,
        sessionsPerWeek: 7,
        runSessionsPerWeek: 3,
        bikeSessionsPerWeek: 2,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 1,
        goalMode: 'continuous',
        trainingPriority: 'triathlon',
        fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym', swim_css_seconds_per_100m: '110' },
        gymProfile: { equipment_access: 'Full gym' },
        runProfile: { weekly_mileage_km: '25', weekly_availability_days: '5' },
      },
      {
        label: 'hybrid',
        objective: 'General fitness build',
        expectedPrimaryFocus: 'hybrid',
        expectedPlanSport: 'hybrid',
        expectedSessionTypes: ['run', 'gym'],
        durationWeeks: 4,
        sessionsPerWeek: 5,
        runSessionsPerWeek: 3,
        strengthSessionsPerWeek: 2,
        goalMode: 'maintenance',
        trainingPriority: 'hybrid',
        fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym' },
        gymProfile: { equipment_access: 'Full gym', primary_goal: 'Athletic' },
        runProfile: { weekly_mileage_km: '20', weekly_availability_days: '4' },
      },
    ] as const;

    expect(supportedPlanCases.map((planCase) => planCase.expectedPrimaryFocus)).toEqual([
      'running',
      'marathon',
      'cycling',
      'swimming',
      'strength',
      'triathlon',
      'hybrid',
    ]);

    for (const planCase of supportedPlanCases) {
      const athlete = buildAthleteStateFromTrainingProfiles({
        userId: 700,
        objective: planCase.objective,
        durationWeeks: planCase.durationWeeks,
        startDate,
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: 'runSessionsPerWeek' in planCase ? planCase.runSessionsPerWeek : null,
        bikeSessionsPerWeek: 'bikeSessionsPerWeek' in planCase ? planCase.bikeSessionsPerWeek : null,
        swimSessionsPerWeek: 'swimSessionsPerWeek' in planCase ? planCase.swimSessionsPerWeek : null,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
        longWorkoutDay: 'Sunday',
        notes: null,
        fitnessProfile: planCase.fitnessProfile,
        gymProfile: planCase.gymProfile,
        runProfile: planCase.runProfile,
        goalMode: 'goalMode' in planCase ? planCase.goalMode : null,
        trainingPriority: 'trainingPriority' in planCase ? planCase.trainingPriority : null,
        raceDate: 'raceDate' in planCase ? planCase.raceDate : null,
      });
      expect(athlete.goals.primaryFocus, planCase.label).toBe(planCase.expectedPrimaryFocus);

      const plan = buildCoachKernelTrainingPlan({
        userId: 700,
        objective: planCase.objective,
        durationWeeks: planCase.durationWeeks,
        startDate,
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: 'runSessionsPerWeek' in planCase ? planCase.runSessionsPerWeek : null,
        bikeSessionsPerWeek: 'bikeSessionsPerWeek' in planCase ? planCase.bikeSessionsPerWeek : null,
        swimSessionsPerWeek: 'swimSessionsPerWeek' in planCase ? planCase.swimSessionsPerWeek : null,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
        longWorkoutDay: 'Sunday',
        notes: null,
        fitnessProfile: planCase.fitnessProfile,
        gymProfile: planCase.gymProfile,
        runProfile: planCase.runProfile,
        goalMode: 'goalMode' in planCase ? planCase.goalMode : null,
        trainingPriority: 'trainingPriority' in planCase ? planCase.trainingPriority : null,
        raceDate: 'raceDate' in planCase ? planCase.raceDate : null,
        currentReadiness: { score: 82, confidence: 'manual_check_in', dataSource: 'manual' },
      });

      expect(plan.sport, planCase.label).toBe(planCase.expectedPlanSport);
      expect(plan.weeks, planCase.label).toHaveLength(planCase.durationWeeks);
      expect(plan.profileQuality, planCase.label).toBeTruthy();

      const sessions = (plan.weeks ?? []).flatMap((week) => week.sessions ?? []);
      expect(sessions.length, planCase.label).toBeGreaterThan(0);
      for (const expectedType of planCase.expectedSessionTypes) {
        expect(sessions.some((session) => session.sessionType === expectedType), planCase.label).toBe(true);
      }

      for (const [weekIndex, week] of (plan.weeks ?? []).entries()) {
        expect(week.focus, `${planCase.label} week ${weekIndex + 1}`).toMatch(/^(base|build|peak|taper|race|deload|maintenance)$/);
        const weekSessions = week.sessions ?? [];
        expect(weekSessions.length, `${planCase.label} week ${weekIndex + 1}`).toBeGreaterThan(0);
        const sessionKeys = new Set<string>();
        for (const session of weekSessions) {
          expect(session.dayOfWeek, `${planCase.label} ${session.title}`).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
          expect(session.sessionType, `${planCase.label} ${session.title}`).toMatch(/^(run|ride|swim|gym|rest)$/);
          expect(session.title.trim().length, planCase.label).toBeGreaterThan(3);
          expect((session.description ?? '').trim().length, `${planCase.label} ${session.title}`).toBeGreaterThan(12);
          expect(session.durationMinutes, `${planCase.label} ${session.title}`).toBeGreaterThan(0);
          expect(session.durationMinutes, `${planCase.label} ${session.title}`).toBeLessThanOrEqual(240);
          if (session.sessionType === 'gym') {
            expect(session.exercises?.length ?? 0, `${planCase.label} ${session.title}`).toBeGreaterThan(0);
          }
          const key = `${session.dayOfWeek}|${session.sessionType}|${session.title}`;
          expect(sessionKeys.has(key), `${planCase.label} duplicate ${key}`).toBe(false);
          sessionKeys.add(key);
        }
      }

      const lintResult = lintWeekSessions({
        startDate,
        durationWeeks: planCase.durationWeeks,
        weekNumber: 1,
        focus: plan.weeks?.[0]?.focus,
        sessions: plan.weeks?.[0]?.sessions,
        hasPoolAccess: planCase.expectedSessionTypes.includes('swim') ? true : undefined,
      });
      expect(lintResult.blockers, planCase.label).toEqual([]);
    }
  });
});
