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

vi.mock('../../src/services/unified-calendar', () => ({
  isAnyCalendarConfigured: vi.fn(() => false),
  getEvents: vi.fn(async () => []),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(() => false),
  getUnreadCount: vi.fn(async () => 0),
}));

vi.mock('../../src/state/reminders', () => ({
  getActiveReminders: vi.fn(() => []),
}));

import { tryDeterministicChatCommand } from '../../src/api/routes/chat-fastpath';

describe('Chat Fast-Path Command Interceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
