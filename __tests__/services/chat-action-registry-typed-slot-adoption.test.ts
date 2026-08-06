// Phase 12 batch 63 (2026-05-16): typed slot extractor adoption tests.
//
// Phase 11 batch 59 added the typed `SlotExtractor` / `SlotValidator`
// system. Phase 12 batch 63 wires it into the three highest-impact
// actions:
//
//   • secretary_calendar.schedule_event  → calendarEventSlotExtractor
//   • tasks.create_task                  → simpleTaskSlotExtractor
//   • training.training_plan_create      → trainingPlanSlotExtractor
//
// These tests exercise the registry round-trip: pull the entry, read its
// typed extractor via getSlotExtractors, run it against a real example
// string, and assert the extracted slots match expectations. The
// validators are also exercised via runSlotValidators.

import { describe, expect, it } from 'vitest';

import {
  type ChatActionDefinition,
  findChatActionDefinition,
  getChatActionRegistry,
  getSlotExtractors,
  getSlotValidators,
  runSlotValidators,
} from '../../src/services/chat/registry';

function activeActions(entries: ChatActionDefinition[]): ChatActionDefinition[] {
  return entries.filter((entry) => entry.status === 'active');
}

function exampleTags(example: { tags?: string[] }): string[] {
  return Array.isArray(example.tags) ? example.tags : ['golden'];
}

describe('typed slot adoption — schedule_event (Phase 12 batch 63)', () => {
  it('exposes the calendar typed extractor on schedule_event', () => {
    const entry = findChatActionDefinition('secretary_calendar', 'schedule_event');
    expect(entry).not.toBeNull();
    const extractors = getSlotExtractors(entry!);
    expect(extractors[0].name).toBe('calendar_event_nlp');
  });

  it('extracts a full calendar slot map from a natural-language phrase', () => {
    const entry = findChatActionDefinition('secretary_calendar', 'schedule_event')!;
    const ext = getSlotExtractors(entry)[0];
    const result = ext.extract(
      'Schedule a meeting for Friday at 2pm called weekly sync',
      { timezone: 'Europe/London', nowIso: '2026-05-16T12:00:00+01:00' },
    );
    expect(result.slots.title).toBe('weekly sync');
    expect(typeof result.slots.startDateTime).toBe('string');
    expect(typeof result.slots.endDateTime).toBe('string');
    expect(result.slots.timezone).toBe('Europe/London');
    expect(result.slots.provider).toBe('google_calendar');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('returns empty slots when the text is not a calendar write intent', () => {
    const entry = findChatActionDefinition('secretary_calendar', 'schedule_event')!;
    const ext = getSlotExtractors(entry)[0];
    const result = ext.extract('What is on my agenda today?', { timezone: 'UTC' });
    expect(result.slots).toEqual({});
  });

  it('validator flags missing fields when the extractor returns empty slots', () => {
    const entry = findChatActionDefinition('secretary_calendar', 'schedule_event')!;
    const result = runSlotValidators(entry, {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['title', 'startDateTime', 'endDateTime', 'timezone', 'provider']),
    );
  });

  it('validator passes when all required fields are present', () => {
    const entry = findChatActionDefinition('secretary_calendar', 'schedule_event')!;
    const result = runSlotValidators(entry, {
      title: 'weekly sync',
      startDateTime: '2026-05-22T14:00:00+01:00',
      endDateTime: '2026-05-22T15:00:00+01:00',
      timezone: 'Europe/London',
      provider: 'google_calendar',
    });
    expect(result.ok).toBe(true);
  });
});

describe('typed slot adoption — create_task (Phase 12 batch 63)', () => {
  it('exposes the task typed extractor on create_task', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    expect(getSlotExtractors(entry)[0].name).toBe('simple_task_title');
  });

  it('extracts the title from a "called X" marker', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Create a task called weekly review',
      { locale: 'en-US' },
    );
    expect(result.slots.title).toBe('weekly review');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('extracts the title from a Portuguese "chamada X" marker', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Cria uma tarefa chamada revisar pull request',
      { locale: 'pt-BR' },
    );
    expect(result.slots.title).toBe('revisar pull request');
  });

  it('extracts the title from a Spanish "llamada X" marker', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Crea una tarea llamada llamar a Carlos',
      { locale: 'es-ES' },
    );
    expect(result.slots.title).toBe('llamar a Carlos');
  });

  it('prefers quoted strings over markers', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Create a task "draft Q3 plan"',
      {},
    );
    expect(result.slots.title).toBe('draft Q3 plan');
    expect(result.confidence).toBe(0.95);
  });

  it('returns empty slots when no title marker is present', () => {
    const entry = findChatActionDefinition('tasks', 'create_task')!;
    const result = getSlotExtractors(entry)[0].extract('Create something for me', {});
    expect(result.slots).toEqual({});
  });
});

describe('typed slot adoption — task subtasks', () => {
  it('extracts parent task and subtasks for task-with-subtasks actions', () => {
    const entry = findChatActionDefinition('tasks', 'create_task_with_subtasks')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Create task "Prozis" with subtasks "creatine", "K2", "D3"',
      { locale: 'en-US' },
    );
    expect(result.slots).toMatchObject({
      title: 'Prozis',
      subtasks: ['creatine', 'K2', 'D3'],
    });
  });

  it('extracts Spanish add-subtask targets without leaking articles into the title', () => {
    const entry = findChatActionDefinition('tasks', 'add_subtasks_to_task')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Añade creatina, K2 y D3 a la tarea Prozis',
      { locale: 'es-ES' },
    );
    expect(result.slots).toMatchObject({
      title: 'Prozis',
      subtasks: ['creatina', 'K2', 'D3'],
    });
  });
});

describe('typed slot adoption — training_plan_create (Phase 12 batch 63)', () => {
  it('exposes the training typed extractor on training_plan_create', () => {
    const entry = findChatActionDefinition('training', 'training_plan_create')!;
    expect(getSlotExtractors(entry)[0].name).toBe('training_plan_slots');
  });

  it('extracts the REST-compatible creation core from natural language', () => {
    const entry = findChatActionDefinition('training', 'training_plan_create')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Build me a 10K plan for 12 weeks starting Monday with 4 sessions per week',
      { timezone: 'Europe/Madrid', nowIso: '2026-05-16T12:00:00+02:00' },
    );
    expect(result.slots).toMatchObject({
      objective: '10K',
      durationWeeks: 12,
      sessionsPerWeek: 4,
      startPolicy: 'next_full_week',
    });
    expect(result.slots).not.toHaveProperty('weeklyVolumeKm');
  });

  it('validator surfaces exactly every missing required field and accepts the complete core', () => {
    const entry = findChatActionDefinition('training', 'training_plan_create')!;
    const validators = getSlotValidators(entry);
    expect(validators[0].name).toBe('required_fields');
    const validateRequiredCore = validators[0].validate;
    const result = runSlotValidators(entry, { objective: '10K' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['durationWeeks', 'sessionsPerWeek', 'startPolicy']);

    const complete = runSlotValidators(entry, {
      objective: '10K',
      durationWeeks: 12,
      sessionsPerWeek: 4,
      startPolicy: 'next_full_week',
    });
    expect(complete.ok).toBe(true);
    expect(complete.missing).toBeUndefined();

    const completeCore = {
      objective: '10K',
      durationWeeks: 12,
      sessionsPerWeek: 4,
      startPolicy: 'next_full_week',
    };
    expect(validateRequiredCore(completeCore)).toEqual({ ok: true, missing: undefined });
    for (const emptyValue of [null, undefined, '']) {
      expect(validateRequiredCore({ ...completeCore, sessionsPerWeek: emptyValue })).toEqual({
        ok: false,
        missing: ['sessionsPerWeek'],
      });
    }
  });
});

describe('typed slot adoption — content pipeline stage transition', () => {
  it('extracts target stage and topic title from content pipeline phrasings', () => {
    const entry = findChatActionDefinition('content', 'content_pipeline_stage_transition')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Move the morning routine reel to editing',
      { locale: 'en-US' },
    );
    expect(result.slots).toMatchObject({
      topicTitle: 'morning routine reel',
      targetStage: 'editing',
    });
    expect(result.confidence).toBeGreaterThan(0.8);
  });
});

describe('typed slot adoption — cooking ingredient substitution', () => {
  it('extracts date, meal type, original ingredient, and replacement', () => {
    const entry = findChatActionDefinition('cooking', 'cooking_substitute_ingredient')!;
    const result = getSlotExtractors(entry)[0].extract(
      'Replace peanuts with sunflower seed butter in dinner tomorrow',
      { locale: 'en-US', timezone: 'Europe/Lisbon', nowIso: '2026-05-14T12:00:00+01:00' },
    );
    expect(result.slots).toMatchObject({
      date: '2026-05-15',
      mealType: 'dinner',
      originalIngredient: 'peanuts',
      suggestedIngredient: 'sunflower seed butter',
    });
    expect(result.confidence).toBeGreaterThan(0.8);
  });
});

describe('typed slot adoption inventory (Phase 15 batch 77: full coverage)', () => {
  it('imports the runtime registry and finds exactly 51 active actions', () => {
    const entries = getChatActionRegistry();
    expect(entries).toHaveLength(51);
    expect(activeActions(entries)).toHaveLength(51);
  });

  it('excludes non-active action definitions from active-action counts', () => {
    const [first] = getChatActionRegistry();
    expect(first).toBeTruthy();
    const synthetic = [
      first!,
      { ...first!, action: 'mail_unread_count', status: 'deprecated' as const },
      { ...first!, action: 'mail_inbox_summary', status: 'experimental' as const },
    ];
    expect(activeActions(synthetic).map((entry) => entry.status)).toEqual(['active']);
  });

  it('all 51 active registry actions have typedSlotExtractors (full coverage)', () => {
    // Adoption history:
    //   Phase 12 batch 63 — 3 (calendar/task/training core)
    //   Phase 13 batch 67 — +5 (mail send/draft, delete_event, etc.)
    //   Phase 14 batch 72 — +10 (extended to 18)
    //   Phase 15 batch 77 — +29 (FULL coverage; noop adapter for entries
    //     where extraction has no useful NL signal)
    const entries = activeActions(getChatActionRegistry());
    const adopted = entries.filter((e: { typedSlotExtractors?: unknown }) => Array.isArray(e.typedSlotExtractors) && e.typedSlotExtractors.length > 0);
    expect(adopted.length).toBe(51);
    expect(adopted.length).toBe(entries.length);
  });

  it('every active action has at least one supported-locale golden example', () => {
    const missing = activeActions(getChatActionRegistry()).filter((entry) => !((entry.examples ?? []).some((example) =>
      (example.locale === 'en' || example.locale === 'pt' || example.locale === 'mixed')
      && exampleTags(example).includes('golden')
    )));
    expect(
      missing.map((entry) => `${entry.skill}.${entry.action}`),
      'active actions missing en/pt/mixed golden examples',
    ).toEqual([]);
  });

  it('every active golden example declares expectedAction', () => {
    const missing: string[] = [];
    for (const entry of activeActions(getChatActionRegistry())) {
      for (const [index, example] of (entry.examples ?? []).entries()) {
        if (exampleTags(example).includes('golden') && example.expectedAction === undefined) {
          missing.push(`${entry.skill}.${entry.action}#${index}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('inventories intentional noopSlotExtractor usage with action-level justification', () => {
    const justifiedNoops: Record<string, string> = {
      'training.training_reflow_preview': 'preview uses current Training plan/session state; no durable natural-language slot is useful without provider state',
      'training.training_reflow_confirm': 'confirmation applies a pending preview; slot truth is the pending action id, not raw text',
      'content.content_pipeline_handoff': 'handoff operates on the current/visible package; package id comes from UI or recent entity context',
      'finance.finance_payment_action': 'financial payment actions require strong confirmation and provider context; raw text extraction would be unsafe',
      'secretary_reminders.set_reminder': 'standalone reminder slot extraction is owned by the deterministic reminder parser to preserve timezone/date semantics',
    };
    const actual = activeActions(getChatActionRegistry())
      .filter((entry) => (entry.typedSlotExtractors ?? []).some((extractor) => extractor.name === 'noop'))
      .map((entry) => `${entry.skill}.${entry.action}`)
      .sort();

    expect(actual).toEqual(Object.keys(justifiedNoops).sort());
    for (const action of actual) {
      expect(justifiedNoops[action].length).toBeGreaterThan(40);
    }
  });
});
