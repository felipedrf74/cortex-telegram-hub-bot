import { describe, expect, it } from 'vitest';

import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
  type CoordinatedTrainingPlan,
} from '../../src/services/training-plan-coordination';
import {
  enforceFinalTrainingPlanTwoADayCap,
  enforceRequestedTrainingPlanVolume,
} from '../../src/services/training-plan-volume-enforcement';
import { buildCoachKernelTrainingPlan } from '../../src/services/training-coach-kernel-plan-generator';

function confirmedRecordingContent(
  date: string,
  options: {
    state?: 'scheduled' | 'provider_synced' | 'sync_failed';
    schedule?: Record<string, unknown>;
    block?: Record<string, unknown>;
  } = {},
): any {
  const startsAt = `${date}T10:00:00.000Z`;
  const endsAt = `${date}T12:00:00.000Z`;
  return {
    filmingRecommendation: null,
    workSchedule: {
      authority: 'secretary',
      authorityStatus: 'current',
      planStatus: 'confirmed',
      semantics: 'private_work_session',
      attentionCount: 0,
      confirmedBlocks: [{
        itemId: 41,
        title: 'Record weekly update',
        date,
        startsAt,
        endsAt,
        workKind: 'record',
        state: options.state ?? 'scheduled',
        authority: 'secretary',
        authorityStatus: 'current',
        semantics: 'private_work_session',
        contentChangedSinceScheduling: false,
        ...options.block,
      }],
      ...options.schedule,
    },
  };
}

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
        ...confirmedRecordingContent('2026-04-18'),
        // The advisory recommendation deliberately points elsewhere; only the
        // canonical Secretary-confirmed record block may affect Training.
        filmingRecommendation: { date: '2026-04-16' },
      } as any,
    });

    expect(coordination.conservativeFirstWeek).toBe(true);
    expect(coordination.maxHardSessionsPerWeek).toBe(1);
    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.strengthSessionTarget).toBe(2);
    expect(coordination.resolvedLongWorkoutDay).toBe('sunday');
    expect(coordination.protectConfirmedRecordingDay).toBe('saturday');
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
    expect(coordination.promptBlock).toContain('Secretary confirms a current private Content recording work session on Saturday');
    expect(coordination.promptBlock).toContain('Avoid recommending new paid equipment');
    expect(coordination.promptBlock).toContain('Keep non-key training locally executable');
    expect(coordination.promptBlock).toContain('Treat supplements as pause_new');
    expect(coordination.promptBlock).toContain('Avoid back-to-back impact-heavy run days');
    expect(coordination.promptBlock).toContain('Keep lower-body strength at least one easier day away');
  });

  it('does not move or soften Training from an advisory filming recommendation alone', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 0,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: null,
      content: {
        filmingRecommendation: { date: '2026-04-18' },
        workSchedule: {
          authority: 'secretary',
          authorityStatus: 'current',
          planStatus: 'proposed',
          semantics: 'private_work_session',
          confirmedBlocks: [],
          attentionCount: 0,
        },
      } as any,
      secretary: null,
      sharedDecisionContext: '',
    });
    const plan: CoordinatedTrainingPlan = {
      sport: 'running',
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'saturday',
          sessionType: 'run',
          title: 'Tempo Run',
          durationMinutes: 50,
          description: 'Keep the authored session.',
          exercises: [],
        }],
      }],
    };

    const result = applyTrainingPlanCoordination(plan, coordination);
    const authoredSession = result.weeks?.[0]?.sessions?.find((session) => session.title === 'Tempo Run');

    expect(coordination.protectConfirmedRecordingDay).toBeNull();
    expect(coordination.resolvedLongWorkoutDay).toBe('saturday');
    expect(coordination.promptBlock).not.toContain('private Content recording work session');
    expect(authoredSession).toMatchObject({
      dayOfWeek: 'saturday',
      sessionType: 'run',
      durationMinutes: 50,
      description: 'Keep the authored session.',
    });
  });

  it.each([
    [
      'the schedule is not Secretary-owned',
      confirmedRecordingContent('2026-04-18', { schedule: { authority: 'content' } }),
    ],
    [
      'the schedule authority is unavailable',
      confirmedRecordingContent('2026-04-18', { schedule: { authorityStatus: 'unavailable' } }),
    ],
    [
      'the schedule is not confirmed',
      confirmedRecordingContent('2026-04-18', { schedule: { planStatus: 'proposed' } }),
    ],
    [
      'the schedule does not represent private work sessions',
      confirmedRecordingContent('2026-04-18', { schedule: { semantics: 'target_date_not_publication' } }),
    ],
    [
      'the work kind is not record',
      confirmedRecordingContent('2026-04-18', { block: { workKind: 'edit' } }),
    ],
    [
      'the block is not Secretary-owned',
      confirmedRecordingContent('2026-04-18', { block: { authority: 'content' } }),
    ],
    [
      'the block authority is not current',
      confirmedRecordingContent('2026-04-18', { block: { authorityStatus: 'unavailable' } }),
    ],
    [
      'the block has a pending cancellation',
      confirmedRecordingContent('2026-04-18', { block: { state: 'cancel_pending' } }),
    ],
    [
      'the block semantics are not a private work session',
      confirmedRecordingContent('2026-04-18', { block: { semantics: 'target_date_not_publication' } }),
    ],
    [
      'the canonical local date is invalid',
      confirmedRecordingContent('2026-02-30'),
    ],
  ])('fails closed when %s', (_label, content) => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 0,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: null,
      content,
      secretary: null,
      sharedDecisionContext: '',
    });

    expect(coordination.protectConfirmedRecordingDay).toBeNull();
    expect(coordination.resolvedLongWorkoutDay).toBe('saturday');
  });

  it('protects a current Secretary recording block while provider sync needs attention', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 0,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: null,
      content: confirmedRecordingContent('2026-04-18', { state: 'sync_failed' }),
      secretary: null,
      sharedDecisionContext: '',
    });

    expect(coordination.protectConfirmedRecordingDay).toBe('saturday');
    expect(coordination.resolvedLongWorkoutDay).toBe('sunday');
  });

  it('protects an exact current record block when unrelated schedule entries are partially unavailable', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 0,
      longWorkoutDay: 'saturday',
      training: null,
      cooking: null,
      finance: null,
      content: confirmedRecordingContent('2026-04-18', {
        schedule: {
          authorityStatus: 'partially_unavailable',
          planStatus: 'partial',
        },
      }),
      secretary: null,
      sharedDecisionContext: '',
    });

    expect(coordination.protectConfirmedRecordingDay).toBe('saturday');
    expect(coordination.resolvedLongWorkoutDay).toBe('sunday');
  });

  it('turns the active plan latest compressed Secretary decision into concrete plan guardrails', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: 'saturday',
      fitnessProfile: {
        experience_level: 'Advanced (3+ years)',
      },
      training: {
        secretaryFeedback: {
          planId: 1,
          feedbackType: 'compressed_session',
          status: 'compressed',
          reasonCodes: ['compressed_to_fit_capacity', 'duration_reduced'],
          shouldRefreshSource: true,
          hints: ['recovery_debt', 'adapt_workload_to_capacity'],
          scheduledDurationMinutes: 30,
        },
        derivedSignals: [],
      } as any,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });

    expect(coordination.conservativeFirstWeek).toBe(true);
    expect(coordination.modularSessionBias).toBe(true);
    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.maxHardSessionsPerWeek).toBe(2);
    expect(coordination.firstWeekIntensityReductionPct).toBe(4);
    expect(coordination.promptBlock).toContain('Secretary reports that at least one plan session was compressed');
    expect(coordination.promptBlock).toContain('conservative capacity signal');
    expect(coordination.promptBlock).toContain('Cap truly hard sessions at 2 per week');
  });

  it('never lets Secretary-triggered strength coverage exceed the final weekly session cap', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 6,
      longWorkoutDay: 'saturday',
      fitnessProfile: { experience_level: 'Advanced (3+ years)' },
      training: {
        secretaryFeedback: {
          planId: 1,
          feedbackType: 'compressed_session',
          status: 'compressed',
          reasonCodes: ['compressed_to_fit_capacity'],
          shouldRefreshSource: true,
          hints: ['adapt_workload_to_capacity'],
          scheduledDurationMinutes: 30,
        },
        derivedSignals: [],
      } as any,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    const plan: CoordinatedTrainingPlan = {
      sport: 'strength',
      weeks: [{
        weekNumber: 1,
        sessions: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
          .map((dayOfWeek, index) => ({
            dayOfWeek,
            sessionType: index < 6 ? 'gym' : 'run',
            title: index < 6 ? `Strength ${index + 1}` : 'Easy Run',
            durationMinutes: 45,
            description: 'Planned work.',
            exercises: [],
          })),
      }],
    };

    const result = applyTrainingPlanCoordination(plan, coordination);
    const activeSessions = result.weeks?.[0]?.sessions?.filter((session) => session.sessionType !== 'rest') ?? [];
    const activeDays = new Set(activeSessions.map((session) => session.dayOfWeek.toLowerCase()));

    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.strengthSessionTarget).toBeLessThanOrEqual(coordination.weeklySessionTarget);
    // Stronger guarantee: Secretary caps active DAYS. Physical rows can stay
    // doubled and are governed later by the explicit two-a-day contract.
    expect(activeDays.size).toBeLessThanOrEqual(coordination.weeklySessionTarget);
  });

  it('treats the coordination weekly target as distinct days, not physical two-a-day rows', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      fitnessProfile: { experience_level: 'Advanced (3+ years)' },
      gymProfile: { training_age: '5+ years' },
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    const trainingDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const plan: CoordinatedTrainingPlan = {
      sport: 'hybrid',
      weeks: [{
        weekNumber: 1,
        sessions: trainingDays.flatMap((dayOfWeek, index) => ([
          {
            dayOfWeek,
            sessionType: 'run',
            title: `Easy Run ${index + 1}`,
            durationMinutes: 35,
          },
          {
            dayOfWeek,
            sessionType: 'gym',
            title: `Strength ${index + 1}`,
            durationMinutes: 40,
          },
        ])),
      }],
    };

    const result = applyTrainingPlanCoordination(plan, coordination);
    const active = result.weeks?.[0]?.sessions?.filter((session) => session.sessionType !== 'rest') ?? [];
    const distinctDays = new Set(active.map((session) => session.dayOfWeek.toLowerCase()));
    let longestStreak = 0;
    let currentStreak = 0;
    for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      currentStreak = distinctDays.has(day) ? currentStreak + 1 : 0;
      longestStreak = Math.max(longestStreak, currentStreak);
    }

    // Stronger guarantee: the five-day cap must not collapse five legal
    // run+strength doubles into five physical rows.
    expect(active).toHaveLength(10);
    expect(distinctDays.size).toBe(5);
    expect(longestStreak).toBeLessThanOrEqual(coordination.maxConsecutiveActiveDays);
  });

  it('preserves an explicit triathlon modality mix under a Cooking nutrition advisory', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 1,
      longWorkoutDay: 'saturday',
      fitnessProfile: { experience_level: 'Advanced (3+ years)' },
      gymProfile: { training_age: '5 years' },
      runProfile: null,
      training: null,
      cooking: {
        derivedSignals: [{
          signalType: 'meal_execution_readiness',
          payload: { status: 'at_risk' },
        }],
      } as any,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    const plan: CoordinatedTrainingPlan = {
      sport: 'triathlon',
      weeks: [{
        weekNumber: 1,
        sessions: [
          { dayOfWeek: 'Monday', sessionType: 'run', title: 'Brick Run', durationMinutes: 20 },
          {
            dayOfWeek: 'Tuesday',
            sessionType: 'gym',
            sessionRole: 'strength_maintenance',
            title: 'Strength Maintenance + Core',
            durationMinutes: 35,
            exercises: [{ name: 'Goblet Squat' }, { name: 'One-Arm Row' }, { name: 'Dead Bug' }],
          },
          { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Tempo Progression Run', durationMinutes: 45 },
          { dayOfWeek: 'Thursday', sessionType: 'swim', title: 'Threshold Swim', durationMinutes: 45 },
          { dayOfWeek: 'Friday', sessionType: 'ride', title: 'Endurance Ride', durationMinutes: 45 },
          { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 45 },
          { dayOfWeek: 'Sunday', sessionType: 'swim', title: 'Technique Swim', durationMinutes: 45 },
        ],
      }],
    };

    const result = applyTrainingPlanCoordination(plan, coordination);
    const active = result.weeks?.[0]?.sessions?.filter((session) =>
      session.sessionType !== 'rest' && session.sessionType !== 'mobility'
    ) ?? [];
    const count = (type: string) => active.filter((session) => session.sessionType === type).length;
    const activeDays = [...new Set(active.map((session) => session.dayOfWeek.toLowerCase()))]
      .sort((left, right) => [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ].indexOf(left) - [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ].indexOf(right));
    let longestStreak = 0;
    let streak = 0;
    for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      streak = activeDays.includes(day) ? streak + 1 : 0;
      longestStreak = Math.max(longestStreak, streak);
    }

    expect(coordination.weeklySessionTarget).toBe(6);
    // Coordination owns distinct active days and recovery spacing. It keeps
    // all seven authored rows after reflow; the explicit-volume authority
    // below removes the additive Brick row from the six-session request.
    expect(active).toHaveLength(7);
    expect({ run: count('run'), ride: count('ride'), swim: count('swim'), gym: count('gym') })
      .toEqual({ run: 3, ride: 1, swim: 2, gym: 1 });
    expect(active.some((session) => session.title === 'Brick Run')).toBe(true);
    expect(longestStreak).toBeLessThanOrEqual(coordination.maxConsecutiveActiveDays);

    const volumeEnforced = enforceRequestedTrainingPlanVolume(result, {
      sessionsPerWeek: 6,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay: 'Saturday',
      twoADayPreference: 'never',
    });
    const enforcedActive = volumeEnforced.weeks?.[0]?.sessions?.filter((session) =>
      session.sessionType !== 'rest' && session.sessionType !== 'mobility'
    ) ?? [];
    expect(enforcedActive.map((session) => session.sessionType).sort())
      .toEqual(['gym', 'ride', 'run', 'run', 'swim', 'swim']);
    expect(volumeEnforced.volumeShortfalls ?? []).toEqual([]);
  });

  it('keeps a beginner recovery swim as swim while breaking a five-day active streak', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      longWorkoutDay: 'saturday',
      fitnessProfile: { experience_level: 'Beginner' },
      gymProfile: null,
      runProfile: null,
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    const plan: CoordinatedTrainingPlan = {
      sport: 'triathlon',
      weeks: [{
        weekNumber: 1,
        sessions: [
          {
            dayOfWeek: 'Thursday',
            sessionType: 'gym',
            sessionRole: 'strength_maintenance',
            title: 'Strength Maintenance + Core',
            durationMinutes: 35,
          },
          { dayOfWeek: 'Wednesday', sessionType: 'swim', title: 'Threshold Swim', durationMinutes: 45 },
          { dayOfWeek: 'Friday', sessionType: 'ride', title: 'Endurance Ride', durationMinutes: 45 },
          { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 45 },
          { dayOfWeek: 'Sunday', sessionType: 'swim', title: 'Technique Swim', durationMinutes: 45 },
        ],
      }],
    };

    const coordinated = applyTrainingPlanCoordination(plan, coordination);
    const volumeEnforced = enforceRequestedTrainingPlanVolume(coordinated, {
      sessionsPerWeek: 5,
      runSessionsPerWeek: 1,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay: 'Saturday',
      twoADayPreference: 'never',
    });
    const active = volumeEnforced.weeks?.[0]?.sessions?.filter((session) =>
      session.sessionType !== 'rest' && session.sessionType !== 'mobility'
    ) ?? [];

    expect(active.map((session) => session.sessionType).sort())
      .toEqual(['gym', 'ride', 'run', 'swim', 'swim']);
    expect(volumeEnforced.volumeShortfalls ?? []).toEqual([]);
  });

  it('preserves the exact six-session triathlon request through kernel coordination and volume', () => {
    const fitnessProfile = {
      experience_level: 'Advanced (3+ years)',
      weekly_frequency: '6+ days',
      injuries: 'none',
      available_equipment: 'Full gym',
    };
    const gymProfile = {
      training_age: '5+ years',
      primary_goal: 'Support other sports',
      equipment_access: 'Full commercial gym',
    };
    const enduranceProfile = {
      weekly_mileage_km: '32',
      longest_recent_run_km: '14',
      easy_pace_min_per_km: '5:45',
      injury_history: 'none',
      ftp_watts: '245',
      cycling_weekly_hours: '3-6 hours',
      pool_access: '25m indoor',
      swim_pool_access: '25m indoor',
      swim_sessions_per_week: '2',
    };
    const request = {
      sessionsPerWeek: 6,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      startDate: '2026-05-25',
      longWorkoutDay: 'Saturday',
      twoADayPreference: 'never',
    } as const;
    const kernelPlan = buildCoachKernelTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Triathlon discipline balance',
      durationWeeks: 1,
      startDate: request.startDate,
      sessionsPerWeek: request.sessionsPerWeek,
      runSessionsPerWeek: request.runSessionsPerWeek,
      bikeSessionsPerWeek: request.bikeSessionsPerWeek,
      swimSessionsPerWeek: request.swimSessionsPerWeek,
      strengthSessionsPerWeek: request.strengthSessionsPerWeek,
      preferredTime: '07:00',
      preferredCardioTime: request.preferredCardioTime,
      preferredStrengthTime: request.preferredStrengthTime,
      longWorkoutDay: request.longWorkoutDay,
      notes: null,
      goalMode: 'continuous',
      trainingPriority: 'triathlon',
      fitnessProfile,
      gymProfile,
      runProfile: enduranceProfile,
      currentReadiness: null,
      twoADayPreference: request.twoADayPreference,
    });
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: request.sessionsPerWeek,
      strengthSessionsPerWeek: request.strengthSessionsPerWeek,
      longWorkoutDay: request.longWorkoutDay,
      fitnessProfile,
      gymProfile,
      runProfile: enduranceProfile,
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    const coordinated = applyTrainingPlanCoordination(kernelPlan, coordination);
    const enforced = enforceRequestedTrainingPlanVolume(coordinated, request);
    const finalCapped = enforceFinalTrainingPlanTwoADayCap(enforced, request);
    const active = finalCapped.weeks?.[0]?.sessions?.filter((session) =>
      session.sessionType !== 'rest'
      && session.sessionType !== 'mobility'
      && !['deferred', 'unscheduled', 'dropped'].includes(String(session.scheduleState ?? ''))
    ) ?? [];

    expect(active.map((session) => session.sessionType).sort(), JSON.stringify({
      kernel: kernelPlan.weeks?.[0]?.sessions,
      coordinated: coordinated.weeks?.[0]?.sessions,
      enforced: enforced.weeks?.[0]?.sessions,
      finalCapped: finalCapped.weeks?.[0]?.sessions,
      shortfalls: finalCapped.volumeShortfalls,
    })).toEqual(['gym', 'ride', 'run', 'run', 'swim', 'swim']);
    expect(finalCapped.volumeShortfalls ?? []).toEqual([]);
  });

  it('does not tell the model to recover a reflow time or session identity omitted by the privacy projection', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      training: {
        secretaryFeedback: {
          planId: 1,
          feedbackType: 'reflowed_session',
          status: 'reflowed',
          reasonCodes: ['reflowed_to_available_window'],
          shouldRefreshSource: true,
          hints: ['refresh_user_facing_time_copy'],
          scheduledDurationMinutes: 45,
        },
        derivedSignals: [],
      } as any,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });

    expect(coordination.promptBlock).toContain('treat Secretary-owned calendar placement as authoritative');
    expect(coordination.promptBlock).toContain('do not infer or restate its exact time');
    expect(coordination.promptBlock).not.toContain('use the latest scheduled placement');
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
      content: confirmedRecordingContent('2026-04-16', { state: 'provider_synced' }),
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
    expect(week3?.intensityPct).toBe(70);
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
      content: confirmedRecordingContent('2026-04-15'),
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
