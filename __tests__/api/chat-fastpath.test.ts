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
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
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
import { getActiveReminders } from '../../src/state/reminders';
import { getEvents, hasConnectedCalendarForUser } from '../../src/services/unified-calendar';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../../src/services/unified-mail-pressure';

describe('Chat Fast-Path Command Interceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskProviderForUser.mockReset();
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
    const result = await tryDeterministicChatCommand('/day');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Today task');
  });

  it('handles /week overview', async () => {
    const result = await tryDeterministicChatCommand('/week');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Week');
  });

  it('handles /status overview', async () => {
    const result = await tryDeterministicChatCommand('/status');
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Status');
    expect(result?.text).toContain('Microsoft To Do');
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

  it('uses scoped reminders and calendar data for authenticated /status', async () => {
    const provider = {
      getDefaultList: vi.fn(),
      getTasks: vi.fn(),
      getLists: vi.fn(),
      getAllPendingTasks: vi.fn(async () => ({
        success: true,
        data: [
          { id: 't1', title: 'Scoped task', listName: 'Inbox', listId: 'list-1', status: 'notStarted', importance: 'high' },
        ],
      })),
      getTasksDueInRange: vi.fn(),
    };
    mockGetTaskProviderForUser.mockReturnValue(provider);
    vi.mocked(hasConnectedCalendarForUser).mockReturnValue(true);
    vi.mocked(getEvents).mockResolvedValue([
      {
        id: 'e1',
        summary: 'Scoped meeting',
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        source: 'google',
      } as any,
    ]);
    vi.mocked(getActiveReminders).mockReturnValue([
      { id: 1, user_id: 42, message: 'Scoped reminder', remind_at: new Date().toISOString(), status: 'active' } as any,
    ]);

    const result = await tryDeterministicChatCommand('/status', 42);

    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(42);
    expect(getActiveReminders).toHaveBeenCalledWith(42);
    expect(hasConnectedCalendarForUser).toHaveBeenCalledWith(42);
    expect(getEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 42);
    expect(result?.text).toContain('Active reminders: 1');
    expect(result?.text).toContain('Events today: 1');
  });

  it('uses unified Gmail and Outlook unread pressure for authenticated /status', async () => {
    const provider = {
      getDefaultList: vi.fn(),
      getTasks: vi.fn(),
      getLists: vi.fn(),
      getAllPendingTasks: vi.fn(async () => ({ success: true, data: [] })),
      getTasksDueInRange: vi.fn(),
    };
    mockGetTaskProviderForUser.mockReturnValue(provider);
    vi.mocked(isAnyMailConfiguredForUser).mockReturnValue(true);
    vi.mocked(getUnreadMailSummaryForUser).mockResolvedValue({
      totalUnread: 9,
      outlookUnread: 4,
      gmailUnread: 5,
      configuredProviders: ['outlook', 'gmail'],
    });

    const result = await tryDeterministicChatCommand('/status', 42);

    expect(isAnyMailConfiguredForUser).toHaveBeenCalledWith(42);
    expect(getUnreadMailSummaryForUser).toHaveBeenCalledWith(42);
    expect(result?.text).toContain('Inbox unread: 9');
    expect(result?.text).toContain('Outlook 4');
    expect(result?.text).toContain('Gmail 5');
  });
});
