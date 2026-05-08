import { describe, expect, it, vi } from 'vitest';

import {
  buildChatReasoningContextPack,
  CHAT_ACTION_MANIFESTS,
  detectChatReasoningMode,
  executeChatReasoningFrame,
  parseDeterministicActionFrame,
  tryHandleChatReasoningAction,
  validateChatActionFrame,
  type ChatActionFrame,
} from '../../src/services/chat-reasoning-engine';

function expectSubtaskFrame(text: string, title: string, subtasks: string[]) {
  const frame = parseDeterministicActionFrame(text);
  expect(frame).toMatchObject({
    version: 'chat_action_frame.v1',
    primaryIntent: 'create_task_with_subtasks',
    skill: 'secretary',
    reasoningMode: 'structured_action',
  });
  expect(frame?.entities).toMatchObject({
    title,
    subtasks,
    dueAt: null,
    reminderAt: null,
  });
  return frame!;
}

describe('Chat Reasoning Engine v1', () => {
  it('extracts the Prozis parent task and subtasks instead of flattening the sentence into one title', () => {
    const frame = expectSubtaskFrame(
      "Create a task called Prozis where it has sub tasks called creatine K2 D3 for now that's it",
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );

    expect(frame.confidence).toBeGreaterThanOrEqual(0.9);
    expect(frame.requiresConfirmation).toBe(false);
    expect((frame.entities as any).dueAt).toBeNull();
  });

  it('keeps quoted task titles intact instead of interpreting embedded subtask words as instructions', () => {
    const frame = parseDeterministicActionFrame('Create task "Prozis with subtasks called creatine K2 D3"');

    expect(frame).toMatchObject({
      primaryIntent: 'create_task',
      skill: 'secretary',
    });
    expect(frame?.entities).toMatchObject({
      title: 'Prozis with subtasks called creatine K2 D3',
    });
  });

  it('supports quoted title plus quoted subtasks', () => {
    expectSubtaskFrame(
      'Create task "Prozis" with subtasks "creatine", "K2", "D3"',
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
  });

  it('handles Portuguese and mixed-language checklist commands', () => {
    expectSubtaskFrame(
      'Cria uma tarefa chamada Prozis com subtarefas creatine K2 D3 por agora',
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
    expectSubtaskFrame(
      'Cria uma tarefa Prozis com creatina K2 D3',
      'Prozis',
      ['creatina', 'K2', 'D3'],
    );
    expectSubtaskFrame(
      'Crear tarea Prozis con subtareas creatina K2 D3',
      'Prozis',
      ['creatina', 'K2', 'D3'],
    );
    expectSubtaskFrame(
      'Create uma task chamada Suplementos com subtasks creatine K2 D3',
      'Suplementos',
      ['creatine', 'K2', 'D3'],
    );
  });

  it('distinguishes one task with subtasks from separate tasks and long quoted titles', () => {
    expect(parseDeterministicActionFrame('Create three tasks: creatine, K2, D3')).toMatchObject({
      primaryIntent: 'create_multiple_tasks',
      steps: [
        { action: 'create_task', entities: { title: 'creatine' } },
        { action: 'create_task', entities: { title: 'K2' } },
        { action: 'create_task', entities: { title: 'D3' } },
      ],
    });
    expect(parseDeterministicActionFrame('Create task called creatine K2 D3')).toMatchObject({
      primaryIntent: 'create_task',
      entities: { title: 'creatine K2 D3' },
    });
    expect(parseDeterministicActionFrame('Create tasks A, B, C')).toMatchObject({
      primaryIntent: 'create_multiple_tasks',
      steps: [
        { action: 'create_task', entities: { title: 'A' } },
        { action: 'create_task', entities: { title: 'B' } },
        { action: 'create_task', entities: { title: 'C' } },
      ],
    });
    expect(parseDeterministicActionFrame('Create 3 tasks: A, B, C')).toMatchObject({
      primaryIntent: 'create_multiple_tasks',
    });
  });

  it('handles adversarial parser cases without flattening or creating noisy subtasks', () => {
    expectSubtaskFrame(
      "Create task Prozis with subtasks creatine for now that's it K2 D3",
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
    expectSubtaskFrame(
      'Create checklist groceries: eggs, milk, bananas',
      'groceries',
      ['eggs', 'milk', 'bananas'],
    );
    expectSubtaskFrame(
      'Create task Prozis with subtasks A B C D E F G H I J',
      'Prozis',
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
    );
    expect(parseDeterministicActionFrame('Create task "Prozis \'inner\' rest"')).toMatchObject({
      primaryIntent: 'create_task',
      entities: { title: "Prozis 'inner' rest" },
    });
    const capped = expectSubtaskFrame(
      `Create task Load Test with subtasks ${Array.from({ length: 40 }, (_, index) => `item${index + 1}`).join(' ')}`,
      'Load Test',
      Array.from({ length: 25 }, (_, index) => `item${index + 1}`),
    );
    expect((capped.entities as any).subtasks).toHaveLength(25);
  });

  it('fails closed for targeted destructive and multi-step messages', async () => {
    expect(detectChatReasoningMode('Delete the Prozis task')).toBe('high_risk_preview');
    expect(detectChatReasoningMode('Cancel my 9am meeting')).toBe('high_risk_preview');
    expect(detectChatReasoningMode('Apaga a tarefa Prozis')).toBe('high_risk_preview');
    expect(detectChatReasoningMode('Create task Prozis with subtasks creatine K2 D3 and remind me tomorrow')).toBe('multi_step_plan');

    const result = await tryHandleChatReasoningAction({
      text: 'Create task Prozis with subtasks creatine K2 D3 and remind me tomorrow',
      userId: 42,
      tenantId: 42,
      sourceMessageId: 'msg-multi-step',
    });
    expect(result).toMatchObject({
      status: 'needs_clarification',
      response: {
        metadata: {
          type: 'chat_action_clarification_required',
          reason: 'multi_step_action_requires_preview',
        },
      },
    });
  });

  it('asks for clarification instead of merging multi-recipient subtask updates', () => {
    const frame = parseDeterministicActionFrame('Add creatine to Prozis and K2 to Vitamins');

    expect(frame).toMatchObject({
      primaryIntent: 'add_subtasks_to_task',
      ambiguityFlags: ['multi_recipient_subtask_update'],
      missingFields: ['targetTask'],
    });
  });

  it('detects reasoning mode for token-zero reads, high-risk requests, and structured actions', () => {
    const cases: Array<[string, ReturnType<typeof detectChatReasoningMode>]> = [
      ['Who am I?', 'deterministic_fastpath'],
      ['whoami', 'deterministic_fastpath'],
      ['Quem sou eu?', 'deterministic_fastpath'],
      ['Show my tasks', 'deterministic_fastpath'],
      ['show tasks', 'deterministic_fastpath'],
      ['list my todo', 'deterministic_fastpath'],
      ['open my to-dos', 'deterministic_fastpath'],
      ['List my agenda', 'deterministic_fastpath'],
      ['What is my week?', 'deterministic_fastpath'],
      ["What's my day?", 'deterministic_fastpath'],
      ['open calendar', 'deterministic_fastpath'],
      ['Mostra as minhas tarefas', 'deterministic_fastpath'],
      ['listar tarefas', 'deterministic_fastpath'],
      ['abre agenda', 'deterministic_fastpath'],
      ['quais são as minhas tarefas', 'deterministic_fastpath'],
      ['Create task buy creatine', 'structured_action'],
      ['Add task buy creatine', 'structured_action'],
      ['make a task call dentist', 'structured_action'],
      ['create todo review invoices', 'structured_action'],
      ['create checklist Supplements: creatine, K2, D3', 'structured_action'],
      ['Create task Prozis with subtasks creatine K2 D3', 'structured_action'],
      ['Create task Prozis with subtasks creatine K2 D3 and remind me tomorrow', 'multi_step_plan'],
      ['Create a task called Prozis where it has sub tasks called creatine K2 D3', 'structured_action'],
      ['Create task "Prozis" with subtasks "creatine", "K2", "D3"', 'structured_action'],
      ['create tasks: creatine, K2, D3', 'structured_action'],
      ['Create three tasks: creatine, K2, D3', 'structured_action'],
      ['Create 3 tasks: creatine, K2, D3', 'structured_action'],
      ['Create tasks creatine, K2, D3', 'structured_action'],
      ['Add creatine, K2, D3 to task Prozis', 'structured_action'],
      ['add these subtasks to my Prozis task', 'structured_action'],
      ['adiciona creatina, K2, D3 à tarefa Prozis', 'structured_action'],
      ['Cria uma tarefa chamada Prozis com subtarefas creatina K2 D3', 'structured_action'],
      ['Criar checklist chamado Prozis: creatina, K2, D3', 'structured_action'],
      ['Create uma task chamada Suplementos com subtasks creatine K2 D3', 'structured_action'],
      ['Delete all events tomorrow', 'high_risk_preview'],
      ['Delete the Prozis task', 'high_risk_preview'],
      ['Cancel my 9am meeting', 'high_risk_preview'],
      ['delete everything on my agenda', 'high_risk_preview'],
      ['Cancel everything on my calendar', 'high_risk_preview'],
      ['clear all tasks', 'high_risk_preview'],
      ['apagar todas tarefas', 'high_risk_preview'],
      ['cancela todos os eventos', 'high_risk_preview'],
      ['undo that', 'clarification'],
      ['fix that', 'clarification'],
      ['No, I meant those as subtasks', 'clarification'],
      ['corrige isso', 'clarification'],
      ['Create a marathon plan and schedule long runs Saturday', 'multi_step_plan'],
      ['reschedule my training session to Friday', 'multi_step_plan'],
      ['Create a content idea about marathon prep and schedule recording Tuesday', 'multi_step_plan'],
      ['Plan dinners next week and create a grocery list', 'multi_step_plan'],
      ['Remind me to pay invoice tomorrow and mark it in Finance', 'multi_step_plan'],
      ['schedule calendar focus time tomorrow', 'multi_step_plan'],
      ['I need a plan for this week', 'multi_step_plan'],
      ['What should I do today?', 'conversation_answer'],
      ['how should I think about tomorrow?', 'conversation_answer'],
      ['tell me a joke', 'conversation_answer'],
      ['I feel tired today', 'conversation_answer'],
      ['compare creatine and K2', 'conversation_answer'],
      ['hello Nexus', 'conversation_answer'],
    ];

    expect(cases.length).toBeGreaterThanOrEqual(50);

    for (const [text, expected] of cases) {
      expect(detectChatReasoningMode(text), text).toBe(expected);
    }
  });

  it('rejects model-provided identity fields and manifest-only future actions before execution', () => {
    const context = buildChatReasoningContextPack({ userId: 42, tenantId: 42 });
    const frame = expectSubtaskFrame(
      'Create task Prozis with subtasks creatine K2 D3',
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );

    expect(validateChatActionFrame({
      ...frame,
      entities: { ...frame.entities, userId: 1, tenantId: 2 },
    }, context)).toMatchObject({
      decision: 'deny',
      reason: 'model_identity_fields_rejected',
    });
    expect(validateChatActionFrame({
      ...frame,
      entities: { ...frame.entities, metadata: { userId: 999 } },
      steps: [{ action: 'create_task_with_subtasks', entities: { title: 'Prozis', nested: { tenantId: 123 } } }],
    }, context)).toMatchObject({
      decision: 'deny',
      reason: 'model_identity_fields_rejected',
    });

    const futureAction: ChatActionFrame = {
      ...frame,
      primaryIntent: 'create_meal_plan',
      skill: 'cooking',
      entities: { range: 'next week' },
      steps: [{ action: 'create_meal_plan', entities: { range: 'next week' } }],
    };
    expect(validateChatActionFrame(futureAction, context)).toMatchObject({
      decision: 'deny',
      reason: 'manifest_only_action_not_executable',
    });
    expect(CHAT_ACTION_MANIFESTS.some((manifest) => manifest.skill === 'cooking' && manifest.action === 'create_meal_plan')).toBe(true);
  });

  it('requires an authenticated tenant instead of inventing one from the user id', () => {
    expect(() => buildChatReasoningContextPack({ userId: 42 })).toThrow('chat_reasoning_missing_authenticated_tenant');
  });

  it('executes the Secretary task/subtask slice deterministically and verifies read-back state', async () => {
    const frame = expectSubtaskFrame(
      "Create a task called Prozis where it has sub tasks called creatine K2 D3 for now that's it",
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
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

    const result = await executeChatReasoningFrame({
      text: 'Create task',
      userId: 42,
      tenantId: 42,
      sourceMessageId: 'msg-user-test',
      frame,
      provider,
      persistPlan: false,
    });

    expect(provider.createTask).toHaveBeenCalledWith('list-1', 'Inbox', expect.objectContaining({ title: 'Prozis' }));
    expect(provider.addChecklistItem).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('completed');
    expect(result.response.text).toContain('Created task “Prozis” with 3 subtasks');
    expect(result.response.metadata).toMatchObject({
      type: 'task_created',
      taskId: 'task-1',
      title: 'Prozis',
      verificationStatus: 'verified',
      subtasks: [
        { title: 'creatine' },
        { title: 'K2' },
        { title: 'D3' },
      ],
    });
  });

  it('executes plain task creation instead of returning a deferred developer message', async () => {
    const frame = parseDeterministicActionFrame('Create task buy milk');
    expect(frame).toMatchObject({
      primaryIntent: 'create_task',
      entities: { title: 'buy milk' },
    });
    const provider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      createTask: vi.fn(async (_listId: string, _listName: string, data: any) => ({
        success: true,
        data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: data.title },
      })),
      getTask: vi.fn(async () => ({
        success: true,
        data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: 'buy milk', checklistItems: [] },
      })),
    };

    const result = await executeChatReasoningFrame({
      text: 'Create task buy milk',
      userId: 42,
      tenantId: 42,
      sourceMessageId: 'msg-create-task',
      frame: frame!,
      provider,
      persistPlan: false,
    });

    expect(provider.createTask).toHaveBeenCalledWith('list-1', 'Inbox', expect.objectContaining({ title: 'buy milk' }));
    expect(result.status).toBe('completed');
    expect(result.response.text).toContain('Created task “buy milk”');
    expect(result.response.metadata).toMatchObject({
      type: 'task_created',
      title: 'buy milk',
      subtasks: [],
      verificationStatus: 'verified',
    });
  });

  it('returns partial failure instead of claiming success when read-back cannot verify subtasks', async () => {
    const frame = expectSubtaskFrame(
      'Create task Prozis with subtasks creatine K2 D3',
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
    const provider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: 'Prozis' } })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => ({ success: true, data: { id: displayName, displayName, isChecked: false } })),
      getTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', listId: 'list-1', title: 'Prozis', checklistItems: [] } })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: [] })),
    };

    const result = await executeChatReasoningFrame({
      text: 'Create task',
      userId: 42,
      tenantId: 42,
      sourceMessageId: 'msg-user-test',
      frame,
      provider,
      persistPlan: false,
    });

    expect(result.status).toBe('partial_failure');
    expect(result.response.metadata).toMatchObject({
      verificationStatus: 'partial_failure',
      warnings: expect.arrayContaining(['created_subtasks_missing']),
    });
  });

  it('does not mark verification successful when the created task cannot be read back', async () => {
    const frame = expectSubtaskFrame(
      'Create task Prozis with subtasks creatine K2 D3',
      'Prozis',
      ['creatine', 'K2', 'D3'],
    );
    const provider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'list-1', displayName: 'Inbox', wellknownListName: 'defaultList' }] })),
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', listId: 'list-1', listName: 'Inbox', title: 'Prozis' } })),
      addChecklistItem: vi.fn(async (_listId: string, _taskId: string, displayName: string) => ({ success: true, data: { id: displayName, displayName, isChecked: false } })),
      getTask: vi.fn(async () => ({ success: false, data: null })),
      getChecklistItems: vi.fn(async () => ({ success: true, data: [
        { id: 'ci-1', displayName: 'creatine', isChecked: false },
        { id: 'ci-2', displayName: 'K2', isChecked: false },
        { id: 'ci-3', displayName: 'D3', isChecked: false },
      ] })),
    };

    const result = await executeChatReasoningFrame({
      text: 'Create task',
      userId: 42,
      tenantId: 42,
      sourceMessageId: 'msg-user-test',
      frame,
      provider,
      persistPlan: false,
    });

    expect(result.status).toBe('partial_failure');
    expect(result.response.metadata).toMatchObject({
      verificationStatus: 'partial_failure',
      warnings: expect.arrayContaining(['task_read_back_unavailable']),
    });
  });
});
