/**
 * Microsoft To Do delta pull mode (M6, flag TASK_MS_DELTA_SYNC).
 *
 * Cursor lifecycle against a scripted Graph client: first pull stores whole
 * deltaLink URLs in the composite cursor; the second pull replays them;
 * 410/syncStateNotFound trigger LIST-scoped resyncs (Location honored);
 * `@removed` rows surface on the removals channel; partial rows merge by id
 * onto known local state; and failed lists preserve their unadvanced cursor
 * entries. Flag-off asserts the byte-identical full-pull contract.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

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
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => true),
}));

const graph = vi.hoisted(() => ({
  getGraphClientForUser: vi.fn(),
}));
vi.mock('../../../src/services/microsoft-auth', () => ({
  getGraphClientForUser: (...args: unknown[]) => graph.getGraphClientForUser(...args),
}));

import { MicrosoftTodoAdapter, __testing } from '../../../src/services/task-store/microsoft-todo-adapter';

const USER_ID = 7;
const LISTS_KEY = __testing.MS_LISTS_DELTA_CURSOR_KEY;

type Responder = (url: string) => any;

/**
 * Scripted Graph client: every api(url).get() goes through the responder;
 * requested URLs are recorded for cursor-replay assertions. Throw an object
 * from the responder to simulate Graph errors.
 */
function makeClient() {
  const requested: string[] = [];
  const responders: Responder[] = [];
  const client = {
    api(url: string) {
      const request: any = {
        _url: url,
        query() { return request; },
        async get() {
          requested.push(url);
          for (const responder of responders) {
            const result = responder(url);
            if (result !== undefined) {
              if (result instanceof Error || (result && typeof result === 'object' && result.__throw)) {
                throw result.__throw ?? result;
              }
              return result;
            }
          }
          throw new Error(`No scripted response for ${url}`);
        },
      };
      return request;
    },
  };
  return {
    client,
    requested,
    respond(responder: Responder) { responders.push(responder); },
  };
}

const LIST_A = { provider: 'ms_todo' as const, externalId: 'list-a', name: 'Alpha', isDefault: true, taskCount: 0 };
const LIST_B = { provider: 'ms_todo' as const, externalId: 'list-b', name: 'Beta', isDefault: false, taskCount: 0 };

function deltaUrlFor(listId: string): string {
  return `/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
}

function deltaLinkFor(listId: string, token: string): string {
  return `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks/delta?$deltatoken=${token}`;
}

const LISTS_DELTA_URL = '/me/todo/lists/delta';
const LISTS_DELTA_LINK = 'https://graph.microsoft.com/v1.0/me/todo/lists/delta?$deltatoken=lists-1';

let adapter: MicrosoftTodoAdapter;

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  vi.clearAllMocks();
  vi.stubEnv('TASK_MS_DELTA_SYNC', '1');
  adapter = new MicrosoftTodoAdapter();
});

afterEach(() => {
  vi.unstubAllEnvs();
  testDb?.close();
});

describe('flag gating', () => {
  it('keeps the full-pull contract byte-identical while the flag is off', async () => {
    vi.stubEnv('TASK_MS_DELTA_SYNC', '0');
    expect(adapter.capabilities.hasIncrementalSync).toBe(false);

    const { client, requested, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    respond((url) => (url === `/me/todo/lists/${LIST_A.externalId}/tasks`
      ? { value: [{ id: 'ms-1', title: 'Full pull task', status: 'notStarted' }] }
      : undefined));

    const result = await adapter.getTasks(USER_ID, { knownProjects: [LIST_A] });

    expect(requested.every((url) => !url.includes('/delta'))).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(result.removals).toBeUndefined();
    expect(result.tasks.map((task) => task.externalId)).toEqual(['ms-1']);
  });

  it('advertises incremental sync while the flag is on', () => {
    expect(adapter.capabilities.hasIncrementalSync).toBe(true);
  });
});

describe('delta cursor lifecycle', () => {
  it('first pull walks fresh delta feeds and stores whole deltaLink URLs per list plus the lists feed', async () => {
    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === deltaUrlFor('list-a')) {
        return {
          value: [{ id: 'ms-a1', title: 'Task A1', status: 'notStarted' }],
          '@odata.nextLink': 'https://graph.microsoft.com/next-a',
        };
      }
      if (url === 'https://graph.microsoft.com/next-a') {
        return {
          value: [{ id: 'ms-a2', title: 'Task A2', status: 'notStarted' }],
          '@odata.deltaLink': deltaLinkFor('list-a', 'a1'),
        };
      }
      if (url === deltaUrlFor('list-b')) {
        return { value: [], '@odata.deltaLink': deltaLinkFor('list-b', 'b1') };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, { knownProjects: [LIST_A, LIST_B] });

    expect(result.tasks.map((task) => task.externalId)).toEqual(['ms-a1', 'ms-a2']);
    expect(result.incomplete).toBeFalsy();
    const cursor = JSON.parse(result.nextCursor || '{}');
    expect(cursor).toEqual({
      [LISTS_KEY]: LISTS_DELTA_LINK,
      'list-a': deltaLinkFor('list-a', 'a1'),
      'list-b': deltaLinkFor('list-b', 'b1'),
    });
  });

  it('second pull replays the stored deltaLink URLs instead of fresh feeds', async () => {
    const { client, requested, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const cursor = JSON.stringify({
      [LISTS_KEY]: LISTS_DELTA_LINK,
      'list-a': deltaLinkFor('list-a', 'a1'),
    });
    respond((url) => {
      if (url === LISTS_DELTA_LINK) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === deltaLinkFor('list-a', 'a1')) {
        return {
          value: [{ id: 'ms-a1', status: 'completed', title: 'Task A1' }],
          '@odata.deltaLink': deltaLinkFor('list-a', 'a2'),
        };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A],
      sinceCursor: cursor,
    });

    expect(requested).toContain(deltaLinkFor('list-a', 'a1'));
    expect(requested).toContain(LISTS_DELTA_LINK);
    expect(requested).not.toContain(deltaUrlFor('list-a'));
    expect(JSON.parse(result.nextCursor || '{}')['list-a']).toBe(deltaLinkFor('list-a', 'a2'));
  });

  it('preserves the unadvanced cursor entry when a list delta fails mid-pull', async () => {
    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'a1');
    const priorB = deltaLinkFor('list-b', 'b1');
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        const err: any = new Error('boom 500');
        err.statusCode = 500;
        return { __throw: err };
      }
      if (url === priorB) {
        return { value: [], '@odata.deltaLink': deltaLinkFor('list-b', 'b2') };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A, LIST_B],
      sinceCursor: JSON.stringify({ 'list-a': priorA, 'list-b': priorB }),
    });

    expect(result.incomplete).toBe(true);
    expect(result.errors?.[0]).toMatch(/delta pull failed for 1 feed/);
    const cursor = JSON.parse(result.nextCursor || '{}');
    // Failed list keeps its unadvanced deltaLink; the healthy list advanced.
    expect(cursor['list-a']).toBe(priorA);
    expect(cursor['list-b']).toBe(deltaLinkFor('list-b', 'b2'));
  });
});

describe('delta removals and resync', () => {
  it('surfaces @removed tasks on the removals channel instead of the task list', async () => {
    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'a1');
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        return {
          value: [
            { id: 'ms-gone', '@removed': { reason: 'deleted' } },
            { id: 'ms-live', title: 'Still here', status: 'notStarted' },
          ],
          '@odata.deltaLink': deltaLinkFor('list-a', 'a2'),
        };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A],
      sinceCursor: JSON.stringify({ 'list-a': priorA }),
    });

    expect(result.tasks.map((task) => task.externalId)).toEqual(['ms-live']);
    expect(result.removals).toEqual([
      { kind: 'task', externalId: 'ms-gone', listId: 'list-a' },
    ]);
  });

  it('surfaces @removed lists as project removals and skips their task feeds', async () => {
    const { client, requested, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    respond((url) => {
      if (url === LISTS_DELTA_URL) {
        return {
          value: [{ id: 'list-b', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': LISTS_DELTA_LINK,
        };
      }
      if (url === deltaUrlFor('list-a')) {
        return { value: [], '@odata.deltaLink': deltaLinkFor('list-a', 'a1') };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, { knownProjects: [LIST_A, LIST_B] });

    expect(result.removals).toEqual([{ kind: 'project', externalId: 'list-b' }]);
    expect(requested).not.toContain(deltaUrlFor('list-b'));
  });

  it('runs a LIST-scoped resync honoring the 410 Location URL', async () => {
    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'expired');
    const priorB = deltaLinkFor('list-b', 'b1');
    const resyncUrl = 'https://graph.microsoft.com/v1.0/me/todo/lists/list-a/tasks/delta?$deltatoken=resync';
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        const err: any = new Error('Gone');
        err.statusCode = 410;
        err.headers = { location: resyncUrl };
        return { __throw: err };
      }
      if (url === resyncUrl) {
        return {
          value: [{ id: 'ms-a1', title: 'Survivor', status: 'notStarted' }],
          '@odata.deltaLink': deltaLinkFor('list-a', 'fresh'),
        };
      }
      if (url === priorB) return { value: [], '@odata.deltaLink': priorB };
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A, LIST_B],
      sinceCursor: JSON.stringify({ 'list-a': priorA, 'list-b': priorB }),
    });

    // Only list-a resynced; list-b stayed incremental.
    expect(result.resyncedListIds).toEqual(['list-a']);
    expect(result.incomplete).toBeFalsy();
    expect(result.tasks.map((task) => task.externalId)).toEqual(['ms-a1']);
    expect(JSON.parse(result.nextCursor || '{}')['list-a']).toBe(deltaLinkFor('list-a', 'fresh'));
  });

  it('resyncs from a fresh feed on syncStateNotFound error codes', async () => {
    const { client, requested, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'lost');
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        const err: any = new Error('SyncStateNotFound');
        err.statusCode = 400;
        err.code = 'syncStateNotFound';
        return { __throw: err };
      }
      if (url === deltaUrlFor('list-a')) {
        return { value: [], '@odata.deltaLink': deltaLinkFor('list-a', 'fresh') };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A],
      sinceCursor: JSON.stringify({ 'list-a': priorA }),
    });

    expect(requested).toContain(deltaUrlFor('list-a'));
    expect(result.resyncedListIds).toEqual(['list-a']);
    expect(JSON.parse(result.nextCursor || '{}')['list-a']).toBe(deltaLinkFor('list-a', 'fresh'));
  });
});

describe('partial delta rows', () => {
  it('merges partial rows by id onto known raw provider state', async () => {
    // Known full Graph payload in the local store.
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_name, title, status,
         priority, tags, provider_data, synced_at, nexus_task_id
       ) VALUES (?, ?, 'ms_todo', 'ms-a1', 'Alpha', 'Known Title', 'pending', 2, '[]', ?, datetime('now'), 'task_known_a1')`,
    ).run(USER_ID, USER_ID, JSON.stringify({
      id: 'ms-a1',
      title: 'Known Title',
      status: 'notStarted',
      importance: 'high',
      listId: 'list-a',
    }));

    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'a1');
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        return {
          // Partial row: only the changed member came down the delta feed.
          value: [{ id: 'ms-a1', status: 'completed' }],
          '@odata.deltaLink': deltaLinkFor('list-a', 'a2'),
        };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A],
      sinceCursor: JSON.stringify({ 'list-a': priorA }),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      externalId: 'ms-a1',
      title: 'Known Title',
      status: 'completed',
      priority: 3,
    });
  });

  it('lets unknown rows stand alone (no merge base)', async () => {
    const { client, respond } = makeClient();
    graph.getGraphClientForUser.mockReturnValue(client);
    const priorA = deltaLinkFor('list-a', 'a1');
    respond((url) => {
      if (url === LISTS_DELTA_URL) return { value: [], '@odata.deltaLink': LISTS_DELTA_LINK };
      if (url === priorA) {
        return {
          value: [{ id: 'ms-new', title: 'Fresh task', status: 'notStarted' }],
          '@odata.deltaLink': deltaLinkFor('list-a', 'a2'),
        };
      }
      return undefined;
    });

    const result = await adapter.getTasks(USER_ID, {
      knownProjects: [LIST_A],
      sinceCursor: JSON.stringify({ 'list-a': priorA }),
    });

    expect(result.tasks[0]).toMatchObject({ externalId: 'ms-new', title: 'Fresh task' });
  });
});

describe('delta helper units', () => {
  it('parses only string-valued cursor entries and tolerates junk', () => {
    expect(__testing.parseMsDeltaCursor(undefined)).toEqual({});
    expect(__testing.parseMsDeltaCursor('not json')).toEqual({});
    expect(__testing.parseMsDeltaCursor('[1,2]')).toEqual({});
    expect(__testing.parseMsDeltaCursor(JSON.stringify({ a: 'x', b: 7, c: '' }))).toEqual({ a: 'x' });
  });

  it('merge keeps the delta row alone when the base is not Graph-shaped', () => {
    expect(__testing.mergeDeltaRow(undefined, { id: '1', title: 'D' } as any)).toEqual({ id: '1', title: 'D' });
    expect(__testing.mergeDeltaRow({ recurrence: null } as any, { id: '1', title: 'D' } as any))
      .toEqual({ id: '1', title: 'D' });
    expect(__testing.mergeDeltaRow(
      { id: '1', title: 'Base', importance: 'low' } as any,
      { id: '1', status: 'completed' } as any,
    )).toEqual({ id: '1', title: 'Base', importance: 'low', status: 'completed' });
  });

  it('classifies expired sync state from status and error codes', () => {
    expect(__testing.isGraphSyncStateExpired({ statusCode: 410 })).toBe(true);
    expect(__testing.isGraphSyncStateExpired({ code: 'syncStateNotFound' })).toBe(true);
    expect(__testing.isGraphSyncStateExpired({ message: 'ResyncRequired by service' })).toBe(true);
    expect(__testing.isGraphSyncStateExpired({ statusCode: 500 })).toBe(false);
  });

  it('extracts the resync Location from header variants', () => {
    expect(__testing.graphResyncLocation({ headers: { Location: 'https://x/resync' } })).toBe('https://x/resync');
    expect(__testing.graphResyncLocation({
      response: { headers: { get: (name: string) => (name === 'location' ? 'https://y/resync' : null) } },
    })).toBe('https://y/resync');
    expect(__testing.graphResyncLocation({})).toBeNull();
  });
});
