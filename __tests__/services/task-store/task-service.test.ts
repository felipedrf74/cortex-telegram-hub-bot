/**
 * Tests for src/services/task-store/task-service.ts
 *
 * Validates the high-level write API: createTask falls back to a local
 * 'nexus' task when no provider is registered, completeTask routes through
 * the adapter for non-local rows, and listTasks proxies to the store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    }
  }
  // Migration 042 added FK on unified_*.user_id — pre-seed users so tests
  // can insert with arbitrary user IDs without FK violations.
  const seedUser = db.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let i = 1; i <= 1000; i++) seedUser.run(i, i);
}

let testDb: Database.Database;
const mockInvalidateTaskCaches = vi.fn();

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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
  createTask,
  completeTask,
  deleteTask,
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
  testDb = createTestDb();
  applyMigrations(testDb);
  _resetAdaptersForTests();
  mockInvalidateTaskCaches.mockReset();
});

// ── createTask ─────────────────────────────────────────────────────

describe('createTask', () => {
  it('falls back to local nexus task when no adapter registered', async () => {
    const task = await createTask(USER_ID, { title: 'Local task', priority: 1 });

    expect(task.provider).toBe('nexus');
    expect(task.externalId).toMatch(/^nexus_/);
    expect(task.title).toBe('Local task');

    const stored = listTasks(USER_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0].provider).toBe('nexus');
    expect(mockInvalidateTaskCaches).toHaveBeenLastCalledWith({
      userId: USER_ID,
      listIds: expect.any(Array),
      includeDerivedSurfaces: true,
    });
  });

  it('writes to the registered default provider when available', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    const adapter = makeAdapter('todoist');
    registerAdapter(adapter);

    const task = await createTask(USER_ID, { title: 'Cloud task', priority: 3 });

    expect(adapter.spies.createTask).toHaveBeenCalledOnce();
    expect(task.provider).toBe('todoist');
    expect(mockInvalidateTaskCaches).toHaveBeenLastCalledWith({
      userId: USER_ID,
      listIds: expect.any(Array),
      includeDerivedSurfaces: true,
    });
  });

  it('falls back to local when adapter is registered but disconnected', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    registerAdapter(makeAdapter('todoist', false));

    const task = await createTask(USER_ID, { title: 'Offline fallback' });
    expect(task.provider).toBe('nexus');
  });

  it('falls back to local when adapter throws', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    const adapter = makeAdapter('todoist');
    adapter.createTask = async () => { throw new Error('API down'); };
    registerAdapter(adapter);

    const task = await createTask(USER_ID, { title: 'Resilient' });
    expect(task.provider).toBe('nexus');
  });
});

// ── completeTask ───────────────────────────────────────────────────

describe('completeTask', () => {
  it('marks a local task complete without calling any adapter', async () => {
    const task = await createTask(USER_ID, { title: 'Local' });
    await completeTask(USER_ID, task.id!);

    const fresh = getTask(task.id!)!;
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

    const task = await createTask(USER_ID, { title: 'Cloud' });
    await completeTask(USER_ID, task.id!);

    expect(adapter.spies.completeTask).toHaveBeenCalledWith(USER_ID, task.externalId);
    expect(getTask(task.id!)!.status).toBe('completed');
  });

  it('marks complete locally even when adapter throws (best-effort)', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    const adapter = makeAdapter('todoist');
    adapter.completeTask = async () => { throw new Error('rate limited'); };
    registerAdapter(adapter);

    const task = await createTask(USER_ID, { title: 'Resilient complete' });
    await completeTask(USER_ID, task.id!);

    expect(getTask(task.id!)!.status).toBe('completed');
  });

  it('throws when task does not exist', async () => {
    await expect(completeTask(USER_ID, 9999)).rejects.toThrow(/not found/);
  });

  it('throws when task belongs to a different user', async () => {
    const task = await createTask(USER_ID, { title: 'Mine' });
    await expect(completeTask(USER_ID + 1, task.id!)).rejects.toThrow(/does not belong/);
  });
});

// ── deleteTask ─────────────────────────────────────────────────────

describe('deleteTask', () => {
  it('soft-deletes a local task', async () => {
    const task = await createTask(USER_ID, { title: 'Doomed' });
    await deleteTask(USER_ID, task.id!);

    const remaining = listTasks(USER_ID);
    expect(remaining).toHaveLength(0);
    expect(mockInvalidateTaskCaches).toHaveBeenLastCalledWith({
      userId: USER_ID,
      listIds: expect.any(Array),
      includeDerivedSurfaces: true,
    });
  });

  it('routes through the adapter for provider tasks', async () => {
    setDefaultProvider(USER_ID, 'ms_todo');
    const adapter = makeAdapter('ms_todo');
    registerAdapter(adapter);

    const task = await createTask(USER_ID, { title: 'Cloud doomed' });
    await deleteTask(USER_ID, task.id!);

    expect(adapter.spies.deleteTask).toHaveBeenCalledWith(USER_ID, task.externalId);
  });
});

// ── listTasks ──────────────────────────────────────────────────────

describe('listTasks', () => {
  it('returns tasks from all providers', async () => {
    setDefaultProvider(USER_ID, 'todoist');
    registerAdapter(makeAdapter('todoist'));

    await createTask(USER_ID, { title: 'Cloud 1' });

    setDefaultProvider(USER_ID, 'nexus');
    await createTask(USER_ID, { title: 'Local 1' });

    const all = listTasks(USER_ID);
    expect(all).toHaveLength(2);
    const providers = all.map(t => t.provider).sort();
    expect(providers).toEqual(['nexus', 'todoist']);
  });

  it('respects status filter', async () => {
    const task = await createTask(USER_ID, { title: 'Filterable' });
    await completeTask(USER_ID, task.id!);

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
