// Performance and token-budget gates for Phases 0-15 QA.
//
// These are local deterministic gates, not production SLOs. They catch
// accidental full-registry prompt expansion and slow deterministic routing
// regressions before the eval corpus is promoted.

import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';

import {
  buildDeterministicChatActionPlan,
  buildLlmPlannerPrompt,
  type ChatPlannerInput,
} from '../../src/services/chat';
import {
  getChatActionRegistry,
  selectRegistrySubsetForMessage,
  type ChatActionDefinition,
} from '../../src/services/chat/registry';
import { buildLlmSafePromptSlice } from '../../src/services/build-llm-safe-prompt-slice';
import { buildRegistryDrivenEvalScenarios } from '../../src/services/registry-driven-eval-scenarios';
import { scoreRegistryScenariosBatch } from '../../src/services/registry-real-eval-scoring';

type RegistryExample = NonNullable<ChatActionDefinition['examples']>[number];

const NOW_ISO = '2026-05-16T12:00:00+01:00';
const BASE_INPUT = {
  userId: 515,
  tenantId: 616,
  conversationId: 'perf-budget-c',
  messageId: 'perf-budget-m',
  channel: 'api' as const,
  timezone: 'Europe/Lisbon',
  nowIso: NOW_ISO,
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function goldenExamples(): Array<{ entry: ChatActionDefinition; example: RegistryExample }> {
  return getChatActionRegistry().flatMap((entry) =>
    (entry.examples ?? [])
      .filter((example) => (example.tags ?? ['golden']).includes('golden'))
      .map((example) => ({ entry, example })),
  );
}

function plannerInputFor(example: RegistryExample, index: number): ChatPlannerInput {
  const locale = example.locale === 'es'
    ? 'es-ES'
    : example.locale === 'en'
      ? 'en-US'
      : 'pt-PT';
  return {
    ...BASE_INPUT,
    text: example.turns?.[0] ?? example.text,
    locale,
    conversationId: `perf-budget-c-${index}`,
    messageId: `perf-budget-m-${index}`,
  };
}

function parsePromptRegistry(prompt: ReturnType<typeof buildLlmPlannerPrompt>): unknown[] {
  const line = prompt.systemPrompt.split('\n').find((part) => part.startsWith('[{"skill"'));
  expect(line).toBeTruthy();
  return JSON.parse(line!);
}

function parsePromptExamples(prompt: ReturnType<typeof buildLlmPlannerPrompt>): unknown[] {
  const match = prompt.systemPrompt.match(/Relevant examples: (.*)$/m);
  return match ? JSON.parse(match[1]) : [];
}

describe('deterministic planner latency gates', () => {
  it('keeps deterministic route p95 below 100ms on runtime golden examples', () => {
    const cases = goldenExamples();
    expect(cases.length).toBeGreaterThanOrEqual(150);

    // Warm the parser/regex paths outside the measured sample.
    for (const [index, { example }] of cases.slice(0, 12).entries()) {
      buildDeterministicChatActionPlan(plannerInputFor(example, index));
    }

    const latencies = cases.map(({ example }, index) => {
      const started = performance.now();
      buildDeterministicChatActionPlan(plannerInputFor(example, index));
      return performance.now() - started;
    });

    const p50 = percentile(latencies, 0.50);
    const p95 = percentile(latencies, 0.95);
    expect({ p50, p95, total: latencies.length }).toMatchObject({ total: cases.length });
    expect(p95).toBeLessThan(100);
  });

  it('keeps registry retrieval p95 below 25ms for runtime golden examples', () => {
    const cases = goldenExamples();
    const latencies = cases.map(({ example }) => {
      const started = performance.now();
      selectRegistrySubsetForMessage(example.turns?.[0] ?? example.text);
      return performance.now() - started;
    });
    expect(percentile(latencies, 0.95)).toBeLessThan(25);
  });

  it('keeps the full registry-driven matrix runtime bounded', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: ['golden', 'ambiguous', 'negative', 'prompt_injection', 'adversarial'],
      perActionMax: 10,
    });
    expect(scenarios.length).toBeGreaterThanOrEqual(92);

    const started = performance.now();
    const batch = scoreRegistryScenariosBatch(scenarios, {
      nowIso: NOW_ISO,
      timezone: 'Europe/Lisbon',
    });
    const elapsedMs = performance.now() - started;

    expect(batch.scenarios).toHaveLength(scenarios.length);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe('LLM prompt token-budget gates', () => {
  it('keeps safe prompt slices compact and free of implementation internals', () => {
    const forbidden = [
      'executor',
      'verifier',
      'executionPolicy',
      'verificationPolicy',
      'typedSlotExtractors',
      'typedSlotValidators',
      'slotExtractors',
      'slotValidators',
      'providerDependencies',
      'supportedCards',
      'uiSurfaces',
    ];
    const sizes = getChatActionRegistry().map((entry) => {
      const serialized = JSON.stringify(buildLlmSafePromptSlice(entry));
      for (const key of forbidden) {
        expect(serialized).not.toContain(key);
      }
      return Buffer.byteLength(serialized, 'utf8');
    });

    expect(Math.max(...sizes)).toBeLessThan(2_500);
  });

  it('does not send the full active registry or unbounded examples to the planner model', () => {
    const prompt = buildLlmPlannerPrompt({
      ...BASE_INPUT,
      text: 'Create task and email and calendar and training and content and cooking and finance and connection and notification and decision',
      locale: 'en-US',
    });
    const registryView = parsePromptRegistry(prompt);
    const examples = parsePromptExamples(prompt);
    const serializedSize = Buffer.byteLength(`${prompt.systemPrompt}\n${prompt.userPrompt}`, 'utf8');

    expect(registryView.length).toBeLessThan(getChatActionRegistry().length);
    expect(registryView.length).toBeLessThanOrEqual(11);
    expect(examples.length).toBeLessThanOrEqual(6);
    expect(serializedSize).toBeLessThan(12_000);
    expect(prompt.systemPrompt).not.toContain('typedSlotExtractors');
    expect(prompt.systemPrompt).not.toContain('executor');
    expect(prompt.systemPrompt).not.toContain('provider_read_back');
  });
});
