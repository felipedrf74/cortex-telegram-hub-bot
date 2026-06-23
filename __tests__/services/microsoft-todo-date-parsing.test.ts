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

  it('realigns recurrence on due-date PATCH instead of creating a second task', async () => {
    const calls: Array<{ method: string; path: string; body?: any; headers?: Record<string, string> }> = [];
    const mockClient = createMutationMockClient(calls);
    (getGraphClient as any).mockReturnValue(mockClient);

    const { updateTask } = await import('../../src/services/microsoft-todo');
    const result = await updateTask(
      'list-1',
      'task-1',
      { dueDateTime: '2026-05-12T09:00:00.000Z', timeZone: 'UTC' },
      'Family',
    );

    expect(result.success).toBe(true);
    const patchCall = calls.find((call) => call.method === 'PATCH');
    expect(patchCall).toEqual(expect.objectContaining({
      path: '/me/todo/lists/list-1/tasks/task-1',
    }));
    expect(patchCall?.body).toEqual(expect.objectContaining({
      dueDateTime: { dateTime: '2026-05-12T09:00:00.000Z', timeZone: 'UTC' },
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['tuesday'] },
        range: { type: 'noEnd', startDate: '2026-05-12' },
      },
    }));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('stamps Nexus task identity into Microsoft create payload and does not retry create POST failures', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const mockClient = {
      api: (path: string) => ({
        post: async (body: any) => {
          calls.push({ method: 'POST', path, body });
          const err: any = new Error('Graph 503 after commit');
          err.statusCode = 503;
          throw err;
        },
      }),
    };
    (getGraphClient as any).mockReturnValue(mockClient);

    const { createTask } = await import('../../src/services/microsoft-todo');
    const result = await createTask(
      'list-1',
      'Family',
      { title: 'Write back safely', nexusTaskId: 'nexus-task-1' },
      { nexusTaskId: 'nexus-task-1', idempotencyKey: 'ms:key' },
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({
      method: 'POST',
      path: '/me/todo/lists/list-1/tasks',
      body: expect.objectContaining({
        linkedResources: [{
          applicationName: 'NexusHub',
          externalId: 'nexus-task-1',
          displayName: 'Write back safely',
        }],
      }),
    }));
  });

  it('sends If-Match on Microsoft update when provider version is known', async () => {
    const calls: Array<{ method: string; path: string; body?: any; headers?: Record<string, string> }> = [];
    const mockClient = createMutationMockClient(calls);
    (getGraphClient as any).mockReturnValue(mockClient);

    const { updateTask } = await import('../../src/services/microsoft-todo');
    const result = await updateTask(
      'list-1',
      'task-1',
      { title: 'Preconditioned update' },
      'Family',
      { ifMatch: 'etag-v1' },
    );

    expect(result.success).toBe(true);
    const patchCall = calls.find((call) => call.method === 'PATCH');
    expect(patchCall?.headers).toEqual({ 'If-Match': 'etag-v1' });
  });

  it('rolls back copied Microsoft task when list move cannot delete the source task', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const mockClient = createMoveRollbackMockClient(calls);
    (getGraphClient as any).mockReturnValue(mockClient);

    const { moveTask } = await import('../../src/services/microsoft-todo');
    const result = await moveTask('source-list', 'task-1', 'target-list', 'Target');

    expect(result.success).toBe(false);
    expect(calls).toEqual([
      expect.objectContaining({ method: 'GET', path: '/me/todo/lists/source-list/tasks/task-1' }),
      expect.objectContaining({ method: 'POST', path: '/me/todo/lists/target-list/tasks' }),
      expect.objectContaining({ method: 'DELETE', path: '/me/todo/lists/source-list/tasks/task-1' }),
      expect.objectContaining({ method: 'DELETE', path: '/me/todo/lists/target-list/tasks/copied-task' }),
    ]);
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

function createMutationMockClient(calls: Array<{ method: string; path: string; body?: any; headers?: Record<string, string> }>) {
  return {
    api: (path: string) => {
      const requestHeaders: Record<string, string> = {};
      const chain: any = {
        get: async () => {
          calls.push({ method: 'GET', path });
          if (path === '/me/todo/lists/list-1/tasks/task-1') {
            return {
              id: 'task-1',
              title: 'Take supplement',
              status: 'notStarted',
              importance: 'normal',
              dueDateTime: { dateTime: '2026-05-11T09:00:00.0000000', timeZone: 'UTC' },
              recurrence: {
                pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
                range: { type: 'noEnd', startDate: '2026-05-11' },
              },
              createdDateTime: '2026-05-01T10:00:00.000Z',
            };
          }
          return { value: [] };
        },
        patch: async (body: any) => {
          calls.push({ method: 'PATCH', path, body, headers: { ...requestHeaders } });
          return {
            id: 'task-1',
            title: 'Take supplement',
            status: 'notStarted',
            importance: 'normal',
            dueDateTime: body.dueDateTime,
            recurrence: body.recurrence,
            createdDateTime: '2026-05-01T10:00:00.000Z',
          };
        },
        post: async (body: any) => {
          calls.push({ method: 'POST', path, body, headers: { ...requestHeaders } });
          return {};
        },
        query: () => chain,
        header: (name: string, value: string) => {
          requestHeaders[name] = value;
          return chain;
        },
        headers: (values: Record<string, string>) => {
          Object.assign(requestHeaders, values);
          return chain;
        },
      };
      return chain;
    },
  };
}

function createMoveRollbackMockClient(calls: Array<{ method: string; path: string; body?: any }>) {
  return {
    api: (path: string) => {
      const chain: any = {
        get: async () => {
          calls.push({ method: 'GET', path });
          return {
            id: 'task-1',
            title: 'Move me',
            status: 'notStarted',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-05-11T09:00:00.0000000', timeZone: 'UTC' },
            createdDateTime: '2026-05-01T10:00:00.000Z',
          };
        },
        post: async (body: any) => {
          calls.push({ method: 'POST', path, body });
          return {
            id: 'copied-task',
            title: body.title,
            status: body.status,
            importance: body.importance,
            dueDateTime: body.dueDateTime,
            createdDateTime: '2026-05-01T10:00:00.000Z',
          };
        },
        delete: async () => {
          calls.push({ method: 'DELETE', path });
          if (path === '/me/todo/lists/source-list/tasks/task-1') {
            throw new Error('source delete failed');
          }
          return {};
        },
      };
      return chain;
    },
  };
}
