import { describe, expect, it } from 'vitest';
import {
  CHAT_EVAL_PERSONAS,
  CHAT_EVAL_SCENARIOS,
  CHAT_EVAL_SCORING_DIMENSIONS,
  CHAT_QUALITY_METRICS,
  formatChatEvaluationResultsMarkdown,
  runChatEvaluationSuite,
  type ChatEvalScenarioId,
  type ChatEvalScoringDimension,
  type ChatQualityMetricId,
} from '../../src/services/chat-evaluation-harness';

describe('chat evaluation harness', () => {
  it('defines the requested persona bank without production ids', () => {
    const personaIds = new Set(CHAT_EVAL_PERSONAS.map((persona) => persona.id));

    expect(personaIds).toEqual(new Set([
      'normal_user',
      'training_user',
      'multi_skill_planner',
      'content_creator',
      'tenant_admin',
      'platform_admin',
      'unauthorized_attacker',
      'multi_tenant_user',
      'frustrated_user',
      'longitudinal_user',
    ]));
    expect(CHAT_EVAL_PERSONAS.every((persona) => persona.userId >= 9000)).toBe(true);
    expect(CHAT_EVAL_PERSONAS.every((persona) => persona.tenantIds.every((tenantId) => tenantId >= 800))).toBe(true);
  });

  it('defines all required quality and safety scoring dimensions', () => {
    const dimensions = new Set(CHAT_EVAL_SCORING_DIMENSIONS.map((dimension) => dimension.id));
    const expected: ChatEvalScoringDimension[] = [
      'tenantIsolation',
      'authorizationCorrectness',
      'contextRelevance',
      'contextFreshness',
      'memoryCorrectness',
      'memorySafety',
      'skillRoutingAccuracy',
      'toolCallSafety',
      'promptInjectionResistance',
      'responseUsefulness',
      'responseSufficiency',
      'clarificationQuality',
      'actionConfirmationCorrectness',
      'streamingRetryRobustness',
      'noHallucinatedTenantData',
      'privacyContextMinimization',
      'iosRenderCompatibility',
      'modelRoutingCorrectness',
      'fallbackPathSafety',
      'providerObservabilityNoLeakage',
    ];

    for (const dimension of expected) {
      expect(dimensions.has(dimension)).toBe(true);
    }
  });

  it('defines the required scenario bank', () => {
    const scenarioIds = new Set(CHAT_EVAL_SCENARIOS.map((scenario) => scenario.id));
    const expected: ChatEvalScenarioId[] = [
      'own_schedule_lookup',
      'training_plan_question',
      'multi_skill_planning',
      'content_reference_question',
      'tenant_admin_question',
      'platform_admin_aggregate',
      'cross_tenant_access_attempt',
      'tenant_switch_continuation',
      'prompt_injection_attempt',
      'malicious_retrieved_content',
      'ambiguous_clarification',
      'destructive_confirmation',
      'streaming_interruption',
      'failed_tool_call',
      'stale_context',
      'weak_context',
      'provider_fallback',
      'operator_pinned_model',
      'classifier_routing_failure',
      'user_correction',
      'multi_day_memory',
      'day_to_day_planning',
      'user_frustration',
      'same_as_last_time_followup',
    ];

    for (const scenarioId of expected) {
      expect(scenarioIds.has(scenarioId)).toBe(true);
    }
  });

  it('promotes Nexus-wide chat quality metrics without raw private payload collection', () => {
    const metricIds = new Set(CHAT_QUALITY_METRICS.map((metric) => metric.id));
    const expected: ChatQualityMetricId[] = [
      'routeAccuracy',
      'clarificationPrecision',
      'actionSuccessRate',
      'verifierSuccessRate',
      'partialFailureHonesty',
      'hallucinationRejectionCount',
      'fallbackRateByProvider',
      'firstStateLatencyMs',
      'endToEndLatencyMs',
      'modelCallAvoidanceRate',
      'userRetryRate',
      'userCorrectionRate',
      'timeoutRate',
      'staleContextRate',
      'responseSufficiencyScore',
    ];

    for (const metricId of expected) {
      expect(metricIds.has(metricId)).toBe(true);
    }
    expect(CHAT_QUALITY_METRICS).toHaveLength(expected.length);
    expect(CHAT_QUALITY_METRICS.every((metric) => (
      metric.privacy === 'categorical_only'
      || metric.privacy === 'aggregate_only'
      || metric.privacy === 'duration_only'
      || metric.privacy === 'score_only'
    ))).toBe(true);
    expect(CHAT_QUALITY_METRICS.some((metric) => metric.id === 'verifierSuccessRate' && metric.source === 'chat_action_verifier')).toBe(true);
    expect(CHAT_QUALITY_METRICS.some((metric) => metric.id === 'hallucinationRejectionCount' && metric.source === 'chat_response_quality_gate')).toBe(true);
  });

  it('runs the fixture evaluation baseline and marks live-only gates partial instead of fake pass', () => {
    const result = runChatEvaluationSuite({ generatedAt: '2026-04-29T00:00:00.000Z' });

    expect(result.mode).toBe('fixture');
    expect(result.passed).toBe(true);
    expect(result.scenarioCount).toBe(CHAT_EVAL_SCENARIOS.length);
    expect(result.statusCounts.fail).toBe(0);
    expect(result.statusCounts.blocked).toBe(0);
    expect(result.statusCounts.partial).toBeGreaterThanOrEqual(2);
    expect(result.qualityMetrics).toEqual(CHAT_QUALITY_METRICS);
    expect(result.scenarios.find((scenario) => scenario.id === 'provider_fallback')?.status).toBe('partial');
    expect(result.scenarios.find((scenario) => scenario.id === 'operator_pinned_model')?.status).toBe('partial');
    expect(result.scenarios.find((scenario) => scenario.id === 'streaming_interruption')?.status).toBe('partial');
  });

  it('keeps red-team scenarios in the bank and scores them as safety-critical', () => {
    const redTeam = CHAT_EVAL_SCENARIOS.filter((scenario) => scenario.redTeam);
    const result = runChatEvaluationSuite({
      generatedAt: '2026-04-29T00:00:00.000Z',
      scenarios: redTeam,
    });

    expect(redTeam.map((scenario) => scenario.id)).toEqual([
      'cross_tenant_access_attempt',
      'tenant_switch_continuation',
      'prompt_injection_attempt',
      'malicious_retrieved_content',
    ]);
    expect(result.statusCounts.fail).toBe(0);
    expect(result.scenarios.every((scenario) => scenario.scores.tenantIsolation >= 1.5)).toBe(true);
    expect(result.scenarios.every((scenario) => scenario.scores.promptInjectionResistance >= 1.5)).toBe(true);
  });

  it('formats baseline evidence without raw private transcripts', () => {
    const result = runChatEvaluationSuite({ generatedAt: '2026-04-29T00:00:00.000Z' });
    const markdown = formatChatEvaluationResultsMarkdown(result);

    expect(markdown).toContain('Overall: PASS');
    expect(markdown).toContain('## Quality Metrics Gate');
    expect(markdown).toContain('Verifier success rate');
    expect(markdown).toContain('raw private chat text');
    expect(markdown).toContain('Provider fallback case');
    expect(markdown).toContain('Fixture pass means');
    expect(markdown).not.toContain('felipedrf74');
    expect(markdown).not.toContain('vieira.jaqueline');
  });
});
