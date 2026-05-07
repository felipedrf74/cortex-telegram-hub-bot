import { describe, expect, it, vi } from 'vitest';

import {
  buildChatReasoningContextPack,
  CHAT_ACTION_MANIFESTS,
  detectChatReasoningMode,
  executeChatReasoningFrame,
  parseDeterministicActionFrame,
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
      ['Create a task called Prozis where it has sub tasks called creatine K2 D3', 'structured_action'],
      ['Create task "Prozis" with subtasks "creatine", "K2", "D3"', 'structured_action'],
      ['create tasks: creatine, K2, D3', 'structured_action'],
      ['Create three tasks: creatine, K2, D3', 'structured_action'],
      ['Add creatine, K2, D3 to task Prozis', 'structured_action'],
      ['add these subtasks to my Prozis task', 'structured_action'],
      ['adiciona creatina, K2, D3 à tarefa Prozis', 'structured_action'],
      ['Cria uma tarefa chamada Prozis com subtarefas creatina K2 D3', 'structured_action'],
      ['Criar checklist chamado Prozis: creatina, K2, D3', 'structured_action'],
      ['Create uma task chamada Suplementos com subtasks creatine K2 D3', 'structured_action'],
      ['Delete all events tomorrow', 'high_risk_preview'],
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
});
