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
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
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
  withDatabaseForTestAsync: vi.fn(),
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
  testDb = createMigratedTestDatabase();
  const seedUser = testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let id = 1; id <= 1000; id += 1) seedUser.run(id, id);
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

  it('does not resurrect a pending-delete on divergent re-upsert; flags conflict instead (NEX-19)', () => {
    const task = makeTask({ externalId: 'res1' });
    upsertTask(USER_ID, task);
    const tasks = getAllTasks(USER_ID);
    markTaskDeleted(tasks[0].id!);
    expect(getPendingTasks(USER_ID)).toHaveLength(0);

    // Re-upsert with new title (hash change). The row is
    // 'deleted_pending_sync' — it carries an un-pushed local delete — so the
    // pull must NOT overwrite/resurrect it; the divergence is surfaced as a
    // conflict and the tombstone stays.
    upsertTask(USER_ID, { ...task, title: 'Resurrected' });
    expect(getPendingTasks(USER_ID)).toHaveLength(0);
    const row = testDb.prepare(
      "SELECT sync_state, is_deleted, title FROM unified_tasks WHERE user_id = ? AND external_id = 'res1'",
    ).get(USER_ID) as { sync_state: string; is_deleted: number; title: string };
    expect(row.sync_state).toBe('conflict');
    expect(row.is_deleted).toBe(1);
    expect(row.title).toBe(task.title);

    // A delete that already pushed leaves the row 'synced'; if the provider
    // later re-creates the task, resurrection is legitimate and still works.
    testDb.prepare(
      "UPDATE unified_tasks SET sync_state = 'synced' WHERE user_id = ? AND external_id = 'res1'",
    ).run(USER_ID);
    upsertTask(USER_ID, { ...task, title: 'Recreated later' });
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

  it('does not flip a provider_disconnected row to synced on a hash-equal provider sighting (NEX-03)', () => {
    // 'provider_disconnected' is only written when a local mutation was parked
    // by an auth failure. A pull that sees the provider's (stale) copy of the
    // same content must NOT mark the row healthy — the parked edit has not
    // been delivered yet. Only the worker's markSynced heals this state.
    const task = makeTask({ externalId: 'disc-mask-1', title: 'Edited while disconnected' });
    upsertTask(USER_ID, task);
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'provider_disconnected'
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'disc-mask-1'`,
    ).run(USER_ID);

    const result = upsertTask(USER_ID, task);
    const row = testDb.prepare(
      `SELECT sync_state, title
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'disc-mask-1'`,
    ).get(USER_ID) as { sync_state: string; title: string };

    expect(result).toBe('unchanged');
    expect(row).toEqual({ sync_state: 'provider_disconnected', title: 'Edited while disconnected' });
  });

  it('marks conflict without overwriting when provider content diverges from a provider_disconnected row (NEX-03)', () => {
    const task = makeTask({ externalId: 'disc-conflict-1', title: 'Local disconnected edit' });
    upsertTask(USER_ID, task);
    testDb.prepare(
      `UPDATE unified_tasks SET sync_state = 'provider_disconnected'
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'disc-conflict-1'`,
    ).run(USER_ID);

    const result = upsertTask(USER_ID, { ...task, title: 'Provider edited title' });
    const row = testDb.prepare(
      `SELECT sync_state, title
       FROM unified_tasks
       WHERE user_id = ? AND provider = 'todoist' AND external_id = 'disc-conflict-1'`,
    ).get(USER_ID) as { sync_state: string; title: string };

    expect(result).toBe('unchanged');
    expect(row).toEqual({ sync_state: 'conflict', title: 'Local disconnected edit' });
  });

  it('still heals provider_missing, stale, and failed_retryable rows on a hash-equal sighting', () => {
    // Regression guard for the reduced recoverable-absence set: dropping
    // 'provider_disconnected' from it must not break healing for the states
    // that legitimately recover when the provider shows the task again.
    const states = ['provider_missing', 'stale', 'failed_retryable'] as const;

    const observed = states.map((state) => {
      const externalId = `heal-${state}`;
      const task = makeTask({ externalId });
      upsertTask(USER_ID, task);
      testDb.prepare(
        `UPDATE unified_tasks SET sync_state = ?
         WHERE user_id = ? AND provider = 'todoist' AND external_id = ?`,
      ).run(state, USER_ID, externalId);

      const result = upsertTask(USER_ID, task);
      const row = testDb.prepare(
        `SELECT sync_state
         FROM unified_tasks
         WHERE user_id = ? AND provider = 'todoist' AND external_id = ?`,
      ).get(USER_ID, externalId) as { sync_state: string };
      return { state, result, syncState: row.sync_state };
    });

    expect(observed).toEqual([
      { state: 'provider_missing', result: 'unchanged', syncState: 'synced' },
      { state: 'stale', result: 'unchanged', syncState: 'synced' },
      { state: 'failed_retryable', result: 'unchanged', syncState: 'synced' },
    ]);
  });
});

// ── last_synced_snapshot capture on pulls (M2B) ────────────────────

describe('pull-side last_synced_snapshot capture (M2B)', () => {
  function readSnapshot(externalId: string): Record<string, unknown> | null {
    const row = testDb.prepare(
      `SELECT l.last_synced_snapshot AS snapshot
       FROM task_provider_links l
       INNER JOIN unified_tasks t
         ON t.nexus_task_id = l.task_id AND t.user_id = l.user_id
       WHERE t.user_id = ? AND t.external_id = ?`,
    ).get(USER_ID, externalId) as { snapshot: string | null } | undefined;
    return row?.snapshot ? JSON.parse(row.snapshot) : null;
  }

  it('captures the imported provider content as the agreed base on insert', () => {
    upsertTask(USER_ID, makeTask({
      provider: 'ms_todo',
      externalId: 'ms-snap-insert',
      title: 'Imported title',
      dueDate: '2026-07-20T09:00:00Z',
      dueIsDatetime: true,
      notes: 'imported note',
      providerData: { listId: 'ms-list-1', '@odata.etag': 'etag-v1' },
    }));

    expect(readSnapshot('ms-snap-insert')).toEqual({
      title: 'Imported title',
      status: 'pending',
      priority: 2,
      dueDate: '2026-07-20T09:00:00Z',
      dueIsDatetime: true,
      notes: 'imported note',
    });
  });

  it('advances the snapshot on the pull overwrite path and on hash-equal sightings', () => {
    const task = makeTask({
      provider: 'ms_todo',
      externalId: 'ms-snap-overwrite',
      title: 'First',
      providerData: { listId: 'ms-list-1', '@odata.etag': 'etag-v1' },
    });
    upsertTask(USER_ID, task);

    // Overwrite (hash changed, no pending local mutation) refreshes the base.
    upsertTask(USER_ID, { ...task, title: 'Second' });
    expect(readSnapshot('ms-snap-overwrite')).toMatchObject({ title: 'Second' });

    // Hash-equal sighting keeps capturing (rides the existing link upsert —
    // no extra read in markProviderTaskSeen).
    upsertTask(USER_ID, { ...task, title: 'Second' });
    expect(readSnapshot('ms-snap-overwrite')).toMatchObject({ title: 'Second' });
  });

  it('does NOT advance the snapshot when a divergent pull conflicts a pending-local row', () => {
    const task = makeTask({
      provider: 'ms_todo',
      externalId: 'ms-snap-conflict',
      title: 'Agreed base',
      providerData: { listId: 'ms-list-1', '@odata.etag': 'etag-v1' },
    });
    upsertTask(USER_ID, task);
    testDb.prepare(
      "UPDATE unified_tasks SET sync_state = 'queued' WHERE user_id = ? AND external_id = 'ms-snap-conflict'",
    ).run(USER_ID);

    upsertTask(USER_ID, { ...task, title: 'Provider-side divergence' });

    const row = testDb.prepare(
      "SELECT sync_state FROM unified_tasks WHERE user_id = ? AND external_id = 'ms-snap-conflict'",
    ).get(USER_ID) as { sync_state: string };
    expect(row.sync_state).toBe('conflict');
    // The provider's divergent copy is one SIDE of the conflict, not a base:
    // the snapshot must keep pointing at the last agreed content.
    expect(readSnapshot('ms-snap-conflict')).toMatchObject({ title: 'Agreed base' });
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

// ── Canonical links (M4) ───────────────────────────────────────────

describe('canonical links (M4)', () => {
  const MS_ACCOUNT = `ms_todo:${USER_ID}`;

  /**
   * Seed a pushed Nexus-origin task the way the offline-first create path
   * plus the sync worker's markSynced leave it after a successful push:
   * the unified_tasks row keeps its nexus origin identity (provider 'nexus',
   * external_id = nexus task id) while the task_provider_links row carries
   * the provider-side identity (provider_task_id = Graph id, link_state
   * 'linked', ownership 'nexus_created').
   */
  function seedPushedNexusTask(opts: {
    nexusTaskId: string;
    providerTaskId: string | null;
    title?: string;
    syncState?: string;
    isDeleted?: number;
    linkState?: string;
    linkId?: string;
    providerListId?: string | null;
  }): { linkId: string } {
    const title = opts.title ?? 'Pushed task';
    const contentHash = computeContentHash({
      provider: 'nexus',
      externalId: opts.nexusTaskId,
      title,
      status: 'pending',
      priority: 2,
    });
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, status, priority,
         tags, provider_data, content_hash, is_deleted, synced_at,
         nexus_task_id, local_version, sync_state, source_of_truth
       ) VALUES (?, ?, 'nexus', ?, ?, 'pending', 2, '[]', '{}', ?, ?, datetime('now'), ?, 1, ?, 'nexus')`,
    ).run(
      USER_ID,
      USER_ID,
      opts.nexusTaskId,
      title,
      contentHash,
      opts.isDeleted ?? 0,
      opts.nexusTaskId,
      opts.syncState ?? 'synced',
    );
    const linkId = opts.linkId ?? `link_${opts.nexusTaskId}`;
    testDb.prepare(
      `INSERT INTO task_provider_links (
         id, task_id, tenant_id, user_id, provider, provider_account_id,
         provider_task_id, provider_list_id, ownership, link_state,
         last_synced_at, last_verified_at
       ) VALUES (?, ?, ?, ?, 'ms_todo', ?, ?, ?, 'nexus_created', ?, datetime('now'), datetime('now'))`,
    ).run(
      linkId,
      opts.nexusTaskId,
      USER_ID,
      USER_ID,
      MS_ACCOUNT,
      opts.providerTaskId,
      opts.providerListId ?? 'ms-list-work',
      opts.linkState ?? 'linked',
    );
    return { linkId };
  }

  function msPayload(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
    return {
      provider: 'ms_todo',
      externalId: 'MS-G1',
      title: 'Pushed task',
      status: 'pending',
      priority: 2,
      ...overrides,
    };
  }

  function taskRows(): Array<{
    provider: string;
    external_id: string;
    nexus_task_id: string | null;
    title: string;
    sync_state: string | null;
    is_deleted: number;
  }> {
    return testDb.prepare(
      `SELECT provider, external_id, nexus_task_id, title, sync_state, is_deleted
       FROM unified_tasks
       WHERE user_id = ?
       ORDER BY id`,
    ).all(USER_ID) as Array<{
      provider: string;
      external_id: string;
      nexus_task_id: string | null;
      title: string;
      sync_state: string | null;
      is_deleted: number;
    }>;
  }

  it('routes a pull through the active link so a pushed nexus task is not re-imported as a twin (NEX-02)', () => {
    seedPushedNexusTask({ nexusTaskId: 'task_nex02_pushed', providerTaskId: 'MS-G1' });

    const result = upsertTask(USER_ID, msPayload());

    expect(result).toBe('unchanged');
    expect(taskRows()).toEqual([
      expect.objectContaining({
        provider: 'nexus',
        external_id: 'task_nex02_pushed',
        nexus_task_id: 'task_nex02_pushed',
        sync_state: 'synced',
        is_deleted: 0,
      }),
    ]);
    const links = testDb.prepare(
      `SELECT task_id, ownership, link_state
       FROM task_provider_links
       WHERE tenant_id = ? AND user_id = ? AND provider = 'ms_todo' AND provider_task_id = 'MS-G1'`,
    ).all(USER_ID, USER_ID) as Array<Record<string, unknown>>;
    expect(links).toEqual([
      expect.objectContaining({
        task_id: 'task_nex02_pushed',
        ownership: 'nexus_created',
        link_state: 'linked',
      }),
    ]);
  });

  it('applies provider content changes onto the canonical row through the link without rewriting its identity', () => {
    seedPushedNexusTask({ nexusTaskId: 'task_nex02_update', providerTaskId: 'MS-G1' });

    const result = upsertTask(USER_ID, msPayload({ title: 'Retitled at Microsoft' }));

    expect(result).toBe('updated');
    expect(taskRows()).toEqual([
      expect.objectContaining({
        provider: 'nexus',
        external_id: 'task_nex02_update',
        title: 'Retitled at Microsoft',
        sync_state: 'synced',
      }),
    ]);
  });

  it('flags conflict instead of overwriting when the linked canonical row has pending local changes', () => {
    seedPushedNexusTask({
      nexusTaskId: 'task_nex02_pending',
      providerTaskId: 'MS-G1',
      title: 'Local edited title',
      syncState: 'queued',
    });

    const result = upsertTask(USER_ID, msPayload({ title: 'Provider edited title' }));

    expect(result).toBe('unchanged');
    expect(taskRows()).toEqual([
      expect.objectContaining({
        provider: 'nexus',
        title: 'Local edited title',
        sync_state: 'conflict',
      }),
    ]);
  });

  it('adopts a recreated provider id onto the marked task link instead of importing a twin (Microsoft move)', () => {
    const { linkId } = seedPushedNexusTask({
      nexusTaskId: 'task_moved_1',
      providerTaskId: 'MS-OLD',
      providerListId: 'ms-list-old',
    });

    const result = upsertTask(USER_ID, msPayload({
      externalId: 'MS-NEW',
      providerData: {
        listId: 'ms-list-new',
        linkedResources: [{ externalId: 'task_moved_1', applicationName: 'Nexus Hub' }],
      },
    }));

    expect(result).toBe('unchanged');
    expect(taskRows()).toEqual([
      expect.objectContaining({ provider: 'nexus', external_id: 'task_moved_1' }),
    ]);
    const link = testDb.prepare(
      `SELECT task_id, provider_task_id, provider_list_id FROM task_provider_links WHERE id = ?`,
    ).get(linkId) as Record<string, unknown>;
    expect(link).toEqual({
      task_id: 'task_moved_1',
      provider_task_id: 'MS-NEW',
      provider_list_id: 'ms-list-new',
    });
    const linkCount = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_provider_links WHERE user_id = ? AND provider = 'ms_todo'`,
    ).get(USER_ID) as { count: number };
    expect(linkCount.count).toBe(1);
  });

  it('imports a fresh row when the marker does not resolve to a task with an active same-provider link', () => {
    // A live nexus task whose only link is the local one: the marker matches
    // the task id but there is no active ms_todo link to adopt onto.
    const contentHash = computeContentHash({
      provider: 'nexus', externalId: 'task_local_only', title: 'Local only', status: 'pending', priority: 2,
    });
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, status, priority,
         tags, provider_data, content_hash, synced_at, nexus_task_id, local_version, sync_state, source_of_truth
       ) VALUES (?, ?, 'nexus', 'task_local_only', 'Local only', 'pending', 2, '[]', '{}', ?, datetime('now'), 'task_local_only', 1, 'local_only', 'nexus')`,
    ).run(USER_ID, USER_ID, contentHash);
    testDb.prepare(
      `INSERT INTO task_provider_links (
         id, task_id, tenant_id, user_id, provider, provider_account_id,
         provider_task_id, ownership, link_state
       ) VALUES ('link_local_only', 'task_local_only', ?, ?, 'nexus_local', ?, 'task_local_only', 'linked', 'linked')`,
    ).run(USER_ID, USER_ID, `nexus_local:${USER_ID}`);

    const result = upsertTask(USER_ID, msPayload({
      externalId: 'MS-FRESH',
      title: 'Provider task with stray marker',
      providerData: { linkedResources: [{ externalId: 'task_local_only' }] },
    }));

    expect(result).toBe('inserted');
    expect(taskRows()).toEqual([
      expect.objectContaining({ provider: 'nexus', external_id: 'task_local_only', title: 'Local only' }),
      expect.objectContaining({ provider: 'ms_todo', external_id: 'MS-FRESH' }),
    ]);
  });

  it('returns unchanged for a merged tombstone without resurrecting it or creating links', () => {
    testDb.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, title, status, priority,
         tags, provider_data, content_hash, is_deleted, deleted_at, synced_at,
         nexus_task_id, local_version, sync_state, source_of_truth
       ) VALUES (?, ?, 'ms_todo', 'MS-TOMB', 'Merged twin', 'pending', 2, '[]',
         '{"merged_into":"task_canonical_1"}', 'stalehash0000000', 1, datetime('now'), datetime('now'),
         'task_twin_1', 1, 'synced', 'nexus')`,
    ).run(USER_ID, USER_ID);

    const result = upsertTask(USER_ID, msPayload({
      externalId: 'MS-TOMB',
      title: 'Provider still sends the twin',
    }));

    expect(result).toBe('unchanged');
    expect(taskRows()).toEqual([
      expect.objectContaining({
        provider: 'ms_todo',
        external_id: 'MS-TOMB',
        title: 'Merged twin',
        is_deleted: 1,
        sync_state: 'synced',
      }),
    ]);
    const linkCount = testDb.prepare(
      `SELECT COUNT(*) AS count FROM task_provider_links WHERE user_id = ? AND provider_task_id = 'MS-TOMB'`,
    ).get(USER_ID) as { count: number };
    expect(linkCount.count).toBe(0);
  });

  it('does not let an insert-path upsert re-point a link away from a live row', () => {
    // An orphaned duplicate link (e.g. parked by migration 234 cleanup) still
    // occupies the (provider, account, provider_task_id) unique slot while
    // pointing at the live canonical row. Importing that provider id inserts
    // a fresh row (orphaned links are invisible to links-first routing) and
    // ensureProviderLinkForTask collides with the parked slot — the collision
    // must NOT steal the link away from the live row.
    seedPushedNexusTask({
      nexusTaskId: 'task_guard_live',
      providerTaskId: 'MS-G1',
      linkState: 'orphaned',
      linkId: 'link_guard_live',
    });

    const result = upsertTask(USER_ID, msPayload({ title: 'Imported twin' }));

    expect(result).toBe('inserted');
    const link = testDb.prepare(
      `SELECT task_id FROM task_provider_links WHERE id = 'link_guard_live'`,
    ).get() as { task_id: string };
    expect(link.task_id).toBe('task_guard_live');
    const twin = testDb.prepare(
      `SELECT nexus_task_id FROM unified_tasks WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'MS-G1'`,
    ).get(USER_ID) as { nexus_task_id: string };
    expect(twin.nexus_task_id).not.toBe('task_guard_live');
  });

  it('still re-points a conflicting link away from a soft-deleted row', () => {
    seedPushedNexusTask({
      nexusTaskId: 'task_guard_dead',
      providerTaskId: 'MS-G1',
      isDeleted: 1,
      linkState: 'orphaned',
      linkId: 'link_guard_dead',
    });

    const result = upsertTask(USER_ID, msPayload({ title: 'Re-imported after delete' }));

    expect(result).toBe('inserted');
    const inserted = testDb.prepare(
      `SELECT nexus_task_id FROM unified_tasks WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'MS-G1'`,
    ).get(USER_ID) as { nexus_task_id: string };
    const link = testDb.prepare(
      `SELECT task_id FROM task_provider_links WHERE id = 'link_guard_dead'`,
    ).get() as { task_id: string };
    expect(link.task_id).toBe(inserted.nexus_task_id);
  });

  describe('M10 priority echo stability (NEX-17)', () => {
    function seedWithPriority(nexusTaskId: string, providerTaskId: string, priority: number, title = 'Pushed task'): void {
      seedPushedNexusTask({ nexusTaskId, providerTaskId, title, linkId: `link_${nexusTaskId}` });
      const hash = computeContentHash({
        provider: 'nexus',
        externalId: nexusTaskId,
        title,
        status: 'pending',
        priority,
      } as NormalizedTask);
      testDb.prepare(
        'UPDATE unified_tasks SET priority = ?, content_hash = ? WHERE nexus_task_id = ?',
      ).run(priority, hash, nexusTaskId);
    }

    function storedRow(nexusTaskId: string): { priority: number; local_version: number; title: string } {
      return testDb.prepare(
        'SELECT priority, local_version, title FROM unified_tasks WHERE nexus_task_id = ?',
      ).get(nexusTaskId) as { priority: number; local_version: number; title: string };
    }

    it('keeps a stored P1 when its own push echoes back as high (importance→2)', () => {
      seedWithPriority('task_echo_p1', 'MS-E1', 1);

      // P1 pushed as 'high'; the pull imports 'high' as priority 2.
      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-E1', priority: 2 }));

      expect(result).toBe('unchanged');
      // Kept value + kept-value hash → no phantom change recorded.
      expect(storedRow('task_echo_p1')).toMatchObject({ priority: 1, local_version: 1 });
    });

    it('keeps a stored P4 across its low echo', () => {
      seedWithPriority('task_echo_p4', 'MS-E4', 4);

      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-E4', priority: 4 }));

      expect(result).toBe('unchanged');
      expect(storedRow('task_echo_p4')).toMatchObject({ priority: 4, local_version: 1 });
    });

    it('keeps a stored none (0) when the provider echoes normal (importance→3)', () => {
      seedWithPriority('task_echo_none', 'MS-E0', 0);

      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-E0', priority: 3 }));

      expect(result).toBe('unchanged');
      expect(storedRow('task_echo_none')).toMatchObject({ priority: 0, local_version: 1 });
    });

    it('accepts a real provider-side importance change (high bucket → low) as the incoming priority', () => {
      seedWithPriority('task_echo_change', 'MS-EC', 1);

      // The user set the task to 'low' in Outlook — different bucket, real change.
      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-EC', priority: 4 }));

      expect(result).toBe('updated');
      expect(storedRow('task_echo_change').priority).toBe(4);
    });

    it('preserves the stored fine-grained priority through a real overwrite of other fields', () => {
      seedWithPriority('task_echo_mixed', 'MS-EM', 1, 'Old provider title');

      // Title changed provider-side; importance is still the P1 echo ('high'→2).
      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-EM', title: 'New provider title', priority: 2 }));

      expect(result).toBe('updated');
      expect(storedRow('task_echo_mixed')).toMatchObject({ priority: 1, title: 'New provider title' });
    });

    it('takes the incoming priority as-is when the stored priority is NULL (legacy row)', () => {
      seedWithPriority('task_echo_null', 'MS-EN', 0);
      testDb.prepare('UPDATE unified_tasks SET priority = NULL WHERE nexus_task_id = ?').run('task_echo_null');

      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-EN', priority: 3 }));

      expect(result).toBe('updated');
      expect(storedRow('task_echo_null').priority).toBe(3);
    });

    it('takes the incoming priority as-is for an unlinked import', () => {
      const result = upsertTask(USER_ID, msPayload({ externalId: 'MS-FRESH', priority: 2 }));

      expect(result).toBe('inserted');
      const row = testDb.prepare(
        `SELECT priority FROM unified_tasks WHERE user_id = ? AND provider = 'ms_todo' AND external_id = 'MS-FRESH'`,
      ).get(USER_ID) as { priority: number };
      expect(row.priority).toBe(2);
    });

    it('does not apply the ms_todo echo rule to other providers', () => {
      upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'TD-1', priority: 2 }));

      const result = upsertTask(USER_ID, makeTask({ provider: 'todoist', externalId: 'TD-1', priority: 1 }));

      expect(result).toBe('updated');
      const row = testDb.prepare(
        `SELECT priority FROM unified_tasks WHERE user_id = ? AND provider = 'todoist' AND external_id = 'TD-1'`,
      ).get(USER_ID) as { priority: number };
      expect(row.priority).toBe(1);
    });
  });

  describe('softDeleteMissing via canonical links', () => {
    it('marks pushed nexus tasks missing through their provider link on a full pull', () => {
      seedPushedNexusTask({ nexusTaskId: 'task_push_gone', providerTaskId: 'MS-P1', linkId: 'link_push_gone' });
      seedPushedNexusTask({ nexusTaskId: 'task_push_kept', providerTaskId: 'MS-P2', linkId: 'link_push_kept' });
      upsertTask(USER_ID, makeTask({ provider: 'ms_todo', externalId: 'MS-M1' }));

      const marked = softDeleteMissing(USER_ID, 'ms_todo', ['MS-P2']);

      const rows = testDb.prepare(
        `SELECT external_id, sync_state, is_deleted FROM unified_tasks WHERE user_id = ? ORDER BY external_id`,
      ).all(USER_ID) as Array<{ external_id: string; sync_state: string; is_deleted: number }>;
      const linkStates = testDb.prepare(
        `SELECT id, link_state FROM task_provider_links WHERE user_id = ? AND id IN ('link_push_gone', 'link_push_kept')
         ORDER BY id`,
      ).all(USER_ID) as Array<{ id: string; link_state: string }>;

      expect(marked).toBe(2);
      expect(rows).toEqual([
        { external_id: 'MS-M1', sync_state: 'provider_missing', is_deleted: 0 },
        { external_id: 'task_push_gone', sync_state: 'provider_missing', is_deleted: 0 },
        { external_id: 'task_push_kept', sync_state: 'synced', is_deleted: 0 },
      ]);
      expect(linkStates).toEqual([
        { id: 'link_push_gone', link_state: 'provider_missing' },
        { id: 'link_push_kept', link_state: 'linked' },
      ]);
    });

    it('marks a pushed task with pending local changes as conflict when its provider id is missing', () => {
      seedPushedNexusTask({
        nexusTaskId: 'task_push_queued',
        providerTaskId: 'MS-P3',
        syncState: 'queued',
      });

      const marked = softDeleteMissing(USER_ID, 'ms_todo', ['MS-OTHER']);

      const row = testDb.prepare(
        `SELECT sync_state, is_deleted FROM unified_tasks WHERE user_id = ? AND nexus_task_id = 'task_push_queued'`,
      ).get(USER_ID) as { sync_state: string; is_deleted: number };
      expect(marked).toBe(1);
      expect(row).toEqual({ sync_state: 'conflict', is_deleted: 0 });
    });

    it('ignores pending-create links that never received a provider id', () => {
      seedPushedNexusTask({
        nexusTaskId: 'task_pending_create',
        providerTaskId: null,
        syncState: 'queued',
        linkState: 'pending_create',
        linkId: 'link_pending_create',
      });

      const marked = softDeleteMissing(USER_ID, 'ms_todo', []);

      const row = testDb.prepare(
        `SELECT sync_state FROM unified_tasks WHERE user_id = ? AND nexus_task_id = 'task_pending_create'`,
      ).get(USER_ID) as { sync_state: string };
      const link = testDb.prepare(
        `SELECT link_state FROM task_provider_links WHERE id = 'link_pending_create'`,
      ).get() as { link_state: string };
      expect(marked).toBe(0);
      expect(row.sync_state).toBe('queued');
      expect(link.link_state).toBe('pending_create');
    });
  });
});

// ─── M10 shared priority tables (NEX-17) ─────────────────────────────────────

describe('task-priority shared tables (M10)', () => {
  it('pins the outbound priority→importance table value-by-value', async () => {
    const { priorityToImportance } = await import('../../../src/services/task-store/task-priority');
    expect(priorityToImportance(1)).toBe('high');
    expect(priorityToImportance(2)).toBe('high');
    expect(priorityToImportance(3)).toBe('normal');
    expect(priorityToImportance(4)).toBe('low');
    expect(priorityToImportance(0)).toBe('normal');
    // Out-of-scale/garbage values project to the none bucket.
    expect(priorityToImportance(9)).toBe('normal');
    expect(priorityToImportance('not-a-number')).toBe('normal');
  });

  it('pins the inbound importance→priority table including client synonyms', async () => {
    const { importanceToPriority } = await import('../../../src/services/task-store/task-priority');
    expect(importanceToPriority('urgent')).toBe(1);
    expect(importanceToPriority('high')).toBe(2);
    expect(importanceToPriority('important')).toBe(2);
    expect(importanceToPriority('normal')).toBe(3);
    expect(importanceToPriority('medium')).toBe(3);
    expect(importanceToPriority('low')).toBe(4);
    expect(importanceToPriority('HIGH ')).toBe(2);
    expect(importanceToPriority('')).toBe(0);
    expect(importanceToPriority(undefined)).toBe(0);
    expect(importanceToPriority('somethingOdd')).toBe(0);
  });

  it('validates wire priorities strictly (integers 0–4 only)', async () => {
    const { isValidTaskPriorityInput, normalizeStoredTaskPriority } = await import('../../../src/services/task-store/task-priority');
    for (const valid of [0, 1, 2, 3, 4]) expect(isValidTaskPriorityInput(valid), String(valid)).toBe(true);
    for (const invalid of [-1, 5, 1.5, Number.NaN, '2', null, undefined, true]) {
      expect(isValidTaskPriorityInput(invalid), JSON.stringify(invalid)).toBe(false);
    }
    expect(normalizeStoredTaskPriority(3)).toBe(3);
    expect(normalizeStoredTaskPriority(9)).toBe(0);
    expect(normalizeStoredTaskPriority(-2)).toBe(0);
    expect(normalizeStoredTaskPriority(2.5)).toBe(0);
    expect(normalizeStoredTaskPriority(null)).toBe(0);
  });

  it('buckets and ranks consistently with the outbound table', async () => {
    const { sameImportanceBucket, taskPriorityRankSql } = await import('../../../src/services/task-store/task-priority');
    expect(sameImportanceBucket(1, 2)).toBe(true);
    expect(sameImportanceBucket(0, 3)).toBe(true);
    expect(sameImportanceBucket(2, 4)).toBe(false);
    expect(sameImportanceBucket(1, 4)).toBe(false);
    const ranks = testDb.prepare(
      `SELECT ${taskPriorityRankSql('value')} AS rank FROM (
         SELECT 1 AS value UNION ALL SELECT 4 UNION ALL SELECT 0 UNION ALL SELECT NULL UNION ALL SELECT 9
       ) ORDER BY value NULLS FIRST`,
    ).all() as Array<{ rank: number }>;
    // NULL, 0, 1, 4, 9 → none/garbage rank 5 (last), P-values rank as themselves.
    expect(ranks.map((row) => row.rank)).toEqual([5, 5, 1, 4, 5]);
  });
});
