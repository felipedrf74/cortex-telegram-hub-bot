import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  buildDayPlan,
  loadCoachKnowledge,
  sampleHybridAthlete,
  sampleMarathonAthlete,
  sampleTriathlete,
  type AthleteState,
} from '../../src/services/coach-kernel';

describe('coach-kernel planner', () => {
  it('handles marathon peak-week long run safely', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'peak',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-08-10');
    const longRun = plan.sessions.find((session) => session.sessionType === 'long_run');

    expect(longRun).toBeTruthy();
    expect(longRun!.durationMinutes).toBeLessThanOrEqual(170);
    expect(plan.phase).toBe('peak');
  });

  it('places a triathlon brick around the bike day', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const brick = plan.sessions.find((session) => session.sessionType === 'brick');
    const keyRide = plan.sessions.find((session) => session.tags.includes('key_ride'));

    expect(brick).toBeTruthy();
    expect(keyRide).toBeTruthy();
    expect(brick!.dayOfWeek).toBe(keyRide!.dayOfWeek);
  });

  it('resolves hybrid priority conflicts in favor of the declared priority', () => {
    const knowledge = loadCoachKnowledge();
    expect(knowledge.docs.hybridAthleteRules).toContain('Endurance priority wins');

    const plan = buildWeekPlan(sampleHybridAthlete, '2026-05-04');
    const strengthSessions = plan.sessions.filter((session) => session.sport === 'strength');
    const runSessions = plan.sessions.filter((session) => session.sport === 'running');

    expect(strengthSessions.length).toBeGreaterThan(0);
    expect(runSessions.length).toBeLessThanOrEqual(3);
  });

  it('builds a daily recommendation using deterministic weekly plan output', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const day = buildDayPlan(sampleMarathonAthlete, plan, 'tuesday');

    expect(day.session).toBeTruthy();
    expect(day.rationale[0]).toContain('primary prescription');
  });
});

