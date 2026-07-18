/**
 * Tests for src/services/task-store/sync-engine.ts
 *
 * Uses a hand-rolled MockAdapter that satisfies the TaskProviderAdapter
 * interface so we can verify orchestration without depending on any real
 * provider SDK or HTTP layer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../helpers/apply-migrations';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

let testDb: Database.Database;

// Mocks for the mutation-push path (task-mutation-sync-worker) so the
// "pushes still run while the poll gate skips the pull" test can exercise
// the real worker against the real migrated schema.
const workerMocks = vi.hoisted(() => ({
  oauthIsConnected: vi.fn(() => true),
  providerApi: {
    getTasks: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    deleteTask: vi.fn(),
    getChecklistItems: vi.fn(),
    addChecklistItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    deleteChecklistItem: vi.fn(),
  },
}));

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb,
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
  isConnected: workerMocks.oauthIsConnected,
}));
vi.mock('../../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(() => workerMocks.providerApi),
  resolveTaskProvider: vi.fn(() => 'nexus'),
}));

import {
  registerAdapter,
  getAdapter,
  syncProvider,
  syncAllProviders,
  taskSyncPollIntervalMinutes,
  _resetAdaptersForTests,
  _resetPollIntervalForTests,
} from '../../../src/services/task-store/sync-engine';
import { runTaskMutationSyncBatch } from '../../../src/services/task-store/task-mutation-sync-worker';
import { TaskProviderAdapter } from '../../../src/services/task-store/adapter-interface';
import {
  NormalizedProject,
  NormalizedTask,
  TaskProvider,
} from '../../../src/services/task-store/types';
import {
  getPendingTasks,
  getProjects,
  getSyncState,
} from '../../../src/services/task-store/unified-task-store';
import { setTaskListSyncSelection } from '../../../src/services/task-store/task-list-sync-selection';

const USER_ID = 7;

interface MockAdapterOptions {
  provider?: TaskProvider;
  connected?: boolean;
  hasIncrementalSync?: boolean;
  tasksByCall?: NormalizedTask[][];
  projects?: NormalizedProject[];
  cursorByCall?: (string | undefined)[];
  throwOnGetTasks?: boolean;
  incompleteByCall?: boolean[];
  errorsByCall?: string[][];
}

function makeMockAdapter(opts: MockAdapterOptions = {}): TaskProviderAdapter & {
  calls: number;
  projectCalls: number;
  lastGetTasksOptions?: { projectId?: string; sinceCursor?: string; knownProjects?: NormalizedProject[] };
} {
  const provider = opts.provider ?? 'todoist';
  const tasksByCall = opts.tasksByCall ?? [[]];
  const cursorByCall = opts.cursorByCall ?? [];
  const incompleteByCall = opts.incompleteByCall ?? [];
  const errorsByCall = opts.errorsByCall ?? [];
  let callIndex = 0;

  const adapter: any = {
    provider,
    calls: 0,
    projectCalls: 0,
    lastGetTasksOptions: undefined,
    capabilities: {
      canCreate: true,
      canComplete: true,
      canDelete: true,
      canUpdate: true,
      canAssignDue: true,
      hasWebhooks: false,
      hasIncrementalSync: opts.hasIncrementalSync ?? false,
    },
    isConnected: () => opts.connected ?? true,
    getProjects: async () => {
      adapter.projectCalls++;
      return opts.projects ?? [];
    },
    getTasks: async (_userId: number, options?: any) => {
      adapter.calls++;
      adapter.lastGetTasksOptions = options;
      if (opts.throwOnGetTasks) throw new Error('mock failure');
      const idx = Math.min(callIndex, tasksByCall.length - 1);
      const tasks = tasksByCall[idx] || [];
      const cursor = cursorByCall[idx];
      const incomplete = incompleteByCall[idx];
      const errors = errorsByCall[idx];
      callIndex++;
      return { tasks, nextCursor: cursor, incomplete, errors };
    },
    createTask: async (_userId: number, task: any) => ({ ...task, provider, externalId: `mock_${Date.now()}` }),
    completeTask: async () => undefined,
    deleteTask: async () => undefined,
  };
  return adapter;
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  // Migration 042 added FK on unified_*.user_id; pre-seed users so tests
  // can insert with arbitrary user IDs without FK violations.
  const seedUser = testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let i = 1; i <= 1000; i++) seedUser.run(i, i);
  _resetAdaptersForTests();
  // Disable the poll-interval gate by default so the pre-existing tests
  // keep exercising back-to-back full pulls; gate tests opt back in.
  process.env.TASK_SYNC_POLL_INTERVAL_MINUTES = '0';
  _resetPollIntervalForTests();
  workerMocks.oauthIsConnected.mockClear();
  workerMocks.oauthIsConnected.mockReturnValue(true);
  for (const fn of Object.values(workerMocks.providerApi)) fn.mockReset();
});

// ── registerAdapter / getAdapter ───────────────────────────────────

describe('adapter registry', () => {
  it('register makes the adapter retrievable', () => {
    const adapter = makeMockAdapter({ provider: 'todoist' });
    registerAdapter(adapter);
    expect(getAdapter('todoist')).toBe(adapter);
  });

  it('re-register overwrites previous adapter (for tests)', () => {
    const first = makeMockAdapter({ provider: 'todoist' });
    const second = makeMockAdapter({ provider: 'todoist' });
    registerAdapter(first);
    registerAdapter(second);
    expect(getAdapter('todoist')).toBe(second);
  });
});

// ── syncProvider ────────────────────────────────────────────────────

describe('syncProvider', () => {
  it('upserts tasks returned by adapter', async () => {
    const adapter = makeMockAdapter({
      provider: 'todoist',
      tasksByCall: [[
        { provider: 'todoist', externalId: 'a', title: 'Task A', status: 'pending', priority: 2 },
        { provider: 'todoist', externalId: 'b', title: 'Task B', status: 'pending', priority: 0 },
      ]],
    });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');
    expect(result.errors).toHaveLength(0);
    expect(result.tasksUpserted).toBe(2);

    const stored = getPendingTasks(USER_ID);
    expect(stored).toHaveLength(2);
    expect(stored.map(t => t.externalId).sort()).toEqual(['a', 'b']);
  });

  it('upserts projects before tasks', async () => {
    const adapter = makeMockAdapter({
      provider: 'todoist',
      projects: [{ provider: 'todoist', externalId: 'p1', name: 'Inbox' }],
    });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');
    expect(result.projectsUpserted).toBe(1);
    expect(getProjects(USER_ID)).toHaveLength(1);
  });

  it('saves a sync cursor for incremental adapters', async () => {
    const adapter = makeMockAdapter({
      provider: 'todoist',
      hasIncrementalSync: true,
      cursorByCall: ['cursor_abc'],
    });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'todoist');
    const state = getSyncState(USER_ID, 'todoist');
    expect(state?.sync_cursor).toBe('cursor_abc');
  });

  it('does not soft-delete on incremental sync (cursor present)', async () => {
    const adapter = makeMockAdapter({
      provider: 'todoist',
      hasIncrementalSync: true,
      tasksByCall: [
        [{ provider: 'todoist', externalId: 'a', title: 'A', status: 'pending', priority: 0 }],
        // Second sync returns nothing — represents an empty delta
        [],
      ],
      cursorByCall: ['cursor1', 'cursor2'],
    });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'todoist'); // first sync, no cursor → full pull
    expect(getPendingTasks(USER_ID)).toHaveLength(1);

    await syncProvider(USER_ID, 'todoist'); // second sync, cursor exists → incremental
    // Task should NOT be soft-deleted because we trust the delta
    expect(getPendingTasks(USER_ID)).toHaveLength(1);
  });

  it('marks missing provider tasks provider_missing on full sync (no cursor)', async () => {
    const adapter = makeMockAdapter({
      provider: 'todoist',
      hasIncrementalSync: false,
      tasksByCall: [
        [
          { provider: 'todoist', externalId: 'a', title: 'A', status: 'pending', priority: 0 },
          { provider: 'todoist', externalId: 'b', title: 'B', status: 'pending', priority: 0 },
        ],
        [{ provider: 'todoist', externalId: 'a', title: 'A', status: 'pending', priority: 0 }],
      ],
    });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'todoist');
    expect(getPendingTasks(USER_ID)).toHaveLength(2);

    await syncProvider(USER_ID, 'todoist');
    const remaining = getPendingTasks(USER_ID).map(t => t.externalId).sort();
    expect(remaining).toEqual(['a', 'b']);
    const missingRow = testDb.prepare(
      `SELECT sync_state, is_deleted
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'b'`,
    ).get(USER_ID) as { sync_state: string; is_deleted: number };
    const issue = testDb.prepare(
      `SELECT code, state, message
       FROM task_sync_issues
       WHERE user_id = ? AND provider = 'todoist' AND code = 'provider_task_missing'`,
    ).get(USER_ID) as { code: string; state: string; message: string };
    expect(missingRow).toEqual({ sync_state: 'provider_missing', is_deleted: 0 });
    expect(issue).toMatchObject({
      code: 'provider_task_missing',
      state: 'open',
      message: 'Provider no longer has this task. Nexus kept the local copy.',
    });
  });

  it('does not mark omitted tasks missing when a full provider pull is incomplete', async () => {
    const adapter = makeMockAdapter({
      provider: 'ms_todo',
      hasIncrementalSync: false,
      tasksByCall: [
        [
          { provider: 'ms_todo', externalId: 'a', title: 'A', status: 'pending', priority: 0 },
          { provider: 'ms_todo', externalId: 'b', title: 'B', status: 'pending', priority: 0 },
        ],
        [{ provider: 'ms_todo', externalId: 'a', title: 'A', status: 'pending', priority: 0 }],
      ],
      incompleteByCall: [false, true],
      errorsByCall: [[], ['Microsoft To Do failed to fetch 1 list']],
    });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'ms_todo');
    const partial = await syncProvider(USER_ID, 'ms_todo');

    const omittedRow = testDb.prepare(
      `SELECT sync_state, is_deleted
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'b'`,
    ).get(USER_ID) as { sync_state: string; is_deleted: number };
    const missingIssueCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM task_sync_issues
       WHERE user_id = ? AND provider = 'ms_todo' AND code = 'provider_task_missing'`,
    ).get(USER_ID) as { count: number };
    const syncState = getSyncState(USER_ID, 'ms_todo');

    expect(partial.tasksDeleted).toBe(0);
    expect(partial.errors).toEqual(['tasks: Microsoft To Do failed to fetch 1 list']);
    expect(omittedRow).toEqual({ sync_state: 'synced', is_deleted: 0 });
    expect(missingIssueCount.count).toBe(0);
    expect(syncState?.status).toBe('error');
    expect(syncState?.error_message).toBe('tasks: Microsoft To Do failed to fetch 1 list');
  });

  it('clears provider_missing when a later full sync returns the provider task again', async () => {
    const adapter = makeMockAdapter({
      provider: 'ms_todo',
      hasIncrementalSync: false,
      tasksByCall: [
        [
          {
            provider: 'ms_todo',
            externalId: 'ms-returning-task',
            title: 'Apontar horas (Mendix)',
            status: 'pending',
            priority: 0,
            providerData: { listId: 'ms-list-siemens', '@odata.etag': 'etag-v1' },
          },
        ],
        [],
        [
          {
            provider: 'ms_todo',
            externalId: 'ms-returning-task',
            title: 'Apontar horas (Mendix)',
            status: 'pending',
            priority: 0,
            providerData: { listId: 'ms-list-siemens', '@odata.etag': 'etag-v1' },
          },
        ],
      ],
    });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'ms_todo');
    await syncProvider(USER_ID, 'ms_todo');
    await syncProvider(USER_ID, 'ms_todo');

    const row = testDb.prepare(
      `SELECT t.sync_state, l.link_state
       FROM unified_tasks t
       INNER JOIN task_provider_links l
         ON l.tenant_id = t.tenant_id
        AND l.user_id = t.user_id
        AND l.task_id = t.nexus_task_id
       WHERE t.user_id = ? AND t.provider = 'ms_todo' AND t.external_id = 'ms-returning-task'`,
    ).get(USER_ID) as { sync_state: string; link_state: string };
    const issue = testDb.prepare(
      `SELECT state
       FROM task_sync_issues
       WHERE user_id = ? AND provider = 'ms_todo' AND code = 'provider_task_missing'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(USER_ID) as { state: string };

    expect(row).toEqual({ sync_state: 'synced', link_state: 'linked' });
    expect(issue.state).toBe('resolved');
  });

  it('returns error result on adapter exception without throwing', async () => {
    const adapter = makeMockAdapter({ throwOnGetTasks: true });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.tasksUpserted).toBe(0);

    // sync_state should reflect the error
    const state = getSyncState(USER_ID, 'todoist');
    expect(state?.status).toBe('error');
  });

  it('skips disconnected adapters', async () => {
    const adapter = makeMockAdapter({ connected: false });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');
    expect(result.errors).toContain('Not connected');
    expect(adapter.calls).toBe(0);
  });

  it('returns error when no adapter is registered', async () => {
    const result = await syncProvider(USER_ID, 'notion');
    expect(result.errors).toContain('Adapter not registered');
  });
});

// ── syncAllProviders ───────────────────────────────────────────────

describe('syncAllProviders', () => {
  it('syncs every connected adapter', async () => {
    const a = makeMockAdapter({
      provider: 'todoist',
      tasksByCall: [[{ provider: 'todoist', externalId: 't1', title: 'T1', status: 'pending', priority: 0 }]],
    });
    const b = makeMockAdapter({
      provider: 'ms_todo',
      tasksByCall: [[{ provider: 'ms_todo', externalId: 'm1', title: 'M1', status: 'pending', priority: 0 }]],
    });
    registerAdapter(a);
    registerAdapter(b);

    const results = await syncAllProviders(USER_ID);
    expect(results).toHaveLength(2);
    expect(getPendingTasks(USER_ID)).toHaveLength(2);
  });

  it('skips disconnected adapters silently', async () => {
    const connected = makeMockAdapter({ provider: 'todoist' });
    const disconnected = makeMockAdapter({ provider: 'ms_todo', connected: false });
    registerAdapter(connected);
    registerAdapter(disconnected);

    const results = await syncAllProviders(USER_ID);
    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe('todoist');
  });

  it('returns empty array when sync is disabled for the user', async () => {
    // Disable sync via preferences
    testDb.prepare(
      "INSERT INTO user_task_preferences (user_id, default_provider, sync_enabled) VALUES (?, 'nexus', 0)",
    ).run(USER_ID);

    const adapter = makeMockAdapter({ provider: 'todoist' });
    registerAdapter(adapter);

    const results = await syncAllProviders(USER_ID);
    expect(results).toHaveLength(0);
  });
});

// ── Poll-interval gate for full-pull providers ─────────────────────

function setPollInterval(value: string | undefined): void {
  if (value === undefined) delete process.env.TASK_SYNC_POLL_INTERVAL_MINUTES;
  else process.env.TASK_SYNC_POLL_INTERVAL_MINUTES = value;
  _resetPollIntervalForTests();
}

function backdateLastSync(provider: string, minutesAgo: number): void {
  testDb.prepare(
    'UPDATE task_sync_state SET last_sync_at = ? WHERE user_id = ? AND provider = ?',
  ).run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), USER_ID, provider);
}

describe('taskSyncPollIntervalMinutes', () => {
  it('defaults to 45 when the env var is unset', () => {
    setPollInterval(undefined);
    expect(taskSyncPollIntervalMinutes()).toBe(45);
  });

  it('honors an explicit 0 (gate disabled)', () => {
    setPollInterval('0');
    expect(taskSyncPollIntervalMinutes()).toBe(0);
  });

  it('falls back to the default on garbage or negative values', () => {
    setPollInterval('not-a-number');
    expect(taskSyncPollIntervalMinutes()).toBe(45);
    setPollInterval('-15');
    expect(taskSyncPollIntervalMinutes()).toBe(45);
  });

  it('parses once and caches until reset', () => {
    setPollInterval('30');
    expect(taskSyncPollIntervalMinutes()).toBe(30);
    process.env.TASK_SYNC_POLL_INTERVAL_MINUTES = '99';
    expect(taskSyncPollIntervalMinutes()).toBe(30);
  });
});

describe('poll-interval gate (full-pull providers)', () => {
  it('skips the pull for a polling provider inside the interval', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({
      provider: 'notion',
      hasIncrementalSync: false,
      projects: [{ provider: 'notion', externalId: 'db1', name: 'Tasks DB' }],
      tasksByCall: [[{ provider: 'notion', externalId: 'n1', title: 'N1', status: 'pending', priority: 0 }]],
    });
    registerAdapter(adapter);

    const first = await syncProvider(USER_ID, 'notion');
    expect(first.skipped).toBeUndefined();
    expect(adapter.calls).toBe(1);

    const second = await syncProvider(USER_ID, 'notion');
    expect(second).toMatchObject({
      provider: 'notion',
      skipped: 'skipped_poll_interval',
      tasksUpserted: 0,
      tasksDeleted: 0,
      projectsUpserted: 0,
      errors: [],
    });
    // Neither the task pull nor the project pull ran again
    expect(adapter.calls).toBe(1);
    expect(adapter.projectCalls).toBe(1);
    // Sync state untouched by the skip — still the successful sync's record
    const state = getSyncState(USER_ID, 'notion');
    expect(state?.status).toBe('idle');
    expect(state?.tasks_synced).toBe(1);
  });

  it('pulls again once the interval has elapsed', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({ provider: 'notion', hasIncrementalSync: false });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'notion');
    backdateLastSync('notion', 46);

    const result = await syncProvider(USER_ID, 'notion');
    expect(result.skipped).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('does not gate retries after a failed sync (gate keys off last SUCCESSFUL sync)', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({ provider: 'notion', hasIncrementalSync: false, throwOnGetTasks: true });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'notion');
    expect(getSyncState(USER_ID, 'notion')?.status).toBe('error');

    // Immediately retries — the failed attempt's timestamp does not gate
    const retry = await syncProvider(USER_ID, 'notion');
    expect(retry.skipped).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('leaves incremental providers syncing every tick', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({
      provider: 'todoist',
      hasIncrementalSync: true,
      cursorByCall: ['c1', 'c2'],
    });
    registerAdapter(adapter);

    const first = await syncProvider(USER_ID, 'todoist');
    const second = await syncProvider(USER_ID, 'todoist');
    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('TASK_SYNC_POLL_INTERVAL_MINUTES=0 restores pull-every-tick behavior', async () => {
    setPollInterval('0');
    const adapter = makeMockAdapter({ provider: 'notion', hasIncrementalSync: false });
    registerAdapter(adapter);

    const first = await syncProvider(USER_ID, 'notion');
    const second = await syncProvider(USER_ID, 'notion');
    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('force bypasses the gate for manual syncs', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({ provider: 'notion', hasIncrementalSync: false });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'notion');
    const forced = await syncProvider(USER_ID, 'notion', { force: true });
    expect(forced.skipped).toBeUndefined();
    expect(adapter.calls).toBe(2);
  });

  it('still pushes queued mutations while the poll gate skips the pull', async () => {
    setPollInterval('45');
    const adapter = makeMockAdapter({ provider: 'ms_todo', hasIncrementalSync: false });
    registerAdapter(adapter);

    // First tick: pull runs and records a successful sync
    await syncProvider(USER_ID, 'ms_todo');
    expect(adapter.calls).toBe(1);

    // A local write lands between ticks: queued create mutation
    const taskId = 'task-gate-push-1';
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_name,
         title, status, priority, provider_data,
         nexus_task_id, local_version, sync_state, source_of_truth
       ) VALUES (?, ?, 'nexus', ?, 'Inbox', 'Push me', 'pending', 2, '{}', ?, 1, 'queued', 'nexus')`,
    ).run(USER_ID, USER_ID, taskId, taskId);
    testDb.prepare(
      `INSERT INTO task_provider_links (
         id, task_id, tenant_id, user_id, provider, provider_account_id,
         provider_task_id, provider_list_id, ownership, link_state
       ) VALUES (?, ?, ?, ?, 'ms_todo', ?, NULL, 'ms-list-1', 'nexus_created', 'pending_create')`,
    ).run(`link-${taskId}`, taskId, USER_ID, USER_ID, `ms_todo:${USER_ID}`);
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, status, retry_count
       ) VALUES (?, ?, ?, ?, ?, ?, 'task.create', 1, ?, 'queued', 0)`,
    ).run(
      `mutation-${taskId}`,
      `client-${taskId}`,
      `idem-${taskId}`,
      USER_ID,
      USER_ID,
      taskId,
      JSON.stringify({ providerLinkProvider: 'ms_todo' }),
    );
    workerMocks.providerApi.getTasks.mockResolvedValue({ success: true, data: [] });
    workerMocks.providerApi.createTask.mockResolvedValue({
      success: true,
      data: { id: 'provider-created-1', providerVersion: 'etag-created' },
    });

    // Second tick, same order as the scheduler: push batch, then pull
    const pushResult = await runTaskMutationSyncBatch({ tenantId: USER_ID, userId: USER_ID });
    const pullResult = await syncProvider(USER_ID, 'ms_todo');

    // The pull was gated…
    expect(pullResult.skipped).toBe('skipped_poll_interval');
    expect(adapter.calls).toBe(1);
    // …but the mutation still reached the provider
    expect(pushResult.processed).toBe(1);
    expect(pushResult.synced).toBe(1);
    expect(workerMocks.providerApi.createTask).toHaveBeenCalledTimes(1);
  });
});

// ── knownProjects threading (list double-fetch dedupe) ─────────────

describe('project reuse between getProjects and getTasks', () => {
  it('passes the already-fetched project set into getTasks', async () => {
    const projects: NormalizedProject[] = [
      { provider: 'ms_todo', externalId: 'list-1', name: 'Tasks' },
      { provider: 'ms_todo', externalId: 'list-2', name: 'Work' },
    ];
    const adapter = makeMockAdapter({ provider: 'ms_todo', projects });
    registerAdapter(adapter);

    await syncProvider(USER_ID, 'ms_todo');
    expect(adapter.lastGetTasksOptions?.knownProjects).toEqual(projects);
  });

  it('omits knownProjects when the project pull fails, so adapters fall back to self-fetching', async () => {
    const adapter = makeMockAdapter({ provider: 'ms_todo' });
    (adapter as any).getProjects = async () => { throw new Error('projects boom'); };
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'ms_todo');
    expect(result.errors).toEqual(['projects: projects boom']);
    expect(adapter.lastGetTasksOptions?.knownProjects).toBeUndefined();
  });
});

// ── M6: cursor preservation, delta removals, list-scoped resync ─────

import {
  saveSyncState,
  upsertTask,
  upsertProject,
} from '../../../src/services/task-store/unified-task-store';

function makeDeltaAdapter(
  provider: TaskProvider,
  pullResult: Partial<Awaited<ReturnType<TaskProviderAdapter['getTasks']>>>,
): TaskProviderAdapter {
  return {
    provider,
    capabilities: {
      canCreate: true,
      canComplete: true,
      canDelete: true,
      canUpdate: true,
      canAssignDue: true,
      hasWebhooks: false,
      hasIncrementalSync: true,
    },
    isConnected: () => true,
    getProjects: async () => [],
    getTasks: async () => ({ tasks: [], ...pullResult }),
    createTask: async (userId, task) => ({ ...task, provider, externalId: 'created' } as NormalizedTask),
    completeTask: async () => undefined,
    deleteTask: async () => undefined,
  };
}

function seedMsTask(externalId: string, listId: string, title = `Task ${externalId}`): void {
  upsertTask(USER_ID, {
    provider: 'ms_todo',
    externalId,
    title,
    status: 'pending',
    priority: 0,
    providerData: { id: externalId, title, status: 'notStarted', listId },
  });
}

describe('M6 cursor preservation and delta removals', () => {
  it('preserves the stored cursor when the pull throws (catch path no longer wipes deltaLinks)', async () => {
    saveSyncState(USER_ID, 'todoist', {
      lastSyncAt: new Date().toISOString(),
      syncCursor: 'cursor_abc',
      status: 'idle',
    });
    const adapter = makeMockAdapter({ provider: 'todoist', hasIncrementalSync: true, throwOnGetTasks: true });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');

    expect(result.errors).toEqual(['mock failure']);
    const state = getSyncState(USER_ID, 'todoist');
    expect(state?.status).toBe('error');
    expect(state?.sync_cursor).toBe('cursor_abc');
  });

  it('preserves the stored cursor when a partial pull returns no advanced cursor', async () => {
    saveSyncState(USER_ID, 'todoist', {
      lastSyncAt: new Date().toISOString(),
      syncCursor: 'cursor_abc',
      status: 'idle',
    });
    const adapter = makeMockAdapter({
      provider: 'todoist',
      hasIncrementalSync: true,
      tasksByCall: [[]],
      cursorByCall: [undefined],
      incompleteByCall: [true],
      errorsByCall: [['project 9 fetch failed']],
    });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'todoist');

    expect(result.errors).toEqual(['tasks: project 9 fetch failed']);
    const state = getSyncState(USER_ID, 'todoist');
    expect(state?.status).toBe('error');
    expect(state?.sync_cursor).toBe('cursor_abc');
  });

  it('applies task removals as per-task tombstones through the canonical-links path', async () => {
    seedMsTask('ms-removed-1', 'list-a');
    saveSyncState(USER_ID, 'ms_todo', {
      lastSyncAt: new Date().toISOString(),
      syncCursor: '{"list-a":"delta-1"}',
      status: 'idle',
    });
    registerAdapter(makeDeltaAdapter('ms_todo', {
      nextCursor: '{"list-a":"delta-2"}',
      removals: [{ kind: 'task', externalId: 'ms-removed-1', listId: 'list-a' }],
    }));

    const result = await syncProvider(USER_ID, 'ms_todo');

    expect(result.errors).toEqual([]);
    expect(result.tasksDeleted).toBe(1);
    const row = testDb.prepare(
      `SELECT sync_state, is_deleted FROM unified_tasks WHERE user_id = ? AND external_id = 'ms-removed-1'`,
    ).get(USER_ID) as { sync_state: string; is_deleted: number };
    // provider_missing semantics — Nexus keeps the local copy, flagged.
    expect(row).toEqual({ sync_state: 'provider_missing', is_deleted: 0 });
    const link = testDb.prepare(
      `SELECT link_state FROM task_provider_links WHERE user_id = ? AND provider_task_id = 'ms-removed-1'`,
    ).get(USER_ID) as { link_state: string };
    expect(link.link_state).toBe('provider_missing');
    expect(getSyncState(USER_ID, 'ms_todo')?.sync_cursor).toBe('{"list-a":"delta-2"}');
  });

  it('soft-handles removed provider lists: local list row goes away, its tasks are flagged', async () => {
    upsertProject(USER_ID, { provider: 'ms_todo', externalId: 'list-b', name: 'Beta' });
    seedMsTask('ms-b1', 'list-b');
    saveSyncState(USER_ID, 'ms_todo', {
      lastSyncAt: new Date().toISOString(),
      syncCursor: '{"list-b":"delta-1"}',
      status: 'idle',
    });
    registerAdapter(makeDeltaAdapter('ms_todo', {
      nextCursor: '{}',
      removals: [{ kind: 'project', externalId: 'list-b' }],
    }));

    const result = await syncProvider(USER_ID, 'ms_todo');

    expect(result.tasksDeleted).toBe(1);
    expect(getProjects(USER_ID).some((project) => project.externalId === 'list-b')).toBe(false);
    const row = testDb.prepare(
      `SELECT sync_state FROM unified_tasks WHERE user_id = ? AND external_id = 'ms-b1'`,
    ).get(USER_ID) as { sync_state: string };
    expect(row.sync_state).toBe('provider_missing');
    const mapping = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_container_mappings WHERE user_id = ? AND provider_container_id = 'list-b'`,
    ).get(USER_ID) as { count: number };
    expect(mapping.count).toBe(0);
  });

  it('reconciles absences ONLY inside resynced lists after a 410 rebuild', async () => {
    seedMsTask('ms-a1', 'list-a');
    seedMsTask('ms-a2', 'list-a');
    seedMsTask('ms-b1', 'list-b');
    saveSyncState(USER_ID, 'ms_todo', {
      lastSyncAt: new Date().toISOString(),
      syncCursor: '{"list-a":"expired","list-b":"delta-1"}',
      status: 'idle',
    });
    registerAdapter(makeDeltaAdapter('ms_todo', {
      tasks: [{
        provider: 'ms_todo',
        externalId: 'ms-a1',
        title: 'Task ms-a1',
        status: 'pending',
        priority: 0,
        providerData: { id: 'ms-a1', title: 'Task ms-a1', status: 'notStarted', listId: 'list-a' },
      }],
      nextCursor: '{"list-a":"fresh","list-b":"delta-1"}',
      resyncedListIds: ['list-a'],
    }));

    const result = await syncProvider(USER_ID, 'ms_todo');

    expect(result.tasksDeleted).toBe(1);
    const states = Object.fromEntries((testDb.prepare(
      `SELECT external_id, sync_state FROM unified_tasks WHERE user_id = ? AND provider = 'ms_todo'`,
    ).all(USER_ID) as Array<{ external_id: string; sync_state: string }>)
      .map((row) => [row.external_id, row.sync_state]));
    // ms-a2 was absent from the resynced complete set for list-a → flagged;
    // ms-b1 lives in a NON-resynced list → untouched by the sweep.
    expect(states['ms-a1']).toBe('synced');
    expect(states['ms-a2']).toBe('provider_missing');
    expect(states['ms-b1']).toBe('synced');
  });
});

// ── M12: per-list sync selection (disabled lists) ─────────────────────

describe('syncProvider — de-selected list skip (M12)', () => {
  function msTask(externalId: string, listId: string): NormalizedTask {
    return {
      provider: 'ms_todo',
      externalId,
      title: `Task ${externalId}`,
      status: 'pending',
      priority: 0,
      providerData: { listId },
    };
  }

  function syncStateByExternalId(): Record<string, string> {
    return Object.fromEntries((testDb.prepare(
      `SELECT external_id, sync_state FROM unified_tasks WHERE user_id = ? AND provider = 'ms_todo' AND is_deleted = 0`,
    ).all(USER_ID) as Array<{ external_id: string; sync_state: string }>)
      .map((row) => [row.external_id, row.sync_state]));
  }

  it('does not import tasks (or projects) from a disabled list', async () => {
    setTaskListSyncSelection({
      tenantId: USER_ID, userId: USER_ID, provider: 'ms_todo',
      entries: [
        { providerListId: 'listA', syncEnabled: true },
        { providerListId: 'listB', syncEnabled: false },
      ],
    });
    const adapter = makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'A' },
        { provider: 'ms_todo', externalId: 'listB', name: 'B' },
      ],
      tasksByCall: [[msTask('a', 'listA'), msTask('b', 'listB')]],
    });
    registerAdapter(adapter);

    const result = await syncProvider(USER_ID, 'ms_todo');

    const imported = getPendingTasks(USER_ID).map((t) => t.externalId).sort();
    expect(imported).toEqual(['a']);
    expect(result.projectsUpserted).toBe(1); // only listA
    // The disabled list is not represented as a project either.
    expect(getProjects(USER_ID).map((p) => p.externalId)).toEqual(['listA']);
  });

  it('does not false-mark a disabled list provider_missing on full-pull reconciliation', async () => {
    // First pull with BOTH lists enabled imports a & b.
    const first = makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'A' },
        { provider: 'ms_todo', externalId: 'listB', name: 'B' },
      ],
      tasksByCall: [[msTask('a', 'listA'), msTask('b', 'listB')]],
    });
    registerAdapter(first);
    await syncProvider(USER_ID, 'ms_todo');
    expect(syncStateByExternalId()).toEqual({ a: 'synced', b: 'synced' });

    // Now disable listB, then a full pull that returns only listA's task.
    setTaskListSyncSelection({
      tenantId: USER_ID, userId: USER_ID, provider: 'ms_todo',
      entries: [{ providerListId: 'listB', syncEnabled: false }],
    });
    const second = makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'A' },
        { provider: 'ms_todo', externalId: 'listB', name: 'B' },
      ],
      tasksByCall: [[msTask('a', 'listA')]],
    });
    registerAdapter(second);
    await syncProvider(USER_ID, 'ms_todo');

    // b lives in the disabled list → excluded from reconciliation → still synced.
    expect(syncStateByExternalId()).toEqual({ a: 'synced', b: 'synced' });
  });

  it('DOES mark a missing task provider_missing when its list stays enabled (control)', async () => {
    const first = makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'A' },
        { provider: 'ms_todo', externalId: 'listB', name: 'B' },
      ],
      tasksByCall: [[msTask('a', 'listA'), msTask('b', 'listB')]],
    });
    registerAdapter(first);
    await syncProvider(USER_ID, 'ms_todo');

    // No selection → both lists enabled. A full pull without b marks it missing.
    const second = makeMockAdapter({
      provider: 'ms_todo',
      projects: [
        { provider: 'ms_todo', externalId: 'listA', name: 'A' },
        { provider: 'ms_todo', externalId: 'listB', name: 'B' },
      ],
      tasksByCall: [[msTask('a', 'listA')]],
    });
    registerAdapter(second);
    await syncProvider(USER_ID, 'ms_todo');

    expect(syncStateByExternalId()).toEqual({ a: 'synced', b: 'provider_missing' });
  });
});
