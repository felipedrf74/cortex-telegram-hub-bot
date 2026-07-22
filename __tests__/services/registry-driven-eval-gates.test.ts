// Registry-driven catalog accounting gates.
//
// Registry examples are scenario definitions, not executable chat evidence.
// The harness must account for every supplied catalog row without assigning
// it a fabricated status or score. Executed fixture/live results come only
// from an evidence-bearing day-to-day profile and are asserted separately.

import { describe, expect, it } from 'vitest';

import {
  buildRegistryDrivenEvalScenarios,
} from '../../src/services/registry-driven-eval-scenarios';
import {
  runChatEvaluationSuite,
} from '../../src/services/chat-evaluation-harness';
import { DAY_TO_DAY_SCENARIOS } from '../../src/services/chat-day-to-day-simulation';

const CATALOG_TAGS = [
  'golden',
  'ambiguous',
  'negative',
  'prompt_injection',
  'adversarial',
] as const;

type RegistryScenario = ReturnType<typeof buildRegistryDrivenEvalScenarios>[number];
type SuiteResult = Awaited<ReturnType<typeof runChatEvaluationSuite>>;

function expectCatalogAccountedWithoutSyntheticExecution(
  result: SuiteResult,
  scenarios: RegistryScenario[],
): void {
  expect(result.catalogCoverage).toMatchObject({
    total: scenarios.length,
    executed: 0,
    excluded: scenarios.length,
    reasonCode: 'catalog_only_no_executable_profile_v1',
  });
  expect(result.catalogCoverage.ids).toEqual(scenarios.map((scenario) => scenario.id));
  const catalogIds = new Set<string>(scenarios.map((scenario) => scenario.id));
  expect(result.scenarios.some((scenario) => catalogIds.has(scenario.id))).toBe(false);
}

describe('registry-driven catalog accounting gates', () => {
  it('accounts for the complete registry catalog without manufacturing a macro pass rate', async () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: [...CATALOG_TAGS],
    });
    expect(scenarios.length).toBeGreaterThanOrEqual(150);
    const result = await runChatEvaluationSuite({ scenarios });
    expectCatalogAccountedWithoutSyntheticExecution(result, scenarios);
  });

  for (const tag of CATALOG_TAGS) {
    it(`accounts for every "${tag}" catalog row without presenting it as execution evidence`, async () => {
      const scenarios = buildRegistryDrivenEvalScenarios({ tags: [tag] });
      expect(scenarios.length).toBeGreaterThan(0);
      const result = await runChatEvaluationSuite({ scenarios });
      expectCatalogAccountedWithoutSyntheticExecution(result, scenarios);
    });
  }

  it('preserves every registry skill represented by the golden catalog', async () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const result = await runChatEvaluationSuite({ scenarios });
    expectCatalogAccountedWithoutSyntheticExecution(result, scenarios);
    const catalogSkills = new Set(scenarios.map((scenario) => scenario.title.split('.')[0]));
    expect(catalogSkills.size).toBeGreaterThanOrEqual(10);
  });

  it('keeps the fixture execution verdict separate from catalog coverage', async () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const result = await runChatEvaluationSuite({ scenarios });
    expect(scenarios.length).toBeGreaterThanOrEqual(45);
    expectCatalogAccountedWithoutSyntheticExecution(result, scenarios);
    expect(result.evaluationProfile).toBe('fixture_full_v1');
    expect(result.scenarioCount).toBe(DAY_TO_DAY_SCENARIOS.length);
    expect(result.scenarios).toHaveLength(DAY_TO_DAY_SCENARIOS.length);
    expect(result.averageScore).toBeGreaterThan(0);
    expect(result.averageScore).toBeLessThanOrEqual(2);
  });
});
