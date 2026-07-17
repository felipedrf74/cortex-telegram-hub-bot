// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unified Task Store — CRUD on `unified_tasks` and `unified_projects`.
 *
 * The store is the canonical READ source for AI calls and the iOS app —
 * never query a provider API at read time. Writes go through provider
 * adapters first (see task-service.ts) and the result is upserted here.
 *
 * The headline feature is hash-based change detection: 95% of sync upserts
 * are no-ops because the task didn't actually change between sync windows.
 * `computeContentHash` produces a 16-byte fingerprint over the fields users
 * care about; identical hash → SQL skip. This keeps the WAL quiet.
 */

import crypto from 'crypto';
import { getDb } from '../database';
import { logger } from '../../utils/logger';
import {
  NormalizedTask,
  NormalizedProject,
  NormalizedStatus,
  TaskProvider,
  SyncStateRow,
} from './types';
import { recordTaskSyncIssue, resolveTaskSyncIssue } from './task-sync-issues';
import { buildTaskSyncedSnapshot } from './task-sync-snapshot';

// ─── Row mapping ────────────────────────────────────────────────────────

interface UnifiedTaskRow {
  id: number;
  user_id: number;
  tenant_id: number | null;
  provider: TaskProvider;
  external_id: string;
  project_id: number | null;
  project_name: string | null;
  title: string;
  description: string | null;
  status: NormalizedStatus;
  priority: number;
  due_date: string | null;
  due_is_datetime: number;
  tags: string;
  notes: string | null;
  completed_at: string | null;
  assignee: string | null;
  url: string | null;
  provider_data: string;
  content_hash: string | null;
  is_deleted: number;
  synced_at: string;
  created_at: string;
  updated_at: string;
  nexus_task_id: string | null;
  local_version: number | null;
  sync_state: string | null;
  deleted_at: string | null;
}

interface UnifiedProjectRow {
  id: number;
  user_id: number;
  tenant_id: number | null;
  provider: TaskProvider;
  external_id: string;
  name: string;
  color: string | null;
  is_default: number;
  task_count: number;
  synced_at: string;
}

function rowToTask(row: UnifiedTaskRow): NormalizedTask {
  let tags: string[] = [];
  let providerData: Record<string, unknown> = {};
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* invalid JSON, drop */ }
  try { providerData = JSON.parse(row.provider_data || '{}'); } catch { /* invalid JSON, drop */ }

  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date ?? undefined,
    dueIsDatetime: row.due_is_datetime === 1,
    tags,
    notes: row.notes ?? undefined,
    completedAt: row.completed_at ?? undefined,
    assignee: row.assignee ?? undefined,
    url: row.url ?? undefined,
    providerData,
  };
}

function rowToProject(row: UnifiedProjectRow): NormalizedProject {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    name: row.name,
    color: row.color ?? undefined,
    isDefault: row.is_default === 1,
    taskCount: row.task_count,
  };
}

// ─── Content hash ──────────────────────────────────────────────────────

/**
 * Compute a deterministic 16-byte hex hash over the fields that matter for
 * change detection: title, status, due, priority, tags. NOT included:
 *
 *   - `notes`/`description` — too noisy; users edit prose constantly without
 *     wanting a re-render. (If we hashed it, completing-via-cron would race
 *     with the user's typing.)
 *   - `providerData` — opaque, varies between provider responses for the
 *     same logical task.
 *   - `synced_at`/`updated_at` — always change.
 *
 * The hash is intentionally short (16 hex chars = 64 bits): collisions in
 * 64 bits are vanishingly unlikely for our scale (millions of tasks per user
 * still gives collision odds <1 in 10^9).
 */
export function computeContentHash(task: NormalizedTask): string {
  const tagsKey = (task.tags || []).slice().sort().join(',');
  const hashInput = [
    task.title || '',
    task.status,
    task.dueDate || '',
    String(task.priority),
    tagsKey,
    task.projectName || '',
  ].join('|');
  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

function stableNexusTaskId(tenantId: number, userId: number, task: NormalizedTask): string {
  if (task.provider === 'nexus' && /^task_[A-Za-z0-9_-]+$/.test(task.externalId || '')) {
    return task.externalId;
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${tenantId}:${userId}:${task.provider}:${task.externalId}`)
    .digest('hex')
    .slice(0, 28);
  return `task_${hash}`;
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function isMappedTaskProvider(provider: TaskProvider): provider is 'ms_todo' {
  return provider === 'ms_todo';
}

function ensureTaskContainerMappingForProviderProject(userId: number, tenantId: number, project: NormalizedProject): void {
  if (!isMappedTaskProvider(project.provider)) return;
  const db = getDb();
  const providerProject = db.prepare(
    `SELECT id
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?
     LIMIT 1`,
  ).get(userId, tenantId, project.provider, project.externalId) as { id: number } | undefined;
  if (!providerProject) return;

  const providerContainerType = project.provider === 'ms_todo' ? 'todo_list' : 'project';
  const existingPreference = db.prepare(
    `SELECT sync_direction
     FROM task_container_mappings
     WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_container_id = ?
       AND sync_direction IN ('none', 'pull_only', 'push_only', 'bidirectional')
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(tenantId, userId, project.provider, project.externalId) as { sync_direction: string } | undefined;
  const syncDirection = existingPreference?.sync_direction || 'bidirectional';
  db.prepare(
    `INSERT INTO task_container_mappings (
       id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
       provider_container_id, sync_direction
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, nexus_list_id, provider)
     DO UPDATE SET
       provider_container_type = excluded.provider_container_type,
       provider_container_id = excluded.provider_container_id,
       sync_direction = CASE
         WHEN task_container_mappings.sync_direction IN ('none', 'pull_only', 'push_only', 'bidirectional')
           THEN task_container_mappings.sync_direction
         ELSE excluded.sync_direction
       END,
       updated_at = datetime('now')`,
  ).run(
    randomId('task_container_mapping'),
    tenantId,
    userId,
    String(providerProject.id),
    project.provider,
    providerContainerType,
    project.externalId,
    syncDirection,
  );
}

function stringProviderDataValue(task: NormalizedTask, keys: string[]): string | null {
  for (const key of keys) {
    const value = task.providerData?.[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return null;
}

function providerLinkProvider(provider: TaskProvider): 'ms_todo' | 'todoist' | 'nexus_local' | null {
  if (provider === 'ms_todo' || provider === 'todoist') return provider;
  if (provider === 'nexus') return 'nexus_local';
  return null;
}

function providerContainerId(task: NormalizedTask): string | null {
  return stringProviderDataValue(task, [
    'listId',
    'list_id',
    'parentFolderId',
    'project_id',
    'projectId',
  ]) || (task.projectId != null ? String(task.projectId) : null);
}

/**
 * Extract the Nexus correlation marker from a provider payload. The push
 * worker stamps every Nexus-created Microsoft task with a linkedResources
 * entry whose externalId is the canonical nexus task id; reading it back at
 * import is what lets a pull recognize its own pushed task even when the
 * Graph id changed (Microsoft has no move API — the official clients
 * delete + recreate on cross-list moves).
 */
function extractNexusMarkerTaskId(task: NormalizedTask): string | null {
  const raw = (task.providerData as Record<string, unknown> | undefined)?.linkedResources;
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    const externalId = typeof (entry as { externalId?: unknown })?.externalId === 'string'
      ? (entry as { externalId: string }).externalId
      : null;
    if (externalId && /^task_[A-Za-z0-9_-]+$/.test(externalId)) return externalId;
  }
  return null;
}

function ensureProviderLinkForTask(
  tenantId: number,
  userId: number,
  task: NormalizedTask,
  nexusTaskId: string,
  options: { captureSyncedSnapshot?: boolean } = {},
): void {
  const provider = providerLinkProvider(task.provider);
  if (!provider) return;

  // M2B snapshot capture rides the link upsert that already happens on every
  // pull path (import, hash-equal sighting, overwrite) — no extra read. The
  // divergent-pull conflict path passes captureSyncedSnapshot:false because
  // the provider copy it saw is NOT an agreed base; the snapshot must keep
  // pointing at the last content both sides shared.
  const syncedSnapshot = options.captureSyncedSnapshot === false
    ? null
    : buildTaskSyncedSnapshot({
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate ?? null,
      dueIsDatetime: task.dueIsDatetime ?? false,
      notes: task.notes ?? null,
    });

  const containerId = providerContainerId(task);
  getDb().prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id,
       provider_version, provider_updated_at, last_synced_at, last_verified_at,
       ownership, link_state, last_synced_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, 'linked', ?)
     ON CONFLICT(tenant_id, user_id, provider, provider_account_id, provider_task_id)
     DO UPDATE SET
       task_id = CASE
         WHEN task_provider_links.task_id != excluded.task_id
          AND EXISTS (
            SELECT 1 FROM unified_tasks live
            WHERE live.nexus_task_id = task_provider_links.task_id
              AND live.user_id = task_provider_links.user_id
              AND live.is_deleted = 0
          )
         THEN task_provider_links.task_id
         ELSE excluded.task_id
       END,
       provider_list_id = COALESCE(excluded.provider_list_id, task_provider_links.provider_list_id),
       provider_project_id = COALESCE(excluded.provider_project_id, task_provider_links.provider_project_id),
       provider_version = COALESCE(excluded.provider_version, task_provider_links.provider_version),
       provider_updated_at = COALESCE(excluded.provider_updated_at, task_provider_links.provider_updated_at),
       last_synced_snapshot = COALESCE(excluded.last_synced_snapshot, task_provider_links.last_synced_snapshot),
       last_synced_at = datetime('now'),
       last_verified_at = datetime('now'),
       link_state = CASE
         WHEN task_provider_links.link_state IN ('conflict', 'orphaned') THEN task_provider_links.link_state
         ELSE 'linked'
       END,
       updated_at = datetime('now')`,
  ).run(
    randomId('task_link'),
    nexusTaskId,
    tenantId,
    userId,
    provider,
    `${provider}:${userId}`,
    task.externalId || nexusTaskId,
    provider === 'ms_todo' ? containerId : null,
    provider === 'todoist' ? containerId : null,
    stringProviderDataValue(task, ['etag', '@odata.etag', 'revision', 'sync_id']),
    stringProviderDataValue(task, ['updated_at', 'lastModifiedDateTime', 'modified_at']),
    provider === 'nexus_local' ? 'linked' : 'provider_imported',
    syncedSnapshot,
  );
}

function hasRecoverableProviderAbsenceState(syncState: string | null | undefined): boolean {
  // 'provider_disconnected' is deliberately NOT recoverable-by-sighting: that
  // state is only written when a local mutation was parked by an auth failure,
  // and flipping the row to 'synced' just because a pull saw the provider's
  // (stale) copy masked the un-delivered edit (NEX-03). Disconnected rows heal
  // through actual delivery — the worker re-arms parked mutations once the
  // provider reconnects and markSynced flips the state after the push lands.
  return [
    'provider_missing',
    'stale',
    'failed_retryable',
  ].includes(String(syncState || ''));
}

function markProviderTaskSeen(input: {
  tenantId: number;
  userId: number;
  provider: TaskProvider;
  nexusTaskId: string;
}): void {
  const provider = providerLinkProvider(input.provider);
  if (!provider) return;

  const db = getDb();
  db.prepare(
    `UPDATE unified_tasks
     SET sync_state = 'synced',
         is_deleted = 0,
         deleted_at = NULL,
         synced_at = datetime('now'),
         updated_at = datetime('now')
     WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?
       AND sync_state IN ('provider_missing', 'stale', 'failed_retryable')`,
  ).run(input.tenantId, input.userId, input.nexusTaskId);
  db.prepare(
    `UPDATE task_provider_links
     SET link_state = 'linked',
         last_synced_at = datetime('now'),
         last_verified_at = datetime('now'),
         updated_at = datetime('now')
     WHERE tenant_id = ? AND user_id = ? AND task_id = ? AND provider = ?
       AND link_state IN ('provider_missing', 'disconnected', 'stale')`,
  ).run(input.tenantId, input.userId, input.nexusTaskId, provider);

  resolveTaskSyncIssue({
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.nexusTaskId,
    provider,
    code: 'provider_task_missing',
  });
}

function hasPendingLocalMutation(syncState: string | null | undefined): boolean {
  // 'provider_disconnected' rows carry a parked local mutation (that state is
  // only written by the worker's failure path), and 'deleted_pending_sync'
  // rows carry an un-pushed delete — both must be protected from the pull
  // overwrite path, which previously reverted disconnected-era edits (NEX-03)
  // and resurrected pending deletes (NEX-19).
  return [
    'queued',
    'syncing',
    'failed_retryable',
    'conflict',
    'provider_disconnected',
    'deleted_pending_sync',
  ].includes(String(syncState || ''));
}

function markProviderMissingTask(input: {
  tenantId: number;
  userId: number;
  provider: TaskProvider;
  row: { id: number; nexus_task_id: string | null; sync_state: string | null };
}): void {
  const db = getDb();
  const taskId = input.row.nexus_task_id || `task_legacy_${input.row.id}`;
  const pendingLocal = hasPendingLocalMutation(input.row.sync_state);
  const nextSyncState = pendingLocal ? 'conflict' : 'provider_missing';
  db.prepare(
    `UPDATE unified_tasks
     SET sync_state = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(nextSyncState, input.row.id);
  db.prepare(
    `UPDATE task_provider_links
     SET link_state = 'provider_missing', updated_at = datetime('now')
     WHERE tenant_id = ? AND user_id = ? AND task_id = ? AND provider = ?`,
  ).run(input.tenantId, input.userId, taskId, input.provider === 'nexus' ? 'nexus_local' : input.provider);
  recordTaskSyncIssue({
    tenantId: input.tenantId,
    userId: input.userId,
    taskId,
    provider: input.provider === 'nexus' ? 'nexus_local' : input.provider,
    code: pendingLocal ? 'provider_conflict' : 'provider_task_missing',
    message: pendingLocal
      ? 'Provider deleted this task while Nexus has pending local changes. Review conflict.'
      : 'Provider no longer has this task. Nexus kept the local copy.',
    details: { reason: 'provider_full_pull_missing_task' },
  });
}

// ─── Upsert ────────────────────────────────────────────────────────────

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

/**
 * Idempotent task upsert.
 *
 * Three outcomes:
 *   - `inserted` → no row matched (user_id, provider, external_id)
 *   - `updated`  → row matched but content hash changed
 *   - `unchanged` → row matched and content hash is identical
 *
 * The 'unchanged' case is the hot path on every sync — 95%+ of attempts.
 * It does ONE SELECT and zero writes, which is what makes 96 sync runs/day
 * across all providers fast enough to hide behind the existing scheduler.
 */
type ExistingTaskRow = {
  id: number;
  content_hash: string;
  sync_state: string | null;
  nexus_task_id: string | null;
  is_deleted?: number;
  provider_data?: string | null;
};

/**
 * Canonical-links pull routing: an ACTIVE provider link owns the incoming
 * provider task id — its target row (the canonical Nexus task, whatever its
 * origin identity says) is authoritative, so a pushed Nexus task can never
 * be re-imported as a twin (NEX-02) and a soft-deleted twin can never
 * recapture its link on the next pull.
 */
function findRowByActiveLink(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  userId: number,
  task: NormalizedTask,
): ExistingTaskRow | undefined {
  const provider = providerLinkProvider(task.provider);
  if (!provider || provider === 'nexus_local' || !task.externalId) return undefined;
  return db.prepare(
    `SELECT t.id, t.content_hash, t.sync_state, t.nexus_task_id, t.is_deleted, t.provider_data
     FROM task_provider_links l
     JOIN unified_tasks t
       ON t.nexus_task_id = l.task_id
      AND t.user_id = l.user_id
      AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
     WHERE l.user_id = ? AND COALESCE(l.tenant_id, l.user_id) = ?
       AND l.provider = ? AND l.provider_account_id = ? AND l.provider_task_id = ?
       AND l.link_state NOT IN ('orphaned')
     LIMIT 1`,
  ).get(userId, tenantId, provider, `${provider}:${userId}`, task.externalId) as ExistingTaskRow | undefined;
}

/**
 * Marker adoption: the incoming provider task carries the Nexus
 * linkedResources marker but no active link matches its (new) provider id —
 * the Microsoft-move case (delete + recreate under a fresh Graph id). Adopt
 * the new id onto the marked task's link instead of importing a twin.
 */
function adoptRowByNexusMarker(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  userId: number,
  task: NormalizedTask,
): ExistingTaskRow | undefined {
  const provider = providerLinkProvider(task.provider);
  if (!provider || provider === 'nexus_local') return undefined;
  const markerTaskId = extractNexusMarkerTaskId(task);
  if (!markerTaskId) return undefined;

  const linked = db.prepare(
    `SELECT t.id, t.content_hash, t.sync_state, t.nexus_task_id, t.is_deleted, t.provider_data,
            l.id AS link_id
     FROM unified_tasks t
     JOIN task_provider_links l
       ON l.task_id = t.nexus_task_id
      AND l.user_id = t.user_id
      AND COALESCE(l.tenant_id, l.user_id) = COALESCE(t.tenant_id, t.user_id)
      AND l.provider = ? AND l.provider_account_id = ?
      AND l.link_state NOT IN ('orphaned')
     WHERE t.user_id = ? AND COALESCE(t.tenant_id, t.user_id) = ?
       AND t.nexus_task_id = ? AND t.is_deleted = 0
     LIMIT 1`,
  ).get(provider, `${provider}:${userId}`, userId, tenantId, markerTaskId) as
    | (ExistingTaskRow & { link_id: string })
    | undefined;
  if (!linked) return undefined;

  // Pre-migration-234-shaped data can still hold the incoming provider id on
  // an orphaned link, which occupies the legacy UNIQUE slot — retire it so
  // the adoption UPDATE cannot collide.
  db.prepare(
    `UPDATE task_provider_links
     SET provider_task_id = NULL, updated_at = datetime('now')
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
       AND provider = ? AND provider_account_id = ? AND provider_task_id = ?
       AND link_state = 'orphaned'`,
  ).run(userId, tenantId, provider, `${provider}:${userId}`, task.externalId);

  db.prepare(
    `UPDATE task_provider_links
     SET provider_task_id = ?,
         provider_list_id = CASE WHEN ? = 'ms_todo' THEN COALESCE(?, provider_list_id) ELSE provider_list_id END,
         provider_project_id = CASE WHEN ? = 'todoist' THEN COALESCE(?, provider_project_id) ELSE provider_project_id END,
         provider_version = COALESCE(?, provider_version),
         last_synced_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    task.externalId,
    provider,
    providerContainerId(task),
    provider,
    providerContainerId(task),
    stringProviderDataValue(task, ['etag', '@odata.etag', 'revision', 'sync_id']),
    linked.link_id,
  );
  return linked;
}

function isMergedTombstone(row: ExistingTaskRow | undefined): boolean {
  if (!row || row.is_deleted !== 1) return false;
  return typeof row.provider_data === 'string' && row.provider_data.includes('"merged_into"');
}

export function upsertTask(userId: number, task: NormalizedTask, tenantId = userId): UpsertResult {
  const db = getDb();
  const hash = computeContentHash(task);
  const nexusTaskId = stableNexusTaskId(tenantId, userId, task);

  // 1. Links-first: an active link for this provider task id is authoritative.
  let existing: ExistingTaskRow | undefined = findRowByActiveLink(db, tenantId, userId, task);

  if (!existing) {
    // 2. Origin-identity match (legacy/unlinked rows keep working).
    existing = db.prepare(
      `SELECT id, content_hash, sync_state, nexus_task_id, is_deleted, provider_data
       FROM unified_tasks
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?`,
    ).get(userId, tenantId, task.provider, task.externalId) as ExistingTaskRow | undefined;

    // A twin merged into a canonical row must never resurrect or recapture
    // its link — its retired identity is only reachable when the canonical
    // link is gone, and even then it stays a tombstone.
    if (isMergedTombstone(existing)) return 'unchanged';

    // 3. Marker adoption (Microsoft move: new Graph id, same Nexus task).
    if (!existing) {
      existing = adoptRowByNexusMarker(db, tenantId, userId, task);
    }
  }

  if (!existing) {
    db.prepare(
      `INSERT INTO unified_tasks (
        user_id, tenant_id, provider, external_id, project_id, project_name, title,
        description, status, priority, due_date, due_is_datetime, tags, notes,
        completed_at, assignee, url, provider_data, content_hash, synced_at,
        nexus_task_id, local_version, sync_state, source_of_truth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1, 'synced', 'nexus')`,
    ).run(
      userId,
      tenantId,
      task.provider,
      task.externalId,
      task.projectId ?? null,
      task.projectName ?? null,
      task.title,
      task.description ?? null,
      task.status,
      task.priority,
      task.dueDate ?? null,
      task.dueIsDatetime ? 1 : 0,
      JSON.stringify(task.tags || []),
      task.notes ?? null,
      task.completedAt ?? null,
      task.assignee ?? null,
      task.url ?? null,
      JSON.stringify(task.providerData || {}),
      hash,
      nexusTaskId,
    );
    ensureProviderLinkForTask(tenantId, userId, task, nexusTaskId);
    return 'inserted';
  }

  // Hot path: hash unchanged → no write
  const existingNexusTaskId = existing.nexus_task_id || nexusTaskId;
  if (existing.content_hash === hash) {
    ensureProviderLinkForTask(tenantId, userId, task, existingNexusTaskId);
    if (hasRecoverableProviderAbsenceState(existing.sync_state)) {
      markProviderTaskSeen({
        tenantId,
        userId,
        provider: task.provider,
        nexusTaskId: existingNexusTaskId,
      });
    }
    return 'unchanged';
  }

  if (hasPendingLocalMutation(existing.sync_state)) {
    // Divergent pull on a pending-local row: do NOT advance the synced
    // snapshot — the provider copy is one side of the conflict, not a base.
    ensureProviderLinkForTask(tenantId, userId, task, existingNexusTaskId, { captureSyncedSnapshot: false });
    db.prepare(
      `UPDATE unified_tasks SET
         sync_state = 'conflict',
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(existing.id);
    return 'unchanged';
  }

  db.prepare(
    `UPDATE unified_tasks SET
       title = ?, description = ?, status = ?, priority = ?,
       due_date = ?, due_is_datetime = ?, tags = ?, notes = ?,
       completed_at = ?, project_name = ?, project_id = ?, url = ?,
       provider_data = ?, content_hash = ?, is_deleted = 0,
       tenant_id = COALESCE(tenant_id, ?),
       nexus_task_id = COALESCE(nexus_task_id, ?),
       local_version = COALESCE(local_version, 1) + 1,
       sync_state = 'synced',
       synced_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    task.title,
    task.description ?? null,
    task.status,
    task.priority,
    task.dueDate ?? null,
    task.dueIsDatetime ? 1 : 0,
    JSON.stringify(task.tags || []),
    task.notes ?? null,
    task.completedAt ?? null,
    task.projectName ?? null,
    task.projectId ?? null,
    task.url ?? null,
    JSON.stringify(task.providerData || {}),
    hash,
    tenantId,
    nexusTaskId,
    existing.id,
  );
  ensureProviderLinkForTask(tenantId, userId, task, existingNexusTaskId);
  if (hasRecoverableProviderAbsenceState(existing.sync_state)) {
    markProviderTaskSeen({
      tenantId,
      userId,
      provider: task.provider,
      nexusTaskId: existingNexusTaskId,
    });
  }
  return 'updated';
}

/** Upsert a project. Same idempotency contract as `upsertTask`. */
export function upsertProject(userId: number, project: NormalizedProject, tenantId = userId): UpsertResult {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id, name, color, task_count
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?`,
  ).get(userId, tenantId, project.provider, project.externalId) as
    | { id: number; name: string; color: string | null; task_count: number }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO unified_projects (
        user_id, tenant_id, provider, external_id, name, color, is_default, task_count, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      userId,
      tenantId,
      project.provider,
      project.externalId,
      project.name,
      project.color ?? null,
      project.isDefault ? 1 : 0,
      project.taskCount ?? 0,
    );
    ensureTaskContainerMappingForProviderProject(userId, tenantId, project);
    return 'inserted';
  }

  const unchanged =
    existing.name === project.name &&
    (existing.color ?? null) === (project.color ?? null) &&
    existing.task_count === (project.taskCount ?? 0);
  if (unchanged) {
    ensureTaskContainerMappingForProviderProject(userId, tenantId, project);
    return 'unchanged';
  }

  db.prepare(
    `UPDATE unified_projects SET tenant_id = COALESCE(tenant_id, ?), name = ?, color = ?, is_default = ?, task_count = ?, synced_at = datetime('now')
     WHERE id = ?`,
  ).run(
    tenantId,
    project.name,
    project.color ?? null,
    project.isDefault ? 1 : 0,
    project.taskCount ?? 0,
    existing.id,
  );
  ensureTaskContainerMappingForProviderProject(userId, tenantId, project);
  return 'updated';
}

// ─── Soft delete ───────────────────────────────────────────────────────

/**
 * Mark any task that's NOT in the current external-id list as deleted.
 *
 * Only safe to call after a FULL provider pull (no cursor) — incremental
 * syncs don't see all tasks, so calling this on an incremental run would
 * wipe everything that wasn't in the delta.
 *
 * We never hard-delete: soft delete preserves history (the iOS app can
 * still resolve a stale notification's task id), and the row remains a
 * dedup target for the cross-provider source-of-truth resolver.
 */
export function softDeleteMissing(
  userId: number,
  provider: TaskProvider,
  currentExternalIds: string[],
  tenantId = userId,
): number {
  const db = getDb();

  let totalMarked = 0;
  const allRows = db.prepare(
    `SELECT id, external_id, nexus_task_id, sync_state
     FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND is_deleted = 0`,
  ).all(userId, tenantId, provider) as Array<{
    id: number;
    external_id: string;
    nexus_task_id: string | null;
    sync_state: string | null;
  }>;

  // Canonical-links membership: pushed Nexus-origin tasks live in the
  // provider only through their link (row provider stays 'nexus'), so a
  // provider-column scan alone can never detect their remote deletion.
  const linkProvider = providerLinkProvider(provider);
  const linkedRows = linkProvider && linkProvider !== 'nexus_local'
    ? db.prepare(
      `SELECT t.id, l.provider_task_id AS external_id, t.nexus_task_id, t.sync_state
       FROM task_provider_links l
       JOIN unified_tasks t
         ON t.nexus_task_id = l.task_id
        AND t.user_id = l.user_id
        AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
       WHERE l.user_id = ? AND COALESCE(l.tenant_id, l.user_id) = ?
         AND l.provider = ? AND l.provider_task_id IS NOT NULL
         AND l.link_state NOT IN ('orphaned')
         AND t.is_deleted = 0
         AND t.provider != ?`,
    ).all(userId, tenantId, linkProvider, provider) as Array<{
      id: number;
      external_id: string;
      nexus_task_id: string | null;
      sync_state: string | null;
    }>
    : [];

  const seen = new Set(currentExternalIds);
  const candidates = [...allRows, ...linkedRows];
  const seenRowIds = new Set<number>();
  const stale = currentExternalIds.length === 0
    ? candidates
    : candidates.filter((r) => !seen.has(r.external_id));

  for (const row of stale) {
    if (seenRowIds.has(row.id)) continue;
    seenRowIds.add(row.id);
    markProviderMissingTask({
      tenantId,
      userId,
      provider,
      row,
    });
    totalMarked += 1;
  }
  return totalMarked;
}

/**
 * M6 delta removals: handle a single explicit provider-side deletion (delta
 * `@removed` entry) as a per-task tombstone through the canonical-links path.
 * Row resolution is links-first (an ACTIVE link owns the provider task id),
 * then origin identity — the same routing the pull upsert uses — and the
 * outcome is the exact provider_missing/conflict semantics of the links-based
 * full-pull reconciliation (markProviderMissingTask). Returns true when a
 * live row was marked.
 */
export function markProviderTaskRemoved(
  userId: number,
  provider: TaskProvider,
  externalId: string,
  tenantId = userId,
): boolean {
  if (!externalId) return false;
  const db = getDb();
  const probe = { provider, externalId } as NormalizedTask;
  let row: ExistingTaskRow | undefined = findRowByActiveLink(db, tenantId, userId, probe);
  if (!row) {
    row = db.prepare(
      `SELECT id, content_hash, sync_state, nexus_task_id, is_deleted, provider_data
       FROM unified_tasks
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?`,
    ).get(userId, tenantId, provider, externalId) as ExistingTaskRow | undefined;
  }
  if (!row || row.is_deleted === 1) return false;
  markProviderMissingTask({
    tenantId,
    userId,
    provider,
    row: { id: row.id, nexus_task_id: row.nexus_task_id, sync_state: row.sync_state },
  });
  return true;
}

/**
 * M6 list-scoped absence reconciliation. After a delta 410/token-expiry
 * resync, the returned rows are the COMPLETE current set for the resynced
 * lists only — so absence marking must be scoped to those containers, never
 * account-global. Candidate membership mirrors softDeleteMissing (provider
 * column rows plus canonical-link rows) restricted to the given provider
 * list/container ids via provider_data.listId and links.provider_list_id.
 */
export function softDeleteMissingForLists(
  userId: number,
  provider: TaskProvider,
  listIds: string[],
  currentExternalIds: string[],
  tenantId = userId,
): number {
  if (listIds.length === 0) return 0;
  const db = getDb();
  const listPlaceholders = listIds.map(() => '?').join(', ');

  const providerRows = db.prepare(
    `SELECT id, external_id, nexus_task_id, sync_state
     FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND is_deleted = 0
       AND json_extract(provider_data, '$.listId') IN (${listPlaceholders})`,
  ).all(userId, tenantId, provider, ...listIds) as Array<{
    id: number;
    external_id: string;
    nexus_task_id: string | null;
    sync_state: string | null;
  }>;

  const linkProvider = providerLinkProvider(provider);
  const linkedRows = linkProvider && linkProvider !== 'nexus_local'
    ? db.prepare(
      `SELECT t.id, l.provider_task_id AS external_id, t.nexus_task_id, t.sync_state
       FROM task_provider_links l
       JOIN unified_tasks t
         ON t.nexus_task_id = l.task_id
        AND t.user_id = l.user_id
        AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
       WHERE l.user_id = ? AND COALESCE(l.tenant_id, l.user_id) = ?
         AND l.provider = ? AND l.provider_task_id IS NOT NULL
         AND l.link_state NOT IN ('orphaned')
         AND l.provider_list_id IN (${listPlaceholders})
         AND t.is_deleted = 0`,
    ).all(userId, tenantId, linkProvider, ...listIds) as Array<{
      id: number;
      external_id: string;
      nexus_task_id: string | null;
      sync_state: string | null;
    }>
    : [];

  const seen = new Set(currentExternalIds);
  const seenRowIds = new Set<number>();
  let totalMarked = 0;
  for (const row of [...providerRows, ...linkedRows]) {
    if (seenRowIds.has(row.id)) continue;
    seenRowIds.add(row.id);
    if (seen.has(row.external_id)) continue;
    markProviderMissingTask({ tenantId, userId, provider, row });
    totalMarked += 1;
  }
  return totalMarked;
}

/**
 * M6 list `@removed` soft-handling: the provider deleted an entire list. The
 * local project row (and its container mappings) is removed so GET /lists
 * stops showing it, while its tasks are kept locally and flagged through the
 * same per-task provider_missing/conflict tombstone path the full pull uses —
 * "Nexus kept the local copy" semantics, consistent with softDeleteMissing.
 */
export function removeProviderProject(
  userId: number,
  provider: TaskProvider,
  externalId: string,
  tenantId = userId,
): { projectRemoved: boolean; tasksMarked: number } {
  if (!externalId) return { projectRemoved: false, tasksMarked: 0 };
  const db = getDb();
  const projectRow = db.prepare(
    `SELECT id FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?
     LIMIT 1`,
  ).get(userId, tenantId, provider, externalId) as { id: number } | undefined;

  const candidateRows = db.prepare(
    `SELECT id, external_id, nexus_task_id, sync_state
     FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND is_deleted = 0
       AND (
         (provider = ? AND json_extract(provider_data, '$.listId') = ?)
         OR (? IS NOT NULL AND project_id = ?)
       )`,
  ).all(userId, tenantId, provider, externalId, projectRow?.id ?? null, projectRow?.id ?? null) as Array<{
    id: number;
    external_id: string;
    nexus_task_id: string | null;
    sync_state: string | null;
  }>;

  const linkProvider = providerLinkProvider(provider);
  const linkedRows = linkProvider && linkProvider !== 'nexus_local'
    ? db.prepare(
      `SELECT t.id, l.provider_task_id AS external_id, t.nexus_task_id, t.sync_state
       FROM task_provider_links l
       JOIN unified_tasks t
         ON t.nexus_task_id = l.task_id
        AND t.user_id = l.user_id
        AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
       WHERE l.user_id = ? AND COALESCE(l.tenant_id, l.user_id) = ?
         AND l.provider = ? AND l.provider_list_id = ?
         AND l.link_state NOT IN ('orphaned')
         AND t.is_deleted = 0`,
    ).all(userId, tenantId, linkProvider, externalId) as Array<{
      id: number;
      external_id: string;
      nexus_task_id: string | null;
      sync_state: string | null;
    }>
    : [];

  const seenRowIds = new Set<number>();
  let tasksMarked = 0;
  for (const row of [...candidateRows, ...linkedRows]) {
    if (seenRowIds.has(row.id)) continue;
    seenRowIds.add(row.id);
    markProviderMissingTask({ tenantId, userId, provider, row });
    tasksMarked += 1;
  }

  db.prepare(
    `DELETE FROM task_container_mappings
     WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_container_id = ?`,
  ).run(tenantId, userId, provider === 'nexus' ? 'nexus_local' : provider, externalId);
  if (projectRow) {
    db.prepare('DELETE FROM unified_projects WHERE id = ?').run(projectRow.id);
  }
  return { projectRemoved: !!projectRow, tasksMarked };
}

// ─── Reads ─────────────────────────────────────────────────────────────

export function getTaskById(taskId: number): NormalizedTask | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(taskId) as
    | UnifiedTaskRow
    | undefined;
  return row ? rowToTask(row) : null;
}

export function getTaskByIdForUser(userId: number, taskId: number, tenantId = userId): NormalizedTask | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE id = ? AND user_id = ? AND COALESCE(tenant_id, user_id) = ? AND is_deleted = 0`,
  ).get(taskId, userId, tenantId) as
    | UnifiedTaskRow
    | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * Get the full task row including the user_id (used by task-service for
 * authorization checks before writing back to a provider).
 */
export function getTaskWithUserId(taskId: number): { task: NormalizedTask; userId: number } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(taskId) as
    | UnifiedTaskRow
    | undefined;
  if (!row) return null;
  return { task: rowToTask(row), userId: row.user_id };
}

export function getPendingTasks(userId: number, tenantId = userId): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND status = 'pending' AND is_deleted = 0
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC`,
  ).all(userId, tenantId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getOverdueTasks(userId: number, tenantId = userId): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND COALESCE(tenant_id, user_id) = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND due_date IS NOT NULL
       AND date(due_date) < date('now')
     ORDER BY due_date ASC`,
  ).all(userId, tenantId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getTasksDueToday(userId: number, tenantId = userId): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND COALESCE(tenant_id, user_id) = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND date(due_date) = date('now')
     ORDER BY priority DESC, due_date ASC`,
  ).all(userId, tenantId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getTasksDueThisWeek(userId: number, tenantId = userId): NormalizedTask[] {
  const db = getDb();
  // SQLite's `date('now', 'weekday 0', '+7 days')` gives next Sunday — close
  // enough to "this week" for the briefing context.
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND COALESCE(tenant_id, user_id) = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND due_date IS NOT NULL
       AND date(due_date) >= date('now')
       AND date(due_date) <= date('now', '+7 days')
     ORDER BY due_date ASC, priority DESC`,
  ).all(userId, tenantId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export interface TaskFilters {
  status?: NormalizedStatus;
  provider?: TaskProvider;
  projectName?: string;
  includeDeleted?: boolean;
}

/** Generic query — used by the high-level service when no special view fits. */
export function getAllTasks(userId: number, filters?: TaskFilters, tenantId = userId): NormalizedTask[] {
  const db = getDb();
  const where: string[] = ['user_id = ?', 'COALESCE(tenant_id, user_id) = ?'];
  const args: unknown[] = [userId, tenantId];

  if (!filters?.includeDeleted) where.push('is_deleted = 0');
  if (filters?.status) {
    where.push('status = ?');
    args.push(filters.status);
  }
  if (filters?.provider) {
    where.push('provider = ?');
    args.push(filters.provider);
  }
  if (filters?.projectName) {
    where.push('project_name = ?');
    args.push(filters.projectName);
  }

  const rows = db.prepare(
    `SELECT * FROM unified_tasks WHERE ${where.join(' AND ')}
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC`,
  ).all(...args) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getProjects(userId: number, tenantId = userId): NormalizedProject[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
     ORDER BY name ASC`,
  ).all(userId, tenantId) as UnifiedProjectRow[];
  return rows.map(rowToProject);
}

// ─── Mutations on local store (no provider involvement) ───────────────

/** Mark a task complete in the local store only. */
export function markTaskCompleted(taskId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE unified_tasks SET
       status = 'completed', completed_at = datetime('now'),
       updated_at = datetime('now'), content_hash = NULL
     WHERE id = ?`,
  ).run(taskId);
}

/** Soft-delete a task in the local store only. */
export function markTaskDeleted(taskId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE unified_tasks SET
       is_deleted = 1,
       deleted_at = datetime('now'),
       sync_state = 'deleted_pending_sync',
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(taskId);
}

// ─── User preferences ─────────────────────────────────────────────────

export function getDefaultProvider(userId: number): TaskProvider {
  const db = getDb();
  const row = db.prepare(
    'SELECT default_provider FROM user_task_preferences WHERE user_id = ?',
  ).get(userId) as { default_provider: TaskProvider } | undefined;
  return row?.default_provider || 'nexus';
}

export function setDefaultProvider(userId: number, provider: TaskProvider): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO user_task_preferences (user_id, default_provider, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       default_provider = excluded.default_provider,
       updated_at = excluded.updated_at`,
  ).run(userId, provider);
}

export function isSyncEnabled(userId: number): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT sync_enabled FROM user_task_preferences WHERE user_id = ?',
  ).get(userId) as { sync_enabled: number } | undefined;
  // Default to enabled if no preference row exists yet
  return row ? row.sync_enabled === 1 : true;
}

// ─── Sync state ────────────────────────────────────────────────────────

export function getSyncState(userId: number, provider: TaskProvider): SyncStateRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM task_sync_state WHERE user_id = ? AND provider = ?',
  ).get(userId, provider) as SyncStateRow | undefined;
  return row || null;
}

export function updateSyncStatus(
  userId: number,
  provider: TaskProvider,
  status: 'idle' | 'syncing' | 'error',
  errorMessage?: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO task_sync_state (user_id, provider, status, error_message)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       status = excluded.status,
       error_message = excluded.error_message`,
  ).run(userId, provider, status, errorMessage ?? null);
}

export function saveSyncState(
  userId: number,
  provider: TaskProvider,
  fields: {
    lastSyncAt?: string;
    syncCursor?: string | null;
    status: 'idle' | 'syncing' | 'error';
    tasksSynced?: number;
    durationMs?: number;
    errorMessage?: string;
  },
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO task_sync_state (
       user_id, provider, last_sync_at, sync_cursor, status,
       tasks_synced, sync_duration_ms, error_message
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       last_sync_at     = excluded.last_sync_at,
       sync_cursor      = excluded.sync_cursor,
       status           = excluded.status,
       tasks_synced     = excluded.tasks_synced,
       sync_duration_ms = excluded.sync_duration_ms,
       error_message    = excluded.error_message`,
  ).run(
    userId,
    provider,
    fields.lastSyncAt ?? null,
    fields.syncCursor ?? null,
    fields.status,
    fields.tasksSynced ?? 0,
    fields.durationMs ?? null,
    fields.errorMessage ?? null,
  );
}

// ─── Aggregate stats (for portal + context engine) ────────────────────

export interface TaskStoreStats {
  totalPending: number;
  totalOverdue: number;
  totalDueToday: number;
  totalDueThisWeek: number;
  byProvider: Record<string, number>;
}

export function getTaskStats(userId: number, tenantId = userId): TaskStoreStats {
  const db = getDb();
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 THEN 1 ELSE 0 END) AS total_pending,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) < date('now') THEN 1 ELSE 0 END) AS total_overdue,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) = date('now') THEN 1 ELSE 0 END) AS total_today,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) >= date('now') AND date(due_date) <= date('now', '+7 days') THEN 1 ELSE 0 END) AS total_week
     FROM unified_tasks WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?`,
  ).get(userId, tenantId) as {
    total_pending: number | null;
    total_overdue: number | null;
    total_today: number | null;
    total_week: number | null;
  };

  const byProviderRows = db.prepare(
    `SELECT provider, COUNT(*) AS cnt
     FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND status = 'pending' AND is_deleted = 0
     GROUP BY provider`,
  ).all(userId, tenantId) as { provider: string; cnt: number }[];

  const byProvider: Record<string, number> = {};
  for (const r of byProviderRows) byProvider[r.provider] = r.cnt;

  return {
    totalPending: counts.total_pending || 0,
    totalOverdue: counts.total_overdue || 0,
    totalDueToday: counts.total_today || 0,
    totalDueThisWeek: counts.total_week || 0,
    byProvider,
  };
}

/** Test-only utility: nuke all task store data (used by vitest setup). */
export function _resetForTests(): void {
  try {
    const db = getDb();
    db.exec(`
      DELETE FROM unified_tasks;
      DELETE FROM unified_projects;
      DELETE FROM task_sync_state;
      DELETE FROM task_provider_links;
      DELETE FROM task_mutations;
      DELETE FROM task_container_mappings;
      DELETE FROM task_sync_issues;
      DELETE FROM user_task_preferences;
      DELETE FROM daily_context_cache;
    `);
  } catch (err) {
    logger.warn({ err }, '_resetForTests failed');
  }
}
