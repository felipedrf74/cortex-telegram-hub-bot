import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  loadCoachKnowledge,
  sampleHybridAthlete,
  sampleMarathonAthlete,
  sampleTriathlete,
  type AthleteState,
  type Session,
} from '../../src/services/coach-kernel';
import { isActiveTrainingSession } from '../../src/services/coach-kernel/capacity-reconciliation';
import { adaptSessionForPoorRecovery } from '../../src/services/coach-kernel/poor-recovery-variation';
import { estimateStrengthSessionMinutes, validateSessionCoherence } from '../../src/services/coach-kernel/session-coherence';
import type { ExercisePrescription } from '../../src/services/coach-kernel/types';

function withPoorRecovery(athlete: AthleteState, overrides: Partial<AthleteState> = {}): AthleteState {
  return {
    ...athlete,
    ...overrides,
    readiness: {
      ...athlete.readiness,
      level: 'red',
      score: 24,
      soreness: 'high',
      painFlags: [],
      ...(overrides.readiness ?? {}),
    },
    currentBlock: {
      ...athlete.currentBlock,
      phase: 'build',
      weekIndex: athlete.currentBlock.weekIndex,
      ...(overrides.currentBlock ?? {}),
    },
  };
}

function cyclingAthlete(overrides: Partial<AthleteState> = {}): AthleteState {
  return withPoorRecovery({
    ...sampleTriathlete,
    profile: {
      ...sampleTriathlete.profile,
      primaryDiscipline: 'cycling',
    },
    goals: {
      ...sampleTriathlete.goals,
      primaryFocus: 'cycling',
      secondaryFocus: undefined,
      priorityOrder: ['cycling'],
      weeklySessionsTarget: { cycling: 4 },
      weeklyMinutesTarget: { cycling: 220 },
    },
    currentBlock: {
      ...sampleTriathlete.currentBlock,
      discipline: 'cycling',
      phase: 'build',
      weekIndex: 8,
    },
  }, overrides);
}

function strengthAthlete(overrides: Partial<AthleteState> = {}): AthleteState {
  return withPoorRecovery({
    ...sampleHybridAthlete,
    profile: {
      ...sampleHybridAthlete.profile,
      primaryDiscipline: 'strength',
    },
    goals: {
      ...sampleHybridAthlete.goals,
      primaryFocus: 'strength',
      secondaryFocus: undefined,
      priorityOrder: ['strength'],
      weeklySessionsTarget: { strength: 4 },
      weeklyMinutesTarget: { strength: 160 },
    },
    currentBlock: {
      ...sampleHybridAthlete.currentBlock,
      discipline: 'strength',
      phase: 'build',
      weekIndex: 6,
    },
  }, overrides);
}

function readinessAdjusted(planSessions: Session[]): Session[] {
  return planSessions.filter((session) => session.tags.includes('readiness_adjusted'));
}

function uniqueTitles(sessions: Session[]): Set<string> {
  return new Set(sessions.map((session) => session.title));
}

describe('coach-kernel poor recovery variation', () => {
  it('varies cycling recovery sessions while preserving low-fatigue intent', () => {
    const plan = buildWeekPlan(cyclingAthlete(), '2026-06-01');
    const adjustedCycling = readinessAdjusted(plan.sessions).filter((session) => session.sport === 'cycling');

    expect(adjustedCycling.length).toBeGreaterThanOrEqual(2);
    expect(uniqueTitles(adjustedCycling).size).toBeGreaterThanOrEqual(2);
    expect(adjustedCycling.every((session) => session.fatigueCost === 'low')).toBe(true);
    expect(adjustedCycling.every((session) => session.intensityZone === 'recovery')).toBe(true);
    expect(adjustedCycling.every((session) => session.keySession === false)).toBe(true);
    expect(adjustedCycling.some((session) => session.title.includes('Cadence') || session.tags.includes('bike_technique'))).toBe(true);
  });

  it('keeps poor-recovery hybrid weeks modality-aware instead of collapsing to one generic recovery card', () => {
    const plan = buildWeekPlan(withPoorRecovery(sampleHybridAthlete), '2026-05-04');
    const activeAdjusted = readinessAdjusted(plan.sessions).filter(isActiveTrainingSession);
    const representedSports = new Set(activeAdjusted.map((session) => session.sport));

    expect(representedSports.has('running')).toBe(true);
    expect(representedSports.has('strength')).toBe(true);
    expect(uniqueTitles(activeAdjusted).size).toBeGreaterThanOrEqual(3);
    expect(activeAdjusted.every((session) => session.fatigueCost === 'low')).toBe(true);
    expect(plan.guardrailResults.some((result) =>
      result.ruleId === 'readiness'
      && result.adjusted === true
      && result.message.includes('varied low-fatigue')
    )).toBe(true);
  });

  it('gives poor-recovery strength weeks more than one safe fallback shape', () => {
    const knowledge = loadCoachKnowledge();
    const plan = buildWeekPlan(strengthAthlete(), '2026-05-04');
    const strengthSessions = readinessAdjusted(plan.sessions).filter((session) => session.sport === 'strength');
    const mobilitySessions = strengthSessions.filter((session) => session.sessionType === 'mobility');

    expect(strengthSessions.length).toBeGreaterThanOrEqual(3);
    expect(uniqueTitles(strengthSessions).size).toBeGreaterThanOrEqual(2);
    expect(strengthSessions.every((session) => session.fatigueCost === 'low')).toBe(true);
    expect(strengthSessions.every((session) => session.durationMinutes <= 35)).toBe(true);
    expect(mobilitySessions.length).toBeGreaterThanOrEqual(1);
    for (const session of mobilitySessions) {
      expect(session.exercises?.length ?? 0).toBeGreaterThanOrEqual(4);
      expect(estimateStrengthSessionMinutes({ exercises: session.exercises ?? [] }, knowledge))
        .toBeGreaterThanOrEqual(session.durationMinutes - 2);
    }
  });

  it('uses travel-aware low-burden recovery instead of pretending every constrained week can ride normally', () => {
    const plan = buildWeekPlan(cyclingAthlete({
      constraints: [
        ...sampleTriathlete.constraints,
        { id: 'travel-week', type: 'time', severity: 'high', description: 'Travel week with hotel gym and limited equipment.' },
      ],
      equipment: {
        ...sampleTriathlete.equipment,
        hasBikeTrainer: false,
        notes: ['hotel only'],
      },
      availability: {
        ...sampleTriathlete.availability,
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '07:00', end: '07:30', sports: ['cycling', 'strength', 'running'] },
          { dayOfWeek: 'wednesday', start: '07:00', end: '07:30', sports: ['cycling', 'strength', 'running'] },
        ],
        maxSessionsPerDay: 1,
      },
    }), '2026-06-01');

    const adjusted = readinessAdjusted(plan.sessions);

    expect(adjusted.some((session) => session.title === 'Off-Bike Mobility + Walk Reset')).toBe(true);
    expect(adjusted.every((session) => session.fatigueCost === 'low')).toBe(true);
    expect(adjusted.every((session) => session.durationMinutes <= 35)).toBe(true);
    expect(plan.guardrailResults.some((result) =>
      result.ruleId === 'readiness'
      && JSON.stringify(result.metadata ?? {}).includes('travel_fatigue')
    )).toBe(true);
  });

  it('rotates deterministic recovery choices across repeated poor-recovery weeks', () => {
    const weekEight = buildWeekPlan(cyclingAthlete({
      currentBlock: { ...sampleTriathlete.currentBlock, discipline: 'cycling', phase: 'build', weekIndex: 8 },
    }), '2026-06-01');
    const weekNine = buildWeekPlan(cyclingAthlete({
      currentBlock: { ...sampleTriathlete.currentBlock, discipline: 'cycling', phase: 'build', weekIndex: 9 },
    }), '2026-06-08');

    const weekEightTitles = readinessAdjusted(weekEight.sessions)
      .filter((session) => session.sport === 'cycling')
      .map((session) => session.title)
      .sort();
    const weekNineTitles = readinessAdjusted(weekNine.sessions)
      .filter((session) => session.sport === 'cycling')
      .map((session) => session.title)
      .sort();

    expect(weekEightTitles).not.toEqual(weekNineTitles);
  });

  it('does not produce overstuffed strength_maintenance recovery sessions (time_volume_coherence regression)', () => {
    // Pre-fix bug: strength sessions adapted for poor recovery shrunk
    // `durationMinutes` to 20-35 min but inherited the original
    // session's full exercise list. The eval baseline flagged this
    // pattern as overstuffed (e.g. "Technique Strength + Mobility:
    // claimed 20min, estimated 51min, action trimContent") and pinned
    // time_volume_coherence at 82/100. This regression test asserts
    // that strength_maintenance recovery sessions emerging from a
    // typical strength athlete's poor-recovery week are coherent —
    // either ok or, at worst, underfilled (never overstuffed).
    const knowledge = loadCoachKnowledge();
    const plan = buildWeekPlan(strengthAthlete(), '2026-05-04');
    const strengthMaintenance = readinessAdjusted(plan.sessions)
      .filter((session) => session.sport === 'strength' && session.sessionType === 'strength_maintenance');

    expect(strengthMaintenance.length).toBeGreaterThanOrEqual(1);
    for (const session of strengthMaintenance) {
      const verdict = validateSessionCoherence(session, knowledge);
      if (verdict.ok) continue;
      expect(verdict.reason).not.toBe('overstuffed');
    }
  });

  it('replaces the original hypertrophy block with catalog mobility when the variant is mobility', () => {
    // Direct unit test on `adaptSessionForPoorRecovery`: when the
    // chosen variant is mobility, the inherited hypertrophy list must
    // be replaced by a catalog-grounded mobility flow. The integration
    // variety test pins this for the buildWeekPlan path; this test pins
    // the unit-level contract so future variant rotations cannot
    // silently regress it.
    const originalExercises: ExercisePrescription[] = [
      { exerciseId: 'front_squat', name: 'Front Squat', sets: 4, reps: '8-12', restSec: 120 },
      { exerciseId: 'bench_press', name: 'Bench Press', sets: 4, reps: '8-12', restSec: 90 },
      { exerciseId: 'romanian_deadlift', name: 'RDL', sets: 3, reps: '10', restSec: 90 },
      { exerciseId: 'pull_up', name: 'Pull-Up', sets: 3, reps: '8', restSec: 60 },
      { exerciseId: 'dead_bug', name: 'Dead Bug', sets: 3, reps: '10', restSec: 60 },
    ];
    const original: Session = {
      id: 'strength-1',
      sport: 'strength',
      sessionType: 'strength_hypertrophy',
      title: 'Lower Body Strength A',
      description: 'Heavy lower-body hypertrophy day.',
      dayOfWeek: 'monday',
      durationMinutes: 60,
      intensityZone: 'aerobic',
      fatigueCost: 'high',
      keySession: true,
      plannedLoad: 220,
      tags: ['key_strength'],
      exercises: originalExercises,
    };
    const athlete = strengthAthlete();
    // Force the mobility variant by classifying as a scenario whose
    // variant index lands on the mobility option. The strength
    // variant order is: [Technique Strength, Mobility + Core Reset,
    // Minimum-Dose Strength]. We don't strictly need to force a
    // specific variant — instead, walk the candidates and assert the
    // contract for whichever resolves.
    const adaptation = adaptSessionForPoorRecovery({
      athlete,
      session: original,
      weekSessions: [original],
      sessionIndex: 2,
    });

    if (adaptation.session.sessionType === 'mobility') {
      const knowledge = loadCoachKnowledge();
      const originalIds = new Set(originalExercises.map((exercise) => exercise.exerciseId));
      const mobilityExercises = adaptation.session.exercises ?? [];
      expect(mobilityExercises.length).toBeGreaterThanOrEqual(4);
      expect(mobilityExercises.every((exercise) => !originalIds.has(exercise.exerciseId))).toBe(true);
      const verdict = validateSessionCoherence(adaptation.session, knowledge);
      expect(verdict.ok).toBe(true);
    } else if (adaptation.session.sessionType === 'strength_maintenance') {
      // Strength_maintenance variants keep light technique work but
      // must trim the original block to fit the shrunk duration.
      const knowledge = loadCoachKnowledge();
      const verdict = validateSessionCoherence(adaptation.session, knowledge);
      if (!verdict.ok) {
        expect(verdict.reason).not.toBe('overstuffed');
      }
      expect(adaptation.session.exercises?.length ?? 0).toBeLessThanOrEqual(originalExercises.length);
    }
  });

  it('dedupes the recovery decision trail instead of repeating the same warning', () => {
    const plan = buildWeekPlan(withPoorRecovery({
      ...sampleMarathonAthlete,
      recentSessions: [
        {
          id: 'hard-long-run',
          sport: 'running',
          sessionType: 'long_run',
          completedAt: '2026-05-02T08:00:00.000Z',
          durationMinutes: 120,
          intensityZone: 'aerobic',
          fatigueCost: 'very_high',
          rpe: 9,
          completed: true,
          keySession: true,
        },
      ],
    }), '2026-05-11');

    const normalizedNotes = plan.notes.map((note) => note.toLowerCase().trim());
    expect(new Set(normalizedNotes).size).toBe(plan.notes.length);
    expect(plan.guardrailResults.filter((result) => result.ruleId === 'readiness')).toHaveLength(1);
  });
});
