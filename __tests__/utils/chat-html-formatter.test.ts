import { describe, expect, it } from 'vitest';

import {
  formatMsTodoSummary,
  formatMsTodoTasks,
} from '../../src/utils/chat-html-formatter';

describe('chat HTML formatter localization', () => {
  it('formats Microsoft To Do summaries in Portuguese when the user language is pt-BR', () => {
    const text = formatMsTodoSummary({
      pendingCount: 57,
      overdueCount: 5,
      dueTodayCount: 2,
      highPriorityCount: 3,
      overdueTasks: [
        {
          id: 'task-1',
          title: 'Rotina Limpeza',
          listId: 'list-1',
          listName: 'Rotine',
        status: 'notStarted',
        importance: 'normal',
        dueDateTime: '2026-04-16T09:00:00.000Z',
        isReminderOn: false,
        createdDateTime: '2026-04-10T09:00:00.000Z',
      },
    ],
      dueTodayTasks: [],
    }, 'pt-BR');

    expect(text).toContain('Resumo das tarefas');
    expect(text).toContain('Pendentes: 57');
    expect(text).toContain('Alta prioridade: 3');
    expect(text).toContain('Atrasadas: 5');
    expect(text).toContain('estava prevista para');
    expect(text).not.toContain('Task Summary');
  });

  it('formats task list responses in Portuguese when the user language is pt-PT', () => {
    const text = formatMsTodoTasks([
      {
        id: 'task-1',
        title: 'Pagar imposto',
        listId: 'list-1',
        listName: 'Tarefas',
        status: 'notStarted',
        importance: 'high',
        dueDateTime: '2026-04-22T09:00:00.000Z',
        isReminderOn: false,
        createdDateTime: '2026-04-20T09:00:00.000Z',
      },
    ], 'Tarefas', 'pt-PT');

    expect(text).toContain('Tarefas (1 tarefas)');
    expect(text).toContain('vence');
    expect(text).not.toContain('due');
  });

});
