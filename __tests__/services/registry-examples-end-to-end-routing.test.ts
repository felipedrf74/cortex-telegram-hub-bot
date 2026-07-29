// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Runtime registry routing gate for the Phases 0-15 consolidation QA.
//
// This test intentionally imports the real registry and the deterministic
// planner at runtime. It is the functional counterpart to the count-based
// registry gates: every golden supported-locale example and every retained
// Spanish-authored compatibility input must actually route to its declared
// expectedAction unless the example is explicitly documented as an LLM-tier
// exception. Spanish inputs always request an English response.

import { describe, expect, it } from 'vitest';

import {
  getChatActionRegistry,
  type ChatActionDefinition,
} from '../../src/services/chat/registry';
import {
  buildDeterministicChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';
import { buildLlmSafePromptSlice } from '../../src/services/build-llm-safe-prompt-slice';
import { buildRegistryDrivenEvalScenarios } from '../../src/services/registry-driven-eval-scenarios';

type RegistryExample = NonNullable<ChatActionDefinition['examples']>[number];
type RuntimeGoldenCase = {
  id: string;
  skill: ChatActionDefinition['skill'];
  action: ChatActionDefinition['action'];
  locale: 'en' | 'pt';
  registryLocale: RegistryExample['locale'];
  requestLocale: 'en' | 'pt' | 'es' | 'mixed';
  responseLocale: 'en' | 'pt';
  text: string;
  expectedAction: RegistryExample['expectedAction'];
  condition?: string;
};

const LOCALES = new Set(['en', 'pt']);
const NOW_ISO = '2026-05-16T12:00:00+01:00';

function activeActions(): ChatActionDefinition[] {
  return getChatActionRegistry().filter((entry) => entry.status === 'active');
}

function exampleTags(example: RegistryExample): string[] {
  return Array.isArray(example.tags) ? example.tags : ['golden'];
}

function isRuntimeGoldenExample(
  example: RegistryExample,
): boolean {
  return Boolean(
    exampleTags(example).includes('golden')
    && (
      (example.locale && LOCALES.has(example.locale))
      || (example.requestLocale === 'es' && example.responseLocale === 'en')
    ),
  );
}

function isLlmTierExample(example: Pick<RegistryExample, 'condition'>): boolean {
  return /\bllm[-_\s]?tier\b/i.test(example.condition ?? '');
}

function plannerLocale(locale: RuntimeGoldenCase['locale']): string {
  if (locale === 'pt') return 'pt-PT';
  return 'en-US';
}

function buildInput(testCase: RuntimeGoldenCase): ChatPlannerInput {
  return {
    text: testCase.text,
    userId: 1,
    tenantId: 1,
    conversationId: `registry-e2e-${testCase.id}`,
    messageId: `registry-e2e-msg-${testCase.id}`,
    channel: 'api',
    locale: plannerLocale(testCase.locale),
    timezone: 'Europe/Lisbon',
    nowIso: NOW_ISO,
  };
}

function collectRuntimeGoldenCases(): RuntimeGoldenCase[] {
  const cases: RuntimeGoldenCase[] = [];
  for (const entry of activeActions()) {
    for (const [index, example] of (entry.examples ?? []).entries()) {
      if (!isRuntimeGoldenExample(example)) continue;
      const responseLocale = example.responseLocale ?? example.locale;
      if (responseLocale !== 'en' && responseLocale !== 'pt') {
        throw new Error(`unsupported registry response locale:${entry.skill}.${entry.action}.${index}`);
      }
      cases.push({
        id: `${entry.skill}.${entry.action}.${example.requestLocale ?? example.locale}.${index}`,
        skill: entry.skill,
        action: entry.action,
        locale: responseLocale,
        registryLocale: example.locale,
        requestLocale: example.requestLocale ?? responseLocale,
        responseLocale,
        text: example.turns?.[0] ?? example.text,
        expectedAction: example.expectedAction,
        condition: example.condition,
      });
    }
  }
  return cases;
}

function route(testCase: RuntimeGoldenCase): ChatActionDefinition['action'] | null {
  const plan = buildDeterministicChatActionPlan(buildInput(testCase));
  return plan?.steps[0]?.action ?? null;
}

describe('registry examples end-to-end deterministic routing', () => {
  const cases = collectRuntimeGoldenCases();
  const routableCases = cases.filter((testCase) => !isLlmTierExample(testCase));

  it('loads golden examples from the runtime registry', () => {
    expect(activeActions()).toHaveLength(51);
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(cases.filter((testCase) => testCase.requestLocale === 'es')).toHaveLength(52);
  });

  it('every runtime golden example declares expectedAction', () => {
    const missing = cases
      .filter((testCase) => testCase.expectedAction === undefined)
      .map((testCase) => testCase.id);
    expect(missing).toEqual([]);
  });

  it('any LLM-tier golden exception is explicit and documented', () => {
    const undocumented = cases
      .filter(isLlmTierExample)
      .filter((testCase) => (testCase.condition ?? '').trim().length < 16)
      .map((testCase) => testCase.id);
    expect(undocumented).toEqual([]);
  });

  it.each(routableCases.map((testCase) => [testCase.id, testCase] as const))(
    'routes %s to expectedAction',
    (_id, testCase) => {
      expect(route(testCase)).toBe(testCase.expectedAction);
    },
  );

  it('routes every Spanish-authored compatibility input under the English response contract', () => {
    const compatibilityCases = routableCases.filter(
      (testCase) => testCase.requestLocale === 'es',
    );
    expect(compatibilityCases).toHaveLength(52);
    for (const testCase of compatibilityCases) {
      expect(testCase.locale, testCase.id).toBe('en');
      expect(testCase.registryLocale, testCase.id).toBeUndefined();
      expect(testCase.responseLocale, testCase.id).toBe('en');
      expect(route(testCase), testCase.id).toBe(testCase.expectedAction);
    }
  });

  it('does not count Spanish-authored compatibility inputs as English product-locale eval rows', () => {
    const compatibilityTexts = new Set(
      cases
        .filter((testCase) => testCase.requestLocale === 'es')
        .map((testCase) => testCase.text),
    );
    const englishProductEvalTexts = new Set(
      buildRegistryDrivenEvalScenarios({
        tags: ['golden'],
        locales: ['en'],
        perActionMax: Number.MAX_SAFE_INTEGER,
      }).flatMap((scenario) => scenario.turns),
    );

    for (const text of compatibilityTexts) {
      expect(englishProductEvalTexts.has(text), text).toBe(false);
    }
  });

  it('keeps Spanish-authored compatibility examples available to the Tier 1 prompt slice', () => {
    const compatibilityTexts = new Set(
      cases
        .filter((testCase) => testCase.requestLocale === 'es')
        .map((testCase) => testCase.text),
    );
    const promptTexts = new Set(
      activeActions().flatMap((entry) =>
        buildLlmSafePromptSlice(entry).examples.map((example) => example.text)
      ),
    );

    expect(compatibilityTexts.size).toBe(52);
    for (const text of compatibilityTexts) {
      expect(promptTexts.has(text), text).toBe(true);
    }
  });

  it('reports 100% routing pass rate by locale for routable golden examples', () => {
    for (const locale of ['en', 'pt'] as const) {
      const localeCases = routableCases.filter((testCase) => testCase.locale === locale);
      const passed = localeCases.filter((testCase) => route(testCase) === testCase.expectedAction).length;
      expect({ locale, passed, total: localeCases.length }).toEqual({
        locale,
        passed: localeCases.length,
        total: localeCases.length,
      });
    }
  });
});
