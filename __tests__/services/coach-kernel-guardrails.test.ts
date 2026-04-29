import { describe, expect, it } from 'vitest';

import { applyGuardrails, buildWeekPlan, loadCoachKnowledge, sampleHybridAthlete, sampleMarathonAthlete, sampleTriathlete, type AthleteState, type WeeklyPlan } from '../../src/services/coach-kernel';
import { estimateStrengthSessionMinutes } from '../../src/services/coach-kernel/session-coherence';

function planMinutesBySport(plan: WeeklyPlan, sport: 'running' | 'cycling' | 'swimming' | 'strength'): number {
  return plan.sessions
    .filter((session) => session.sport === sport)
    .reduce((sum, session) => sum + session.durationMinutes, 0);
}

function minutesBetween(startTime?: string, endTime?: string): number | null {
  if (!startTime || !endTime) return null;
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  if ([startHour, startMinute, endHour, endMinute].some((value) => Number.isNaN(value))) return null;
  let total = ((endHour * 60) + endMinute) - ((startHour * 60) + startMinute);
  if (total < 0) total += 24 * 60;
  return total;
}

describe('coach-kernel guardrails', () => {
  it('blocks unsafe weekly volume jumps', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      trainingHistory: {
        ...sampleMarathonAthlete.trainingHistory,
        lastWeekMinutesBySport: { ...sampleMarathonAthlete.trainingHistory.lastWeekMinutesBySport, running: 100 },
      },
    };

    const plan = buildWeekPlan(athlete, '2026-05-11');
    const runningMinutes = planMinutesBySport(plan, 'running');

    expect(runningMinutes).toBeLessThanOrEqual(108);
    expect(plan.guardrailResults.some((result) => result.ruleId === 'volume_growth_running' && result.adjusted)).toBe(true);
  });

  it('triggers deload when readiness is critically low', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'red',
        score: 28,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-05-11');

    expect(plan.phase).toBe('deload');
    expect(plan.guardrailResults.some((result) => result.ruleId === 'deload' && result.adjusted)).toBe(true);
    expect(plan.guardrailResults.some((result) => result.ruleId === 'readiness' && result.status === 'block')).toBe(true);
  });

  it('protects key endurance sessions from lower-body strength interference', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const keyDays = new Set(plan.sessions.filter((session) => session.keySession).map((session) => session.dayOfWeek));
    const lowerBodyStrength = plan.sessions.filter((session) => session.sport === 'strength');

    expect(lowerBodyStrength.every((session) => !keyDays.has(session.dayOfWeek))).toBe(true);
  });

  it('prevents unresolved schedule conflicts when max sessions per day is tight', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      availability: {
        ...sampleTriathlete.availability,
        maxSessionsPerDay: 1,
      },
    };
    const plan = buildWeekPlan(athlete, '2026-06-15');
    const counts = plan.sessions.reduce<Record<string, number>>((acc, session) => {
      acc[session.dayOfWeek] = (acc[session.dayOfWeek] ?? 0) + 1;
      return acc;
    }, {});

    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(1);
  });

  it('can re-run guardrails on a modified plan safely', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const rerun = applyGuardrails(plan, sampleTriathlete);
    expect(rerun.guardrailResults.length).toBeGreaterThan(0);
  });

  it('keeps red-readiness replacements sport-specific for triathlon sessions', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      readiness: {
        ...sampleTriathlete.readiness,
        level: 'red',
        score: 24,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');

    expect(plan.sessions.some((session) => session.sport === 'cycling' && session.sessionType === 'recovery_ride')).toBe(true);
    expect(plan.sessions.some((session) => session.sport === 'swimming' && session.sessionType === 'recovery_swim')).toBe(true);
    expect(plan.sessions.some((session) => session.sport === 'cycling' && session.sessionType === 'recovery_run')).toBe(false);
    expect(plan.sessions.some((session) => session.sport === 'swimming' && session.sessionType === 'recovery_run')).toBe(false);
  });

  it('keeps red-readiness strength replacements truthful to the short technique slot', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      readiness: {
        ...sampleHybridAthlete.readiness,
        level: 'red',
        score: 24,
      },
    };
    const knowledge = loadCoachKnowledge();

    const plan = buildWeekPlan(athlete, '2026-05-04');
    const redStrength = plan.sessions.filter((session) => session.sport === 'strength' && session.title === 'Technique Strength + Mobility');

    expect(redStrength.length).toBeGreaterThan(0);
    for (const session of redStrength) {
      expect(session.exercises?.length ?? 0).toBeLessThanOrEqual(2);
      expect(session.exercises?.every((exercise) => exercise.sets <= 2)).toBe(true);
      expect(session.exercises?.every((exercise) => (exercise.rir ?? 0) >= 4)).toBe(true);
      const estimated = estimateStrengthSessionMinutes(session, knowledge);
      expect(estimated).toBeLessThanOrEqual(Math.ceil(session.durationMinutes * 1.25));
    }
  });

  it('varies red-readiness recovery titles by the original endurance role', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      readiness: {
        ...sampleTriathlete.readiness,
        level: 'red',
        score: 24,
      },
    };
    const base = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const manual: WeeklyPlan = {
      ...base,
      sessions: [
        {
          ...base.sessions[0],
          id: 'manual-interval-run',
          sport: 'running',
          sessionType: 'interval_run',
          title: 'Track Intervals',
          keySession: true,
        },
        {
          ...base.sessions[1],
          id: 'manual-long-run',
          sport: 'running',
          sessionType: 'long_run',
          title: 'Long Run',
          keySession: true,
        },
        {
          ...base.sessions[2],
          id: 'manual-threshold-ride',
          sport: 'cycling',
          sessionType: 'threshold_ride',
          title: 'Threshold Ride',
          keySession: true,
        },
      ],
      guardrailResults: [],
    };

    const guarded = applyGuardrails(manual, athlete);
    const titles = guarded.sessions.map((session) => session.title);

    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain('Recovery Run - Intensity Removed');
    expect(titles).toContain('Run-Walk Aerobic Reset');
    expect(titles.some((title) => title.includes('Spin') || title.includes('Ride'))).toBe(true);
  });

  it('keeps session times aligned with adjusted durations after guardrails mutate a plan', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      readiness: {
        ...sampleTriathlete.readiness,
        level: 'red',
        score: 22,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');

    for (const session of plan.sessions) {
      if (!session.startTime || !session.endTime) continue;
      expect(minutesBetween(session.startTime, session.endTime)).toBe(session.durationMinutes);
    }
  });
});
