import { describe, expect, it } from 'vitest';

import {
  formatDailyBriefing,
  formatMsTodoSummary,
  formatMsTodoTasks,
} from '../../src/utils/telegram-formatter';

describe('telegram formatter localization', () => {
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

  it('formats daily briefings in Portuguese when the user language is pt-BR', () => {
    // Identity-safety (May 2026 audit): the greeting is now parameterized
    // by the recipient's saved display name. A passed name should appear
    // in the greeting, and the legacy hardcoded "Felipe" must NEVER appear
    // unless the caller explicitly passes that as the recipient name.
    const text = formatDailyBriefing({
      date: 'segunda-feira, 20 de abril',
      events: [],
      highPriorityTasks: [],
      dueTodayTasks: [],
      overdueTasks: [],
      reminders: [],
      unreadEmails: 2,
      yesterdayCompleted: 1,
    }, 'pt-BR', 'Jaqueline');

    expect(text).toContain('Bom dia, Jaqueline');
    expect(text).not.toContain('Felipe');
    expect(text).toContain('Sem eventos hoje');
    expect(text).toContain('Sem tarefas para hoje');
    expect(text).toContain('concluídas ontem');
    expect(text).toContain('emails não lidos');
    expect(text).not.toContain('Good morning');
  });

  it('formats daily briefings without a name when the recipient has no saved display name', () => {
    // Empty recipient = name-less greeting. NEVER falls back to a default
    // founder name.
    const text = formatDailyBriefing({
      date: 'segunda-feira, 20 de abril',
      events: [],
      highPriorityTasks: [],
      dueTodayTasks: [],
      overdueTasks: [],
      reminders: [],
      unreadEmails: 0,
      yesterdayCompleted: 0,
    }, 'pt-BR', '');

    expect(text).toContain('Bom dia!');
    expect(text).not.toContain('Felipe');
    expect(text).not.toContain('Bom dia,');
  });
});
