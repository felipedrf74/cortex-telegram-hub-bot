import { describe, expect, it } from 'vitest';

import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
  type CoordinatedTrainingPlan,
} from '../../src/services/training-plan-coordination';

describe('training-plan-coordination', () => {
  it('derives real coach guardrails from cross-skill context', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: 'weekend',
      sharedDecisionContext: '<shared_decision_context domain="triathlon">budget mode is controlled</shared_decision_context>',
      fitnessProfile: {
        experience_level: 'Beginner (< 1 year)',
        injuries: 'left knee irritation',
      },
      runProfile: {
        injury_history: 'achilles flare-up',
      },
      training: {
        derivedSignals: [
          {
            signalType: 'recovery_state',
            payload: { state: 'strained' },
          },
        ],
      } as any,
      cooking: {
        derivedSignals: [
          {
            signalType: 'fueling_support_status',
            payload: { status: 'at_risk' },
          },
          {
            signalType: 'meal_execution_readiness',
            payload: { status: 'partial' },
          },
        ],
      } as any,
      finance: {
        derivedSignals: [
          {
            signalType: 'budget_remaining',
            payload: {
              budgetMode: 'controlled',
              trainingSpendMode: 'selective',
              supplementMode: 'pause_new',
            },
          },
        ],
      } as any,
      content: {
        filmingRecommendation: {
          date: '2026-04-18',
        },
      } as any,
    });

    expect(coordination.conservativeFirstWeek).toBe(true);
    expect(coordination.maxHardSessionsPerWeek).toBe(1);
    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.strengthSessionTarget).toBe(2);
    expect(coordination.resolvedLongWorkoutDay).toBe('sunday');
    expect(coordination.protectFilmingDay).toBe('saturday');
    expect(coordination.lowCostBias).toBe(true);
    expect(coordination.selectiveTrainingSpend).toBe(true);
    expect(coordination.progressionRampCapPct).toBe(4);
    expect(coordination.maxConsecutiveActiveDays).toBe(3);
    expect(coordination.protectImpactSpacing).toBe(true);
    expect(coordination.protectLowerBodySpacing).toBe(true);
    expect(coordination.promptBlock).toContain('Start week 1 conservatively');
    expect(coordination.promptBlock).toContain('Treat the athlete like a beginner');
    expect(coordination.promptBlock).toContain('Cap truly hard sessions at 1 per week');
    expect(coordination.promptBlock).toContain('Keep week-to-week intensity jumps within 4 points');
    expect(coordination.promptBlock).toContain('Anchor the longest session on Sunday');
    expect(coordination.promptBlock).toContain('Keep Saturday lower-fatigue');
    expect(coordination.promptBlock).toContain('Avoid recommending new paid equipment');
    expect(coordination.promptBlock).toContain('Keep non-key training locally executable');
    expect(coordination.promptBlock).toContain('Treat supplements as pause_new');
    expect(coordination.promptBlock).toContain('Avoid back-to-back impact-heavy run days');
    expect(coordination.promptBlock).toContain('Keep lower-body strength at least one easier day away');
  });

  it('applies coordination rules to fallback-style plans', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Marathon Build',
      sport: 'running',
      periodization: 'undulating',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 70,
          sessions: [
            {
              dayOfWeek: 'monday',
              sessionType: 'gym',
              title: 'Strength Session A',
              durationMinutes: 60,
              description: 'Lift.',
              exercises: [{ name: 'Squat' }],
            },
            {
              dayOfWeek: 'tuesday',
              sessionType: 'gym',
              title: 'Strength Session B',
              durationMinutes: 55,
              description: 'Lift.',
              exercises: [{ name: 'Deadlift' }],
            },
            {
              dayOfWeek: 'thursday',
              sessionType: 'run',
              title: 'Tempo Run',
              durationMinutes: 55,
              description: 'Threshold work.',
              exercises: [],
            },
            {
              dayOfWeek: 'saturday',
              sessionType: 'run',
              title: 'Long Run',
              durationMinutes: 90,
              description: 'Endurance work.',
              exercises: [],
            },
            {
              dayOfWeek: 'friday',
              sessionType: 'run',
              title: 'Easy Run',
              durationMinutes: 35,
              description: 'Easy work.',
              exercises: [],
            },
          ],
        },
      ],
    };

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      longWorkoutDay: 'sunday',
      training: null,
      cooking: {
        derivedSignals: [
          {
            signalType: 'fueling_support_status',
            payload: { status: 'at_risk' },
          },
        ],
      } as any,
      finance: {
        derivedSignals: [
          {
            signalType: 'budget_remaining',
            payload: {
              budgetMode: 'controlled',
              trainingSpendMode: 'selective',
              supplementMode: 'pause_new',
            },
          },
        ],
      } as any,
      content: {
        filmingRecommendation: {
          date: '2026-04-16',
        },
      } as any,
      sharedDecisionContext: '',
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week = result.weeks?.[0];
    const sunday = week?.sessions?.find((session) => session.title === 'Long Run');
    const thursday = week?.sessions?.find((session) => session.dayOfWeek === 'thursday');
    const mobilitySessions = week?.sessions?.filter((session) => session.sessionType === 'mobility') ?? [];
    const remainingGym = week?.sessions?.filter((session) => session.sessionType === 'gym') ?? [];

    expect(week?.intensityPct).toBe(62);
    expect(sunday?.dayOfWeek).toBe('sunday');
    expect(thursday?.title).toBe('Aerobic Support / Recovery');
    expect(mobilitySessions.length).toBeGreaterThanOrEqual(1);
    expect(remainingGym).toHaveLength(1);
    expect(week?.sessions?.every((session) => session.sessionType === 'rest' || session.description?.includes('Prefer the simplest execution option you already have available.') || session.description?.includes('Use current equipment only and skip any optional spend-heavy add-ons.') || session.sessionType === 'mobility')).toBe(true);
  });

  it('uses selective training spend to trim non-essential volume even without a recovery crisis', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: {
        derivedSignals: [
          {
            signalType: 'budget_remaining',
            payload: {
              budgetMode: 'normal',
              trainingSpendMode: 'selective',
              supplementMode: 'normal',
            },
          },
        ],
      } as any,
      content: null,
      sharedDecisionContext: '',
    });

    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.strengthSessionTarget).toBe(2);
    expect(coordination.maxHardSessionsPerWeek).toBe(2);
    expect(coordination.lowCostBias).toBe(true);
    expect(coordination.selectiveTrainingSpend).toBe(true);
    expect(coordination.promptBlock).toContain('Keep non-key training locally executable');
  });

  it('preserves explicit five-day strength targets for experienced full-gym plans', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
      longWorkoutDay: 'saturday',
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        available_equipment: 'Full gym',
      },
      gymProfile: {
        training_age: '5+ years',
        equipment_access: 'Full commercial gym',
      },
      training: null,
      cooking: null,
      finance: null,
      content: null,
      sharedDecisionContext: '',
      secretary: null,
    });

    expect(coordination.weeklySessionTarget).toBe(7);
    expect(coordination.strengthSessionTarget).toBe(5);
  });

  it('caps impossible strength targets at six instead of silently reverting to four', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 9,
      longWorkoutDay: 'saturday',
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        available_equipment: 'Full gym',
      },
      gymProfile: {
        training_age: '5+ years',
        equipment_access: 'Full commercial gym',
      },
      training: null,
      cooking: null,
      finance: null,
      content: null,
      sharedDecisionContext: '',
      secretary: null,
    });

    expect(coordination.strengthSessionTarget).toBe(6);
  });

  it('keeps the long run when capping weekly volume', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Advanced Marathon Hybrid',
      sport: 'running',
      periodization: 'block',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 72,
          sessions: [
            { dayOfWeek: 'monday', sessionType: 'run', title: 'Easy Aerobic Support', durationMinutes: 35, description: 'Filler.', exercises: [] },
            { dayOfWeek: 'monday', sessionType: 'gym', title: 'Upper Body Strength A', durationMinutes: 55, description: 'Lift.', exercises: [] },
            { dayOfWeek: 'tuesday', sessionType: 'run', title: 'Tempo Run', durationMinutes: 55, description: 'Quality.', exercises: [] },
            { dayOfWeek: 'wednesday', sessionType: 'gym', title: 'Lower Body Strength A', durationMinutes: 55, description: 'Lift.', exercises: [] },
            { dayOfWeek: 'thursday', sessionType: 'run', title: 'Recovery Run', durationMinutes: 40, description: 'Easy.', exercises: [] },
            { dayOfWeek: 'friday', sessionType: 'gym', title: 'Upper Body Strength B', durationMinutes: 55, description: 'Lift.', exercises: [] },
            { dayOfWeek: 'saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 110, description: 'Key marathon session.', exercises: [] },
            { dayOfWeek: 'sunday', sessionType: 'gym', title: 'Mobility Strength Support', durationMinutes: 40, description: 'Support.', exercises: [] },
          ],
        },
      ],
    };
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
      longWorkoutDay: 'saturday',
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
        available_equipment: 'Full gym',
      },
      gymProfile: {
        training_age: '5+ years',
        equipment_access: 'Full commercial gym',
      },
      training: null,
      cooking: null,
      finance: null,
      content: null,
      sharedDecisionContext: '',
      secretary: null,
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week = result.weeks?.[0];
    const activeTitles = (week?.sessions ?? [])
      .filter((session) => session.sessionType !== 'rest')
      .map((session) => session.title);

    expect(activeTitles).toContain('Long Run');
    expect(activeTitles.length).toBe(7);
  });

  it('adds safer spacing and progression caps for beginner injury-risk profiles', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Return to Run',
      sport: 'running',
      periodization: 'undulating',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 70,
          sessions: [
            {
              dayOfWeek: 'tuesday',
              sessionType: 'run',
              title: 'Tempo Run',
              durationMinutes: 50,
              description: 'Threshold work.',
              exercises: [],
            },
            {
              dayOfWeek: 'wednesday',
              sessionType: 'run',
              title: 'Easy Run',
              durationMinutes: 40,
              description: 'Easy aerobic work.',
              exercises: [],
            },
            {
              dayOfWeek: 'saturday',
              sessionType: 'run',
              title: 'Long Run',
              durationMinutes: 95,
              description: 'Long aerobic session.',
              exercises: [],
            },
            {
              dayOfWeek: 'sunday',
              sessionType: 'gym',
              title: 'Lower Body Strength',
              durationMinutes: 60,
              description: 'Strength support.',
              exercises: [{ name: 'Back Squat' }],
            },
          ],
        },
        {
          weekNumber: 2,
          intensityPct: 82,
          sessions: [],
        },
        {
          weekNumber: 3,
          intensityPct: 95,
          sessions: [],
        },
      ],
    };

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: 'saturday',
      fitnessProfile: {
        experience_level: 'Beginner (< 1 year)',
        injuries: 'right knee soreness',
      },
      runProfile: {
        injury_history: 'achilles discomfort',
      },
      training: null,
      cooking: null,
      finance: null,
      content: null,
      sharedDecisionContext: '',
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week1 = result.weeks?.[0];
    const week2 = result.weeks?.[1];
    const week3 = result.weeks?.[2];

    expect(week1?.intensityPct).toBe(62);
    expect(week2?.intensityPct).toBe(66);
    expect(week3?.intensityPct).toBe(56);
    expect(week1?.sessions?.find((session) => session.dayOfWeek === 'wednesday')?.title).toBe('Low-Impact Recovery');
    expect(week1?.sessions?.find((session) => session.dayOfWeek === 'sunday')?.title).toBe('Low-Impact Recovery');
    expect(week1?.sessions?.filter((session) => session.title === 'Long Run')).toHaveLength(1);
    expect(week1?.sessions?.find((session) => session.title === 'Tempo Run')?.title).not.toBe('Tempo Run');
  });

  it('consumes secretary travel and focus pressure when shaping the plan', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Hybrid Week',
      sport: 'hybrid',
      periodization: 'undulating',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 74,
          sessions: [
            {
              dayOfWeek: 'friday',
              sessionType: 'run',
              title: 'Tempo Run',
              durationMinutes: 60,
              description: 'Threshold work.',
              exercises: [],
            },
            {
              dayOfWeek: 'sunday',
              sessionType: 'run',
              title: 'Long Run',
              durationMinutes: 95,
              description: 'Long aerobic session.',
              exercises: [],
            },
            {
              dayOfWeek: 'monday',
              sessionType: 'run',
              title: 'Aerobic Run',
              durationMinutes: 65,
              description: 'Easy aerobic support.',
              exercises: [],
            },
          ],
        },
      ],
    };

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 1,
      longWorkoutDay: 'sunday',
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: {
        focusBlock: {
          date: '2026-04-17',
        },
        derivedSignals: [
          { signalType: 'travel_window', payload: { dates: ['2026-04-20'] } },
          { signalType: 'inbox_pressure', payload: { overdueCount: 4, dueTodayCount: 1, dueThisWeekCount: 6, pendingCount: 12 } },
        ],
      } as any,
      sharedDecisionContext: '',
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week = result.weeks?.[0];

    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.maxHardSessionsPerWeek).toBe(1);
    expect(coordination.modularSessionBias).toBe(true);
    expect(coordination.protectFocusDay).toBe('friday');
    expect(coordination.promptBlock).toContain('Travel is currently flagged on Monday');
    expect(coordination.promptBlock).toContain('Bias toward modular sub-60-minute sessions');
    expect(coordination.promptBlock).toContain('Keep Friday lighter when possible');
    expect(week?.sessions?.find((session) => session.dayOfWeek === 'friday')?.title).toBe('Aerobic Support / Recovery');
    expect(week?.sessions?.find((session) => session.dayOfWeek === 'monday')?.durationMinutes).toBeLessThanOrEqual(55);
  });

  it('fills missing weekly volume and strength support when the plan comes back too thin', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Running Build',
      sport: 'running',
      periodization: 'undulating',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 72,
          sessions: [
            {
              dayOfWeek: 'tuesday',
              sessionType: 'run',
              title: 'Intervals / Speed Session',
              durationMinutes: 50,
              description: 'Structured quality run.',
              exercises: [],
            },
            {
              dayOfWeek: 'thursday',
              sessionType: 'run',
              title: 'Tempo Run',
              durationMinutes: 55,
              description: 'Controlled threshold work.',
              exercises: [],
            },
            {
              dayOfWeek: 'sunday',
              sessionType: 'run',
              title: 'Long Run',
              durationMinutes: 85,
              description: 'Aerobic long run.',
              exercises: [],
            },
          ],
        },
      ],
    };

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 2,
      longWorkoutDay: 'sunday',
      training: null,
      cooking: null,
      finance: null,
      content: null,
      sharedDecisionContext: '',
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week = result.weeks?.[0];
    const activeSessions = week?.sessions?.filter((session) => session.sessionType !== 'rest') ?? [];
    const strengthSessions = week?.sessions?.filter((session) => session.sessionType === 'gym') ?? [];

    expect(activeSessions).toHaveLength(6);
    expect(strengthSessions).toHaveLength(2);
    expect(week?.sessions?.some((session) => session.title === 'Easy Aerobic Support')).toBe(true);
    expect(week?.sessions?.some((session) => session.title === 'Runner Strength Support')).toBe(true);
  });

  it('adds support volume on safe free days instead of crowding protected days', () => {
    const plan: CoordinatedTrainingPlan = {
      planName: 'Hybrid Week',
      sport: 'hybrid',
      periodization: 'undulating',
      weeks: [
        {
          weekNumber: 1,
          intensityPct: 70,
          sessions: [
            {
              dayOfWeek: 'tuesday',
              sessionType: 'gym',
              title: 'Strength Session',
              durationMinutes: 55,
              description: 'Main strength session.',
              exercises: [{ name: 'Goblet Squat' }],
            },
            {
              dayOfWeek: 'thursday',
              sessionType: 'run',
              title: 'Tempo Run',
              durationMinutes: 50,
              description: 'Threshold work.',
              exercises: [],
            },
            {
              dayOfWeek: 'saturday',
              sessionType: 'run',
              title: 'Long Run',
              durationMinutes: 90,
              description: 'Long aerobic session.',
              exercises: [],
            },
          ],
        },
      ],
    };

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: null,
      content: {
        filmingRecommendation: {
          date: '2026-04-15',
        },
      } as any,
      secretary: {
        focusBlock: {
          date: '2026-04-17',
        },
        derivedSignals: [],
      } as any,
      sharedDecisionContext: '',
    });

    const result = applyTrainingPlanCoordination(plan, coordination);
    const week = result.weeks?.[0];
    const supportDays = (week?.sessions ?? [])
      .filter((session) => /support/i.test(session.title))
      .map((session) => session.dayOfWeek);

    expect(supportDays).not.toContain('wednesday');
    expect(supportDays).not.toContain('friday');
    expect(supportDays.length).toBeGreaterThanOrEqual(2);
  });
});
