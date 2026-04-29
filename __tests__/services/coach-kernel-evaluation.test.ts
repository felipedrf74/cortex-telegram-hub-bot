import { describe, expect, it } from 'vitest';

import {
  buildTrainingEvalCases,
  evaluatePlanAgainstRubric,
  renderTrainingEvalMarkdown,
  runTrainingCoachBenchmark,
  trainingEvalPersonaBank,
  trainingEvalScenarioBank,
  TRAINING_EVAL_DIMENSION_WEIGHTS,
} from '../../src/services/coach-kernel/evaluation';
import type { WeeklyPlan } from '../../src/services/coach-kernel/types';

describe('training coach evaluation harness', () => {
  it('ships a representative persona bank for coach-quality coverage', () => {
    const ids = new Set(trainingEvalPersonaBank.map((persona) => persona.id));

    expect(trainingEvalPersonaBank.length).toBeGreaterThanOrEqual(13);
    expect([...ids]).toEqual(expect.arrayContaining([
      'beginner-gym-dumbbells',
      'intermediate-hypertrophy-full-gym',
      'advanced-strength-focused',
      'runner-half-marathon',
      'cyclist-ftp-build',
      'hybrid-gym-running',
      'hybrid-gym-cycling',
      'low-time-user',
      'inconsistent-adherence-user',
      'equipment-limited-home',
      'travel-week-hotel-gym',
      'discomfort-knee-limitation',
      'explicit-cycle-aware-user',
    ]));

    for (const persona of trainingEvalPersonaBank) {
      expect(persona.athlete.profile.athleteId).toBeGreaterThan(0);
      expect(persona.athlete.availability.weeklyWindows.length).toBeGreaterThan(0);
      expect(persona.expectations.expectedSports.length).toBeGreaterThan(0);
    }
  });

  it('ships a scenario bank that exercises adaptation, schedule, feedback, safety, profile, and agenda lifecycle pressure', () => {
    const ids = new Set(trainingEvalScenarioBank.map((scenario) => scenario.id));
    const categories = new Set(trainingEvalScenarioBank.map((scenario) => scenario.category));

    expect(trainingEvalScenarioBank.length).toBeGreaterThanOrEqual(12);
    expect([...ids]).toEqual(expect.arrayContaining([
      'baseline-current-profile',
      'missed-key-session',
      'reduced-available-time',
      'plan-cancel-regenerate',
      'plateau-signals',
      'poor-recovery',
      'travel-hotel-gym',
      'schedule-change-one-session-per-day',
      'feedback-too-hard-easy-long',
      'missing-fueling-coverage',
      'weak-profile-completeness',
      'discomfort-substitution',
    ]));
    expect([...categories]).toEqual(expect.arrayContaining([
      'adaptation',
      'calendar_lifecycle',
      'feedback',
      'profile_completeness',
      'schedule',
      'safety',
      'travel',
    ]));
  });

  it('builds the persona × scenario matrix without collapsing cases', () => {
    const personas = trainingEvalPersonaBank.slice(0, 3);
    const scenarios = trainingEvalScenarioBank.slice(0, 4);
    const cases = buildTrainingEvalCases(personas, scenarios, '2026-04-27');

    expect(cases).toHaveLength(personas.length * scenarios.length);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.some((item) => item.scenario.expectations?.compareWithNextVersion)).toBe(true);
  });

  it('runs a bounded benchmark and returns weighted scores for every rubric dimension', () => {
    const personas = [
      trainingEvalPersonaBank.find((persona) => persona.id === 'beginner-gym-dumbbells')!,
      trainingEvalPersonaBank.find((persona) => persona.id === 'runner-half-marathon')!,
      trainingEvalPersonaBank.find((persona) => persona.id === 'hybrid-gym-running')!,
    ];
    const scenarios = [
      trainingEvalScenarioBank.find((scenario) => scenario.id === 'baseline-current-profile')!,
      trainingEvalScenarioBank.find((scenario) => scenario.id === 'reduced-available-time')!,
      trainingEvalScenarioBank.find((scenario) => scenario.id === 'plan-cancel-regenerate')!,
      trainingEvalScenarioBank.find((scenario) => scenario.id === 'discomfort-substitution')!,
    ];

    const result = runTrainingCoachBenchmark({
      personas,
      scenarios,
      weekStart: '2026-04-27',
      generatedAt: '2026-04-27T00:00:00.000Z',
      engine: { packageVersion: 'test' },
    });

    expect(result.aggregate.caseCount).toBe(personas.length * scenarios.length);
    expect(result.aggregate.personaCount).toBe(personas.length);
    expect(result.aggregate.scenarioCount).toBe(scenarios.length);
    expect(result.aggregate.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.aggregate.overallScore).toBeLessThanOrEqual(100);

    const expectedDimensions = Object.keys(TRAINING_EVAL_DIMENSION_WEIGHTS).sort();
    for (const item of result.cases) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(100);
      expect(item.dimensionScores.map((score) => score.dimension).sort()).toEqual(expectedDimensions);
      expect(item.planSummary.weekStart).toBe('2026-04-27');
    }

    const markdown = renderTrainingEvalMarkdown(result);
    expect(markdown).toContain('# Training Coach Evaluation Baseline Results');
    expect(markdown).toContain('Overall score:');
    expect(markdown).toContain('## Case Matrix');
  });

  it('scores the sparse 48-minute Dead Bug regression as a time-volume penalty', () => {
    const persona = trainingEvalPersonaBank.find((item) => item.id === 'beginner-gym-dumbbells')!;
    const scenario = trainingEvalScenarioBank.find((item) => item.id === 'baseline-current-profile')!;
    const evalCase = buildTrainingEvalCases([persona], [scenario], '2026-04-27')[0];
    const sparsePlan: WeeklyPlan = {
      athleteId: persona.athlete.profile.athleteId,
      weekStart: '2026-04-27',
      discipline: 'strength',
      phase: 'base',
      notes: ['Evaluation fixture: sparse strength regression.'],
      guardrailResults: [],
      sessions: [{
        id: 'sparse-dead-bug',
        sport: 'strength',
        sessionType: 'strength_hypertrophy',
        title: 'Sparse Strength Regression',
        description: 'A too-small exercise list claiming a long session.',
        dayOfWeek: 'monday',
        startTime: '12:00',
        endTime: '12:48',
        durationMinutes: 48,
        intensityZone: 'tempo',
        fatigueCost: 'medium',
        keySession: false,
        plannedLoad: 100,
        tags: ['eval_fixture'],
        exercises: [{ exerciseId: 'dead_bug', name: 'Dead Bug', sets: 2, reps: '10-15', restSec: 60 }],
      }],
    };

    const scores = evaluatePlanAgainstRubric(evalCase, sparsePlan);
    const timeScore = scores.find((item) => item.dimension === 'time_volume_coherence')!;

    expect(timeScore.score).toBeLessThan(100);
    expect(timeScore.penalties.join(' ')).toContain('Sparse Strength Regression');
    expect(timeScore.penalties.join(' ')).toMatch(/action (rebuild|shrinkDuration|trimContent)/);
  });
});
