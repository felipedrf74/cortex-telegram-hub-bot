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
import { recordTaskSyncIssue } from './task-sync-issues';

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

function stableNexusListExternalId(tenantId: number, userId: number, name: string): string {
  const normalized = String(name || 'Inbox').trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(`${tenantId}:${userId}:${normalized}`).digest('hex').slice(0, 16);
  return `nexus_list_${hash}`;
}

function isMappedTaskProvider(provider: TaskProvider): provider is 'ms_todo' {
  return provider === 'ms_todo';
}

function defaultNexusListFlag(name: string): number {
  return /^inbox|tasks|tarefas$/i.test(name) ? 1 : 0;
}

function ensureTaskContainerMappingForProviderProject(userId: number, tenantId: number, project: NormalizedProject): void {
  if (!isMappedTaskProvider(project.provider)) return;
  const normalizedName = String(project.name || '').trim() || 'Inbox';
  const db = getDb();

  let nexusProject = db.prepare(
    `SELECT id
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus'
       AND lower(name) = lower(?)
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
  ).get(userId, tenantId, normalizedName) as { id: number } | undefined;

  if (!nexusProject) {
    const externalId = stableNexusListExternalId(tenantId, userId, normalizedName);
    db.prepare(
      `INSERT INTO unified_projects (
         user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
       ) VALUES (?, ?, 'nexus', ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(user_id, provider, external_id) DO UPDATE SET
         tenant_id = COALESCE(unified_projects.tenant_id, excluded.tenant_id),
         name = excluded.name,
         synced_at = datetime('now')`,
    ).run(userId, tenantId, externalId, normalizedName, defaultNexusListFlag(normalizedName));

    nexusProject = db.prepare(
      `SELECT id
       FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus'
         AND external_id = ?
       LIMIT 1`,
    ).get(userId, tenantId, externalId) as { id: number } | undefined;
  }

  if (!nexusProject) return;

  const providerContainerType = project.provider === 'ms_todo' ? 'todo_list' : 'project';
  db.prepare(
    `INSERT INTO task_container_mappings (
       id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
       provider_container_id, sync_direction
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bidirectional')
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
    String(nexusProject.id),
    project.provider,
    providerContainerType,
    project.externalId,
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

function ensureProviderLinkForTask(tenantId: number, userId: number, task: NormalizedTask, nexusTaskId: string): void {
  const provider = providerLinkProvider(task.provider);
  if (!provider) return;

  const containerId = providerContainerId(task);
  getDb().prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id,
       provider_version, provider_updated_at, last_synced_at, last_verified_at,
       ownership, link_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, 'linked')
     ON CONFLICT(tenant_id, user_id, provider, provider_account_id, provider_task_id)
     DO UPDATE SET
       task_id = excluded.task_id,
       provider_list_id = COALESCE(excluded.provider_list_id, task_provider_links.provider_list_id),
       provider_project_id = COALESCE(excluded.provider_project_id, task_provider_links.provider_project_id),
       provider_updated_at = COALESCE(excluded.provider_updated_at, task_provider_links.provider_updated_at),
       last_synced_at = datetime('now'),
       last_verified_at = COALESCE(task_provider_links.last_verified_at, datetime('now')),
       link_state = CASE
         WHEN task_provider_links.link_state IN ('conflict', 'provider_missing') THEN task_provider_links.link_state
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
  );
}

function hasPendingLocalMutation(syncState: string | null | undefined): boolean {
  return [
    'queued',
    'syncing',
    'failed_retryable',
    'conflict',
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
export function upsertTask(userId: number, task: NormalizedTask, tenantId = userId): UpsertResult {
  const db = getDb();
  const hash = computeContentHash(task);
  const nexusTaskId = stableNexusTaskId(tenantId, userId, task);

  const existing = db.prepare(
    `SELECT id, content_hash, sync_state, nexus_task_id
     FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?`,
  ).get(userId, tenantId, task.provider, task.externalId) as
    | { id: number; content_hash: string; sync_state: string | null; nexus_task_id: string | null }
    | undefined;

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
    return 'unchanged';
  }

  if (hasPendingLocalMutation(existing.sync_state)) {
    ensureProviderLinkForTask(tenantId, userId, task, existingNexusTaskId);
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

  const seen = new Set(currentExternalIds);
  const stale = currentExternalIds.length === 0
    ? allRows
    : allRows.filter((r) => !seen.has(r.external_id));

  for (const row of stale) {
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
