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
  getEvents: vi.fn(),
  isAnyCalendarConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => true),
  getAllPendingTasks: vi.fn(),
  getDefaultList: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  getUnreadCount: vi.fn(),
  isOutlookMailConfigured: vi.fn(() => true),
}));

vi.mock('../../src/state/reminders', () => ({
  getRemindersForToday: vi.fn(() => []),
  setReminder: vi.fn(),
}));

vi.mock('../../src/skills/registry', () => ({
  isSubmoduleEnabled: vi.fn(() => true),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks so the module picks them up
import {
  tryFastpath,
  getFastpathPatterns,
  getFastpathMetrics,
  resetFastpathMetrics,
} from '../../src/services/secretary-fastpath';
import * as calendar from '../../src/services/unified-calendar';
import * as todo from '../../src/services/microsoft-todo';
import * as mail from '../../src/services/outlook-mail';
import * as reminders from '../../src/state/reminders';
import * as registry from '../../src/skills/registry';

const UID = 42;

// ─── Setup helpers ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetFastpathMetrics();
  // Default everything to "configured + sub-skill enabled"
  vi.mocked(calendar.isAnyCalendarConfigured).mockReturnValue(true);
  vi.mocked(todo.isOutlookTodoConfigured).mockReturnValue(true);
  vi.mocked(mail.isOutlookMailConfigured).mockReturnValue(true);
  vi.mocked(registry.isSubmoduleEnabled).mockReturnValue(true);
  // Default empty fixtures
  vi.mocked(calendar.getEvents).mockResolvedValue([]);
  vi.mocked(todo.getAllPendingTasks).mockResolvedValue({ success: true, data: [] });
  vi.mocked(mail.getUnreadCount).mockResolvedValue(0);
  vi.mocked(reminders.getRemindersForToday).mockReturnValue([]);
});

// ════════════════════════════════════════════════════════════════════
// Pattern matching
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / pattern matching', () => {
  it('exposes 7 registered patterns', () => {
    const patterns = getFastpathPatterns();
    expect(patterns).toEqual(
      expect.arrayContaining([
        'day_overview',
        'week_overview',
        'show_tasks',
        'unread_emails',
        'overdue_tasks',
        'set_reminder',
        'quick_add_task',
      ]),
    );
    expect(patterns).toHaveLength(7);
  });

  it.each([
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
    vi.mocked(todo.getDefaultList).mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    vi.mocked(todo.createTask).mockResolvedValue({ success: true, data: { id: 'T1', title: 'x' } } as any);
    const result = await tryFastpath(UID, input);
    expect(result.matched).toBe(true);
    expect(result.patternId).toBe(expectedPattern);
  });

  it.each([
    'plan my week considering my training and content schedule',
    'should I reschedule the meeting with Pedro?',
    'what should I prioritize today given my deadlines',
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
    vi.mocked(todo.getAllPendingTasks).mockResolvedValue({
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
    vi.mocked(mail.getUnreadCount).mockResolvedValue(7);
    const result = await tryFastpath(UID, "what's my day?");
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('E-MAILS:');
    expect(result.response!.text).toContain('7');
  });

  it('handles partial API failures gracefully', async () => {
    vi.mocked(calendar.getEvents).mockRejectedValue(new Error('Calendar API down'));
    vi.mocked(todo.getAllPendingTasks).mockResolvedValue({
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
// show_tasks handler
// ════════════════════════════════════════════════════════════════════

describe('secretary-fastpath / show_tasks handler', () => {
  it('returns "Sem tarefas pendentes" on empty list', async () => {
    vi.mocked(todo.getAllPendingTasks).mockResolvedValue({ success: true, data: [] });
    const result = await tryFastpath(UID, 'show my tasks');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Sem tarefas pendentes');
  });

  it('groups tasks by list and shows count', async () => {
    vi.mocked(todo.getAllPendingTasks).mockResolvedValue({
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
    vi.mocked(todo.getAllPendingTasks).mockResolvedValue({
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
    vi.mocked(mail.getUnreadCount).mockResolvedValue(12);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('<b>12</b>');
  });

  it('returns "Caixa de entrada limpa" when 0', async () => {
    vi.mocked(mail.getUnreadCount).mockResolvedValue(0);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Caixa de entrada limpa');
  });

  it('returns config error when outlook not configured', async () => {
    vi.mocked(mail.isOutlookMailConfigured).mockReturnValue(false);
    const result = await tryFastpath(UID, 'unread emails');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Email não configurado');
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
    vi.mocked(todo.getDefaultList).mockResolvedValue({ id: 'L1', displayName: 'Tasks' } as any);
    vi.mocked(todo.createTask).mockResolvedValue({ success: true, data: { id: 'T1', title: 'Buy milk' } } as any);
    const result = await tryFastpath(UID, 'add task: buy milk');
    expect(result.matched).toBe(true);
    expect(result.response!.text).toContain('Tarefa criada');
    expect(result.response!.text).toContain('buy milk');
    expect(todo.createTask).toHaveBeenCalledWith('L1', 'Tasks', { title: 'buy milk' });
  });

  it('errors gracefully when no default list', async () => {
    vi.mocked(todo.getDefaultList).mockResolvedValue(null);
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
    expect(todo.getAllPendingTasks).not.toHaveBeenCalled();
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
    vi.mocked(todo.getAllPendingTasks).mockImplementation(() => {
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
