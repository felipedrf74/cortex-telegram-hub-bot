// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for the MS Graph dueDateTime parsing fix.
 *
 * The bug: MS Graph returns due dates as { dateTime, timeZone } where
 * dateTime is missing the Z suffix and uses 7 fractional second digits.
 * Without normalization, JavaScript parses the string as local time, which
 * causes today's tasks (due "April 6 00:00 Lisbon" stored as
 * "2026-04-05T23:00:00 UTC") to be misclassified as overdue from the
 * perspective of a server in Europe/Lisbon.
 *
 * After the fix in parseTask, the dueDateTime field is a clean ISO 8601
 * UTC string that all consumers (iOS endpoints, Telegram bot, Apple's
 * ISO8601DateFormatter) can correctly interpret.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We can't import parseTask directly (it's not exported), so we test the
// behavior through getAllPendingTasks which calls parseTask internally.
// Mock the auth and HTTP layer.
vi.mock('../../src/services/microsoft-auth', () => ({
  getGraphClient: vi.fn(),
  isMicrosoftConfigured: vi.fn(() => true),
}));

import { getGraphClient } from '../../src/services/microsoft-auth';

describe('MS Graph dueDateTime normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends Z to UTC dateTime values that lack a timezone designator', async () => {
    const mockClient = createMockClient([
      { id: 'list-1', displayName: 'Family' },
    ], {
      'list-1': [
        {
          id: 'task-1',
          title: 'Pay rent',
          status: 'notStarted',
          importance: 'normal',
          dueDateTime: { dateTime: '2026-04-05T23:00:00.0000000', timeZone: 'UTC' },
          createdDateTime: '2025-12-01T10:00:00.000Z',
        },
      ],
    });
    (getGraphClient as any).mockReturnValue(mockClient);

    const { getAllPendingTasks } = await import('../../src/services/microsoft-todo');
    const result = await getAllPendingTasks();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    // The dueDateTime must be a UTC ISO 8601 string with Z, NOT a bare datetime
    expect(result.data[0].dueDateTime).toBe('2026-04-05T23:00:00Z');
  });

  it('strips non-standard 7-digit fractional seconds', async () => {
    const mockClient = createMockClient([
      { id: 'list-1', displayName: 'Family' },
    ], {
      'list-1': [
        {
          id: 'task-1',
          title: 'Test',
          status: 'notStarted',
          importance: 'normal',
          dueDateTime: { dateTime: '2026-04-05T23:00:00.0000000', timeZone: 'UTC' },
          createdDateTime: '2025-12-01T10:00:00.000Z',
        },
      ],
    });
    (getGraphClient as any).mockReturnValue(mockClient);

    const { getAllPendingTasks } = await import('../../src/services/microsoft-todo');
    const result = await getAllPendingTasks();

    // Apple's ISO8601DateFormatter rejects more than 3 fractional digits.
    // Verify the cleaned string has no fractional seconds.
    expect(result.data[0].dueDateTime).not.toContain('.0000000');
    expect(result.data[0].dueDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('the parsed UTC string converts to the correct Lisbon date', async () => {
    const mockClient = createMockClient([
      { id: 'list-1', displayName: 'Family' },
    ], {
      'list-1': [
        {
          id: 'task-1',
          title: 'Due April 6 in MS Todo UI',
          status: 'notStarted',
          importance: 'normal',
          // MS Todo "Due April 6" stores this as midnight April 6 Lisbon = 23:00 April 5 UTC
          dueDateTime: { dateTime: '2026-04-05T23:00:00.0000000', timeZone: 'UTC' },
          createdDateTime: '2025-12-01T10:00:00.000Z',
        },
      ],
    });
    (getGraphClient as any).mockReturnValue(mockClient);

    const { getAllPendingTasks } = await import('../../src/services/microsoft-todo');
    const result = await getAllPendingTasks();

    const due = result.data[0].dueDateTime!;
    const lisbonDate = new Date(due).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
    // The user is in Lisbon and sees "Due April 6" in MS Todo. Our parsed
    // string must convert back to April 6 in Lisbon, NOT April 5.
    expect(lisbonDate).toBe('2026-04-06');
  });

  it('also normalizes reminderDateTime and completedDateTime', async () => {
    const mockClient = createMockClient([
      { id: 'list-1', displayName: 'Family' },
    ], {
      'list-1': [
        {
          id: 'task-1',
          title: 'Test',
          status: 'notStarted',
          importance: 'normal',
          dueDateTime: { dateTime: '2026-04-06T00:00:00.0000000', timeZone: 'UTC' },
          reminderDateTime: { dateTime: '2026-04-06T07:30:00.0000000', timeZone: 'UTC' },
          completedDateTime: { dateTime: '2026-04-06T10:15:00.0000000', timeZone: 'UTC' },
          createdDateTime: '2025-12-01T10:00:00.000Z',
        },
      ],
    });
    (getGraphClient as any).mockReturnValue(mockClient);

    const { getAllPendingTasks } = await import('../../src/services/microsoft-todo');
    const result = await getAllPendingTasks();

    expect(result.data[0].dueDateTime).toBe('2026-04-06T00:00:00Z');
    expect(result.data[0].reminderDateTime).toBe('2026-04-06T07:30:00Z');
    expect(result.data[0].completedDateTime).toBe('2026-04-06T10:15:00Z');
  });

  it('returns undefined for missing dateTimes', async () => {
    const mockClient = createMockClient([
      { id: 'list-1', displayName: 'Family' },
    ], {
      'list-1': [
        {
          id: 'task-1',
          title: 'No due date',
          status: 'notStarted',
          importance: 'normal',
          createdDateTime: '2025-12-01T10:00:00.000Z',
        },
      ],
    });
    (getGraphClient as any).mockReturnValue(mockClient);

    const { getAllPendingTasks } = await import('../../src/services/microsoft-todo');
    const result = await getAllPendingTasks();

    expect(result.data[0].dueDateTime).toBeUndefined();
    expect(result.data[0].reminderDateTime).toBeUndefined();
    expect(result.data[0].completedDateTime).toBeUndefined();
  });
});

// ── Test helpers ────────────────────────────────────────────────────

function createMockClient(
  lists: Array<{ id: string; displayName: string }>,
  tasksByList: Record<string, any[]>,
) {
  return {
    api: (path: string) => {
      const chain: any = {
        get: async () => {
          if (path === '/me/todo/lists') {
            return { value: lists };
          }
          const match = path.match(/\/me\/todo\/lists\/([^/]+)\/tasks/);
          if (match) {
            return { value: tasksByList[match[1]] || [] };
          }
          return { value: [] };
        },
        filter: () => chain,
        top: () => chain,
        orderby: () => chain,
        select: () => chain,
        count: () => chain,
        query: () => chain,
        header: () => chain,
        headers: () => chain,
        version: () => chain,
        responseType: () => chain,
      };
      return chain;
    },
  };
}
