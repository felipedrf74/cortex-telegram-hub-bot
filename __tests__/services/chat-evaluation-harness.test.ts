import { describe, expect, it } from 'vitest';
import {
  CHAT_EVAL_PERSONAS,
  CHAT_EVAL_SCENARIOS,
  CHAT_EVAL_SCORING_DIMENSIONS,
  CHAT_QUALITY_METRICS,
  CHAT_HYBRID_ACTION_GATE_THRESHOLDS,
  evaluateChatHybridActionGate,
  formatChatEvaluationResultsMarkdown,
  runChatEvaluationSuite,
  type ChatEvalScenarioId,
  type ChatEvalScoringDimension,
  type ChatQualityMetricId,
} from '../../src/services/chat-evaluation-harness';
import { DAY_TO_DAY_SCENARIOS } from '../../src/services/chat-day-to-day-simulation';

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
      'macroActionPrecision',
      'macroSlotF1',
      'actionRecallCoverage',
      'verifiedMutationSuccessRate',
      'wrongEntityRate',
      'falseBlockRate',
      'uiHandoffRate',
      'costPerVerifiedSuccess',
      'criticalRiskFalseExecutionCount',
      'falseSuccessWithoutReadBackCount',
      'falsePositiveOnRefusalCount',
      'debugInternalLeakageCount',
      'portugueseLocalizationLeakageCount',
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
    expect(CHAT_QUALITY_METRICS.some((metric) => metric.id === 'macroActionPrecision' && metric.target.includes('0.98'))).toBe(true);
  });

  it('evaluates the hybrid action gate without allowing precision-only gaming', () => {
    const passing = evaluateChatHybridActionGate({
      macroActionPrecision: 0.985,
      macroSlotF1: 0.975,
      actionRecallCoverage: 0.93,
      verifiedMutationSuccessRate: 0.982,
      wrongEntityRate: 0.001,
      falseBlockRate: 0.03,
      clarificationRate: 0.2,
      uiHandoffRate: 0.12,
      p95LatencyMs: 2500,
      costPerVerifiedSuccessUsd: 0.0012,
      criticalRiskFalseExecutionCount: 0,
      falseSuccessWithoutReadBackCount: 0,
      falsePositiveOnRefusalCount: 0,
      debugInternalLeakageCount: 0,
      portugueseLocalizationLeakageCount: 0,
    });
    expect(passing.passed).toBe(true);

    const overClarifying = evaluateChatHybridActionGate({
      ...passing.metrics,
      macroActionPrecision: 0.99,
      actionRecallCoverage: 0.4,
      clarificationRate: 0.8,
    });
    expect(overClarifying.passed).toBe(false);
    expect(overClarifying.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('actionRecallCoverage'),
      expect.stringContaining('clarificationRate'),
    ]));
    expect(CHAT_HYBRID_ACTION_GATE_THRESHOLDS.falseSuccessWithoutReadBackCount).toBe(0);
    expect(CHAT_HYBRID_ACTION_GATE_THRESHOLDS.falsePositiveOnRefusalCount).toBe(0);
  });

  it('runs the fixture day-to-day baseline while reporting the 24-item rubric as an unexecuted catalog', async () => {
    const result = await runChatEvaluationSuite({ generatedAt: '2026-04-29T00:00:00.000Z' });

    expect(result.mode).toBe('fixture');
    expect(result.passed).toBe(true);
    expect(result.scenarioCount).toBe(DAY_TO_DAY_SCENARIOS.length);
    expect(result.scenarios.map((scenario) => scenario.id)).toEqual(DAY_TO_DAY_SCENARIOS.map((scenario) => scenario.id));
    expect(result.statusCounts.fail).toBe(0);
    expect(result.statusCounts.blocked).toBe(0);
    expect(result.statusCounts.partial).toBe(0);
    expect(result.qualityMetrics).toEqual(CHAT_QUALITY_METRICS);
    expect(result.averageScore).toBe(result.dayToDay.averageScore);
    expect(result.catalogCoverage).toEqual({
      total: CHAT_EVAL_SCENARIOS.length,
      executed: 0,
      excluded: CHAT_EVAL_SCENARIOS.length,
      reasonCode: 'catalog_only_no_executable_profile_v1',
      ids: CHAT_EVAL_SCENARIOS.map((scenario) => scenario.id),
    });
  });

  it('keeps red-team scenarios in the catalog without fabricating safety scores', async () => {
    const redTeam = CHAT_EVAL_SCENARIOS.filter((scenario) => scenario.redTeam);
    const result = await runChatEvaluationSuite({
      generatedAt: '2026-04-29T00:00:00.000Z',
      scenarios: redTeam,
    });

    expect(redTeam.map((scenario) => scenario.id)).toEqual([
      'cross_tenant_access_attempt',
      'tenant_switch_continuation',
      'prompt_injection_attempt',
      'malicious_retrieved_content',
    ]);
    expect(result.catalogCoverage).toMatchObject({
      total: 4,
      executed: 0,
      excluded: 4,
      reasonCode: 'catalog_only_no_executable_profile_v1',
    });
    expect(result.catalogCoverage.ids).toEqual(redTeam.map((scenario) => scenario.id));
    expect(result.scenarios.some((scenario) => redTeam.some((catalog) => catalog.id === scenario.id))).toBe(false);
  });

  it('refuses to label a fixture executor as local_engine or real_provider evidence', async () => {
    await expect(runChatEvaluationSuite({ mode: 'local_engine' })).rejects.toThrow(/local_engine.*executor/i);
    await expect(runChatEvaluationSuite({ mode: 'real_provider' })).rejects.toThrow(/real_provider.*executor/i);
  });

  it('formats baseline evidence without raw private transcripts', async () => {
    const result = await runChatEvaluationSuite({ generatedAt: '2026-04-29T00:00:00.000Z' });
    const markdown = formatChatEvaluationResultsMarkdown(result);

    expect(markdown).toContain('Overall: PASS');
    expect(markdown).toContain('## Quality Metrics Gate');
    expect(markdown).toContain('Verifier success rate');
    expect(markdown).toContain('raw private chat text');
    expect(markdown).toContain('Executed: 0 / 24');
    expect(markdown).toContain('catalog is reported separately');
    expect(markdown).not.toContain('felipedrf74');
    expect(markdown).not.toContain('vieira.jaqueline');
  });
});
