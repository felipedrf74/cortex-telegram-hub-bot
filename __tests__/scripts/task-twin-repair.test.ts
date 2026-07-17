/**
 * Tests for scripts/task-twin-repair.mjs — the one-shot repair for the
 * NEX-02 twin backlog — plus the merged_into resolver alias hop and the
 * post-repair pull-safety contract of the links-first upsert routing.
 *
 * Before findRowByActiveLink/adoptRowByNexusMarker landed, a pull of a
 * Nexus-created, pushed provider task could import it as a SECOND
 * unified_tasks row (a twin of the canonical task its active link already
 * pointed at). The repair merges twin metadata into the survivor's empty
 * fields only, unions checklists by normalized displayName (preferring
 * isChecked=true and adopting the twin's Graph item ids), tombstones the
 * twin with a RETIRED external_id and a provider_data merged_into alias,
 * supersedes its pending task.delete mutations, remaps its other pending
 * mutations, and orphans redundant links. Dry-run executes the full repair
 * in a rolled-back transaction. Validation fails closed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
}));

import {
  runTaskTwinRepair,
  selectTwinCandidates,
} from '../../scripts/task-twin-repair.mjs';
import { upsertTask } from '../../src/services/task-store/unified-task-store';
import {
  getOfflineTaskById,
  resolveOfflineNexusTaskId,
} from '../../src/services/task-store/offline-first-task-service';

const USER_ID = 42;
const OTHER_USER_ID = 43;

let seq = 0;

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(OTHER_USER_ID, OTHER_USER_ID);
  vi.clearAllMocks();
});

type TaskSeed = {
  provider?: 'nexus' | 'ms_todo' | 'todoist';
  externalId?: string;
  nexusTaskId?: string;
  userId?: number;
  title?: string;
  description?: string | null;
  notes?: string | null;
  dueDate?: string | null;
  dueIsDatetime?: number;
  completedAt?: string | null;
  url?: string | null;
  providerData?: Record<string, unknown>;
  syncState?: string;
  isDeleted?: number;
};

function seedTask(input: TaskSeed): { rowId: number; nexusTaskId: string } {
  seq += 1;
  const userId = input.userId ?? USER_ID;
  const provider = input.provider ?? 'nexus';
  const nexusTaskId = input.nexusTaskId ?? `task_seed_${seq}`;
  const externalId = input.externalId ?? nexusTaskId;
  const rowId = Number(testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, title, description, status,
       priority, due_date, due_is_datetime, tags, notes, completed_at, url,
       provider_data, is_deleted, synced_at, nexus_task_id, sync_state, source_of_truth
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, '[]', ?, ?, ?, ?, ?, datetime('now'), ?, ?, 'nexus')`,
  ).run(
    userId,
    userId,
    provider,
    externalId,
    input.title ?? `Task ${seq}`,
    input.description ?? null,
    input.dueDate ?? null,
    input.dueIsDatetime ?? 0,
    input.notes ?? null,
    input.completedAt ?? null,
    input.url ?? null,
    JSON.stringify(input.providerData ?? {}),
    input.isDeleted ?? 0,
    nexusTaskId,
    input.syncState ?? 'synced',
  ).lastInsertRowid);
  return { rowId, nexusTaskId };
}

function seedLink(input: {
  taskId: string;
  providerTaskId?: string | null;
  providerListId?: string | null;
  userId?: number;
  provider?: 'ms_todo' | 'todoist';
  providerAccountId?: string;
  ownership?: string;
  linkState?: string;
}): string {
  seq += 1;
  const userId = input.userId ?? USER_ID;
  const provider = input.provider ?? 'ms_todo';
  const linkId = `link_seed_${seq}`;
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id, ownership, link_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    linkId,
    input.taskId,
    userId,
    userId,
    provider,
    input.providerAccountId ?? `${provider}:${userId}`,
    input.providerTaskId ?? null,
    input.providerListId ?? null,
    input.ownership ?? 'nexus_created',
    input.linkState ?? 'linked',
  );
  return linkId;
}

function seedMutation(input: {
  taskId: string;
  operation: string;
  status?: string;
  userId?: number;
  lockedAt?: string | null;
}): string {
  seq += 1;
  const userId = input.userId ?? USER_ID;
  const mutationId = `mutation_seed_${seq}`;
  testDb.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, patch_json, submitted_at, status, retry_count,
       next_retry_at, locked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', datetime('now'), ?, 0, NULL, ?)`,
  ).run(
    mutationId,
    `client_seed_${seq}`,
    `idem_seed_${seq}`,
    userId,
    userId,
    input.taskId,
    input.operation,
    input.status ?? 'queued',
    input.lockedAt ?? null,
  );
  return mutationId;
}

/** Seed the canonical NEX-02 shape: survivor + active link + provider twin. */
function seedBasicTwinPair(overrides: { survivor?: TaskSeed; twin?: TaskSeed; userId?: number } = {}) {
  const userId = overrides.userId ?? USER_ID;
  seq += 1;
  const providerTaskId = `AAMk-prov-${seq}`;
  const survivor = seedTask({
    nexusTaskId: `task_survivor_${seq}`,
    title: 'Trip prep',
    userId,
    ...overrides.survivor,
  });
  const linkId = seedLink({
    taskId: survivor.nexusTaskId,
    providerTaskId,
    providerListId: 'AAMk-list-1',
    userId,
  });
  const twin = seedTask({
    provider: 'ms_todo',
    externalId: providerTaskId,
    nexusTaskId: `task_twin_${seq}`,
    title: 'Trip prep',
    userId,
    ...overrides.twin,
  });
  return { survivor, twin, linkId, providerTaskId, userId };
}

function readTaskRow(rowId: number) {
  return testDb.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(rowId) as Record<string, unknown> & {
    external_id: string;
    is_deleted: number;
    sync_state: string;
    provider_data: string;
  };
}

function readLinkRow(linkId: string) {
  return testDb.prepare('SELECT * FROM task_provider_links WHERE id = ?').get(linkId) as Record<string, unknown> & {
    task_id: string;
    link_state: string;
    ownership: string;
    provider_task_id: string | null;
    provider_list_id: string | null;
  };
}

function readMutationRow(mutationId: string) {
  return testDb.prepare('SELECT * FROM task_mutations WHERE mutation_id = ?').get(mutationId) as {
    task_id: string;
    status: string;
    locked_at: string | null;
    last_error_code: string | null;
  };
}

function activeLinksFor(taskId: string) {
  return testDb.prepare(
    `SELECT * FROM task_provider_links
     WHERE task_id = ? AND link_state NOT IN ('orphaned') ORDER BY id`,
  ).all(taskId) as Array<{ id: string; provider_task_id: string | null; provider_list_id: string | null; link_state: string }>;
}

describe('task-twin-repair', () => {
  it('repairs a link-detected twin: survivor keeps identity and link, twin is tombstoned and retired', () => {
    const { survivor, twin, linkId, providerTaskId } = seedBasicTwinPair({
      survivor: {
        description: null,
        notes: 'keep me',
        dueDate: null,
        url: null,
        providerData: {
          checklistItems: [
            { id: 'local-1', displayName: 'Pack bags', isChecked: false },
            { id: 'local-2', displayName: 'Buy Milk', isChecked: true },
            { id: 'local-3', displayName: 'buy milk', isChecked: false },
          ],
        },
      },
      twin: {
        description: 'Provider description',
        notes: 'provider notes',
        dueDate: '2026-07-20T09:00:00Z',
        dueIsDatetime: 1,
        url: 'https://to-do.office.com/tasks/1',
        providerData: {
          etag: 'W/"1"',
          checklistItems: [
            { id: 'AAMkCHK1', displayName: ' pack bags ', isChecked: true },
            { id: 'AAMkCHK2', displayName: 'New item', isChecked: false },
          ],
        },
      },
    });

    const summary = runTaskTwinRepair(testDb, { apply: true, runId: 'run-basic' });

    expect(summary.mode).toBe('apply');
    expect(summary).toMatchObject({
      candidates: 1,
      repaired: 1,
      skipped: 0,
      ambiguous: 0,
      checklistItemsAdded: 1,
      checklistIdsAdopted: 1,
      checklistDuplicatesCollapsed: 1,
    });
    expect(summary.details).toEqual([
      expect.objectContaining({
        taskId: twin.nexusTaskId,
        survivorTaskId: survivor.nexusTaskId,
        userId: USER_ID,
        provider: 'ms_todo',
        providerTaskId,
        outcome: 'repaired:link',
        mergedFields: expect.arrayContaining(['description', 'url', 'due_date']),
        checklist: { added: 1, idsAdopted: 1, acceptedLosses: ['buy milk'] },
      }),
    ]);

    // Survivor: NULL/empty fields filled from the twin, existing values kept.
    const survivorRow = readTaskRow(survivor.rowId);
    expect(survivorRow).toMatchObject({
      is_deleted: 0,
      nexus_task_id: survivor.nexusTaskId,
      description: 'Provider description',
      notes: 'keep me',
      due_date: '2026-07-20T09:00:00Z',
      due_is_datetime: 1,
      url: 'https://to-do.office.com/tasks/1',
    });
    // Checklist union: names matched trim+lowercase, isChecked=true preferred,
    // twin Graph ids adopted, twin-only items appended, survivor dup collapsed.
    expect(JSON.parse(survivorRow.provider_data).checklistItems).toEqual([
      { id: 'AAMkCHK1', displayName: 'Pack bags', isChecked: true },
      { id: 'local-2', displayName: 'Buy Milk', isChecked: true },
      { id: 'AAMkCHK2', displayName: 'New item', isChecked: false },
    ]);

    // Twin: tombstoned, identity retired, merged_into alias written, other
    // provider_data keys preserved.
    const twinRow = readTaskRow(twin.rowId);
    expect(twinRow).toMatchObject({
      is_deleted: 1,
      sync_state: 'synced',
      external_id: `retired:${providerTaskId}:${twin.rowId}`,
    });
    expect(twinRow.deleted_at).not.toBeNull();
    const twinData = JSON.parse(twinRow.provider_data);
    expect(twinData.merged_into).toBe(survivor.nexusTaskId);
    expect(twinData.etag).toBe('W/"1"');

    // Canonical link untouched (identity, state, ownership).
    expect(readLinkRow(linkId)).toMatchObject({
      task_id: survivor.nexusTaskId,
      provider_task_id: providerTaskId,
      link_state: 'linked',
      ownership: 'nexus_created',
    });
    expect(activeLinksFor(twin.nexusTaskId)).toEqual([]);
  });

  it("supersedes the twin's pending task.delete and remaps its other pending mutations to the survivor", () => {
    const { survivor, twin } = seedBasicTwinPair();
    const deleteMutation = seedMutation({
      taskId: twin.nexusTaskId,
      operation: 'task.delete',
      status: 'queued',
      lockedAt: '2026-07-17 10:00:00',
    });
    const updateMutation = seedMutation({
      taskId: twin.nexusTaskId,
      operation: 'task.update',
      status: 'failed',
    });
    const completedMutation = seedMutation({
      taskId: twin.nexusTaskId,
      operation: 'task.complete',
      status: 'synced',
    });

    const summary = runTaskTwinRepair(testDb, { apply: true });

    expect(summary).toMatchObject({ repaired: 1, mutationsSuperseded: 1, mutationsRemapped: 1 });
    // The pending delete is cancelled WITHOUT deleting the provider task:
    // 'synced' keeps it out of every push path (never deleted_pending_sync).
    expect(readMutationRow(deleteMutation)).toEqual(expect.objectContaining({
      task_id: twin.nexusTaskId,
      status: 'synced',
      locked_at: null,
      last_error_code: 'twin_repair_superseded',
    }));
    // Other pending mutations follow the survivor; terminal ones stay put.
    expect(readMutationRow(updateMutation)).toEqual(expect.objectContaining({
      task_id: survivor.nexusTaskId,
      status: 'failed',
    }));
    expect(readMutationRow(completedMutation)).toEqual(expect.objectContaining({
      task_id: twin.nexusTaskId,
      status: 'synced',
    }));
  });

  it("orphans the survivor's redundant NULL-provider link (container merged) and the twin's leftover links", () => {
    const { survivor, twin, linkId } = seedBasicTwinPair();
    // Pre-migration-234 R1-b leftover: an active same-provider link with no
    // provider_task_id (different account slot, or it could not coexist).
    const redundantLink = seedLink({
      taskId: survivor.nexusTaskId,
      providerTaskId: null,
      providerListId: 'AAMk-list-9',
      providerAccountId: 'ms_todo:legacy',
      linkState: 'stale',
    });
    const twinPendingCreateLink = seedLink({
      taskId: twin.nexusTaskId,
      providerTaskId: null,
      linkState: 'stale',
    });
    // The kept canonical link initially knows no container.
    testDb.prepare('UPDATE task_provider_links SET provider_list_id = NULL WHERE id = ?').run(linkId);

    const summary = runTaskTwinRepair(testDb, { apply: true });

    expect(summary).toMatchObject({ repaired: 1, redundantLinksOrphaned: 1, twinLinksOrphaned: 1 });
    expect(readLinkRow(redundantLink).link_state).toBe('orphaned');
    expect(readLinkRow(twinPendingCreateLink).link_state).toBe('orphaned');
    // The redundant link's container moved onto the kept canonical link.
    expect(readLinkRow(linkId)).toMatchObject({
      link_state: 'linked',
      provider_list_id: 'AAMk-list-9',
    });
    expect(activeLinksFor(survivor.nexusTaskId)).toHaveLength(1);
    expect(activeLinksFor(twin.nexusTaskId)).toEqual([]);
  });

  it('repairs a marker-detected twin by adopting its provider id onto the survivor link slot', () => {
    const survivor = seedTask({ title: 'Moved task' });
    const oldLink = seedLink({
      taskId: survivor.nexusTaskId,
      providerTaskId: 'AAMk-old-1',
      providerListId: 'AAMk-list-1',
    });
    // Microsoft move: delete + recreate under a fresh Graph id. The pre-fix
    // pull imported the recreated task as a twin whose linkedResources marker
    // still names the survivor; its own import link claims the new id.
    const twin = seedTask({
      provider: 'ms_todo',
      externalId: 'AAMk-new-2',
      title: 'Moved task',
      providerData: {
        listId: 'AAMk-list-2',
        linkedResources: [{ externalId: survivor.nexusTaskId }],
      },
    });
    const selfLink = seedLink({
      taskId: twin.nexusTaskId,
      providerTaskId: 'AAMk-new-2',
      ownership: 'provider_imported',
    });

    const summary = runTaskTwinRepair(testDb, { apply: true });

    expect(summary).toMatchObject({ candidates: 1, repaired: 1, ambiguous: 0 });
    expect(summary.details[0]).toMatchObject({ outcome: 'repaired:marker', providerTaskId: 'AAMk-new-2' });
    // The twin's slot row was re-pointed to the survivor and stays the only
    // active link; the survivor's stale old-id link is orphaned.
    expect(activeLinksFor(survivor.nexusTaskId)).toEqual([
      expect.objectContaining({ id: selfLink, provider_task_id: 'AAMk-new-2' }),
    ]);
    expect(readLinkRow(oldLink).link_state).toBe('orphaned');
    expect(readTaskRow(twin.rowId)).toMatchObject({
      is_deleted: 1,
      external_id: `retired:AAMk-new-2:${twin.rowId}`,
    });
    expect(activeLinksFor(twin.nexusTaskId)).toEqual([]);
  });

  it('records a manual_resolution_required issue and touches nothing when identity signals conflict', () => {
    // Marker names a live survivor, but an active link claims the twin's
    // provider id for a task that does NOT qualify (provider-origin owner).
    const markerTarget = seedTask({ title: 'Marker target' });
    const foreignOwner = seedTask({
      provider: 'ms_todo',
      externalId: 'AAMk-foreign-1',
    });
    const twin = seedTask({
      provider: 'ms_todo',
      externalId: 'AAMk-conflict-1',
      providerData: { linkedResources: [{ externalId: markerTarget.nexusTaskId }] },
    });
    seedLink({ taskId: foreignOwner.nexusTaskId, providerTaskId: 'AAMk-conflict-1' });

    const summary = runTaskTwinRepair(testDb, { apply: true, runId: 'run-conflict' });

    expect(summary).toMatchObject({ candidates: 1, repaired: 0, ambiguous: 1 });
    expect(readTaskRow(twin.rowId)).toMatchObject({ is_deleted: 0, external_id: 'AAMk-conflict-1' });
    const issues = testDb.prepare(
      "SELECT code, provider, state, details_json FROM task_sync_issues WHERE task_id = ? AND state = 'open'",
    ).all(twin.nexusTaskId) as Array<{ code: string; details_json: string }>;
    expect(issues).toEqual([
      expect.objectContaining({ code: 'manual_resolution_required', provider: 'ms_todo', state: 'open' }),
    ]);
    expect(JSON.parse(issues[0].details_json)).toMatchObject({
      repairRunId: 'run-conflict',
      reason: 'twin_repair_ambiguous',
      providerTaskId: 'AAMk-conflict-1',
    });
  });

  it('dry-run executes the full repair in a rolled-back transaction; apply commits the same counts', () => {
    const { survivor, twin, providerTaskId } = seedBasicTwinPair({
      twin: { description: 'Provider description' },
    });
    const deleteMutation = seedMutation({ taskId: twin.nexusTaskId, operation: 'task.delete', status: 'queued' });

    const dryRun = runTaskTwinRepair(testDb, { apply: false });

    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun).toMatchObject({ candidates: 1, repaired: 1, mutationsSuperseded: 1 });
    // NOTHING was committed.
    expect(readTaskRow(twin.rowId)).toMatchObject({ is_deleted: 0, external_id: providerTaskId });
    expect(readTaskRow(survivor.rowId)).toMatchObject({ description: null });
    expect(readMutationRow(deleteMutation)).toEqual(expect.objectContaining({ status: 'queued', last_error_code: null }));

    const applied = runTaskTwinRepair(testDb, { apply: true });

    const comparable = (summary: Record<string, unknown>) => ({
      candidates: summary.candidates,
      repaired: summary.repaired,
      skipped: summary.skipped,
      ambiguous: summary.ambiguous,
      mutationsSuperseded: summary.mutationsSuperseded,
      mutationsRemapped: summary.mutationsRemapped,
      twinLinksOrphaned: summary.twinLinksOrphaned,
      redundantLinksOrphaned: summary.redundantLinksOrphaned,
      checklistItemsAdded: summary.checklistItemsAdded,
    });
    expect(comparable(applied)).toEqual(comparable(dryRun));
    expect(readTaskRow(twin.rowId)).toMatchObject({
      is_deleted: 1,
      external_id: `retired:${providerTaskId}:${twin.rowId}`,
    });
    expect(readTaskRow(survivor.rowId)).toMatchObject({ description: 'Provider description' });
    expect(readMutationRow(deleteMutation).status).toBe('synced');
  });

  it('is idempotent: the retired twin is invisible to a second run', () => {
    const { twin } = seedBasicTwinPair();

    const first = runTaskTwinRepair(testDb, { apply: true });
    const second = runTaskTwinRepair(testDb, { apply: true });

    expect(first).toMatchObject({ candidates: 1, repaired: 1 });
    // The retired external_id can no longer join an active link's
    // provider_task_id, and the tombstone fails the is_deleted filter.
    expect(second).toMatchObject({ candidates: 0, repaired: 0, skipped: 0, ambiguous: 0 });
    expect(selectTwinCandidates(testDb)).toEqual([]);
    expect(readTaskRow(twin.rowId).is_deleted).toBe(1);
  });

  it('scopes selection and repair to a single user when userId is passed', () => {
    const scoped = seedBasicTwinPair({ userId: USER_ID });
    const other = seedBasicTwinPair({ userId: OTHER_USER_ID });

    const unscoped = selectTwinCandidates(testDb) as Array<{ user_id: number }>;
    expect(unscoped.map((candidate) => candidate.user_id).sort()).toEqual([USER_ID, OTHER_USER_ID]);
    expect((selectTwinCandidates(testDb, { userId: USER_ID }) as Array<{ user_id: number }>)
      .map((candidate) => candidate.user_id)).toEqual([USER_ID]);

    const summary = runTaskTwinRepair(testDb, { apply: true, userId: USER_ID });

    expect(summary).toMatchObject({ candidates: 1, repaired: 1 });
    expect(Object.keys(summary.perUser)).toEqual([String(USER_ID)]);
    expect(readTaskRow(scoped.twin.rowId).is_deleted).toBe(1);
    expect(readTaskRow(other.twin.rowId).is_deleted).toBe(0);
  });

  it('resolves the retired twin id to the survivor through getTaskRowByAnyTaskId (merged_into alias hop)', () => {
    const { survivor, twin, providerTaskId } = seedBasicTwinPair();
    runTaskTwinRepair(testDb, { apply: true });

    // Stale twin references (old notifications, cached client ids) resolve
    // to the survivor via the tombstone's merged_into alias — single hop.
    expect(resolveOfflineNexusTaskId(USER_ID, USER_ID, twin.nexusTaskId)).toBe(survivor.nexusTaskId);
    const dto = getOfflineTaskById(USER_ID, USER_ID, twin.nexusTaskId);
    expect(dto).toEqual(expect.objectContaining({ id: survivor.nexusTaskId, title: 'Trip prep' }));
    expect(dto?.status).not.toBe('cancelled');
    // The provider id itself resolves through the canonical link directly.
    expect(resolveOfflineNexusTaskId(USER_ID, USER_ID, providerTaskId)).toBe(survivor.nexusTaskId);
  });

  it("post-repair pull safety: upsertTask with the twin's original provider payload routes to the survivor and does not resurrect the tombstone", () => {
    const { survivor, twin, linkId, providerTaskId } = seedBasicTwinPair();
    runTaskTwinRepair(testDb, { apply: true });
    const rowsBefore = (testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks').get() as { count: number }).count;

    // The provider still holds the task under its ORIGINAL id; the next pull
    // re-imports that payload. Links-first routing must land on the survivor.
    const result = upsertTask(USER_ID, {
      provider: 'ms_todo',
      externalId: providerTaskId,
      title: 'Trip prep (renamed at provider)',
      status: 'pending',
      priority: 0,
      dueIsDatetime: false,
      tags: [],
      providerData: { listId: 'AAMk-list-1' },
    }, USER_ID);

    expect(result).toBe('updated');
    const rowsAfter = (testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks').get() as { count: number }).count;
    expect(rowsAfter).toBe(rowsBefore); // no twin re-import
    expect(readTaskRow(survivor.rowId)).toMatchObject({
      title: 'Trip prep (renamed at provider)',
      is_deleted: 0,
      nexus_task_id: survivor.nexusTaskId,
    });
    // The tombstone stays retired and dead.
    expect(readTaskRow(twin.rowId)).toMatchObject({
      is_deleted: 1,
      external_id: `retired:${providerTaskId}:${twin.rowId}`,
      title: 'Trip prep',
    });
    expect(readLinkRow(linkId)).toMatchObject({ task_id: survivor.nexusTaskId, link_state: 'linked' });
  });
});
