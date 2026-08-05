import { describe, expect, it } from 'vitest';

import {
  captureTrainingPlanVolumeTargetSnapshot,
  enforceFinalTrainingPlanTwoADayCap,
  enforceRequestedTrainingPlanVolume,
  recalculateFinalTrainingPlanVolumeShortfalls,
} from '../../src/services/training-plan-volume-enforcement';
import { buildCoachKernelTrainingPlan } from '../../src/services/training-coach-kernel-plan-generator';
import { inferTrainingSessionIsLowerHeavy } from '../../src/services/training-session-classification';
import type { CoordinatedTrainingPlan } from '../../src/services/training-plan-coordination';

describe('training-plan-volume-enforcement', () => {
  it('drops standalone mobility and reports missing engine-authored volume', () => {
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
    // Stronger F10 guarantee: normalization may remove non-training rows, but
    // it cannot invent four unreviewed workouts to make the count look full.
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(1);
    expect(sessions.some((session) => session.sessionType === 'mobility')).toBe(false);
    expect(sessions.filter((session) => session.sessionType === 'gym').every((session) => session.preferredStartTime === '12:00')).toBe(true);
    expect(sessions.filter((session) => session.sessionType !== 'gym').every((session) => session.preferredStartTime === '07:00')).toBe(true);
    expect(result.volumeShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'active', requested: 6, achieved: 2, reason: 'engine_output_shortfall' }),
      expect.objectContaining({ kind: 'strength', requested: 4, achieved: 1, reason: 'engine_output_shortfall' }),
    ]));
  });

  it('does not synthesize wraparound workouts when week-one engine output is empty', () => {
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
    expect(sessions).toHaveLength(0);
    expect(days.has('monday')).toBe(false);
    expect(days.has('tuesday')).toBe(false);
    expect([...days].every((day) => ['wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(day))).toBe(true);
    expect(result.volumeShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'active', requested: 6, achieved: 0 }),
      expect.objectContaining({ kind: 'strength', requested: 4, achieved: 0 }),
    ]));
  });

  it('reports a five-strength-session engine shortfall without recreating the old four-session cap', () => {
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
    expect(sessions).toHaveLength(0);
    expect(result.volumeShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'active', requested: 11, achieved: 0 }),
      expect.objectContaining({ kind: 'strength', requested: 5, achieved: 0 }),
    ]));
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

  it('does not leave engine-authored lower-heavy strength on the day before a Saturday long run', () => {
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

    expect(sessions).toHaveLength(4);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(2);
    expect(fridaySessions.some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
    expect(result.volumeShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'active', requested: 10, achieved: 4 }),
      expect.objectContaining({ kind: 'strength', requested: 5, achieved: 2 }),
    ]));
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

  it('trims excess gym rows without converting them into generic aerobic sessions', () => {
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
    // Stronger F10 guarantee: modality correction may remove excess strength,
    // but it must not relabel those rows as empty generic runs.
    expect(sessions).toHaveLength(4);
    expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(4);
    expect(sessions.filter((session) => session.sessionType === 'run')).toHaveLength(0);
    expect(result.volumeShortfalls).toEqual([
      expect.objectContaining({ kind: 'active', requested: 6, achieved: 4, reason: 'engine_output_shortfall' }),
    ]);
  });

  it('does not add implicit workouts to an empty pure-gym engine result', () => {
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
    expect(sessions).toHaveLength(0);
    expect(result.volumeShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'active', requested: 3, achieved: 0 }),
      expect.objectContaining({ kind: 'strength', requested: 3, achieved: 0 }),
    ]));
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
      { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
        { dayOfWeek: 'Sunday', sessionType: 'run', title: 'Engine Run', durationMinutes: 40 },
        { dayOfWeek: 'Sunday', sessionType: 'gym', title: 'Engine Strength', durationMinutes: 45, exercises: [{ name: 'Press' }] },
      ] }] },
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
  // ── F7 (Phase 3): twoADayPreference 'never' ─────────────────────────────
  // The kernel receives the preference but the volume enforcer used to
  // ignore it: activeTarget baked in allowedDays * 2, the insertion-day
  // picker happily stacked a second session, and kernel-produced doubles
  // survived untouched. 'never' is an explicit athlete constraint.
  describe("twoADayPreference 'never' (F7)", () => {
    const neverRequest = {
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:00',
      startDate: '2026-04-27',
      twoADayPreference: 'never',
    };

    function activeSessionsPerDay(sessions: Array<{ dayOfWeek: string; scheduleState?: string }>): Map<string, number> {
      const counts = new Map<string, number>();
      for (const session of sessions) {
        if (session.scheduleState === 'deferred' || session.scheduleState === 'unscheduled' || session.scheduleState === 'dropped') continue;
        counts.set(session.dayOfWeek, (counts.get(session.dayOfWeek) ?? 0) + 1);
      }
      return counts;
    }

    it('relocates kernel-produced same-day doubles instead of keeping two a day', () => {
      const result = enforceRequestedTrainingPlanVolume(
        {
          sport: 'hybrid',
          weeks: [{
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Friday', sessionType: 'run', title: 'Tempo Run', durationMinutes: 40 },
              { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Lift A', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
              { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 70 },
            ],
          }],
        },
        neverRequest,
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      const perDay = activeSessionsPerDay(sessions);
      expect(Math.max(...perDay.values())).toBe(1);
      // Relocation, not deletion: all three sessions survive as active work.
      expect([...perDay.values()].reduce((sum, count) => sum + count, 0)).toBe(3);
    });

    it('budgets distinct days for the summed explicit hybrid modalities', () => {
      // With `never`, a 3-run + 2-strength ask cannot be evaluated against
      // only the three endurance days: doing so silently trims the easy and
      // quality runs even though five distinct days are available.
      const result = enforceRequestedTrainingPlanVolume(
        {
          sport: 'hybrid',
          weeks: [{
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'Recovery Run', durationMinutes: 35 },
              { dayOfWeek: 'Tuesday', sessionType: 'run', title: 'Tempo Run', durationMinutes: 45 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Strength A', durationMinutes: 45 },
              { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Strength B', durationMinutes: 45 },
              { dayOfWeek: 'Saturday', sessionType: 'long_run', title: 'Long Run', durationMinutes: 75 },
            ],
          }],
        },
        {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 3,
          strengthSessionsPerWeek: 2,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '18:00',
          startDate: '2026-05-25',
          longWorkoutDay: 'Saturday',
          twoADayPreference: 'never',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      expect(sessions.filter((session) => /run/.test(session.sessionType))).toHaveLength(3);
      expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(2);
      expect(result.volumeShortfalls ?? []).toEqual([]);
    });

    it('reserves the requested remaining days for partial-auto multisport modalities', () => {
      const rawPlan: CoordinatedTrainingPlan = {
        sport: 'triathlon',
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Auto Run', durationMinutes: 40 },
            { dayOfWeek: 'Thursday', sessionType: 'ride', title: 'Auto Ride', durationMinutes: 50 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45 },
          ],
        }],
      };
      const request = {
        sessionsPerWeek: 6,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 2,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
        startDate: '2026-05-25',
        longWorkoutDay: 'Saturday',
        twoADayPreference: 'never',
      };

      const snapshot = captureTrainingPlanVolumeTargetSnapshot(rawPlan, request);
      expect(snapshot.weeks[0]).toMatchObject({
        weekTotalBudget: 6,
        activeTarget: 6,
        singleSessionPerDay: true,
      });
      expect(snapshot.weeks[0]?.allowedDays).toHaveLength(6);

      const result = enforceRequestedTrainingPlanVolume(rawPlan, request);
      const sessions = result.weeks?.[0]?.sessions ?? [];
      expect(sessions).toHaveLength(6);
      expect(new Set(sessions.map((session) => session.dayOfWeek)).size).toBe(6);
      expect(result.volumeShortfalls ?? []).toEqual([]);
    });

    it('uses the same summed explicit day budget for a running plan with strength support', () => {
      const result = enforceRequestedTrainingPlanVolume(
        {
          sport: 'running',
          weeks: [{
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'Easy Run', durationMinutes: 35 },
              { dayOfWeek: 'Tuesday', sessionType: 'run', title: 'Tempo Run', durationMinutes: 45 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Strength A', durationMinutes: 45 },
              { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Strength B', durationMinutes: 45 },
            ],
          }],
        },
        {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 2,
          strengthSessionsPerWeek: 2,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '18:00',
          startDate: '2026-05-25',
          twoADayPreference: 'never',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      expect(sessions.filter((session) => /run/.test(session.sessionType))).toHaveLength(2);
      expect(sessions.filter((session) => session.sessionType === 'gym')).toHaveLength(2);
      expect(new Set(sessions.map((session) => session.dayOfWeek)).size).toBe(4);
      expect(result.volumeShortfalls ?? []).toEqual([]);
    });

    it('never fills a second session onto an occupied day', () => {
      const result = enforceRequestedTrainingPlanVolume(
        { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
          ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'run', title: `Run ${index + 1}`, durationMinutes: 40,
          })),
          ...['Monday', 'Tuesday', 'Wednesday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'gym', title: `Strength ${index + 1}`, durationMinutes: 45, exercises: [{ name: 'Press' }],
          })),
        ] }] },
        {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 5,
          strengthSessionsPerWeek: 3,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '12:00',
          startDate: '2026-04-27',
          twoADayPreference: 'never',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      const perDay = activeSessionsPerDay(sessions);
      // The explicit cap trims to the five legal engine-authored rows; it no
      // longer preserves three extra rows or replaces them with fillers.
      expect(sessions).toHaveLength(5);
      expect(Math.max(...perDay.values())).toBe(1);
      expect(result.volumeShortfalls).toContainEqual(expect.objectContaining({
        kind: 'active', requested: 8, achieved: 5, reason: 'two_a_day_cap',
      }));
    });

    it('restores the cap after a later quality pass creates a doubled day', () => {
      const result = enforceFinalTrainingPlanTwoADayCap(
        {
          sport: 'hybrid',
          weeks: [{
            weekNumber: 2,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'Recovery Run', durationMinutes: 35 },
              { dayOfWeek: 'Tuesday', sessionType: 'run', title: 'Tempo Run', durationMinutes: 45 },
              { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Full Body Strength A', durationMinutes: 45 },
              { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Full Body Strength B', durationMinutes: 45 },
              { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 75 },
            ],
          }],
        },
        {
          startDate: '2026-08-05',
          twoADayPreference: 'never',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      const perDay = activeSessionsPerDay(sessions);
      expect(Math.max(...perDay.values())).toBe(1);
      expect([...perDay.values()].reduce((sum, count) => sum + count, 0)).toBe(5);
      expect(sessions.find((session) => session.title === 'Full Body Strength B')).toMatchObject({
        originalDayOfWeek: 'Saturday',
        scheduleAdjustments: expect.arrayContaining(['reflowed']),
      });
    });

    it('keeps two-a-days available when the preference is absent', () => {
      const result = enforceRequestedTrainingPlanVolume(
        { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
          ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'run', title: `Run ${index + 1}`, durationMinutes: 40,
          })),
          ...['Monday', 'Tuesday', 'Wednesday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'gym', title: `Strength ${index + 1}`, durationMinutes: 45, exercises: [{ name: 'Press' }],
          })),
        ] }] },
        {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 5,
          strengthSessionsPerWeek: 3,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '12:00',
          startDate: '2026-04-27',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      const perDay = activeSessionsPerDay(sessions);
      // The pre-F7 behaviour is preserved for every other preference value:
      // the 5-day budget with 8 requested sessions requires doubling up.
      expect(Math.max(...perDay.values())).toBe(2);
    });
  });

  // ── F10 (Phase 3): engine-only sessions + structured shortfall ──────────
  describe('engine output provenance and shortfall (F10)', () => {
    it('preserves the pre-enforcement partial-multisport target after trimming removes auto modalities', () => {
      const request = {
        sessionsPerWeek: 6,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 2,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const rawPlan: CoordinatedTrainingPlan = {
        sport: 'triathlon',
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
            { dayOfWeek: 'Thursday', sessionType: 'ride', title: 'Ride 1', durationMinutes: 50 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45 },
          ],
        }],
      };
      const targetSnapshot = captureTrainingPlanVolumeTargetSnapshot(rawPlan, request);
      const finalPlan: CoordinatedTrainingPlan = {
        ...rawPlan,
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45 },
          ],
        }],
      };

      const result = recalculateFinalTrainingPlanVolumeShortfalls(finalPlan, targetSnapshot);

      expect(result.volumeShortfalls).toContainEqual(expect.objectContaining({
        kind: 'active',
        requested: 6,
        achieved: 4,
        reason: 'no_available_day',
      }));
    });

    it('reports the athlete-requested strength target when placement capacity binds lower', () => {
      const request = {
        sessionsPerWeek: 3,
        strengthSessionsPerWeek: 6,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const plan: CoordinatedTrainingPlan = {
        sport: 'gym',
        weeks: [{
          weekNumber: 1,
          sessions: ['Monday', 'Wednesday', 'Friday'].map((day, index) => ({
            dayOfWeek: day,
            sessionType: 'gym',
            title: `Strength ${index + 1}`,
            durationMinutes: 45,
          })),
        }],
      };
      const targetSnapshot = captureTrainingPlanVolumeTargetSnapshot(plan, request);

      const result = recalculateFinalTrainingPlanVolumeShortfalls(plan, targetSnapshot);

      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          kind: 'strength',
          requested: 6,
          achieved: 3,
          reason: 'no_available_day',
        }),
      ]);
    });

    it('does not count either canceled spelling as achieved final volume', () => {
      const request = {
        sessionsPerWeek: 3,
        runSessionsPerWeek: 3,
        strengthSessionsPerWeek: 0,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const plan: CoordinatedTrainingPlan = {
        sport: 'running',
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 2', durationMinutes: 40, scheduleState: 'canceled' },
            { dayOfWeek: 'Friday', sessionType: 'run', title: 'Run 3', durationMinutes: 40, scheduleState: 'cancelled' },
          ],
        }],
      };
      const targetSnapshot = captureTrainingPlanVolumeTargetSnapshot(plan, request);

      const result = recalculateFinalTrainingPlanVolumeShortfalls(plan, targetSnapshot);

      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          kind: 'active',
          requested: 3,
          achieved: 1,
          reason: 'no_available_day',
        }),
      ]);
    });

    it('replaces stale pre-quality shortfalls after a late pass adds engine-authored sessions', () => {
      const referencePlan: CoordinatedTrainingPlan = {
        sport: 'running',
        weeks: [{
          weekNumber: 1,
          sessions: [
            ...['Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((day, index) => ({
              dayOfWeek: day,
              sessionType: 'run',
              title: `Engine Run ${index + 1}`,
              durationMinutes: 40,
            })),
            { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Engine Strength 1', durationMinutes: 45 },
          ],
        }],
      };
      const finalPlan: CoordinatedTrainingPlan = {
        ...referencePlan,
        volumeShortfalls: [
          {
            weekNumber: 1,
            kind: 'active',
            requested: 10,
            achieved: 5,
            reason: 'engine_output_shortfall',
            provenance: 'coach_kernel_output',
          },
          {
            weekNumber: 1,
            kind: 'strength',
            requested: 5,
            achieved: 1,
            reason: 'engine_output_shortfall',
            provenance: 'coach_kernel_output',
          },
        ],
        weeks: [{
          weekNumber: 1,
          sessions: [
            ...(referencePlan.weeks?.[0]?.sessions ?? []),
            ...['Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
              dayOfWeek: day,
              sessionType: 'gym',
              title: `Quality Strength ${index + 2}`,
              durationMinutes: 45,
            })),
          ],
        }],
      };

      const request = {
        sessionsPerWeek: 5,
        runSessionsPerWeek: 5,
        strengthSessionsPerWeek: 5,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const result = recalculateFinalTrainingPlanVolumeShortfalls(
        finalPlan,
        captureTrainingPlanVolumeTargetSnapshot(referencePlan, request),
      );

      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          kind: 'active',
          requested: 10,
          achieved: 9,
          reason: 'engine_output_shortfall',
        }),
      ]);
      expect(result.weeks?.[0]?.sessions).toEqual(finalPlan.weeks?.[0]?.sessions);
      expect(result.weeks?.[0]?.sessions?.some((session: any) => session.sessionProvenance === 'volume_filler')).toBe(false);
    });

    it('detects a new late-pass removal using the original multisport target semantics', () => {
      const referencePlan: CoordinatedTrainingPlan = {
        sport: 'triathlon',
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
            { dayOfWeek: 'Thursday', sessionType: 'run', title: 'Run 2', durationMinutes: 40 },
            { dayOfWeek: 'Friday', sessionType: 'ride', title: 'Ride 1', durationMinutes: 50 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
          ],
        }],
      };
      const finalPlan: CoordinatedTrainingPlan = {
        ...referencePlan,
        weeks: [{
          weekNumber: 1,
          // A late mutator removed every auto-selected run/ride. Using only
          // final modalities would collapse the target to swim=2 + strength=1
          // and hide the new gap; the reference keeps the original 6-day ask.
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
            { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
          ],
        }],
      };

      const request = {
        sessionsPerWeek: 6,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 1,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const result = recalculateFinalTrainingPlanVolumeShortfalls(
        finalPlan,
        captureTrainingPlanVolumeTargetSnapshot(referencePlan, request),
      );

      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          kind: 'active',
          requested: 6,
          achieved: 3,
          reason: 'engine_output_shortfall',
        }),
      ]);
      expect(result.weeks?.[0]?.sessions).toEqual(finalPlan.weeks?.[0]?.sessions);
    });

    it('keeps no-available-day distinct from a missing engine prescription', () => {
      const plan: CoordinatedTrainingPlan = {
        sport: 'running',
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 2', durationMinutes: 40 },
            {
              dayOfWeek: 'Friday',
              sessionType: 'run',
              title: 'Run 3',
              durationMinutes: 40,
              scheduleState: 'unscheduled',
            },
          ],
        }],
      };
      const request = {
        sessionsPerWeek: 3,
        runSessionsPerWeek: 3,
        strengthSessionsPerWeek: 0,
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
        startDate: '2026-04-27',
      };
      const result = recalculateFinalTrainingPlanVolumeShortfalls(
        plan,
        captureTrainingPlanVolumeTargetSnapshot(plan, request),
      );

      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          kind: 'active',
          requested: 3,
          achieved: 2,
          reason: 'no_available_day',
        }),
      ]);
    });

    it('surfaces a shortfall instead of manufacturing generic support sessions', () => {
      const result = enforceRequestedTrainingPlanVolume(
        { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
          { dayOfWeek: 'Monday', sessionType: 'run', title: 'Engine Run', durationMinutes: 45 },
        ] }] },
        {
          sessionsPerWeek: 3,
          runSessionsPerWeek: 3,
          strengthSessionsPerWeek: 1,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '12:00',
          startDate: '2026-04-27',
        },
      );

      const sessions = result.weeks?.[0]?.sessions ?? [];
      // Stronger guarantee: the enforcer reports the engine's gap and never
      // turns a missing prescription into a user-facing generic workout.
      expect(sessions.map((session) => session.title)).toEqual(['Engine Run']);
      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          weekNumber: 1,
          kind: 'active',
          requested: 4,
          achieved: 1,
          reason: 'engine_output_shortfall',
          provenance: 'coach_kernel_output',
        }),
        expect.objectContaining({
          weekNumber: 1,
          kind: 'strength',
          requested: 1,
          achieved: 0,
          reason: 'engine_output_shortfall',
          provenance: 'coach_kernel_output',
        }),
      ]);
    });

    it('surfaces a structured shortfall when the two-a-day cap makes the ask unreachable', () => {
      const result = enforceRequestedTrainingPlanVolume(
        { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
          ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'run', title: `Run ${index + 1}`, durationMinutes: 40,
          })),
          ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
            dayOfWeek: day, sessionType: 'gym', title: `Strength ${index + 1}`, durationMinutes: 45, exercises: [{ name: 'Press' }],
          })),
        ] }] },
        {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 5,
          strengthSessionsPerWeek: 5,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '12:00',
          startDate: '2026-04-27',
          twoADayPreference: 'never',
        },
      );

      // 10 requested sessions on a 5-day budget with a 1/day cap: the silent
      // \`break\` used to hide the gap entirely.
      expect(result.volumeShortfalls).toEqual([
        expect.objectContaining({
          weekNumber: 1,
          kind: 'active',
          requested: 10,
          achieved: 5,
          reason: 'two_a_day_cap',
          provenance: 'coach_kernel_output',
        }),
      ]);
    });

    it('reports no shortfall when the ask is met', () => {
      const result = enforceRequestedTrainingPlanVolume(
        { sport: 'running', weeks: [{ weekNumber: 1, sessions: [
          { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
          { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 2', durationMinutes: 40 },
          { dayOfWeek: 'Friday', sessionType: 'run', title: 'Run 3', durationMinutes: 40 },
        ] }] },
        {
          sessionsPerWeek: 3,
          runSessionsPerWeek: 3,
          strengthSessionsPerWeek: 0,
          preferredCardioTime: '07:00',
          preferredStrengthTime: '12:00',
          startDate: '2026-04-27',
        },
      );
      expect(result.volumeShortfalls ?? []).toHaveLength(0);
    });
  });
});
