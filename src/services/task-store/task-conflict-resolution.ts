// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task conflict resolution (M2B) — the designed exit from the NEX-06
 * absorbing conflict state.
 *
 * Preview (`getTaskConflictPreview`) re-fetches the provider copy LIVE (same
 * getTask probe the reconciliation job uses, 10s timeout) so the user decides
 * against the provider's current content, not a stale cache. Resolution
 * (`resolveTaskConflict`) re-fetches again and, when the client passed the
 * previewed `expectedProviderVersion`, rejects with CONFLICT_STALE if the
 * provider copy moved in between — the delayed-"keep mine"-clobbers-newer-edit
 * guard.
 *
 * Strategies:
 *   - keep_local: retire the task's conflict/failed ledger rows as
 *     'superseded', stamp the link with the FRESH provider version (so the
 *     push's If-Match succeeds), and enqueue ONE new queued task.update
 *     carrying the full local content. Provider copy gone → clear the link's
 *     provider_task_id and mark it pending_create: the worker's existing
 *     create-recovery branch (no provider_task_id → search-then-create)
 *     re-creates the task without any new worker operation.
 *   - keep_provider: apply the fetched provider fields onto the canonical row
 *     (never touching provider/external_id — canonical-links rule), recompute
 *     the content hash, retire every still-pending mutation as 'superseded',
 *     and stamp the link with the fresh version + synced snapshot. Provider
 *     copy gone → accept the remote deletion and tombstone the row.
 *
 * All state writes go through assertTransition (fail-open) so violations
 * surface in observability without blocking resolution.
 */

import crypto from 'crypto';
import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { getTaskProviderForUser } from './task-router';
import { assertTransition } from './task-sync-transitions';
import { resolveTaskSyncIssue } from './task-sync-issues';
import { buildTaskSyncedSnapshot } from './task-sync-snapshot';
import { computeContentHash } from './unified-task-store';
import { importanceToPriority, normalizeStoredTaskPriority, sameImportanceBucket } from './task-priority';
import { extractLinkProviderVersion } from './task-mutation-sync-worker';
import {
  getOfflineTaskById,
  resolveOfflineNexusTaskId,
  type OfflineTaskDto,
} from './offline-first-task-service';
import type { NormalizedTask, TaskProvider } from './types';

const PROVIDER_READ_TIMEOUT_MS = 10_000;

type LinkProvider = 'ms_todo' | 'todoist' | 'nexus_local';

type ConflictTaskRow = {
  id: number;
  tenant_id: number;
  user_id: number;
  provider: string;
  external_id: string;
  project_id: number | null;
  project_name: string | null;
  title: string;
  status: string;
  priority: number | null;
  due_date: string | null;
  due_is_datetime: number | null;
  tags: string | null;
  notes: string | null;
  is_deleted: number;
  nexus_task_id: string;
  local_version: number | null;
  sync_state: string | null;
};

type ConflictLinkRow = {
  id: string;
  task_id: string;
  provider: LinkProvider;
  provider_account_id: string;
  provider_task_id: string | null;
  provider_list_id: string | null;
  provider_project_id: string | null;
  provider_version: string | null;
  link_state: string;
};

export interface TaskConflictTheirs {
  title: string;
  status: string;
  dueDateTime: string | null;
  importance: 'low' | 'normal' | 'high';
  body: string | null;
}

export interface TaskConflictPreview {
  conflictId: string;
  mine: OfflineTaskDto;
  theirs: TaskConflictTheirs | null;
  providerVersion: string | null;
  providerMissing: boolean;
  fetchedAt: string;
}

export interface TaskConflictResolveInput {
  taskId: string;
  strategy: 'keep_local' | 'keep_provider';
  expectedProviderVersion?: string;
  idempotencyKey?: string;
  clientMutationId?: string;
}

export interface TaskConflictResolveResult {
  resolved: true;
  strategy: 'keep_local' | 'keep_provider';
  task: OfflineTaskDto;
  idempotentReplay?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function typedError(code: string, message: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getConflictTaskRow(tenantId: number, userId: number, nexusTaskId: string): ConflictTaskRow | null {
  const row = getDb().prepare(
    `SELECT * FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?
     LIMIT 1`,
  ).get(tenantId, userId, nexusTaskId) as ConflictTaskRow | undefined;
  return row || null;
}

function hasConflictMutation(tenantId: number, userId: number, nexusTaskId: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 AS ok FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND task_id = ? AND status = 'conflict'
     LIMIT 1`,
  ).get(tenantId, userId, nexusTaskId) as { ok: number } | undefined;
  return !!row;
}

/** The ACTIVE provider link — the sync target the conflict is against. */
function getActiveProviderLink(tenantId: number, userId: number, nexusTaskId: string): ConflictLinkRow | null {
  const row = getDb().prepare(
    `SELECT * FROM task_provider_links
     WHERE tenant_id = ? AND user_id = ? AND task_id = ?
       AND provider != 'nexus_local'
       AND link_state NOT IN ('orphaned')
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(tenantId, userId, nexusTaskId) as ConflictLinkRow | undefined;
  return row || null;
}

function providerContainerId(link: ConflictLinkRow): string | null {
  return link.provider === 'ms_todo'
    ? link.provider_list_id
    : link.provider_project_id || link.provider_list_id;
}

/** Mirrors the reconciliation job's provider-missing probe classification. */
function looksProviderMissing(value: any): boolean {
  if (value == null) return true;
  if (value && typeof value === 'object') {
    if (value.success === false) {
      const statusCode = Number(value.statusCode ?? value.status);
      if (statusCode === 404 || statusCode === 410) return true;
      const error = String(value.error || value.message || '').toLowerCase();
      return /not found|404|gone|missing/.test(error);
    }
    if (value.success === true && value.data == null) return true;
  }
  return false;
}

function normalizeTheirsStatus(value: unknown): string {
  switch (String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'inprogress':
    case 'started':
      return 'inProgress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'notStarted';
  }
}

function normalizeTheirsImportance(value: unknown): 'low' | 'normal' | 'high' {
  const asString = String(value ?? '').trim().toLowerCase();
  if (asString === 'low') return 'low';
  if (asString === 'high' || asString === 'urgent' || asString === 'important') return 'high';
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    if (asNumber >= 3) return 'high';
    if (asNumber === 1) return 'low';
  }
  return 'normal';
}

/**
 * Normalize the provider's live copy into the minimal conflict-preview
 * subset. Defensive by design: adapters return slightly different shapes
 * (wrapped `data`, Graph-style `body.content`/`dueDateTime.dateTime`,
 * Todoist-style `content`/`description`), and a preview must never throw on
 * a shape drift.
 */
function normalizeTheirs(value: any): TaskConflictTheirs {
  const data = value?.data || value?.task || value || {};
  const title = String(data.title ?? data.content ?? '').trim() || '(Untitled)';
  const rawDue = (data.dueDateTime && typeof data.dueDateTime === 'object' ? data.dueDateTime.dateTime : data.dueDateTime)
    ?? (data.due && typeof data.due === 'object' ? data.due.datetime || data.due.date : null)
    ?? data.dueDate
    ?? null;
  const rawBody = (data.body && typeof data.body === 'object' ? data.body.content : data.body)
    ?? data.description
    ?? data.notes
    ?? null;
  return {
    title,
    status: normalizeTheirsStatus(data.status ?? (data.checked ? 'completed' : undefined)),
    dueDateTime: rawDue != null && String(rawDue).trim() ? String(rawDue) : null,
    importance: normalizeTheirsImportance(data.importance ?? data.priority),
    body: rawBody != null && String(rawBody).trim() ? String(rawBody) : null,
  };
}

type ProviderProbe = {
  providerMissing: boolean;
  providerTask: any | null;
  providerVersion: string | null;
};

async function fetchLiveProviderCopy(
  userId: number,
  link: ConflictLinkRow | null,
  projectName: string | null,
): Promise<ProviderProbe> {
  // No active provider link, no provider task identity, or no container:
  // there is no provider copy to fetch — resolution proceeds with the
  // provider-missing semantics (keep_local re-creates, keep_provider accepts
  // the deletion).
  if (!link || !link.provider_task_id) {
    return { providerMissing: true, providerTask: null, providerVersion: null };
  }
  const containerId = providerContainerId(link);
  if (!containerId) {
    return { providerMissing: true, providerTask: null, providerVersion: null };
  }

  const providerApi = getTaskProviderForUser(userId, link.provider === 'nexus_local' ? 'nexus' : link.provider);
  if (typeof providerApi.getTask !== 'function') {
    throw typedError('PROVIDER_UNAVAILABLE', `${link.provider} does not support live task reads`);
  }

  let result: any;
  try {
    result = await withTimeout(
      Promise.resolve(providerApi.getTask(containerId, link.provider_task_id, projectName || 'Tasks')),
      PROVIDER_READ_TIMEOUT_MS,
      'task_conflict_provider_read',
    );
  } catch (err) {
    throw typedError(
      'PROVIDER_UNAVAILABLE',
      err instanceof Error ? err.message : 'provider_read_failed',
    );
  }

  if (looksProviderMissing(result)) {
    return { providerMissing: true, providerTask: null, providerVersion: null };
  }
  if (result && typeof result === 'object' && result.success === false) {
    throw typedError(
      'PROVIDER_UNAVAILABLE',
      String(result.error || result.message || 'provider_read_failed'),
    );
  }

  const providerVersion = extractLinkProviderVersion(link, result) || link.provider_version || null;
  return { providerMissing: false, providerTask: result, providerVersion };
}

function assertConflicted(tenantId: number, userId: number, row: ConflictTaskRow): void {
  if (row.sync_state === 'conflict') return;
  if (hasConflictMutation(tenantId, userId, row.nexus_task_id)) return;
  throw typedError('CONFLICT_NOT_FOUND', 'Task has no unresolved sync conflict');
}

function buildPreview(input: {
  tenantId: number;
  userId: number;
  nexusTaskId: string;
  link: ConflictLinkRow | null;
  probe: ProviderProbe;
}): TaskConflictPreview {
  const mine = getOfflineTaskById(input.tenantId, input.userId, input.nexusTaskId);
  if (!mine) throw typedError('NOT_FOUND', 'Task not found in local task store');
  return {
    // Deterministic per (task, last-known provider version): the same
    // unresolved conflict always previews with the same id.
    conflictId: `conflict_${input.nexusTaskId}_${input.link?.provider_version || 'none'}`,
    mine,
    theirs: input.probe.providerMissing ? null : normalizeTheirs(input.probe.providerTask),
    providerVersion: input.probe.providerVersion,
    providerMissing: input.probe.providerMissing,
    fetchedAt: nowIso(),
  };
}

export async function getTaskConflictPreview(
  tenantId: number,
  userId: number,
  taskId: string,
): Promise<TaskConflictPreview> {
  const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
  if (!nexusTaskId) throw typedError('NOT_FOUND', 'Task not found in local task store');
  const row = getConflictTaskRow(tenantId, userId, nexusTaskId);
  if (!row) throw typedError('NOT_FOUND', 'Task not found in local task store');
  assertConflicted(tenantId, userId, row);

  const link = getActiveProviderLink(tenantId, userId, nexusTaskId);
  const probe = await fetchLiveProviderCopy(userId, link, row.project_name);
  return buildPreview({ tenantId, userId, nexusTaskId, link, probe });
}

function supersedeMutations(input: {
  tenantId: number;
  userId: number;
  nexusTaskId: string;
  statuses: readonly string[];
  errorCode: 'conflict_resolved_keep_local' | 'conflict_resolved_keep_provider';
}): number {
  const db = getDb();
  const placeholders = input.statuses.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT mutation_id, status FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND task_id = ? AND status IN (${placeholders})`,
  ).all(input.tenantId, input.userId, input.nexusTaskId, ...input.statuses) as Array<{
    mutation_id: string;
    status: string;
  }>;
  const update = db.prepare(
    `UPDATE task_mutations
     SET status = 'superseded',
         locked_at = NULL,
         next_retry_at = NULL,
         last_error_code = ?,
         last_error_message = NULL
     WHERE mutation_id = ?`,
  );
  for (const row of rows) {
    assertTransition('mutation_status', row.status, 'superseded', { mutationId: row.mutation_id });
    update.run(input.errorCode, row.mutation_id);
  }
  return rows.length;
}

function statusDbValue(theirs: TaskConflictTheirs): string {
  switch (theirs.status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'inProgress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function importanceDbPriority(importance: 'low' | 'normal' | 'high'): number {
  // M10 (NEX-17): shared inbound table (high→2, normal→3, low→4).
  return importanceToPriority(importance);
}

export async function resolveTaskConflict(
  tenantId: number,
  userId: number,
  input: TaskConflictResolveInput,
): Promise<TaskConflictResolveResult> {
  if (input.strategy !== 'keep_local' && input.strategy !== 'keep_provider') {
    throw typedError('BAD_REQUEST', "strategy must be 'keep_local' or 'keep_provider'");
  }
  const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, input.taskId);
  if (!nexusTaskId) throw typedError('NOT_FOUND', 'Task not found in local task store');
  const row = getConflictTaskRow(tenantId, userId, nexusTaskId);
  if (!row) throw typedError('NOT_FOUND', 'Task not found in local task store');

  const db = getDb();
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:task.update`).slice(0, 220);

  // Idempotent replay (keep_local only — keep_provider records no ledger row):
  // a retried resolve whose first attempt already enqueued the re-push must
  // not 404/duplicate. Checked before the conflicted gate on purpose — the
  // first attempt already cleared the conflict.
  if (input.strategy === 'keep_local' && (input.clientMutationId || input.idempotencyKey)) {
    const existing = db.prepare(
      `SELECT mutation_id FROM task_mutations
       WHERE tenant_id = ? AND user_id = ? AND operation = 'task.update'
         AND (client_mutation_id = ? OR idempotency_key = ?)
       LIMIT 1`,
    ).get(tenantId, userId, clientMutationId, idempotencyKey) as { mutation_id: string } | undefined;
    if (existing) {
      const task = getOfflineTaskById(tenantId, userId, nexusTaskId);
      if (!task) throw typedError('NOT_FOUND', 'Task not found in local task store');
      return { resolved: true, strategy: input.strategy, task, idempotentReplay: true };
    }
  }

  assertConflicted(tenantId, userId, row);

  const link = getActiveProviderLink(tenantId, userId, nexusTaskId);
  const probe = await fetchLiveProviderCopy(userId, link, row.project_name);

  // Stale-preview guard: the client resolved against a specific provider
  // version; if the provider copy moved (or disappeared) since the preview,
  // reject and hand back a refreshed preview instead of clobbering the newer
  // remote edit.
  if (input.expectedProviderVersion != null && String(input.expectedProviderVersion).trim() !== '') {
    const freshKey = probe.providerVersion || 'none';
    if (String(input.expectedProviderVersion) !== freshKey) {
      const err = typedError('CONFLICT_STALE', 'Provider copy changed since the conflict preview. Review the refreshed preview.');
      (err as any).preview = buildPreview({ tenantId, userId, nexusTaskId, link, probe });
      throw err;
    }
  }

  const resolvedAt = nowIso();

  if (input.strategy === 'keep_local') {
    db.transaction(() => {
      supersedeMutations({
        tenantId,
        userId,
        nexusTaskId,
        statuses: ['conflict', 'failed'],
        errorCode: 'conflict_resolved_keep_local',
      });

      if (link) {
        if (probe.providerMissing) {
          // Provider copy is gone: keep_local means re-create. Clearing the
          // provider task identity re-arms the worker's existing
          // create-recovery branch (no provider_task_id → marker search →
          // createTask) — no new worker operation needed, and the freed
          // UNIQUE slot cannot collide with a future re-import.
          assertTransition('link_state', link.link_state, 'pending_create', { linkId: link.id });
          db.prepare(
            `UPDATE task_provider_links
             SET provider_task_id = NULL,
                 provider_version = NULL,
                 link_state = 'pending_create',
                 updated_at = ?
             WHERE id = ?`,
          ).run(resolvedAt, link.id);
        } else {
          assertTransition('link_state', link.link_state, 'pending_update', { linkId: link.id });
          db.prepare(
            `UPDATE task_provider_links
             SET provider_version = ?,
                 link_state = 'pending_update',
                 updated_at = ?
             WHERE id = ?`,
          ).run(probe.providerVersion, resolvedAt, link.id);
        }
      }

      // ONE new queued full-content re-push. The worker builds the provider
      // payload from the canonical row, so the patch carries the content for
      // audit plus the provider filter that routes it to the conflicted link.
      db.prepare(
        `INSERT INTO task_mutations (
           mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
           task_id, operation, base_local_version, patch_json, submitted_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'task.update', ?, ?, ?, 'queued')`,
      ).run(
        randomId('task_mutation'),
        clientMutationId,
        idempotencyKey,
        tenantId,
        userId,
        nexusTaskId,
        row.local_version || 1,
        JSON.stringify({
          resolution: 'keep_local',
          providerLinkProvider: link?.provider || null,
          title: row.title,
          body: row.notes,
          dueDateTime: row.due_date,
          status: row.status,
        }),
        resolvedAt,
      );

      assertTransition('task_sync_state', String(row.sync_state || ''), 'queued', { taskId: nexusTaskId });
      db.prepare(
        `UPDATE unified_tasks
         SET sync_state = 'queued', updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(resolvedAt, tenantId, userId, nexusTaskId);
    })();

    resolveTaskSyncIssue({ tenantId, userId, taskId: nexusTaskId, code: 'provider_conflict' });
    if (probe.providerMissing) {
      resolveTaskSyncIssue({ tenantId, userId, taskId: nexusTaskId, code: 'provider_task_missing' });
    }
  } else if (probe.providerMissing) {
    // keep_provider with the provider copy gone: accept the remote deletion.
    db.transaction(() => {
      supersedeMutations({
        tenantId,
        userId,
        nexusTaskId,
        statuses: ['queued', 'accepted_local', 'failed', 'conflict'],
        errorCode: 'conflict_resolved_keep_provider',
      });

      assertTransition('task_sync_state', String(row.sync_state || ''), 'synced', { taskId: nexusTaskId });
      db.prepare(
        `UPDATE unified_tasks
         SET is_deleted = 1,
             deleted_at = ?,
             sync_state = 'synced',
             updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(resolvedAt, resolvedAt, tenantId, userId, nexusTaskId);

      if (link) {
        // Same semantics as a pushed delete: the link surrenders its provider
        // id and retires so the UNIQUE slot is free for future re-links.
        assertTransition('link_state', link.link_state, 'orphaned', { linkId: link.id });
        db.prepare(
          `UPDATE task_provider_links
           SET provider_task_id = NULL,
               link_state = 'orphaned',
               updated_at = ?
           WHERE id = ?`,
        ).run(resolvedAt, link.id);
      }
    })();

    resolveTaskSyncIssue({ tenantId, userId, taskId: nexusTaskId, code: 'provider_conflict' });
    resolveTaskSyncIssue({ tenantId, userId, taskId: nexusTaskId, code: 'provider_task_missing' });
  } else {
    const theirs = normalizeTheirs(probe.providerTask);
    const nextStatus = statusDbValue(theirs);
    // M10 echo-stability (NEX-17): the provider only speaks coarse
    // importance, so keep_provider preserves the stored fine-grained P1–P4
    // when the provider's bucket agrees with it — 'high' must not demote a
    // stored P1 to P2. A different bucket is a real provider-side change and
    // wins (same rule as the pull merge in unified-task-store.upsertTask).
    const theirsPriority = importanceDbPriority(theirs.importance);
    const nextPriority = sameImportanceBucket(row.priority, theirsPriority)
      ? normalizeStoredTaskPriority(row.priority)
      : theirsPriority;
    const nextDue = theirs.dueDateTime;
    const nextNotes = theirs.body;
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags || '[]');
    } catch {
      tags = [];
    }
    // Canonical-links rule: provider/external_id stay origin metadata — only
    // content fields move. The recomputed hash makes the next pull of this
    // exact provider content a no-op instead of a phantom "update".
    const contentHash = computeContentHash({
      provider: row.provider as TaskProvider,
      externalId: row.external_id,
      title: theirs.title,
      status: nextStatus,
      priority: nextPriority,
      dueDate: nextDue ?? undefined,
      tags,
      projectName: row.project_name ?? undefined,
    } as NormalizedTask);

    db.transaction(() => {
      supersedeMutations({
        tenantId,
        userId,
        nexusTaskId,
        statuses: ['queued', 'accepted_local', 'failed', 'conflict'],
        errorCode: 'conflict_resolved_keep_provider',
      });

      assertTransition('task_sync_state', String(row.sync_state || ''), 'synced', { taskId: nexusTaskId });
      db.prepare(
        `UPDATE unified_tasks
         SET title = ?,
             status = ?,
             priority = ?,
             due_date = ?,
             due_is_datetime = ?,
             notes = ?,
             description = ?,
             completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END,
             content_hash = ?,
             is_deleted = 0,
             deleted_at = NULL,
             sync_state = 'synced',
             local_version = COALESCE(local_version, 1) + 1,
             synced_at = ?,
             updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(
        theirs.title,
        nextStatus,
        nextPriority,
        nextDue,
        nextDue && String(nextDue).includes('T') ? 1 : 0,
        nextNotes,
        nextNotes,
        nextStatus,
        resolvedAt,
        contentHash,
        resolvedAt,
        resolvedAt,
        tenantId,
        userId,
        nexusTaskId,
      );

      if (link) {
        assertTransition('link_state', link.link_state, 'linked', { linkId: link.id });
        db.prepare(
          `UPDATE task_provider_links
           SET provider_version = ?,
               last_synced_snapshot = ?,
               link_state = 'linked',
               last_synced_at = ?,
               last_verified_at = ?,
               updated_at = ?
           WHERE id = ?`,
        ).run(
          probe.providerVersion,
          buildTaskSyncedSnapshot({
            title: theirs.title,
            status: nextStatus,
            priority: nextPriority,
            dueDate: nextDue,
            dueIsDatetime: Boolean(nextDue && String(nextDue).includes('T')),
            notes: nextNotes,
          }),
          resolvedAt,
          resolvedAt,
          resolvedAt,
          link.id,
        );
      }
    })();

    resolveTaskSyncIssue({ tenantId, userId, taskId: nexusTaskId, code: 'provider_conflict' });
  }

  logger.info(
    {
      tenantId,
      userId,
      taskId: nexusTaskId,
      strategy: input.strategy,
      providerMissing: probe.providerMissing,
      provider: link?.provider || null,
    },
    'Task sync conflict resolved',
  );

  const task = getOfflineTaskById(tenantId, userId, nexusTaskId);
  if (!task) throw typedError('NOT_FOUND', 'Task not found in local task store');
  return { resolved: true, strategy: input.strategy, task };
}

/** Test-only: exercise the defensive provider normalization directly. */
export function _normalizeTheirsForTests(value: unknown): TaskConflictTheirs {
  return normalizeTheirs(value);
}
