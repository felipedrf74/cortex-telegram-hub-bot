import { describe, expect, it } from 'vitest';

import {
  buildFixturesFromRegistry,
  summarizeBuilderCoverage,
} from './registry-fixture-builder';
import {
  getChatActionRegistry,
  type ChatActionDefinition,
} from '../../src/services/chat/registry';

function syntheticRegistry(entries: Array<Partial<ChatActionDefinition> & { examples?: unknown[] }>): ChatActionDefinition[] {
  return entries.map((overrides) => ({
    skill: 'tasks',
    action: 'create_task',
    readableIntents: ['create a task'],
    requiredFields: ['title'],
    optionalFields: [],
    providerDependencies: ['nexus'],
    risk: 'safe_write',
    confirmationPolicy: 'none',
    executor: 'task_store.createTask',
    verifier: 'local_read_back',
    supportedCards: [],
    ...overrides,
  })) as unknown as ChatActionDefinition[];
}

describe('buildFixturesFromRegistry', () => {
  it('returns an empty array for an empty registry', () => {
    expect(buildFixturesFromRegistry({ registry: [] })).toEqual([]);
  });

  it('skips entries with no examples', () => {
    const registry = syntheticRegistry([
      { action: 'create_task' },
      { action: 'complete_task' },
    ]);
    expect(buildFixturesFromRegistry({ registry })).toEqual([]);
  });

  it('emits one fixture per example by default', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [
          { text: 'Create a task for tomorrow', tags: ['golden'] },
          { text: 'Cria uma tarefa para amanhã', locale: 'pt', tags: ['golden'] },
        ],
      },
    ]);
    const fixtures = buildFixturesFromRegistry({ registry });
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].text).toBe('Create a task for tomorrow');
    expect(fixtures[1].text).toBe('Cria uma tarefa para amanhã');
    expect(fixtures[1].locale).toBe('pt-PT');
  });

  it('respects perActionMax', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [
          { text: 'A', tags: ['golden'] },
          { text: 'B', tags: ['golden'] },
          { text: 'C', tags: ['golden'] },
        ],
      },
    ]);
    const fixtures = buildFixturesFromRegistry({ registry, perActionMax: 2 });
    expect(fixtures).toHaveLength(2);
    expect(fixtures.map((f) => f.text)).toEqual(['A', 'B']);
  });

  it('respects includeActions and excludeActions', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [{ text: 'task example', tags: ['golden'] }],
      },
      {
        action: 'complete_task',
        examples: [{ text: 'complete example', tags: ['golden'] }],
      },
    ]);
    const onlyCreate = buildFixturesFromRegistry({
      registry,
      includeActions: ['create_task'],
    });
    expect(onlyCreate).toHaveLength(1);
    expect(onlyCreate[0].expectedAction).toBe('create_task');

    const withoutComplete = buildFixturesFromRegistry({
      registry,
      excludeActions: ['complete_task'],
    });
    expect(withoutComplete).toHaveLength(1);
    expect(withoutComplete[0].expectedAction).toBe('create_task');
  });

  describe('tag → fixture mapping', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [
          {
            text: 'golden case',
            tags: ['golden'],
            expectedSlots: { title: 'something' },
          },
          {
            text: 'ambiguous case',
            tags: ['ambiguous'],
          },
          {
            text: 'negative case',
            tags: ['negative'],
          },
          {
            text: 'prompt injection case',
            tags: ['prompt_injection'],
          },
          {
            text: 'adversarial case',
            tags: ['adversarial'],
          },
          {
            text: 'untagged case',
            expectedSlots: { title: 'untagged-title' },
          },
        ],
      },
    ]);

    const fixtures = buildFixturesFromRegistry({ registry });

    it('golden tag maps to actionable=true, gate=true, expectedAction populated', () => {
      const golden = fixtures.find((f) => f.text === 'golden case');
      expect(golden).toBeTruthy();
      expect(golden?.expectedGate).toBe(true);
      expect(golden?.expectedActionable).toBe(true);
      expect(golden?.expectedAction).toBe('create_task');
      expect(golden?.expectedTitle).toBe('something');
      expect(golden?.expectedRefusal).toBeUndefined();
    });

    it('ambiguous tag maps to actionable=false, gate=true, no expectedAction', () => {
      const ambiguous = fixtures.find((f) => f.text === 'ambiguous case');
      expect(ambiguous?.expectedGate).toBe(true);
      expect(ambiguous?.expectedActionable).toBe(false);
      expect(ambiguous?.expectedAction).toBeUndefined();
    });

    it('negative tag maps to gate=false', () => {
      const negative = fixtures.find((f) => f.text === 'negative case');
      expect(negative?.expectedGate).toBe(false);
      expect(negative?.expectedActionable).toBeUndefined();
      expect(negative?.expectedRefusal).toBeUndefined();
    });

    it('prompt_injection tag maps to refusal=true, gate=false', () => {
      const injection = fixtures.find((f) => f.text === 'prompt injection case');
      expect(injection?.expectedRefusal).toBe(true);
      expect(injection?.expectedGate).toBe(false);
      expect(injection?.expectedActionable).toBeUndefined();
    });

    it('adversarial tag maps to refusal=true, gate=false', () => {
      const adversarial = fixtures.find((f) => f.text === 'adversarial case');
      expect(adversarial?.expectedRefusal).toBe(true);
      expect(adversarial?.expectedGate).toBe(false);
    });

    it('untagged example defaults to golden-like behaviour', () => {
      const untagged = fixtures.find((f) => f.text === 'untagged case');
      expect(untagged?.expectedGate).toBe(true);
      expect(untagged?.expectedActionable).toBe(true);
      expect(untagged?.expectedTitle).toBe('untagged-title');
    });
  });

  describe('expectedAction override', () => {
    it('when example.expectedAction is set, prefer it over the entry action', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            {
              text: 'agenda routing',
              tags: ['golden'],
              expectedAction: 'summarize_agenda',
            },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      expect(fixtures[0].expectedAction).toBe('summarize_agenda');
    });

    it('when example.expectedAction is null without injection tag, treat as clarification', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            {
              text: 'null action case',
              expectedAction: null,
            },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      expect(fixtures[0].expectedRefusal).toBeUndefined();
      expect(fixtures[0].expectedActionable).toBe(false);
      expect(fixtures[0].expectedGate).toBe(true);
    });

    it('when example.expectedAction is null AND tagged negative, prefer the negative classification', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            {
              text: 'negative null action',
              tags: ['negative'],
              expectedAction: null,
            },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      expect(fixtures[0].expectedGate).toBe(false);
      expect(fixtures[0].expectedRefusal).toBeUndefined();
      expect(fixtures[0].expectedActionable).toBeUndefined();
    });
  });

  describe('expectedSlots → fixture flags', () => {
    it('sets expectDueDateTime when expectedSlots has a datetime-like field', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            {
              text: 'with due',
              tags: ['golden'],
              expectedSlots: {
                title: 'X',
                dueDateTime: '<tomorrow 09:00 user-tz>',
              },
            },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      expect(fixtures[0].expectDueDateTime).toBe(true);
      expect(fixtures[0].expectedTitle).toBe('X');
    });

    it('sets expectDueDateTime for startDateTime / date / scheduledDateTime variants', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            { text: 'a', tags: ['golden'], expectedSlots: { startDateTime: 'x' } },
            { text: 'b', tags: ['golden'], expectedSlots: { date: 'x' } },
            { text: 'c', tags: ['golden'], expectedSlots: { scheduledDateTime: 'x' } },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      for (const fixture of fixtures) {
        expect(fixture.expectDueDateTime).toBe(true);
      }
    });

    it('omits expectedTitle when no title slot is present', () => {
      const registry = syntheticRegistry([
        {
          action: 'complete_task',
          examples: [
            { text: 'mark done', tags: ['golden'], expectedSlots: { taskId: 'placeholder' } },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      expect(fixtures[0].expectedTitle).toBeUndefined();
    });
  });

  describe('id generation', () => {
    it('produces unique deterministic ids', () => {
      const registry = syntheticRegistry([
        {
          action: 'create_task',
          examples: [
            { text: 'a', tags: ['golden'] },
            { text: 'b', tags: ['negative'] },
          ],
        },
      ]);
      const fixtures = buildFixturesFromRegistry({ registry });
      const ids = fixtures.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('tasks-create_task-golden-0');
      expect(ids[1]).toBe('tasks-create_task-negative-1');
    });
  });

  describe('against the live registry', () => {
    const liveRegistry = getChatActionRegistry();

    it('the live registry currently has at least 1 populated examples entry', () => {
      const summary = summarizeBuilderCoverage(liveRegistry);
      expect(summary.totalActions).toBeGreaterThan(0);
      // schedule_event ships with one example today; Phase 1 expands this.
      expect(summary.actionsWithExamples).toBeGreaterThanOrEqual(1);
    });

    it('emits fixtures from the live registry without throwing', () => {
      const fixtures = buildFixturesFromRegistry({ registry: liveRegistry });
      expect(Array.isArray(fixtures)).toBe(true);
      for (const fixture of fixtures) {
        expect(typeof fixture.id).toBe('string');
        expect(typeof fixture.text).toBe('string');
        expect(typeof fixture.expectedGate).toBe('boolean');
      }
    });
  });
});

describe('summarizeBuilderCoverage', () => {
  it('counts actions with examples and tag categories', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [
          { text: 'a', tags: ['golden'] },
          { text: 'b', tags: ['ambiguous'] },
        ],
      },
      {
        action: 'complete_task',
        examples: [],
      },
      {
        action: 'delete_task',
        examples: [
          { text: 'c', tags: ['prompt_injection'] },
        ],
      },
    ]);
    const summary = summarizeBuilderCoverage(registry);
    expect(summary.totalActions).toBe(3);
    expect(summary.actionsWithExamples).toBe(2);
    expect(summary.actionsByCategory.golden).toBe(1);
    expect(summary.actionsByCategory.ambiguous).toBe(1);
    expect(summary.actionsByCategory.prompt_injection).toBe(1);
    expect(summary.actionsByCategory.untagged).toBe(0);
  });

  it('counts untagged examples separately', () => {
    const registry = syntheticRegistry([
      {
        action: 'create_task',
        examples: [
          { text: 'a' },
          { text: 'b' },
        ],
      },
    ]);
    const summary = summarizeBuilderCoverage(registry);
    expect(summary.actionsByCategory.untagged).toBe(2);
    expect(summary.actionsByCategory.golden).toBe(0);
  });
});
