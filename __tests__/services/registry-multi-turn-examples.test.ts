// Phase 5 batch 25 (2026-05-15): multi-turn registry examples.
//
// The `examples` field accepts an optional `turns` array for multi-turn
// scenarios. This test validates:
//
//   • At least one registry action carries a multi-turn example.
//   • The registry-driven scenario builder propagates `turns` correctly.
//   • Single-turn examples continue to work (turns defaults to [text]).
//   • Multi-turn examples that mention the deterministic-planner can route
//     turn 1 deterministically; turn 2+ are state-dependent (covered by the
//     state-required parity harness, not this test).

import { describe, expect, it } from 'vitest';

import {
  getChatActionRegistry,
  type ChatActionDefinition,
} from '../../src/services/chat/registry';
import {
  buildRegistryDrivenEvalScenarios,
} from '../../src/services/registry-driven-eval-scenarios';

type ExampleWithTurns = NonNullable<ChatActionDefinition['examples']>[number] & {
  turns?: string[];
};

describe('multi-turn registry examples (Phase 5 batch 25)', () => {
  it('at least one registry example carries a non-empty turns array', () => {
    const registry = getChatActionRegistry();
    let foundMultiTurn = false;
    for (const entry of registry) {
      const examples = (entry.examples ?? []) as ExampleWithTurns[];
      for (const example of examples) {
        if (Array.isArray(example.turns) && example.turns.length >= 2) {
          foundMultiTurn = true;
          break;
        }
      }
      if (foundMultiTurn) break;
    }
    expect(foundMultiTurn, 'expected at least one multi-turn example in the registry').toBe(true);
  });

  it('multi-turn example first turn matches the legacy text field', () => {
    const registry = getChatActionRegistry();
    for (const entry of registry) {
      const examples = (entry.examples ?? []) as ExampleWithTurns[];
      for (const example of examples) {
        if (Array.isArray(example.turns) && example.turns.length > 0) {
          expect(
            example.turns[0],
            `${entry.skill}.${entry.action}: turns[0] must match text for backwards-compat`,
          ).toBe(example.text);
        }
      }
    }
  });

  it('buildRegistryDrivenEvalScenarios propagates multi-turn turns array', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const multiTurnScenario = scenarios.find((s) => s.turns.length >= 2);
    expect(multiTurnScenario, 'expected at least one multi-turn scenario').toBeDefined();
    expect(multiTurnScenario!.turns.length).toBeGreaterThanOrEqual(2);
  });

  it('single-turn examples still produce turns of length 1 in the eval scenario', () => {
    const scenarios = buildRegistryDrivenEvalScenarios({
      tags: ['golden'],
      includeActions: ['create_task'],
      perActionMax: 1,
    });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].turns).toHaveLength(1);
  });
});
