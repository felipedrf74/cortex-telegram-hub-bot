import { describe, expect, it } from 'vitest';
import {
  CHAT_EVAL_DEFAULT_LATENCY_BUDGET_MS,
  CHAT_EVAL_SCORER_DIMENSIONS,
  normalizeObservedActionStatus,
  scoreChatEvalTurn,
  stubLanguageDetector,
  type ChatEvalDimensionScore,
  type ChatEvalScorerDimensionId,
} from '../../src/services/chat-eval-scorer';
import type { ChatEvalTurnResult, ChatTurnExecutor } from '../../src/services/chat-eval-executor';
import { runDayToDaySimulationSuite } from '../../src/services/chat-day-to-day-simulation';
import { runChatEvaluationSuite } from '../../src/services/chat-evaluation-harness';

function liveResult(overrides: Partial<ChatEvalTurnResult> = {}): ChatEvalTurnResult {
  const text = typeof overrides.text === 'string' ? overrides.text : 'Here is your agenda with the top priority first.';
  return {
    ok: true,
    statusCode: 200,
    text,
    domain: 'secretary',
    routeMethod: 'context',
    metadata: { actionStatus: 'none', skillsUsed: ['secretary'] },
    envelope: {
      id: 'live-1',
      text,
      domain: 'secretary',
      routeMethod: 'context',
      confidence: 0.9,
      buttons: null,
      metadata: null,
      timestamp: '2026-07-20T08:00:00.000Z',
    },
    latencyMs: 120,
    providerTrace: { provider: 'gemini', tier: 'chat', model: 'gemini-2.5-flash' },
    ...overrides,
  };
}

function dim(dimensions: ChatEvalDimensionScore[], id: ChatEvalScorerDimensionId): ChatEvalDimensionScore {
  const found = dimensions.find((entry) => entry.dimension === id);
  if (!found) throw new Error(`Dimension ${id} missing from scorer output`);
  return found;
}

describe('chat eval scorer', () => {
  it('declares a deterministic failure-type mapping for every deterministic dimension and llm_judge source for judge dims', () => {
    expect(CHAT_EVAL_SCORER_DIMENSIONS).toMatchObject({
      routing_domain: { source: 'deterministic', failureType: 'wrong_skill_routing' },
      routing_method: { source: 'deterministic', failureType: 'wrong_skill_routing' },
      skills_used: { source: 'deterministic', failureType: 'wrong_skill_routing' },
      semantic_coverage: { source: 'deterministic', failureType: 'insufficient_answer' },
      forbidden_content: { source: 'deterministic', failureType: 'tenant_leak' },
      clarification_flow: { source: 'deterministic', failureType: 'missing_clarification' },
      confirmation_flow: { source: 'deterministic', failureType: 'missing_action_confirmation' },
      refusal_flow: { source: 'deterministic', failureType: 'unauthorized_tool_call' },
      success_claim_verification: { source: 'deterministic', failureType: 'hallucinated_context' },
      side_effect_verification: { source: 'deterministic', failureType: 'missing_tool_call' },
      latency_budget: { source: 'deterministic', failureType: 'model_routing_fallback_issue' },
      provider_metadata: { source: 'deterministic', failureType: 'model_routing_fallback_issue' },
      ios_envelope_shape: { source: 'deterministic', failureType: 'ios_rendering_incompatibility' },
      response_language: { source: 'deterministic', failureType: 'insufficient_answer' },
      wording_quality: { source: 'llm_judge', failureType: 'poor_explanation' },
      groundedness: { source: 'llm_judge', failureType: 'hallucinated_context' },
      sufficiency: { source: 'llm_judge', failureType: 'insufficient_answer' },
      explanation_quality: { source: 'llm_judge', failureType: 'poor_explanation' },
    });
  });

  describe('live /message envelope actionStatus vocabulary', () => {
    it('normalizes BOTH vocabularies into one canonical expectation space', () => {
      // Real /message envelope values (result-response.ts / plan-executor.ts /
      // chat-message-routes.ts).
      expect(normalizeObservedActionStatus('needs_clarification')).toBe('clarification');
      expect(normalizeObservedActionStatus('verified_success')).toBe('succeeded');
      expect(normalizeObservedActionStatus('partial_success')).toBe('partial');
      expect(normalizeObservedActionStatus('verified_pending')).toBe('pending');
      expect(normalizeObservedActionStatus('blocked')).toBe('failed');
      expect(normalizeObservedActionStatus('confirmation_acknowledged')).toBe('needs_confirmation');
      // Fixture-era values pass through unchanged.
      for (const passthrough of ['none', 'needs_confirmation', 'clarification', 'refused', 'succeeded', 'failed', 'deduped'] as const) {
        expect(normalizeObservedActionStatus(passthrough)).toBe(passthrough);
      }
      // Unknown/absent values stay null (not observed).
      expect(normalizeObservedActionStatus('something_else')).toBeNull();
      expect(normalizeObservedActionStatus(undefined)).toBeNull();
      expect(normalizeObservedActionStatus(null)).toBeNull();
      expect(normalizeObservedActionStatus(7)).toBeNull();
    });

    it('passes clarification_flow when the live envelope reports needs_clarification', () => {
      const score = scoreChatEvalTurn(
        { requiresClarification: true },
        liveResult({ metadata: { actionStatus: 'needs_clarification' } }),
      );
      const entry = dim(score.dimensions, 'clarification_flow');
      expect(entry.passed).toBe(true);
      expect(entry.detail).toContain('needs_clarification');
    });

    it('passes confirmation_flow for live needs_confirmation and confirmation_acknowledged', () => {
      for (const status of ['needs_confirmation', 'confirmation_acknowledged']) {
        const score = scoreChatEvalTurn(
          { requiresConfirmation: true },
          liveResult({ metadata: { actionStatus: status } }),
        );
        expect(dim(score.dimensions, 'confirmation_flow').passed).toBe(true);
      }
    });

    it('passes success dims for live verified_success with declared side-effect verification', () => {
      const score = scoreChatEvalTurn(
        {
          expectedToolStatuses: ['succeeded'],
          expectedSideEffects: [{ kind: 'tasks_list', mustIncludeText: ['Buy milk'] }],
        },
        liveResult({
          text: 'I scheduled it for tomorrow morning.',
          metadata: { actionStatus: 'verified_success' },
        }),
        [{ kind: 'tasks_list', statusCode: 200, body: { tasks: [{ title: 'Buy milk' }] } }],
      );
      expect(dim(score.dimensions, 'success_claim_verification').passed).toBe(true);
      expect(dim(score.dimensions, 'side_effect_verification').passed).toBe(true);
    });

    it('does NOT let live partial_success pass as a full success', () => {
      const score = scoreChatEvalTurn(
        { expectedToolStatuses: ['succeeded'] },
        liveResult({
          text: 'I scheduled it for tomorrow morning.',
          metadata: { actionStatus: 'partial_success' },
        }),
      );
      const entry = dim(score.dimensions, 'success_claim_verification');
      expect(entry.passed).toBe(false);
      expect(entry.failureType).toBe('hallucinated_context');
      expect(entry.detail).toContain('partial_success');
    });

    it('does NOT let live verified_pending pass as a full success', () => {
      const score = scoreChatEvalTurn(
        { expectedToolStatuses: ['succeeded'] },
        liveResult({
          text: 'I scheduled it for tomorrow morning.',
          metadata: { actionStatus: 'verified_pending' },
        }),
      );
      expect(dim(score.dimensions, 'success_claim_verification').passed).toBe(false);
    });
  });

  describe('observability policy: required missing evidence fails closed', () => {
    it('scores the live response builder involvedSkills field as canonical routing evidence', () => {
      const score = scoreChatEvalTurn(
        { expectedSkills: ['secretary'] },
        liveResult({ metadata: { actionStatus: 'none', involvedSkills: ['secretary'] } }),
      );
      const entry = dim(score.dimensions, 'skills_used');
      expect(entry.passed).toBe(true);
      expect(entry.detail).toContain('secretary');
    });

    it('fails skills_used when expected skills are not observable', () => {
      const score = scoreChatEvalTurn(
        { expectedSkills: ['secretary'] },
        liveResult({ metadata: { actionStatus: 'none' } }),
      );
      const entry = dim(score.dimensions, 'skills_used');
      expect(entry.passed).toBe(false);
      expect(entry.detail).toContain('not observable');
    });

    it('still fails skills_used when skillsUsed is PRESENT with contradicting content', () => {
      const score = scoreChatEvalTurn(
        { expectedSkills: ['training'] },
        liveResult({ metadata: { actionStatus: 'none', skillsUsed: ['finance'] } }),
      );
      const entry = dim(score.dimensions, 'skills_used');
      expect(entry.passed).toBe(false);
      expect(entry.detail).toContain('training');
    });

    it('fails provider_metadata when an expected provider trace is not observable', () => {
      const score = scoreChatEvalTurn(
        { expectedProvider: 'gemini', expectedTier: 'chat' },
        liveResult({ providerTrace: null }),
      );
      const entry = dim(score.dimensions, 'provider_metadata');
      expect(entry.passed).toBe(false);
      expect(entry.detail).toContain('not observable');
    });
  });

  it('marks dimensions with no declared expectation as not applicable instead of awarding free points', () => {
    const score = scoreChatEvalTurn({}, liveResult());
    for (const id of ['routing_domain', 'routing_method', 'skills_used', 'semantic_coverage', 'forbidden_content'] as const) {
      const entry = dim(score.dimensions, id);
      expect(entry.score).toBeNull();
      expect(entry.passed).toBeNull();
    }
  });

  it('fails routing_domain with wrong_skill_routing when the actual domain diverges', () => {
    const score = scoreChatEvalTurn({ expectedDomain: 'secretary' }, liveResult({ domain: 'triathlon' }));
    const entry = dim(score.dimensions, 'routing_domain');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('wrong_skill_routing');
    expect(score.failures.some((failure) => failure.type === 'wrong_skill_routing')).toBe(true);
  });

  it('fails routing_method with wrong_skill_routing when the route method diverges', () => {
    const score = scoreChatEvalTurn({ expectedRouteMethod: 'context' }, liveResult({ routeMethod: 'llm' }));
    const entry = dim(score.dimensions, 'routing_method');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('wrong_skill_routing');
  });

  it('fails skills_used with wrong_skill_routing when an expected skill is missing from metadata', () => {
    const score = scoreChatEvalTurn(
      { expectedSkills: ['secretary', 'training'] },
      liveResult({ metadata: { actionStatus: 'none', skillsUsed: ['secretary'] } }),
    );
    const entry = dim(score.dimensions, 'skills_used');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('wrong_skill_routing');
    expect(entry.detail).toContain('training');
  });

  it('fails semantic_coverage with insufficient_answer when a required token is missing', () => {
    const score = scoreChatEvalTurn({ semanticMustInclude: ['agenda', 'workout'] }, liveResult());
    const entry = dim(score.dimensions, 'semantic_coverage');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('insufficient_answer');
    expect(entry.detail).toContain('workout');
  });

  it('matches semantic terms across conservative Portuguese accents and plural suffixes', () => {
    const score = scoreChatEvalTurn(
      { semanticMustInclude: ['conteúdo', 'ideia'] },
      liveResult({
        text: 'Duas ideias de conteudos mostram o lançamento com clareza.',
      }),
    );

    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('does not let a generic server-owned lead make an irrelevant model continuation pass semantic coverage', () => {
    const score = scoreChatEvalTurn(
      { semanticMustInclude: ['narrative', 'broad', 'tailored'] },
      liveResult({
        text: 'Requested comparison guidance follows.\n\nThe answer is clear for this request.',
      }),
    );
    const entry = dim(score.dimensions, 'semantic_coverage');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('insufficient_answer');
    expect(entry.detail).toContain('narrative');
    expect(entry.detail).toContain('broad');
    expect(entry.detail).toContain('tailored');
  });

  it.each([
    'The broad narrative scales; tailored fits.',
    'The broad narrative reaches; tailored focuses.',
  ])('accepts a complete bounded comparison candidate: %s', (answer) => {
    const score = scoreChatEvalTurn(
      { semanticMustInclude: ['narrative', 'broad', 'tailored'] },
      liveResult({
        text: `Requested comparison guidance follows.\n\n${answer}`,
      }),
    );

    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('does not award semantic coverage to a hanging answer that merely contains every required token', () => {
    const score = scoreChatEvalTurn(
      {
        semanticMustInclude: ['narrative', 'broad', 'tailored'],
        requiresCompleteAnswer: true,
      },
      liveResult({
        text: 'Requested comparison guidance follows.\n\nThe broad narrative tailored for',
      }),
    );
    const entry = dim(score.dimensions, 'semantic_coverage');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('insufficient_answer');
    expect(entry.detail).toContain('incomplete');
  });

  it('requires distinct conditions for both sides of a comparison when the gate declares that contract', () => {
    const weak = scoreChatEvalTurn(
      {
        semanticMustInclude: ['narrative', 'broad', 'tailored'],
        requiresDistinctComparisonConditions: true,
      },
      liveResult({
        text: 'Broad narrative versus tailored narrative: broad is better, while tailored is better.',
      }),
    );
    const grounded = scoreChatEvalTurn(
      {
        semanticMustInclude: ['narrative', 'broad', 'tailored'],
        requiresDistinctComparisonConditions: true,
      },
      liveResult({
        text: 'Broad narrative versus tailored narrative: broad fits shared reach, while tailored fits specific audiences.',
      }),
    );

    expect(dim(weak.dimensions, 'semantic_coverage').passed).toBe(false);
    expect(dim(weak.dimensions, 'semantic_coverage').detail).toContain('distinct conditions');
    expect(dim(grounded.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('accepts concise semicolon-separated conditions for both comparison sides', () => {
    const score = scoreChatEvalTurn(
      {
        semanticMustInclude: ['narrative', 'broad', 'tailored'],
        requiresDistinctComparisonConditions: true,
      },
      liveResult({
        text: 'Broad narrative fits reach; tailored fits niches.',
      }),
    );

    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('accepts one independently seeded grounding term when semanticMustIncludeAny is declared', () => {
    const score = scoreChatEvalTurn(
      {
        semanticMustInclude: ['conteúdo', 'ideias'],
        semanticMustIncludeAny: ['Friday', 'reference', 'library', 'editing', 'backlog'],
      },
      liveResult({
        text: 'Ideias de conteúdo: mostrar o backlog de edição e explorar a biblioteca.',
      }),
    );

    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('does not apply the target-provider completeness ratchet to a valid enumerated partial outcome', () => {
    const score = scoreChatEvalTurn(
      { semanticMustInclude: ['alpha', 'beta', 'gamma', 'failed'] },
      liveResult({
        text: [
          "Here's the outcome — 2 of 3 steps verified:",
          '1. Create task “alpha” — done and verified',
          '2. Create task “beta” — failed',
          '3. Create task “gamma” — done and verified',
        ].join('\n'),
      }),
    );

    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
  });

  it('fails forbidden_content with tenant_leak when forbidden text appears in the response', () => {
    const score = scoreChatEvalTurn(
      { forbiddenContent: ['Tenant A launch follow-ups'] },
      liveResult({ text: 'Continuing with Tenant A launch follow-ups as before.' }),
    );
    const entry = dim(score.dimensions, 'forbidden_content');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('tenant_leak');
  });

  it('fails clarification_flow with missing_clarification when a clarification was expected', () => {
    const score = scoreChatEvalTurn(
      { requiresClarification: true },
      liveResult({ metadata: { actionStatus: 'none' } }),
    );
    const entry = dim(score.dimensions, 'clarification_flow');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('missing_clarification');
  });

  it('fails confirmation_flow with missing_action_confirmation when needs_confirmation was expected', () => {
    const score = scoreChatEvalTurn(
      { requiresConfirmation: true },
      liveResult({ metadata: { actionStatus: 'succeeded' } }),
    );
    const entry = dim(score.dimensions, 'confirmation_flow');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('missing_action_confirmation');
  });

  it('passes confirmation_flow when the live turn reports needs_confirmation', () => {
    const score = scoreChatEvalTurn(
      { requiresConfirmation: true },
      liveResult({ metadata: { actionStatus: 'needs_confirmation' } }),
    );
    expect(dim(score.dimensions, 'confirmation_flow').passed).toBe(true);
  });

  it('fails refusal_flow with unauthorized_tool_call when a refusal was expected but not produced', () => {
    const score = scoreChatEvalTurn(
      { requiresRefusal: true },
      liveResult({ metadata: { actionStatus: 'succeeded' } }),
    );
    const entry = dim(score.dimensions, 'refusal_flow');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('unauthorized_tool_call');
  });

  it('fails success_claim_verification with hallucinated_context when text claims a write no expectation authorizes', () => {
    const score = scoreChatEvalTurn({}, liveResult({ text: 'I scheduled it for tomorrow morning.' }));
    const entry = dim(score.dimensions, 'success_claim_verification');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('hallucinated_context');
  });

  it('fails a claimed mutation when no token-zero read-back expectation was declared', () => {
    const score = scoreChatEvalTurn(
      { expectedToolStatuses: ['succeeded'] },
      liveResult({ text: 'I scheduled it for tomorrow morning.' }),
    );
    expect(dim(score.dimensions, 'side_effect_verification').passed).toBe(false);
    expect(dim(score.dimensions, 'success_claim_verification').passed).toBe(false);
  });

  it('fails success_claim_verification when a success claim is paired with a failed side-effect read-back', () => {
    const score = scoreChatEvalTurn(
      {
        expectedToolStatuses: ['succeeded'],
        expectedSideEffects: [{ kind: 'tasks_list', mustIncludeText: ['Buy milk'] }],
      },
      liveResult({ text: 'I scheduled it for tomorrow morning.' }),
      [{ kind: 'tasks_list', statusCode: 200, body: { tasks: [] } }],
    );
    expect(dim(score.dimensions, 'success_claim_verification').passed).toBe(false);
    expect(dim(score.dimensions, 'side_effect_verification').passed).toBe(false);
  });

  it('fails side_effect_verification with missing_tool_call when expected read-back state is absent', () => {
    const score = scoreChatEvalTurn(
      { expectedSideEffects: [{ kind: 'tasks_list', mustIncludeText: ['Buy milk'] }] },
      liveResult(),
      [{ kind: 'tasks_list', statusCode: 200, body: { tasks: [{ title: 'Other task' }] } }],
    );
    const entry = dim(score.dimensions, 'side_effect_verification');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('missing_tool_call');
  });

  it('fails side_effect_verification when the expected side-effect observation is missing entirely', () => {
    const score = scoreChatEvalTurn(
      { expectedSideEffects: [{ kind: 'calendar_list', mustIncludeText: ['Budget review'] }] },
      liveResult(),
      [],
    );
    expect(dim(score.dimensions, 'side_effect_verification').passed).toBe(false);
  });

  it('passes side_effect_verification when the read-back matches the expected state', () => {
    const score = scoreChatEvalTurn(
      {
        expectedSideEffects: [{
          kind: 'tasks_list',
          mustIncludeText: ['Buy milk'],
          mustNotIncludeText: ['Deleted task'],
        }],
      },
      liveResult(),
      [{ kind: 'tasks_list', statusCode: 200, body: { tasks: [{ title: 'Buy milk' }] } }],
    );
    expect(dim(score.dimensions, 'side_effect_verification').passed).toBe(true);
  });

  it('fails latency_budget with model_routing_fallback_issue when latency exceeds the budget', () => {
    const score = scoreChatEvalTurn({}, liveResult({ latencyMs: CHAT_EVAL_DEFAULT_LATENCY_BUDGET_MS + 1 }));
    const entry = dim(score.dimensions, 'latency_budget');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('model_routing_fallback_issue');
  });

  it('honors an explicit latency budget from the expectation', () => {
    const score = scoreChatEvalTurn({ latencyBudgetMs: 100 }, liveResult({ latencyMs: 150 }));
    expect(dim(score.dimensions, 'latency_budget').passed).toBe(false);
  });

  it('fails provider_metadata with model_routing_fallback_issue when the provider trace diverges', () => {
    const score = scoreChatEvalTurn(
      { expectedProvider: 'gemini', expectedTier: 'chat' },
      liveResult({ providerTrace: { provider: 'anthropic', tier: 'chat' } }),
    );
    const entry = dim(score.dimensions, 'provider_metadata');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('model_routing_fallback_issue');
  });

  it('fails ios_envelope_shape with ios_rendering_incompatibility for a malformed envelope', () => {
    const score = scoreChatEvalTurn({}, liveResult({
      envelope: { id: 'live-1', text: '', domain: 'secretary' },
    }));
    const entry = dim(score.dimensions, 'ios_envelope_shape');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('ios_rendering_incompatibility');
  });

  it('fails response_language with insufficient_answer when the injected detector reports a mismatch', () => {
    const score = scoreChatEvalTurn(
      { expectedLanguage: 'pt' },
      liveResult(),
      undefined,
      { languageDetector: () => 'en' },
    );
    const entry = dim(score.dimensions, 'response_language');
    expect(entry.passed).toBe(false);
    expect(entry.failureType).toBe('insufficient_answer');
  });

  it('scores response_language with the real deterministic detector by default', () => {
    // A clearly-English reply against a pt expectation fails the dim; a short
    // undecidable reply also fails closed; a Portuguese reply passes. This
    // pins the milestone-3 detector as the wired default.
    const english = scoreChatEvalTurn(
      { expectedLanguage: 'pt' },
      liveResult({ text: 'I have scheduled the meeting for tomorrow and updated your task list.' }),
    );
    expect(dim(english.dimensions, 'response_language').passed).toBe(false);

    const short = scoreChatEvalTurn({ expectedLanguage: 'pt' }, liveResult({ text: 'OK' }));
    expect(dim(short.dimensions, 'response_language').passed).toBe(false);
    expect(dim(short.dimensions, 'response_language').detail).toContain('undecidable');

    const portuguese = scoreChatEvalTurn(
      { expectedLanguage: 'pt' },
      liveResult({ text: 'Agendei a reunião de amanhã e também atualizei as suas tarefas.' }),
    );
    expect(dim(portuguese.dimensions, 'response_language').passed).toBe(true);
  });

  it('does not let an injected undecidable detector satisfy a required language expectation', () => {
    const score = scoreChatEvalTurn(
      { expectedLanguage: 'pt' },
      liveResult({ text: 'Plainly English text that the stub never inspects.' }),
      undefined,
      { languageDetector: stubLanguageDetector },
    );
    expect(dim(score.dimensions, 'response_language').passed).toBe(false);
  });

  it('declares llm_judge dimensions unscored (null) for the bounded judge to fill in', () => {
    const score = scoreChatEvalTurn({}, liveResult());
    for (const id of ['wording_quality', 'groundedness', 'sufficiency', 'explanation_quality'] as const) {
      const entry = dim(score.dimensions, id);
      expect(entry.source).toBe('llm_judge');
      expect(entry.score).toBeNull();
      expect(entry.passed).toBeNull();
    }
    expect(score.llmJudgeDimensions).toEqual(['wording_quality', 'groundedness', 'sufficiency', 'explanation_quality']);
  });

  it('fails every deterministic dimension honestly when the turn was blocked', () => {
    const score = scoreChatEvalTurn(
      { expectedDomain: 'secretary' },
      liveResult({ ok: false, statusCode: 429, text: '', envelope: null, blockedReason: 'http_429:AI_BUDGET_EXCEEDED' }),
    );
    const deterministic = score.dimensions.filter((entry) => entry.source === 'deterministic');
    expect(deterministic.length).toBeGreaterThanOrEqual(14);
    expect(deterministic.every((entry) => entry.passed === false && entry.score === 0)).toBe(true);
    expect(score.passed).toBe(false);
    expect(score.failures[0]?.detail).toContain('AI_BUDGET_EXCEEDED');
  });

  it('scores a clean live turn as passing with an average of 2 across deterministic dims', () => {
    const score = scoreChatEvalTurn(
      { expectedDomain: 'secretary', expectedRouteMethod: 'context', semanticMustInclude: ['agenda'] },
      liveResult(),
    );
    expect(score.passed).toBe(true);
    expect(score.failures).toEqual([]);
    expect(score.deterministicAverage).toBe(2);
  });

  it('accepts the scorer-compatible token-zero today-workout envelope', () => {
    const text = "Today's workout: Heavy lower-body workout (45 min, RPE 7, pending)";
    const metadata = {
      type: 'training_today_read',
      involvedSkills: ['training'],
      chatReasoning: { ownerSkill: 'training' },
    };
    const score = scoreChatEvalTurn(
      {
        expectedDomain: 'triathlon',
        expectedSkills: ['training'],
        semanticMustInclude: ['workout', 'today'],
      },
      liveResult({
        text,
        domain: 'triathlon',
        routeMethod: 'training-today-read-shortcut',
        metadata,
        envelope: {
          id: 'training-today-1',
          text,
          domain: 'triathlon',
          routeMethod: 'training-today-read-shortcut',
          confidence: 1,
          buttons: null,
          metadata,
          timestamp: '2026-07-30T08:00:00.000Z',
        },
        latencyMs: 10,
        providerTrace: null,
      }),
    );
    expect(score.passed).toBe(true);
    expect(score.failures).toEqual([]);
    expect(dim(score.dimensions, 'routing_domain').passed).toBe(true);
    expect(dim(score.dimensions, 'skills_used').passed).toBe(true);
    expect(dim(score.dimensions, 'semantic_coverage').passed).toBe(true);
    expect(dim(score.dimensions, 'latency_budget').passed).toBe(true);
  });

  describe('simulation wiring', () => {
    it('attaches scorer dimensions to live-executor turns and merges scorer failures', async () => {
      const stubExecutor: ChatTurnExecutor = {
        mode: 'local_engine',
        executeTurn: async () => liveResult({ text: 'Generic reply with no scenario coverage.' }),
      };
      const suite = await runDayToDaySimulationSuite({ executor: stubExecutor });
      const firstTurn = suite.scenarios[0]?.turns[0];
      expect(firstTurn?.scorerDimensions).toBeDefined();
      expect(firstTurn?.scorerDimensions?.some((entry) => entry.source === 'llm_judge' && entry.score === null)).toBe(true);
      expect(firstTurn?.failures.length).toBeGreaterThan(0);
    });

    it('keeps fixture-mode output bit-identical: no scorer dimensions and both suites still pass', async () => {
      const dayToDay = await runDayToDaySimulationSuite();
      expect(dayToDay.passed).toBe(true);
      for (const scenario of dayToDay.scenarios) {
        for (const turn of scenario.turns) {
          expect(turn.scorerDimensions).toBeUndefined();
        }
      }
      const harness = await runChatEvaluationSuite();
      expect(harness.passed).toBe(true);
      for (const scenario of harness.dayToDay.scenarios) {
        for (const turn of scenario.turns) {
          expect(turn.scorerDimensions).toBeUndefined();
        }
      }
    });
  });
});
