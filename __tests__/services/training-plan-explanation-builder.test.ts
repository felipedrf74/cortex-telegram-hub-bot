import { describe, expect, it } from 'vitest';

import {
  buildPlanCreationExplanation,
  parsePlanCreationExplanationJson,
  withPlanCreationExplanationPlanId,
  type TrainingPlanExplanationTrace,
} from '../../src/services/training-plan-explanation/builder';

function trace(overrides: Partial<TrainingPlanExplanationTrace> = {}): TrainingPlanExplanationTrace {
  return {
    primaryFocus: { value: 'marathon', source: 'objective_keyword', matchedKeyword: 'marathon' },
    rawWeeklyTargets: { running: 5, strength: 2 },
    shapedWeeklyTargets: { running: 5, strength: 2 },
    equipment: {
      value: {
        hasGym: true,
        hasBarbell: true,
        hasDumbbells: true,
        hasBikeTrainer: false,
        hasPool: false,
        hasTrack: true,
      },
      source: 'gym_profile.equipment_access',
      matchedKeyword: 'full gym',
    },
    runningHistory: {
      value: 270,
      source: 'profile_data',
      rawInputField: 'run_profile.weekly_mileage_km',
      rawInputValue: 45,
    },
    cyclingHistory: { value: undefined, source: 'no_volume' },
    strengthGoal: {
      value: 'hypertrophy',
      source: 'gym_profile.primary_goal',
      matchedKeyword: 'hypertrophy',
    },
    experienceLevel: {
      value: 'advanced',
      source: 'gym_profile.training_age',
      matchedKeyword: '5+ years',
    },
    readiness: {
      capturedAt: '2026-05-22T09:45:00.000Z',
      level: 'green',
      score: 82,
      hrvStatus: 'normal',
      sleepHours: 7.4,
      energyReserve: 78,
      painFlags: [],
      confidence: 'fresh_wearable',
      dataSource: 'wearable',
      notes: [],
    },
    raceCalendar: [{ id: 'race-1', name: 'Lisbon Marathon', discipline: 'running', subtype: 'marathon', date: '2026-10-18', priority: 'a' }],
    firstWeekPhase: 'base',
    maxSessionsPerDay: 2,
    decisionReasons: [],
    ...overrides,
  };
}

const request = {
  objective: 'Run the Lisbon marathon',
  startPolicy: 'next_full_week' as const,
  sessionsPerWeek: 6,
  runSessionsPerWeek: 5,
  bikeSessionsPerWeek: null,
  swimSessionsPerWeek: null,
  strengthSessionsPerWeek: 2,
  preferredCardioTime: '07:00',
  preferredStrengthTime: '12:00',
  longWorkoutDay: 'sunday',
  twoADayPreference: 'preferred' as const,
  goalMode: 'event_based' as const,
};

describe('training plan creation explanation builder', () => {
  it('emits smart picks, respected constraints, and attention items as separate trust surfaces', () => {
    const explanation = buildPlanCreationExplanation({
      request,
      trace: trace(),
      generatedAt: new Date('2026-05-22T10:00:00.000Z'),
    });

    expect(explanation.schemaVersion).toBe(1);
    expect(explanation.generatedAt).toBe('2026-05-22T10:00:00.000Z');
    expect(explanation.smartPicks.map((pick) => pick.id)).toEqual(expect.arrayContaining([
      'primary_focus_from_objective',
      'first_week_phase',
      'training_history_profile_data',
      'readiness_baseline',
      'equipment_profile',
      'experience_level',
      'strength_goal',
      'two_a_day_policy',
    ]));
    expect(explanation.smartPicks.some((pick) => pick.id === 'weekly_volume_inference')).toBe(false);
    expect(explanation.smartPicks.some((pick) => pick.id === 'goal_mode_volume_cap')).toBe(false);
    expect(explanation.smartPicks.some((pick) => pick.source === 'request')).toBe(false);
    expect(explanation.respectedConstraints.map((constraint) => constraint.id)).toEqual(expect.arrayContaining([
      'weekly_frequency',
      'run_sessions',
      'strength_sessions',
      'long_session_day',
      'preferred_cardio_time',
      'preferred_strength_time',
      'start_policy',
    ]));
    expect(explanation.respectedConstraints.every((constraint) => constraint.source === 'request')).toBe(true);
    expect(explanation.attentionItems).toEqual([]);
  });

  it('surfaces fallback primary focus and missing readiness without exposing raw defaults as smart picks', () => {
    const explanation = buildPlanCreationExplanation({
      request: { ...request, objective: 'make me unstoppable\u0000<script>x</script>', runSessionsPerWeek: null },
      trace: trace({
        primaryFocus: {
          value: 'hybrid',
          source: 'fallback',
          reason: 'unrecognized',
          rawInput: 'make me unstoppable\u0000<script>x</script>',
        },
        readiness: {
          capturedAt: '2026-05-22T09:45:00.000Z',
          level: 'yellow',
          score: 70,
          painFlags: [],
          confidence: 'no_data',
          dataSource: 'fallback',
          notes: [],
        },
      }),
    });

    expect(explanation.smartPicks.some((pick) => pick.id === 'primary_focus_from_objective')).toBe(false);
    expect(explanation.attentionItems.map((item) => item.id)).toEqual(expect.arrayContaining([
      'primary_focus_fallback',
      'readiness_missing',
    ]));
    const evidence = explanation.attentionItems.flatMap((item) => item.evidence);
    expect(evidence.some((item) => item.rawInputSnippet?.includes('\u0000'))).toBe(false);
  });

  it('pins weekly-volume inference and goal-mode caps as smart picks only when Nexus changed the shape', () => {
    const inferredVolume = buildPlanCreationExplanation({
      request: { ...request, runSessionsPerWeek: null, strengthSessionsPerWeek: 0 },
      trace: trace({
        rawWeeklyTargets: { running: 4, strength: 0 },
        shapedWeeklyTargets: { running: 4, strength: 0 },
      }),
    });
    expect(inferredVolume.smartPicks.find((pick) => pick.id === 'weekly_volume_inference')).toMatchObject({
      category: 'weekly_volume',
      source: 'system_inference',
      value: 4,
    });

    const cappedVolume = buildPlanCreationExplanation({
      request: { ...request, goalMode: 'maintenance' },
      trace: trace({
        rawWeeklyTargets: { running: 6, strength: 3 },
        shapedWeeklyTargets: { running: 3, strength: 1 },
        decisionReasons: [{
          code: 'maintenance_volume_capped',
          text: 'Maintenance mode capped weekly volume.',
          severity: 'notice',
          affectedEntity: { type: 'week', id: 'week-1' },
          sourceConstraint: { type: 'volume', label: 'maintenance' },
          evidence: ['Raw 9 sessions shaped to 4 sessions.'],
        }],
      }),
    });

    expect(cappedVolume.smartPicks.find((pick) => pick.id === 'goal_mode_volume_cap')).toMatchObject({
      category: 'goal_mode_volume_cap',
      source: 'goal_mode_rule',
      value: 4,
    });
    expect(cappedVolume.smartPicks.find((pick) => pick.id === 'goal_mode_maintenance_volume_capped')).toMatchObject({
      category: 'goal_mode_volume_cap',
      source: 'goal_mode_rule',
      value: 'maintenance_volume_capped',
    });
  });

  it('keeps stale readiness visible as both a smart pick and a data-quality attention item', () => {
    const explanation = buildPlanCreationExplanation({
      request,
      trace: trace({
        readiness: {
          capturedAt: '2026-05-21T06:00:00.000Z',
          level: 'yellow',
          score: 63,
          painFlags: [],
          confidence: 'stale_provider',
          dataSource: 'garmin',
          isStale: true,
          notes: [],
        },
      }),
    });

    expect(explanation.smartPicks.find((pick) => pick.id === 'readiness_baseline')).toMatchObject({
      category: 'readiness_baseline',
      source: 'readiness_data',
      value: 'yellow',
    });
    expect(explanation.attentionItems.find((item) => item.id === 'readiness_stale')).toMatchObject({
      category: 'readiness_baseline',
      severity: 'notice',
    });
  });

  it('treats equipment fallback as an attention item instead of pretending it is profile-backed', () => {
    const explanation = buildPlanCreationExplanation({
      request,
      trace: trace({
        equipment: {
          value: {
            hasGym: false,
            hasBarbell: false,
            hasDumbbells: false,
            hasBikeTrainer: false,
            hasPool: false,
            hasTrack: false,
          },
          source: 'fallback',
          reason: 'missing_profile',
          rawInput: 'home only',
        },
      }),
    });

    expect(explanation.smartPicks.some((pick) => pick.id === 'equipment_profile')).toBe(false);
    expect(explanation.attentionItems.find((item) => item.id === 'equipment_fallback')).toMatchObject({
      category: 'equipment_profile',
      severity: 'notice',
    });
  });

  it('round-trips persisted explanations and attaches plan id without mutating the original', () => {
    const explanation = buildPlanCreationExplanation({ request, trace: trace() });
    const parsed = parsePlanCreationExplanationJson(JSON.stringify(explanation));
    const withPlan = withPlanCreationExplanationPlanId(parsed, 123);

    expect(parsed?.planId).toBeNull();
    expect(withPlan?.planId).toBe(123);
    expect(parsed?.planId).toBeNull();
  });
});
