// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock service modules BEFORE importing the unit under test
vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => true),
  getDefaultList: vi.fn(async () => ({ id: 'list-1', displayName: 'Tarefas' })),
  getTasks: vi.fn(async () => ({
    success: true,
    data: [
      { id: 't1', title: 'Pay rent', listName: 'Tarefas', listId: 'list-1', status: 'notStarted', importance: 'normal' },
    ],
  })),
  getLists: vi.fn(async () => ({
    success: true,
    data: [{ id: 'list-1', displayName: 'Tarefas', isShared: false }],
  })),
  getAllPendingTasks: vi.fn(async () => ({
    success: true,
    data: [
      { id: 't1', title: 'Overdue task', listName: 'Tarefas', listId: 'list-1', status: 'notStarted', importance: 'normal', dueDateTime: '2020-01-01T12:00:00.0000000' },
      { id: 't2', title: 'Today task', listName: 'Tarefas', listId: 'list-1', status: 'notStarted', importance: 'high', dueDateTime: new Date().toISOString() },
      { id: 't3', title: 'Future task', listName: 'Tarefas', listId: 'list-1', status: 'notStarted', importance: 'normal', dueDateTime: '2099-01-01T12:00:00.0000000' },
    ],
  })),
  getTasksDueInRange: vi.fn(async () => ({ success: true, data: [] })),
}));

const mockGetTaskProviderForUser = vi.fn();
const mockTrySecretaryFastpath = vi.fn();
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

vi.mock('../../src/services/secretary-fastpath', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-fastpath')>(
    '../../src/services/secretary-fastpath',
  )),
  tryFastpath: (...args: unknown[]) => mockTrySecretaryFastpath(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  hasConnectedCalendarForUser: vi.fn(() => false),
  isAnyCalendarConfigured: vi.fn(() => false),
  getEvents: vi.fn(async () => []),
}));

vi.mock('../../src/services/unified-mail-pressure', () => ({
  isAnyMailConfiguredForUser: vi.fn(() => false),
  getUnreadMailSummaryForUser: vi.fn(async () => ({
    totalUnread: 0,
    outlookUnread: null,
    gmailUnread: null,
  })),
}));

vi.mock('../../src/state/reminders', () => ({
  getActiveReminders: vi.fn(() => []),
}));

import { tryDeterministicChatCommand } from '../../src/api/routes/chat-fastpath';
import * as msTodo from '../../src/services/microsoft-todo';

describe('Chat Fast-Path Command Interceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskProviderForUser.mockReset();
    mockTrySecretaryFastpath.mockImplementation(async (_userId: number, command: string) => ({
      matched: true,
      patternId: command === '/week' ? 'week_overview' : command === '/status' ? 'status_overview' : 'day_overview',
      response: {
        domain: 'secretary',
        text: command === '/week'
          ? '<b>Week</b>'
          : command === '/status'
            ? '<b>Plan Status</b>'
            : '<b>Day</b>\nToday task',
      },
    }));
  });

  it('returns null for non-slash messages (free-form questions)', async () => {
    const result = await tryDeterministicChatCommand('Como está meu dia?');
    expect(result).toBeNull();
  });

  it('returns null for empty messages', async () => {
    expect(await tryDeterministicChatCommand('')).toBeNull();
  });

  it('returns null for /todo with arguments (AI parsing needed)', async () => {
    const result = await tryDeterministicChatCommand('/todo Buy new running shoes');
    expect(result).toBeNull();
  });

  it('returns null for unknown slash commands', async () => {
    const result = await tryDeterministicChatCommand('/somethingrandom');
    expect(result).toBeNull();
  });

  it('handles bare /todo as task list lookup', async () => {
    const result = await tryDeterministicChatCommand('/todo');
    expect(result).not.toBeNull();
    expect(result?.domain).toBe('secretary');
    expect(result?.text).toContain('Tarefas');
  });

  it('handles /todos identically to /todo', async () => {
    const result = await tryDeterministicChatCommand('/todos');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Tarefas');
  });

  it('handles /tasks identically to /todo', async () => {
    const result = await tryDeterministicChatCommand('/tasks');
    expect(result).not.toBeNull();
  });

  it('handles /lists', async () => {
    const result = await tryDeterministicChatCommand('/lists');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Tarefas');
  });

  it('handles /overdue and filters by Lisbon date', async () => {
    const result = await tryDeterministicChatCommand('/overdue');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Overdue');
    // The 2020 task is overdue, the future and today tasks are not
    expect(result?.text).toContain('Overdue task');
    expect(result?.text).not.toContain('Future task');
  });

  it('handles /duetoday and filters by Lisbon date', async () => {
    const result = await tryDeterministicChatCommand('/duetoday');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Today task');
    expect(result?.text).not.toContain('Overdue task');
    expect(result?.text).not.toContain('Future task');
  });

  it('handles /todosummary with full breakdown', async () => {
    const result = await tryDeterministicChatCommand('/todosummary');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Pending');
    expect(result?.text).toContain('Overdue');
  });

  it('handles /day overview', async () => {
    const result = await tryDeterministicChatCommand('/day', 42, 42);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Today task');
    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(42, '/day', undefined, 42);
  });

  it('handles /week overview', async () => {
    const result = await tryDeterministicChatCommand('/week', 42, 42);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Week');
    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(42, '/week', undefined, 42);
  });

  it('handles /status overview', async () => {
    const result = await tryDeterministicChatCommand('/status', 42, 42);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Plan Status');
    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(42, '/status', undefined, 42);
  });

  it('fails closed for an anonymous overview instead of reporting an empty plan', async () => {
    const result = await tryDeterministicChatCommand('/day');

    expect(result?.text).toContain('could not be confirmed');
    expect(result?.text).not.toContain('No events');
    expect(mockTrySecretaryFastpath).not.toHaveBeenCalled();
  });

  it('is case-insensitive for slash commands', async () => {
    const result = await tryDeterministicChatCommand('/TODO');
    expect(result).not.toBeNull();
  });

  it('trims whitespace before parsing', async () => {
    const result = await tryDeterministicChatCommand('  /overdue  ');
    expect(result).not.toBeNull();
  });

  it('uses the per-user task provider for authenticated /todo instead of the global singleton', async () => {
    const provider = {
      getDefaultList: vi.fn(async () => ({ id: 'native-1', displayName: 'Inbox' })),
      getTasks: vi.fn(async () => ({
        success: true,
        data: [
          { id: 'n1', title: 'Native task', listName: 'Inbox', listId: 'native-1', status: 'notStarted', importance: 'normal' },
        ],
      })),
      getLists: vi.fn(),
      getAllPendingTasks: vi.fn(async () => ({ success: true, data: [] })),
      getTasksDueInRange: vi.fn(),
    };
    mockGetTaskProviderForUser.mockReturnValue(provider);

    const result = await tryDeterministicChatCommand('/todo', 42);

    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(42);
    expect(provider.getDefaultList).toHaveBeenCalled();
    expect(provider.getTasks).toHaveBeenCalledWith('native-1', 'Inbox', { status: 'notStarted' });
    expect(msTodo.getDefaultList).not.toHaveBeenCalled();
    expect(result?.text).toContain('Native task');
  });

  it('uses the canonical Secretary reader for authenticated status callbacks', async () => {
    mockTrySecretaryFastpath.mockResolvedValueOnce({
      matched: true,
      patternId: 'status_overview',
      response: {
        domain: 'secretary',
        text: '<b>Plan Status</b>\n📅 Agenda today: 2 commitments\n📧 Inbox: 9 unread',
      },
    });

    const result = await tryDeterministicChatCommand('/status', 42, 42);

    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(42, '/status', undefined, 42);
    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
    expect(result?.text).toContain('2 commitments');
    expect(result?.text).toContain('9 unread');
  });

  it('rejects a mismatched callback scope before planner or provider reads', async () => {
    await expect(tryDeterministicChatCommand('/status', 42, 43)).rejects.toMatchObject({
      code: 'TENANT_SCOPE_MISMATCH',
    });

    expect(mockTrySecretaryFastpath).not.toHaveBeenCalled();
    expect(mockGetTaskProviderForUser).not.toHaveBeenCalled();
  });
});
