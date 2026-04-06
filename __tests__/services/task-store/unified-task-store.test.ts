/**
 * Tests for src/services/task-store/unified-task-store.ts
 *
 * Covers:
 *   - hash-based upsert (inserted / updated / unchanged)
 *   - computeContentHash determinism + sensitivity
 *   - softDeleteMissing for full-pull diffs
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
}

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
});

// ── softDeleteMissing ──────────────────────────────────────────────

describe('softDeleteMissing', () => {
  it('marks tasks not in the current set as deleted', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'a' }));
    upsertTask(USER_ID, makeTask({ externalId: 'b' }));
    upsertTask(USER_ID, makeTask({ externalId: 'c' }));

    const deleted = softDeleteMissing(USER_ID, 'todoist', ['a', 'c']);
    expect(deleted).toBe(1);

    const remaining = getPendingTasks(USER_ID).map(t => t.externalId).sort();
    expect(remaining).toEqual(['a', 'c']);
  });

  it('marks all tasks deleted when current set is empty', () => {
    upsertTask(USER_ID, makeTask({ externalId: 'a' }));
    upsertTask(USER_ID, makeTask({ externalId: 'b' }));

    const deleted = softDeleteMissing(USER_ID, 'todoist', []);
    expect(deleted).toBe(2);
    expect(getPendingTasks(USER_ID)).toHaveLength(0);
  });

  it('only touches the specified provider', () => {
    upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'tt' }));
    upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'mm' }));

    softDeleteMissing(USER_ID, 'todoist', []);

    const surviving = getPendingTasks(USER_ID);
    expect(surviving).toHaveLength(1);
    expect(surviving[0].provider).toBe('ms_todo');
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
