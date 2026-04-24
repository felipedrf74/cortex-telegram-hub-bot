import { describe, expect, it } from 'vitest';

import { buildDeterministicTrainingPlan } from '../../src/api/routes/training-fallback-plan';

describe('training-fallback-plan', () => {
  it('builds a running fallback plan with the requested long-run day and strength support', () => {
    const plan = buildDeterministicTrainingPlan('Lisbon Marathon build', 4, {
      sessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: 'Sunday',
    });

    expect(plan.sport).toBe('running');
    expect(plan.weeks).toHaveLength(4);

    const weekOneSessions = plan.weeks[0].sessions;
    expect(weekOneSessions.filter((session: any) => session.sessionType === 'run')).toHaveLength(4);
    expect(weekOneSessions.filter((session: any) => session.sessionType === 'gym')).toHaveLength(2);
    expect(weekOneSessions.some((session: any) => session.title === 'Long Run' && session.dayOfWeek === 'sunday')).toBe(true);
  });

  it('builds a triathlon fallback plan with swim, bike, run, and strength coverage', () => {
    const plan = buildDeterministicTrainingPlan('Half Ironman prep', 3);

    expect(plan.sport).toBe('hybrid');
    const sessionTypes = new Set(plan.weeks[0].sessions.map((session: any) => session.sessionType));
    expect(sessionTypes).toEqual(new Set(['swim', 'ride', 'gym', 'run']));
  });

  it('builds a gym fallback plan for hypertrophy objectives', () => {
    const plan = buildDeterministicTrainingPlan('Hypertrophy phase', 3);

    expect(plan.sport).toBe('gym');
    expect(plan.weeks[0].sessions.map((session: any) => session.title)).toEqual([
      'Upper Body A',
      'Lower Body A',
      'Upper Body B',
      'Lower Body B',
    ]);
  });

  it('uses a deload final week with reduced intensity and scaled sets', () => {
    const plan = buildDeterministicTrainingPlan('General strength block', 4);

    expect(plan.weeks[3].focus).toBe('deload');
    expect(plan.weeks[3].intensityPct).toBe(58);
    expect(plan.weeks[3].sessions[0].durationMinutes).toBeLessThan(plan.weeks[0].sessions[0].durationMinutes);
    expect(plan.weeks[3].sessions[0].exercises[0].sets).toBeLessThan(plan.weeks[0].sessions[0].exercises[0].sets);
  });
});
