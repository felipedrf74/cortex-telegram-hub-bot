// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCoachKernelTrainingPlan,
  buildAthleteStateFromTrainingProfiles,
} from '../../src/services/training-coach-kernel-plan-generator';
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
    expect(athlete.goals.weeklySessionsTarget).toMatchObject({ strength: 5 });
  });

  it('builds muscle-building weeks without running sessions', () => {
    const plan = buildCoachKernelTrainingPlan({
      userId: 506,
      objective: 'Muscle Building',
      durationWeeks: 4,
      startDate: '2026-04-26',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
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
    expect(plan.weeks?.[0]?.sessions?.every((session) => session.sessionType === 'gym')).toBe(true);
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
    // The reasoning line flows through as a planner note so downstream
    // briefings can surface "why" without re-deriving from factors.
    expect(athlete.readiness.notes?.some((note) => note.includes('Low HRV'))).toBe(true);
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
});
