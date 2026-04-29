// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildWeekPlan } from '../planner-engine';
import type { AthleteState, Session, WeeklyPlan } from '../types';
import { trainingEvalPersonaBank } from './personas';
import { evaluatePlanAgainstRubric, TRAINING_EVAL_DIMENSION_WEIGHTS } from './rubric';
import { trainingEvalScenarioBank } from './scenarios';
import type {
  TrainingEvalAggregate,
  TrainingEvalCase,
  TrainingEvalCaseResult,
  TrainingEvalDimension,
  TrainingEvalDimensionScore,
  TrainingEvalPersona,
  TrainingEvalRunResult,
  TrainingEvalScenario,
} from './types';

export interface TrainingEvalRunOptions {
  weekStart?: string;
  generatedAt?: string;
  personas?: TrainingEvalPersona[];
  scenarios?: TrainingEvalScenario[];
  engine?: {
    packageVersion: string;
    gitCommit?: string;
    gitBranch?: string;
  };
}

const defaultWeekStart = '2026-04-27';
const defaultGeneratedAt = '2026-04-27T23:59:00.000Z';

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function countBySport(sessions: Session[]): Partial<Record<Session['sport'], number>> {
  return sessions.reduce<Partial<Record<Session['sport'], number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + 1;
    return acc;
  }, {});
}

function summarizePlan(plan: WeeklyPlan): TrainingEvalCaseResult['planSummary'] {
  return {
    weekStart: plan.weekStart,
    phase: plan.phase,
    discipline: plan.discipline,
    totalSessions: plan.sessions.length,
    sessionsBySport: countBySport(plan.sessions),
    totalMinutes: plan.sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
    keySessions: plan.sessions.filter((session) => session.keySession).length,
  };
}

function weightedScore(scores: TrainingEvalDimensionScore[]): number {
  const weightSum = scores.reduce((sum, item) => sum + item.weight, 0);
  if (weightSum <= 0) return 0;
  return Math.round(scores.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum);
}

function buildCaseId(persona: TrainingEvalPersona, scenario: TrainingEvalScenario): string {
  return `${persona.id}__${scenario.id}`;
}

export function buildTrainingEvalCases(
  personas: TrainingEvalPersona[] = trainingEvalPersonaBank,
  scenarios: TrainingEvalScenario[] = trainingEvalScenarioBank,
  weekStart = defaultWeekStart,
): TrainingEvalCase[] {
  return personas.flatMap((persona) =>
    scenarios.map((scenario) => ({
      id: buildCaseId(persona, scenario),
      persona,
      scenario,
      athlete: scenario.apply({ persona, baseWeekStart: weekStart }),
      weekStart,
    }))
  );
}

function failureScores(message: string): TrainingEvalDimensionScore[] {
  return (Object.keys(TRAINING_EVAL_DIMENSION_WEIGHTS) as TrainingEvalDimension[]).map((dimension) => ({
    dimension,
    score: 0,
    weight: TRAINING_EVAL_DIMENSION_WEIGHTS[dimension],
    observations: [],
    penalties: [message],
  }));
}

function evaluateCase(evalCase: TrainingEvalCase): TrainingEvalCaseResult {
  try {
    const plan = buildWeekPlan(evalCase.athlete, evalCase.weekStart);
    let nextVersionPlan: WeeklyPlan | undefined;
    if (evalCase.scenario.expectations?.compareWithNextVersion) {
      const nextAthlete: AthleteState = {
        ...evalCase.athlete,
        currentBlock: {
          ...evalCase.athlete.currentBlock,
          weekIndex: evalCase.athlete.currentBlock.weekIndex + 1,
        },
      };
      nextVersionPlan = buildWeekPlan(nextAthlete, addDays(evalCase.weekStart, 7));
    }
    const dimensionScores = evaluatePlanAgainstRubric(evalCase, plan, nextVersionPlan);
    const criticalFailures = dimensionScores
      .filter((item) => item.score < 50)
      .map((item) => `${item.dimension}: ${item.penalties.join(' ') || 'score below 50'}`);
    return {
      caseId: evalCase.id,
      personaId: evalCase.persona.id,
      personaName: evalCase.persona.name,
      scenarioId: evalCase.scenario.id,
      scenarioName: evalCase.scenario.name,
      score: weightedScore(dimensionScores),
      planSummary: summarizePlan(plan),
      dimensionScores,
      criticalFailures,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dimensionScores = failureScores(`Plan generation threw: ${message}`);
    return {
      caseId: evalCase.id,
      personaId: evalCase.persona.id,
      personaName: evalCase.persona.name,
      scenarioId: evalCase.scenario.id,
      scenarioName: evalCase.scenario.name,
      score: 0,
      planSummary: {
        weekStart: evalCase.weekStart,
        phase: evalCase.athlete.currentBlock.phase,
        discipline: evalCase.athlete.goals.primaryFocus,
        totalSessions: 0,
        sessionsBySport: {},
        totalMinutes: 0,
        keySessions: 0,
      },
      dimensionScores,
      criticalFailures: [`Plan generation threw: ${message}`],
    };
  }
}

function aggregateResults(
  results: TrainingEvalCaseResult[],
  personaCount: number,
  scenarioCount: number,
): TrainingEvalAggregate {
  const dimensions = Object.keys(TRAINING_EVAL_DIMENSION_WEIGHTS) as TrainingEvalDimension[];
  const dimensionAverages = dimensions.reduce<Record<TrainingEvalDimension, number>>((acc, dimension) => {
    const values = results
      .map((result) => result.dimensionScores.find((score) => score.dimension === dimension)?.score)
      .filter((value): value is number => typeof value === 'number');
    acc[dimension] = values.length > 0
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    return acc;
  }, {} as Record<TrainingEvalDimension, number>);

  return {
    overallScore: results.length > 0
      ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length)
      : 0,
    caseCount: results.length,
    personaCount,
    scenarioCount,
    dimensionAverages,
    lowestCases: [...results]
      .sort((left, right) => left.score - right.score)
      .slice(0, 10)
      .map((result) => ({
        caseId: result.caseId,
        personaName: result.personaName,
        scenarioName: result.scenarioName,
        score: result.score,
        criticalFailures: result.criticalFailures,
      })),
  };
}

export function runTrainingCoachBenchmark(options: TrainingEvalRunOptions = {}): TrainingEvalRunResult {
  const personas = options.personas ?? trainingEvalPersonaBank;
  const scenarios = options.scenarios ?? trainingEvalScenarioBank;
  const weekStart = options.weekStart ?? defaultWeekStart;
  const cases = buildTrainingEvalCases(personas, scenarios, weekStart);
  const results = cases.map(evaluateCase);
  return {
    generatedAt: options.generatedAt ?? defaultGeneratedAt,
    weekStart,
    engine: options.engine ?? { packageVersion: 'unknown' },
    aggregate: aggregateResults(results, personas.length, scenarios.length),
    cases: results,
  };
}

export function renderTrainingEvalMarkdown(result: TrainingEvalRunResult): string {
  const lines: string[] = [];
  lines.push('# Training Coach Evaluation Baseline Results');
  lines.push('');
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Week start: ${result.weekStart}`);
  lines.push(`Engine version: ${result.engine.packageVersion}`);
  if (result.engine.gitBranch || result.engine.gitCommit) {
    lines.push(`Git: ${result.engine.gitBranch ?? 'unknown'} @ ${result.engine.gitCommit ?? 'unknown'}`);
  }
  lines.push('');
  lines.push('## Aggregate Score');
  lines.push('');
  lines.push(`Overall score: **${result.aggregate.overallScore}/100** across ${result.aggregate.caseCount} cases (${result.aggregate.personaCount} personas × ${result.aggregate.scenarioCount} scenarios).`);
  lines.push('');
  lines.push('| Dimension | Average |');
  lines.push('| --- | ---: |');
  for (const [dimension, average] of Object.entries(result.aggregate.dimensionAverages)) {
    lines.push(`| ${dimension} | ${average} |`);
  }
  lines.push('');
  lines.push('## Lowest Scoring Cases');
  lines.push('');
  lines.push('| Case | Persona | Scenario | Score | Critical failures |');
  lines.push('| --- | --- | --- | ---: | --- |');
  for (const item of result.aggregate.lowestCases) {
    lines.push(`| ${item.caseId} | ${item.personaName} | ${item.scenarioName} | ${item.score} | ${item.criticalFailures.join('<br>') || 'None'} |`);
  }
  lines.push('');
  lines.push('## Case Matrix');
  lines.push('');
  lines.push('| Persona | Scenario | Score | Phase | Sessions | Minutes | Sports |');
  lines.push('| --- | --- | ---: | --- | ---: | ---: | --- |');
  for (const item of result.cases) {
    const sports = Object.entries(item.planSummary.sessionsBySport).map(([sport, count]) => `${sport}:${count}`).join(', ');
    lines.push(`| ${item.personaName} | ${item.scenarioName} | ${item.score} | ${item.planSummary.phase} | ${item.planSummary.totalSessions} | ${item.planSummary.totalMinutes} | ${sports || 'none'} |`);
  }
  lines.push('');
  lines.push('## How To Read This');
  lines.push('');
  lines.push('- Scores are rubric-based, not snapshots. A branch can change exact sessions and still improve if the rubric dimensions rise.');
  lines.push('- Dimensions below 50 become critical failures for that case.');
  lines.push('- This baseline should be regenerated after meaningful Training-engine changes and compared branch-to-branch.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

