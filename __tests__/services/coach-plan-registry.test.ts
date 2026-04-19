// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCoachPlanStoreForTests,
  getStoredPlanCoveringDate,
  getStoredPlanForWeek,
  getWeeklyPlanCoveringDate,
  getWeeklyPlanForWeek,
  recordWeeklyPlan,
} from '../../src/services/coach-plan-registry';
import { sampleMarathonAthlete } from '../../src/services/coach-kernel/seed/sample-athletes';
import type { AthleteState, WeeklyPlan } from '../../src/services/coach-kernel/types';

function makePlan(overrides: Partial<WeeklyPlan> = {}): WeeklyPlan {
  return {
    athleteId: 42,
    weekStart: '2026-04-13',
    discipline: 'marathon',
    phase: 'build',
    sessions: [],
    notes: [],
    guardrailResults: [
      { ruleId: 'readiness', status: 'warn', adjusted: true, message: 'Reduced tempo because readiness is low.' },
      { ruleId: 'volume_growth', status: 'pass', adjusted: false, message: 'Growth within band.' },
    ],
    ...overrides,
  };
}

function makeAthlete(overrides: Partial<AthleteState> = {}): AthleteState {
  return {
    ...sampleMarathonAthlete,
    profile: { ...sampleMarathonAthlete.profile, athleteId: 42 },
    ...overrides,
  };
}

describe('coach-plan-registry', () => {
  beforeEach(() => {
    _resetCoachPlanStoreForTests();
  });

  it('returns the recorded plan by exact (athleteId, weekStart) key', () => {
    const plan = makePlan();
    recordWeeklyPlan(plan, makeAthlete());

    expect(getWeeklyPlanForWeek(42, '2026-04-13')).toEqual(plan);
  });

  it('returns null when no plan is stored for the given athlete', () => {
    expect(getWeeklyPlanForWeek(42, '2026-04-13')).toBeNull();
    expect(getStoredPlanForWeek(42, '2026-04-13')).toBeNull();
  });

  it('covers a mid-week date by scanning back up to 6 days to find the week-start', () => {
    // Monday plan covers Mon-Sun. Querying Wednesday must return it.
    const plan = makePlan({ weekStart: '2026-04-13' }); // Monday
    recordWeeklyPlan(plan, makeAthlete());

    expect(getWeeklyPlanCoveringDate(42, '2026-04-15')?.athleteId).toBe(42);
    expect(getWeeklyPlanCoveringDate(42, '2026-04-19')?.weekStart).toBe('2026-04-13');
  });

  it('returns null when no plan covers the given date (cold start / restart)', () => {
    // Store a plan for a prior week, query a date > 6 days away.
    recordWeeklyPlan(makePlan({ weekStart: '2026-04-06' }), makeAthlete());

    expect(getWeeklyPlanCoveringDate(42, '2026-04-20')).toBeNull();
  });

  it('scopes lookups per athlete so two users do not collide', () => {
    recordWeeklyPlan(
      makePlan({ athleteId: 1, weekStart: '2026-04-13' }),
      makeAthlete({ profile: { ...sampleMarathonAthlete.profile, athleteId: 1 } }),
    );
    recordWeeklyPlan(
      makePlan({ athleteId: 2, weekStart: '2026-04-13', phase: 'peak' }),
      makeAthlete({ profile: { ...sampleMarathonAthlete.profile, athleteId: 2 } }),
    );

    expect(getWeeklyPlanForWeek(1, '2026-04-13')?.phase).toBe('build');
    expect(getWeeklyPlanForWeek(2, '2026-04-13')?.phase).toBe('peak');
  });

  it('overwrites a prior plan for the same (athleteId, weekStart) on re-record', () => {
    recordWeeklyPlan(makePlan(), makeAthlete());
    recordWeeklyPlan(
      makePlan({
        guardrailResults: [{ ruleId: 'readiness', status: 'pass', adjusted: false, message: 'Rested.' }],
      }),
      makeAthlete(),
    );

    const stored = getWeeklyPlanForWeek(42, '2026-04-13');
    expect(stored?.guardrailResults).toHaveLength(1);
    expect(stored?.guardrailResults[0].message).toBe('Rested.');
  });

  it('also persists the AthleteState so the home-view route can re-run fatigue adjustment later', () => {
    // Structural #5 relies on this: the stored AthleteState must survive
    // alongside the plan. Without it we could only surface guardrails
    // frozen at generation time.
    const plan = makePlan();
    const athlete = makeAthlete();
    recordWeeklyPlan(plan, athlete);

    const entry = getStoredPlanForWeek(42, '2026-04-13');
    expect(entry).not.toBeNull();
    expect(entry!.plan).toEqual(plan);
    expect(entry!.athleteState.profile.athleteId).toBe(42);
  });

  it('returns the full stored entry when scanning by date', () => {
    recordWeeklyPlan(makePlan({ weekStart: '2026-04-13' }), makeAthlete());

    const entry = getStoredPlanCoveringDate(42, '2026-04-16');
    expect(entry).not.toBeNull();
    expect(entry!.plan.weekStart).toBe('2026-04-13');
    expect(entry!.athleteState.profile.athleteId).toBe(42);
  });
});
