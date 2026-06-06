import { describe, expect, it } from 'vitest';

import {
  buildChatModelBakeoffReport,
  CHAT_MODEL_BAKEOFF_CANDIDATES,
  formatChatModelBakeoffMarkdown,
} from '../../src/services/chat-model-bakeoff';

describe('chat model bake-off baseline', () => {
  it('includes production candidates and external eval-only challengers without enabling new providers', () => {
    expect(CHAT_MODEL_BAKEOFF_CANDIDATES.map((candidate) => candidate.model)).toEqual(expect.arrayContaining([
      'gemini-2.5-flash-lite',
      'gpt-5.4-nano',
      'gemini-2.5-flash',
      'gpt-5.4-mini',
      'mistral-small-4',
      'command-r',
    ]));
    expect(CHAT_MODEL_BAKEOFF_CANDIDATES.find((candidate) => candidate.model === 'mistral-small-4')?.productionEligible).toBe(false);
    expect(CHAT_MODEL_BAKEOFF_CANDIDATES.find((candidate) => candidate.model === 'command-r')?.provider).toBe('external_eval_only');
  });

  it('scores the bilingual contract fixture bank and estimates batch savings only for offline work', () => {
    const report = buildChatModelBakeoffReport({ generatedAt: '2026-05-19T00:00:00.000Z' });

    expect(report.fixtureCount).toBeGreaterThanOrEqual(100);
    expect(report.turnCount).toBe(report.fixtureCount * 2);

    const nano = report.candidates.find((candidate) => candidate.candidate.model === 'gpt-5.4-nano')!;
    expect(nano.skillPrecision).toBeGreaterThanOrEqual(0.95);
    expect(nano.routePrecision).toBeGreaterThanOrEqual(0.95);
    expect(nano.localReadCorrectness).toBeGreaterThanOrEqual(0.95);
    expect(nano.noLocalTruthViolationPrecision).toBeGreaterThanOrEqual(0.95);
    expect(nano.actionSafetyPrecision).toBeGreaterThanOrEqual(0.95);
    expect(nano.scoringSource).toBe('contract_baseline');
    expect(nano.estimatedInteractiveCostUsd).toBeGreaterThan(0);
    expect(nano.estimatedBatchCostUsd).toBeCloseTo(nano.estimatedInteractiveCostUsd! * 0.5, 10);
    expect(nano.estimatedCostPerSuccessfulAnswerUsd).toBeGreaterThan(0);
    expect(nano.notes.join(' ')).toContain('not live Telegram chat');

    const external = report.candidates.find((candidate) => candidate.candidate.model === 'command-r')!;
    expect(external.estimatedInteractiveCostUsd).toBeNull();
    expect(external.notes.join(' ')).toContain('no production provider adapter');
  });

  it('can score observed model outputs by quality, safety, latency, tokens, and cost per successful answer', () => {
    const report = buildChatModelBakeoffReport({
      generatedAt: '2026-05-19T00:00:00.000Z',
      observations: [
        {
          candidateId: 'openai-gpt-5-4-nano-structured-chat',
          fixtureSkill: 'cooking',
          scenario: 'generic_recipe',
          language: 'pt',
          successfulAnswer: true,
          skillPass: true,
          routePass: true,
          groundingPass: true,
          responseShapePass: true,
          riskPass: true,
          localReadCorrect: true,
          noLocalTruthViolation: true,
          languageQualityPass: true,
          actionSafetyPass: true,
          latencyMs: 900,
          inputTokens: 100,
          outputTokens: 300,
          costUsd: 0.000395,
        },
        {
          candidateId: 'openai-gpt-5-4-nano-structured-chat',
          fixtureSkill: 'cooking',
          scenario: 'generic_recipe',
          language: 'en',
          successfulAnswer: false,
          skillPass: true,
          routePass: true,
          groundingPass: true,
          responseShapePass: false,
          riskPass: true,
          localReadCorrect: true,
          noLocalTruthViolation: false,
          languageQualityPass: false,
          actionSafetyPass: true,
          latencyMs: 1500,
          inputTokens: 110,
          outputTokens: 250,
          costUsd: 0.0003345,
        },
      ],
    });

    const nano = report.candidates.find((candidate) => candidate.candidate.id === 'openai-gpt-5-4-nano-structured-chat')!;
    expect(nano.scoringSource).toBe('observed_model_outputs');
    expect(nano.fixtureTurns).toBe(2);
    expect(nano.successfulAnswerRate).toBe(0.5);
    expect(nano.responseShapePrecision).toBe(0.5);
    expect(nano.noLocalTruthViolationPrecision).toBe(0.5);
    expect(nano.portugueseQualityPrecision).toBe(1);
    expect(nano.englishQualityPrecision).toBe(0);
    expect(nano.actionSafetyPrecision).toBe(1);
    expect(nano.p95LatencyMs).toBe(1500);
    expect(nano.estimatedInputTokens).toBe(210);
    expect(nano.estimatedOutputTokens).toBe(550);
    expect(nano.estimatedInteractiveCostUsd).toBeCloseTo(0.0007295, 10);
    expect(nano.estimatedCostPerSuccessfulAnswerUsd).toBeCloseTo(0.0007295, 10);
  });

  it('renders a Markdown report for offline model review', () => {
    const markdown = formatChatModelBakeoffMarkdown(buildChatModelBakeoffReport({
      generatedAt: '2026-05-19T00:00:00.000Z',
    }));

    expect(markdown).toContain('# Chat Model Bake-Off Baseline');
    expect(markdown).toContain('gpt-5.4-nano');
    expect(markdown).toContain('Cost/success');
    expect(markdown).toContain('No local-truth violation');
    expect(markdown).toContain('contract_baseline');
    expect(markdown).toContain('--observations <jsonl>');
    expect(markdown).toContain('Batch/Flex modes are for offline evals and backfills only');
  });
});
