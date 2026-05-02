import { describe, expect, it } from 'vitest';

import { enforceRequestedTrainingPlanVolume } from '../../src/services/training-plan-volume-enforcement';
import type { CoordinatedTrainingPlan } from '../../src/services/training-plan-coordination';

describe('training-plan-volume-enforcement', () => {
  it('replaces standalone mobility with real requested training volume', () => {
    const plan: CoordinatedTrainingPlan = {
      sport: 'hybrid',
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Easy Run', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'gym', title: 'Strength Session', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
            { dayOfWeek: 'Thursday', sessionType: 'mobility', title: 'Mobility + Recovery', durationMinutes: 30, exercises: [] },
          ],
        },
      ],
    };

    const result = enforceRequestedTrainingPlanVolume(plan, {
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 4,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      startDate: '2026-04-27',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    expect(sessions).toHaveLength(6);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
    expect(sessions.some((session) => session.sessionType === 'mobility')).toBe(false);
    expect(sessions.filter((session) => session.sessionType === 'gym').every((session) => session.preferredStartTime === '12:00')).toBe(true);
    expect(sessions.filter((session) => session.sessionType !== 'gym').every((session) => session.preferredStartTime === '07:00')).toBe(true);
  });

  it('uses remaining future days when week one starts mid-week', () => {
    const result = enforceRequestedTrainingPlanVolume(
      { sport: 'hybrid', weeks: [{ weekNumber: 1, sessions: [] }] },
      {
        sessionsPerWeek: 6,
        strengthSessionsPerWeek: 4,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-29',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const days = new Set(sessions.map((session) => session.dayOfWeek.toLowerCase()));
    expect(days.has('monday')).toBe(false);
    expect(days.has('tuesday')).toBe(false);
    expect(sessions).toHaveLength(6);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
  });

  it('preserves five requested strength sessions instead of trimming to the old four-session cap', () => {
    const result = enforceRequestedTrainingPlanVolume(
      { sport: 'running', weeks: [{ weekNumber: 1, sessions: [] }] },
      {
        sessionsPerWeek: 6,
        strengthSessionsPerWeek: 5,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const strengthSessions = sessions.filter((session) => session.sessionType === 'gym');
    const strengthDays = strengthSessions.map((session) => session.dayOfWeek);

    expect(sessions).toHaveLength(11);
    expect(strengthSessions).toHaveLength(5);
    expect(sessions.filter((session) => session.sessionType === 'run')).toHaveLength(6);
    expect(new Set(strengthDays).size).toBe(5);
    expect(strengthSessions.every((session) => session.preferredStartTime === '12:00')).toBe(true);
  });

  it('converts excess gym sessions into aerobic support instead of standalone mobility', () => {
    const plan: CoordinatedTrainingPlan = {
      sport: 'gym',
      weeks: [
        {
          weekNumber: 2,
          sessions: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => ({
            dayOfWeek: day,
            sessionType: 'gym',
            title: `Strength ${index + 1}`,
            durationMinutes: 45,
            exercises: [{ name: 'Squat' }],
          })),
        },
      ],
    };

    const result = enforceRequestedTrainingPlanVolume(plan, {
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 4,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      startDate: '2026-04-27',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    expect(sessions).toHaveLength(6);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
    expect(sessions.filter((session) => session.sessionType === 'run')).toHaveLength(2);
  });

  it('spreads duplicate same-type sessions before allowing two-a-days', () => {
    const result = enforceRequestedTrainingPlanVolume(
      {
        sport: 'hybrid',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Upper A', durationMinutes: 45, exercises: [{ name: 'Press' }] },
              { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Upper B', durationMinutes: 45, exercises: [{ name: 'Pull' }] },
              { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 60 },
            ],
          },
        ],
      },
      {
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 3,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const strengthDays = sessions
      .filter((session) => session.sessionType === 'gym')
      .map((session) => session.dayOfWeek);
    expect(new Set(strengthDays).size).toBe(strengthDays.length);
  });

  it('does not fill a remaining double-session day with two strength sessions', () => {
    const result = enforceRequestedTrainingPlanVolume(
      { sport: 'running', weeks: [{ weekNumber: 1, sessions: [] }] },
      {
        sessionsPerWeek: 3,
        strengthSessionsPerWeek: 2,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-05-03',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const sunday = sessions.filter((session) => session.dayOfWeek === 'Sunday');
    const sundayStrength = sunday.filter((session) => session.sessionType === 'gym');

    expect(sunday).toHaveLength(2);
    expect(sundayStrength).toHaveLength(1);
    expect(sunday.some((session) => session.sessionType === 'run')).toBe(true);
    expect(sundayStrength[0].preferredStartTime).toBe('12:00');
  });
});
