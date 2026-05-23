import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/api/routes/training-plan-calendar-sync', () => ({
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
}));

import {
  buildChatActionPlan,
  buildDeterministicChatActionPlan,
  buildLlmPlannerPrompt,
  buildTier1ClassifierPrompt,
  executeChatActionPlan,
  parseLlmPlannerJson,
  parseTier1ClassifierJson,
  shouldRunActionPlannerBeforeReadOnlyFastPaths,
  tryHandleChatActionPlan,
} from '../../src/services/chat-action-planner';
import {
  cancelPendingChatActionsForAccountSwitch,
  expireStalePendingChatActionsForJob,
  getActivePendingChatAction,
  getPendingChatActionById,
  rememberRecentChatEntity,
  resetChatActionStateForTests,
  upsertPendingChatAction,
} from '../../src/services/chat-action-state';
import {
  claimChatActionRunForExecution,
  getChatActionRun,
  pruneCompletedChatActionRuns,
  reapZombieChatActionRuns,
  updateChatActionRun,
} from '../../src/services/chat-action-run-store';
import { getChatActionRegistry } from '../../src/services/chat-action-registry';
import { parseNaturalLanguageCalendarEvent } from '../../src/services/calendar-natural-language-parser';
import { buildContentAgencyPackage, ensureContentAgencyTables, persistContentAgencyArtifact } from '../../src/services/content-agency';
import { getTopics } from '../../src/services/content-scheduler';
import { addRecipe, generateShoppingList, getMealPlan, getRecipeById, getShoppingList, setMealPlan } from '../../src/services/cooking-chef';
import { addTransaction, calculateAndStoreTax, getTaxEvents, getTransactions } from '../../src/services/finance-tracker';
import { confirmTrainingSessionReflow, previewTrainingSessionReflow } from '../../src/api/routes/training-plan-calendar-sync';
import { executeTaskWithSubtasksStep } from '../../src/services/skills/tasks/executor';

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

const baseInput = {
  text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
  userId: 42,
  tenantId: 42,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  channel: 'ios' as const,
  locale: 'pt-PT',
  timezone: 'Europe/Lisbon',
  nowIso: FROZEN_NOW,
  persistRuns: false,
};

describe('ChatActionPlanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatActionStateForTests();
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('asks a clarifying question instead of guessing for ambiguous schedule requests', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Schedule something for tomorrow',
      locale: 'en-US',
      messageId: 'msg-ambiguous-schedule',
    });

    expect(plan).toMatchObject({
      clarificationReason: 'ambiguous_intent',
      intentClass: 'clarifying_question',
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        requiredArgsPresent: false,
      }],
    });

    const response = await executeChatActionPlan(plan!, {
      ...baseInput,
      text: 'Schedule something for tomorrow',
      locale: 'en-US',
      messageId: 'msg-ambiguous-schedule',
      persistRuns: false,
    }, {} as never);

    expect(response.text).toMatch(/event, a task, or a reminder/i);
    expect(response.metadata).toMatchObject({
      type: 'chat_action_needs_input',
      actionStatus: 'needs_clarification',
      intentClass: 'clarifying_question',
      clarification: {
        reason: 'ambiguous_intent',
      },
    });
  });

  it('asks the same clarifying question for ambiguous Portuguese schedule requests', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Agenda algo para amanhã',
      locale: 'pt-PT',
      messageId: 'msg-ambiguous-schedule-pt',
    });

    expect(plan).toMatchObject({
      clarificationReason: 'ambiguous_intent',
      intentClass: 'clarifying_question',
    });
    expect(plan?.clarificationQuestion).toMatch(/evento.*tarefa.*lembrete/i);
  });

  it('routes the Portuguese Gmail-agenda command to Google Calendar, not Gmail unread', async () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths(baseInput.text)).toBe(true);
    const parsed = parseNaturalLanguageCalendarEvent(baseInput.text, {
      timezone: 'Europe/Lisbon',
      nowIso: FROZEN_NOW,
    });
    expect(parsed).toMatchObject({
      title: 'igreja',
      provider: 'google',
      startDateTime: '2026-05-17T10:00:00+01:00',
      endDateTime: '2026-05-17T12:30:00+01:00',
      timezone: 'Europe/Lisbon',
    });

    const plan = await buildChatActionPlan(baseInput);
    expect(plan).toMatchObject({
      planner: 'deterministic',
      requiresConfirmation: false,
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        provider: 'google_calendar',
        requiredArgsPresent: true,
        risk: 'safe_write',
      }],
    });
    expect(plan?.steps[0]?.args).toMatchObject({
      title: 'igreja',
      provider: 'google_calendar',
      startDateTime: '2026-05-17T10:00:00+01:00',
      endDateTime: '2026-05-17T12:30:00+01:00',
      timezone: 'Europe/Lisbon',
    });
    expect(plan?.debug?.rejectedFastPaths).toContain('gmail_unread_count');
  });

  it('uses the same step idempotency key for deterministic and LLM plans with the same scoped args', () => {
    const deterministic = buildDeterministicChatActionPlan(baseInput);
    const args = deterministic?.steps[0]?.args;
    const llm = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.98,
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        args,
        missingFields: [],
      }],
    }), baseInput);

    expect(deterministic?.steps[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(llm?.steps[0]?.idempotencyKey).toBe(deterministic?.steps[0]?.idempotencyKey);
  });

  it('keeps step idempotency parity when LLM emits equivalent datetime slots without milliseconds', () => {
    const taskInput = {
      ...baseInput,
      text: 'Create a task for tomorrow 9 am called Test chat',
      locale: 'en-US',
    };
    const deterministic = buildDeterministicChatActionPlan(taskInput);
    const deterministicArgs = deterministic?.steps[0]?.args as Record<string, unknown>;
    const llm = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.98,
      steps: [{
        skill: 'tasks',
        action: 'create_task',
        args: {
          ...deterministicArgs,
          dueDateTime: '2026-05-15T09:00:00+01:00',
        },
        missingFields: [],
      }],
    }), taskInput);

    expect(deterministic?.steps[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(llm?.steps[0]?.idempotencyKey).toBe(deterministic?.steps[0]?.idempotencyKey);
  });

  it('canonicalizes equivalent ISO offsets to the same step idempotency key', () => {
    const variants = [
      '2026-05-15T10:00:00Z',
      '2026-05-15T10:00:00.000Z',
      '2026-05-15T10:00:00+00:00',
      '2026-05-15T11:00:00+01:00',
    ];
    const hashes = new Set(variants.map((startDateTime) => parseLlmPlannerJson(JSON.stringify({
      confidence: 0.98,
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        args: {
          title: 'igreja',
          provider: 'google_calendar',
          startDateTime,
          endDateTime: '2026-05-15T11:00:00Z',
          timezone: 'Europe/Lisbon',
        },
        missingFields: [],
      }],
    }), baseInput)?.steps[0]?.idempotencyKey));

    expect([...hashes]).toHaveLength(1);
    expect([...hashes][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps distinct ISO instants in distinct step idempotency keys', () => {
    const hashFor = (startDateTime: string) => parseLlmPlannerJson(JSON.stringify({
      confidence: 0.98,
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        args: {
          title: 'igreja',
          provider: 'google_calendar',
          startDateTime,
          endDateTime: '2026-05-15T11:00:00Z',
          timezone: 'Europe/Lisbon',
        },
        missingFields: [],
      }],
    }), baseInput)?.steps[0]?.idempotencyKey;

    expect(hashFor('2026-05-15T11:00:00+01:00')).not.toBe(hashFor('2026-05-15T11:00:00+02:00'));
  });

  it('asks a targeted clarification when a calendar command is missing the event title', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no domingo às 10',
    });

    expect(plan?.steps[0]).toMatchObject({
      skill: 'secretary_calendar',
      action: 'schedule_event',
      requiredArgsPresent: false,
    });
    expect(plan?.clarificationQuestion).toMatch(/t[íi]tulo/i);
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.text).toMatch(/t[íi]tulo/i);
  });

  it('executes and claims success only after provider read-back matches', async () => {
    const created = {
      id: 'google-event-1',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    const createEvent = vi.fn().mockResolvedValue(created);

    const result = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(result?.status).toBe('verified_success');
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][1]).toBe('google');
    expect(getEventsForSources).toHaveBeenCalledTimes(2);
    expect(result?.response.text).toContain('Feito — criei');
    expect(result?.response.text).toContain('igreja');
    expect(result?.response.metadata).toMatchObject({
      type: 'chat_action_verified_success',
      actionStatus: 'verified_success',
      verificationStatus: 'verified_success',
    });
    expect(JSON.stringify(result?.response.metadata)).not.toMatch(/auth\.scope|skill_capability_registry|fallback policy|chatReasoning/i);
  });

  it('does not claim verified success when provider read-back does not match', async () => {
    const created = {
      id: 'google-event-1',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...created, id: 'other', summary: 'other event' }]);

    const result = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(created) as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(result?.status).toBe('partial_success');
    expect(result?.response.text).not.toMatch(/\bcriei\b.*\bverifiquei\b/i);
    expect(result?.response.metadata.type).toBe('chat_action_partial_success');
  });

  it('downgrades provider read-back timeout to partial success instead of a false failure', async () => {
    const previousTimeout = process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
    process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS = '1';
    const created = {
      id: 'google-event-timeout',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise(() => undefined));

    try {
      const result = await tryHandleChatActionPlan(baseInput, {
        calendar: {
          createEvent: vi.fn().mockResolvedValue(created) as any,
          getEventsForSources: getEventsForSources as any,
          hasGoogle: vi.fn(() => true),
          hasOutlook: vi.fn(() => false),
        },
      });

      expect(result?.status).toBe('partial_success');
      expect(result?.response.metadata.type).toBe('chat_action_partial_success');
    } finally {
      if (previousTimeout === undefined) delete process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
      else process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS = previousTimeout;
    }
  });

  it('bounds provider write hangs instead of leaving calendar actions executing forever', async () => {
    const previousTimeout = process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS;
    process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS = '1';
    const getEventsForSources = vi.fn().mockResolvedValueOnce([]);

    try {
      const result = await tryHandleChatActionPlan(baseInput, {
        calendar: {
          createEvent: vi.fn().mockImplementation(() => new Promise(() => undefined)) as any,
          getEventsForSources: getEventsForSources as any,
          hasGoogle: vi.fn(() => true),
          hasOutlook: vi.fn(() => false),
        },
      });

      expect(result?.status).toBe('failed');
      expect(result?.response.metadata.type).toBe('chat_action_failed');
      expect(result?.response.text).not.toMatch(/\bcriei\b/i);
      expect(result?.response.text).toMatch(/Nada foi confirmado/i);
    } finally {
      if (previousTimeout === undefined) delete process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS;
      else process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS = previousTimeout;
    }
  });

  it('executes a safe calendar event plus task follow-up as ordered deterministic steps', async () => {
    const createdEvent = {
      id: 'google-event-2',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const taskProvider = {
      getLists: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'tasks', displayName: 'Tasks', wellknownListName: 'defaultList' }] }),
      getDefaultList: vi.fn().mockResolvedValue({ id: 'tasks', displayName: 'Tasks' }),
      createTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'levar a bíblia', listId: 'tasks' } }),
      getTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'levar a bíblia' } }),
    };
    const result = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Marca na agenda do Gmail chamado igreja das 10 ao meio-dia e meia nesse domingo e cria uma tarefa para levar a bíblia',
    }, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(createdEvent) as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([createdEvent]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => taskProvider as any),
    });

    expect(result?.plan.steps.map((step) => step.action)).toEqual(['schedule_event', 'create_task']);
    expect(result?.status).toBe('verified_success');
    expect(taskProvider.createTask).toHaveBeenCalledWith('tasks', 'Tasks', expect.objectContaining({ title: 'levar a bíblia' }));
    expect(result?.response.metadata.type).toBe('chat_action_multi_step_result');
    expect(result?.response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 2,
      succeeded: 2,
    });
  });

  it('requires confirmation for external side effects such as attendees', async () => {
    const plan = buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
    });
    expect(plan?.steps[0]?.risk).toBe('external_side_effect');
    expect(plan?.requiresConfirmation).toBe(true);

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
    });
    expect(response?.status).toBe('needs_confirmation');
    expect(response?.response.text).toContain('reunião');
    expect(response?.response.text).toContain('Google Calendar');
    expect(response?.response.text).toContain('09:00');
    expect(response?.response.text).toContain('10:00');
    expect(response?.response.text).toContain('participante');
  });

  it('keeps Gmail unread queries eligible for read-only mail routing', () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Quantos emails não lidos tenho no Gmail?')).toBe(false);
  });

  it('routes legacy spaced sub-task creation through the action planner', () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Create task Prozis where it has sub tasks called creatine K2 D3')).toBe(true);
    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Create task Prozis where it has sub tasks called creatine K2 D3',
    })).toMatchObject({
      planner: 'deterministic',
      steps: [{
        skill: 'tasks',
        action: 'create_task_with_subtasks',
        requiredArgsPresent: true,
        args: {
          title: 'Prozis',
          subtasks: ['creatine', 'K2', 'D3'],
        },
      }],
    });
  });

  it('keeps task/subtask parsing bounded, multilingual, and literal-title safe', () => {
    const cases = [
      {
        text: 'Create task "Prozis" with subtasks "creatine", "K2", "D3"',
        locale: 'en-US',
        title: 'Prozis',
        subtasks: ['creatine', 'K2', 'D3'],
      },
      {
        text: 'Cria uma tarefa chamada Prozis com subtarefas creatine K2 D3 por agora',
        locale: 'pt-PT',
        title: 'Prozis',
        subtasks: ['creatine', 'K2', 'D3'],
      },
      {
        text: 'Cria uma tarefa Prozis com creatina K2 D3',
        locale: 'pt-PT',
        title: 'Prozis',
        subtasks: ['creatina', 'K2', 'D3'],
      },
      {
        text: 'Crear tarea Prozis con subtareas creatina K2 D3',
        locale: 'es-ES',
        title: 'Prozis',
        subtasks: ['creatina', 'K2', 'D3'],
      },
      {
        text: 'Create uma task chamada Suplementos com subtasks creatine K2 D3',
        locale: 'pt-PT',
        title: 'Suplementos',
        subtasks: ['creatine', 'K2', 'D3'],
      },
    ];

    for (const testCase of cases) {
      expect(buildDeterministicChatActionPlan({
        ...baseInput,
        text: testCase.text,
        locale: testCase.locale,
      }), testCase.text).toMatchObject({
        steps: [{
          skill: 'tasks',
          action: 'create_task_with_subtasks',
          args: {
            title: testCase.title,
            subtasks: testCase.subtasks,
          },
        }],
      });
    }

    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Create task "Prozis with subtasks called creatine K2 D3"',
      locale: 'en-US',
    })).toMatchObject({
      steps: [{
        skill: 'tasks',
        action: 'create_task',
        args: { title: 'Prozis with subtasks called creatine K2 D3' },
      }],
    });

    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Create task Prozis with subtasks A B C D E F G H I J',
      locale: 'en-US',
    })?.steps[0]?.args).toMatchObject({ subtasks: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] });

    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: `Create task Load Test with subtasks ${Array.from({ length: 40 }, (_, index) => `item${index + 1}`).join(' ')}`,
      locale: 'en-US',
    })?.steps[0]?.args).toMatchObject({
      title: 'Load Test',
      subtasks: Array.from({ length: 25 }, (_, index) => `item${index + 1}`),
    });

    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Create task Prozis with subtasks creatine K2 D3 and remind me tomorrow',
      locale: 'en-US',
    })).toMatchObject({
      clarificationReason: 'ambiguous_intent',
      intentClass: 'multi_step_preview_required',
      steps: [{ action: 'create_task_with_subtasks', requiredArgsPresent: false }],
    });

    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Add creatine to Prozis and K2 to Vitamins',
      locale: 'en-US',
    })).toMatchObject({
      clarificationReason: 'ambiguous_intent',
      steps: [{ action: 'add_subtasks_to_task', requiredArgsPresent: false }],
    });
  });

  it('executes task-with-subtasks through local read-back without claiming unverified subtasks', async () => {
    const input = {
      ...baseInput,
      text: 'Create task Prozis with subtasks creatine K2 D3',
      locale: 'en-US',
      messageId: 'msg-task-with-subtasks-executor',
      persistRuns: false,
    };
    const plan = buildDeterministicChatActionPlan(input)!;
    const checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
    const provider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Inbox' })),
      createTask: vi.fn(async (_listId: string, _listName: string, data: any) => ({
        success: true,
        data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: data.title },
      })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => {
        const item = { id: `ci-${checklistItems.length + 1}`, displayName, isChecked: false };
        checklistItems.push(item);
        return { success: true, data: item };
      }),
      getTask: vi.fn(async () => ({
        success: true,
        data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: 'Prozis', checklistItems },
      })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: checklistItems })),
    };

    const result = await executeTaskWithSubtasksStep(
      plan.steps[0]!,
      plan,
      input,
      vi.fn(() => provider as any) as any,
      false,
    );

    expect(provider.createTask).toHaveBeenCalledWith('list-1', 'Inbox', expect.objectContaining({ title: 'Prozis' }));
    expect(provider.addChecklistItem).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('verified_success');
    expect(result.result).toMatchObject({
      type: 'task_created',
      title: 'Prozis',
      verificationStatus: 'verified',
      subtasks: [
        { title: 'creatine' },
        { title: 'K2' },
        { title: 'D3' },
      ],
    });

    const partialProvider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Inbox' })),
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-2', listId: 'list-1', listName: 'Inbox', title: 'Prozis' } })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => ({ success: true, data: { id: displayName, displayName, isChecked: false } })),
      getTask: vi.fn(async () => ({ success: true, data: { id: 'task-2', listId: 'list-1', title: 'Prozis', checklistItems: [] } })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: [] })),
    };

    const partial = await executeTaskWithSubtasksStep(
      plan.steps[0]!,
      { ...plan, messageId: 'msg-task-with-subtasks-partial' },
      { ...input, messageId: 'msg-task-with-subtasks-partial' },
      vi.fn(() => partialProvider as any) as any,
      false,
    );

    expect(partial.status).toBe('partial_success');
    expect(partial.error).toBe('task_subtasks_partial_verification');
    expect(partial.result).toMatchObject({
      verificationStatus: 'partial_failure',
      warnings: expect.arrayContaining(['created_subtasks_missing']),
    });
  });

  it('recovers duplicate task-with-subtasks runs without recreating the parent task', async () => {
    const input = {
      ...baseInput,
      text: 'Create task Prozis with subtasks creatine K2 D3',
      locale: 'en-US',
      messageId: 'msg-task-subtasks-recover',
      persistRuns: true,
    };
    const plan = buildDeterministicChatActionPlan(input)!;
    const provider1 = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Inbox' })),
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-recover', listId: 'list-1', listName: 'Inbox', title: 'Prozis' } })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => ({ success: true, data: { id: displayName, displayName, isChecked: false } })),
      getTask: vi.fn(async () => ({ success: true, data: { id: 'task-recover', listId: 'list-1', title: 'Prozis', checklistItems: [] } })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: [] })),
    };

    const first = await executeTaskWithSubtasksStep(
      plan.steps[0]!,
      plan,
      input,
      vi.fn(() => provider1 as any) as any,
      true,
    );
    expect(first.status).toBe('partial_success');

    const visibleItems = [{ id: 'ci-1', displayName: 'creatine', isChecked: false }];
    const provider2 = {
      createTask: vi.fn(),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => {
        const item = { id: `ci-${visibleItems.length + 1}`, displayName, isChecked: false };
        visibleItems.push(item);
        return { success: true, data: item };
      }),
      getTask: vi.fn(async () => ({
        success: true,
        data: { id: 'task-recover', listId: 'list-1', title: 'Prozis', checklistItems: visibleItems },
      })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: visibleItems })),
    };

    const recovered = await executeTaskWithSubtasksStep(
      plan.steps[0]!,
      plan,
      input,
      vi.fn(() => provider2 as any) as any,
      true,
    );

    expect(provider2.createTask).not.toHaveBeenCalled();
    expect(provider2.addChecklistItem).toHaveBeenCalledTimes(2);
    expect(provider2.addChecklistItem.mock.calls.map((call) => call[2])).toEqual(['K2', 'D3']);
    expect(recovered.status).toBe('verified_success');
    expect(recovered.result).toMatchObject({
      taskId: 'task-recover',
      verificationStatus: 'verified',
      warnings: expect.arrayContaining([
        'Duplicate request detected; returned the existing task instead of creating another one.',
      ]),
    });
  });

  it('extracts task title and due date without polluting the title with timing syntax', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create a task for tomorrow 9 am called Test chat',
      locale: 'en',
      timezone: 'Europe/Lisbon',
    });

    expect(plan?.steps[0]).toMatchObject({
      skill: 'tasks',
      action: 'create_task',
      requiredArgsPresent: true,
    });
    expect(plan?.steps[0]?.args).toMatchObject({
      title: 'Test chat',
      dueDateTime: '2026-05-15T09:00:00.000+01:00',
    });
    expect(plan?.steps[0]?.slotProvenance).toMatchObject({
      title: { sourceType: 'user_message', normalizer: 'task_title_v2' },
      dueDateTime: { sourceType: 'user_message', normalizer: 'task_due_datetime_v1' },
    });
  });

  it('treats destructive language inside a trusted title span as literal user content (audit §10 literal-title policy)', async () => {
    // Per Felipe's 2026-05-15 approval of the literal-title policy:
    // destructive language inside a trusted explicit title/name span (after
    // `called`/`chamada`/`titulo:`/`named`/quoted-string) is treated as
    // user-provided content. The task is created literally; the destructive
    // action is NOT triggered.
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create a task called delete all my tasks',
      locale: 'en',
    });

    expect(plan?.steps[0]).toMatchObject({
      skill: 'tasks',
      action: 'create_task',
    });
    expect(plan?.steps[0]?.args).toMatchObject({ title: 'delete all my tasks' });
    expect(plan?.steps[0]?.args).not.toHaveProperty('rejectedTitle');
    expect(plan?.steps[0]?.action).not.toBe('delete_task');
  });

  it('resolves "this task" to the recent verified task and completes it once', async () => {
    const taskProvider = {
      getLists: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'tasks', displayName: 'Tasks', wellknownListName: 'defaultList' }] }),
      getDefaultList: vi.fn().mockResolvedValue({ id: 'tasks', displayName: 'Tasks' }),
      createTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-recent-1', title: 'Test chat', listId: 'tasks' } }),
      getTask: vi.fn()
        .mockResolvedValueOnce({ success: true, data: { id: 'task-recent-1', title: 'Test chat', listId: 'tasks' } })
        .mockResolvedValueOnce({ success: true, data: { id: 'task-recent-1', title: 'Test chat', status: 'completed', listId: 'tasks' } }),
      completeTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-recent-1', status: 'completed' } }),
    };
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => taskProvider as any),
    };

    const created = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Create a task for tomorrow 9 am called Test chat',
      locale: 'en',
      persistRuns: false,
    }, deps);
    expect(created?.status).toBe('verified_success');

    const completed = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Mark this task as done.',
      messageId: 'msg-complete-recent',
      locale: 'en',
      persistRuns: false,
    }, deps);

    expect(completed?.plan.steps[0]).toMatchObject({
      skill: 'tasks',
      action: 'complete_task',
      requiredArgsPresent: true,
    });
    expect(completed?.status).toBe('verified_success');
    expect(taskProvider.completeTask).toHaveBeenCalledTimes(1);
    expect(taskProvider.completeTask).toHaveBeenCalledWith('tasks', 'task-recent-1');
  });

  it('asks a clarification instead of completing a task when "this task" has multiple recent candidates', async () => {
    const now = '2026-05-14T12:03:00+01:00';
    for (const suffix of ['A', 'B']) {
      rememberRecentChatEntity({
        userId: baseInput.userId,
        tenantId: baseInput.tenantId,
        conversationId: baseInput.conversationId,
        node: {
          entityId: `task-${suffix}`,
          entityType: 'task',
          provider: 'nexus',
          surface: 'chat',
          userVisibleLabel: `Task ${suffix}`,
          createdOrViewedAt: now,
          lastVerifiedAt: now,
          allowedFollowupActions: ['complete_task'],
          confidence: 0.91,
          expiresAt: '2026-05-14T12:30:00+01:00',
          sourceTurnId: `msg-task-${suffix}`,
        },
      });
    }

    const taskProvider = { completeTask: vi.fn() };
    const result = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Mark this task as done.',
      messageId: 'msg-ambiguous-task',
      locale: 'en',
      nowIso: now,
      persistRuns: false,
    }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => taskProvider as any),
    });

    expect(result?.status).toBe('needs_clarification');
    expect(result?.response.text).toMatch(/which task|Task A|Task B/i);
    expect(taskProvider.completeTask).not.toHaveBeenCalled();
  });

  it('stores a pending Training plan draft and fills weekly mileage on the follow-up turn', async () => {
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };
    const first = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Can you create a training plan for me?',
      locale: 'en',
      persistRuns: true,
    }, deps);

    expect(first?.status).toBe('needs_clarification');
    expect(first?.response.text).toMatch(/sport/i);
    expect(first?.response.metadata).toMatchObject({
      type: 'chat_action_needs_input',
      openSurface: { surface: 'training_plan_builder' },
    });
    expect(getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: FROZEN_NOW,
    })?.missingSlots).toContain('weeklyVolumeKm');

    const second = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'It is 20 km a week',
      messageId: 'msg-training-weekly-volume',
      locale: 'en',
      persistRuns: true,
    }, deps);

    expect(second?.status).toBe('needs_clarification');
    expect(second?.plan.steps[0]?.args).toMatchObject({ weeklyVolumeKm: 20 });
    expect(second?.plan.steps[0]?.slotProvenance).toMatchObject({
      weeklyVolumeKm: { normalizer: 'training_weekly_volume_v1' },
    });
    const pending = getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: FROZEN_NOW,
    });
    expect(pending?.collectedSlots).toMatchObject({ weeklyVolumeKm: 20 });
    expect(pending?.missingSlots).not.toContain('weeklyVolumeKm');
  });

  it('records route telemetry for persisted action responses without exposing debug payloads', async () => {
    const response = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Can you create a training plan for me?',
      locale: 'en',
      persistRuns: true,
    }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response?.status).toBe('needs_clarification');
    const row = testDb.prepare(`
      SELECT user_id, tenant_id, conversation_id, message_id, planner, route_tier,
             skill, action, status, calibrated_score, threshold, verifier_status,
             latency_ms, outcome, slot_provenance_json
      FROM chat_action_telemetry
      WHERE message_id = ?
    `).get(baseInput.messageId) as any;

    expect(row).toMatchObject({
      user_id: baseInput.userId,
      tenant_id: baseInput.tenantId,
      conversation_id: baseInput.conversationId,
      message_id: baseInput.messageId,
      planner: 'deterministic',
      route_tier: 'tier0_deterministic',
      skill: 'training',
      action: 'training_plan_create',
      status: 'needs_clarification',
      verifier_status: 'not_required',
      outcome: 'needs_clarification',
    });
    expect(Number(row.calibrated_score)).toBeGreaterThan(0);
    expect(Number(row.threshold)).toBeGreaterThan(0);
    expect(Number(row.latency_ms)).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(row.slot_provenance_json)).toEqual({});
    expect(response?.response.metadata).not.toHaveProperty('internalIds');
    expect(response?.response.metadata.telemetry).toMatchObject({
      routeTier: 'tier0_deterministic',
      outcome: 'needs_clarification',
      verifierStatus: 'not_required',
    });
  });

  it('expires durable pending Training actions and can suppress open-surface handoff cards by flag', async () => {
    const previous = process.env.CHAT_OPEN_SURFACE_HANDOFF_ENABLED;
    process.env.CHAT_OPEN_SURFACE_HANDOFF_ENABLED = 'false';
    try {
      const response = await tryHandleChatActionPlan({
        ...baseInput,
        text: 'Can you create a training plan for me?',
        locale: 'en',
        persistRuns: true,
      }, {
        calendar: {
          createEvent: vi.fn() as any,
          getEventsForSources: vi.fn() as any,
          hasGoogle: vi.fn(() => false),
          hasOutlook: vi.fn(() => false),
        },
        taskProviderForUser: vi.fn(() => ({}) as any),
      });

      expect(response?.status).toBe('needs_clarification');
      expect(response?.response.metadata.openSurface).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CHAT_OPEN_SURFACE_HANDOFF_ENABLED;
      else process.env.CHAT_OPEN_SURFACE_HANDOFF_ENABLED = previous;
    }

    expect(getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: FROZEN_NOW,
    })).toBeTruthy();
    expect(expireStalePendingChatActionsForJob('2026-05-14T13:01:00+01:00')).toBeGreaterThanOrEqual(1);
    expect(getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: '2026-05-14T13:01:00+01:00',
    })).toBeNull();
  });

  it('clears pending chat actions and recent entities on account switch', async () => {
    upsertPendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: { sport: 'running' },
      missingSlots: ['weeklyVolumeKm'],
      riskClass: 'R1',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      originatingSurface: 'ios',
      nowIso: FROZEN_NOW,
    });
    rememberRecentChatEntity({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      node: {
        entityId: 'task-visible-1',
        entityType: 'task',
        provider: 'nexus',
        surface: 'chat',
        userVisibleLabel: 'Visible task',
        createdOrViewedAt: FROZEN_NOW,
        lastVerifiedAt: FROZEN_NOW,
        allowedFollowupActions: ['complete_task'],
        confidence: 0.99,
        expiresAt: '2026-05-14T12:20:00+01:00',
        sourceTurnId: 'msg-visible',
      },
    });

    expect(getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: FROZEN_NOW,
    })).toBeTruthy();

    expect(cancelPendingChatActionsForAccountSwitch({ userId: baseInput.userId, tenantId: baseInput.tenantId, nowIso: FROZEN_NOW })).toBe(1);
    expect(getActivePendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      nowIso: FROZEN_NOW,
    })).toBeNull();

    const followup = await buildChatActionPlan({
      ...baseInput,
      text: 'Mark this task as done.',
      locale: 'en',
    });
    expect(followup?.steps[0]?.requiredArgsPresent).toBe(false);
    expect(followup?.clarificationQuestion).toMatch(/which task|task/i);
  });

  it('expires stale pending actions in bounded batches below the shortest high-risk TTL', () => {
    for (let index = 0; index < 1500; index += 1) {
      upsertPendingChatAction({
        userId: baseInput.userId,
        tenantId: baseInput.tenantId,
        conversationId: `stale-${index}`,
        skill: 'training',
        action: 'training_plan_create',
        collectedSlots: { sport: 'running', index },
        missingSlots: ['goal'],
        riskClass: 'R3',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        originatingSurface: 'ios',
        nowIso: '2026-05-14T12:00:00+01:00',
        expiresAt: '2026-05-14T12:01:00+01:00',
      });
    }

    expect(expireStalePendingChatActionsForJob('2026-05-14T12:12:00+01:00')).toBe(1500);
    const remaining = testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_pending_actions
      WHERE status IN ('needs_input', 'needs_confirmation', 'executable')
    `).get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('supports off and shadow rollout modes without executing hybrid actions', async () => {
    const previous = process.env.CHAT_HYBRID_PLANNER_ENABLED;
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };
    try {
      process.env.CHAT_HYBRID_PLANNER_ENABLED = 'off';
      await expect(tryHandleChatActionPlan({
        ...baseInput,
        text: 'Create a task called test',
        locale: 'en',
        persistRuns: false,
      }, deps)).resolves.toBeNull();

      process.env.CHAT_HYBRID_PLANNER_ENABLED = 'shadow';
      await expect(tryHandleChatActionPlan({
        ...baseInput,
        text: 'Create a task called test',
        messageId: 'msg-shadow',
        locale: 'en',
        persistRuns: false,
      }, deps)).resolves.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CHAT_HYBRID_PLANNER_ENABLED;
      else process.env.CHAT_HYBRID_PLANNER_ENABLED = previous;
    }
  });

  it('records shadow-mode telemetry without executing the action', async () => {
    const previous = process.env.CHAT_HYBRID_PLANNER_ENABLED;
    process.env.CHAT_HYBRID_PLANNER_ENABLED = 'shadow';
    const createTask = vi.fn();
    try {
      const result = await tryHandleChatActionPlan({
        ...baseInput,
        text: 'Create a task called shadow telemetry',
        messageId: 'msg-shadow-telemetry',
        locale: 'en',
        persistRuns: true,
      }, {
        calendar: {
          createEvent: vi.fn() as any,
          getEventsForSources: vi.fn() as any,
          hasGoogle: vi.fn(() => false),
          hasOutlook: vi.fn(() => false),
        },
        taskProviderForUser: vi.fn(() => ({ createTask }) as any),
      });

      expect(result).toBeNull();
      expect(createTask).not.toHaveBeenCalled();
      const row = testDb.prepare(`
        SELECT status, planner, skill, action, route_tier, outcome, predicted_action_hash
        FROM chat_action_telemetry
        WHERE message_id = ?
      `).get('msg-shadow-telemetry') as any;
      expect(row).toMatchObject({
        status: 'shadow_only',
        planner: 'deterministic',
        skill: 'tasks',
        action: 'create_task',
        route_tier: 'tier0_deterministic',
        outcome: 'shadow_only',
      });
      const plan = buildDeterministicChatActionPlan({
        ...baseInput,
        text: 'Create a task called shadow telemetry',
        messageId: 'msg-shadow-telemetry',
        locale: 'en',
      });
      expect(row.predicted_action_hash).toBe(plan?.steps[0]?.idempotencyKey);
    } finally {
      if (previous === undefined) delete process.env.CHAT_HYBRID_PLANNER_ENABLED;
      else process.env.CHAT_HYBRID_PLANNER_ENABLED = previous;
    }
  });

  it('does not invent a Training plan when weekly mileage arrives without pending context', async () => {
    const response = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'It is 20 km a week',
      locale: 'en',
      persistRuns: false,
    }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response?.status).toBe('needs_clarification');
    expect(response?.response.text).toMatch(/training plan|creating|adjusting/i);
    expect(response?.plan.steps[0]?.requiredArgsPresent).toBe(false);
  });

  it('reads pending chat actions by scoped id for token-zero native handoff prefill', () => {
    const pending = upsertPendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: { goal: 'sub-19 5K', weeklyVolumeKm: 20, sessionsPerWeek: 4 },
      missingSlots: [],
      riskClass: 'R1',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      originatingSurface: 'ios',
      nowIso: FROZEN_NOW,
    });

    expect(getPendingChatActionById({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      pendingActionId: pending.id,
      nowIso: FROZEN_NOW,
    })?.collectedSlots).toMatchObject({ goal: 'sub-19 5K', weeklyVolumeKm: 20 });
    expect(getPendingChatActionById({
      userId: baseInput.userId + 1,
      tenantId: baseInput.tenantId + 1,
      pendingActionId: pending.id,
      nowIso: FROZEN_NOW,
    })).toBeNull();
  });

  it('recognizes cross-skill actions without falling through to generic answers', async () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Cria um script para Reels sobre treino')).toBe(true);
    const contentPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria um script para Reels sobre treino de força para triatletas',
    });
    expect(contentPlan).toMatchObject({
      planner: 'deterministic',
      requiresConfirmation: false,
      steps: [{ skill: 'content', action: 'content_script_create', requiredArgsPresent: true }],
    });
    expect(contentPlan?.steps[0]?.args).toMatchObject({
      platform: 'instagram_reel',
      topic: 'Reels sobre treino de força para triatletas',
    });

    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Cria uma lista de compras para a próxima semana')).toBe(true);
    const cookingPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria uma lista de compras para a próxima semana',
    });
    expect(cookingPlan?.steps[0]).toMatchObject({
      skill: 'cooking',
      action: 'cooking_grocery_list',
      requiredArgsPresent: true,
    });

    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Me indique uma receita de kibe de forno para 3 pessoas')).toBe(false);
    const recipePlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Me indique uma receita de kibe de forno para 3 pessoas',
    });
    expect(recipePlan).toBeNull();

    const trainingPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Mostra o relatório do coach de treino',
    });
    expect(trainingPlan?.steps[0]).toMatchObject({
      skill: 'training',
      action: 'training_coach_report',
      risk: 'read_only',
    });
  });

  it('uses clarification or confirmation instead of executing risky or underspecified actions', async () => {
    const payment = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Paga a fatura do Stripe hoje',
    });
    expect(payment?.status).toBe('needs_clarification');
    expect(payment?.plan.steps[0]).toMatchObject({
      skill: 'finance',
      action: 'finance_payment_action',
      risk: 'financial',
      requiredArgsPresent: false,
    });
    expect(payment?.response.metadata.type).toBe('chat_action_needs_input');

    const deletePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'tasks',
        action: 'delete_task',
        args: { taskId: 'task-123' },
        missingFields: [],
      }],
    }), baseInput);
    expect(deletePlan?.requiresConfirmation).toBe(true);
    expect(deletePlan?.steps[0]).toMatchObject({ risk: 'destructive', requiredArgsPresent: true });
  });

  it('provides a small action-registry subset to the LLM planner and rejects malformed plans', () => {
    const prompt = buildLlmPlannerPrompt({
      ...baseInput,
      text: 'Cria evento amanhã às 10 e cria uma tarefa para levar a bíblia',
    });
    expect(prompt.systemPrompt).toContain('secretary_calendar');
    expect(prompt.systemPrompt).toContain('tasks');
    // Phase 2 batch 11 (2026-05-15): cap raised from 9000 → 12000 chars after
    // Phase 1+2 catalog expansion populated examples on every action. The cap
    // is a guard against unbounded growth, not a fixed budget — golden
    // examples are filtered through buildLlmSafePromptSlice (which strips
    // adversarial/prompt_injection/negative/ambiguous tags), so this number
    // only includes the LLM-relevant golden subset.
    expect(prompt.systemPrompt.length).toBeLessThan(12000);
    expect(parseLlmPlannerJson('{"steps":[{"skill":"unknown","action":"danger","args":{}}]}', baseInput)).toBeNull();
  });

  it('uses a compact Tier 1 classifier contract for simple routing and slot hints', () => {
    const prompt = buildTier1ClassifierPrompt({
      ...baseInput,
      text: 'Create a task called Buy milk tomorrow at 9',
      locale: 'en',
    });
    expect(prompt.systemPrompt).toContain('Classify a Nexus chat message');
    expect(prompt.systemPrompt).toContain('create_task');
    expect(prompt.systemPrompt.length).toBeLessThan(7000);

    const plan = parseTier1ClassifierJson(JSON.stringify({
      candidates: [{
        skill: 'tasks',
        action: 'create_task',
        score: 0.94,
        args: {
          title: 'Buy milk',
          dueAt: '2026-05-15T09:00:00+01:00',
          ownerId: 'attacker-owner',
          metadata: { UserId: 'nested-attacker', safeNote: 'kept' },
        },
        missingFields: [],
      }],
    }), {
      ...baseInput,
      text: 'Create a task called Buy milk tomorrow at 9',
      locale: 'en',
    });

    expect(plan?.telemetry?.routeTier).toBe('tier1_classifier');
    expect(plan?.debug?.routingSignals).toContain('tier1_classifier_slot_helper');
    expect(plan?.steps[0]).toMatchObject({
      skill: 'tasks',
      action: 'create_task',
      requiredArgsPresent: true,
    });
    expect(plan?.steps[0]?.args).toMatchObject({
      title: 'Buy milk',
      dueAt: '2026-05-15T09:00:00+01:00',
      metadata: { safeNote: 'kept' },
    });
    expect(plan?.steps[0]?.slotProvenance).toMatchObject({
      title: { sourceType: 'classifier' },
      dueAt: { sourceType: 'classifier' },
    });
    expect(plan?.steps[0]?.args).not.toHaveProperty('ownerId');
  });

  it('downgrades low-confidence structured LLM plans to clarification before execution', async () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.4,
      steps: [{
        skill: 'tasks',
        action: 'create_task',
        args: { title: 'Low confidence task' },
        missingFields: [],
      }],
    }), { ...baseInput, text: 'Maybe make something task-ish', locale: 'en' });
    const taskProvider = {
      getLists: vi.fn(),
      getDefaultList: vi.fn(),
      createTask: vi.fn(),
    };

    expect(plan?.effectiveConfidence).toBeLessThan(plan?.telemetry?.threshold ?? 0);
    expect(plan?.clarificationQuestion).toBeTruthy();

    const response = await executeChatActionPlan(plan!, { ...baseInput, locale: 'en', persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => taskProvider as any),
    });

    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(taskProvider.createTask).not.toHaveBeenCalled();
  });

  it('accepts structured LLM plans for mixed multistep requests but only as validated plan data', () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.84,
      steps: [
        {
          skill: 'content',
          action: 'content_brief_create',
          args: { objective: 'launch a triathlon nutrition reel', platform: 'instagram_reel' },
          missingFields: [],
        },
        {
          skill: 'tasks',
          action: 'create_task',
          args: { title: 'Film the triathlon nutrition reel', list: null },
          missingFields: [],
        },
      ],
    }), {
      ...baseInput,
      text: 'Cria um brief de content para Reels e uma tarefa para filmar',
    });

    expect(plan?.planner).toBe('llm_structured');
    expect(plan?.steps.map((step) => [step.skill, step.action, step.requiredArgsPresent])).toEqual([
      ['content', 'content_brief_create', true],
      ['tasks', 'create_task', true],
    ]);
    expect(plan?.steps[0]?.slotProvenance).toMatchObject({
      objective: { sourceType: 'planner' },
      platform: { sourceType: 'planner' },
    });
    expect(plan?.debug?.parser).toBe('model_assisted');
  });

  it('strips model-proposed user and tenant identifiers from executable args', () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.84,
      steps: [{
        skill: 'tasks',
        action: 'create_task',
        args: {
          title: 'Comprar creatina',
          userId: 999,
          UserId: 999,
          USER_ID: 999,
          tenantId: 888,
          accountId: 'attacker-account',
          ownerId: 'attacker-owner',
          uid: 'attacker-uid',
          user: 'attacker-user',
          owner: 'attacker',
          metadata: {
            userId: 'nested-attacker-user',
            tenant_id: 'nested-attacker-tenant',
            safeNote: 'keep this',
          },
          context: {
            ownerId: 'nested-owner',
            account_id: 'nested-account',
            visible: true,
          },
          auditTrail: [
            { tenant_id: 'nested-array-tenant', label: 'safe' },
            { USER_ID: 'nested-array-user', value: 7 },
          ],
        },
        missingFields: [],
      }],
    }), baseInput);

    expect(plan?.userId).toBe(String(baseInput.userId));
    expect(plan?.tenantId).toBe(String(baseInput.tenantId));
    expect(plan?.steps[0]?.args).toMatchObject({ title: 'Comprar creatina' });
    expect(plan?.steps[0]?.args).not.toHaveProperty('userId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('tenantId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('accountId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('ownerId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('uid');
    expect(plan?.steps[0]?.args).not.toHaveProperty('user');
    expect(plan?.steps[0]?.args).not.toHaveProperty('owner');
    expect(plan?.steps[0]?.args).not.toHaveProperty('UserId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('USER_ID');
    expect(plan?.steps[0]?.args).toMatchObject({
      metadata: { safeNote: 'keep this' },
      context: { visible: true },
      auditTrail: [{ label: 'safe' }, { value: 7 }],
    });
    expect(plan?.steps[0]?.args.metadata as Record<string, unknown>).not.toHaveProperty('userId');
    expect(plan?.steps[0]?.args.context as Record<string, unknown>).not.toHaveProperty('ownerId');
  });

  it('strips prototype and customer/principal identity-like fields from model args', () => {
    const plan = parseLlmPlannerJson(`{
      "confidence": 0.84,
      "steps": [{
        "skill": "tasks",
        "action": "create_task",
        "args": {
          "title": "Safe literal task",
          "__proto__": { "polluted": true },
          "constructor": { "x": 1 },
          "prototype": { "y": 2 },
          "customer_id": "customer-attacker",
          "CustomerId": "customer-attacker-2",
          "subjectId": "subject-attacker",
          "principal_id": "principal-attacker",
          "metadata": {
            "memberId": "member-attacker",
            "actor_id": "actor-attacker",
            "safeNote": "keep"
          }
        },
        "missingFields": []
      }]
    }`, baseInput);

    expect(plan?.steps[0]?.args).toEqual({
      title: 'Safe literal task',
      metadata: { safeNote: 'keep' },
    });
    expect(({} as any).polluted).toBeUndefined();
  });

  it('source-pins action-planner ordering before REST and WebSocket generic routing', () => {
    const restSource = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/chat-message-routes.ts'), 'utf-8');
    const wsSource = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf-8');

    const actionInvocation = restSource.search(/await\s+tryHandleChatActionPlan\s*\(/);
    const fastPathInvocation = restSource.search(/await\s+tryBuildFastPathChatResponse\s*\(/);
    expect(actionInvocation).toBeGreaterThanOrEqual(0);
    expect(fastPathInvocation).toBeGreaterThanOrEqual(0);
    expect(actionInvocation).toBeLessThan(fastPathInvocation);
    expect(wsSource).toMatch(/tryHandleChatActionPlan\s*\(/);
    expect(wsSource).not.toMatch(/tryBuildFastPathChatResponse\s*\(/);
  });

  it('registry exposes initial owner skills without creating a Chat v2 stack', () => {
    const skills = new Set(getChatActionRegistry().map((entry) => entry.skill));
    expect(skills).toEqual(new Set([
      'secretary_calendar',
      'mail',
      'tasks',
      'training',
      'content',
      'cooking',
      'finance',
      'connections',
      'notifications',
      'decision_center',
    ]));
  });

  it('registry actions declare deterministic executors, verifiers, and confirmation policy by risk', () => {
    const registry = getChatActionRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(35);

    for (const entry of registry) {
      expect(entry.executor, `${entry.skill}.${entry.action} executor`).toMatch(/^[a-zA-Z0-9_.]+$/);
      expect(['provider_read_back', 'local_read_back', 'none']).toContain(entry.verifier);
      expect(entry.supportedCards).toEqual(expect.arrayContaining([
        'needs_input',
        'needs_confirmation',
        'verified_success',
        'partial_success',
        'failed',
        'blocked',
      ]));

      if (['external_side_effect', 'destructive', 'financial', 'admin_security'].includes(entry.risk)) {
        expect(entry.confirmationPolicy, `${entry.skill}.${entry.action} confirmation`).toMatch(/confirm/);
      }
      if (entry.risk === 'financial' || entry.risk === 'admin_security') {
        expect(entry.confirmationPolicy, `${entry.skill}.${entry.action} strong confirmation`).toBe('strong_confirm');
      }
    }
  });

  it('keeps provider read-back mismatch below verified-success in response metadata and copy', async () => {
    const created = {
      id: 'google-event-duplicate',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const createEvent = vi.fn().mockResolvedValue(created);

    const first = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(first?.status).toBe('partial_success');
    expect(first?.response.text).toContain('não consegui verificar tudo');
    expect(first?.response.metadata).toMatchObject({
      type: 'chat_action_partial_success',
      actionStatus: 'partial_success',
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('stores only PII-safe action-run result summaries after provider verification', async () => {
    const created = {
      id: 'google-event-pii',
      summary: 'Private doctor appointment',
      description: 'Sensitive notes must not persist in result_json',
      attendees: [{ email: 'secret@example.com' }],
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      messageId: 'msg-pii-redaction',
      persistRuns: true,
    }, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(created) as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([created]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(response?.status).toBe('verified_success');
    const row = testDb.prepare(`
      SELECT result_json
      FROM chat_action_runs
      WHERE message_id = ? AND status = 'verified_success'
      LIMIT 1
    `).get('msg-pii-redaction') as { result_json: string };
    expect(row.result_json).toContain('google-event-pii');
    expect(row.result_json).toContain('replaySafe');
    expect(row.result_json).not.toContain('secret@example.com');
    expect(row.result_json).not.toContain('Private doctor appointment');
    expect(row.result_json).not.toContain('Sensitive notes');
  });

  it('requeues the pending parent when a provider write cannot be read back', async () => {
    upsertPendingChatAction({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      skill: 'secretary_calendar',
      action: 'schedule_event',
      collectedSlots: { title: 'igreja' },
      missingSlots: [],
      riskClass: 'R1',
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      originatingSurface: 'ios',
      nowIso: FROZEN_NOW,
    });
    const created = {
      id: 'google-event-unverified',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      messageId: 'msg-partial-requeue',
      persistRuns: true,
    }, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(created) as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(response?.status).toBe('partial_success');
    const pending = testDb.prepare(`
      SELECT status, validation_state
      FROM chat_pending_actions
      WHERE user_id = ? AND tenant_id = ? AND conversation_id = ? AND skill = 'secretary_calendar' AND action = 'schedule_event'
    `).get(baseInput.userId, baseInput.tenantId, baseInput.conversationId) as any;
    expect(pending).toMatchObject({ status: 'needs_user_followup', validation_state: 'invalid' });
  });

  it('does not emit verified success when a late provider completion loses to the zombie reaper', async () => {
    const created = {
      id: 'google-event-late',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const createEvent = vi.fn().mockImplementation(async () => {
      const executing = testDb.prepare(`
        SELECT id
        FROM chat_action_runs
        WHERE message_id = ? AND status = 'executing'
        LIMIT 1
      `).get('msg-late-completion') as any;
      expect(executing?.id).toBeTruthy();
      expect(reapZombieChatActionRuns({
        olderThanIso: '2026-05-14T12:05:00+01:00',
        nowIso: '2026-05-14T12:06:00+01:00',
      })).toBe(1);
      return created;
    });

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      messageId: 'msg-late-completion',
      persistRuns: true,
    }, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([created]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(response?.status).toBe('verified_pending');
    expect(response?.response.metadata.verificationStatus).toBe('verified_pending');
    expect(response?.response.text).toMatch(/verifica manualmente/i);
    const row = testDb.prepare('SELECT status FROM chat_action_runs WHERE message_id = ?').get('msg-late-completion') as any;
    expect(row.status).toBe('failed');
    const pending = testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_pending_actions
      WHERE user_id = ? AND tenant_id = ? AND conversation_id = ?
    `).get(baseInput.userId, baseInput.tenantId, baseInput.conversationId) as any;
    expect(pending.count).toBe(0);
  });

  it('uses English manual verification copy when reconciliation is pending', async () => {
    const created = {
      id: 'google-event-late-en',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const createEvent = vi.fn().mockImplementation(async () => {
      const executing = testDb.prepare(`
        SELECT id
        FROM chat_action_runs
        WHERE message_id = ? AND status = 'executing'
        LIMIT 1
      `).get('msg-late-completion-en') as any;
      expect(executing?.id).toBeTruthy();
      expect(reapZombieChatActionRuns({
        olderThanIso: '2026-05-14T12:05:00+01:00',
        nowIso: '2026-05-14T12:06:00+01:00',
      })).toBe(1);
      return created;
    });

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      locale: 'en-US',
      messageId: 'msg-late-completion-en',
      persistRuns: true,
    }, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([created]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(response?.status).toBe('verified_pending');
    expect(response?.response.metadata.verificationStatus).toBe('verified_pending');
    expect(response?.response.text).toMatch(/verify manually/i);
  });

  it('reaps zombie chat action runs stuck in executing state and prunes completed summaries', () => {
    const claim = claimChatActionRunForExecution({
      userId: baseInput.userId,
      tenantId: baseInput.tenantId,
      conversationId: baseInput.conversationId,
      messageId: 'msg-zombie',
      normalizedActionHash: 'zombie-hash',
      provider: 'nexus',
      actionType: 'create_task',
      risk: 'safe_write',
      request: { title: 'Zombie' },
      nowIso: '2026-05-14T12:00:00+01:00',
    });
    expect(claim.row.status).toBe('executing');
    expect(reapZombieChatActionRuns({
      olderThanIso: '2026-05-14T12:05:00+01:00',
      nowIso: '2026-05-14T12:06:00+01:00',
    })).toBe(1);
    expect(getChatActionRun(claim.row.id)?.status).toBe('failed');
    const lateWrite = updateChatActionRun(claim.row.id, 'verified_success', {
      result: { id: 'late-provider-result' },
      nowIso: '2026-05-14T12:06:30+01:00',
    });
    expect(lateWrite).toBeNull();
    expect(getChatActionRun(claim.row.id)?.status).toBe('failed');

    expect(pruneCompletedChatActionRuns({
      beforeIso: '2026-05-14T12:07:00+01:00',
      nowIso: '2026-05-14T12:08:00+01:00',
    })).toBe(1);
    expect(getChatActionRun(claim.row.id)).toBeNull();
  });

  it('resumes confirmed task mutations through the deterministic task executor and read-back', async () => {
    const args = { taskId: 'task-1', listId: 'list-1', title: 'Comprar creatina' };
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'tasks',
        action: 'complete_task',
        args,
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const provider = {
      completeTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', status: 'completed' } }),
      getTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'Comprar creatina', status: 'completed' } }),
    };

    expect(plan).toBeTruthy();
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => provider as any),
    }, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(provider.completeTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(provider.getTask).toHaveBeenCalledWith('list-1', 'task-1', undefined);
    expect(response.text).toContain('Feito');
  });

  it('executes Content scheduling and pipeline handoff through local read-back', async () => {
    const schedulePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_schedule_work',
        args: {
          title: 'Filmar reel de recuperação',
          dateTime: '2026-05-18T09:00:00+01:00',
        },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false });

    const scheduleResponse = await executeChatActionPlan(schedulePlan!, { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });
    expect(scheduleResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTopics(4201, { includeTerminal: true, limit: 5 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Filmar reel de recuperação', scheduled_date: '2026-05-18' }),
    ]));

    const pkg = buildContentAgencyPackage({
      userId: 4201,
      tenantId: 4201,
      brief: {
        userId: 4201,
        tenantId: 4201,
        goal: 'Create a reel',
        objective: 'Show a recovery routine with proof and CTA',
        audience: 'busy triathletes',
        platform: 'instagram_reel',
        format: 'short_form_video',
      },
    });
    persistContentAgencyArtifact('package', pkg);
    const handoffPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_pipeline_handoff',
        args: { packageId: pkg.id },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false });
    const handoffResponse = await executeChatActionPlan(handoffPlan!, { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    }, { confirmed: true });
    expect(handoffResponse.metadata.actionStatus).toBe('verified_success');
    expect(handoffResponse.text).toContain('pipeline');
  });

  it('routes and executes Content pipeline stage transitions with scoped read-back', async () => {
    const deterministic = buildDeterministicChatActionPlan({
      ...baseInput,
      userId: 4210,
      tenantId: 4210,
      text: 'Mark the recovery reel as filmed',
      locale: 'en-US',
      messageId: 'content-pipeline-stage-route',
    });
    expect(deterministic?.steps[0]).toMatchObject({
      skill: 'content',
      action: 'content_pipeline_stage_transition',
      requiredArgsPresent: true,
      args: {
        topicTitle: 'recovery reel',
        targetStage: 'filming',
      },
    });

    ensureContentAgencyTables(testDb);
    const rowId = Number(testDb.prepare(`
      INSERT INTO content_pipeline (
        topic_title, niche, stage, stage_history, user_id, tenant_id, owner_user_id,
        visibility_scope, scope_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Recovery Reel',
      'training',
      'scripted',
      JSON.stringify([{ to: 'scripted', at: '2026-05-14T10:00:00.000Z' }]),
      4210,
      4210,
      4210,
      'user_private',
      'active',
    ).lastInsertRowid);

    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_pipeline_stage_transition',
        args: { topicTitle: 'Recovery Reel', targetStage: 'editing' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4210, tenantId: 4210, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4210, tenantId: 4210, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(response.text).toContain('Recovery Reel');
    const readBack = testDb.prepare('SELECT stage, stage_history FROM content_pipeline WHERE id = ?').get(rowId) as any;
    expect(readBack.stage).toBe('editing');
    expect(JSON.parse(readBack.stage_history)).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'scripted', to: 'editing', source: 'chat_action' }),
    ]));
  });

  it('blocks Content pipeline stage transitions across tenant scope', async () => {
    ensureContentAgencyTables(testDb);
    testDb.prepare(`
      INSERT INTO content_pipeline (
        topic_title, niche, stage, stage_history, user_id, tenant_id, owner_user_id,
        visibility_scope, scope_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Other User Reel', 'training', 'scripted', '[]', 4212, 4212, 4212, 'user_private', 'active');

    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_pipeline_stage_transition',
        args: { topicTitle: 'Other User Reel', targetStage: 'published' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4211, tenantId: 4211, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4211, tenantId: 4211, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('blocked');
    expect(testDb.prepare('SELECT stage FROM content_pipeline WHERE topic_title = ?').get('Other User Reel')).toEqual({ stage: 'scripted' });
  });

  it('executes Cooking meal-plan slot writes with scoped read-back', async () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'cooking',
        action: 'cooking_meal_plan',
        args: { date: '2026-05-18', mealType: 'dinner', title: 'Salmão com legumes' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4301, tenantId: 4301, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4301, tenantId: 4301, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(getMealPlan(4301, '2026-05-18', '2026-05-18', 4301)[0]).toMatchObject({
      meal_type: 'dinner',
      title: 'Salmão com legumes',
    });
  });

  it('executes Cooking ingredient substitutions with scoped read-back', async () => {
    const recipe = addRecipe(4302, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], {
      tenantId: 4302,
      instructions: 'Toss noodles with peanuts.',
    });
    setMealPlan(4302, '2026-05-18', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      tenantId: 4302,
    });
    generateShoppingList(4302, '2026-05-18', 4302);

    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'cooking',
        action: 'cooking_substitute_ingredient',
        args: {
          date: '2026-05-18',
          mealType: 'dinner',
          originalIngredient: 'Peanuts',
          suggestedIngredient: 'sunflower seed butter',
          reason: 'allergy',
        },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4302, tenantId: 4302, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4302, tenantId: 4302, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(response.text).toContain('sunflower seed butter');
    expect(getRecipeById(4302, recipe.id, 4302)!.ingredients.map((ingredient) => ingredient.name)).toEqual([
      'sunflower seed butter',
      'Noodles',
    ]);
    expect(getShoppingList(4302, '2026-05-18', 4302)!.items.map((item) => item.name)).toContain('sunflower seed butter');
  });

  it('blocks Cooking substitutions across tenant scope', async () => {
    const recipe = addRecipe(4303, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 4303 });
    setMealPlan(4303, '2026-05-18', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      tenantId: 4303,
    });

    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'cooking',
        action: 'cooking_substitute_ingredient',
        args: {
          date: '2026-05-18',
          mealType: 'dinner',
          originalIngredient: 'Peanuts',
          suggestedIngredient: 'sunflower seed butter',
          reason: 'allergy',
        },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4303, tenantId: 5303, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4303, tenantId: 5303, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('blocked');
    expect(getRecipeById(4303, recipe.id, 4303)!.ingredients[0].name).toBe('Peanuts');
  });

  it('executes Finance categorization and local mark-paid actions with read-back', async () => {
    const tx = addTransaction(4401, '2026-05-10', 'uncategorized', 12.5, {
      currency: 'EUR',
      description: 'Receipt lunch',
      receiptRef: 'receipt-4401',
    });
    const categorizePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'finance',
        action: 'finance_categorize_receipt',
        args: { receiptId: tx.id, category: 'food', subcategory: 'lunch' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false });
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };

    const categorizeResponse = await executeChatActionPlan(categorizePlan!, { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false }, deps, { confirmed: true });
    expect(categorizeResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTransactions(4401, { limit: 5 }).find((candidate) => candidate.id === tx.id)).toMatchObject({ category: 'food', subcategory: 'lunch' });

    addTransaction(4401, '2026-05-01', 'income', 5000, { currency: 'BRL' });
    calculateAndStoreTax(4401, '2026-05');
    const payPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.99,
      steps: [{
        skill: 'finance',
        action: 'finance_payment_action',
        args: { action: 'mark_tax_paid', month: '2026-05' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false });
    const payResponse = await executeChatActionPlan(payPlan!, { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false }, deps, { confirmed: true });
    expect(payResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTaxEvents(4401, { year: 2026 }).find((event) => event.month === '2026-05')).toMatchObject({ status: 'paid' });
  });

  it('keeps Training reflow preview separate from the confirmation mutation path', async () => {
    vi.mocked(previewTrainingSessionReflow).mockResolvedValue({
      status: 'preview',
      data: {
        sessionId: 501,
        current: { startAt: '2026-05-18T07:00:00+01:00', endAt: '2026-05-18T08:00:00+01:00' },
        proposal: { startAt: '2026-05-19T07:00:00+01:00', endAt: '2026-05-19T08:00:00+01:00' },
      },
    } as any);
    vi.mocked(confirmTrainingSessionReflow).mockResolvedValue({
      status: 'confirmed',
      data: {
        sessionId: 501,
        verified: true,
        eventId: 'training-event-501',
      },
    } as any);
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };

    const previewPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_reflow_preview',
        args: { sessionId: 501 },
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const previewResponse = await executeChatActionPlan(previewPlan!, { ...baseInput, persistRuns: false }, deps, { confirmed: true });

    expect(previewResponse.metadata.actionStatus).toBe('verified_success');
    expect(previewTrainingSessionReflow).toHaveBeenCalledWith(baseInput.userId, 501, null, baseInput.tenantId);
    expect(confirmTrainingSessionReflow).not.toHaveBeenCalled();

    const confirmPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_reflow_confirm',
        args: { sessionId: 501 },
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const confirmResponse = await executeChatActionPlan(confirmPlan!, { ...baseInput, persistRuns: false }, deps, { confirmed: true });

    expect(confirmResponse.metadata.actionStatus).toBe('verified_success');
    expect(confirmTrainingSessionReflow).toHaveBeenCalledWith(expect.objectContaining({
      userId: baseInput.userId,
      sessionId: 501,
    }));
  });

  it('fails closed when a registry action has no safe chat executor yet', async () => {
    const args = { rawRequest: 'Ajusta o plano de treino para esta semana', planId: 1, changeRequest: 'lighter week' };
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_adjust_plan',
        args,
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });

    expect(plan).toBeTruthy();
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    }, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('blocked');
    expect(response.text).toContain('Ainda não consigo executar essa ação por chat com segurança');
    expect(response.metadata).toMatchObject({
      type: 'chat_action_blocked',
      actionStatus: 'blocked',
    });
    expect(JSON.stringify(response.metadata)).not.toMatch(/verified_success|Feito — concluí/i);
  });
});
