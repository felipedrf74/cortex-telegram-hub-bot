import { describe, expect, it } from 'vitest';

import {
  analyzeTrainingFeedback,
  applyFeedbackToWeeklyPlan,
  applyFeedbackToAthleteState,
  buildWeekPlan,
  loadCoachKnowledge,
  sampleHybridAthlete,
  type AthleteState,
  type RecentSession,
  type TrainingFeedbackAnalysis,
  type WeeklyPlan,
} from '../../src/services/coach-kernel';
import { trainingEvalPersonaBank } from '../../src/services/coach-kernel/evaluation';
import { validateSessionCoherence } from '../../src/services/coach-kernel/session-coherence';
import { buildAthleteStateFromTrainingProfiles } from '../../src/services/training-coach-kernel-plan-generator';

function recent(overrides: Partial<RecentSession> = {}): RecentSession {
  return {
    id: overrides.id ?? `recent-${Math.random()}`,
    sport: overrides.sport ?? 'strength',
    sessionType: overrides.sessionType ?? 'strength_hypertrophy',
    completedAt: overrides.completedAt ?? '2026-04-24T12:00:00.000Z',
    durationMinutes: overrides.durationMinutes ?? 45,
    plannedDurationMinutes: overrides.plannedDurationMinutes ?? 45,
    actualDurationMinutes: overrides.actualDurationMinutes ?? overrides.durationMinutes ?? 45,
    intensityZone: overrides.intensityZone ?? 'aerobic',
    fatigueCost: overrides.fatigueCost ?? 'medium',
    completed: overrides.completed ?? true,
    completionStatus: overrides.completionStatus,
    rpe: overrides.rpe,
    rir: overrides.rir,
    sorenessLevel: overrides.sorenessLevel,
    feedbackTags: overrides.feedbackTags,
    keySession: overrides.keySession,
    missedReason: overrides.missedReason,
  };
}

function athlete(overrides: Partial<AthleteState> = {}): AthleteState {
  return {
    ...sampleHybridAthlete,
    readiness: {
      ...sampleHybridAthlete.readiness,
      level: 'green',
      score: 86,
      soreness: 'low',
    },
    compliance: {
      trailing14DayCompliance: 0.86,
      bySport: { running: 0.85, strength: 0.86 },
      missedKeySessions: 0,
      consecutiveMisses: 0,
    },
    recentSessions: [],
    ...overrides,
  };
}

function totalMinutes(state: AthleteState): number {
  return buildWeekPlan(state, '2026-05-04').sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
}

describe('coach-kernel feedback analysis and autoregulation', () => {
  it('turns hard feedback, soreness, and low recovery into a deload decision that changes the plan', () => {
    const base = athlete();
    const strained = athlete({
      readiness: { ...base.readiness, level: 'orange', score: 48 },
      recentSessions: [
        recent({ rpe: 9, sorenessLevel: 8, feedbackTags: ['too_hard'] }),
        recent({ rpe: 9, sorenessLevel: 8, feedbackTags: ['pain'] }),
        recent({ sport: 'running', sessionType: 'threshold_run', intensityZone: 'threshold', fatigueCost: 'high', rpe: 8.8, sorenessLevel: 7 }),
      ],
    });

    const analysis = analyzeTrainingFeedback(strained, '2026-04-27T08:00:00.000Z');
    expect(analysis.recoveryClass).toBe('strained');
    expect(analysis.difficultyBias).toBe('too_hard');
    expect(analysis.progressionState).toBe('deload');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('high_soreness_downshift');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('too_hard_intensity_downshift');

    const baseMinutes = totalMinutes(base);
    const strainedPlan = buildWeekPlan(strained, '2026-05-04');

    expect(strainedPlan.phase).toBe('deload');
    expect(strainedPlan.notes.some((note) => note.includes('Feedback loop:'))).toBe(true);
    expect(strainedPlan.sessions.reduce((sum, session) => sum + session.durationMinutes, 0)).toBeLessThan(baseMinutes);
    expect(strainedPlan.sessions.some((session) => session.tags.includes('feedback_deload'))).toBe(true);
  });

  it('preserves movement-pattern variety across a four-week fatigue deload block', () => {
    const generatedState = buildAthleteStateFromTrainingProfiles({
      userId: 1_000_019,
      objective: 'Recovery-led plateau reset',
      durationWeeks: 4,
      startDate: '2026-05-04',
      sessionsPerWeek: 3,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      longWorkoutDay: 'Saturday',
      notes: 'Fixture-only canonical persona fatigue_plateau.',
      fitnessProfile: {
        experience_level: 'Intermediate (1-3 years)',
        weekly_frequency: '2-3 days',
        preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
        blocked_days: 'Friday',
        training_goals: 'Endurance, Strength',
        injuries: 'none',
        available_equipment: 'Full gym',
      },
      gymProfile: {
        training_age: '3-5 years',
        current_split: 'No preference',
        primary_goal: 'Support other sports',
        squat_1rm_kg: '115',
        bench_1rm_kg: '82',
        deadlift_1rm_kg: '150',
        sessions_per_week: '1-2',
        preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
        blocked_days: 'Friday',
        equipment_access: 'Full commercial gym',
        session_duration_minutes: '60',
      },
      runProfile: {
        weekly_mileage_km: '32',
        longest_recent_run_km: '14',
        easy_pace_min_per_km: '5:45',
        target_race: 'None — general fitness',
        target_race_date: 'none',
        preferred_workouts: 'Easy runs, Tempo, Long runs',
        injury_history: 'none',
        weekly_availability_days: '5',
        preferred_training_days: 'Tuesday, Thursday, Saturday, Sunday',
        blocked_days: 'Friday',
      },
      goalMode: 'continuous',
      trainingPriority: 'hybrid',
      twoADayPreference: 'never',
      currentReadiness: { score: 25 },
    });
    const fatigueState: AthleteState = {
      ...generatedState,
      readiness: {
        ...generatedState.readiness,
        level: 'red',
        score: 25,
        soreness: 'high',
        sleepHours: 3.5,
        hrvStatus: 'low',
        energyReserve: 20,
      },
      compliance: {
        trailing14DayCompliance: 1,
        bySport: { running: 1, strength: 1 },
        missedKeySessions: 0,
        consecutiveMisses: 0,
      },
      recentSessions: [
        recent({ id: 'fatigue-threshold', sport: 'running', sessionType: 'threshold_run', intensityZone: 'threshold', fatigueCost: 'high', rpe: 9, sorenessLevel: 8, keySession: true }),
        recent({ id: 'fatigue-interval', sport: 'running', sessionType: 'interval_run', intensityZone: 'vo2', fatigueCost: 'high', rpe: 9, sorenessLevel: 8, keySession: true }),
        recent({ id: 'fatigue-long', sport: 'running', sessionType: 'long_run', intensityZone: 'aerobic', fatigueCost: 'high', rpe: 9, sorenessLevel: 8, keySession: true }),
      ],
    };
    const weekStarts = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'];
    const block = weekStarts.map((weekStart, index) => buildWeekPlan({
      ...fatigueState,
      // Production only carries today's severe readiness into week one;
      // later planned weeks use the neutral yellow canary posture while the
      // same recent high-strain history continues to drive deload shaping.
      readiness: index === 0
        ? fatigueState.readiness
        : { ...fatigueState.readiness, level: 'yellow' as const, score: 70, soreness: 'moderate' as const },
      currentBlock: {
        ...fatigueState.currentBlock,
        phase: index === 3 ? 'deload' : index < 2 ? 'base' : 'build',
        weekIndex: index + 1,
        totalWeeks: weekStarts.length,
      },
    }, weekStart));
    const strengthSessions = block.flatMap((week) =>
      week.sessions.filter((session) => session.sport === 'strength' && session.exercises?.length)
    );
    const movementByExerciseId = new Map(
      loadCoachKnowledge().exercises.map((exercise) => [exercise.id, exercise.movementPattern]),
    );
    const exerciseIds = strengthSessions.flatMap((session) =>
      (session.exercises ?? []).map((exercise) => exercise.exerciseId ?? '')
    );
    const movementPatterns = new Set(
      exerciseIds.map((exerciseId) => movementByExerciseId.get(exerciseId)).filter(Boolean),
    );

    // A recovery-led block must remove hard work without collapsing every
    // strength prescription into the same squat/hinge pair.
    expect(block.flatMap((week) => week.sessions).every((session) =>
      session.keySession === false
      && session.fatigueCost !== 'high'
      && session.fatigueCost !== 'very_high'
    )).toBe(true);
    const adaptedEndurance = block.flatMap((week) => week.sessions)
      .filter((session) => session.sport !== 'strength');
    // The public structured metadata is part of the prescription. A recovery
    // title/zone paired with the original VO2 or threshold summary would make
    // the read model advertise work the guardrail explicitly removed.
    expect(adaptedEndurance.every((session) =>
      session.intensitySummary?.primaryZone === session.intensityZone
      && session.intensityProfile?.primaryZone === session.intensityZone
    )).toBe(true);
    expect(adaptedEndurance.every((session) =>
      session.intensitySummary?.highPct === 0
      && !/threshold|vo2/i.test(session.intensitySummary?.targetSummaryText ?? '')
    )).toBe(true);
    expect(new Set(strengthSessions.map((session) =>
      (session.exercises ?? []).map((exercise) => exercise.exerciseId).join('|')
    )).size).toBeGreaterThanOrEqual(3);
    expect(
      movementPatterns.size,
      `four-week recovery strength ids: ${JSON.stringify(exerciseIds)}`,
    ).toBeGreaterThanOrEqual(3);
    for (const session of strengthSessions) {
      const coherence = validateSessionCoherence(session, loadCoachKnowledge());
      expect(coherence.reason).not.toBe('overstuffed');
    }
    const firstWeekStrength = block[0].sessions.find((session) => session.sport === 'strength');
    expect(firstWeekStrength?.exercises?.every((exercise) =>
      exercise.sets <= 2 && (exercise.rir ?? 0) >= 4
    )).toBe(true);
  });

  it('uses poor adherence and missed sessions as a re-entry signal instead of regenerating the same volume', () => {
    const fragile = athlete({
      compliance: {
        trailing14DayCompliance: 0.38,
        bySport: { running: 0.25, strength: 0.4 },
        missedKeySessions: 1,
        consecutiveMisses: 3,
      },
      recentSessions: [
        recent({ completed: false, completionStatus: 'skipped', missedReason: 'work', keySession: true }),
        recent({ completed: false, completionStatus: 'skipped', missedReason: 'travel' }),
        recent({ completed: true, completionStatus: 'partial', plannedDurationMinutes: 60, actualDurationMinutes: 24 }),
      ],
    });

    const analysis = analyzeTrainingFeedback(fragile);
    const adjusted = applyFeedbackToAthleteState(fragile, analysis);

    expect(analysis.adherenceClass).toBe('broken');
    expect(analysis.progressionState).toBe('reentry');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('poor_adherence_reentry');
    expect(adjusted.goals.weeklySessionsTarget.strength).toBeLessThan(fragile.goals.weeklySessionsTarget.strength ?? 0);
    expect(adjusted.goals.weeklySessionsTarget.running).toBeLessThan(fragile.goals.weeklySessionsTarget.running ?? 0);
    expect(adjusted.availability.maxSessionsPerDay).toBe(1);
  });

  it('progresses prescriptions when feedback says work is easy and recovery/adherence are strong', () => {
    const steady = athlete();
    const easy = athlete({
      compliance: {
        trailing14DayCompliance: 0.95,
        bySport: { running: 0.95, strength: 0.95 },
        missedKeySessions: 0,
        consecutiveMisses: 0,
      },
      recentSessions: [
        recent({ rpe: 5, rir: 4, feedbackTags: ['too_easy'] }),
        recent({ rpe: 5, rir: 4, feedbackTags: ['underload'] }),
        recent({ rpe: 5.2, rir: 5 }),
      ],
    });

    const analysis = analyzeTrainingFeedback(easy);
    const easyPlan = buildWeekPlan(easy, '2026-05-04');
    const steadyPlan = buildWeekPlan(steady, '2026-05-04');
    const progressedStrength = easyPlan.sessions.find((session) => session.sport === 'strength' && session.exercises?.length);
    const steadyStrength = steadyPlan.sessions.find((session) => session.sport === 'strength' && session.exercises?.length);

    expect(analysis.difficultyBias).toBe('too_easy');
    expect(analysis.progressionState).toBe('build');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('too_easy_progression');
    expect(progressedStrength?.tags).toContain('feedback_progression');
    expect(progressedStrength!.exercises![0].sets).toBeGreaterThan(steadyStrength!.exercises![0].sets);
  });

  it('caps session duration when feedback says sessions are taking too long', () => {
    const baseline = athlete();
    const tooLong = athlete({
      recentSessions: [
        recent({ plannedDurationMinutes: 45, actualDurationMinutes: 65, feedbackTags: ['too_long'] }),
        recent({ plannedDurationMinutes: 45, actualDurationMinutes: 62 }),
        recent({ sport: 'running', sessionType: 'easy_run', plannedDurationMinutes: 40, actualDurationMinutes: 55 }),
      ],
    });

    const analysis = analyzeTrainingFeedback(tooLong);
    expect(analysis.difficultyBias).toBe('too_long');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('too_long_duration_cap');

    expect(totalMinutes(tooLong)).toBeLessThan(totalMinutes(baseline));
    expect(buildWeekPlan(tooLong, '2026-05-04').notes.some((note) => note.includes('taking materially longer'))).toBe(true);
  });

  it('still emits an intensity downshift when too_long feedback is also too_hard', () => {
    const overloaded = athlete({
      recentSessions: [
        recent({ plannedDurationMinutes: 45, actualDurationMinutes: 65, rpe: 9, feedbackTags: ['too_long', 'too_hard'] }),
        recent({ plannedDurationMinutes: 45, actualDurationMinutes: 64, rpe: 9 }),
        recent({ plannedDurationMinutes: 45, actualDurationMinutes: 63, rpe: 9 }),
      ],
    });

    const analysis = analyzeTrainingFeedback(overloaded);

    expect(analysis.difficultyBias).toBe('too_long');
    expect(analysis.decisions.map((decision) => decision.code)).toContain('too_hard_intensity_downshift');
  });

  it('applies volumeMultiplier to the weekly plan even when durationMultiplier is absent', () => {
    const plan: WeeklyPlan = {
      athleteId: 303,
      weekStart: '2026-05-04',
      discipline: 'running',
      phase: 'build',
      sessions: [{
        id: 'run',
        sport: 'running',
        sessionType: 'threshold_run',
        title: 'Threshold',
        description: 'Work.',
        dayOfWeek: 'tuesday',
        durationMinutes: 100,
        intensityZone: 'threshold',
        fatigueCost: 'high',
        keySession: true,
        plannedLoad: 130,
        tags: [],
      }],
      notes: [],
      guardrailResults: [],
    };
    const analysis: TrainingFeedbackAnalysis = {
      generatedAt: '2026-05-01T00:00:00.000Z',
      sampleSize: 1,
      completionCounts: { completed: 1, partial: 0, skipped: 0 },
      adherenceClass: 'steady',
      recoveryClass: 'ready',
      difficultyBias: 'balanced',
      progressionState: 'hold',
      decisions: [{
        code: 'missed_key_session_rebuild',
        severity: 'watch',
        reason: 'Missed key.',
        evidence: [],
        volumeMultiplier: 0.9,
      }],
      notes: [],
    };

    const adjusted = applyFeedbackToWeeklyPlan(plan, analysis);

    expect(adjusted.sessions[0].durationMinutes).toBe(90);
  });

  it('keeps reduced strength sessions time-volume coherent after feedback/guardrail duration cuts', () => {
    const persona = trainingEvalPersonaBank.find((item) => item.id === 'advanced-strength-focused')!;
    const reduced = {
      ...persona.athlete,
      readiness: {
        ...persona.athlete.readiness,
        level: 'yellow' as const,
        score: 62,
        soreness: 'moderate' as const,
      },
      compliance: {
        ...persona.athlete.compliance,
        trailing14DayCompliance: 0.68,
      },
    };
    const knowledge = loadCoachKnowledge();

    const plan = buildWeekPlan(reduced, '2026-04-27');
    const strengthSessions = plan.sessions.filter((session) => session.sport === 'strength' && session.exercises?.length);

    expect(strengthSessions.length).toBeGreaterThan(0);
    expect(strengthSessions.some((session) =>
      session.tags.includes('feedback_duration_coherent') || session.tags.includes('guardrail_duration_coherent')
    )).toBe(true);
    for (const session of strengthSessions) {
      const verdict = validateSessionCoherence(session, knowledge);
      expect(verdict.ok).toBe(true);
    }
  });

  it('turns poor adherence strength work into a minimum-effective-dose session instead of another hard-to-finish plan', () => {
    const reentry = athlete({
      goals: {
        ...sampleHybridAthlete.goals,
        weeklySessionsTarget: {
          ...sampleHybridAthlete.goals.weeklySessionsTarget,
          running: 2,
          cycling: 0,
          swimming: 0,
          strength: 1,
        },
      },
      compliance: {
        trailing14DayCompliance: 0.34,
        bySport: { strength: 0.3 },
        missedKeySessions: 1,
        consecutiveMisses: 3,
      },
      recentSessions: [
        recent({ completed: false, completionStatus: 'skipped', missedReason: 'work' }),
        recent({ completed: false, completionStatus: 'skipped', missedReason: 'family' }),
        recent({ completed: true, completionStatus: 'partial', plannedDurationMinutes: 50, actualDurationMinutes: 20 }),
      ],
    });

    const plan = buildWeekPlan(reentry, '2026-05-04');
    const strengthSession = plan.sessions.find((session) => session.sport === 'strength' && session.exercises?.length);

    expect(strengthSession).toBeDefined();
    expect(strengthSession?.tags).toContain('minimum_effective_dose');
    expect(strengthSession?.tags).toContain('adherence_realistic');
    expect(strengthSession?.durationMinutes).toBeLessThanOrEqual(20);
    expect(strengthSession?.exercises?.length).toBeLessThanOrEqual(2);
    expect(strengthSession?.exercises?.every((exercise) => exercise.sets <= 2)).toBe(true);
    expect(strengthSession?.exercises?.every((exercise) => (exercise.rir ?? 0) >= 3)).toBe(true);

    // Stronger guarantee: a re-entry week must not retain a long/key/hard
    // identity after its load was downshifted, and a four-week minimum-dose
    // block must rotate enough movement patterns to avoid a two-movement rut.
    const block = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25']
      .map((weekStart) => buildWeekPlan(reentry, weekStart));
    expect(block.every((week) => week.phase === 'deload')).toBe(true);
    const endurance = block.flatMap((week) => week.sessions.filter((session) => session.sport !== 'strength'));
    expect(endurance.length).toBeGreaterThan(0);
    expect(endurance.every((session) =>
      session.keySession === false
      && /easy|recovery/.test(session.sessionType)
      && !/long|threshold|interval|tempo|vo2/i.test(`${session.sessionType} ${session.title}`)
    )).toBe(true);
    expect(block.every((week) => week.notes.some((note) =>
      /maintenance\/recovery rationale:.*adherence.*(?:re-entry|consecutive miss)/i.test(note)
    ))).toBe(true);

    const movementByExerciseId = new Map(
      loadCoachKnowledge().exercises.map((exercise) => [exercise.id, exercise.movementPattern]),
    );
    const blockMovementPatterns = new Set(block.flatMap((week) =>
      week.sessions
        .filter((session) => session.sport === 'strength')
        .flatMap((session) => session.exercises ?? [])
        .map((exercise) => movementByExerciseId.get(exercise.exerciseId ?? ''))
        .filter((pattern): pattern is string => typeof pattern === 'string')
    ));
    expect(blockMovementPatterns.size).toBeGreaterThanOrEqual(3);
  });

  it('compresses strength sessions for declared low-time weeks without hiding the fallback rationale', () => {
    const lowTime = athlete({
      constraints: [
        ...sampleHybridAthlete.constraints,
        { id: 'work-crunch', type: 'time', severity: 'high', description: 'Only short windows this week.' },
      ],
    });

    const analysis = analyzeTrainingFeedback(lowTime);
    const plan = buildWeekPlan(lowTime, '2026-05-04');
    const strengthSession = plan.sessions.find((session) => session.sport === 'strength' && session.exercises?.length);

    expect(analysis.decisions.map((decision) => decision.code)).toContain('duration_compression');
    expect(strengthSession?.tags).toContain('minimum_effective_dose');
    expect(strengthSession?.durationMinutes).toBeLessThanOrEqual(25);
    expect(strengthSession?.exercises?.length).toBeLessThanOrEqual(3);
    expect(strengthSession?.alternatives?.some((item) => item.includes('time is still tight'))).toBe(true);
  });

  it('marks plateau sports for variation without inventing a random template', () => {
    const plateau = athlete({
      trainingHistory: {
        ...sampleHybridAthlete.trainingHistory,
        trailing4WeekMinutesBySport: {
          ...sampleHybridAthlete.trainingHistory.trailing4WeekMinutesBySport,
          strength: [120, 121, 119, 120],
        },
      },
      compliance: {
        trailing14DayCompliance: 0.82,
        bySport: { strength: 0.82 },
        missedKeySessions: 0,
        consecutiveMisses: 0,
      },
    });

    const analysis = analyzeTrainingFeedback(plateau);
    const plan = buildWeekPlan(plateau, '2026-05-04');

    expect(analysis.progressionState).toBe('variation');
    expect(analysis.decisions).toContainEqual(expect.objectContaining({ code: 'plateau_variation', sport: 'strength' }));
    expect(plan.sessions.some((session) => session.sport === 'strength' && session.tags.includes('plateau_variation'))).toBe(true);
  });
});
