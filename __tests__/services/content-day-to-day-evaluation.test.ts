import { describe, expect, it } from 'vitest';
import {
  CONTENT_PERSONA_BANK,
  CONTENT_QUALITY_RUBRIC,
  CONTENT_SCENARIO_BANK,
  formatContentEvalResultsMarkdown,
  runContentDayToDayEvaluation,
} from '../../src/services/content-day-to-day-evaluation';

describe('Content day-to-day evaluation harness', () => {
  it('defines the required persona bank for realistic Content Creation work', () => {
    const personaIds = new Set(CONTENT_PERSONA_BANK.map((persona) => persona.id));

    expect(personaIds).toEqual(new Set([
      'solo_creator',
      'creator_with_references',
      'strong_voice_creator',
      'weak_setup_creator',
      'training_milestone_creator',
      'tight_schedule_creator',
      'multi_tenant_brand_creator',
      'tenant_admin_reviewer',
      'voice_correction_user',
      'repeat_rejection_user',
    ]));
  });

  it('defines multi-turn workflow scenarios instead of one-shot snapshot prompts', () => {
    const scenarioIds = new Set(CONTENT_SCENARIO_BANK.map((scenario) => scenario.id));

    expect(scenarioIds).toEqual(new Set([
      'book_reference_to_script',
      'voice_refinement_to_short_form',
      'secretary_schedules_writing_block',
      'radar_dismiss_and_explain',
      'reject_repeated_topic',
      'training_milestone_to_content',
      'tenant_brand_switch_safety',
      'same_style_as_last_week',
      'remove_unsupported_claims',
      'weekly_content_plan',
    ]));
    expect(CONTENT_SCENARIO_BANK.every((scenario) => scenario.turns.length >= 3)).toBe(true);
    expect(CONTENT_SCENARIO_BANK.every((scenario) => scenario.requiredWorkflow.length > 0)).toBe(true);
  });

  it('scores content quality by rubric dimensions rather than exact wording', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    const rubricIds = CONTENT_QUALITY_RUBRIC.map((dimension) => dimension.id).sort();

    expect(result.aggregate.caseCount).toBeGreaterThanOrEqual(10);
    expect(result.aggregate.overallScore).toBeGreaterThanOrEqual(85);
    expect(result.aggregate.criticalFailureCount).toBe(0);
    expect(result.passed).toBe(true);

    for (const testCase of result.cases) {
      expect(Object.keys(testCase.dimensionScores).sort()).toEqual(rubricIds);
      expect(testCase.output.transcript.length).toBeGreaterThanOrEqual(3);
      expect(testCase.output.providerTrace.productionDataUsed).toBe(false);
      expect(testCase.output.providerTrace.preservesLiveRouting).toBe(true);
      expect(testCase.output.providerTrace.category).toBe('content_day_to_day_eval');
    }
  });

  it('keeps tenant and brand context partitioned during tenant-switch scenarios', () => {
    const result = runContentDayToDayEvaluation({ mode: 'fixture' });
    const tenantSwitch = result.cases.find((testCase) => testCase.scenarioId === 'tenant_brand_switch_safety');

    expect(tenantSwitch).toBeDefined();
    expect(tenantSwitch?.dimensionScores.tenant_safety).toBe(100);
    expect(tenantSwitch?.failures).not.toContain('wrong_tenant_reference');
    expect(tenantSwitch?.output.referencesUsed.every((ref) => ref.tenantId === tenantSwitch.output.tenantId)).toBe(true);
  });

  it('treats repeated ideas as a novelty and workflow problem, not a text snapshot problem', () => {
    const result = runContentDayToDayEvaluation({ mode: 'fixture' });
    const repeatCase = result.cases.find((testCase) => testCase.scenarioId === 'reject_repeated_topic');

    expect(repeatCase).toBeDefined();
    expect(repeatCase?.output.noveltyStatus).toBe('duplicate_suppressed');
    expect(repeatCase?.dimensionScores.novelty).toBeGreaterThanOrEqual(90);
    expect(repeatCase?.failures).not.toContain('duplicate_idea');
  });

  it('renders a baseline report with failure taxonomy and release conditions', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    const markdown = formatContentEvalResultsMarkdown(result);

    expect(markdown).toContain('# Content Day-to-Day Evaluation Baseline Results');
    expect(markdown).toContain('Failure Taxonomy Counts');
    expect(markdown).toContain('Release gate');
    expect(markdown).toContain('full local Nexus engine smoke remains required');
  });
});
