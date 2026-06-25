// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Training skill hardening (2026-05-19):
// Source/contract pins for plan requirements that are intentionally served by
// the existing Training architecture rather than by new V2-style services.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';

const repoRoot = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function listFiles(root: string): string[] {
  const absoluteRoot = join(repoRoot, root);
  const output: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = join(dir, entry);
      const relativePath = absolutePath.slice(repoRoot.length + 1);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
      } else if (/\.(ts|md|json|yaml)$/.test(entry)) {
        output.push(relativePath);
      }
    }
  }

  walk(absoluteRoot);
  return output;
}

describe('training skill hardening source contracts', () => {
  it('keeps durable coaching knowledge in reusable coach-kernel assets', () => {
    const knowledge = loadCoachKnowledge();

    expect(knowledge.exercises.length).toBeGreaterThan(10);
    expect(knowledge.workoutTemplates.length).toBeGreaterThan(8);
    expect(Array.from(new Set(knowledge.workoutTemplates.map((template) => template.sport)))).toEqual(
      expect.arrayContaining(['running', 'cycling', 'swimming', 'strength']),
    );
    expect(knowledge.docs.hybridAthleteRules).toContain('Endurance priority wins');
    expect(knowledge.docs.marathonPeriodization).toMatch(/taper/i);
    expect(knowledge.docs.llmToolContract).toContain('The LLM is an orchestrator, not the coach brain');
    expect(knowledge.docs.llmToolContract).toContain('Do not invent training prescriptions');
    expect(knowledge.docs.llmToolContract).toContain('Do not bypass guardrail results');

    const loader = read('src/services/coach-kernel/knowledge-loader.ts');
    expect(loader).toContain("knowledgePath('templates', 'run-workouts.yaml')");
    expect(loader).toContain("knowledgePath('templates', 'bike-workouts.yaml')");
    expect(loader).toContain("knowledgePath('templates', 'swim-workouts.yaml')");
    expect(loader).toContain("knowledgePath('templates', 'strength-blocks.yaml')");
    expect(loader).toContain("knowledgePath('docs', 'llm-tool-contract.md')");
  });

  it('keeps adaptation, what-changed, and feedback loops deterministic', () => {
    const planner = read('src/services/coach-kernel/planner-engine.ts');
    const homeState = read('src/services/training-home-view-state.ts');
    const history = read('src/services/training-history.ts');
    const feedback = read('src/services/coach-kernel/feedback-analysis.ts');

    expect(planner).toContain('analyzeTrainingFeedback');
    expect(planner).toContain('applyFeedbackToAthleteState');
    expect(planner).toContain('applyFeedbackToWeeklyPlan');
    expect(planner).toContain('decisionReasonsFromGuardrails');
    expect(planner).toContain('why today changed');
    expect(homeState).toContain('authoritative "what changed"');
    expect(homeState).toContain('kernelAdjustments');
    expect(history).toContain("tags.add('too_hard')");
    expect(history).toContain("tags.add('too_easy')");
    expect(history).toContain("tags.add('pain')");
    expect(history).toContain("tags.add('substitution')");
    expect(feedback).toContain('too_hard_intensity_downshift');
    expect(feedback).toContain('too_easy_progression');
    expect(feedback).toContain('repeated_substitution_review');
  });

  it('keeps cross-skill orchestration explicit and Training-scoped', () => {
    const signals = read('src/services/training-signals.ts');
    const crossAgent = read('src/services/cross-agent-learning.ts');

    expect(signals).toContain('publishTrainingSessionScheduled');
    expect(signals).toContain('readScheduledTrainingSessions');
    expect(signals).toContain('publishFuelingGapRisk');
    expect(signals).toContain('publishTrainingBudgetConstraint');
    expect(signals).toContain('readTrainingContext');
    expect(signals).toContain('fuelingGap');
    expect(signals).toContain('budgetConstraint');
    expect(signals).toContain('calendarConflict');
    expect(signals).toContain('Avoid paid gear, subscriptions, and supplement asks');
    expect(crossAgent).toContain('fueling_support_status');
    expect(crossAgent).toContain('budget_remaining');
    expect(crossAgent).toContain('trainingSpendMode');
  });

  it('keeps LLM cost boundaries explicit for the operational plan path', () => {
    const routes = read('src/api/routes/training-plan-routes.ts');
    const generator = read('src/api/routes/training-plan-generation.ts');
    const coach = read('src/services/garmin-coach.ts');

    expect(routes).toContain('acquireCostLock');
    expect(routes).toContain('enforceCostGuardrails');
    expect(routes).toContain('future explanation call');
    expect(routes).toContain('should not create a training-plan api_usage row');
    expect(generator).toContain('buildCoachKernelTrainingPlan');
    expect(generator).not.toMatch(/\bGemini\b|\bOpenAI\b|\banthropic\b|\bgenerateText\b|\bapi_usage\b/i);
    expect(coach).toContain("'coach_analysis'");
    expect(coach).toContain("export type CoachAnalysisMeteringActor = 'user' | 'system'");
    expect(coach).toContain('COACH_ANALYSIS_SYSTEM_METERING_USER_ID');
    expect(coach).toContain('COACH_ANALYSIS_SYSTEM_METERING_TENANT_ID');
    expect(coach).toContain("requireTenantIdParam(opts.tenantId, 'generateCoachBriefing')");
    expect(coach).toContain('meteringActor: meteringScope.actor');
    expect(coach).toContain('{ maxTokens: 2500, userId: meteringScope.userId, tenantId: meteringScope.tenantId }');
    expect(coach).toContain("{ userId: meteringScope.userId, tenantId: meteringScope.tenantId }");
  });

  it('keeps Training generation version pins sourced from the canonical catalog snapshot', () => {
    const generator = read('src/api/routes/training-plan-generation.ts');

    expect(generator).toContain('const snapshot = loadTrainingCatalogSnapshot({ tenantId })');
    expect(generator).toContain('catalogVersion: snapshot.catalogVersion');
    expect(generator).toContain('sciencePolicyVersion: snapshot.sciencePolicyVersion');
    expect(generator).toContain('selectorPolicyVersion: snapshot.selectorPolicyVersion');
    expect(generator).toContain('equipmentVocabularyVersion: snapshot.equipmentVocabularyVersion');
    expect(generator).toContain('generationPipelineVersion: snapshot.generationPipelineVersion');
    expect(generator).not.toContain('STRENGTH_SELECTOR_POLICY_VERSION');
    expect(generator).not.toContain('EQUIPMENT_VOCABULARY_VERSION');
    expect(generator).not.toContain('GENERATION_PIPELINE_VERSION');
  });

  it('keeps strength exercise metadata sourced from the canonical catalog seed with emergency-only compatibility fallbacks', () => {
    const taxonomy = read('src/services/coach-kernel/training-taxonomy.ts');

    expect(taxonomy).toContain("import { buildRepoTrainingCatalogSnapshot, type ExerciseCatalogEntry } from './training-catalog'");
    expect(taxonomy).toContain('const EMERGENCY_EXERCISE_LIBRARY');
    expect(taxonomy).toContain('export const EXERCISE_LIBRARY: ExerciseDefinition[] = buildCanonicalExerciseLibrary()');
    expect(taxonomy).toContain('const snapshot = buildRepoTrainingCatalogSnapshot()');
    expect(taxonomy).toContain('return mergeExerciseDefinitions(catalogDefinitions, EMERGENCY_EXERCISE_LIBRARY)');
    expect(taxonomy).toContain('function refineCatalogMuscles');
    expect(taxonomy).toContain("movementPattern === 'lateral_raise'");
    expect(taxonomy).toContain("movementPattern === 'knee_flexion'");
  });

  it('does not introduce Training V2 or CoachKernelV2 pollution', () => {
    const trainingFiles = [
      ...listFiles('src/services/coach-kernel'),
      ...listFiles('src/api/routes').filter((file) => file.includes('training')),
      ...listFiles('src/services').filter((file) => file.includes('training')),
    ];
    const joined = trainingFiles
      .map((file) => `${file}\n${read(file)}`)
      .join('\n---\n');

    expect(joined).not.toMatch(/CoachKernelV2|TrainingCoachKernelV2|training[-_ ]?v2/i);
  });
});
