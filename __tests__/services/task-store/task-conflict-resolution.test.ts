// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

const mockGetTaskProviderForUser = vi.fn();

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

vi.mock('../../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => true),
}));

vi.mock('../../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));

import {
  getTaskConflictPreview,
  resolveTaskConflict,
  _normalizeTheirsForTests,
} from '../../../src/services/task-store/task-conflict-resolution';

const USER_ID = 42;

const providerApi = {
  getTask: vi.fn(),
};

function seedConflictTask(input: {
  taskId?: string;
  syncState?: string | null;
  localVersion?: number | null;
  tags?: string | null;
  projectName?: string | null;
  withLink?: boolean;
  linkState?: string;
  providerTaskId?: string | null;
  providerListId?: string | null;
  providerVersion?: string | null;
  withConflictMutation?: boolean;
} = {}) {
  const taskId = input.taskId || 'task-unit-conflict-1';
  testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_id, project_name,
       title, status, priority, due_date, due_is_datetime, tags, notes,
       nexus_task_id, local_version, sync_state, source_of_truth
     ) VALUES (?, ?, 'nexus', ?, NULL, ?, 'Unit conflicted title', 'pending', 2,
       '2026-07-18T10:00:00Z', 1, ?, 'unit note', ?, ?, ?, 'nexus')`,
  ).run(
    USER_ID,
    USER_ID,
    taskId,
    input.projectName === undefined ? 'Work' : input.projectName,
    input.tags === undefined ? null : input.tags,
    taskId,
    input.localVersion === undefined ? 3 : input.localVersion,
    input.syncState === undefined ? 'conflict' : input.syncState,
  );
  if (input.withLink !== false) {
    testDb.prepare(
      `INSERT INTO task_provider_links (
         id, task_id, tenant_id, user_id, provider, provider_account_id,
         provider_task_id, provider_list_id, provider_version, ownership, link_state
       ) VALUES (?, ?, ?, ?, 'ms_todo', 'ms_todo:42', ?, ?, ?, 'nexus_created', ?)`,
    ).run(
      `link-${taskId}`,
      taskId,
      USER_ID,
      USER_ID,
      input.providerTaskId === undefined ? 'ms-task-u1' : input.providerTaskId,
      input.providerListId === undefined ? 'ms-list-u1' : input.providerListId,
      input.providerVersion === undefined ? 'etag-u1' : input.providerVersion,
      input.linkState || 'conflict',
    );
  }
  if (input.withConflictMutation !== false) {
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, status, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'task.update', '{}', 'conflict', 'provider_conflict')`,
    ).run(`mutation-${taskId}`, `client-${taskId}`, `idem-${taskId}`, USER_ID, USER_ID, taskId);
  }
  return { taskId };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  mockGetTaskProviderForUser.mockReturnValue(providerApi);
});

afterEach(() => {
  testDb?.close();
});

describe('normalizeTheirs defensive shape handling', () => {
  it('normalizes status spellings across providers', () => {
    expect(_normalizeTheirsForTests({ status: 'inProgress' }).status).toBe('inProgress');
    expect(_normalizeTheirsForTests({ status: 'started' }).status).toBe('inProgress');
    expect(_normalizeTheirsForTests({ status: 'cancelled' }).status).toBe('cancelled');
    expect(_normalizeTheirsForTests({ status: 'canceled' }).status).toBe('cancelled');
    expect(_normalizeTheirsForTests({ status: 'done' }).status).toBe('completed');
    expect(_normalizeTheirsForTests({ status: 'somethingelse' }).status).toBe('notStarted');
  });

  it('maps a Todoist-style checked flag to completed when status is absent', () => {
    expect(_normalizeTheirsForTests({ checked: true }).status).toBe('completed');
    expect(_normalizeTheirsForTests({ checked: false }).status).toBe('notStarted');
  });

  it('normalizes importance strings and numeric priorities', () => {
    expect(_normalizeTheirsForTests({ importance: 'low' }).importance).toBe('low');
    expect(_normalizeTheirsForTests({ importance: 'urgent' }).importance).toBe('high');
    expect(_normalizeTheirsForTests({ importance: 'important' }).importance).toBe('high');
    expect(_normalizeTheirsForTests({ priority: 4 }).importance).toBe('high');
    expect(_normalizeTheirsForTests({ priority: 1 }).importance).toBe('low');
    expect(_normalizeTheirsForTests({ priority: 2 }).importance).toBe('normal');
    expect(_normalizeTheirsForTests({ priority: 'not-a-number' }).importance).toBe('normal');
    expect(_normalizeTheirsForTests({}).importance).toBe('normal');
  });

  it('unwraps data/task envelopes and falls back to the bare value', () => {
    expect(_normalizeTheirsForTests({ data: { title: 'From data' } }).title).toBe('From data');
    expect(_normalizeTheirsForTests({ task: { title: 'From task' } }).title).toBe('From task');
    expect(_normalizeTheirsForTests({ title: 'Bare' }).title).toBe('Bare');
    // A primitive has no readable shape at all — every field defaults.
    expect(_normalizeTheirsForTests(42)).toEqual({
      title: '(Untitled)',
      status: 'notStarted',
      dueDateTime: null,
      importance: 'normal',
      body: null,
    });
  });

  it('reads Todoist content as the title and blanks empty titles', () => {
    expect(_normalizeTheirsForTests({ content: 'Todoist content' }).title).toBe('Todoist content');
    expect(_normalizeTheirsForTests({ title: '   ' }).title).toBe('(Untitled)');
  });

  it('reads due dates from every provider shape', () => {
    expect(_normalizeTheirsForTests({ dueDateTime: { dateTime: '2026-07-21T09:00:00Z' } }).dueDateTime)
      .toBe('2026-07-21T09:00:00Z');
    expect(_normalizeTheirsForTests({ dueDateTime: '2026-07-22T10:00:00Z' }).dueDateTime)
      .toBe('2026-07-22T10:00:00Z');
    expect(_normalizeTheirsForTests({ due: { datetime: '2026-07-23T11:00:00Z' } }).dueDateTime)
      .toBe('2026-07-23T11:00:00Z');
    expect(_normalizeTheirsForTests({ due: { date: '2026-07-24' } }).dueDateTime).toBe('2026-07-24');
    expect(_normalizeTheirsForTests({ dueDate: '2026-07-25' }).dueDateTime).toBe('2026-07-25');
    expect(_normalizeTheirsForTests({ dueDateTime: '   ' }).dueDateTime).toBeNull();
    expect(_normalizeTheirsForTests({}).dueDateTime).toBeNull();
  });

  it('reads bodies from Graph object, scalar, description, and notes shapes', () => {
    expect(_normalizeTheirsForTests({ body: { content: 'graph body' } }).body).toBe('graph body');
    expect(_normalizeTheirsForTests({ body: 'scalar body' }).body).toBe('scalar body');
    expect(_normalizeTheirsForTests({ description: 'todoist description' }).body).toBe('todoist description');
    expect(_normalizeTheirsForTests({ notes: 'notes body' }).body).toBe('notes body');
    expect(_normalizeTheirsForTests({ body: '   ' }).body).toBeNull();
  });
});

describe('getTaskConflictPreview provider probe edges', () => {
  it('404s for a task id the local store has never seen', async () => {
    await expect(getTaskConflictPreview(USER_ID, USER_ID, 'task-never-existed'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('accepts a conflicted MUTATION as conflict evidence when the row sync_state moved on', async () => {
    const { taskId } = seedConflictTask({ syncState: 'synced', withLink: false });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerMissing).toBe(true);
    expect(preview.theirs).toBeNull();
  });

  it('treats a task with no active link as provider-missing and keys the conflictId to none', async () => {
    const { taskId } = seedConflictTask({ withLink: false });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview).toMatchObject({
      conflictId: `conflict_${taskId}_none`,
      providerMissing: true,
      theirs: null,
      providerVersion: null,
    });
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('treats a pending-create link (no provider task id) as provider-missing', async () => {
    const { taskId } = seedConflictTask({ providerTaskId: null, linkState: 'pending_create' });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerMissing).toBe(true);
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('treats a link with no container id as provider-missing without a provider read', async () => {
    const { taskId } = seedConflictTask({ providerListId: null });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerMissing).toBe(true);
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('503s when the provider wrapper exposes no live task read', async () => {
    const { taskId } = seedConflictTask();
    mockGetTaskProviderForUser.mockReturnValue({});

    await expect(getTaskConflictPreview(USER_ID, USER_ID, taskId))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('maps a non-Error rejection to the generic provider_read_failed message', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockRejectedValue('string failure');

    await expect(getTaskConflictPreview(USER_ID, USER_ID, taskId))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'provider_read_failed' });
  });

  it('falls back to Tasks as the probe list name when the row has no project name', async () => {
    const { taskId } = seedConflictTask({ projectName: null });
    providerApi.getTask.mockResolvedValue({ success: true, data: { title: 'X', '@odata.etag': 'e9' } });

    await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(providerApi.getTask).toHaveBeenCalledWith('ms-list-u1', 'ms-task-u1', 'Tasks');
  });

  it.each([
    ['null result', null],
    ['success:false with 404 statusCode', { success: false, statusCode: 404 }],
    ['success:false with 410 statusCode', { success: false, statusCode: 410 }],
    ['success:false with status fallback field', { success: false, status: 404 }],
    ['success:false with a gone error text', { success: false, error: 'Resource is GONE from the server' }],
    ['success:false with a missing message text', { success: false, message: 'item not found upstream' }],
    ['success:true with null data', { success: true, data: null }],
  ])('classifies %s as provider-missing', async (_label, providerResult) => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(providerResult);

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerMissing).toBe(true);
    expect(preview.theirs).toBeNull();
  });

  it.each([
    ['error text', { success: false, statusCode: 500, error: 'boom' }, 'boom'],
    ['message fallback', { success: false, statusCode: 500, message: 'kaput' }, 'kaput'],
    ['generic fallback', { success: false }, 'provider_read_failed'],
  ])('maps a non-missing provider failure (%s) to PROVIDER_UNAVAILABLE', async (_label, providerResult, message) => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(providerResult);

    await expect(getTaskConflictPreview(USER_ID, USER_ID, taskId))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message });
  });

  it('normalizes a primitive provider payload instead of throwing', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue(42);

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerMissing).toBe(false);
    expect(preview.theirs).toMatchObject({ title: '(Untitled)', status: 'notStarted' });
  });

  it('falls back to the stored link version when the live copy carries no etag', async () => {
    const { taskId } = seedConflictTask();
    providerApi.getTask.mockResolvedValue({ success: true, data: { title: 'No etag here' } });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerVersion).toBe('etag-u1');
  });

  it('reports a null provider version when neither the copy nor the link knows one', async () => {
    const { taskId } = seedConflictTask({ providerVersion: null });
    providerApi.getTask.mockResolvedValue({ success: true, data: { title: 'Still no etag' } });

    const preview = await getTaskConflictPreview(USER_ID, USER_ID, taskId);

    expect(preview.providerVersion).toBeNull();
    expect(preview.conflictId).toBe(`conflict_${taskId}_none`);
  });
});

describe('resolveTaskConflict edges', () => {
  it('rejects an unknown strategy before touching anything', async () => {
    const { taskId } = seedConflictTask();

    await expect(resolveTaskConflict(USER_ID, USER_ID, {
      taskId,
      strategy: 'merge_both' as never,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('404s for an unknown task id', async () => {
    await expect(resolveTaskConflict(USER_ID, USER_ID, {
      taskId: 'task-never-existed',
      strategy: 'keep_local',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('replays an already-applied keep_local resolve idempotently without a provider read', async () => {
    const { taskId } = seedConflictTask({ syncState: 'queued', withConflictMutation: false });
    testDb.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, status
       ) VALUES ('m-replay-1', 'client-replay-1', 'idem-replay-1', ?, ?, ?, 'task.update', '{}', 'queued')`,
    ).run(USER_ID, USER_ID, taskId);

    const result = await resolveTaskConflict(USER_ID, USER_ID, {
      taskId,
      strategy: 'keep_local',
      clientMutationId: 'client-replay-1',
    });

    expect(result).toMatchObject({ resolved: true, strategy: 'keep_local', idempotentReplay: true });
    expect(providerApi.getTask).not.toHaveBeenCalled();
  });

  it('keep_local with no link re-pushes from ledger truth alone (falsy version/sync_state hardening)', async () => {
    // sync_state and local_version are NOT NULL columns; empty string and 0
    // are the falsy values the || fallbacks defend against.
    const { taskId } = seedConflictTask({
      withLink: false,
      syncState: '',
      localVersion: 0,
    });

    const result = await resolveTaskConflict(USER_ID, USER_ID, {
      taskId,
      strategy: 'keep_local',
      // The preview of a provider-missing conflict reports version 'none';
      // echoing it back must NOT trip the stale guard.
      expectedProviderVersion: 'none',
      clientMutationId: 'client-keep-local-nolink',
    });

    expect(result).toMatchObject({ resolved: true, strategy: 'keep_local' });
    const requeued = testDb.prepare(
      `SELECT status, base_local_version, patch_json FROM task_mutations
       WHERE task_id = ? AND client_mutation_id = 'client-keep-local-nolink'`,
    ).get(taskId) as { status: string; base_local_version: number; patch_json: string };
    expect(requeued.status).toBe('queued');
    expect(requeued.base_local_version).toBe(1);
    expect(JSON.parse(requeued.patch_json).providerLinkProvider).toBeNull();
    const task = testDb.prepare(
      `SELECT sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { sync_state: string };
    expect(task.sync_state).toBe('queued');
  });

  it('keep_local falls back to randomBytes ids when crypto.randomUUID is unavailable', async () => {
    const { taskId } = seedConflictTask({ withLink: false });
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    try {
      const result = await resolveTaskConflict(USER_ID, USER_ID, {
        taskId,
        strategy: 'keep_local',
      });
      expect(result.resolved).toBe(true);
      const requeued = testDb.prepare(
        `SELECT mutation_id FROM task_mutations
         WHERE task_id = ? AND status = 'queued' AND operation = 'task.update'`,
      ).get(taskId) as { mutation_id: string };
      expect(requeued.mutation_id).toMatch(/^task_mutation_[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true });
    }
  });

  it('keep_provider with the copy gone and no link tombstones from an empty sync_state', async () => {
    const { taskId } = seedConflictTask({ withLink: false, syncState: '' });

    const result = await resolveTaskConflict(USER_ID, USER_ID, {
      taskId,
      strategy: 'keep_provider',
    });

    expect(result).toMatchObject({ resolved: true, strategy: 'keep_provider' });
    const row = testDb.prepare(
      `SELECT is_deleted, sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { is_deleted: number; sync_state: string };
    expect(row).toEqual({ is_deleted: 1, sync_state: 'synced' });
  });

  it.each([
    ['cancelled maps to the cancelled db status', 'cancelled', 'cancelled'],
    ['inProgress maps to in_progress', 'inProgress', 'in_progress'],
    ['unknown statuses map to pending', 'somethingRemote', 'pending'],
  ])('keep_provider status mapping: %s', async (_label, providerStatus, dbStatus) => {
    const { taskId } = seedConflictTask({ taskId: `task-status-${providerStatus}` });
    providerApi.getTask.mockResolvedValue({
      success: true,
      data: { title: 'Status carrier', status: providerStatus, '@odata.etag': 'e-status' },
    });

    await resolveTaskConflict(USER_ID, USER_ID, { taskId, strategy: 'keep_provider' });

    const row = testDb.prepare(
      `SELECT status, completed_at FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as { status: string; completed_at: string | null };
    expect(row.status).toBe(dbStatus);
    expect(row.completed_at).toBeNull();
  });

  it('keep_provider applies a low-importance, date-only copy onto a tagged row', async () => {
    const { taskId } = seedConflictTask({ tags: '["urgent","travel"]', projectName: null });
    providerApi.getTask.mockResolvedValue({
      success: true,
      data: {
        title: 'Provider low',
        status: 'notStarted',
        importance: 'low',
        dueDateTime: { dateTime: '2026-07-20' },
        '@odata.etag': 'e-low',
      },
    });

    await resolveTaskConflict(USER_ID, USER_ID, { taskId, strategy: 'keep_provider' });

    const row = testDb.prepare(
      `SELECT title, priority, due_date, due_is_datetime, notes, sync_state
       FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as Record<string, unknown>;
    expect(row).toEqual({
      title: 'Provider low',
      // M10 (NEX-17): stored P2 ('high' bucket) vs provider 'low' is a REAL
      // provider-side change → accept the inbound table value (low→4).
      priority: 4,
      due_date: '2026-07-20',
      due_is_datetime: 0,
      notes: null,
      sync_state: 'synced',
    });
    const link = testDb.prepare(
      `SELECT link_state, provider_version, last_synced_snapshot
       FROM task_provider_links WHERE id = ?`,
    ).get(`link-${taskId}`) as { link_state: string; provider_version: string; last_synced_snapshot: string };
    expect(link.link_state).toBe('linked');
    expect(link.provider_version).toBe('e-low');
    expect(JSON.parse(link.last_synced_snapshot)).toMatchObject({
      title: 'Provider low',
      priority: 4,
      dueDate: '2026-07-20',
      dueIsDatetime: false,
    });
  });

  it('keep_provider applies a normal-importance, no-due copy from an empty sync_state', async () => {
    const { taskId } = seedConflictTask({ syncState: '' });
    providerApi.getTask.mockResolvedValue({
      success: true,
      data: { title: 'Provider normal', status: 'notStarted', importance: 'somethingOdd', '@odata.etag': 'e-norm' },
    });

    await resolveTaskConflict(USER_ID, USER_ID, { taskId, strategy: 'keep_provider' });

    const row = testDb.prepare(
      `SELECT priority, due_date, due_is_datetime, sync_state
       FROM unified_tasks WHERE nexus_task_id = ?`,
    ).get(taskId) as Record<string, unknown>;
    expect(row).toEqual({
      // M10 (NEX-17): unknown importance normalizes to 'normal' → inbound
      // table gives P3 (stored P2 is in the 'high' bucket, so no preserve).
      priority: 3,
      due_date: null,
      due_is_datetime: 0,
      sync_state: 'synced',
    });
  });
});
