/**
 * Tests for src/services/task-store/task-service.ts
 *
 * M5 single write path: createTask/deleteTask were deleted (no consumers —
 * writes flow through the offline-first ledger). This suite covers the
 * retained surface: completeTask (legacy flag-off branch of the chat-core-v2
 * command executor) and the read helpers listTasks/listTasksForUser/getTask.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;
const mockInvalidateTaskCaches = vi.fn();

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
vi.mock('../../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateTaskCaches: (...args: unknown[]) => mockInvalidateTaskCaches(...args),
}));

import {
  completeTask,
  listTasks,
  listTasksForUser,
  getTask,
} from '../../../src/services/task-store/task-service';
import {
  registerAdapter,
  _resetAdaptersForTests,
} from '../../../src/services/task-store/sync-engine';
import { setDefaultProvider } from '../../../src/services/task-store/unified-task-store';
import { TaskProviderAdapter } from '../../../src/services/task-store/adapter-interface';
import { NormalizedTask } from '../../../src/services/task-store/types';

const USER_ID = 11;

// Helper that builds a fully working mock adapter for any provider
function makeAdapter(provider: 'todoist' | 'ms_todo' | 'notion', connected = true): TaskProviderAdapter & { spies: any } {
  const spies = {
    createTask: vi.fn(),
    completeTask: vi.fn(),
    deleteTask: vi.fn(),
  };
  return {
    provider,
    capabilities: {
      canCreate: true,
      canComplete: true,
      canDelete: true,
      canUpdate: true,
      canAssignDue: true,
      hasWebhooks: false,
      hasIncrementalSync: false,
    },
    isConnected: () => connected,
    getProjects: async () => [],
    getTasks: async () => ({ tasks: [] }),
    createTask: async (_userId, task) => {
      spies.createTask(_userId, task);
      return {
        ...task,
        provider,
        externalId: `mock_${provider}_${Date.now()}`,
      } as NormalizedTask;
    },
    completeTask: async (uid, eid) => { spies.completeTask(uid, eid); },
    deleteTask: async (uid, eid) => { spies.deleteTask(uid, eid); },
    spies,
  } as any;
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  const seedUser = testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let id = 1; id <= 1000; id += 1) seedUser.run(id, id);
  _resetAdaptersForTests();
  mockInvalidateTaskCaches.mockReset();
});

/** Seed a unified_tasks row directly — task-service no longer writes creates. */
function seedUnifiedTask(input: {
  userId?: number;
  provider?: 'nexus' | 'todoist' | 'ms_todo';
  externalId?: string;
  title: string;
  status?: string;
}): { id: number; externalId: string } {
  const provider = input.provider ?? 'nexus';
  const externalId = input.externalId ?? `${provider}_seed_${Math.random().toString(16).slice(2)}`;
  const result = testDb.prepare(`
    INSERT INTO unified_tasks (user_id, provider, external_id, title, status, priority, project_name)
    VALUES (?, ?, ?, ?, ?, 0, 'Inbox')
  `).run(input.userId ?? USER_ID, provider, externalId, input.title, input.status ?? 'pending');
  return { id: Number(result.lastInsertRowid), externalId };
}

// ── completeTask ───────────────────────────────────────────────────

describe('completeTask', () => {
  it('marks a local task complete without calling any adapter', async () => {
    const task = seedUnifiedTask({ title: 'Local' });
    await completeTask(USER_ID, task.id);

    const fresh = getTask(task.id)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.completedAt).toBeTruthy();
    expect(mockInvalidateTaskCaches).toHaveBeenLastCalledWith({
      userId: USER_ID,
      listIds: expect.any(Array),
      includeDerivedSurfaces: true,
    });
  });

  it('routes through the adapter for provider tasks', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    const adapter = makeAdapter('todoist');
    registerAdapter(adapter);

    const task = seedUnifiedTask({ provider: 'todoist', title: 'Cloud' });
    await completeTask(USER_ID, task.id);

    expect(adapter.spies.completeTask).toHaveBeenCalledWith(USER_ID, task.externalId);
    expect(getTask(task.id)!.status).toBe('completed');
  });

  it('marks complete locally even when adapter throws (best-effort)', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    const adapter = makeAdapter('todoist');
    adapter.completeTask = async () => { throw new Error('rate limited'); };
    registerAdapter(adapter);

    const task = seedUnifiedTask({ provider: 'todoist', title: 'Resilient complete' });
    await completeTask(USER_ID, task.id);

    expect(getTask(task.id)!.status).toBe('completed');
  });

  it('throws when task does not exist', async () => {
    await expect(completeTask(USER_ID, 9999)).rejects.toThrow(/not found/);
  });

  it('throws when task belongs to a different user', async () => {
    const task = seedUnifiedTask({ title: 'Mine' });
    await expect(completeTask(USER_ID + 1, task.id)).rejects.toThrow(/does not belong/);
  });
});

// ── listTasks ──────────────────────────────────────────────────────

describe('listTasks', () => {
  it('returns tasks from all providers', async () => {
    seedUnifiedTask({ provider: 'todoist', title: 'Cloud 1' });
    seedUnifiedTask({ provider: 'nexus', title: 'Local 1' });

    const all = listTasks(USER_ID);
    expect(all).toHaveLength(2);
    const providers = all.map(t => t.provider).sort();
    expect(providers).toEqual(['nexus', 'todoist']);
  });

  it('respects status filter', async () => {
    const task = seedUnifiedTask({ title: 'Filterable' });
    await completeTask(USER_ID, task.id);

    expect(listTasks(USER_ID, { status: 'pending' })).toHaveLength(0);
    expect(listTasks(USER_ID, { status: 'completed' })).toHaveLength(1);
  });

  it('listTasksForUser combines native Nexus tasks and unified synced-provider tasks through local reads', () => {
    testDb.prepare('INSERT OR IGNORE INTO native_task_lists (user_id, name, is_default) VALUES (?, ?, 1)').run(USER_ID, 'Inbox');
    const listId = (testDb.prepare('SELECT id FROM native_task_lists WHERE user_id = ?').get(USER_ID) as { id: number }).id;
    testDb.prepare(`
      INSERT INTO native_tasks (user_id, list_id, title, status, due_date_time, importance)
      VALUES (?, ?, ?, 'notStarted', ?, 'high')
    `).run(USER_ID, listId, 'Native private title', '2026-06-17');
    testDb.prepare(`
      INSERT INTO unified_tasks (user_id, provider, external_id, title, status, priority, due_date, project_name)
      VALUES (?, 'ms_todo', 'ms-private-id', ?, 'pending', 3, ?, 'Microsoft To Do')
    `).run(USER_ID, 'Synced private title', '2026-06-17');

    const tasks = listTasksForUser(USER_ID, { status: 'pending' });

    expect(tasks.map((task) => `${task.provider}:${task.title}`).sort()).toEqual([
      'ms_todo:Synced private title',
      'nexus:Native private title',
    ]);
  });
});
