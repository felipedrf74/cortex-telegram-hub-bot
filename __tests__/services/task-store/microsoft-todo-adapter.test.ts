import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGraphClientForUser: vi.fn(),
  isConnected: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/services/microsoft-auth', () => ({
  getGraphClientForUser: mocks.getGraphClientForUser,
}));

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: mocks.isConnected,
}));

vi.mock('../../../src/config', () => ({
  config: {
    app: { timezone: 'UTC' },
  },
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mocks.logger,
  LOGGER_REDACTION_PATHS: [],
}));

import { MicrosoftTodoAdapter, __testing } from '../../../src/services/task-store/microsoft-todo-adapter';

type MockGraphClient = {
  calls: Array<{ path: string; query?: Record<string, string> }>;
  api: (path: string) => {
    query: (query: Record<string, string>) => any;
    get: () => Promise<any>;
    post: (body: any) => Promise<any>;
    patch: (body: any) => Promise<any>;
    delete: () => Promise<any>;
  };
};

function makeGraphClient(responses: Record<string, any>): MockGraphClient {
  const calls: MockGraphClient['calls'] = [];
  return {
    calls,
    api(path: string) {
      const request = {
        query(query: Record<string, string>) {
          calls.push({ path, query });
          return request;
        },
        async get() {
          if (!calls.some((call) => call.path === path)) calls.push({ path });
          const response = responses[path];
          if (response instanceof Error) throw response;
          return response ?? { value: [] };
        },
        async post(body: any) {
          calls.push({ path, query: body });
          const response = responses[`POST ${path}`];
          if (response instanceof Error) throw response;
          return response ?? { id: 'created-task', title: body.title };
        },
        async patch(body: any) {
          calls.push({ path, query: body });
          const response = responses[`PATCH ${path}`];
          if (response instanceof Error) throw response;
          return response ?? {};
        },
        async delete() {
          calls.push({ path });
          const response = responses[`DELETE ${path}`];
          if (response instanceof Error) throw response;
          return response ?? {};
        },
      };
      return request;
    },
  };
}

beforeEach(() => {
  mocks.getGraphClientForUser.mockReset();
  mocks.isConnected.mockReset();
  mocks.logger.debug.mockReset();
  mocks.logger.error.mockReset();
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
});

describe('MicrosoftTodoAdapter', () => {
  it('uses Outlook OAuth connectivity for Microsoft To Do', () => {
    mocks.isConnected.mockReturnValue(true);

    const adapter = new MicrosoftTodoAdapter();

    expect(adapter.isConnected(42)).toBe(true);
    expect(mocks.isConnected).toHaveBeenCalledWith(42, 'outlook');
  });

  it('maps Microsoft To Do lists to normalized projects', async () => {
    const client = makeGraphClient({
      '/me/todo/lists': {
        value: [
          { id: 'list-default', displayName: 'Tasks', wellknownListName: 'defaultList' },
          { id: 'list-work', displayName: 'Work' },
        ],
      },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const projects = await adapter.getProjects(42);

    expect(mocks.getGraphClientForUser).toHaveBeenCalledWith(42);
    expect(projects).toEqual([
      expect.objectContaining({
        provider: 'ms_todo',
        externalId: 'list-default',
        name: 'Tasks',
        isDefault: true,
      }),
      expect.objectContaining({
        provider: 'ms_todo',
        externalId: 'list-work',
        name: 'Work',
        isDefault: false,
      }),
    ]);
  });

  it('pulls every Microsoft To Do list into normalized tasks with provider list metadata', async () => {
    const client = makeGraphClient({
      '/me/todo/lists': {
        value: [
          { id: 'list-default', displayName: 'Tasks', wellknownListName: 'defaultList' },
          { id: 'list-work', displayName: 'Work' },
        ],
      },
      '/me/todo/lists/list-default/tasks': {
        value: [
          {
            id: 'task-1',
            title: 'Prepare plan',
            body: { content: 'Draft notes' },
            status: 'inProgress',
            importance: 'high',
            dueDateTime: { dateTime: '2026-06-24T09:00:00.0000000', timeZone: 'UTC' },
            completedDateTime: null,
            checklistItems: [{ id: 'check-1', displayName: 'Outline', isChecked: true }],
            '@odata.etag': 'etag-1',
            lastModifiedDateTime: '2026-06-23T20:00:00Z',
          },
        ],
      },
      '/me/todo/lists/list-work/tasks': {
        value: [
          {
            id: 'task-2',
            title: 'Completed thing',
            status: 'completed',
            importance: 'low',
            completedDateTime: { dateTime: '2026-06-23T10:00:00.0000000', timeZone: 'UTC' },
          },
        ],
      },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const result = await adapter.getTasks(42);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        provider: 'ms_todo',
        externalId: 'task-1',
        projectName: 'Tasks',
        title: 'Prepare plan',
        description: 'Draft notes',
        status: 'in_progress',
        priority: 3,
        dueDate: '2026-06-24T09:00:00Z',
        dueIsDatetime: true,
        checklistItems: [{ id: 'check-1', displayName: 'Outline', isChecked: true }],
        providerData: expect.objectContaining({
          listId: 'list-default',
          listName: 'Tasks',
          etag: 'etag-1',
        }),
      }),
      expect.objectContaining({
        provider: 'ms_todo',
        externalId: 'task-2',
        projectName: 'Work',
        status: 'completed',
        priority: 1,
        completedAt: '2026-06-23T10:00:00Z',
      }),
    ]);
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/me/todo/lists/list-default/tasks',
        query: expect.objectContaining({
          $top: '100',
          $expand: 'checklistItems,linkedResources',
        }),
      }),
      expect.objectContaining({
        path: '/me/todo/lists/list-work/tasks',
        query: expect.objectContaining({
          $top: '100',
          $expand: 'checklistItems,linkedResources',
        }),
      }),
    ]));
  });

  it('normalizes Graph timestamps without seven-digit fractions', () => {
    expect(__testing.normalizeMsGraphDateTime({
      dateTime: '2026-06-24T09:00:00.1234567',
      timeZone: 'UTC',
    })).toBe('2026-06-24T09:00:00Z');
  });

  it('bounds stalled Microsoft Graph requests with a timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = expect(
        __testing.withTimeout(new Promise(() => undefined), 'Graph fixture', 5),
      ).rejects.toMatchObject({
        message: 'Graph fixture timed out',
        code: 'ETIMEDOUT',
      });
      await vi.advanceTimersByTimeAsync(5);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('is registered lazily by the task sync engine for provider imports', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/services/task-store/sync-engine.ts'), 'utf8');

    expect(source).toContain("require('./microsoft-todo-adapter')");
    expect(source).toContain('registerAdapter(new MicrosoftTodoAdapter())');
    expect(source).toContain('ensureBuiltInAdaptersRegistered()');
  });
});
