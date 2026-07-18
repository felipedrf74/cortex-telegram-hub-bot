import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

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

// Real in-memory DB so the sync-engine integration test below can run the
// full syncProvider() path (unified-task-store writes) against this adapter.
let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
import {
  registerAdapter,
  syncProvider,
  _resetAdaptersForTests,
  _resetPollIntervalForTests,
} from '../../../src/services/task-store/sync-engine';

type MockGraphClient = {
  calls: Array<{ path: string; query?: Record<string, string> }>;
  /** Number of GET round-trips per path — `calls` dedupes repeats, this doesn't. */
  getCounts: Record<string, number>;
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
  const getCounts: MockGraphClient['getCounts'] = {};
  return {
    calls,
    getCounts,
    api(path: string) {
      let currentQuery: Record<string, string> | undefined;
      const request = {
        query(query: Record<string, string>) {
          currentQuery = query;
          calls.push({ path, query });
          return request;
        },
        async get() {
          getCounts[path] = (getCounts[path] || 0) + 1;
          if (!calls.some((call) => call.path === path)) calls.push({ path });
          // Query-specific responses (keyed "<path> <json-query>") let tests
          // distinguish the expanded fetch from its basic-fetch fallback.
          const queryKey = currentQuery ? `${path} ${JSON.stringify(currentQuery)}` : path;
          const response = Object.prototype.hasOwnProperty.call(responses, queryKey)
            ? responses[queryKey]
            : responses[path];
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
        // M10 inbound table: importance 'high' imports as P2 (P1 stays
        // user-assigned only — see task-priority.ts).
        priority: 2,
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
        // M10 inbound table: importance 'low' imports as P4.
        priority: 4,
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

  it('reports an incomplete pull when one Microsoft To Do list fetch fails', async () => {
    const client = makeGraphClient({
      '/me/todo/lists': {
        value: [
          { id: 'list-good', displayName: 'Rotina Matinal' },
          { id: 'list-failing', displayName: 'Work' },
        ],
      },
      '/me/todo/lists/list-good/tasks': {
        value: [{ id: 'task-supplement', title: 'Suplemento Matinal', status: 'notStarted' }],
      },
      '/me/todo/lists/list-failing/tasks': Object.assign(new Error('Graph timeout'), { statusCode: 503 }),
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const result = await adapter.getTasks(42);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        externalId: 'task-supplement',
        title: 'Suplemento Matinal',
        projectName: 'Rotina Matinal',
      }),
    ]);
    expect(result.incomplete).toBe(true);
    expect(result.errors).toEqual(['Microsoft To Do failed to fetch 1 list']);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, listId: 'list-failing' }),
      'Microsoft To Do adapter failed to fetch list tasks',
    );
  });

  it('falls back to a basic task pull when expanded Microsoft To Do list fetch fails', async () => {
    const path = '/me/todo/lists/list-routine/tasks';
    const expandedKey = `${path} ${JSON.stringify({
      $top: '100',
      $orderby: 'createdDateTime DESC',
      $expand: 'checklistItems,linkedResources',
    })}`;
    const basicKey = `${path} ${JSON.stringify({
      $top: '100',
      $orderby: 'createdDateTime DESC',
    })}`;
    const client = makeGraphClient({
      '/me/todo/lists': {
        value: [{ id: 'list-routine', displayName: 'Rotina Matinal' }],
      },
      [expandedKey]: Object.assign(new Error('Expand failed'), { statusCode: 503 }),
      [basicKey]: {
        value: [{
          id: 'task-supplement',
          title: 'Suplemento Matinal',
          status: 'notStarted',
          dueDateTime: { dateTime: '2026-06-23T09:00:00.0000000', timeZone: 'UTC' },
        }],
      },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const result = await adapter.getTasks(42);

    expect(result.incomplete).toBe(false);
    expect(result.errors).toBeUndefined();
    expect(result.tasks).toEqual([
      expect.objectContaining({
        externalId: 'task-supplement',
        title: 'Suplemento Matinal',
        projectName: 'Rotina Matinal',
        dueDate: '2026-06-23T09:00:00Z',
      }),
    ]);
    expect(client.getCounts[path]).toBe(3);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, listId: 'list-routine' }),
      'Microsoft To Do adapter expanded list fetch failed — retrying basic task fetch',
    );
  });

  // M10 (NEX-17): both direction tables pinned value-by-value. The outbound
  // table is the SHIPPED mapping — P2 MUST stay 'high' (a P2→normal change
  // would visibly demote every P2 task in Outlook). The inbound table is its
  // deliberate asymmetric inverse — 'high' imports as P2, never P1, so P1
  // stays user-assigned only (the upsert echo-stability rule protects a
  // stored P1 against its own 'high' echo).
  it('pins the outbound priority→Graph importance table (P1/P2→high, P3→normal, P4→low, none→normal)', () => {
    expect(__testing.priorityToGraphImportance(1)).toBe('high');
    expect(__testing.priorityToGraphImportance(2)).toBe('high');
    expect(__testing.priorityToGraphImportance(3)).toBe('normal');
    expect(__testing.priorityToGraphImportance(4)).toBe('low');
    expect(__testing.priorityToGraphImportance(0)).toBe('normal');
    // Absent field → omit importance from the Graph body entirely.
    expect(__testing.priorityToGraphImportance(undefined)).toBeUndefined();
    expect(__testing.priorityToGraphImportance(null)).toBeUndefined();
    expect(__testing.graphTaskBodyFromNormalized({ title: 'No priority change' })).not.toHaveProperty('importance');
    expect(__testing.graphTaskBodyFromNormalized({ priority: 0 })).toMatchObject({ importance: 'normal' });
    expect(__testing.graphTaskBodyFromNormalized({ priority: 1 })).toMatchObject({ importance: 'high' });
  });

  it('pins the inbound Graph importance→priority table (high→2, normal→3, low→4, unknown→0)', () => {
    expect(__testing.graphImportanceToPriority('high')).toBe(2);
    expect(__testing.graphImportanceToPriority('normal')).toBe(3);
    expect(__testing.graphImportanceToPriority('low')).toBe(4);
    expect(__testing.graphImportanceToPriority('')).toBe(0);
    expect(__testing.graphImportanceToPriority(undefined)).toBe(0);
    expect(__testing.graphImportanceToPriority('somethingOdd')).toBe(0);
  });

  it('maps inbound Graph reminderDateTime onto reminderAt, honoring isReminderOn:false (M13)', () => {
    const project = __testing.projectFromGraphList({ id: 'list-1', displayName: 'Inbox' });

    const withReminder = __testing.taskFromGraphTask({
      id: 'task-1',
      title: 'Call the vet',
      reminderDateTime: { dateTime: '2026-07-19T15:00:00.0000000', timeZone: 'UTC' },
      isReminderOn: true,
    }, project);
    expect(withReminder.reminderAt).toBe('2026-07-19T15:00:00Z');

    // isReminderOn:false is an explicit clear even when a stale dateTime remains.
    const cleared = __testing.taskFromGraphTask({
      id: 'task-2',
      title: 'Reminder switched off',
      reminderDateTime: { dateTime: '2026-07-19T15:00:00', timeZone: 'UTC' },
      isReminderOn: false,
    }, project);
    expect(cleared.reminderAt).toBeNull();

    // No reminder fields at all → null (nothing to schedule from).
    const none = __testing.taskFromGraphTask({ id: 'task-3', title: 'Bare task' }, project);
    expect(none.reminderAt).toBeNull();
  });

  it('serializes outbound reminderDateTime zone-naive with isReminderOn (M13/NEX-29)', () => {
    // A 'Z' instant beside a named timeZone is the contract violation M6 fixed
    // for due dates: the designator must be dropped and the wall clock expressed
    // in the named zone.
    const set = __testing.graphTaskBodyFromNormalized({ reminderAt: '2026-07-19T15:00:00Z' });
    expect(set.reminderDateTime).toEqual({ dateTime: '2026-07-19T15:00:00', timeZone: 'UTC' });
    expect(set.isReminderOn).toBe(true);

    // Explicit clear → null payload + isReminderOn:false.
    const cleared = __testing.graphTaskBodyFromNormalized({ reminderAt: null });
    expect(cleared.reminderDateTime).toBeNull();
    expect(cleared.isReminderOn).toBe(false);

    // Absent field → omit reminder entirely so a partial update leaves it alone.
    const untouched = __testing.graphTaskBodyFromNormalized({ title: 'no reminder change' });
    expect(untouched).not.toHaveProperty('reminderDateTime');
    expect(untouched).not.toHaveProperty('isReminderOn');
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

  it('reuses caller-provided projects in getTasks without re-fetching lists', async () => {
    const client = makeGraphClient({
      '/me/todo/lists/list-work/tasks': {
        value: [{ id: 'task-9', title: 'From known list' }],
      },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const result = await adapter.getTasks(42, {
      knownProjects: [{ provider: 'ms_todo', externalId: 'list-work', name: 'Work' }],
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ externalId: 'task-9', projectName: 'Work' }),
    ]);
    // The list catalogue was never fetched — knownProjects replaced it
    expect(client.getCounts['/me/todo/lists']).toBeUndefined();
    expect(client.getCounts['/me/todo/lists/list-work/tasks']).toBe(1);
  });

  it('still applies the projectId filter to caller-provided projects', async () => {
    const client = makeGraphClient({
      '/me/todo/lists/list-work/tasks': { value: [{ id: 'task-9', title: 'Kept' }] },
      '/me/todo/lists/list-home/tasks': { value: [{ id: 'task-8', title: 'Filtered out' }] },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    const adapter = new MicrosoftTodoAdapter();
    const result = await adapter.getTasks(42, {
      projectId: 'list-work',
      knownProjects: [
        { provider: 'ms_todo', externalId: 'list-work', name: 'Work' },
        { provider: 'ms_todo', externalId: 'list-home', name: 'Home' },
      ],
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ externalId: 'task-9' }),
    ]);
    expect(client.getCounts['/me/todo/lists/list-home/tasks']).toBeUndefined();
  });

  it('sync engine pull fetches the Microsoft To Do list catalogue exactly once', async () => {
    testDb = createMigratedTestDatabase();
    testDb.prepare('INSERT INTO users (id, telegram_id) VALUES (?, ?)').run(42, 42);

    mocks.isConnected.mockReturnValue(true);
    const client = makeGraphClient({
      '/me/todo/lists': {
        value: [
          { id: 'list-default', displayName: 'Tasks', wellknownListName: 'defaultList' },
          { id: 'list-work', displayName: 'Work' },
        ],
      },
      '/me/todo/lists/list-default/tasks': { value: [{ id: 'task-1', title: 'One' }] },
      '/me/todo/lists/list-work/tasks': { value: [{ id: 'task-2', title: 'Two' }] },
    });
    mocks.getGraphClientForUser.mockReturnValue(client);

    _resetAdaptersForTests();
    _resetPollIntervalForTests();
    registerAdapter(new MicrosoftTodoAdapter());
    const result = await syncProvider(42, 'ms_todo');

    expect(result.errors).toEqual([]);
    expect(result.tasksUpserted).toBe(2);
    // One list fetch for the whole sync — getTasks reused the engine's set
    expect(client.getCounts['/me/todo/lists']).toBe(1);
    expect(client.getCounts['/me/todo/lists/list-default/tasks']).toBe(1);
    expect(client.getCounts['/me/todo/lists/list-work/tasks']).toBe(1);
  });
});
