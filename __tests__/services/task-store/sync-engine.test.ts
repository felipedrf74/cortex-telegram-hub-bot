/**
 * Tests for src/services/task-store/sync-engine.ts
 *
 * Uses a hand-rolled MockAdapter that satisfies the TaskProviderAdapter
 * interface so we can verify orchestration without depending on any real
 * provider SDK or HTTP layer.
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

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  registerAdapter,
  getAdapter,
  syncProvider,
  syncAllProviders,
  _resetAdaptersForTests,
} from '../../../src/services/task-store/sync-engine';
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

const USER_ID = 7;

interface MockAdapterOptions {
  provider?: TaskProvider;
  connected?: boolean;
  hasIncrementalSync?: boolean;
  tasksByCall?: NormalizedTask[][];
  projects?: NormalizedProject[];
  cursorByCall?: (string | undefined)[];
  throwOnGetTasks?: boolean;
}

function makeMockAdapter(opts: MockAdapterOptions = {}): TaskProviderAdapter & { calls: number } {
  const provider = opts.provider ?? 'todoist';
  const tasksByCall = opts.tasksByCall ?? [[]];
  const cursorByCall = opts.cursorByCall ?? [];
  let callIndex = 0;

  const adapter: any = {
    provider,
    calls: 0,
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
    getProjects: async () => opts.projects ?? [],
    getTasks: async () => {
      adapter.calls++;
      if (opts.throwOnGetTasks) throw new Error('mock failure');
      const idx = Math.min(callIndex, tasksByCall.length - 1);
      const tasks = tasksByCall[idx] || [];
      const cursor = cursorByCall[idx];
      callIndex++;
      return { tasks, nextCursor: cursor };
    },
    createTask: async (_userId: number, task: any) => ({ ...task, provider, externalId: `mock_${Date.now()}` }),
    completeTask: async () => undefined,
    deleteTask: async () => undefined,
  };
  return adapter;
}

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  _resetAdaptersForTests();
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

  it('soft-deletes missing tasks on full sync (no cursor)', async () => {
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
    const remaining = getPendingTasks(USER_ID).map(t => t.externalId);
    expect(remaining).toEqual(['a']);
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
