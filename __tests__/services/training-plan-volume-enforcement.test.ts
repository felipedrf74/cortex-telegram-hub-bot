import { describe, expect, it } from 'vitest';

import {
  enforceRequestedTrainingPlanVolume,
} from '../../src/services/training-plan-volume-enforcement';
import { buildCoachKernelTrainingPlan } from '../../src/services/training-coach-kernel-plan-generator';
import { inferTrainingSessionIsLowerHeavy } from '../../src/services/training-session-classification';
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

  it('treats week one as the remaining start week instead of wrapping into prior weekdays', () => {
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
    expect(sessions).toHaveLength(6);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
    expect(days.has('wednesday')).toBe(true);
    expect(days.has('monday')).toBe(false);
    expect(days.has('tuesday')).toBe(false);
    expect([...days].every((day) => ['wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(day))).toBe(true);
  });

  it('preserves five requested strength sessions instead of trimming to the old four-session cap', () => {
    const result = enforceRequestedTrainingPlanVolume(
      { sport: 'running', weeks: [{ weekNumber: 1, sessions: [] }] },
      {
        sessionsPerWeek: 6,
        runSessionsPerWeek: 6,
        strengthSessionsPerWeek: 5,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
        longWorkoutDay: 'Saturday',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const strengthSessions = sessions.filter((session) => session.sessionType === 'gym');
    const strengthDays = strengthSessions.map((session) => session.dayOfWeek);

    expect(sessions).toHaveLength(11);
    expect(strengthSessions).toHaveLength(5);
    expect(sessions.filter((session) => session.sessionType === 'run')).toHaveLength(6);
    expect(new Set(sessions.map((session) => session.dayOfWeek.toLowerCase())).size).toBeLessThanOrEqual(6);
    expect(sessions.some((session) => session.dayOfWeek.toLowerCase() === 'sunday')).toBe(false);
    expect(new Set(strengthDays).size).toBe(5);
    expect(strengthSessions.every((session) => session.preferredStartTime === '12:00')).toBe(true);
  });

  it('matches persisted strength target to real kernel plus enforcer output when explicit strength exceeds day budget', () => {
    const rawPlan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Strength block',
      durationWeeks: 1,
      startDate: '2026-04-27',
      sessionsPerWeek: 3,
      runSessionsPerWeek: null,
      strengthSessionsPerWeek: 5,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      trainingPriority: 'strength',
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });
    const result = enforceRequestedTrainingPlanVolume(rawPlan, {
      sessionsPerWeek: 3,
      runSessionsPerWeek: undefined,
      strengthSessionsPerWeek: 5,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
      longWorkoutDay: 'Saturday',
    });

    const scheduledStrengthSessions = result.weeks?.[0]?.sessions
      ?.filter((session) => session.sessionType === 'gym')
      .length ?? 0;
    expect(scheduledStrengthSessions).toBe(3);
  });

  it('matches persisted strength target when explicit run budget limits high strength requests', () => {
    const rawPlan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Running with strength support',
      durationWeeks: 1,
      startDate: '2026-04-27',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      trainingPriority: 'running',
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });
    const result = enforceRequestedTrainingPlanVolume(rawPlan, {
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const scheduledStrengthSessions = sessions.filter((session) => session.sessionType === 'gym').length;
    expect(scheduledStrengthSessions).toBe(2);
    expect(sessions.filter((session) => session.sessionType === 'run' || session.sessionType === 'long_run')).toHaveLength(2);
  });

  it('keeps triathlon zero bike and swim requests floored in the final scheduled plan', () => {
    const rawPlan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Olympic triathlon',
      durationWeeks: 1,
      startDate: '2026-04-27',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      trainingPriority: 'triathlon',
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    const result = enforceRequestedTrainingPlanVolume(rawPlan, {
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    expect(sessions.filter((session) => ['ride', 'bike', 'cycling'].includes(String(session.sessionType).toLowerCase()))).toHaveLength(1);
    expect(sessions.filter((session) => String(session.sessionType).toLowerCase() === 'swim')).toHaveLength(1);
  });

  it('honors an asymmetric partial-zero triathlon request without applying default multisport floors', () => {
    const rawPlan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Olympic triathlon',
      durationWeeks: 1,
      startDate: '2026-04-27',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      trainingPriority: 'triathlon',
      fitnessProfile: null,
      gymProfile: null,
      runProfile: null,
    });

    const result = enforceRequestedTrainingPlanVolume(rawPlan, {
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const swims = sessions.filter((session) => String(session.sessionType).toLowerCase() === 'swim');
    expect(swims).toHaveLength(2);
    // Regression guard: the zeroed dials mean "auto", so the week must keep
    // its 6-day budget instead of collapsing to explicit-sum (swim 2 +
    // strength 1 = 3 sessions was the bug).
    expect(sessions.length).toBeGreaterThan(3);
  });

  it('does not refill strength into a pre-race strength-cutoff week', () => {
    const rawPlan = buildCoachKernelTrainingPlan({
      userId: 99,
      objective: 'Marathon race week',
      durationWeeks: 1,
      startDate: '2026-04-27',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: null,
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-04-29',
      fitnessProfile: { experience_level: 'advanced', available_equipment: 'Full commercial gym' },
      gymProfile: { training_age: '5 years', equipment_access: 'Full commercial gym' },
      runProfile: { weekly_mileage_km: '45' },
    });
    expect(rawPlan.weeks?.[0]?.strengthCutoffActive).toBe(true);

    const result = enforceRequestedTrainingPlanVolume(rawPlan, {
      sessionsPerWeek: 5,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const strengthSessions = sessions.filter(
      (session) => String(session.sessionType).toLowerCase() === 'gym',
    );
    expect(strengthSessions).toHaveLength(0);
    // The freed strength slots must not be backfilled with extra cardio —
    // the week budget shrinks with the cutoff.
    expect(sessions.length).toBeLessThanOrEqual(4);
  });

  it('does not inflate non-zero cycling targets to sessionsPerWeek during enforcement', () => {
    const result = enforceRequestedTrainingPlanVolume({
      sport: 'cycling',
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'ride', title: 'Endurance Ride', durationMinutes: 60 },
            { dayOfWeek: 'Wednesday', sessionType: 'ride', title: 'Tempo Ride', durationMinutes: 50 },
            { dayOfWeek: 'Saturday', sessionType: 'ride', title: 'Long Ride', durationMinutes: 120 },
            { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Strength Support', durationMinutes: 45, exercises: [{ name: 'Split Squat' }] },
          ],
        },
      ],
    }, {
      sessionsPerWeek: 5,
      bikeSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-04-27',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    expect(sessions).toHaveLength(4);
    expect(sessions.filter((session) => String(session.sessionType).toLowerCase() === 'ride')).toHaveLength(3);
    expect(sessions.filter((session) => String(session.sessionType).toLowerCase() === 'gym')).toHaveLength(1);
  });

  it('does not leave lower-heavy strength on the day before a Saturday long run after volume fill-in', () => {
    const plan: CoordinatedTrainingPlan = {
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Tuesday', sessionType: 'run', title: 'Easy Run', durationMinutes: 45 },
            { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Upper Body Strength', durationMinutes: 45, exercises: [{ name: 'Bench Press' }] },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Lower Body Strength', durationMinutes: 45, exercises: [{ name: 'Back Squat' }] },
            { dayOfWeek: 'Saturday', sessionType: 'long_run', title: 'Long Run', durationMinutes: 90 },
          ],
        },
      ],
    };

    const result = enforceRequestedTrainingPlanVolume(plan, {
      sessionsPerWeek: 5,
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const fridaySessions = sessions.filter((session) => session.dayOfWeek.toLowerCase() === 'friday');

    expect(sessions).toHaveLength(10);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(5);
    expect(fridaySessions.some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
  });

  it.each([
    { longWorkoutDay: 'Sunday', protectedDay: 'Saturday', upperDay: 'Thursday' },
    { longWorkoutDay: 'Wednesday', protectedDay: 'Tuesday', upperDay: 'Friday' },
    { longWorkoutDay: 'Monday', protectedDay: 'Sunday', upperDay: 'Wednesday' },
  ])('protects $protectedDay when the resolved long run is $longWorkoutDay', ({ longWorkoutDay, protectedDay, upperDay }) => {
    const plan: CoordinatedTrainingPlan = {
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            { dayOfWeek: protectedDay, sessionType: 'gym', title: 'Lower Body Strength', durationMinutes: 45, exercises: [{ name: 'Back Squat' }] },
            { dayOfWeek: upperDay, sessionType: 'gym', title: 'Upper Body Strength', durationMinutes: 45, exercises: [{ name: 'Bench Press' }] },
            { dayOfWeek: longWorkoutDay, sessionType: 'long_run', title: 'Long Run', durationMinutes: 90 },
          ],
        },
      ],
    };

    const result = enforceRequestedTrainingPlanVolume(plan, {
      sessionsPerWeek: 3,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 2,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay,
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const protectedSessions = sessions.filter((session) =>
      session.dayOfWeek.toLowerCase() === protectedDay.toLowerCase()
    );

    expect(protectedSessions).not.toHaveLength(0);
    expect(protectedSessions.some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
  });

  it('converts the pre-long-run strength session to upper-body when no safe swap candidate exists', () => {
    const plan: CoordinatedTrainingPlan = {
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Tuesday', sessionType: 'gym', title: 'Lower Strength A', durationMinutes: 45, exercises: [{ name: 'Back Squat' }] },
            { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Lower Strength B', durationMinutes: 45, exercises: [{ name: 'Deadlift' }] },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Lower Strength C', durationMinutes: 45, exercises: [{ name: 'Front Squat' }] },
            { dayOfWeek: 'Saturday', sessionType: 'long_run', title: 'Long Run', durationMinutes: 90 },
          ],
        },
      ],
    };

    const result = enforceRequestedTrainingPlanVolume(plan, {
      sessionsPerWeek: 4,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 3,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay: 'Saturday',
    });

    const sessions = result.weeks?.[0]?.sessions ?? [];
    const fridayStrength = sessions.find((session) =>
      session.dayOfWeek.toLowerCase() === 'friday' && session.sessionType === 'gym'
    );

    expect(fridayStrength).toBeDefined();
    expect(inferTrainingSessionIsLowerHeavy(fridayStrength!)).toBe(false);
    expect(fridayStrength?.description).toContain('Upper-body strength slot substituted');
    expect(fridayStrength?.scheduleAdjustments).toContain('Converted from lower-body strength to upper-body strength before the long run.');
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

  it('does not add implicit runs to pure gym requests when run volume is absent', () => {
    const result = enforceRequestedTrainingPlanVolume(
      { sport: 'gym', weeks: [{ weekNumber: 1, sessions: [] }] },
      {
        sessionsPerWeek: 3,
        strengthSessionsPerWeek: 3,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-06-22',
      },
    );

    const sessions = result.weeks?.[0]?.sessions ?? [];
    expect(sessions).toHaveLength(3);
    expect(sessions.every((session) => session.sessionType === 'gym')).toBe(true);
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

  it('does not wrap Sunday-start week-one plans into the prior six days', () => {
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
    const sessionsByDay = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const daySessions = sessionsByDay.get(session.dayOfWeek) ?? [];
      daySessions.push(session);
      sessionsByDay.set(session.dayOfWeek, daySessions);
    }

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.dayOfWeek === 'Sunday')).toBe(true);
    expect([...sessionsByDay.values()].every((daySessions) =>
      daySessions.filter((session) => session.sessionType === 'gym').length <= 1
    )).toBe(true);
    expect([...sessionsByDay.values()].every((daySessions) => daySessions.length <= 2)).toBe(true);
  });
});
