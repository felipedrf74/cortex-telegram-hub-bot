import { describe, expect, it } from 'vitest';

import { buildDeterministicChatActionPlan } from '../../src/services/chat';

const baseInput = {
  userId: 9101,
  tenantId: 9101,
  conversationId: 'nlu-task-extraction',
  messageId: 'msg-nlu-task-extraction',
  channel: 'telegram' as const,
  timezone: 'Europe/Lisbon',
  nowIso: '2026-05-14T12:00:00+01:00',
  persistRuns: false,
};

describe('task NLU title extraction', () => {
  it.each([
    {
      text: 'Add a task to call my dentist on Friday',
      locale: 'en-US',
      title: 'Call my dentist',
      dueDateTime: '2026-05-15',
    },
    {
      text: 'Create a task for tomorrow at 10am called "Team meeting"',
      locale: 'en-US',
      title: 'Team meeting',
      dueDateTime: '2026-05-15T10:00:00.000+01:00',
    },
    {
      text: 'Remind me to buy milk',
      locale: 'en-US',
      title: 'Buy milk',
      dueDateTime: null,
    },
    {
      text: 'Cria uma tarefa para amanhã chamada "Reunião"',
      locale: 'pt-PT',
      title: 'Reunião',
      dueDateTime: '2026-05-15',
    },
    {
      text: 'Adiciona uma tarefa para ligar ao dentista amanhã',
      locale: 'pt-PT',
      title: 'ligar ao dentista',
      dueDateTime: '2026-05-15',
    },
    {
      text: 'Crea una tarea llamada "Comprar leche"',
      locale: 'es-ES',
      title: 'Comprar leche',
      dueDateTime: null,
    },
  ])('extracts "$title" from "$text"', async ({ text, locale, title, dueDateTime }) => {
    const plan = buildDeterministicChatActionPlan({
      ...baseInput,
      text,
      locale,
      messageId: `msg-${text.replace(/\W+/g, '-').toLowerCase()}`,
    });

    expect(plan?.steps[0]).toMatchObject({
      skill: 'tasks',
      action: 'create_task',
      requiredArgsPresent: true,
    });
    expect(plan?.steps[0]?.args).toMatchObject({
      title,
      dueDateTime,
    });
  });
});
