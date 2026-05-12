import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  isActiveTrainingSession,
  reconcileWeeklyCapacity,
  sampleHybridAthlete,
  syncCalendar,
  type AthleteState,
  type Session,
} from '../../src/services/coach-kernel';
import { trainingEvalPersonaBank, trainingEvalScenarioBank } from '../../src/services/coach-kernel/evaluation';
import { timeToMinutes } from '../../src/services/coach-kernel/utils';

function activeSessions(plan: { sessions: Session[] }): Session[] {
  return plan.sessions.filter(isActiveTrainingSession);
}

function windowFor(athlete: AthleteState, session: Session) {
  return athlete.availability.weeklyWindows.find((window) =>
    window.dayOfWeek === session.dayOfWeek
    && (!window.sports || window.sports.includes(session.sport))
  );
}

function expectActiveSessionsInsideWindows(athlete: AthleteState, sessions: Session[]): void {
  for (const session of sessions) {
    const window = windowFor(athlete, session);
    expect(window, `${session.title} needs a compatible window`).toBeTruthy();
    expect(session.startTime, `${session.title} missing start`).toMatch(/^\d{2}:\d{2}$/);
    expect(session.endTime, `${session.title} missing end`).toMatch(/^\d{2}:\d{2}$/);
    expect(timeToMinutes(session.startTime!)).toBeGreaterThanOrEqual(timeToMinutes(window!.start));
    expect(timeToMinutes(session.endTime!)).toBeLessThanOrEqual(timeToMinutes(window!.end));
    expect(session.durationMinutes).toBeLessThanOrEqual(timeToMinutes(window!.end) - timeToMinutes(window!.start));
  }
}

describe('coach-kernel constrained week capacity reconciliation', () => {
  it('caps a travel strength week to the two feasible hotel-gym windows and marks the leftover session unscheduled', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        primaryDiscipline: 'strength',
      },
      goals: {
        ...sampleHybridAthlete.goals,
        primaryFocus: 'strength',
        secondaryFocus: undefined,
        strengthGoal: 'hypertrophy',
        priorityOrder: ['strength'],
        weeklySessionsTarget: { strength: 3 },
        weeklyMinutesTarget: { strength: 135 },
      },
      equipment: {
        hasGym: false,
        hasBarbell: false,
        hasDumbbells: true,
        hasBikeTrainer: false,
        hasPool: false,
        hasTrack: false,
        notes: ['hotel gym only'],
      },
      constraints: [
        { id: 'travel-week', type: 'equipment', severity: 'high', description: 'Travel week: hotel gym only and reduced setup time.' },
      ],
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '12:00', end: '12:30', sports: ['strength'], label: 'hotel gym lunch' },
          { dayOfWeek: 'thursday', start: '18:00', end: '18:30', sports: ['strength'], label: 'hotel gym evening' },
        ],
        preferredTimesBySport: { strength: '12:00' },
        maxSessionsPerDay: 1,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-04-27');
    const active = activeSessions(plan);
    const inactive = plan.sessions.filter((session) => !isActiveTrainingSession(session));

    expect(active).toHaveLength(2);
    expect(active.every((session) => ['scheduled', 'compressed', 'capped', 'reflowed'].includes(session.scheduleState ?? ''))).toBe(true);
    expect(inactive.some((session) => session.scheduleState === 'unscheduled')).toBe(true);
    expect(plan.guardrailResults.some((result) => result.ruleId === 'capacity_weekly_active_session_cap')).toBe(true);
    expect(plan.decisionReasons?.some((reason) => reason.code === 'weekly_frequency_capped')).toBe(true);
    expect(plan.decisionReasons?.some((reason) => reason.code === 'session_unscheduled')).toBe(true);
    expect(plan.notes.some((note) => note.startsWith('Plan adjustment:'))).toBe(true);
    expectActiveSessionsInsideWindows(athlete, active);
  });

  it('reconciles a reduced-availability hybrid gym and running week without forcing sessions into invalid days', () => {
    const persona = trainingEvalPersonaBank.find((item) => item.id === 'hybrid-gym-running')!;
    const scenario = trainingEvalScenarioBank.find((item) => item.id === 'reduced-available-time')!;
    const athlete = scenario.apply({ persona, weekStart: '2026-04-27' });

    const plan = buildWeekPlan(athlete, '2026-04-27');
    const active = activeSessions(plan);
    const activeByDay = active.reduce<Record<string, number>>((acc, session) => {
      acc[session.dayOfWeek] = (acc[session.dayOfWeek] ?? 0) + 1;
      return acc;
    }, {});

    expect(active.length).toBeLessThanOrEqual(athlete.availability.weeklyWindows.length);
    expect(Object.values(activeByDay).every((count) => count <= athlete.availability.maxSessionsPerDay)).toBe(true);
    expectActiveSessionsInsideWindows(athlete, active);
    expect(plan.sessions.some((session) =>
      ['compressed', 'capped', 'reflowed', 'unscheduled'].includes(session.scheduleState ?? '')
    )).toBe(true);
  });

  it('does not create impossible cycling and strength density when recovery spacing and slots are both constrained', () => {
    const persona = trainingEvalPersonaBank.find((item) => item.id === 'hybrid-gym-cycling')!;
    const athlete: AthleteState = {
      ...persona.athlete,
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '06:30', end: '07:05', sports: ['cycling'] },
          { dayOfWeek: 'wednesday', start: '12:00', end: '12:35', sports: ['strength'] },
          { dayOfWeek: 'friday', start: '06:30', end: '07:05', sports: ['cycling', 'strength'] },
        ],
        preferredTimesBySport: { cycling: '06:30', strength: '12:00' },
        maxSessionsPerDay: 1,
      },
      constraints: [
        ...persona.athlete.constraints,
        { id: 'compressed-bike-gym', type: 'time', severity: 'high', description: 'Only three short slots are available this week.' },
      ],
    };

    const plan = buildWeekPlan(athlete, '2026-04-27');
    const active = activeSessions(plan);

    expect(active.length).toBeLessThanOrEqual(3);
    expectActiveSessionsInsideWindows(athlete, active);
    expect(plan.guardrailResults.some((result) => result.ruleId === 'capacity_weekly_active_session_cap')).toBe(true);
  });

  it('marks every session unscheduled when no valid weekly slot exists instead of inventing missing times', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      availability: {
        ...sampleHybridAthlete.availability,
        weeklyWindows: [],
        maxSessionsPerDay: 1,
      },
      constraints: [
        ...sampleHybridAthlete.constraints,
        { id: 'no-valid-slots', type: 'time', severity: 'high', description: 'No valid training window exists this week.' },
      ],
    };

    const plan = buildWeekPlan(athlete, '2026-04-27');

    expect(activeSessions(plan)).toHaveLength(0);
    expect(plan.sessions.filter((session) => session.scheduleState === 'unscheduled').length).toBeGreaterThan(0);
    expect(plan.sessions.every((session) => !session.startTime && !session.endTime)).toBe(true);
  });

  it('calendar payloads include only capacity-valid scheduled sessions', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        weeklySessionsTarget: { running: 3, strength: 2 },
      },
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '06:30', end: '07:05', sports: ['running'] },
          { dayOfWeek: 'wednesday', start: '12:00', end: '12:35', sports: ['strength'] },
          { dayOfWeek: 'friday', start: '06:30', end: '07:05', sports: ['running', 'strength'] },
        ],
        preferredTimesBySport: { running: '06:30', strength: '12:00' },
        maxSessionsPerDay: 1,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-04-27');
    const events = syncCalendar(plan);

    expect(events).toHaveLength(activeSessions(plan).length);
    expect(events.length).toBeLessThanOrEqual(3);
    expect(plan.sessions.some((session) => session.scheduleState === 'unscheduled')).toBe(true);
  });

  it('attaches evidence-based explanations when a session is reflowed and compressed', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '06:30', end: '07:00', sports: ['running'], label: 'short run window' },
        ],
        preferredTimesBySport: { running: '06:30' },
        maxSessionsPerDay: 1,
      },
      constraints: [
        { id: 'short-week', type: 'time', severity: 'high', description: 'Only one short training window is available this week.' },
      ],
    };
    const session: Session = {
      id: 'run-threshold-1',
      sport: 'running',
      sessionType: 'threshold_run',
      title: 'Threshold Run',
      description: 'Controlled threshold work.',
      dayOfWeek: 'wednesday',
      startTime: '06:30',
      durationMinutes: 45,
      intensityZone: 'threshold',
      fatigueCost: 'high',
      keySession: true,
      plannedLoad: 75,
      tags: ['key_running'],
    };

    const result = reconcileWeeklyCapacity(athlete, [session]);
    const placed = result.sessions[0];

    expect(placed.scheduleAdjustments).toEqual(expect.arrayContaining(['reflowed', 'compressed']));
    expect(placed.decisionReasons?.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'session_reflowed',
      'session_compressed',
    ]));
    const reflow = placed.decisionReasons?.find((reason) => reason.code === 'session_reflowed');
    expect(reflow?.text).toContain('Threshold Run moved from wednesday to monday');
    expect(reflow?.before).toMatchObject({ dayOfWeek: 'wednesday', startTime: '06:30' });
    expect(reflow?.after).toMatchObject({ dayOfWeek: 'monday', startTime: '06:30' });
    expect(reflow?.preservedIntent).toBe('Preserved the key running threshold run intent.');
    const compression = placed.decisionReasons?.find((reason) => reason.code === 'session_compressed');
    expect(compression?.before).toMatchObject({ durationMinutes: 45 });
    expect(compression?.after).toMatchObject({ durationMinutes: 30, capacityMinutes: 30 });
    expect(compression?.sourceConstraint).toMatchObject({ type: 'time', id: 'short-week' });
  });

  it('does not use a two-a-day allowance to stack two strength sessions in the same strength window', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      goals: {
        ...sampleHybridAthlete.goals,
        primaryFocus: 'strength',
        priorityOrder: ['strength'],
        weeklySessionsTarget: { strength: 2 },
        weeklyMinutesTarget: { strength: 90 },
      },
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'saturday', start: '11:00', end: '13:00', sports: ['strength'], label: 'Saturday strength window' },
        ],
        preferredTimesBySport: { strength: '12:00' },
        maxSessionsPerDay: 2,
      },
    };
    const sessions: Session[] = [
      {
        id: 'strength-upper-b',
        sport: 'strength',
        sessionType: 'strength_maintenance',
        title: 'Runner Upper Body Strength B',
        description: 'Upper support lift.',
        dayOfWeek: 'saturday',
        durationMinutes: 38,
        intensityZone: 'aerobic',
        fatigueCost: 'medium',
        keySession: false,
        plannedLoad: 38,
        tags: ['upper_body'],
      },
      {
        id: 'strength-upper-a',
        sport: 'strength',
        sessionType: 'strength_maintenance',
        title: 'Runner Upper Body Strength A',
        description: 'Upper support lift.',
        dayOfWeek: 'saturday',
        durationMinutes: 48,
        intensityZone: 'aerobic',
        fatigueCost: 'medium',
        keySession: false,
        plannedLoad: 48,
        tags: ['upper_body'],
      },
    ];

    const result = reconcileWeeklyCapacity(athlete, sessions);
    const activeStrength = result.sessions.filter((session) => session.sport === 'strength' && isActiveTrainingSession(session));
    const unscheduledStrength = result.sessions.filter((session) => session.sport === 'strength' && session.scheduleState === 'unscheduled');

    expect(activeStrength).toHaveLength(1);
    expect(activeStrength[0].dayOfWeek).toBe('saturday');
    expect(activeStrength[0].startTime).toBe('12:00');
    expect(unscheduledStrength).toHaveLength(1);
    expect(result.decisionReasons.some((reason) => reason.code === 'session_unscheduled')).toBe(true);
  });
});
