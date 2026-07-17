// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from '../database';
import { getUserTimezoneById } from '../user-service';
import { resolveTaskProvider, type TaskProviderType } from './task-router';
import { getOpenTaskSyncWarningsForTasks, recordTaskSyncIssue } from './task-sync-issues';
import { resolveTaskSyncTarget } from './task-sync-policy';
import { triggerTaskMutationKick } from './task-mutation-kick';

export type TaskSyncState =
  | 'local_only'
  | 'queued'
  | 'syncing'
  | 'synced'
  | 'partially_synced'
  | 'conflict'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'provider_disconnected'
  | 'provider_missing'
  | 'stale'
  | 'deleted_pending_sync';

export type TaskSyncWarningCode =
  | 'provider_disconnected'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'unsupported_field_local_only'
  | 'provider_conflict'
  | 'provider_task_missing'
  | 'provider_auth_expired'
  | 'provider_list_missing'
  | 'provider_project_missing'
  | 'retry_scheduled'
  | 'manual_resolution_required'
  // M6 create-retry guard: multiple provider tasks carry one Nexus marker —
  // the push is parked so no runner can mint a third twin.
  | 'suspected_duplicate';

export interface TaskSyncWarning {
  code: TaskSyncWarningCode;
  message: string;
  provider?: string;
  field?: string;
}

export interface OfflineTaskDto {
  id: string;
  title: string;
  body: string | null;
  importance: 'low' | 'normal' | 'high';
  status: string;
  dueDateTime: string | null;
  recurrence: unknown | null;
  listId: string | null;
  listName: string | null;
  checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }> | null;
  createdDateTime: string | null;
  syncProvider: string;
  syncState: TaskSyncState;
  syncWarnings: TaskSyncWarning[];
  localVersion: number;
  deletedAt: string | null;
}

export interface TaskFreshness {
  generatedAt: string;
  state: 'fresh' | 'stale' | 'offline' | 'degraded' | 'empty';
  reasonCodes: string[];
  providerStates: Array<{
    provider: 'ms_todo' | 'todoist';
    state: 'connected' | 'disconnected' | 'syncing' | 'failed' | 'stale';
    lastSyncedAt?: string;
    lastErrorCode?: string;
  }>;
}

export interface TaskMutationInput {
  title: string;
  listName?: string;
  dueDateTime?: string;
  importance?: string;
  body?: string;
  recurrence?: unknown;
  idempotencyKey?: string;
  clientMutationId?: string;
}

export interface TaskUpdateMutationInput {
  taskId: string;
  title?: string;
  dueDateTime?: string | null;
  importance?: string;
  body?: string | null;
  status?: string;
  recurrence?: unknown;
  idempotencyKey?: string;
  clientMutationId?: string;
  /** Optional client OCC (NEX-24): the local_version the client last saw. */
  baseLocalVersion?: number;
}

export interface TaskMoveMutationInput {
  taskId: string;
  targetListId: string;
  idempotencyKey?: string;
  clientMutationId?: string;
  /** Optional client OCC (NEX-24): the local_version the client last saw. */
  baseLocalVersion?: number;
}

export interface TaskChecklistMutationInput {
  taskId: string;
  itemId?: string;
  displayName?: string;
  isChecked?: boolean;
  idempotencyKey?: string;
  clientMutationId?: string;
}

export interface TaskAssignProviderMutationInput {
  taskId: string;
  provider: TaskProviderType;
  idempotencyKey?: string;
  clientMutationId?: string;
}

export interface TaskRetrySyncMutationInput {
  taskId: string;
  idempotencyKey?: string;
  clientMutationId?: string;
}

type UnifiedTaskRow = {
  id: number;
  user_id: number;
  tenant_id: number | null;
  provider: string;
  external_id: string;
  project_id: number | null;
  project_name: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  due_date: string | null;
  due_is_datetime: number | null;
  tags: string | null;
  notes: string | null;
  completed_at: string | null;
  provider_data: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  nexus_task_id: string | null;
  local_version: number | null;
  sync_state: TaskSyncState | null;
  deleted_at: string | null;
  change_seq?: string | null;
};

type ProjectRow = {
  id: number;
  user_id: number;
  tenant_id: number | null;
  provider: string;
  external_id: string;
  name: string;
  is_default?: number | null;
  task_count: number | null;
};

type MutationRow = {
  mutation_id: string;
  client_mutation_id: string;
  idempotency_key: string;
  tenant_id: number;
  user_id: number;
  task_id: string | null;
  operation: string;
  patch_json: string;
  status: string;
  created_at: string;
};

type ChecklistItemDto = { id: string; displayName: string; isChecked: boolean };
type TaskProviderLinkProvider = 'ms_todo' | 'todoist' | 'nexus_local';

type TaskProviderLinkRow = {
  id: string;
  task_id: string;
  tenant_id: number;
  user_id: number;
  provider: TaskProviderLinkProvider;
  provider_account_id: string;
  provider_task_id: string | null;
  provider_list_id: string | null;
  provider_project_id: string | null;
  provider_version: string | null;
  provider_updated_at: string | null;
  last_synced_at: string | null;
  last_verified_at: string | null;
  ownership: 'nexus_created' | 'provider_imported' | 'linked';
  link_state: string;
};

type NativeTaskListRow = {
  id: number;
  user_id: number;
  name: string;
  is_default: number | null;
  color: string | null;
  position: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type NativeTaskRow = {
  id: number;
  user_id: number;
  list_id: number;
  title: string;
  body: string | null;
  importance: string | null;
  status: string | null;
  due_date_time: string | null;
  recurrence: string | null;
  tags: string | null;
  position: number | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
};

type NativeChecklistRow = {
  id: number;
  task_id: number;
  display_name: string;
  is_checked: number | null;
};

/**
 * M6 task.delete undo holdback: deletes are journaled with
 * available_at = now + 10s (≥ the 5s client undo window) so an undo can
 * retire the mutation before ANY runner — cron, kick, or force-sync — ships
 * the provider hard-delete. The gate lives in the worker's readyMutations SQL.
 */
const TASK_DELETE_HOLDBACK_MS = 10_000;

function taskDeleteAvailableAt(): string {
  return new Date(Date.now() + TASK_DELETE_HOLDBACK_MS).toISOString();
}

/**
 * M6 push-kick: best-effort debounced provider push after a ledger write.
 * Only fires when the journaled mutation actually targets a provider
 * (status 'queued'); task.delete producers never call this — deletes ride
 * the available_at holdback instead. Goes through the zero-dependency kick
 * registry (the worker registers itself at load), so this module's import
 * graph stays untouched and un-journaled providers cost nothing.
 */
function kickAfterJournal(tenantId: number, userId: number, mutationStatus: string | null | undefined): void {
  if (mutationStatus !== 'queued') return;
  triggerTaskMutationKick(tenantId, userId);
}

function assertScope(tenantId: number, userId: number): void {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('tenantId required');
  }
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('userId required');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const sqliteUtc = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(sqliteUtc) ? 0 : sqliteUtc;
}

function effectiveChangeTimestamp(row: Pick<UnifiedTaskRow, 'deleted_at' | 'updated_at' | 'created_at' | 'change_seq'>): string {
  return row.change_seq || row.deleted_at || row.updated_at || row.created_at || '';
}

function encodeTaskChangesCursor(timestamp: string, taskId: string): string {
  if (!timestamp) return '';
  return `${timestamp}|${taskId || ''}`;
}

function decodeTaskChangesCursor(cursor: string): { timestamp: string; taskId: string } {
  const trimmed = String(cursor || '').trim();
  if (!trimmed) return { timestamp: '', taskId: '' };
  const separator = trimmed.lastIndexOf('|');
  if (separator === -1) return { timestamp: '', taskId: '' };
  return {
    timestamp: trimmed.slice(0, separator),
    taskId: trimmed.slice(separator + 1),
  };
}

function unifiedTasksHasChangeSeqColumn(): boolean {
  try {
    const rows = getDb().prepare(`PRAGMA table_info(unified_tasks)`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === 'change_seq');
  } catch {
    return false;
  }
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function recordTaskSyncObservabilityEvent(input: {
  tenantId: number;
  userId: number;
  taskId?: string | null;
  provider?: string | null;
  eventType: 'duplicate_prevention_hit';
  operation?: string;
  details?: Record<string, unknown>;
}): void {
  try {
    getDb().prepare(
      `INSERT INTO task_sync_observability_events (
         id, tenant_id, user_id, task_id, provider, event_type, operation, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomId('task_sync_event'),
      input.tenantId,
      input.userId,
      input.taskId || null,
      input.provider || null,
      input.eventType,
      input.operation || null,
      JSON.stringify(input.details || {}),
    );
  } catch {
    // Observability must not block idempotent mutation replay.
  }
}

function recordDuplicatePreventionHit(
  tenantId: number,
  userId: number,
  mutation: MutationRow,
): void {
  recordTaskSyncObservabilityEvent({
    tenantId,
    userId,
    taskId: mutation.task_id,
    eventType: 'duplicate_prevention_hit',
    operation: mutation.operation,
    details: {
      mutationId: mutation.mutation_id,
      clientMutationId: mutation.client_mutation_id,
      idempotencyKey: mutation.idempotency_key,
    },
  });
}

function stableListExternalId(tenantId: number, userId: number, name: string): string {
  const normalized = String(name || 'Inbox').trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(`${tenantId}:${userId}:${normalized}`).digest('hex').slice(0, 16);
  return `nexus_list_${hash}`;
}

function normalizeAssignableProvider(value: unknown): TaskProviderType | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'microsoft_todo') return 'ms_todo';
  if (normalized === 'ms_todo' || normalized === 'todoist' || normalized === 'nexus') {
    return normalized;
  }
  return null;
}

function providerLinkProvider(provider: TaskProviderType): TaskProviderLinkProvider {
  return provider === 'nexus' ? 'nexus_local' : provider;
}

function priorityToDb(value: unknown): number {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'urgent') return 4;
  if (normalized === 'high') return 3;
  if (normalized === 'medium') return 2;
  if (normalized === 'low') return 1;
  return 0;
}

function priorityToImportance(value: unknown): 'low' | 'normal' | 'high' {
  const priority = typeof value === 'number' ? value : Number(value || 0);
  if (priority >= 3) return 'high';
  if (priority === 1) return 'low';
  return 'normal';
}

function dtoStatus(value: string | null | undefined): string {
  switch (String(value || '').trim().toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
      return 'inProgress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'notStarted';
  }
}

function dbStatusForOperation(operation: string): string {
  switch (operation) {
    case 'task.complete':
      return 'completed';
    case 'task.reopen':
      return 'pending';
    case 'task.delete':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function dbStatusForValue(value: unknown, fallback: string): string {
  switch (String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'archived':
      return 'archived';
    default:
      return fallback || 'pending';
  }
}

const COMPLETED_LIKE_STATUS_VALUES = ['completed', 'complete', 'done', 'cancelled', 'canceled'];

function normalizedStatusSql(column: string): string {
  return `lower(replace(replace(coalesce(${column}, ''), '_', ''), '-', ''))`;
}

function completedLikeStatusSql(column: string): string {
  return `${normalizedStatusSql(column)} IN (${COMPLETED_LIKE_STATUS_VALUES.map(() => '?').join(', ')})`;
}

function activeLikeStatusSql(column: string): string {
  return `${normalizedStatusSql(column)} NOT IN (${COMPLETED_LIKE_STATUS_VALUES.map(() => '?').join(', ')})`;
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeChecklistItems(value: unknown): ChecklistItemDto[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const id = String(record.id || record.itemId || '').trim();
      const displayName = String(record.displayName || record.title || record.name || '').trim();
      if (!id || !displayName) return null;
      return {
        id,
        displayName,
        isChecked: Boolean(record.isChecked ?? record.checked ?? record.completed),
      };
    })
    .filter((item): item is ChecklistItemDto => item != null);
}

function dbTableExists(tableName: string): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 AS ok
       FROM sqlite_master
       WHERE type = 'table' AND name = ?
       LIMIT 1`,
    ).get(tableName) as { ok: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function legacyNativeTaskTablesAvailable(): boolean {
  return dbTableExists('native_task_lists') && dbTableExists('native_tasks');
}

function nativeTaskExternalId(id: number): string {
  return `native_task_${id}`;
}

function nativeTaskNexusId(id: number): string {
  return `task_native_${id}`;
}

function nativeListExternalId(id: number): string {
  return `native_list_${id}`;
}

function nativeStatusToDb(value: string | null | undefined): string {
  switch (String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'inprogress':
    case 'active':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function nativePriorityToDb(value: string | null | undefined): number {
  switch (String(value || '').trim().toLowerCase()) {
    case 'high':
    case 'important':
      return 3;
    case 'normal':
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function nativeChecklistItemsForTasks(userId: number, taskIds: number[]): Map<number, ChecklistItemDto[]> {
  const byTask = new Map<number, ChecklistItemDto[]>();
  const validIds = taskIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (validIds.length === 0 || !dbTableExists('native_task_checklist_items')) return byTask;

  const placeholders = validIds.map(() => '?').join(', ');
  const rows = getDb().prepare(
    `SELECT id, task_id, display_name, is_checked
     FROM native_task_checklist_items
     WHERE user_id = ? AND task_id IN (${placeholders})
     ORDER BY task_id ASC, position ASC, id ASC`,
  ).all(userId, ...validIds) as NativeChecklistRow[];

  for (const row of rows) {
    const taskId = Number(row.task_id);
    const items = byTask.get(taskId) || [];
    items.push({
      id: String(row.id),
      displayName: row.display_name,
      isChecked: !!row.is_checked,
    });
    byTask.set(taskId, items);
  }
  return byTask;
}

function nativeTaskProviderData(row: NativeTaskRow, checklistItems: ChecklistItemDto[]): Record<string, unknown> {
  return {
    source: 'native_tasks_backfill',
    nativeTaskId: row.id,
    nativeListId: row.list_id,
    recurrence: safeJsonParse(row.recurrence, null),
    checklistItems,
  };
}

function resolveBackfillProject(tenantId: number, userId: number, list: NativeTaskListRow): ProjectRow {
  const db = getDb();
  const normalizedName = String(list.name || '').trim() || 'Inbox';
  const existingByName = db.prepare(
    `SELECT *
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus'
       AND lower(name) = lower(?)
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
  ).get(userId, tenantId, normalizedName) as ProjectRow | undefined;
  if (existingByName) return existingByName;

  const externalId = nativeListExternalId(list.id);
  db.prepare(
    `INSERT INTO unified_projects (
       user_id, tenant_id, provider, external_id, name, color, is_default, task_count, synced_at
     ) VALUES (?, ?, 'nexus', ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(user_id, provider, external_id) DO UPDATE SET
       tenant_id = COALESCE(unified_projects.tenant_id, excluded.tenant_id),
       name = excluded.name,
       color = excluded.color,
       is_default = excluded.is_default,
       synced_at = datetime('now')`,
  ).run(
    userId,
    tenantId,
    externalId,
    normalizedName,
    list.color || null,
    list.is_default ? 1 : 0,
  );

  return db.prepare(
    `SELECT *
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus' AND external_id = ?
     LIMIT 1`,
  ).get(userId, tenantId, externalId) as ProjectRow;
}

function localMutationExistsForTask(tenantId: number, userId: number, taskId: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 AS ok
     FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND task_id = ?
     LIMIT 1`,
  ).get(tenantId, userId, taskId) as { ok: number } | undefined;
  return !!row;
}

function ensureNativeTasksBackfilled(tenantId: number, userId: number): void {
  assertScope(tenantId, userId);
  if (!legacyNativeTaskTablesAvailable()) return;

  const db = getDb();
  const lists = db.prepare(
    `SELECT id, user_id, name, is_default, color, position, created_at, updated_at
     FROM native_task_lists
     WHERE user_id = ?
     ORDER BY is_default DESC, position ASC, id ASC`,
  ).all(userId) as NativeTaskListRow[];
  if (lists.length === 0) return;

  const tasks = db.prepare(
    `SELECT id, user_id, list_id, title, body, importance, status, due_date_time,
            recurrence, tags, position, created_at, updated_at, completed_at
     FROM native_tasks
     WHERE user_id = ?
     ORDER BY position ASC, created_at DESC, id ASC`,
  ).all(userId) as NativeTaskRow[];
  const checklistByTask = nativeChecklistItemsForTasks(userId, tasks.map((task) => Number(task.id)));

  db.transaction(() => {
    const projectByNativeListId = new Map<number, ProjectRow>();
    for (const list of lists) {
      projectByNativeListId.set(list.id, resolveBackfillProject(tenantId, userId, list));
    }

    for (const task of tasks) {
      const project = projectByNativeListId.get(task.list_id);
      if (!project) continue;
      const taskId = nativeTaskNexusId(task.id);
      if (localMutationExistsForTask(tenantId, userId, taskId)) continue;

      const externalId = nativeTaskExternalId(task.id);
      const dueDate = task.due_date_time || null;
      const providerData = nativeTaskProviderData(task, checklistByTask.get(task.id) || []);
      db.prepare(
        `INSERT INTO unified_tasks (
           user_id, tenant_id, provider, external_id, project_id, project_name,
           title, description, status, priority, due_date, due_is_datetime,
           tags, notes, completed_at, provider_data, content_hash, is_deleted,
           synced_at, created_at, updated_at, nexus_task_id, local_version,
           sync_state, source_of_truth
         ) VALUES (?, ?, 'nexus', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0,
           datetime('now'), ?, ?, ?, 1, 'local_only', 'native_legacy')
         ON CONFLICT(user_id, provider, external_id) DO UPDATE SET
           tenant_id = COALESCE(unified_tasks.tenant_id, excluded.tenant_id),
           project_id = excluded.project_id,
           project_name = excluded.project_name,
           title = excluded.title,
           description = excluded.description,
           status = excluded.status,
           priority = excluded.priority,
           due_date = excluded.due_date,
           due_is_datetime = excluded.due_is_datetime,
           tags = excluded.tags,
           notes = excluded.notes,
           completed_at = excluded.completed_at,
           provider_data = excluded.provider_data,
           is_deleted = 0,
           updated_at = excluded.updated_at,
           nexus_task_id = COALESCE(unified_tasks.nexus_task_id, excluded.nexus_task_id),
           sync_state = CASE
             WHEN unified_tasks.sync_state IN ('queued', 'syncing', 'conflict', 'failed_retryable') THEN unified_tasks.sync_state
             ELSE 'local_only'
           END,
           source_of_truth = CASE
             WHEN unified_tasks.source_of_truth = 'native_legacy' THEN 'native_legacy'
             ELSE unified_tasks.source_of_truth
           END
         WHERE NOT EXISTS (
           SELECT 1
           FROM task_mutations m
           WHERE m.tenant_id = excluded.tenant_id
             AND m.user_id = excluded.user_id
             AND m.task_id = excluded.nexus_task_id
         )`,
      ).run(
        userId,
        tenantId,
        externalId,
        project.id,
        project.name,
        String(task.title || '').trim() || '(Untitled)',
        task.body || null,
        nativeStatusToDb(task.status),
        nativePriorityToDb(task.importance),
        dueDate,
        dueDate && String(dueDate).includes('T') ? 1 : 0,
        task.tags || '[]',
        task.body || null,
        task.completed_at || null,
        JSON.stringify(providerData),
        task.created_at || nowIso(),
        task.updated_at || task.created_at || nowIso(),
        taskId,
      );
    }
  })();
}

function warningForState(syncState: TaskSyncState, provider?: string): TaskSyncWarning[] {
  switch (syncState) {
    case 'provider_disconnected':
      return [{ code: 'provider_disconnected', provider, message: 'Saved locally. Sync resumes when the provider reconnects.' }];
    case 'failed_retryable':
      return [{ code: 'retry_scheduled', provider, message: 'Provider sync failed. Retry scheduled.' }];
    case 'failed_permanent':
      return [{ code: 'manual_resolution_required', provider, message: 'Provider cannot accept this task without user action.' }];
    case 'conflict':
      return [{ code: 'provider_conflict', provider, message: 'This task changed in Nexus and the provider. Review required.' }];
    case 'provider_missing':
      return [{ code: 'provider_task_missing', provider, message: 'Provider no longer has this task.' }];
    case 'partially_synced':
      return [{ code: 'unsupported_field_local_only', provider, message: 'Some task details are local-only for this provider.' }];
    case 'queued':
      return [{ code: 'retry_scheduled', provider, message: 'Queued for provider sync.' }];
    default:
      return [];
  }
}

function rowTaskId(row: UnifiedTaskRow): string {
  return row.nexus_task_id || `task_legacy_${row.id}`;
}

function latestTaskChangesCursor(rows: UnifiedTaskRow[], fallback = ''): string {
  let latestTimestamp = '';
  let latestTaskId = '';
  for (const row of rows) {
    const timestamp = effectiveChangeTimestamp(row);
    const taskId = rowTaskId(row);
    const timestampDelta = timestampMs(timestamp) - timestampMs(latestTimestamp);
    if (timestampDelta > 0 || (timestampDelta === 0 && taskId > latestTaskId)) {
      latestTimestamp = timestamp;
      latestTaskId = taskId;
    }
  }
  return latestTimestamp ? encodeTaskChangesCursor(latestTimestamp, latestTaskId) : fallback;
}

function rowToDto(
  row: UnifiedTaskRow,
  listNameById: Map<number, string>,
  issueMap?: Map<string, TaskSyncWarning[]>,
  linkProviderMap?: Map<string, string>,
): OfflineTaskDto {
  const providerData = safeJsonParse<Record<string, unknown>>(row.provider_data, {});
  const syncState = row.sync_state || (row.provider === 'nexus' ? 'local_only' : 'synced');
  const listName = row.project_name || (row.project_id ? listNameById.get(row.project_id) : null) || null;
  const taskId = rowTaskId(row);
  const status = row.is_deleted ? 'cancelled' : dtoStatus(row.status);
  const completed = ['completed', 'cancelled'].includes(status);
  const openIssueWarnings = issueMap?.get(taskId) || [];
  const visibleIssueWarnings = completed
    ? openIssueWarnings.filter((warning) => warning.code !== 'provider_task_missing')
    : openIssueWarnings;
  // syncProvider is the task's sync TARGET, not its origin: deployed clients
  // gate sync copy and checklist editing on it. A Nexus-created task that
  // syncs to Microsoft must report ms_todo from the moment its link exists —
  // the row's provider column stays origin metadata under canonical links.
  const syncProvider = linkProviderMap?.get(taskId) || row.provider || 'nexus';
  return {
    id: taskId,
    title: row.title || '(Untitled)',
    body: row.notes || row.description || null,
    importance: priorityToImportance(row.priority),
    status,
    dueDateTime: row.due_date || null,
    recurrence: providerData.recurrence || null,
    listId: row.project_id != null ? String(row.project_id) : null,
    listName,
    checklistItems: normalizeChecklistItems(providerData.checklistItems),
    createdDateTime: row.created_at || null,
    syncProvider,
    syncState,
    syncWarnings: [
      ...(completed && syncState === 'provider_missing' ? [] : warningForState(syncState, row.provider)),
      ...visibleIssueWarnings,
    ],
    localVersion: row.local_version || 1,
    deletedAt: row.deleted_at || null,
  };
}

function getLinkProviderMap(tenantId: number, userId: number, taskIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = getDb().prepare(
    `SELECT task_id, provider
     FROM task_provider_links
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
       AND provider != 'nexus_local'
       AND link_state NOT IN ('orphaned')
       AND task_id IN (${placeholders})
     ORDER BY updated_at ASC`,
  ).all(userId, tenantId, ...taskIds) as Array<{ task_id: string; provider: string }>;
  for (const row of rows) map.set(row.task_id, row.provider);
  return map;
}

function rowsToDtos(
  tenantId: number,
  userId: number,
  rows: UnifiedTaskRow[],
  listNameById: Map<number, string>,
): OfflineTaskDto[] {
  const taskIds = rows.map(rowTaskId);
  const issueMap = getOpenTaskSyncWarningsForTasks(tenantId, userId, taskIds);
  const linkProviderMap = getLinkProviderMap(tenantId, userId, taskIds);
  return rows.map((row) => rowToDto(row, listNameById, issueMap, linkProviderMap));
}

function getProjectNameMap(tenantId: number, userId: number): Map<number, string> {
  const rows = getDb().prepare(
    `SELECT id, name
     FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?`,
  ).all(userId, tenantId) as Array<{ id: number; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

function getTaskRowByNexusId(tenantId: number, userId: number, taskId: string): UnifiedTaskRow | null {
  const row = getDb().prepare(
    `SELECT * FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?
     LIMIT 1`,
  ).get(tenantId, userId, taskId) as UnifiedTaskRow | undefined;
  return row || null;
}

function getTaskRowByAnyTaskId(tenantId: number, userId: number, taskId: string): UnifiedTaskRow | null {
  let row = getDb().prepare(
    `SELECT t.*
     FROM unified_tasks t
     LEFT JOIN task_provider_links l
       ON l.tenant_id = t.tenant_id
      AND l.user_id = t.user_id
      AND l.task_id = t.nexus_task_id
     WHERE t.tenant_id = ? AND t.user_id = ?
       AND (
         t.nexus_task_id = ?
         OR t.external_id = ?
         OR l.provider_task_id = ?
       )
     ORDER BY
       CASE WHEN t.nexus_task_id = ? THEN 0 ELSE 1 END,
       t.updated_at DESC
     LIMIT 1`,
  ).get(tenantId, userId, taskId, taskId, taskId, taskId) as UnifiedTaskRow | undefined;
  // M5 single-write-path bridge: chat-core-v2 command payloads address
  // unified tasks by their numeric local row id (the deterministic task
  // reads expose exactly that id). Numeric ids resolve AFTER the
  // nexus/external/provider-link matches above so numeric provider external
  // ids (Todoist) keep their existing precedence over row ids.
  if (!row && /^\d+$/.test(taskId)) {
    row = getDb().prepare(
      `SELECT * FROM unified_tasks
       WHERE tenant_id = ? AND user_id = ? AND id = ?
       LIMIT 1`,
    ).get(tenantId, userId, Number(taskId)) as UnifiedTaskRow | undefined;
  }
  if (!row) return null;
  // Twin-repair alias hop: a merged tombstone records its canonical task in
  // provider_data.merged_into, so stale references to the retired twin id
  // resolve to the survivor. Single hop, no recursion — the repair only ever
  // points merged_into at a live canonical task.
  if (row.is_deleted === 1) {
    const mergedInto = safeJsonParse<Record<string, unknown>>(row.provider_data, {}).merged_into;
    if (typeof mergedInto === 'string' && mergedInto && mergedInto !== row.nexus_task_id) {
      const survivor = getTaskRowByNexusId(tenantId, userId, mergedInto);
      if (survivor) return survivor;
    }
  }
  return row;
}

function getProviderLinkForTask(
  tenantId: number,
  userId: number,
  taskId: string,
  provider?: TaskProviderLinkProvider,
): TaskProviderLinkRow | null {
  const where = [
    'tenant_id = ?',
    'user_id = ?',
    'task_id = ?',
  ];
  const args: unknown[] = [tenantId, userId, taskId];
  if (provider) {
    where.push('provider = ?');
    args.push(provider);
  }

  const providerOrder = provider
    ? 'updated_at DESC'
    : "CASE WHEN provider = 'nexus_local' THEN 1 ELSE 0 END ASC, updated_at DESC";
  const row = getDb().prepare(
    `SELECT *
     FROM task_provider_links
     WHERE ${where.join(' AND ')}
     ORDER BY ${providerOrder}
     LIMIT 1`,
  ).get(...args) as TaskProviderLinkRow | undefined;
  return row || null;
}

function upsertProviderLinkForTask(input: {
  id?: string;
  taskId: string;
  tenantId: number;
  userId: number;
  provider: TaskProviderLinkProvider;
  providerAccountId: string;
  providerTaskId?: string | null;
  providerListId?: string | null;
  providerProjectId?: string | null;
  ownership: 'nexus_created' | 'provider_imported' | 'linked';
  linkState: string;
  updatedAt: string;
}): void {
  const db = getDb();
  const existing = input.id
    ? db.prepare(
      `SELECT id
       FROM task_provider_links
       WHERE tenant_id = ? AND user_id = ? AND id = ?
       LIMIT 1`,
    ).get(input.tenantId, input.userId, input.id) as { id: string } | undefined
    : db.prepare(
      `SELECT id
       FROM task_provider_links
       WHERE tenant_id = ? AND user_id = ? AND task_id = ?
         AND provider = ? AND provider_account_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(
      input.tenantId,
      input.userId,
      input.taskId,
      input.provider,
      input.providerAccountId,
    ) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE task_provider_links
       SET provider_task_id = COALESCE(?, provider_task_id),
           provider_list_id = COALESCE(?, provider_list_id),
           provider_project_id = COALESCE(?, provider_project_id),
           ownership = ?,
           link_state = ?,
           updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND id = ?`,
    ).run(
      input.providerTaskId || null,
      input.providerListId || null,
      input.providerProjectId || null,
      input.ownership,
      input.linkState,
      input.updatedAt,
      input.tenantId,
      input.userId,
      existing.id,
    );
    return;
  }

  db.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id,
       ownership, link_state, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomId('task_link'),
    input.taskId,
    input.tenantId,
    input.userId,
    input.provider,
    input.providerAccountId,
    input.providerTaskId || null,
    input.providerListId || null,
    input.providerProjectId || null,
    input.ownership,
    input.linkState,
    input.updatedAt,
  );
}

function getTaskByNexusId(tenantId: number, userId: number, taskId: string): OfflineTaskDto | null {
  const row = getTaskRowByNexusId(tenantId, userId, taskId);
  if (!row) return null;
  return rowsToDtos(tenantId, userId, [row], getProjectNameMap(tenantId, userId))[0] || null;
}

export function resolveOfflineNexusTaskId(tenantId: number, userId: number, taskId: string): string | null {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const row = getTaskRowByAnyTaskId(tenantId, userId, taskId);
  return row ? rowTaskId(row) : null;
}

export function getOfflineTaskById(tenantId: number, userId: number, taskId: string): OfflineTaskDto | null {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const row = getTaskRowByAnyTaskId(tenantId, userId, taskId);
  if (!row) return null;
  return rowsToDtos(tenantId, userId, [row], getProjectNameMap(tenantId, userId))[0] || null;
}

function getOrCreateProject(tenantId: number, userId: number, listName?: string): ProjectRow {
  const db = getDb();
  const normalizedName = String(listName || '').trim() || 'Inbox';
  const existing = db.prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus' AND lower(name) = lower(?)
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
  ).get(userId, tenantId, normalizedName) as ProjectRow | undefined;
  if (existing) return existing;

  const externalId = stableListExternalId(tenantId, userId, normalizedName);
  db.prepare(
    `INSERT INTO unified_projects (
       user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
     ) VALUES (?, ?, 'nexus', ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(user_id, provider, external_id) DO UPDATE SET
       tenant_id = COALESCE(unified_projects.tenant_id, excluded.tenant_id),
       name = excluded.name,
       synced_at = datetime('now')`,
  ).run(userId, tenantId, externalId, normalizedName, /^inbox|tasks|tarefas$/i.test(normalizedName) ? 1 : 0);

  return db.prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = 'nexus' AND external_id = ?`,
  ).get(userId, tenantId, externalId) as ProjectRow;
}

/**
 * Resolve the project a NEW task should live in.
 *
 * Post-de22b1a2 list model: the provider's own project rows are the lists the
 * app shows (mapped nexus mirrors are hidden from /lists), container mappings
 * are keyed by the provider row id, and resolveTaskSyncTarget resolves
 * provider row ids. iOS sends only a listName on create, so resolving that
 * name to the hidden nexus mirror (as getOrCreateProject does) produced a
 * project id no mapping could match — every create into a Microsoft-backed
 * list parked as failed_permanent/provider_list_missing (NEX-05).
 *
 * Prefer the visible provider list matching the name for the user's active
 * sync provider; fall back to the nexus-local list otherwise (local-only
 * users and genuinely local lists are unchanged).
 */
function resolveCreateTargetProject(
  tenantId: number,
  userId: number,
  listName: string | undefined,
  provider: TaskProviderType,
): ProjectRow {
  if (provider === 'ms_todo' || provider === 'todoist') {
    const normalizedName = String(listName || '').trim() || 'Inbox';
    const providerRow = getDb().prepare(
      `SELECT * FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ?
         AND lower(name) = lower(?)
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
    ).get(userId, tenantId, provider, normalizedName) as ProjectRow | undefined;
    if (providerRow) return providerRow;
  }
  return getOrCreateProject(tenantId, userId, listName);
}

function getProjectById(tenantId: number, userId: number, listId: string): ProjectRow | null {
  const numericListId = Number(listId);
  if (!Number.isFinite(numericListId)) return null;
  const row = getDb().prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND id = ?
     LIMIT 1`,
  ).get(userId, tenantId, numericListId) as ProjectRow | undefined;
  return row || null;
}

function activeRows(tenantId: number, userId: number): UnifiedTaskRow[] {
  return getDb().prepare(
    `SELECT * FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND is_deleted = 0
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC`,
  ).all(tenantId, userId) as UnifiedTaskRow[];
}

function isTaskProviderOAuthConnected(userId: number, provider: 'ms_todo' | 'todoist'): boolean {
  try {
    const { isConnected } = require('../oauth-store') as { isConnected: (userId: number, provider: string) => boolean };
    return isConnected(userId, provider === 'ms_todo' ? 'outlook' : 'todoist');
  } catch {
    // oauth-store unavailable (isolated tests) — fall back to sync-state rows.
    return true;
  }
}

function providerErrorCode(errorMessage: string | null): string | undefined {
  if (!errorMessage) return undefined;
  // Auth failures deserve a distinct code so clients can render an
  // actionable "reconnect" affordance instead of a generic sync error.
  if (/not connected|unauthorized|forbidden|invalid_grant|auth|expired|401|403/i.test(errorMessage)) {
    return 'provider_auth_expired';
  }
  return 'provider_sync_error';
}

function providerStates(userId: number): TaskFreshness['providerStates'] {
  const rows = getDb().prepare(
    `SELECT provider, last_sync_at, status, error_message
     FROM task_sync_state
     WHERE user_id = ? AND provider IN ('ms_todo', 'todoist')`,
  ).all(userId) as Array<{ provider: 'ms_todo' | 'todoist'; last_sync_at: string | null; status: string; error_message: string | null }>;
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return (['ms_todo', 'todoist'] as const).map((provider) => {
    const row = byProvider.get(provider);
    // A stale sync_state row must never report 'connected' after the user
    // disconnected or the grant died — OAuth connection state is the truth
    // for connectivity; the row only contributes sync freshness/errors.
    if (!isTaskProviderOAuthConnected(userId, provider)) {
      return {
        provider,
        state: 'disconnected' as const,
        lastSyncedAt: row?.last_sync_at || undefined,
        lastErrorCode: row?.error_message ? providerErrorCode(row.error_message) : undefined,
      };
    }
    if (!row) return { provider, state: 'disconnected' as const };
    if (row.status === 'syncing') return { provider, state: 'syncing' as const, lastSyncedAt: row.last_sync_at || undefined };
    if (row.status === 'error') {
      return {
        provider,
        state: 'failed' as const,
        lastSyncedAt: row.last_sync_at || undefined,
        lastErrorCode: providerErrorCode(row.error_message),
      };
    }
    return { provider, state: 'connected' as const, lastSyncedAt: row.last_sync_at || undefined };
  });
}

function buildFreshness(tenantId: number, userId: number, tasks: OfflineTaskDto[]): TaskFreshness {
  const pending = countPendingMutations(tenantId, userId);
  const conflicts = tasks.filter((task) => task.syncState === 'conflict').length;
  const state = tasks.length === 0 ? 'empty' : pending > 0 || conflicts > 0 ? 'degraded' : 'fresh';
  const reasonCodes = [
    'local_read_model',
    ...(pending > 0 ? ['pending_task_mutations'] : []),
    ...(conflicts > 0 ? ['task_conflicts'] : []),
  ];
  return {
    generatedAt: nowIso(),
    state,
    reasonCodes,
    providerStates: providerStates(userId),
  };
}

export function countPendingMutations(tenantId: number, userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count
     FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND status IN ('queued', 'accepted_local', 'syncing', 'failed', 'conflict')`,
  ).get(tenantId, userId) as { count: number } | undefined;
  return row?.count || 0;
}

export function countConflicts(tenantId: number, userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count
     FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND sync_state = 'conflict' AND is_deleted = 0`,
  ).get(tenantId, userId) as { count: number } | undefined;
  return row?.count || 0;
}

function mappedNexusMirrorListIdsWithProviderRows(tenantId: number, userId: number): Set<string> {
  const rows = getDb().prepare(
    `SELECT m.nexus_list_id
     FROM task_container_mappings m
       JOIN unified_projects mirror
         ON mirror.user_id = m.user_id
        AND COALESCE(mirror.tenant_id, mirror.user_id) = m.tenant_id
        AND mirror.provider = 'nexus'
        AND mirror.id = CAST(m.nexus_list_id AS INTEGER)
       JOIN unified_projects provider_project
         ON provider_project.user_id = m.user_id
        AND COALESCE(provider_project.tenant_id, provider_project.user_id) = m.tenant_id
        AND provider_project.provider = m.provider
        AND provider_project.external_id = m.provider_container_id
     WHERE m.tenant_id = ? AND m.user_id = ? AND m.provider = 'ms_todo'`,
  ).all(tenantId, userId) as Array<{ nexus_list_id: string }>;
  return new Set(rows.map((row) => row.nexus_list_id));
}

function normalizedListName(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function relatedProjectIdsForList(tenantId: number, userId: number, listId: number): Set<number> {
  const ids = new Set<number>();
  if (Number.isFinite(listId)) ids.add(listId);
  if (!Number.isFinite(listId)) return ids;

  const rows = getDb().prepare(
    `SELECT CAST(m.nexus_list_id AS INTEGER) AS mirror_id, provider_project.id AS provider_id
     FROM task_container_mappings m
       LEFT JOIN unified_projects provider_project
         ON provider_project.user_id = m.user_id
        AND COALESCE(provider_project.tenant_id, provider_project.user_id) = m.tenant_id
        AND provider_project.provider = m.provider
        AND provider_project.external_id = m.provider_container_id
     WHERE m.tenant_id = ? AND m.user_id = ? AND m.provider = 'ms_todo'
       AND (
         CAST(m.nexus_list_id AS INTEGER) = ?
         OR provider_project.id = ?
       )`,
  ).all(tenantId, userId, listId, listId) as Array<{ mirror_id: number | null; provider_id: number | null }>;

  for (const row of rows) {
    if (Number.isFinite(Number(row.mirror_id))) ids.add(Number(row.mirror_id));
    if (Number.isFinite(Number(row.provider_id))) ids.add(Number(row.provider_id));
  }
  return ids;
}

function taskRowMatchesList(
  row: UnifiedTaskRow,
  relatedProjectIds: Set<number>,
  canonicalListName: string,
  knownProjectIds: Set<number>,
): boolean {
  if (row.project_id != null && relatedProjectIds.has(row.project_id)) return true;
  if (!canonicalListName) return false;
  if (row.project_id != null && knownProjectIds.has(row.project_id)) return false;
  return normalizedListName(row.project_name) === canonicalListName;
}

function isCompletedTaskRow(row: UnifiedTaskRow): boolean {
  return row.is_deleted ? true : isCompletedDto({
    id: rowTaskId(row),
    title: row.title,
    body: null,
    importance: 'normal',
    status: dtoStatus(row.status),
    dueDateTime: null,
    recurrence: null,
    listId: null,
    listName: null,
    checklistItems: null,
    createdDateTime: null,
    syncProvider: row.provider,
    syncState: row.sync_state || (row.provider === 'nexus' ? 'local_only' : 'synced'),
    syncWarnings: [],
    localVersion: row.local_version || 1,
    deletedAt: row.deleted_at || null,
  });
}

export function getOfflineTaskLists(tenantId: number, userId: number): { lists: Array<{ id: string; name: string; taskCount: number }>; freshness: TaskFreshness; pendingMutationCount: number; conflictsCount: number } {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const rows = getDb().prepare(
    `SELECT p.*, COUNT(t.id) AS task_count
     FROM unified_projects p
	     LEFT JOIN unified_tasks t
	       ON t.user_id = p.user_id
	      AND t.tenant_id = ?
	      AND t.project_id = p.id
	      AND t.is_deleted = 0
	      AND ${activeLikeStatusSql('t.status')}
	     WHERE p.user_id = ? AND COALESCE(p.tenant_id, p.user_id) = ?
     GROUP BY p.id
	     ORDER BY p.is_default DESC, p.name ASC`,
  ).all(tenantId, ...COMPLETED_LIKE_STATUS_VALUES, userId, tenantId) as ProjectRow[];
  const hiddenMirrorListIds = mappedNexusMirrorListIdsWithProviderRows(tenantId, userId);
  const visibleRows = rows.filter((row) => !(row.provider === 'nexus' && hiddenMirrorListIds.has(String(row.id))));
  const active = activeRows(tenantId, userId);
  const projectNameById = getProjectNameMap(tenantId, userId);
  const knownProjectIds = new Set(projectNameById.keys());
  const activeListCountById = new Map<number, number>();
  for (const row of visibleRows) {
    const relatedProjectIds = relatedProjectIdsForList(tenantId, userId, row.id);
    const canonicalName = normalizedListName(row.name);
    activeListCountById.set(
      row.id,
      active.filter((taskRow) =>
        !isCompletedTaskRow(taskRow) &&
        taskRowMatchesList(taskRow, relatedProjectIds, canonicalName, knownProjectIds),
      ).length,
    );
  }
  const tasks = rowsToDtos(tenantId, userId, active, projectNameById)
    .filter((task) => !isCompletedDto(task));
  return {
    lists: visibleRows.map((row) => ({ id: String(row.id), name: row.name, taskCount: activeListCountById.get(row.id) || 0 })),
    freshness: buildFreshness(tenantId, userId, tasks),
    pendingMutationCount: countPendingMutations(tenantId, userId),
    conflictsCount: countConflicts(tenantId, userId),
  };
}

export function getOfflineTaskSnapshot(
  tenantId: number,
  userId: number,
  options: { pageSize?: number } = {},
) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const listNameById = getProjectNameMap(tenantId, userId);
  const rows = activeRows(tenantId, userId);
  const allTasks = rowsToDtos(tenantId, userId, rows, listNameById);
  const tasks = allTasks.filter((task) => !isCompletedDto(task));
  const lists = getOfflineTaskLists(tenantId, userId).lists;
  const defaultList = lists.find((list) => /^(inbox|tasks|tarefas)$/i.test(list.name)) || lists[0] || null;
  const pageSize = Math.min(Math.max(Number(options.pageSize || 75), 1), 200);
  const activePageTasks = defaultList
    ? tasks.filter((task) => task.listId === defaultList.id).slice(0, pageSize)
    : tasks.slice(0, pageSize);
  const freshness = buildFreshness(tenantId, userId, tasks);
  const cursor = latestTaskChangesCursor(rows);

  return {
    cursor: cursor || freshness.generatedAt,
    tasks,
    policyVersion: 'offline_first_tasks_v1',
    provider: resolveTaskProvider(userId),
    capabilities: {
      supportsActiveStatusFiltering: true,
      supportsCompletedRangeFiltering: true,
      supportsCursorPagination: true,
      supportsProviderSideListCounts: false,
      maxPageSize: 200,
    },
    lists,
    activeCountsByList: Object.fromEntries(lists.map((list) => [list.id, list.taskCount])),
    smartCounts: {
      dueToday: tasks.filter((task) => !isCompletedDto(task) && isDueToday(task, userId)).length,
      overdue: tasks.filter((task) => !isCompletedDto(task) && isOverdue(task, userId)).length,
    },
    defaultListId: defaultList?.id || null,
    activePage: {
      listId: defaultList?.id || null,
      listName: defaultList?.name || 'Inbox',
      tasks: activePageTasks,
      pageSize,
      nextCursor: null,
      hasMore: activePageTasks.length >= pageSize,
    },
    completedPolicy: {
      mode: 'lazy_on_demand',
      suggestedCompletedAfter: null,
      pageSize: 50,
      reasonCodes: ['offline_first_active_snapshot'],
    },
    freshness,
    nextCursors: {
      active: null,
      completed: null,
    },
    pendingMutationCount: countPendingMutations(tenantId, userId),
    conflictsCount: countConflicts(tenantId, userId),
  };
}

export function getOfflineTasksForList(
  tenantId: number,
  userId: number,
  listId: string,
  options: { status?: string; pageSize?: number; listName?: string } = {},
) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const pageSize = Math.min(Math.max(Number(options.pageSize || 75), 1), 200);
  const listNameById = getProjectNameMap(tenantId, userId);
  const numericListId = Number(listId);
  const normalizedStatus = String(options.status || '').trim().toLowerCase();
  const relatedProjectIds = relatedProjectIdsForList(tenantId, userId, numericListId);
  const canonicalListName = normalizedListName(options.listName) || normalizedListName(listNameById.get(numericListId));
  const knownProjectIds = new Set(listNameById.keys());
  let rows = getDb().prepare(
    `SELECT * FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND is_deleted = 0
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC`,
  ).all(tenantId, userId) as UnifiedTaskRow[];
  rows = rows.filter((row) => taskRowMatchesList(row, relatedProjectIds, canonicalListName, knownProjectIds));
  if (normalizedStatus === 'active') {
    rows = rows.filter((row) => !isCompletedTaskRow(row));
  } else if (normalizedStatus === 'completed') {
    rows = rows.filter(isCompletedTaskRow);
  }
  rows = rows.slice(0, pageSize);
  let tasks = rowsToDtos(tenantId, userId, rows, listNameById);
  if (options.status === 'active') tasks = tasks.filter((task) => !isCompletedDto(task));
  if (options.status === 'completed') tasks = tasks.filter(isCompletedDto);
  const scope = normalizedStatus === 'completed'
    ? 'completed'
    : normalizedStatus === 'active'
      ? 'active'
      : 'all';
  return {
    listName: options.listName || listNameById.get(numericListId) || 'Tasks',
    tasks,
    scope,
    freshness: buildFreshness(tenantId, userId, tasks),
    pageInfo: {
      pageSize,
      nextCursor: null,
      hasMore: tasks.length >= pageSize,
    },
    pendingMutationCount: countPendingMutations(tenantId, userId),
    conflictsCount: countConflicts(tenantId, userId),
  };
}

export function getOfflineFilteredTasks(tenantId: number, userId: number, filter: string) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const listNameById = getProjectNameMap(tenantId, userId);
  let tasks = rowsToDtos(tenantId, userId, activeRows(tenantId, userId), listNameById).filter((task) => !isCompletedDto(task));
  if (filter === 'overdue') tasks = tasks.filter((task) => isOverdue(task, userId));
  if (filter === 'dueToday') tasks = tasks.filter((task) => isDueToday(task, userId));
  return {
    tasks,
    count: tasks.length,
    freshness: buildFreshness(tenantId, userId, tasks),
    pendingMutationCount: countPendingMutations(tenantId, userId),
    conflictsCount: countConflicts(tenantId, userId),
  };
}

export function getOfflineTaskChanges(tenantId: number, userId: number, sinceCursor?: string) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const cursor = decodeTaskChangesCursor(String(sinceCursor || '').trim());
  const listNameById = getProjectNameMap(tenantId, userId);
  const changeExpr = unifiedTasksHasChangeSeqColumn()
    ? 'change_seq'
    : 'COALESCE(deleted_at, updated_at, created_at)';
  const rows = getDb().prepare(
    `SELECT *,
            ${changeExpr} AS effective_ts
     FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ?
       AND (
         ? = ''
         OR ${changeExpr} > ?
         OR (
           ${changeExpr} = ?
           AND nexus_task_id > ?
         )
       )
     ORDER BY ${changeExpr} ASC, nexus_task_id ASC
     LIMIT 500`,
  ).all(tenantId, userId, cursor.timestamp, cursor.timestamp, cursor.timestamp, cursor.taskId) as UnifiedTaskRow[];
  const upserts = rowsToDtos(tenantId, userId, rows.filter((row) => !row.is_deleted), listNameById);
  const deletes = rows
    .filter((row) => !!row.is_deleted)
    .map((row) => ({ taskId: rowTaskId(row), deletedAt: row.deleted_at || row.updated_at || nowIso() }));
  const nextCursor = latestTaskChangesCursor(rows, sinceCursor ? String(sinceCursor) : nowIso());

  return {
    cursor: nextCursor,
    upserts,
    deletes,
    freshness: buildFreshness(tenantId, userId, upserts),
  };
}

export function createOfflineFirstTask(tenantId: number, userId: number, input: TaskMutationInput) {
  assertScope(tenantId, userId);
  const title = String(input.title || '').trim();
  if (!title) {
    const err = new Error('title is required');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const operation = 'task.create';
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:${operation}`).slice(0, 220);
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
       AND (client_mutation_id = ? OR idempotency_key = ?)
     ORDER BY created_at ASC
     LIMIT 1`,
  ).get(tenantId, userId, operation, clientMutationId, idempotencyKey) as MutationRow | undefined;
  if (existing?.task_id) {
    const existingTask = getTaskByNexusId(tenantId, userId, existing.task_id);
    if (existingTask) {
      recordDuplicatePreventionHit(tenantId, userId, existing);
      return {
        task: existingTask,
        mutationId: existing.mutation_id,
        clientMutationId: existing.client_mutation_id,
        idempotencyKey: existing.idempotency_key,
        idempotentReplay: true,
        warnings: existingTask.syncWarnings,
      };
    }
  }

  const created = db.transaction(() => {
    const provider = resolveTaskProvider(userId);
    const project = resolveCreateTargetProject(tenantId, userId, input.listName, provider);
    const syncTarget = resolveTaskSyncTarget({
      tenantId,
      userId,
      nexusListId: String(project.id),
      preferredProvider: provider,
    });
    const syncState = syncTarget.syncState;
    const taskId = randomId('task');
    const externalId = taskId;
    const mutationId = randomId('task_mutation');
    const providerData = {
      recurrence: input.recurrence || null,
      source: 'offline_first_create',
    };
    db.prepare(
      `INSERT INTO unified_tasks (
         user_id, tenant_id, provider, external_id, project_id, project_name,
         title, description, status, priority, due_date, due_is_datetime,
         tags, notes, provider_data, content_hash, synced_at, nexus_task_id,
         local_version, sync_state, source_of_truth
       ) VALUES (?, ?, 'nexus', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?, NULL, datetime('now'), ?, 1, ?, 'nexus')`,
    ).run(
      userId,
      tenantId,
      externalId,
      project.id,
      project.name,
      title,
      input.body || null,
      priorityToDb(input.importance),
      input.dueDateTime || null,
      input.dueDateTime && input.dueDateTime.includes('T') ? 1 : 0,
      input.body || null,
      JSON.stringify(providerData),
      taskId,
      syncState,
    );

    db.prepare(
      `INSERT INTO task_provider_links (
         id, task_id, tenant_id, user_id, provider, provider_account_id,
         provider_task_id, provider_list_id, provider_project_id,
         ownership, link_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomId('task_link'),
      taskId,
      tenantId,
      userId,
      syncTarget.provider,
      syncTarget.providerAccountId,
      syncTarget.provider === 'nexus_local' ? taskId : null,
      syncTarget.providerListId,
      syncTarget.providerProjectId,
      syncTarget.provider === 'nexus_local' ? 'linked' : 'nexus_created',
      syncTarget.linkState,
    );

    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      taskId,
      operation,
      JSON.stringify(input),
      nowIso(),
      syncTarget.mutationStatus,
    );

    return { taskId, mutationId, syncTarget };
  })();

  if (created.syncTarget.warning) {
    recordTaskSyncIssue({
      tenantId,
      userId,
      taskId: created.taskId,
      provider: created.syncTarget.provider,
      code: created.syncTarget.warning.code,
      message: created.syncTarget.warning.message,
      details: { reason: 'missing_container_mapping' },
    });
  }

  kickAfterJournal(tenantId, userId, created.syncTarget.mutationStatus);

  const task = getTaskByNexusId(tenantId, userId, created.taskId);
  if (!task) throw new Error('Failed to create local task');
  return {
    task,
    mutationId: created.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
    warnings: task.syncWarnings,
  };
}

export function updateOfflineFirstTask(tenantId: number, userId: number, input: TaskUpdateMutationInput) {
  assertScope(tenantId, userId);
  const operation = 'task.update';
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  if (!existingRow) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId) || rowToDto(existingRow, getProjectNameMap(tenantId, userId));
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:${operation}`).slice(0, 220);
  const db = getDb();
  const existingMutation = db.prepare(
    `SELECT * FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
       AND (client_mutation_id = ? OR idempotency_key = ?)
     LIMIT 1`,
  ).get(tenantId, userId, operation, clientMutationId, idempotencyKey) as MutationRow | undefined;
  if (existingMutation?.task_id) {
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      task: getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  assertBaseLocalVersionCurrent(existingRow, existingTask, input.baseLocalVersion);

  const providerData = safeJsonParse<Record<string, unknown>>(existingRow.provider_data, {});
  if (Object.prototype.hasOwnProperty.call(input, 'recurrence')) {
    providerData.recurrence = input.recurrence || null;
  }
  const newSyncState: TaskSyncState = existingTask.syncState === 'local_only' ? 'local_only' : 'queued';
  const mutationStatus = newSyncState === 'local_only' ? 'synced' : 'queued';
  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const nextTitle = input.title != null ? String(input.title).trim() || existingRow.title : existingRow.title;
    const nextNotes = Object.prototype.hasOwnProperty.call(input, 'body') ? input.body || null : existingRow.notes;
    const nextDue = Object.prototype.hasOwnProperty.call(input, 'dueDateTime') ? input.dueDateTime || null : existingRow.due_date;
    const nextPriority = Object.prototype.hasOwnProperty.call(input, 'importance')
      ? priorityToDb(input.importance)
      : existingRow.priority || 0;
    const nextStatus = Object.prototype.hasOwnProperty.call(input, 'status')
      ? dbStatusForValue(input.status, existingRow.status)
      : existingRow.status;
    db.prepare(
      `UPDATE unified_tasks SET
         title = ?,
         notes = ?,
         description = ?,
         due_date = ?,
         due_is_datetime = ?,
         priority = ?,
         status = ?,
         provider_data = ?,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(
      nextTitle,
      nextNotes,
      nextNotes,
      nextDue,
      nextDue && String(nextDue).includes('T') ? 1 : 0,
      nextPriority,
      nextStatus,
      JSON.stringify(providerData),
      newSyncState,
      updatedAt,
      tenantId,
      userId,
      input.taskId,
    );
    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify(input),
      updatedAt,
      mutationStatus,
    );
    return { mutationId };
  })();

  kickAfterJournal(tenantId, userId, mutationStatus);

  return {
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

export function moveOfflineFirstTask(tenantId: number, userId: number, input: TaskMoveMutationInput) {
  assertScope(tenantId, userId);
  const operation = 'task.move';
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  if (!existingRow) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  const targetProject = getProjectById(tenantId, userId, input.targetListId);
  if (!targetProject) {
    const err = new Error('Target list not found');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId) || rowToDto(existingRow, getProjectNameMap(tenantId, userId));
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:${operation}`).slice(0, 220);
  const db = getDb();
  const linkRows = db.prepare(
    `SELECT id, provider, provider_list_id, provider_project_id
     FROM task_provider_links
     WHERE tenant_id = ? AND user_id = ? AND task_id = ?`,
  ).all(tenantId, userId, input.taskId) as Array<{
    id: string;
    provider: 'ms_todo' | 'todoist' | 'nexus_local';
    provider_list_id: string | null;
    provider_project_id: string | null;
  }>;
  const targetLinks = linkRows.map((link) => {
    if (link.provider === 'nexus_local') return { id: link.id, target: null };
    return {
      id: link.id,
      target: resolveTaskSyncTarget({
        tenantId,
        userId,
        nexusListId: String(targetProject.id),
        preferredProvider: link.provider,
      }),
    };
  });
  const providerTargetWarning = targetLinks.find((entry) => entry.target?.warning)?.target?.warning;
  const existingMutation = db.prepare(
    `SELECT * FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
       AND (client_mutation_id = ? OR idempotency_key = ?)
     LIMIT 1`,
  ).get(tenantId, userId, operation, clientMutationId, idempotencyKey) as MutationRow | undefined;
  if (existingMutation?.task_id) {
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      task: getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  assertBaseLocalVersionCurrent(existingRow, existingTask, input.baseLocalVersion);

  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const newSyncState: TaskSyncState = existingTask.syncState === 'local_only'
      ? 'local_only'
      : providerTargetWarning
        ? 'failed_permanent'
        : 'queued';
    const mutationStatus = newSyncState === 'local_only' ? 'synced' : providerTargetWarning ? 'failed' : 'queued';
    db.prepare(
      `UPDATE unified_tasks SET
         project_id = ?,
         project_name = ?,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(
      targetProject.id,
      targetProject.name,
      newSyncState,
      updatedAt,
      tenantId,
      userId,
      input.taskId,
    );
    for (const entry of targetLinks) {
      if (!entry.target) {
        db.prepare(
          `UPDATE task_provider_links
           SET updated_at = ?
           WHERE id = ?`,
        ).run(updatedAt, entry.id);
        continue;
      }
      db.prepare(
        `UPDATE task_provider_links
         SET provider_account_id = ?,
             provider_list_id = ?,
             provider_project_id = ?,
             link_state = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        entry.target.providerAccountId,
        entry.target.providerListId,
        entry.target.providerProjectId,
        entry.target.linkState === 'pending_create' ? 'pending_update' : entry.target.linkState,
        updatedAt,
        entry.id,
      );
    }
    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify({
        targetListId: input.targetListId,
        targetListName: targetProject.name,
        previousProviderContainers: Object.fromEntries(linkRows.map((link) => [
          link.provider,
          {
            providerListId: link.provider_list_id,
            providerProjectId: link.provider_project_id,
          },
        ])),
      }),
      updatedAt,
      mutationStatus,
    );
    return { mutationId, mutationStatus };
  })();

  kickAfterJournal(tenantId, userId, result.mutationStatus);

  if (providerTargetWarning) {
    recordTaskSyncIssue({
      tenantId,
      userId,
      taskId: input.taskId,
      provider: providerTargetWarning.provider,
      code: providerTargetWarning.code,
      message: providerTargetWarning.message,
      details: { reason: 'missing_move_container_mapping', targetListId: input.targetListId },
    });
  }

  return {
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

export function assignOfflineTaskProvider(tenantId: number, userId: number, input: TaskAssignProviderMutationInput) {
  assertScope(tenantId, userId);
  const provider = normalizeAssignableProvider(input.provider);
  if (!provider) {
    const err = new Error('provider must be one of nexus, ms_todo, microsoft_todo, or todoist');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const operation = 'task.assign_provider';
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  const existingTask = existingRow
    ? getTaskByNexusId(tenantId, userId, input.taskId) || rowToDto(existingRow, getProjectNameMap(tenantId, userId))
    : null;
  if (!existingRow || !existingTask) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation?.task_id) {
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      task: getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  const db = getDb();
  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const linkProvider = providerLinkProvider(provider);
    const existingLink = getProviderLinkForTask(tenantId, userId, input.taskId, linkProvider);
    const nexusListId = existingTask.listId || (existingRow.project_id != null ? String(existingRow.project_id) : '');
    const target = provider === 'nexus'
      ? {
        provider: 'nexus_local' as const,
        providerAccountId: `nexus_local:${userId}`,
        providerListId: nexusListId || null,
        providerProjectId: nexusListId || null,
        syncState: 'local_only' as TaskSyncState,
        mutationStatus: 'synced' as const,
        linkState: 'linked' as const,
        warning: undefined,
      }
      : resolveTaskSyncTarget({
        tenantId,
        userId,
        nexusListId,
        preferredProvider: provider,
      });
    const nextLinkState = target.warning
      ? target.linkState
      : target.provider === 'nexus_local'
        ? 'linked'
        : existingLink?.provider_task_id
          ? 'pending_update'
          : target.linkState;
	    const ownership = target.provider === 'nexus_local'
	      ? 'linked'
	      : existingLink?.ownership || (existingRow.provider === provider ? 'provider_imported' : 'nexus_created');

	    const oldLinkedProviderRows = db.prepare(
	      `SELECT id, provider, provider_task_id, provider_list_id, provider_project_id
	       FROM task_provider_links
	       WHERE tenant_id = ? AND user_id = ? AND task_id = ?
	         AND provider <> ?
	         AND provider <> 'nexus_local'
	         AND link_state = 'linked'`,
	    ).all(tenantId, userId, input.taskId, target.provider) as Array<{
	      id: string;
	      provider: TaskProviderLinkProvider;
	      provider_task_id: string | null;
	      provider_list_id: string | null;
	      provider_project_id: string | null;
	    }>;

	    if (oldLinkedProviderRows.length > 0) {
	      db.prepare(
	        `UPDATE task_provider_links
	         SET link_state = 'pending_delete', updated_at = ?
	         WHERE tenant_id = ? AND user_id = ? AND task_id = ?
	           AND provider <> ?
	           AND provider <> 'nexus_local'
	           AND link_state = 'linked'`,
	      ).run(updatedAt, tenantId, userId, input.taskId, target.provider);
	    }

	    upsertProviderLinkForTask({
      id: existingLink?.id,
      taskId: input.taskId,
      tenantId,
      userId,
      provider: target.provider,
      providerAccountId: target.providerAccountId,
      providerTaskId: target.provider === 'nexus_local'
        ? input.taskId
        : existingLink?.provider_task_id || null,
      providerListId: target.providerListId,
      providerProjectId: target.providerProjectId,
      ownership,
      linkState: nextLinkState,
      updatedAt,
    });

    db.prepare(
      `UPDATE unified_tasks SET
         provider = CASE WHEN ? = 'nexus' THEN 'nexus' ELSE provider END,
         external_id = CASE WHEN ? = 'nexus' THEN ? ELSE external_id END,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(
      provider,
      provider,
      input.taskId,
      target.syncState,
      updatedAt,
      tenantId,
      userId,
      input.taskId,
    );

    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify({
        provider,
        providerLinkProvider: target.provider,
        providerAccountId: target.providerAccountId,
        providerListId: target.providerListId,
        providerProjectId: target.providerProjectId,
      }),
      updatedAt,
	      target.mutationStatus,
	    );

	    for (const oldLink of oldLinkedProviderRows) {
	      const cleanupMutationId = randomId('task_mutation');
	      const cleanupClientMutationId = `${clientMutationId}:provider-cleanup:${oldLink.provider}:${oldLink.id}`.slice(0, 180);
	      db.prepare(
	        `INSERT INTO task_mutations (
	           mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
	           task_id, operation, base_local_version, patch_json, submitted_at, status
	         ) VALUES (?, ?, ?, ?, ?, ?, 'task.delete', ?, ?, ?, 'queued')`,
	      ).run(
	        cleanupMutationId,
	        cleanupClientMutationId,
	        `${tenantId}:${userId}:${cleanupClientMutationId}:task.delete`.slice(0, 220),
	        tenantId,
	        userId,
	        input.taskId,
	        existingTask.localVersion,
	        JSON.stringify({
	          reason: 'provider_reassignment_cleanup',
	          providerLinkProvider: oldLink.provider,
	          providerTaskId: oldLink.provider_task_id,
	          providerListId: oldLink.provider_list_id,
	          providerProjectId: oldLink.provider_project_id,
	        }),
	        updatedAt,
	      );
	    }

	    return {
	      mutationId,
	      warning: target.warning,
	      provider: target.provider,
	      mutationStatus: target.mutationStatus,
	      cleanupCount: oldLinkedProviderRows.length,
	    };
	  })();

  // Cleanup task.delete rows for reassigned-away providers are internal
  // (no undo semantics, no holdback) — they ride the same kick.
  kickAfterJournal(
    tenantId,
    userId,
    result.mutationStatus === 'queued' || result.cleanupCount > 0 ? 'queued' : result.mutationStatus,
  );

  if (result.warning) {
    recordTaskSyncIssue({
      tenantId,
      userId,
      taskId: input.taskId,
      provider: result.provider,
      code: result.warning.code,
      message: result.warning.message,
      details: { reason: 'assign_provider_missing_container', provider },
    });
  }

  const task = getTaskByNexusId(tenantId, userId, input.taskId) || existingTask;
  return {
    task,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
    warnings: task.syncWarnings,
  };
}

export function retryOfflineTaskSync(tenantId: number, userId: number, input: TaskRetrySyncMutationInput) {
  assertScope(tenantId, userId);
  const operation = 'task.retry_sync';
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  const existingTask = existingRow
    ? getTaskByNexusId(tenantId, userId, input.taskId) || rowToDto(existingRow, getProjectNameMap(tenantId, userId))
    : null;
  if (!existingRow || !existingTask) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation?.task_id) {
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      task: getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  const link = getProviderLinkForTask(tenantId, userId, input.taskId);
  const missingContainerCode: TaskSyncWarningCode | null = link?.provider === 'ms_todo' && !link.provider_list_id
    ? 'provider_list_missing'
    : link?.provider === 'todoist' && !link.provider_project_id
      ? 'provider_project_missing'
      : null;
  const cannotRetryProvider = !link || link.provider === 'nexus_local' || existingTask.syncState === 'local_only';
  const conflictRetry = existingTask.syncState === 'conflict' || link?.link_state === 'conflict';

  const result = getDb().transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const mutationStatus = cannotRetryProvider
      ? 'synced'
      : conflictRetry
        ? 'conflict'
        : missingContainerCode
          ? 'failed'
          : 'queued';
    const nextSyncState: TaskSyncState = cannotRetryProvider
      ? 'local_only'
      : conflictRetry
        ? 'conflict'
        : missingContainerCode
          ? 'failed_permanent'
          : 'queued';

    if (link && !cannotRetryProvider) {
      getDb().prepare(
        `UPDATE task_provider_links
         SET link_state = ?,
             updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND id = ?`,
      ).run(
        conflictRetry || missingContainerCode
          ? link.link_state
          : link.provider_task_id
            ? 'pending_update'
            : 'pending_create',
        updatedAt,
        tenantId,
        userId,
        link.id,
      );
    }

    getDb().prepare(
      `UPDATE unified_tasks SET
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(nextSyncState, updatedAt, tenantId, userId, input.taskId);

    getDb().prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify({
        provider: link?.provider || 'nexus_local',
        providerTaskId: link?.provider_task_id || null,
        retryReason: conflictRetry
          ? 'conflict_requires_manual_review'
          : missingContainerCode || 'manual_retry_requested',
      }),
      updatedAt,
      mutationStatus,
    );

    return {
      mutationId,
      mutationStatus,
      issueCode: conflictRetry
        ? 'provider_conflict' as TaskSyncWarningCode
        : missingContainerCode,
      provider: link?.provider || null,
    };
  })();

  kickAfterJournal(tenantId, userId, result.mutationStatus);

  if (result.issueCode) {
    recordTaskSyncIssue({
      tenantId,
      userId,
      taskId: input.taskId,
      provider: result.provider,
      code: result.issueCode,
      details: { reason: 'retry_sync_blocked' },
    });
  }

  const task = getTaskByNexusId(tenantId, userId, input.taskId) || existingTask;
  return {
    task,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
    warnings: task.syncWarnings,
  };
}

/**
 * Optional client OCC (NEX-24). Strictly additive: when the client sends no
 * baseLocalVersion (or an unparseable one — defensive, treated as absent),
 * behavior is exactly the pre-OCC last-write-wins ledger. When present and
 * BEHIND the row's current local_version, the write is rejected with
 * VERSION_CONFLICT carrying the current task DTO so the client can rebase.
 * Runs AFTER the idempotent-replay short-circuit on purpose: a retried
 * mutation whose first attempt already bumped local_version must replay, not
 * 409 against its own effect.
 */
function assertBaseLocalVersionCurrent(
  existingRow: UnifiedTaskRow,
  currentTask: OfflineTaskDto,
  baseLocalVersion: number | undefined,
): void {
  if (baseLocalVersion == null) return;
  const base = Number(baseLocalVersion);
  if (!Number.isFinite(base)) return;
  const current = existingRow.local_version || 1;
  if (base < current) {
    const err = new Error('Task changed since the client base version. Refresh and retry.');
    (err as any).code = 'VERSION_CONFLICT';
    (err as any).currentTask = currentTask;
    throw err;
  }
}

function mutationKeys(
  tenantId: number,
  userId: number,
  operation: string,
  input: { clientMutationId?: string; idempotencyKey?: string },
): { clientMutationId: string; idempotencyKey: string } {
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:${operation}`).slice(0, 220);
  return { clientMutationId, idempotencyKey };
}

function findExistingMutation(
  tenantId: number,
  userId: number,
  operation: string,
  clientMutationId: string,
  idempotencyKey: string,
): MutationRow | undefined {
  return getDb().prepare(
    `SELECT * FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
       AND (client_mutation_id = ? OR idempotency_key = ?)
     LIMIT 1`,
  ).get(tenantId, userId, operation, clientMutationId, idempotencyKey) as MutationRow | undefined;
}

function checklistReplayItem(
  task: OfflineTaskDto,
  existing: MutationRow,
  fallbackItemId?: string,
): ChecklistItemDto {
  const patch = safeJsonParse<Record<string, any>>(existing.patch_json, {});
  const itemId = String(fallbackItemId || patch.itemId || patch.item?.id || '').trim();
  const current = (task.checklistItems || []).find((item) => item.id === itemId);
  if (current) return current;
  const patched = patch.item && typeof patch.item === 'object' ? patch.item : patch;
  return {
    id: itemId || randomId('checklist_item_replay'),
    displayName: String(patched.displayName || '').trim() || 'Checklist item',
    isChecked: Boolean(patched.isChecked ?? patched.item?.isChecked),
  };
}

export function addOfflineTaskChecklistItem(tenantId: number, userId: number, input: TaskChecklistMutationInput) {
  assertScope(tenantId, userId);
  const operation = 'task.checklist.add';
  const displayName = String(input.displayName || '').trim();
  if (!displayName) {
    const err = new Error('displayName is required');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }
  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId);
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  if (!existingTask || !existingRow) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation?.task_id) {
    const task = getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask;
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      item: checklistReplayItem(task, existingMutation),
      task,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  const result = getDb().transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const providerData = safeJsonParse<Record<string, unknown>>(existingRow.provider_data, {});
    const checklistItems = normalizeChecklistItems(providerData.checklistItems);
    const item: ChecklistItemDto = {
      id: String(input.itemId || randomId('checklist_item')).slice(0, 180),
      displayName,
      isChecked: Boolean(input.isChecked),
    };
    checklistItems.push(item);
    providerData.checklistItems = checklistItems;
    const localOnly = existingTask.syncState === 'local_only';
    const syncState: TaskSyncState = localOnly ? 'local_only' : 'queued';
    const mutationStatus = localOnly ? 'synced' : 'queued';

    getDb().prepare(
      `UPDATE unified_tasks SET
         provider_data = ?,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(JSON.stringify(providerData), syncState, updatedAt, tenantId, userId, input.taskId);
    getDb().prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify({ item }),
      updatedAt,
      mutationStatus,
    );
    return { mutationId, item };
  })();

  kickAfterJournal(tenantId, userId, existingTask.syncState === 'local_only' ? 'synced' : 'queued');

  return {
    item: result.item,
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

export function toggleOfflineTaskChecklistItem(tenantId: number, userId: number, input: TaskChecklistMutationInput) {
  assertScope(tenantId, userId);
  const operation = 'task.checklist.update';
  const itemId = String(input.itemId || '').trim();
  if (!itemId) {
    const err = new Error('itemId is required');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }
  if (typeof input.isChecked !== 'boolean') {
    const err = new Error('isChecked is required');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }
  const isChecked = input.isChecked;
  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId);
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  if (!existingTask || !existingRow) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation?.task_id) {
    const task = getTaskByNexusId(tenantId, userId, existingMutation.task_id) || existingTask;
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      item: checklistReplayItem(task, existingMutation, itemId),
      task,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  const result = getDb().transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const providerData = safeJsonParse<Record<string, unknown>>(existingRow.provider_data, {});
    const checklistItems = normalizeChecklistItems(providerData.checklistItems);
    const index = checklistItems.findIndex((item) => item.id === itemId);
    if (index === -1) {
      const err = new Error('Checklist item not found');
      (err as any).code = 'NOT_FOUND';
      throw err;
    }
    const item: ChecklistItemDto = { ...checklistItems[index], isChecked };
    checklistItems[index] = item;
    providerData.checklistItems = checklistItems;
    const localOnly = existingTask.syncState === 'local_only';
    const syncState: TaskSyncState = localOnly ? 'local_only' : 'queued';
    const mutationStatus = localOnly ? 'synced' : 'queued';

    getDb().prepare(
      `UPDATE unified_tasks SET
         provider_data = ?,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(JSON.stringify(providerData), syncState, updatedAt, tenantId, userId, input.taskId);
    getDb().prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      operation,
      existingTask.localVersion,
      JSON.stringify({ itemId, isChecked, item }),
      updatedAt,
      mutationStatus,
    );
    return { mutationId, item };
  })();

  kickAfterJournal(tenantId, userId, existingTask.syncState === 'local_only' ? 'synced' : 'queued');

  return {
    item: result.item,
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

export function recordLocalTaskMutation(
  tenantId: number,
  userId: number,
  input: {
    taskId: string;
    operation: 'task.complete' | 'task.reopen' | 'task.delete';
    clientMutationId?: string;
    idempotencyKey?: string;
    patch?: Record<string, unknown>;
    /** Optional client OCC (NEX-24): the local_version the client last saw. */
    baseLocalVersion?: number;
  },
) {
  assertScope(tenantId, userId);
  const db = getDb();
  const existingRow = getTaskRowByNexusId(tenantId, userId, input.taskId);
  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId);
  if (!existingRow || !existingTask) {
    const err = new Error('Task not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  const clientMutationId = String(input.clientMutationId || input.idempotencyKey || randomId('client_task_mutation')).slice(0, 180);
  const idempotencyKey = String(input.idempotencyKey || `${tenantId}:${userId}:${clientMutationId}:${input.operation}`).slice(0, 220);
  const existing = db.prepare(
    `SELECT * FROM task_mutations
     WHERE tenant_id = ? AND user_id = ? AND operation = ?
       AND (client_mutation_id = ? OR idempotency_key = ?)
     LIMIT 1`,
  ).get(tenantId, userId, input.operation, clientMutationId, idempotencyKey) as MutationRow | undefined;
  if (existing?.task_id) {
    recordDuplicatePreventionHit(tenantId, userId, existing);
    return {
      task: getTaskByNexusId(tenantId, userId, existing.task_id) || existingTask,
      mutationId: existing.mutation_id,
      idempotentReplay: true,
    };
  }

  assertBaseLocalVersionCurrent(existingRow, existingTask, input.baseLocalVersion);

  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const localOnly = existingTask.syncState === 'local_only';
    const syncState: TaskSyncState = localOnly
      ? 'local_only'
      : input.operation === 'task.delete'
        ? 'deleted_pending_sync'
        : 'queued';
    const mutationStatus = localOnly ? 'synced' : 'queued';
    db.prepare(
      `UPDATE unified_tasks SET
         status = ?,
         is_deleted = CASE WHEN ? = 'task.delete' THEN 1 ELSE is_deleted END,
         deleted_at = CASE WHEN ? = 'task.delete' THEN ? ELSE deleted_at END,
         completed_at = CASE WHEN ? = 'task.complete' THEN ? WHEN ? = 'task.reopen' THEN NULL ELSE completed_at END,
         sync_state = ?,
         local_version = COALESCE(local_version, 1) + 1,
         updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(
      dbStatusForOperation(input.operation),
      input.operation,
      input.operation,
      nowIso(),
      input.operation,
      nowIso(),
      input.operation,
      syncState,
      nowIso(),
      tenantId,
      userId,
      input.taskId,
    );
    // M6: provider-bound deletes are journaled with a 10s availability
    // holdback so the client undo window can retire them before any runner
    // ships the provider hard-delete. Everything else is available at once.
    const availableAt = input.operation === 'task.delete' && mutationStatus === 'queued'
      ? taskDeleteAvailableAt()
      : null;
    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, base_local_version, patch_json, submitted_at, status,
         available_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      input.taskId,
      input.operation,
      existingTask.localVersion,
      JSON.stringify(input.patch || {}),
      nowIso(),
      mutationStatus,
      availableAt,
    );
    return { mutationId, mutationStatus };
  })();

  // Deletes are deliberately NOT kicked — the holdback plus the next
  // cron/kick/force-sync ships them once the undo window has passed.
  if (input.operation !== 'task.delete') {
    kickAfterJournal(tenantId, userId, result.mutationStatus);
  }

  return {
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
    idempotentReplay: false,
  };
}

// ─── M5 single write path: list operations through the ledger ───────────────

export interface TaskListMutationInput {
  name: string;
  idempotencyKey?: string;
  clientMutationId?: string;
}

export interface TaskListDeleteMutationInput {
  listId: string;
  idempotencyKey?: string;
  clientMutationId?: string;
}

/**
 * Project rows the app actually shows as lists: every unified_projects row
 * except nexus mirrors hidden behind an ms_todo container mapping whose
 * provider row exists (same visibility rule as getOfflineTaskLists).
 */
function visibleProjectRows(tenantId: number, userId: number): ProjectRow[] {
  const rows = getDb().prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
     ORDER BY is_default DESC, name ASC`,
  ).all(userId, tenantId) as ProjectRow[];
  const hiddenMirrorListIds = mappedNexusMirrorListIdsWithProviderRows(tenantId, userId);
  return rows.filter((row) => !(row.provider === 'nexus' && hiddenMirrorListIds.has(String(row.id))));
}

function getProjectRowForListRef(tenantId: number, userId: number, listRef: string): ProjectRow | null {
  const raw = String(listRef || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = getDb().prepare(
      `SELECT * FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND id = ?
       LIMIT 1`,
    ).get(userId, tenantId, Number(raw)) as ProjectRow | undefined;
    if (byId) return byId;
  }
  const byExternalId = getDb().prepare(
    `SELECT * FROM unified_projects
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND external_id = ?
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
  ).get(userId, tenantId, raw) as ProjectRow | undefined;
  return byExternalId || null;
}

/**
 * Resolve a chat/callback list reference (local row id, provider external id,
 * or display name) to the LOCAL list identity the ledger speaks. Chat reads
 * still run on the provider path, so their list ids are provider container
 * ids — this is the list-side twin of resolveOfflineNexusTaskId.
 */
export function resolveOfflineTaskListRef(
  tenantId: number,
  userId: number,
  listRef?: string | null,
  listName?: string | null,
): { id: string; name: string } | null {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const byRef = listRef ? getProjectRowForListRef(tenantId, userId, String(listRef)) : null;
  if (byRef) return { id: String(byRef.id), name: byRef.name };
  const wanted = normalizedListName(listName || listRef);
  if (!wanted) return null;
  const byName = visibleProjectRows(tenantId, userId).find((row) => normalizedListName(row.name) === wanted);
  return byName ? { id: String(byName.id), name: byName.name } : null;
}

/**
 * Resolve the list NAME a ledger-routed chat create should target.
 *
 * - An explicit name that matches a visible list resolves to that list's
 *   canonical name (case/diacritic-insensitive).
 * - An explicit unknown, non-alias name is kept as-is: offline-first capture
 *   semantics create the local list (same contract as the iOS REST create)
 *   instead of failing like the legacy provider-read resolution did.
 * - No name (or a capture alias) picks the default visible list: alias match
 *   first, then the is_default row, then the first visible list; undefined
 *   lets the ledger fall back to its Inbox default.
 */
export function resolveOfflineCaptureListName(
  tenantId: number,
  userId: number,
  preferredName?: string | null,
): string | undefined {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const rows = visibleProjectRows(tenantId, userId);
  const trimmed = String(preferredName || '').trim();
  const isCaptureAlias = /^(inbox|tasks|tarefas)$/i.test(
    trimmed.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
  );
  if (trimmed) {
    const match = rows.find((row) => normalizedListName(row.name) === normalizedListName(trimmed));
    if (match) return match.name;
    if (!isCaptureAlias) return trimmed;
  }
  const alias = rows.find((row) => /^(inbox|tasks|tarefas)$/i.test(String(row.name || '').trim()));
  if (alias) return alias.name;
  const defaultRow = rows.find((row) => !!row.is_default);
  if (defaultRow) return defaultRow.name;
  return rows[0]?.name;
}

/**
 * Create a task list through the ledger (NEX-10 create fix): the LOCAL
 * unified_projects row exists immediately — GET /lists shows it instantly —
 * and a `list.create` mutation row (task_id NULL) journals the provider push
 * for the sync worker. Provider routing follows the create-task path:
 * ms_todo pushes on the worker cron; todoist (list creation unsupported from
 * Nexus) and nexus-local short-circuit to synced exactly like local task
 * creates.
 */
export function createOfflineFirstTaskList(tenantId: number, userId: number, input: TaskListMutationInput) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const name = String(input.name || '').trim();
  if (!name) {
    const err = new Error('name is required');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const operation = 'list.create';
  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation) {
    const patch = safeJsonParse<Record<string, unknown>>(existingMutation.patch_json, {});
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      list: { id: String(patch.listId || ''), name: String(patch.name || name) },
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  // Name-level idempotency: the local list model is keyed by normalized name
  // (stableListExternalId), so a visible list with this name IS this list.
  // Returning it (instead of journaling a duplicate mutation) keeps repeated
  // "create list X" chat turns and REST retries convergent.
  const existingVisible = visibleProjectRows(tenantId, userId)
    .find((row) => normalizedListName(row.name) === normalizedListName(name));
  if (existingVisible) {
    return {
      list: { id: String(existingVisible.id), name: existingVisible.name },
      mutationId: null,
      clientMutationId,
      idempotencyKey,
      idempotentReplay: true,
    };
  }

  const provider = resolveTaskProvider(userId);
  const pushProvider: 'ms_todo' | 'nexus_local' = provider === 'ms_todo' ? 'ms_todo' : 'nexus_local';
  const db = getDb();
  const created = db.transaction(() => {
    const project = getOrCreateProject(tenantId, userId, name);
    const mutationId = randomId('task_mutation');
    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      operation,
      JSON.stringify({ listId: String(project.id), name: project.name, provider: pushProvider }),
      nowIso(),
      pushProvider === 'ms_todo' ? 'queued' : 'synced',
    );
    return { project, mutationId };
  })();

  kickAfterJournal(tenantId, userId, pushProvider === 'ms_todo' ? 'queued' : 'synced');

  return {
    list: { id: String(created.project.id), name: created.project.name },
    mutationId: created.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

/**
 * Provider deletion identity for a local list row. The worker must call
 * providerApi.deleteList with the PROVIDER container id — passing the local
 * numeric row id to Microsoft Graph was the NEX-10 delete bug — so the
 * identity is captured here, before the local rows are removed.
 */
function listDeletionScope(tenantId: number, userId: number, row: ProjectRow): {
  projectIds: number[];
  pushProvider: 'ms_todo' | 'todoist' | null;
  providerContainerId: string | null;
} {
  const db = getDb();
  const projectIds = new Set<number>([row.id]);
  let pushProvider: 'ms_todo' | 'todoist' | null = null;
  let providerContainerId: string | null = null;

  if (row.provider === 'ms_todo' || row.provider === 'todoist') {
    pushProvider = row.provider;
    providerContainerId = row.external_id;
    // Hidden nexus mirror mapped to this provider container.
    const mirrors = db.prepare(
      `SELECT CAST(nexus_list_id AS INTEGER) AS mirror_id
       FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_container_id = ?`,
    ).all(tenantId, userId, row.provider, row.external_id) as Array<{ mirror_id: number | null }>;
    for (const mirror of mirrors) {
      const mirrorId = Number(mirror.mirror_id);
      if (!Number.isFinite(mirrorId)) continue;
      const mirrorRow = db.prepare(
        `SELECT id FROM unified_projects
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND id = ? AND provider = 'nexus'
         LIMIT 1`,
      ).get(userId, tenantId, mirrorId) as { id: number } | undefined;
      if (mirrorRow) projectIds.add(mirrorRow.id);
    }
  } else {
    const mapping = db.prepare(
      `SELECT provider, provider_container_id
       FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ?
         AND provider IN ('ms_todo', 'todoist')
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(tenantId, userId, String(row.id)) as { provider: 'ms_todo' | 'todoist'; provider_container_id: string } | undefined;
    if (mapping) {
      pushProvider = mapping.provider;
      providerContainerId = mapping.provider_container_id;
      const providerRow = db.prepare(
        `SELECT id FROM unified_projects
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ? AND external_id = ?
         LIMIT 1`,
      ).get(userId, tenantId, mapping.provider, mapping.provider_container_id) as { id: number } | undefined;
      if (providerRow) projectIds.add(providerRow.id);
    }
  }

  return { projectIds: [...projectIds], pushProvider, providerContainerId };
}

/**
 * Delete a task list through the ledger (NEX-10 delete fix): the local row
 * (and its mapped twin, mappings, and contained tasks) disappears from
 * GET /lists immediately, and a `list.delete` mutation carrying the PROVIDER
 * container id journals the provider push. Todoist list deletion is not
 * supported from Nexus, so todoist-backed rows delete locally only (synced
 * short-circuit) — the reconciliation pull remains the arbiter there.
 */
export function deleteOfflineFirstTaskList(tenantId: number, userId: number, input: TaskListDeleteMutationInput) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const operation = 'list.delete';
  const { clientMutationId, idempotencyKey } = mutationKeys(tenantId, userId, operation, input);
  const existingMutation = findExistingMutation(tenantId, userId, operation, clientMutationId, idempotencyKey);
  if (existingMutation) {
    recordDuplicatePreventionHit(tenantId, userId, existingMutation);
    return {
      deleted: true,
      mutationId: existingMutation.mutation_id,
      clientMutationId: existingMutation.client_mutation_id,
      idempotencyKey: existingMutation.idempotency_key,
      idempotentReplay: true,
    };
  }

  const row = getProjectRowForListRef(tenantId, userId, input.listId);
  if (!row) {
    const err = new Error('List not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  if (row.is_default) {
    const err = new Error('Cannot delete the default list');
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const scope = listDeletionScope(tenantId, userId, row);
  const willPush = scope.pushProvider === 'ms_todo' && !!scope.providerContainerId;
  const db = getDb();
  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const deletedAt = nowIso();
    const idPlaceholders = scope.projectIds.map(() => '?').join(', ');
    // Contained tasks are removed with the list (the provider's deleteList
    // cascades the same way); no per-task mutations — the list.delete push
    // covers them.
    db.prepare(
      `UPDATE unified_tasks
       SET is_deleted = 1, deleted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND is_deleted = 0
         AND project_id IN (${idPlaceholders})`,
    ).run(deletedAt, deletedAt, tenantId, userId, ...scope.projectIds);
    db.prepare(
      `DELETE FROM task_container_mappings
       WHERE tenant_id = ? AND user_id = ?
         AND (nexus_list_id IN (${scope.projectIds.map(() => '?').join(', ')})
              OR provider_container_id = COALESCE(?, ''))`,
    ).run(tenantId, userId, ...scope.projectIds.map(String), scope.providerContainerId);
    db.prepare(
      `DELETE FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND id IN (${idPlaceholders})`,
    ).run(userId, tenantId, ...scope.projectIds);

    // Legacy native mirror: the backfill re-creates any native_task_lists row
    // on the next read, so the native list (and its tasks) must go with the
    // unified row — same hard-delete the legacy native deleteList performed.
    if (row.provider === 'nexus' && legacyNativeTaskTablesAvailable()) {
      const nativeLists = db.prepare(
        `SELECT id FROM native_task_lists
         WHERE user_id = ? AND lower(name) = lower(?)`,
      ).all(userId, row.name) as Array<{ id: number }>;
      for (const nativeList of nativeLists) {
        db.prepare('DELETE FROM native_tasks WHERE list_id = ? AND user_id = ?').run(nativeList.id, userId);
        db.prepare('DELETE FROM native_task_lists WHERE id = ? AND user_id = ?').run(nativeList.id, userId);
      }
    }

    db.prepare(
      `INSERT INTO task_mutations (
         mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
         task_id, operation, patch_json, submitted_at, status
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      mutationId,
      clientMutationId,
      idempotencyKey,
      tenantId,
      userId,
      operation,
      JSON.stringify({
        listId: String(row.id),
        name: row.name,
        provider: willPush ? 'ms_todo' : 'nexus_local',
        providerContainerId: willPush ? scope.providerContainerId : null,
      }),
      nowIso(),
      willPush ? 'queued' : 'synced',
    );
    return { mutationId };
  })();

  kickAfterJournal(tenantId, userId, willPush ? 'queued' : 'synced');

  return {
    deleted: true,
    mutationId: result.mutationId,
    clientMutationId,
    idempotencyKey,
    idempotentReplay: false,
  };
}

function isCompletedDto(task: OfflineTaskDto): boolean {
  return ['completed', 'complete', 'done', 'cancelled', 'canceled'].includes(
    String(task.status || '').trim().toLowerCase(),
  );
}

function dateKey(value: string | null, timezone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isDueToday(task: OfflineTaskDto, userId: number): boolean {
  const timezone = getUserTimezoneById(userId);
  const due = dateKey(task.dueDateTime, timezone);
  const today = dateKey(nowIso(), timezone);
  return !!due && !!today && due === today;
}

function isOverdue(task: OfflineTaskDto, userId: number): boolean {
  const timezone = getUserTimezoneById(userId);
  const due = dateKey(task.dueDateTime, timezone);
  const today = dateKey(nowIso(), timezone);
  return !!due && !!today && due < today;
}
