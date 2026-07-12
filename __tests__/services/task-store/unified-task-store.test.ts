/**
 * Tests for src/services/task-store/unified-task-store.ts
 *
 * Covers:
 *   - hash-based upsert (inserted / updated / unchanged)
 *   - computeContentHash determinism + sensitivity
 *   - provider_missing/conflict marking for full-pull diffs
 *   - reader queries (pending / overdue / due today / due this week)
 *   - sync state CRUD
 *   - default provider preferences
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
}));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  computeContentHash,
  upsertTask,
  upsertProject,
  softDeleteMissing,
  getPendingTasks,
  getOverdueTasks,
  getTasksDueToday,
  getTasksDueThisWeek,
  getAllTasks,
  getTaskById,
  getDefaultProvider,
  setDefaultProvider,
  getSyncState,
  saveSyncState,
  updateSyncStatus,
  markTaskCompleted,
  markTaskDeleted,
  getTaskStats,
} from '../../../src/services/task-store/unified-task-store';
import { NormalizedTask } from '../../../src/services/task-store/types';

const USER_ID = 42;

function makeTask(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    provider: 'todoist',
    externalId: `ext_${Math.random().toString(36).slice(2, 10)}`,
    title: 'Write spec',
    status: 'pending',
    priority: 2,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
});

// ── computeContentHash ───────────────────────────────────────────────

describe('computeContentHash', () => {
  it('is deterministic for the same task', () => {
    const t = makeTask();
    expect(computeContentHash(t)).toBe(computeContentHash(t));
  });

  it('changes when title changes', () => {
    const a = makeTask({ title: 'A' });
    const b = makeTask({ title: 'B' });
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('changes when status changes', () => {
    const a = makeTask({ status: 'pending' });
    const b = makeTask({ ...a, status: 'completed' });
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('changes when due date changes', () => {
    const a = makeTask({ dueDate: '2026-04-10' });
    const b = makeTask({ ...a, dueDate: '2026-04-11' });
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('changes when priority changes', () => {
    const a = makeTask({ priority: 1 });
    const b = makeTask({ ...a, priority: 4 });
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('does not depend on tag order', () => {
    const a = makeTask({ tags: ['a', 'b', 'c'] });
    const b = makeTask({ ...a, tags: ['c', 'b', 'a'] });
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('produces a 16-character hex string', () => {
    const hash = computeContentHash(makeTask());
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ── upsertTask ──────────────────────────────────────────────────────

describe('upsertTask', () => {
  it('inserts a new task on first call', () => {
    const result = upsertTask(USER_ID, makeTask({ externalId: 'new1' }));
    expect(result).toBe('inserted');

    const tasks = getPendingTasks(USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].externalId).toBe('new1');
  });

  it('returns "unchanged" when content hash is identical', () => {
    const task = makeTask({ externalId: 'idem1' });
    upsertTask(USER_ID, task);
    const result = upsertTask(USER_ID, task);
    expect(result).toBe('unchanged');
  });

  it('returns "updated" when content hash differs', () => {
    const task = makeTask({ externalId: 'mut1', title: 'Original' });
    upsertTask(USER_ID, task);
    const result = upsertTask(USER_ID, { ...task, title: 'Updated' });
    expect(result).toBe('updated');

    const fetched = getPendingTasks(USER_ID);
    expect(fetched[0].title).toBe('Updated');
  });

  it('isolates tasks across users', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'shared' }));
    upsertTask(99, makeTask({ externalId: 'shared' }));

    expect(getPendingTasks(USER_ID)).toHaveLength(1);
    expect(getPendingTasks(99)).toHaveLength(1);
  });

  it('isolates tasks across providers for the same external_id', () => {
    upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'collision' }));
    upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'collision' }));
    expect(getPendingTasks(USER_ID)).toHaveLength(2);
  });

  it('un-deletes a task on re-upsert (resurrection after sync)', () => {
    const task = makeTask({ externalId: 'res1' });
    upsertTask(USER_ID, task);
    const tasks = getAllTasks(USER_ID);
    markTaskDeleted(tasks[0].id!);
    expect(getPendingTasks(USER_ID)).toHaveLength(0);

    // Re-upsert with new title (forces hash change → UPDATE path)
    upsertTask(USER_ID, { ...task, title: 'Resurrected' });
    expect(getPendingTasks(USER_ID)).toHaveLength(1);
  });

  it('creates a provider-link row for provider-imported tasks', () => {
    const task = makeTask({
      provider: 'todoist',
      externalId: 'todoist-provider-task-1',
      providerData: { project_id: 'todoist-project-1', updated_at: '2026-06-23T10:00:00Z' },
    });

    upsertTask(USER_ID, task);

    const row = testDb.prepare(
      `SELECT task_id, tenant_id, user_id, provider, provider_account_id,
              provider_task_id, provider_project_id, ownership, link_state
       FROM task_provider_links
       WHERE tenant_id = ? AND user_id = ? AND provider = 'todoist'`,
    ).get(USER_ID, USER_ID) as Record<string, unknown>;

    expect(row).toMatchObject({
      tenant_id: USER_ID,
      user_id: USER_ID,
      provider: 'todoist',
      provider_account_id: `todoist:${USER_ID}`,
      provider_task_id: 'todoist-provider-task-1',
      provider_project_id: 'todoist-project-1',
      ownership: 'provider_imported',
      link_state: 'linked',
    });
    expect(String(row.task_id)).toMatch(/^task_[a-f0-9]+$/);
  });

  it('keeps provider-link rows idempotent on unchanged provider imports', () => {
    const task = makeTask({
      provider: 'todoist',
      externalId: 'todoist-provider-task-2',
      providerData: { project_id: 'todoist-project-2' },
    });

    upsertTask(USER_ID, task);
    upsertTask(USER_ID, task);

    const row = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM task_provider_links
       WHERE tenant_id = ? AND user_id = ?
         AND provider = 'todoist'
         AND provider_task_id = ?`,
    ).get(USER_ID, USER_ID, 'todoist-provider-task-2') as { count: number };

    expect(row.count).toBe(1);
  });

  it('clears provider_missing when Microsoft returns the same task again unchanged', () => {
    const task = makeTask({
      provider: 'ms_todo',
      externalId: 'ms-provider-task-1',
      title: 'Apontar horas (Mendix)',
      dueDate: '2026-06-29',
      providerData: {
        listId: 'ms-list-siemens',
        lastModifiedDateTime: '2026-06-25T10:00:00Z',
        '@odata.etag': 'etag-v1',
      },
    });

    upsertTask(USER_ID, task);
    softDeleteMissing(USER_ID, 'ms_todo', []);

    const result = upsertTask(USER_ID, task);
    const row = testDb.prepare(
      `SELECT t.sync_state, l.link_state, l.provider_list_id
       FROM unified_tasks t
       INNER JOIN task_provider_links l
         ON l.tenant_id = t.tenant_id
        AND l.user_id = t.user_id
        AND l.task_id = t.nexus_task_id
       WHERE t.user_id = ? AND t.provider = 'ms_todo' AND t.external_id = ?`,
    ).get(USER_ID, 'ms-provider-task-1') as {
      sync_state: string;
      link_state: string;
      provider_list_id: string;
    };
    const issue = testDb.prepare(
      `SELECT state
       FROM task_sync_issues
       WHERE user_id = ? AND provider = 'ms_todo' AND code = 'provider_task_missing'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(USER_ID) as { state: string };

    expect(result).toBe('unchanged');
    expect(row).toEqual({
      sync_state: 'synced',
      link_state: 'linked',
      provider_list_id: 'ms-list-siemens',
    });
    expect(issue.state).toBe('resolved');
  });

  it('clears provider_missing when Microsoft returns the task with changed content', () => {
    const task = makeTask({
      provider: 'ms_todo',
      externalId: 'ms-provider-task-2',
      title: 'Emitir Nota MV',
      providerData: { listId: 'ms-list-siemens', '@odata.etag': 'etag-v1' },
    });

    upsertTask(USER_ID, task);
    softDeleteMissing(USER_ID, 'ms_todo', []);

    const result = upsertTask(USER_ID, {
      ...task,
      dueDate: '2026-07-07',
      providerData: { listId: 'ms-list-siemens', '@odata.etag': 'etag-v2' },
    });
    const row = testDb.prepare(
      `SELECT t.sync_state, l.link_state, l.provider_version
       FROM unified_tasks t
       INNER JOIN task_provider_links l
         ON l.tenant_id = t.tenant_id
        AND l.user_id = t.user_id
        AND l.task_id = t.nexus_task_id
       WHERE t.user_id = ? AND t.provider = 'ms_todo' AND t.external_id = ?`,
    ).get(USER_ID, 'ms-provider-task-2') as {
      sync_state: string;
      link_state: string;
      provider_version: string;
    };

    expect(result).toBe('updated');
    expect(row).toEqual({
      sync_state: 'synced',
      link_state: 'linked',
      provider_version: 'etag-v2',
    });
  });

  it('marks conflicts instead of overwriting a task with pending local mutations', () => {
    const task = makeTask({
      provider: 'todoist',
      externalId: 'todoist-conflict-task',
      title: 'Local title',
      providerData: { project_id: 'todoist-project-3' },
    });
    upsertTask(USER_ID, task);

    testDb.prepare(
      `UPDATE unified_tasks
       SET sync_state = 'queued', title = 'Local edited title'
       WHERE user_id = ? AND provider = 'todoist' AND external_id = ?`,
    ).run(USER_ID, 'todoist-conflict-task');

    const result = upsertTask(USER_ID, { ...task, title: 'Provider edited title' });
    const row = testDb.prepare(
      `SELECT title, sync_state
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist' AND external_id = ?`,
    ).get(USER_ID, 'todoist-conflict-task') as { title: string; sync_state: string };

    expect(result).toBe('unchanged');
    expect(row).toEqual({ title: 'Local edited title', sync_state: 'conflict' });
  });
});

// ── softDeleteMissing ──────────────────────────────────────────────

describe('softDeleteMissing', () => {
  it('marks tasks not in the current set as provider_missing without hiding local data', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'a' }));
    upsertTask(USER_ID, makeTask({ externalId: 'b' }));
    upsertTask(USER_ID, makeTask({ externalId: 'c' }));

    const marked = softDeleteMissing(USER_ID, 'todoist', ['a', 'c']);
    expect(marked).toBe(1);

    const rows = testDb.prepare(
      `SELECT external_id, is_deleted, sync_state
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist'
       ORDER BY external_id`,
    ).all(USER_ID) as Array<{ external_id: string; is_deleted: number; sync_state: string }>;

    expect(rows).toEqual([
      { external_id: 'a', is_deleted: 0, sync_state: 'synced' },
      { external_id: 'b', is_deleted: 0, sync_state: 'provider_missing' },
      { external_id: 'c', is_deleted: 0, sync_state: 'synced' },
    ]);
  });

  it('marks all provider tasks missing when current set is empty', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'a' }));
    upsertTask(USER_ID, makeTask({ externalId: 'b' }));

    const marked = softDeleteMissing(USER_ID, 'todoist', []);
    const states = testDb.prepare(
      `SELECT sync_state
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist'
       ORDER BY external_id`,
    ).all(USER_ID) as Array<{ sync_state: string }>;

    expect(marked).toBe(2);
    expect(states.map((row) => row.sync_state)).toEqual(['provider_missing', 'provider_missing']);
    expect(getPendingTasks(USER_ID)).toHaveLength(2);
  });

  it('only touches the specified provider', () => {
    upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'tt' }));
    upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'mm' }));

    softDeleteMissing(USER_ID, 'todoist', []);

    const states = testDb.prepare(
      `SELECT provider, sync_state
       FROM unified_tasks
       WHERE user_id = ?
       ORDER BY provider`,
    ).all(USER_ID) as Array<{ provider: string; sync_state: string }>;

    expect(states).toEqual([
      { provider: 'ms_todo', sync_state: 'synced' },
      { provider: 'todoist', sync_state: 'provider_missing' },
    ]);
  });

  it('marks missing provider tasks as conflict when local mutations are pending', () => {
    upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'pending-local-delete' }));
    testDb.prepare(
      `UPDATE unified_tasks
       SET sync_state = 'queued'
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'pending-local-delete'`,
    ).run(USER_ID);

    const marked = softDeleteMissing(USER_ID, 'todoist', []);
    const row = testDb.prepare(
      `SELECT is_deleted, sync_state
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'pending-local-delete'`,
    ).get(USER_ID) as { is_deleted: number; sync_state: string };

    expect(marked).toBe(1);
    expect(row).toEqual({ is_deleted: 0, sync_state: 'conflict' });
  });
});

// ── Reader queries ──────────────────────────────────────────────────

describe('reader queries', () => {
  beforeEach(() => {
    upsertTask(USER_ID, makeTask({ externalId: 'no-due', title: 'No due date' }));
    upsertTask(USER_ID, makeTask({ externalId: 'overdue', title: 'Overdue', dueDate: '2020-01-01' }));
    // Use SQLite "today" for portability
    const today = testDb.prepare("SELECT date('now') AS d").get() as { d: string };
    const tomorrow = testDb.prepare("SELECT date('now', '+1 day') AS d").get() as { d: string };
    upsertTask(USER_ID, makeTask({ externalId: 'today', title: 'Due today', dueDate: today.d }));
    upsertTask(USER_ID, makeTask({ externalId: 'tomorrow', title: 'Due tomorrow', dueDate: tomorrow.d }));
  });

  it('getPendingTasks returns all non-deleted pending', () => {
    expect(getPendingTasks(USER_ID)).toHaveLength(4);
  });

  it('getOverdueTasks returns only overdue', () => {
    const overdue = getOverdueTasks(USER_ID);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].externalId).toBe('overdue');
  });

  it('getTasksDueToday returns only due-today', () => {
    const today = getTasksDueToday(USER_ID);
    expect(today).toHaveLength(1);
    expect(today[0].externalId).toBe('today');
  });

  it('getTasksDueThisWeek includes today and tomorrow but not overdue', () => {
    const week = getTasksDueThisWeek(USER_ID);
    const ids = week.map(t => t.externalId);
    expect(ids).toContain('today');
    expect(ids).toContain('tomorrow');
    expect(ids).not.toContain('overdue');
  });

  it('getAllTasks supports provider filter', () => {
    upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'msx' }));
    const all = getAllTasks(USER_ID, { provider: 'ms_todo' });
    expect(all).toHaveLength(1);
    expect(all[0].provider).toBe('ms_todo');
  });

  it('excludes deleted tasks from getPendingTasks', () => {
    const tasks = getAllTasks(USER_ID);
    markTaskDeleted(tasks[0].id!);
    expect(getPendingTasks(USER_ID)).toHaveLength(3);
  });

  it('markTaskCompleted moves task out of pending', () => {
    const tasks = getPendingTasks(USER_ID);
    markTaskCompleted(tasks[0].id!);
    expect(getPendingTasks(USER_ID)).toHaveLength(3);
    const completed = getAllTasks(USER_ID, { status: 'completed' });
    expect(completed).toHaveLength(1);
  });
});

// ── User preferences ───────────────────────────────────────────────

describe('default provider preferences', () => {
  it('defaults to nexus when no preference is set', () => {
    expect(getDefaultProvider(USER_ID)).toBe('nexus');
  });

  it('persists and round-trips a custom provider', () => {
    setDefaultProvider(USER_ID, 'todoist');
    expect(getDefaultProvider(USER_ID)).toBe('todoist');
  });

  it('overwrites on second set', () => {
    setDefaultProvider(USER_ID, 'todoist');
    setDefaultProvider(USER_ID, 'ms_todo');
    expect(getDefaultProvider(USER_ID)).toBe('ms_todo');
  });
});

// ── Sync state ─────────────────────────────────────────────────────

describe('sync state', () => {
  it('returns null when no state exists', () => {
    expect(getSyncState(USER_ID, 'todoist')).toBeNull();
  });

  it('saves and loads sync state', () => {
    saveSyncState(USER_ID, 'todoist', {
      lastSyncAt: '2026-04-06T12:00:00Z',
      syncCursor: 'cursor_abc',
      status: 'idle',
      tasksSynced: 23,
      durationMs: 1500,
    });

    const state = getSyncState(USER_ID, 'todoist');
    expect(state).not.toBeNull();
    expect(state!.sync_cursor).toBe('cursor_abc');
    expect(state!.status).toBe('idle');
    expect(state!.tasks_synced).toBe(23);
  });

  it('updateSyncStatus updates only the status fields', () => {
    saveSyncState(USER_ID, 'todoist', { status: 'idle', syncCursor: 'old' });
    updateSyncStatus(USER_ID, 'todoist', 'syncing');

    const state = getSyncState(USER_ID, 'todoist');
    expect(state!.status).toBe('syncing');
  });
});

// ── upsertProject ──────────────────────────────────────────────────

describe('upsertProject', () => {
  it('inserts a new project', () => {
    const result = upsertProject(USER_ID, {
      provider: 'todoist',
      externalId: 'p1',
      name: 'Inbox',
      isDefault: true,
    });
    expect(result).toBe('inserted');
  });

  it('returns unchanged on identical re-upsert', () => {
    const project = { provider: 'todoist' as const, externalId: 'p2', name: 'Work' };
    upsertProject(USER_ID, project);
    expect(upsertProject(USER_ID, project)).toBe('unchanged');
  });

  it('returns updated when name changes', () => {
    upsertProject(USER_ID, { provider: 'todoist', externalId: 'p3', name: 'Old Name' });
    const result = upsertProject(USER_ID, { provider: 'todoist', externalId: 'p3', name: 'New Name' });
    expect(result).toBe('updated');
  });

  it('creates a bidirectional Microsoft To Do container mapping for imported provider lists', () => {
    const result = upsertProject(USER_ID, {
      provider: 'ms_todo',
      externalId: 'ms-list-1',
      name: 'Tasks',
      isDefault: true,
    });

    const providerList = testDb.prepare(
      `SELECT id, provider, name
       FROM unified_projects
       WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'ms-list-1'
       LIMIT 1`,
    ).get(USER_ID) as { id: number; provider: string; name: string } | undefined;
    const nexusListCount = testDb.prepare(
      `SELECT COUNT(*) AS count
       FROM unified_projects
       WHERE user_id = ? AND provider = 'nexus' AND lower(name) = lower('Tasks')`,
    ).get(USER_ID) as { count: number };
    const mapping = testDb.prepare(
      `SELECT provider, provider_container_type, provider_container_id, sync_direction
       FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ? AND provider = 'ms_todo'
       LIMIT 1`,
    ).get(USER_ID, USER_ID, String(providerList?.id ?? '')) as {
      provider: string;
      provider_container_type: string;
      provider_container_id: string;
      sync_direction: string;
    } | undefined;

    expect(result).toBe('inserted');
    expect(providerList).toMatchObject({ provider: 'ms_todo', name: 'Tasks' });
    expect(nexusListCount.count).toBe(0);
    expect(mapping).toMatchObject({
      provider: 'ms_todo',
      provider_container_type: 'todo_list',
      provider_container_id: 'ms-list-1',
      sync_direction: 'bidirectional',
    });
  });

  it('preserves an explicit non-bidirectional mapping preference on provider re-sync', () => {
    upsertProject(USER_ID, {
      provider: 'ms_todo',
      externalId: 'ms-list-1',
      name: 'Tasks',
      isDefault: true,
    });
    const providerList = testDb.prepare(
      `SELECT id
       FROM unified_projects
       WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'ms-list-1'
       LIMIT 1`,
    ).get(USER_ID) as { id: number } | undefined;
    expect(providerList).toBeTruthy();
    testDb.prepare(
      `UPDATE task_container_mappings
       SET sync_direction = 'pull_only'
       WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ? AND provider = 'ms_todo'`,
    ).run(USER_ID, USER_ID, String(providerList!.id));

    upsertProject(USER_ID, {
      provider: 'ms_todo',
      externalId: 'ms-list-1',
      name: 'Tasks Updated',
      isDefault: true,
    });
    const mapping = testDb.prepare(
      `SELECT provider_container_id, sync_direction
       FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ? AND provider = 'ms_todo'
       LIMIT 1`,
    ).get(USER_ID, USER_ID, String(providerList!.id)) as { provider_container_id: string; sync_direction: string };

    expect(mapping).toMatchObject({
      provider_container_id: 'ms-list-1',
      sync_direction: 'pull_only',
    });
  });
});

// ── Stats ──────────────────────────────────────────────────────────

describe('getTaskStats', () => {
  it('produces a complete stats snapshot', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'a', dueDate: '2020-01-01' }));
    upsertTask(USER_ID, makeTask({ externalId: 'b' }));
    upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'c' }));

    const stats = getTaskStats(USER_ID);
    expect(stats.totalPending).toBe(3);
    expect(stats.totalOverdue).toBe(1);
    expect(stats.byProvider.todoist).toBe(2);
    expect(stats.byProvider.ms_todo).toBe(1);
  });
});
