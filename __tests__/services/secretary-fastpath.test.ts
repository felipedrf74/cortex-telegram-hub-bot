// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for src/services/secretary-fastpath.ts (Layer 1 of TASK-17).
 *
 * Strategy:
 *   - Mock all downstream services (calendar/todo/email/reminders) so each
 *     test is hermetic and runs in milliseconds.
 *   - Verify pattern matching for both PT-BR and EN phrasings.
 *   - Verify handlers return identical Telegram-HTML structure to what the
 *     AI would produce — empty-state, success, partial-failure all covered.
 *   - Verify graceful degradation: handler throws → matched: false (so the
 *     caller can fall through to the AI path).
 *   - Verify sub-skill gating: tasks pattern is skipped when isSubmoduleEnabled
 *     returns false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (must be defined BEFORE the import that uses them) ───────

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: vi.fn(),
  getEvents: vi.fn(),
  hasConnectedCalendarForUser: vi.fn(() => true),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => true),
}));

const mockGetTaskProviderForUser = vi.fn();
const mockTaskGetAllPendingTasks = vi.fn();
const mockTaskGetDefaultList = vi.fn();
const mockTaskCreateTask = vi.fn();
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  getUnreadCountForUser: vi.fn(),
  isOutlookMailConfiguredForUser: vi.fn(() => true),
}));
vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(),
  isAnyMailConfiguredForUser: vi.fn(() => true),
}));
vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: vi.fn(),
}));

vi.mock('../../src/state/reminders', () => ({
  getRemindersForToday: vi.fn(() => []),
  setReminder: vi.fn(),
}));

vi.mock('../../src/skills/registry', () => ({
  isSubmoduleEnabled: vi.fn(() => true),
}));

// Mock user-service so tests can control per-user language without
// seeding a real SQLite user row. Default returns 'pt-BR' so every
// existing test that doesn't override keeps its previous behavior.
// Bilingual tests below override `getUserLanguage` via `vi.mocked`.
vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'pt-BR'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  setUserLanguage: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateCalendarCaches: vi.fn(),
}));

// Import AFTER mocks so the module picks them up
import {
  tryFastpath,
  getFastpathPatterns,
  getFastpathMetrics,
  resetFastpathMetrics,
} from '../../src/services/secretary-fastpath';
import * as calendar from '../../src/services/unified-calendar';
import * as mailPressure from '../../src/services/unified-mail-pressure';
import * as reminders from '../../src/state/reminders';
import * as registry from '../../src/skills/registry';
import * as dailyBrief from '../../src/services/daily-brief-orchestrator';
import * as cacheCoherence from '../../src/services/cache-coherence-registry';

const UID = 42;

// ─── Setup helpers ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetFastpathMetrics();
  // Default everything to "configured + sub-skill enabled"
  vi.mocked(calendar.hasConnectedCalendarForUser).mockReturnValue(true);
  vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValue(true);
  vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(true);
  vi.mocked(registry.isSubmoduleEnabled).mockReturnValue(true);
  // Default empty fixtures
  vi.mocked(calendar.createEvent).mockResolvedValue({
    id: 'evt-1',
    summary: 'Created event',
    title: 'Created event',
    start: '2026-05-16T09:00:00.000+01:00',
    end: '2026-05-16T13:00:00.000+01:00',
    source: 'outlook',
  } as any);
  vi.mocked(calendar.getEvents).mockResolvedValue([]);
  mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
  mockTaskGetDefaultList.mockReset();
  mockTaskCreateTask.mockReset();
  mockGetTaskProviderForUser.mockReturnValue({
    getAllPendingTasks: mockTaskGetAllPendingTasks,
    getDefaultList: mockTaskGetDefaultList,
    createTask: mockTaskCreateTask,
  });
  vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
    configuredProviders: ['outlook'],
    totalUnread: 0,
    outlookUnread: 0,
    gmailUnread: null,
  });
  vi.mocked(reminders.getRemindersForToday).mockReturnValue([]);
  vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
    coordination: {
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
    },
    day: {
      secretary: {
        priorityNote: null,
        sequence: [],
        tradeoffNote: null,
      },
    },
  } as any);
});

// ════════════════════════════════════════════════════════════════════
// Pattern matching
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / pattern matching', () => {
  it('exposes 9 registered patterns', () => {
    const patterns = getFastpathPatterns();
    expect(patterns).toEqual(
      expect.arrayContaining([
        'day_overview',
        'create_calendar_event',
        'daily_priority',
        'week_overview',
        'show_tasks',
        'unread_emails',
        'overdue_tasks',
        'set_reminder',
        'quick_add_task',
      ]),
    );
    expect(patterns).toHaveLength(9);
  });

  it.each([
    ['Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas, convide o felipedrf@hotmail.com', 'create_calendar_event'],
    ["what's my day?", 'day_overview'],
    ['what is my day', 'day_overview'],
    ['o que tenho hoje', 'day_overview'],
    ['/day', 'day_overview'],
    ['today', 'day_overview'],
    ['hoje', 'day_overview'],
    ['mostra meu dia', 'day_overview'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ["what's my week?", 'week_overview'],
    ['esta semana', 'week_overview'],
    ['/week', 'week_overview'],
    ['mostra minha semana', 'week_overview'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ["what's my priority today?", 'daily_priority'],
    ['what should i do first today?', 'daily_priority'],
    ['o que faço primeiro', 'daily_priority'],
    ['qual a prioridade hoje?', 'daily_priority'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['show my tasks', 'show_tasks'],
    ['list todos', 'show_tasks'],
    ['mostra minhas tarefas', 'show_tasks'],
    ['/tasks', 'show_tasks'],
    ['/todo', 'show_tasks'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['unread emails', 'unread_emails'],
    ['quantos não lidos', 'unread_emails'],
    ['quantos emails não lidos?', 'unread_emails'],
    ['inbox', 'unread_emails'],
    ['check mail', 'unread_emails'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['overdue', 'overdue_tasks'],
    ['atrasadas', 'overdue_tasks'],
    ['tarefas atrasadas', 'overdue_tasks'],
    ['/overdue', 'overdue_tasks'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['remind me at 15:30 call dentist', 'set_reminder'],
    ['lembra às 15:30 ligar dentista', 'set_reminder'],
    ['avisa 9:00 reunião com Pedro', 'set_reminder'],
    ['reminder at 8:00 take vitamins', 'set_reminder'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    ['add task: buy milk', 'quick_add_task'],
    ['nova tarefa: comprar leite', 'quick_add_task'],
    ['adicionar tarefa: revisar PR', 'quick_add_task'],
  ])('matches "%s" → %s', async (input, expectedPattern) => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'x' } } as any);
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    'plan my week considering my training and content schedule',
    'should I reschedule the meeting with Pedro?',
    'help me decide between two options for the gym',
    'random freeform question that needs reasoning',
    '',
  ])('does NOT match "%s" (needs AI)', async (input) => {
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// day_overview handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / day_overview handler', () => {
  it('returns formatted HTML with calendar events', async () => {
    vi.mocked(calendar.getEvents).mockResolvedValue([
      {
        id: '1',
        summary: 'Standup',
        start: '2026-04-07T09:00:00.000Z',
        end: '2026-04-07T09:30:00.000Z',
        provider: 'google',
      } as any,
      {
        id: '2',
        summary: 'Gym session',
        start: '2026-04-07T18:00:00.000Z',
        end: '2026-04-07T19:00:00.000Z',
        provider: 'google',
      } as any,
    ]);

    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('Standup');
    expect(result.response!.text).toContain('Gym session');
    expect(result.response!.domain).toBe('secretary');
  });

  it('shows "Sem eventos hoje" when calendar is empty', async () => {
    vi.mocked(calendar.getEvents).mockResolvedValue([]);
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Sem eventos hoje');
  });

  it('shows pending tasks count and overdue badge', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't2', title: 'Edit podcast', dueDateTime: today, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't3', title: 'No date task', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('TAREFAS:');
    expect(result.response!.text).toContain('3 pendentes');
    expect(result.response!.text).toContain('1 atrasadas');
    expect(result.response!.text).toContain('Edit podcast'); // due today
  });

  it('includes unread email count when present', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 7,
      outlookUnread: 2,
      gmailUnread: 5,
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('E-MAILS:');
    expect(result.response!.text).toContain('7');
  });

  it('handles partial API failures gracefully', async () => {
    vi.mocked(calendar.getEvents).mockRejectedValue(new Error('Calendar API down'));
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [{ id: 't1', title: 'Buy groceries', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any],
    });
    const result = await tryFastpath(UID, "what's my day?");
    // Even with calendar errored out, we still get a valid response with tasks
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('TAREFAS:');
  });
});

// ════════════════════════════════════════════════════════════════════
// create_calendar_event handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / create_calendar_event handler', () => {
  it('creates a Portuguese calendar event with explicit date, time range, title, and attendee without AI', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    try {
      vi.mocked(calendar.createEvent).mockResolvedValueOnce({
        id: 'evt-volley',
        summary: 'Volei Lucas',
        start: '2026-05-16T09:00:00.000+01:00',
        end: '2026-05-16T13:00:00.000+01:00',
        source: 'outlook',
      } as any);

      const result = await tryFastpath(
        UID,
        'Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas, convide o felipedrf@hotmail.com',
        'pt-PT',
      );

      expect(result.matched).toBe(true);
      expect(result.patternId).toBe('create_calendar_event');
      expect(calendar.createEvent).toHaveBeenCalledWith(
        {
          title: 'Volei Lucas',
          start: '2026-05-16T09:00:00.000+01:00',
          end: '2026-05-16T13:00:00.000+01:00',
          attendees: ['felipedrf@hotmail.com'],
        },
        undefined,
        UID,
      );
      expect(cacheCoherence.invalidateCalendarCaches).toHaveBeenCalledWith(UID);
      expect(result.response?.text).toContain('Agendei no Outlook');
      expect(result.response?.text).toContain('Volei Lucas');
      expect(result.response?.text).toContain('felipedrf@hotmail.com');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an honest calendar-unavailable message instead of falling through to a timeout', async () => {
    vi.mocked(calendar.hasWritableCalendarForUser).mockReturnValueOnce(false);

    const result = await tryFastpath(
      UID,
      'Adicionar evento no calendário amanhã das 9h às 10h Consulta',
      'pt-PT',
    );

    expect(result.matched).toBe(true);
    expect(result.patternId).toBe('create_calendar_event');
    expect(calendar.createEvent).not.toHaveBeenCalled();
    expect(result.response?.text).toContain('calendário ligado');
  });

  it('falls back to the connected default calendar when a colloquial Google request has no writable Google path', async () => {
    vi.mocked(calendar.createEvent)
      .mockRejectedValueOnce(new Error('google not connected'))
      .mockResolvedValueOnce({
        id: 'evt-school',
        summary: 'Atividade Escola Sunny',
        start: '2026-05-15T09:30:00.000+01:00',
        end: '2026-05-15T10:30:00.000+01:00',
        source: 'outlook',
      } as any);

    const result = await tryFastpath(
      UID,
      'Colocar na agenda do google para o dia 15/5 das 9:30 as 10:30 Atividade Escola Sunny',
      'pt-PT',
    );

    expect(result.matched).toBe(true);
    expect(calendar.createEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: 'Atividade Escola Sunny' }),
      'google',
      UID,
    );
    expect(calendar.createEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: 'Atividade Escola Sunny' }),
      undefined,
      UID,
    );
    expect(result.response?.text).toContain('Agendei no Outlook');
  });
});

// ════════════════════════════════════════════════════════════════════
// show_tasks handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / show_tasks handler', () => {
  it('returns "Sem tarefas pendentes" on empty list', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Sem tarefas pendentes');
  });

  it('groups tasks by list and shows count', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Buy milk', dueDateTime: null, listName: 'Personal', listId: 'L1' } as any,
        { id: 't2', title: 'Review PR', dueDateTime: null, listName: 'Work', listId: 'L2' } as any,
        { id: 't3', title: 'Call dentist', dueDateTime: null, listName: 'Personal', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Tarefas Pendentes</b> (3)');
    expect(result.response!.text).toContain('Personal</b> (2)');
    expect(result.response!.text).toContain('Work</b> (1)');
    expect(result.response!.text).toContain('Buy milk');
    expect(result.response!.text).toContain('Review PR');
  });

  it('returns error message on API failure', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: false,
      data: [],
      error: 'Graph API rate limited',
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Erro ao buscar tarefas');
  });
});

// ════════════════════════════════════════════════════════════════════
// unread_emails handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / unread_emails handler', () => {
  it('returns count when > 0', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook', 'gmail'],
      totalUnread: 12,
      outlookUnread: 7,
      gmailUnread: 5,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('<b>12</b>');
  });

  it('returns "Caixa de entrada limpa" when 0', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 0,
      outlookUnread: null,
      gmailUnread: 0,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Caixa de entrada limpa');
  });

  it('returns config error when no mail provider is configured', async () => {
    vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(false);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Email não configurado');
  });
});

describe('secretary-fastpath / daily_priority handler', () => {
  it('returns planner coordination for prioritization asks', async () => {
    vi.mocked(dailyBrief.composeDailyBrief).mockResolvedValue({
      coordination: {
        topPriority: 'Protect the long run before content work.',
        executionOrder: ['Long run', 'Breakfast + recovery', 'Review sponsor draft'],
        watchouts: ['Inbox pressure is elevated'],
        handoffs: ['Content should follow training'],
      },
      day: {
        secretary: {
          priorityNote: 'Protect the long run before content work.',
          sequence: ['Long run', 'Breakfast + recovery', 'Review sponsor draft'],
          tradeoffNote: 'Do not trade training for admin drift.',
        },
      },
    } as any);

    const result = await tryFastpath(UID, "what's my priority today?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('PRIORIDADE');
    expect(result.response!.text).toContain('Protect the long run before content work.');
    expect(result.response!.text).toContain('1. Long run');
    expect(result.response!.text).toContain('Inbox pressure is elevated');
  });
});

// ════════════════════════════════════════════════════════════════════
// set_reminder handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / set_reminder handler', () => {
  it('parses "15:30" correctly and persists', async () => {
    const result = await tryFastpath(UID, 'remind me at 15:30 call dentist');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('⏰');
    expect(result.response!.text).toContain('15:30');
    expect(result.response!.text).toContain('call dentist');
    expect(reminders.setReminder).toHaveBeenCalledTimes(1);
    const call = vi.mocked(reminders.setReminder).mock.calls[0];
    expect(call[0]).toBe(UID);
    expect(call[1].message).toBe('call dentist');
    expect(call[1].remind_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('parses "3.30" as 3:30 (dot separator)', async () => {
    const result = await tryFastpath(UID, 'lembra às 3.30 acordar');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('3:30');
  });

  it('rejects invalid time "25:00"', async () => {
    const result = await tryFastpath(UID, 'remind me at 25:00 invalid');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('inválido');
    expect(reminders.setReminder).not.toHaveBeenCalled();
  });

  it('shows error when DB write fails', async () => {
    vi.mocked(reminders.setReminder).mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const result = await tryFastpath(UID, 'remind me at 10:00 test');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Erro ao salvar lembrete');
  });
});

// ════════════════════════════════════════════════════════════════════
// quick_add_task handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / quick_add_task handler', () => {
  it('creates task in default list', async () => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'Buy milk' } } as any);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Tarefa criada');
    expect(result.response!.text).toContain('buy milk');
    expect(mockTaskCreateTask).toHaveBeenCalledWith('L1', 'Tasks', { title: 'buy milk' });
  });

  it('errors gracefully when no default list', async () => {
    mockTaskGetDefaultList.mockResolvedValue(null);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Lista padrão');
  });
});

// ════════════════════════════════════════════════════════════════════
// Sub-skill gating
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / sub-skill gating', () => {
  it('skips show_tasks when tasks sub-skill is disabled', async () => {
    vi.mocked(registry.isSubmoduleEnabled).mockImplementation(
      (_d, sub) => sub !== 'tasks',
    );
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(false);
    expect(mockTaskGetAllPendingTasks).not.toHaveBeenCalled();
  });

  it('skips week_overview when calendar sub-skill is disabled', async () => {
    vi.mocked(registry.isSubmoduleEnabled).mockImplementation(
      (_d, sub) => sub !== 'calendar',
    );
    const result = await tryFastpath(UID, "what's my week?");
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Graceful degradation
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / graceful degradation', () => {
  it('falls through to AI when handler throws unexpectedly', async () => {
    mockTaskGetAllPendingTasks.mockImplementation(() => {
      throw new Error('Unexpected sync throw');
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Metrics
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / metrics', () => {
  it('tracks attempts, hits, and per-pattern counts', async () => {
    await tryFastpath(UID, "what's my day?");
    await tryFastpath(UID, 'show my tasks');
    await tryFastpath(UID, 'plan my entire week considering training');

    const m = getFastpathMetrics();
    expect(m.totalAttempts).toBe(3);
    expect(m.totalHits).toBe(2);
    expect(m.hitRate).toBeCloseTo(2 / 3, 2);
    expect(m.hitsByPattern.day_overview).toBe(1);
    expect(m.hitsByPattern.show_tasks).toBe(1);
  });

  it('avgLatencyMs is non-negative', async () => {
    await tryFastpath(UID, "what's my day?");
    expect(getFastpathMetrics().avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// Bilingual responses (April 2026)
//
// Every handler accepts a `lang` parameter and routes its user-facing
// copy through the COPY table. These tests cover the EN branch so
// the existing PT tests + these new EN tests together prove the
// table is complete for every key the code reads.
// ════════════════════════════════════════════════════════════════════

import * as userSvc from '../../src/services/user-service';
import { normalizeLangHeader } from '../../src/services/secretary-fastpath';

describe('secretary-fastpath / bilingual — EN', () => {
  beforeEach(() => {
    // Force EN for every test in this block. Individual tests can
    // still override via langOverride argument, but the default
    // mirrors the iOS path where setUserLanguage has already
    // written 'en-US' to the user row.
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('en-US');

    // `vi.clearAllMocks()` in the outer beforeEach clears CALL
    // HISTORY but NOT `.mockImplementation` overrides. The
    // "shows error when DB write fails" test earlier in the file
    // leaves `setReminder` throwing, which would bleed into our
    // happy-path set_reminder test below. Reset it to a clean
    // no-op function explicitly.
    vi.mocked(reminders.setReminder).mockReset();
    vi.mocked(reminders.setReminder).mockImplementation(
      (() => ({ id: 1 })) as any,
    );
  });

  // ── day_overview ──
  it('day_overview returns English copy when user lang is en-US', async () => {
    vi.mocked(calendar.getEvents).mockResolvedValue([]);
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    // English header + empty-state copy
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('No events today');
    // Should NOT contain the Portuguese strings
    expect(result.response!.text).not.toContain('Sem eventos hoje');
  });

  it('day_overview shows English task copy', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.response!.text).toContain('TASKS:');
    expect(result.response!.text).toContain('1 pending');
    expect(result.response!.text).toContain('1 overdue');
    expect(result.response!.text).not.toContain('pendentes');
  });

  it('day_overview shows English email header', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 7,
      outlookUnread: null,
      gmailUnread: 7,
    });
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.response!.text).toContain('EMAILS:');
    expect(result.response!.text).toContain('7 unread');
    expect(result.response!.text).not.toContain('não lidos');
  });

  // ── week_overview ──
  it('week_overview uses English day names and WEEK header', async () => {
    vi.mocked(calendar.getEvents).mockResolvedValue([]);
    const result = await tryFastpath(UID, "what's my week?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('WEEK');
    expect(result.response!.text).toContain('Mon');
    expect(result.response!.text).toContain('free'); // "— free" in English
    expect(result.response!.text).not.toContain('SEMANA');
    expect(result.response!.text).not.toContain('livre');
  });

  // ── show_tasks ──
  it('show_tasks uses "Pending Tasks" header in English', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Buy milk', dueDateTime: null, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.response!.text).toContain('Pending Tasks');
    expect(result.response!.text).not.toContain('Tarefas Pendentes');
  });

  it('show_tasks returns English empty-state', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.response!.text).toContain('No pending tasks!');
    expect(result.response!.text).not.toContain('Sem tarefas pendentes');
  });

  // ── unread_emails ──
  it('unread_emails uses English unread line', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['outlook'],
      totalUnread: 3,
      outlookUnread: 3,
      gmailUnread: null,
    });
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.response!.text).toContain('<b>3</b> unread emails');
    expect(result.response!.text).not.toContain('e-mails');
  });

  it('unread_emails uses English zero-state', async () => {
    vi.mocked(mailPressure.getUnreadMailSummaryForUser).mockResolvedValue({
      configuredProviders: ['gmail'],
      totalUnread: 0,
      outlookUnread: null,
      gmailUnread: 0,
    });
    const result = await tryFastpath(UID, 'inbox');
    expect(result.response!.text).toContain('Inbox clean!');
    expect(result.response!.text).not.toContain('Caixa de entrada');
  });

  it('unread_emails uses English config-missing line', async () => {
    vi.mocked(mailPressure.isAnyMailConfiguredForUser).mockReturnValue(false);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.response!.text).toContain('Email not configured');
    expect(result.response!.text).toContain('Settings > Connections');
    expect(result.response!.text).not.toContain('/settings');
    expect(result.response!.text).not.toContain('Email não configurado');
  });

  // ── overdue_tasks ──
  it('overdue_tasks uses "Overdue Task(s)" header in English', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockTaskGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', title: 'Pay tax', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
        { id: 't2', title: 'Review doc', dueDateTime: yesterday, listName: 'Inbox', listId: 'L1' } as any,
      ],
    });
    const result = await tryFastpath(UID, 'overdue');
    expect(result.response!.text).toContain('2 Overdue Tasks');
    expect(result.response!.text).toContain('due:');
    expect(result.response!.text).not.toContain('Atrasada');
    expect(result.response!.text).not.toContain('prazo:');
  });

  it('overdue_tasks empty state is English', async () => {
    mockTaskGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'overdue');
    expect(result.response!.text).toContain('No overdue tasks!');
    expect(result.response!.text).not.toContain('Nenhuma tarefa');
  });

  // ── set_reminder ──
  it('set_reminder uses English "Reminder set for" prefix', async () => {
    const result = await tryFastpath(UID, 'remind me at 10:00 take vitamins');
    expect(result.response!.text).toContain('Reminder set for');
    expect(result.response!.text).toContain('10:00');
    expect(result.response!.text).toContain('take vitamins');
    expect(result.response!.text).not.toContain('Lembrete definido');
  });

  it('set_reminder invalid time message is English', async () => {
    const result = await tryFastpath(UID, 'remind me at 25:00 invalid');
    expect(result.response!.text).toContain('Invalid time:');
    expect(result.response!.text).not.toContain('Horário inválido');
  });

  // ── quick_add_task ──
  it('quick_add_task uses English "Task created" confirmation', async () => {
    mockTaskGetDefaultList.mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    mockTaskCreateTask.mockResolvedValue({ success: true, data: { id: 'T1', title: 'x' } } as any);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.response!.text).toContain('Task created');
    expect(result.response!.text).not.toContain('Tarefa criada');
  });
});

// ════════════════════════════════════════════════════════════════════
// Language override (explicit langOverride parameter)
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / language override', () => {
  beforeEach(() => {
    // User row says pt-BR, but the override should win.
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('pt-BR');
  });

  it('langOverride=en-US produces English copy even when user row is pt-BR', async () => {
    const result = await tryFastpath(UID, "what's my day?", 'en-US');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('AGENDA:');
    expect(result.response!.text).toContain('No events today');
  });

  it('langOverride=pt-BR produces Portuguese copy even when user row is en-US', async () => {
    vi.mocked(userSvc.getUserLanguage).mockReturnValue('en-US');
    const result = await tryFastpath(UID, "what's my day?", 'pt-BR');
    expect(result.response!.text).toContain('Sem eventos hoje');
  });

  it('no override + no user row keeps the legacy pt-BR default without leaking scoped data', async () => {
    // userId=0 skips the getUserLanguage call entirely (anonymous)
    const result = await tryFastpath(0, "what's my day?");
    expect(result.response!.text).toContain('Sem treino planeado hoje');
    expect(result.response!.text).not.toContain('Sem eventos hoje');
    expect(result.response!.text).not.toContain('No training planned today');
  });
});

// ════════════════════════════════════════════════════════════════════
// normalizeLangHeader — boundary parser
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / normalizeLangHeader', () => {
  it.each([
    ['pt-BR', 'pt-BR'],
    ['pt-br', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['pt_pt', 'pt-PT'],
    ['pt', 'pt-BR'],
    ['pt_BR', 'pt-BR'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
    ['en-GB', 'en-US'],
    ['EN', 'en-US'],
  ])('maps "%s" → %s', (input, expected) => {
    expect(normalizeLangHeader(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['unknown value', 'it-IT'],
  ])('falls back to pt-BR for %s', (_label, input) => {
    expect(normalizeLangHeader(input)).toBe('pt-BR');
  });

  it('accepts array values (Express passes repeated headers as arrays)', () => {
    expect(normalizeLangHeader(['en', 'pt-BR'])).toBe('en-US');
  });
});
