/**
 * Tests for scripts/task-mapping-repair.mjs — the one-shot repair for the
 * NEX-05 parked-create backlog.
 *
 * Before M3's resolveCreateTargetProject fix, creates into Microsoft-backed
 * lists resolved their listName to the hidden nexus mirror project, so no
 * container mapping matched and the mutation parked as
 * failed_permanent/provider_list_missing with a NULL-container provider link.
 * The repair re-points each affected task to the visible provider project,
 * backfills the link container, and re-arms the parked mutation. Resolution is
 * deterministic-else-issue: legacy mirror-keyed mapping, else unique
 * case-insensitive name match, else an open task_sync_issues row and no
 * mutation. Dry-run executes the full repair in a rolled-back transaction.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  runTaskMappingRepair,
  selectParkedCreateTargets,
} from '../../scripts/task-mapping-repair.mjs';

const USER_ID = 42;
const OTHER_USER_ID = 43;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createMigratedTestDatabase();
  db.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  db.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(OTHER_USER_ID, OTHER_USER_ID);
});

function seedProject(
  provider: 'nexus' | 'ms_todo' | 'todoist',
  externalId: string,
  name: string,
  userId = USER_ID,
): number {
  return Number(db.prepare(
    `INSERT INTO unified_projects (
       user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
     ) VALUES (?, ?, ?, ?, ?, 0, 0, datetime('now'))`,
  ).run(userId, userId, provider, externalId, name).lastInsertRowid);
}

function seedMirrorKeyedMapping(nexusRowId: number, containerId: string, userId = USER_ID): void {
  // The LEGACY key shape: nexus_list_id points at the hidden nexus mirror
  // row id (pre-de22b1a2 writer), which the repair treats as deterministic.
  db.prepare(
    `INSERT INTO task_container_mappings (
       id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
       provider_container_id, sync_direction
     ) VALUES (?, ?, ?, ?, 'ms_todo', 'todo_list', ?, 'bidirectional')`,
  ).run(`mapping-mirror-${nexusRowId}`, userId, userId, String(nexusRowId), containerId);
}

/** Seed one NEX-05 parked create: task in a project + stale NULL-container link + parked mutation. */
function seedParkedCreate(input: {
  projectId: number;
  projectName: string;
  userId?: number;
  errorCode?: string | null;
}): string {
  seq += 1;
  const userId = input.userId ?? USER_ID;
  const taskId = `task_parked_${seq}`;
  db.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_id, project_name,
       title, status, priority, tags, provider_data, synced_at,
       nexus_task_id, sync_state, source_of_truth
     ) VALUES (?, ?, 'nexus', ?, ?, ?, ?, 'pending', 0, '[]', '{}', datetime('now'),
       ?, 'failed_permanent', 'nexus')`,
  ).run(userId, userId, taskId, input.projectId, input.projectName, `Parked ${seq}`, taskId);
  db.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id, ownership, link_state
     ) VALUES (?, ?, ?, ?, 'ms_todo', ?, NULL, NULL, NULL, 'nexus_created', 'stale')`,
  ).run(`link_parked_${seq}`, taskId, userId, userId, `ms_todo:${userId}`);
  db.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, patch_json, submitted_at, status, retry_count,
       next_retry_at, last_error_code
     ) VALUES (?, ?, ?, ?, ?, ?, 'task.create', '{}', datetime('now'), 'failed', 5, NULL, ?)`,
  ).run(
    `mutation_parked_${seq}`,
    `client_parked_${seq}`,
    `idem_parked_${seq}`,
    userId,
    userId,
    taskId,
    input.errorCode === undefined ? 'provider_list_missing' : input.errorCode,
  );
  return taskId;
}

function readTask(taskId: string) {
  return db.prepare(
    'SELECT project_id, project_name, sync_state FROM unified_tasks WHERE nexus_task_id = ?',
  ).get(taskId) as { project_id: number; project_name: string; sync_state: string };
}

function readLink(taskId: string) {
  return db.prepare(
    "SELECT provider_list_id FROM task_provider_links WHERE task_id = ? AND provider = 'ms_todo'",
  ).get(taskId) as { provider_list_id: string | null };
}

function readMutation(taskId: string) {
  return db.prepare(
    'SELECT status, next_retry_at, retry_count, locked_at FROM task_mutations WHERE task_id = ?',
  ).get(taskId) as { status: string; next_retry_at: string | null; retry_count: number; locked_at: string | null };
}

function readOpenIssues(taskId: string) {
  return db.prepare(
    "SELECT code, provider, state, details_json FROM task_sync_issues WHERE task_id = ? AND state = 'open'",
  ).all(taskId) as Array<{ code: string; provider: string; state: string; details_json: string }>;
}

describe('task-mapping-repair', () => {
  it('repairs through the legacy mirror-keyed container mapping (repaired:legacy_mapping)', () => {
    const nexusRowId = seedProject('nexus', 'nexus-groceries', 'Groceries');
    // The provider row's NAME does not match the parked project name, so only
    // the id-keyed legacy mapping can resolve this target deterministically.
    const msRowId = seedProject('ms_todo', 'AAMk-groceries', 'Groceries (Household)');
    seedMirrorKeyedMapping(nexusRowId, 'AAMk-groceries');
    const taskId = seedParkedCreate({ projectId: nexusRowId, projectName: 'Groceries' });

    const summary = runTaskMappingRepair(db, { apply: true, runId: 'run-legacy' });

    expect(summary.mode).toBe('apply');
    expect(summary).toMatchObject({
      candidates: 1,
      repaired: 1,
      requeuedMutations: 1,
      linksBackfilled: 1,
      ambiguous: 0,
      unresolved: 0,
      skippedAlreadyProviderProject: 0,
    });
    expect(summary.details).toEqual([
      expect.objectContaining({
        taskId,
        userId: USER_ID,
        outcome: 'repaired:legacy_mapping',
        providerProjectId: msRowId,
        providerContainerId: 'AAMk-groceries',
      }),
    ]);
    expect(readTask(taskId)).toEqual({
      project_id: msRowId,
      project_name: 'Groceries (Household)',
      sync_state: 'queued',
    });
    expect(readLink(taskId).provider_list_id).toBe('AAMk-groceries');
    const mutation = readMutation(taskId);
    // Worker contract (readyMutations): status='failed' rows become eligible
    // again once next_retry_at is non-NULL and due; retry budget restarts.
    expect(mutation.status).toBe('failed');
    expect(mutation.next_retry_at).not.toBeNull();
    expect(mutation.retry_count).toBe(0);
    expect(mutation.locked_at).toBeNull();
    expect(readOpenIssues(taskId)).toEqual([]);
  });

  it('repairs through a unique case-insensitive name match when no mapping exists (repaired:unique_name)', () => {
    const nexusRowId = seedProject('nexus', 'nexus-groceries', 'groceries');
    const msRowId = seedProject('ms_todo', 'AAMk-groceries', 'GROCERIES');
    const taskId = seedParkedCreate({ projectId: nexusRowId, projectName: 'groceries' });

    const summary = runTaskMappingRepair(db, { apply: true });

    expect(summary).toMatchObject({ candidates: 1, repaired: 1, requeuedMutations: 1, linksBackfilled: 1 });
    expect(summary.details).toEqual([
      expect.objectContaining({ taskId, outcome: 'repaired:unique_name', providerProjectId: msRowId }),
    ]);
    expect(readTask(taskId)).toEqual({
      project_id: msRowId,
      project_name: 'GROCERIES',
      sync_state: 'queued',
    });
    expect(readLink(taskId).provider_list_id).toBe('AAMk-groceries');
    expect(readMutation(taskId).next_retry_at).not.toBeNull();
  });

  it('records an open issue with candidates and touches nothing when two provider lists share the name', () => {
    const nexusRowId = seedProject('nexus', 'nexus-groceries', 'Groceries');
    const msRowA = seedProject('ms_todo', 'AAMk-groceries-a', 'Groceries');
    const msRowB = seedProject('ms_todo', 'AAMk-groceries-b', 'groceries');
    const taskId = seedParkedCreate({ projectId: nexusRowId, projectName: 'Groceries' });

    const summary = runTaskMappingRepair(db, { apply: true, runId: 'run-ambiguous' });

    expect(summary).toMatchObject({
      candidates: 1,
      repaired: 0,
      requeuedMutations: 0,
      linksBackfilled: 0,
      ambiguous: 1,
      unresolved: 0,
    });
    expect(summary.details).toEqual([
      expect.objectContaining({ taskId, outcome: 'ambiguous' }),
    ]);
    // Task, link, and mutation are untouched.
    expect(readTask(taskId)).toEqual({
      project_id: nexusRowId,
      project_name: 'Groceries',
      sync_state: 'failed_permanent',
    });
    expect(readLink(taskId).provider_list_id).toBeNull();
    expect(readMutation(taskId)).toEqual(expect.objectContaining({
      status: 'failed',
      next_retry_at: null,
      retry_count: 5,
    }));
    // One open issue carries the run id and both candidates for manual review.
    const issues = readOpenIssues(taskId);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'provider_list_missing', provider: 'ms_todo', state: 'open' }),
    ]);
    const details = JSON.parse(issues[0].details_json);
    expect(details.repairRunId).toBe('run-ambiguous');
    expect(details.reason).toBe('ambiguous');
    expect(details.candidates).toHaveLength(2);
    expect(details.candidates).toEqual(expect.arrayContaining([
      { id: msRowA, name: 'Groceries' },
      { id: msRowB, name: 'groceries' },
    ]));
  });

  it('dry-run executes the full repair in a rolled-back transaction and commits nothing', () => {
    const errandsNexusId = seedProject('nexus', 'nexus-errands', 'Errands');
    seedProject('ms_todo', 'AAMk-errands', 'Errands');
    const repairableTaskId = seedParkedCreate({ projectId: errandsNexusId, projectName: 'Errands' });
    const groceriesNexusId = seedProject('nexus', 'nexus-groceries', 'Groceries');
    seedProject('ms_todo', 'AAMk-groceries-a', 'Groceries');
    seedProject('ms_todo', 'AAMk-groceries-b', 'Groceries');
    const ambiguousTaskId = seedParkedCreate({ projectId: groceriesNexusId, projectName: 'Groceries' });

    const dryRun = runTaskMappingRepair(db, { apply: false });

    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun).toMatchObject({
      candidates: 2,
      repaired: 1,
      requeuedMutations: 1,
      linksBackfilled: 1,
      ambiguous: 1,
      unresolved: 0,
    });
    // NOTHING was committed: the repairable target is still parked...
    expect(readTask(repairableTaskId)).toEqual(expect.objectContaining({
      project_id: errandsNexusId,
      sync_state: 'failed_permanent',
    }));
    expect(readLink(repairableTaskId).provider_list_id).toBeNull();
    expect(readMutation(repairableTaskId)).toEqual(expect.objectContaining({
      next_retry_at: null,
      retry_count: 5,
    }));
    // ...and the ambiguous target got no committed issue row either.
    expect(readOpenIssues(ambiguousTaskId)).toEqual([]);
    expect(readTask(ambiguousTaskId).sync_state).toBe('failed_permanent');
  });

  it('apply commits exactly what the dry-run reported', () => {
    const nexusRowId = seedProject('nexus', 'nexus-errands', 'Errands');
    const msRowId = seedProject('ms_todo', 'AAMk-errands', 'Errands');
    const taskId = seedParkedCreate({ projectId: nexusRowId, projectName: 'Errands' });

    const dryRun = runTaskMappingRepair(db, { apply: false });
    expect(readTask(taskId).sync_state).toBe('failed_permanent');
    const applied = runTaskMappingRepair(db, { apply: true });

    const comparable = ({ candidates, repaired, requeuedMutations, linksBackfilled, ambiguous, unresolved, skippedAlreadyProviderProject }: {
      candidates: number;
      repaired: number;
      requeuedMutations: number;
      linksBackfilled: number;
      ambiguous: number;
      unresolved: number;
      skippedAlreadyProviderProject: number;
    }) => ({ candidates, repaired, requeuedMutations, linksBackfilled, ambiguous, unresolved, skippedAlreadyProviderProject });
    expect(comparable(applied)).toEqual(comparable(dryRun));
    expect(readTask(taskId)).toEqual({
      project_id: msRowId,
      project_name: 'Errands',
      sync_state: 'queued',
    });
    expect(readLink(taskId).provider_list_id).toBe('AAMk-errands');
  });

  it('scopes selection and repair to a single user when userId is passed', () => {
    const nexusRowA = seedProject('nexus', 'nexus-groceries', 'Groceries');
    seedProject('ms_todo', 'AAMk-groceries', 'Groceries');
    const scopedTaskId = seedParkedCreate({ projectId: nexusRowA, projectName: 'Groceries' });
    const nexusRowB = seedProject('nexus', 'nexus-groceries-43', 'Groceries', OTHER_USER_ID);
    seedProject('ms_todo', 'AAMk-groceries-43', 'Groceries', OTHER_USER_ID);
    const otherTaskId = seedParkedCreate({
      projectId: nexusRowB,
      projectName: 'Groceries',
      userId: OTHER_USER_ID,
    });

    const unscoped = selectParkedCreateTargets(db) as Array<{ user_id: number }>;
    const scoped = selectParkedCreateTargets(db, { userId: USER_ID }) as Array<{ user_id: number }>;
    expect(unscoped.map((target) => target.user_id).sort()).toEqual([USER_ID, OTHER_USER_ID]);
    expect(scoped.map((target) => target.user_id)).toEqual([USER_ID]);

    const summary = runTaskMappingRepair(db, { apply: true, userId: USER_ID });

    expect(summary).toMatchObject({ candidates: 1, repaired: 1 });
    expect(Object.keys(summary.perUser)).toEqual([String(USER_ID)]);
    expect(readTask(scopedTaskId).sync_state).toBe('queued');
    expect(readTask(otherTaskId).sync_state).toBe('failed_permanent');
    expect(readMutation(otherTaskId).next_retry_at).toBeNull();
  });

  it('skips parked mutations whose task already sits in a provider project', () => {
    const msRowId = seedProject('ms_todo', 'AAMk-groceries', 'Groceries');
    const taskId = seedParkedCreate({ projectId: msRowId, projectName: 'Groceries' });

    const summary = runTaskMappingRepair(db, { apply: true });

    expect(summary).toMatchObject({
      candidates: 1,
      repaired: 0,
      requeuedMutations: 0,
      skippedAlreadyProviderProject: 1,
      ambiguous: 0,
      unresolved: 0,
    });
    expect(readTask(taskId)).toEqual(expect.objectContaining({
      project_id: msRowId,
      sync_state: 'failed_permanent',
    }));
    expect(readMutation(taskId).next_retry_at).toBeNull();
  });

  it('is idempotent: a second apply run selects and repairs nothing', () => {
    const nexusRowId = seedProject('nexus', 'nexus-groceries', 'Groceries');
    seedProject('ms_todo', 'AAMk-groceries', 'Groceries');
    const taskId = seedParkedCreate({ projectId: nexusRowId, projectName: 'Groceries' });

    const first = runTaskMappingRepair(db, { apply: true });
    const second = runTaskMappingRepair(db, { apply: true });

    expect(first).toMatchObject({ candidates: 1, repaired: 1, requeuedMutations: 1 });
    // The repaired mutation now has next_retry_at set, so it is no longer a
    // parked candidate; the repaired task keeps its provider project.
    expect(second).toMatchObject({
      candidates: 0,
      repaired: 0,
      requeuedMutations: 0,
      linksBackfilled: 0,
      ambiguous: 0,
      unresolved: 0,
      skippedAlreadyProviderProject: 0,
    });
    expect(selectParkedCreateTargets(db)).toEqual([]);
    expect(readTask(taskId).sync_state).toBe('queued');
  });
});
