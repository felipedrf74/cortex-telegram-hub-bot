// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  buildTrainingPlanCreationQualityMatrix,
  buildTrainingPlanCreationValidationMatrix,
  TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL,
  scoreTrainingPlanQuality,
  TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL,
  TRAINING_PLAN_CREATION_VARIATION_AXES,
  TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS,
  TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE,
  validateTrainingPlanAgendaMatch,
  type TrainingPlanQualityCandidate,
} from '../../src/services/training-plan-creation-validation';

describe('training plan creation validation matrix', () => {
  it('uses the Hotmail QA account and covers every declared option value at least once', () => {
    const matrix = buildTrainingPlanCreationValidationMatrix();

    expect(matrix.qaAccountEmail).toBe(TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL);
    expect(matrix.qaAccountEmail).toBe('nexushubbot@hotmail.com');
    expect(TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL).toBe('nexushubbot@gmail.com');
    expect(matrix.strategy).toBe('axis-complete-boundary-matrix');
    expect(matrix.cartesianVariationCount).toBeGreaterThan(matrix.scenarios.length);
    expect(matrix.requiredE2EChecks).toEqual(expect.arrayContaining([
      'Start a fresh isolated Training E2E backend container from the target worktree HEAD; record git SHA, image IDs, compose project, non-default ports, DB path, and /api/snapshot.',
      'Run iOS on a dedicated simulator UDID with unique DerivedData/result bundle/test-summary paths; do not shut down or reuse another worktree simulator.',
      'Preview the plan and verify no persistence or agenda writes happened during preview.',
      'Exercise Training Skill entry points: first-run/profile gate, plan builder, preview/review, create, Today, Plan, Progress, complete, skip, feedback, reflow/swap, and degraded/no-plan states.',
      'Run feedback/progression checks: easy/normal/hard feedback, soreness, pain, skipped key sessions, partial completion, repeated misses, deload/reentry, and visible rationale.',
      'Run agenda matcher for identity, date, timezone, title/type, duration, status, version, and duplicate checks.',
      'Clean up only test-created plans and agenda/provider events.',
    ]));
    expect(matrix.personaScenarios.map((scenario) => scenario.id)).toEqual(
      TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((scenario) => scenario.id),
    );
    expect(matrix.personaScenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'beginner_gym',
      'intermediate_hypertrophy',
      'hybrid_run_strength',
      'cycling_gym',
      'swim_triathlon',
      'travel_week',
      'limited_time_week',
      'injury_discomfort',
      'poor_adherence',
      'fatigue_plateau',
      'stale_wearable',
      'no_wearable',
      'calendar_conflicted',
      'race_prep',
    ]));

    for (const axis of TRAINING_PLAN_CREATION_VARIATION_AXES) {
      const covered = new Set(matrix.scenarios.map((scenario) => scenario.values[axis.id].id));
      for (const value of axis.values) {
        expect(covered, `missing matrix coverage for ${axis.id}.${value.id}`).toContain(value.id);
      }
    }
    expect(TRAINING_PLAN_CREATION_VARIATION_AXES.find((axis) => axis.id === 'twoADayPreference')?.values.map((value) => value.id))
      .toContain('optional');
    expect(TRAINING_PLAN_CREATION_VARIATION_AXES.find((axis) => axis.id === 'calendarCapacityState')?.values.map((value) => value.id))
      .toEqual(expect.arrayContaining(['normal_capacity', 'limited_capacity']));
  });

  it('keeps race-date buckets future-dated and aligned to their labels', async () => {
    // The axis computes its dates once at module import. Freeze the clock and
    // import a fresh module instance so the axis and the expected offsets
    // share the same "today" — a run that crosses midnight UTC between the
    // suite's import and this assertion must not flake by one day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    vi.resetModules();
    try {
      const freshModule = await import('../../src/services/training-plan-creation-validation');
      const axis = freshModule.TRAINING_PLAN_CREATION_VARIATION_AXES.find((candidate) => candidate.id === 'raceDateBucket');
      const values = new Map(axis?.values.map((value) => [value.id, value.requestValue]));
      const todayUtc = Date.UTC(2026, 6, 8);
      const dayOffset = (value: unknown) => {
        const parsed = Date.parse(`${value}T00:00:00.000Z`);
        return Math.round((parsed - todayUtc) / (24 * 60 * 60 * 1000));
      };

      expect(dayOffset(values.get('near_3_weeks'))).toBe(21);
      expect(dayOffset(values.get('normal_16_weeks'))).toBe(112);
      expect(dayOffset(values.get('far_40_weeks'))).toBe(280);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it('keeps the science baseline source-backed and top-tier', () => {
    const ids = TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE.map((source) => source.id);

    expect(ids).toEqual(expect.arrayContaining([
      'WHO-2020-PA',
      'ACSM-GETP-12',
      'ACSM-RT-2026',
      'IOC-REDS-2023',
      'ENDURANCE-TID-REVIEW',
      'HIIT-MICT-REVIEW',
    ]));
    for (const source of TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.useInRubric.length).toBeGreaterThan(12);
      expect(source.observedDate).toBe('2026-06-23');
    }
  });

  it('emits a deterministic per-plan quality matrix with required row fields and bounded coverage', () => {
    const first = buildTrainingPlanCreationQualityMatrix({ qaAccountEmail: 'nexushubbot@hotmail.com' });
    const second = buildTrainingPlanCreationQualityMatrix({ qaAccountEmail: 'nexushubbot@hotmail.com' });

    expect(first).toEqual(second);
    expect(first.mode).toBe('static_offline');
    expect(first.authorizationRequiredForWrites).toBe(true);
    expect(first.localSimulatorAccountEmail).toBe('nexushubbot@gmail.com');
    expect(first.personaScenarios).toHaveLength(TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.length);
    expect(first.personaScorecard).toHaveLength(TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.length);
    expect(first.personaScorecard.map((row) => row.id)).toEqual(TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((scenario) => scenario.id));
    expect(first.summary.rowCount).toBe(first.summary.scenarioCount);
    expect(first.summary.duplicateScenarioIds).toEqual([]);
    expect(first.summary.missingAxisCoverage).toEqual([]);
    expect(first.rows.length).toBeGreaterThan(20);

    const baseline = first.rows.find((row) => row.scenarioId === 'baseline-complete-profile-outlook');
    expect(baseline).toMatchObject({
      objective: 'marathon',
      goalMode: 'event_based',
      durationBucket: 'event_derived',
      sessionsPerWeek: 5,
      twoADayPreference: 'auto',
      calendarSource: 'outlook',
      previewStatus: 'static_validated',
      createStatus: 'not_executed_static',
      agendaStatus: 'pass',
    });
    expect(baseline?.sportSplit).toMatchObject({ trainingPriority: 'hybrid', runCardioSessionsPerWeek: 5 });
    expect(baseline?.strengthSplit).toMatchObject({ strengthSessionsPerWeek: 2 });
    expect(baseline?.evidenceIds).toEqual(expect.arrayContaining(['WHO-2020-PA', 'ACSM-GETP-12', 'IOC-REDS-2023']));

    for (const row of first.rows) {
      expect(row.scenarioId).toBeTruthy();
      expect(row.qualityVerdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.totalScore).toBeGreaterThanOrEqual(0);
      expect(row.totalScore).toBeLessThanOrEqual(100);
      expect(row.blockers).toEqual(expect.any(Array));
      expect(row.warnings).toEqual(expect.any(Array));
      expect(row.scoring.outputQuality.verdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.scoring.trainingQuality.verdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.scoring.calendarQuality.verdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.scoring.evidenceStructure.verdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.scoring.progression.verdict).toMatch(/^(pass|warn|fail)$/);
      expect(row.scoring.variation.verdict).toMatch(/^(pass|warn|fail)$/);
    }

    const weightLoss = first.rows.find((row) => row.scenarioId === 'objective-weight_loss');
    expect(weightLoss?.qualityVerdict).toBe('warn');
    expect(weightLoss?.warnings.join(' ')).toContain('weight_loss');

    const limitedCalendar = first.rows.find((row) => row.scenarioId === 'calendarCapacityState-limited_capacity');
    expect(limitedCalendar?.calendarCapacityState).toBe('limited_capacity');
    expect(limitedCalendar?.warnings.join(' ')).toContain('Limited calendar capacity');

    for (const persona of first.personaScorecard) {
      expect(persona.qualityVerdict).toMatch(/^(pass|warn|fail)$/);
      expect(persona.totalScore).toBeGreaterThanOrEqual(80);
      expect(Object.keys(persona.dimensionScores).sort()).toEqual([
        'calendarCompatibility',
        'exerciseVariety',
        'explanationQuality',
        'measurableOutcomes',
        'modalityCorrectness',
        'personalization',
        'progression',
        'safety',
        'scheduleFit',
      ].sort());
      expect(persona.requiredSignals.length).toBeGreaterThanOrEqual(3);
      expect(persona.failureConditions.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('prints CLI write-safety booleans and the local simulator account at the top level', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'src/tools/training-plan-creation-validation-matrix.ts', '--qa-account=nexushubbot@hotmail.com'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      authorizationRequired?: boolean;
      productionWritesForbiddenByDefault?: boolean;
      localSimulatorAccountEmail?: string;
    };
    expect(output.authorizationRequired).toBe(true);
    expect(output.productionWritesForbiddenByDefault).toBe(true);
    expect(output.localSimulatorAccountEmail).toBe('nexushubbot@gmail.com');
  });
});

describe('training plan agenda validation', () => {
  it('passes when every active plan session has one matching agenda item', () => {
    const result = validateTrainingPlanAgendaMatch(
      [{
        planId: 7,
        planVersion: 3,
        sessionId: 100,
        sessionIdentityKey: 'plan-7:w1:monday:run:1',
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'planned',
      }],
      [{
        agendaItemId: 'agenda-100',
        providerEventId: 'evt-100',
        planId: 7,
        planVersion: 3,
        sessionId: 100,
        sessionIdentityKey: 'plan-7:w1:monday:run:1',
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'scheduled',
      }],
    );

    expect(result.ok).toBe(true);
    expect(result.missingAgendaSessionIds).toEqual([]);
    expect(result.duplicateAgendaKeys).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('matches mixed agenda keys symmetrically across sessionIdentityKey and sessionId', () => {
    const result = validateTrainingPlanAgendaMatch(
      [
        {
          planId: 7,
          planVersion: 1,
          sessionId: 200,
          sessionIdentityKey: 'plan-7:w1:monday:run:1',
          date: '2026-07-01',
          timezone: 'Europe/Lisbon',
          title: 'Easy Run',
          type: 'run',
          startTime: '07:00',
          durationMinutes: 45,
          status: 'planned',
        },
        {
          planId: 7,
          planVersion: 1,
          sessionId: 201,
          sessionIdentityKey: 'plan-7:w1:tuesday:strength:1',
          date: '2026-07-02',
          timezone: 'Europe/Lisbon',
          title: 'Strength',
          type: 'strength',
          startTime: '18:00',
          durationMinutes: 50,
          status: 'synced',
        },
      ],
      [
        {
          agendaItemId: 'agenda-200',
          planId: 7,
          planVersion: 1,
          sessionId: 200,
          date: '2026-07-01',
          timezone: 'Europe/Lisbon',
          title: 'Easy Run',
          type: 'run',
          startTime: '07:00',
          durationMinutes: 45,
          status: 'scheduled',
        },
        {
          agendaItemId: 'agenda-201',
          planId: 7,
          planVersion: 1,
          sessionIdentityKey: 'plan-7:w1:tuesday:strength:1',
          date: '2026-07-02',
          timezone: 'Europe/Lisbon',
          title: 'Strength',
          type: 'strength',
          startTime: '18:00',
          durationMinutes: 50,
          status: 'planned',
        },
      ],
    );

    expect(result.ok).toBe(true);
    expect(result.missingAgendaSessionIds).toEqual([]);
    expect(result.duplicateAgendaKeys).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('does not over-match colliding legacy session ids when identity keys disagree', () => {
    const result = validateTrainingPlanAgendaMatch(
      [{
        planId: 7,
        planVersion: 1,
        sessionId: 900,
        sessionIdentityKey: 'plan-7:w1:monday:run:1',
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'planned',
      }],
      [{
        agendaItemId: 'agenda-colliding-900',
        planId: 7,
        planVersion: 1,
        sessionId: 900,
        sessionIdentityKey: 'plan-7:w1:tuesday:strength:1',
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'scheduled',
      }],
    );

    expect(result.ok).toBe(false);
    expect(result.missingAgendaSessionIds).toEqual(['900']);
    expect(result.duplicateAgendaKeys).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('treats planned scheduled and synced as equivalent but flags status drift', () => {
    const result = validateTrainingPlanAgendaMatch(
      [{
        planId: 7,
        planVersion: 1,
        sessionId: 300,
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'planned',
      }],
      [{
        agendaItemId: 'agenda-300',
        planId: 7,
        planVersion: 1,
        sessionId: 300,
        date: '2026-07-01',
        timezone: 'Europe/Lisbon',
        title: 'Easy Run',
        type: 'run',
        startTime: '07:00',
        durationMinutes: 45,
        status: 'completed',
      }],
    );

    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual({
      sessionId: '300',
      field: 'status',
      planValue: 'planned',
      agendaValue: 'completed',
    });
  });

  it('flags missing sessions, duplicate agenda rows, and field drift', () => {
    const result = validateTrainingPlanAgendaMatch(
      [
        {
          planId: 7,
          planVersion: 3,
          sessionId: 100,
          date: '2026-07-01',
          timezone: 'Europe/Lisbon',
          title: 'Easy Run',
          type: 'run',
          startTime: '07:00',
          durationMinutes: 45,
          status: 'planned',
        },
        {
          planId: 7,
          planVersion: 3,
          sessionId: 101,
          date: '2026-07-02',
          timezone: 'Europe/Lisbon',
          title: 'Strength A',
          type: 'strength',
          startTime: '18:00',
          durationMinutes: 50,
          status: 'planned',
        },
      ],
      [
        {
          agendaItemId: 'agenda-100-a',
          planId: 7,
          planVersion: 2,
          sessionId: 100,
          date: '2026-07-01',
          timezone: 'UTC',
          title: 'Easy Run',
          type: 'run',
          startTime: '07:30',
          durationMinutes: 45,
          status: 'scheduled',
        },
        {
          agendaItemId: 'agenda-100-b',
          planId: 7,
          planVersion: 2,
          sessionId: 100,
          date: '2026-07-01',
          timezone: 'UTC',
          title: 'Easy Run',
          type: 'run',
          startTime: '07:30',
          durationMinutes: 45,
          status: 'scheduled',
        },
      ],
    );

    expect(result.ok).toBe(false);
    expect(result.missingAgendaSessionIds).toEqual(['101']);
    expect(result.duplicateAgendaKeys).toEqual(['100']);
    expect(result.mismatches).toEqual(expect.arrayContaining([
      { sessionId: '100', field: 'planVersion', planValue: '3', agendaValue: '2' },
      { sessionId: '100', field: 'timezone', planValue: 'Europe/Lisbon', agendaValue: 'UTC' },
      { sessionId: '100', field: 'startTime', planValue: '07:00', agendaValue: '07:30' },
    ]));
  });
});

describe('training plan quality scoring', () => {
  it('passes a varied event plan with taper, recovery spacing, strength balance, and supported equipment', () => {
    const score = scoreTrainingPlanQuality(goodCandidate());

    expect(score.verdict).toBe('pass');
    expect(score.score).toBeGreaterThanOrEqual(82);
    expect(score.blockers).toEqual([]);
    expect(score.evidenceBaselineIds).toEqual(expect.arrayContaining(['WHO-2020-PA', 'ACSM-RT-2026', 'IOC-REDS-2023']));
    expect(score.dimensions.map((dimension) => dimension.dimension)).toEqual(expect.arrayContaining([
      'deload_logic',
      'safety_downgrades',
      'equipment_fit',
      'objective_fidelity',
    ]));
  });

  it('fails an overpacked red-flag plan with incoherent progression and unavailable equipment', () => {
    const score = scoreTrainingPlanQuality(badCandidate());

    expect(score.verdict).toBe('fail');
    expect(score.blockers.join(' ')).toContain('Safety red-flag');
    expect(score.blockers.join(' ')).toContain('unavailable equipment');
    expect(score.blockers.join(' ')).toContain('load jumps');
  });

  it('warns when objective fidelity detects weight loss drift without changing runtime inference', () => {
    const candidate = goodCandidate();
    candidate.objective = 'weight_loss';
    candidate.goalMode = 'continuous';
    candidate.engineGoal = 'general_fitness';

    const score = scoreTrainingPlanQuality(candidate);

    expect(score.verdict).toBe('warn');
    expect(score.blockers).toEqual([]);
    expect(score.dimensions.find((dimension) => dimension.dimension === 'objective_fidelity')?.score).toBeLessThan(82);
  });

  it('accepts a single recovery phase only when the candidate carries an explicit durable rationale', () => {
    const candidate = goodCandidate();
    candidate.goalMode = 'return_to_training';
    candidate.weeks = candidate.weeks.map((week) => ({ ...week, phase: 'deload' }));
    candidate.rationaleNotes = [
      'Maintenance/recovery rationale: this plan remains recovery-led while declared knee discomfort is active.',
    ];

    const score = scoreTrainingPlanQuality(candidate);
    const periodization = score.dimensions.find((dimension) => dimension.dimension === 'periodization');

    expect(periodization?.blockers).toEqual([]);
    expect(periodization?.observations.join(' ')).toMatch(/explicit maintenance\/recovery rationale: true/i);

    // The prefix alone is not evidence. Keep this fail-closed so a copy edit
    // cannot bypass the multi-phase invariant without naming the real cause.
    candidate.rationaleNotes = ['Maintenance/recovery rationale: unchanged.'];
    const unsupported = scoreTrainingPlanQuality(candidate);
    expect(unsupported.dimensions.find((dimension) => dimension.dimension === 'periodization')?.blockers)
      .toEqual(expect.arrayContaining([
        'Four-plus-week plans need more than one phase or an explicit maintenance rationale.',
      ]));
  });

  it('keeps deload and safety downgrade checks standalone from the broader adaptation score', () => {
    const noDeload = goodCandidate();
    noDeload.weeks = noDeload.weeks.map((week) => ({
      ...week,
      phase: 'base',
      sessions: week.weekNumber === 4
        ? week.sessions.map((session) => ({ ...session, durationMinutes: 80 }))
        : week.sessions,
    }));
    const noDeloadScore = scoreTrainingPlanQuality(noDeload);
    const redFlagScore = scoreTrainingPlanQuality(badCandidate());

    expect(noDeloadScore.dimensions.find((dimension) => dimension.dimension === 'deload_logic')?.blockers.join(' '))
      .toContain('deload');
    expect(redFlagScore.dimensions.find((dimension) => dimension.dimension === 'safety_downgrades')?.blockers.join(' '))
      .toContain('Safety red-flag');
  });

  it('requires explicit readiness adaptation copy instead of any non-empty reason', () => {
    const candidate = goodCandidate();
    candidate.readinessState = 'low_readiness';
    candidate.weeks = candidate.weeks.map((week) => ({
      ...week,
      sessions: week.sessions.map((session) => ({
        ...session,
        adaptationReason: undefined,
        safetyDowngradeReason: undefined,
      })),
    }));
    candidate.weeks[0].sessions[0].adaptationReason = 'Regular training description.';

    const unsupported = scoreTrainingPlanQuality(candidate);
    expect(unsupported.dimensions.find((dimension) => dimension.dimension === 'readiness_adaptation')?.blockers)
      .toEqual(expect.arrayContaining([
        'Readiness state low_readiness requires visible adaptation or safety rationale.',
      ]));

    // Generic execution guidance names fatigue and a stopping action, but it
    // does not say that readiness caused the plan to change. Keep that copy
    // from laundering an unchanged session through the safety gate.
    candidate.weeks[0].sessions[0].adaptationReason =
      'Stop every set well before fatigue accumulates.';
    const genericExecutionCue = scoreTrainingPlanQuality(candidate);
    expect(genericExecutionCue.dimensions.find((dimension) => dimension.dimension === 'readiness_adaptation')?.blockers)
      .toEqual(expect.arrayContaining([
        'Readiness state low_readiness requires visible adaptation or safety rationale.',
      ]));

    candidate.weeks[0].sessions[0].adaptationReason =
      'Feedback loop: reduce load today because readiness and fatigue signals are constrained.';
    const explicit = scoreTrainingPlanQuality(candidate);
    expect(explicit.dimensions.find((dimension) => dimension.dimension === 'readiness_adaptation')?.blockers)
      .toEqual([]);
  });
});

function goodCandidate(): TrainingPlanQualityCandidate {
  return {
    objective: 'Lisbon Marathon',
    goalMode: 'event_based',
    readinessState: 'high_readiness',
    equipmentState: 'dumbbells',
    weeks: [
      {
        weekNumber: 1,
        phase: 'base',
        sessions: [
          run('w1-run-easy', 1, 'Monday', 'Easy Run', 45, 'easy'),
          strength('w1-strength-a', 1, 'Tuesday', ['squat', 'hinge'], ['dumbbells']),
          run('w1-run-tempo', 1, 'Thursday', 'Tempo Run', 50, 'hard', true),
          run('w1-long', 1, 'Saturday', 'Long Run', 75, 'easy', true),
        ],
      },
      {
        weekNumber: 2,
        phase: 'build',
        sessions: [
          run('w2-run-easy', 2, 'Monday', 'Easy Run', 50, 'easy'),
          strength('w2-strength-a', 2, 'Tuesday', ['push', 'pull', 'lunge'], ['dumbbells']),
          run('w2-run-tempo', 2, 'Thursday', 'Threshold Run', 55, 'hard', true),
          run('w2-long', 2, 'Saturday', 'Long Run', 85, 'easy', true),
        ],
      },
      {
        weekNumber: 3,
        phase: 'peak',
        sessions: [
          run('w3-run-easy', 3, 'Monday', 'Easy Run', 55, 'easy'),
          strength('w3-strength-a', 3, 'Tuesday', ['squat', 'pull', 'carry'], ['dumbbells']),
          run('w3-run-tempo', 3, 'Thursday', 'Marathon Pace', 60, 'moderate', true),
          run('w3-long', 3, 'Saturday', 'Long Run', 95, 'easy', true),
        ],
      },
      {
        weekNumber: 4,
        phase: 'taper',
        sessions: [
          run('w4-run-easy', 4, 'Monday', 'Easy Run', 35, 'easy'),
          strength('w4-strength-a', 4, 'Tuesday', ['push', 'hinge', 'core'], ['dumbbells']),
          run('w4-race-prep', 4, 'Thursday', 'Race Prep', 35, 'moderate', true),
        ],
      },
    ],
  };
}

function badCandidate(): TrainingPlanQualityCandidate {
  return {
    objective: 'Marathon',
    goalMode: 'event_based',
    readinessState: 'red_flag',
    equipmentState: 'bodyweight',
    weeks: [
      {
        weekNumber: 1,
        phase: 'base',
        sessions: [
          run('w1-hard-1', 1, 'Monday', 'Hard Intervals', 30, 'hard', true),
          run('w1-hard-2', 1, 'Monday', 'Hard Hills', 40, 'hard', true),
          strength('w1-machine', 1, 'Monday', ['squat'], ['barbell', 'cable machine']),
        ],
      },
      {
        weekNumber: 2,
        phase: 'base',
        sessions: [
          run('w2-hard-1', 2, 'Tuesday', 'Hard Intervals', 180, 'hard', true),
          run('w2-hard-2', 2, 'Wednesday', 'Hard Tempo', 120, 'hard', true),
          run('w2-hard-3', 2, 'Thursday', 'Hard Long Run', 120, 'hard', true),
        ],
      },
    ],
  };
}

function run(
  id: string,
  weekNumber: number,
  dayOfWeek: string,
  title: string,
  durationMinutes: number,
  intensity: 'easy' | 'moderate' | 'hard' | 'recovery',
  keySession = false,
) {
  return {
    id,
    weekNumber,
    dayOfWeek,
    sport: 'running' as const,
    title,
    sessionType: title.toLowerCase().replace(/\s+/g, '_'),
    durationMinutes,
    intensity,
    keySession,
    startTime: '07:00',
    equipment: [],
    movementPatterns: [],
  };
}

function strength(
  id: string,
  weekNumber: number,
  dayOfWeek: string,
  movementPatterns: string[],
  equipment: string[],
) {
  return {
    id,
    weekNumber,
    dayOfWeek,
    sport: 'strength' as const,
    title: 'Strength Session',
    sessionType: 'strength',
    durationMinutes: 45,
    intensity: 'moderate' as const,
    keySession: false,
    startTime: '18:00',
    equipment,
    movementPatterns,
  };
}
