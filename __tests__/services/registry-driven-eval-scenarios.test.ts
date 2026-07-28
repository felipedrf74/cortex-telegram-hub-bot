// Phase 4 batch 19 (2026-05-15): registry-driven eval scenarios test.
//
// Validates the generator at src/services/registry-driven-eval-scenarios.ts.
// The generator is a pure function of the registry; this test pins:
//
//  • Shape: every produced scenario has the right ChatEvalScenario fields.
//  • Coverage: at least one scenario per active action with examples.
//  • Tag mapping: golden → normal persona; prompt_injection/adversarial →
//    unauthorized_attacker + redTeam: true.
//  • Required-dimension mapping: red-team examples require injection-
//    resistance + tenant isolation; ambiguous examples require clarification
//    quality; golden destructive actions require confirmation correctness.
//  • Harness integration: every generated row is reported as catalog-only;
//    registry definitions never receive fabricated execution scores.

import { describe, expect, it } from 'vitest';

import {
  buildRegistryDrivenEvalScenarios,
} from '../../src/services/registry-driven-eval-scenarios';
import {
  getChatActionRegistry,
} from '../../src/services/chat/registry';
import {
  runChatEvaluationSuite,
} from '../../src/services/chat-evaluation-harness';
import { DAY_TO_DAY_SCENARIOS } from '../../src/services/chat-day-to-day-simulation';

describe('registry-driven eval scenarios — shape and coverage', () => {
  it('produces at least one scenario per active action with golden examples', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const registry = getChatActionRegistry();
    const actionsWithGoldenExamples = registry.filter((entry) => {
      const examples = (entry.examples ?? []) as Array<{ tags?: string[] }>;
      return examples.some((ex) => (ex.tags ?? ['golden']).includes('golden'));
    });
    const coveredActions = new Set(
      scenarios.map((s) => s.title.split(' — ')[0]),
    );
    for (const entry of actionsWithGoldenExamples) {
      const key = `${entry.skill}.${entry.action}`;
      expect(coveredActions.has(key), `${key}: not covered by registry-driven scenarios`).toBe(true);
    }
  });

  it('every scenario has non-empty id, title, turns, expectedCapabilities, requiredDimensions', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    for (const scenario of scenarios) {
      expect(scenario.id).toMatch(/^registry\./);
      expect(scenario.title.length).toBeGreaterThan(5);
      expect(scenario.turns.length).toBeGreaterThanOrEqual(1);
      expect(scenario.expectedCapabilities.length).toBeGreaterThanOrEqual(1);
      expect(scenario.requiredDimensions.length).toBeGreaterThanOrEqual(1);
      expect(scenario.acceptance.length).toBe(scenario.requiredDimensions.length);
    }
  });

  it('red-team tags (prompt_injection + adversarial) map to unauthorized_attacker + redTeam: true', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['prompt_injection', 'adversarial'] });
    expect(scenarios.length).toBeGreaterThanOrEqual(13);
    for (const scenario of scenarios) {
      expect(scenario.personaId).toBe('unauthorized_attacker');
      expect(scenario.redTeam).toBe(true);
      expect(scenario.requiredDimensions).toContain('promptInjectionResistance');
      expect(scenario.requiredDimensions).toContain('tenantIsolation');
    }
  });

  it('ambiguous tag maps to clarificationQuality requirement', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['ambiguous'] });
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    for (const scenario of scenarios) {
      expect(scenario.redTeam).toBe(false);
      expect(scenario.requiredDimensions).toContain('clarificationQuality');
    }
  });

  it('negative tag maps to skillRoutingAccuracy + clarificationQuality requirements', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['negative'] });
    expect(scenarios.length).toBeGreaterThanOrEqual(8);
    for (const scenario of scenarios) {
      expect(scenario.redTeam).toBe(false);
      expect(scenario.requiredDimensions).toContain('skillRoutingAccuracy');
    }
  });

  it('destructive golden actions require actionConfirmationCorrectness', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const destructiveScenarios = scenarios.filter((s) => s.destructive);
    expect(destructiveScenarios.length).toBeGreaterThanOrEqual(3);
    for (const scenario of destructiveScenarios) {
      expect(scenario.requiredDimensions).toContain('actionConfirmationCorrectness');
    }
  });

  it('filters by includeActions when provided', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: ['golden'],
      includeActions: ['create_task'],
    });
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(scenario.title).toMatch(/tasks\.create_task/);
    }
  });

  it('caps per-action via perActionMax', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: ['golden'],
      includeActions: ['create_task'],
      perActionMax: 1,
    });
    expect(scenarios).toHaveLength(1);
  });
});

describe('registry-driven scenarios — integration with runChatEvaluationSuite', () => {
  it('accounts for every registry row without mislabeling it as executed evidence', async () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: ['golden'],
      perActionMax: 1,
    });
    expect(scenarios.length).toBeGreaterThan(0);
    const result = await runChatEvaluationSuite({ scenarios });
    expect(result.catalogCoverage).toMatchObject({
      total: scenarios.length,
      executed: 0,
      excluded: scenarios.length,
      reasonCode: 'catalog_only_no_executable_profile_v1',
    });
    expect(result.catalogCoverage.ids).toEqual(scenarios.map((scenario) => scenario.id));
    expect(result.scenarioCount).toBe(DAY_TO_DAY_SCENARIOS.length);
    expect(result.scenarios).toHaveLength(DAY_TO_DAY_SCENARIOS.length);
    const catalogIds = new Set<string>(scenarios.map((scenario) => scenario.id));
    expect(result.scenarios.some((scenario) => catalogIds.has(scenario.id))).toBe(false);
    expect(typeof result.averageScore).toBe('number');
    expect(result.statusCounts).toHaveProperty('pass');
    expect(result.statusCounts).toHaveProperty('partial');
    expect(result.statusCounts).toHaveProperty('fail');
  });
});
