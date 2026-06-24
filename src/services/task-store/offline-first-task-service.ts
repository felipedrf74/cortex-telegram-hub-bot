// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from '../database';
import { getUserTimezoneById } from '../user-service';
import { resolveTaskProvider, type TaskProviderType } from './task-router';
import { getOpenTaskSyncWarningsForTasks, recordTaskSyncIssue } from './task-sync-issues';
import { resolveTaskSyncTarget } from './task-sync-policy';

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
  | 'manual_resolution_required';

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
}

export interface TaskMoveMutationInput {
  taskId: string;
  targetListId: string;
  idempotencyKey?: string;
  clientMutationId?: string;
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
    syncProvider: row.provider || 'nexus',
    syncState,
    syncWarnings: [
      ...(completed && syncState === 'provider_missing' ? [] : warningForState(syncState, row.provider)),
      ...visibleIssueWarnings,
    ],
    localVersion: row.local_version || 1,
    deletedAt: row.deleted_at || null,
  };
}

function rowsToDtos(
  tenantId: number,
  userId: number,
  rows: UnifiedTaskRow[],
  listNameById: Map<number, string>,
): OfflineTaskDto[] {
  const issueMap = getOpenTaskSyncWarningsForTasks(tenantId, userId, rows.map(rowTaskId));
  return rows.map((row) => rowToDto(row, listNameById, issueMap));
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
  const row = getDb().prepare(
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
  return row || null;
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

function providerStates(userId: number): TaskFreshness['providerStates'] {
  const rows = getDb().prepare(
    `SELECT provider, last_sync_at, status, error_message
     FROM task_sync_state
     WHERE user_id = ? AND provider IN ('ms_todo', 'todoist')`,
  ).all(userId) as Array<{ provider: 'ms_todo' | 'todoist'; last_sync_at: string | null; status: string; error_message: string | null }>;
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return (['ms_todo', 'todoist'] as const).map((provider) => {
    const row = byProvider.get(provider);
    if (!row) return { provider, state: 'disconnected' as const };
    if (row.status === 'syncing') return { provider, state: 'syncing' as const, lastSyncedAt: row.last_sync_at || undefined };
    if (row.status === 'error') {
      return {
        provider,
        state: 'failed' as const,
        lastSyncedAt: row.last_sync_at || undefined,
        lastErrorCode: row.error_message ? 'provider_sync_error' : undefined,
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
  const active = activeRows(tenantId, userId);
  const tasks = rowsToDtos(tenantId, userId, active, getProjectNameMap(tenantId, userId))
    .filter((task) => !isCompletedDto(task));
  return {
    lists: rows.map((row) => ({ id: String(row.id), name: row.name, taskCount: row.task_count || 0 })),
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
  options: { status?: string; pageSize?: number } = {},
) {
  assertScope(tenantId, userId);
  ensureNativeTasksBackfilled(tenantId, userId);
  const pageSize = Math.min(Math.max(Number(options.pageSize || 75), 1), 200);
  const listNameById = getProjectNameMap(tenantId, userId);
  const numericListId = Number(listId);
  const normalizedStatus = String(options.status || '').trim().toLowerCase();
  const filters = [
    'tenant_id = ?',
    'user_id = ?',
    'project_id = ?',
    'is_deleted = 0',
  ];
  const args: unknown[] = [
    tenantId,
    userId,
    Number.isFinite(numericListId) ? numericListId : -1,
  ];
  if (normalizedStatus === 'active') {
    filters.push(activeLikeStatusSql('status'));
    args.push(...COMPLETED_LIKE_STATUS_VALUES);
  } else if (normalizedStatus === 'completed') {
    filters.push(completedLikeStatusSql('status'));
    args.push(...COMPLETED_LIKE_STATUS_VALUES);
  }
  const rows = getDb().prepare(
    `SELECT * FROM unified_tasks
     WHERE ${filters.join(' AND ')}
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC
     LIMIT ?`,
  ).all(...args, pageSize) as UnifiedTaskRow[];
  let tasks = rowsToDtos(tenantId, userId, rows, listNameById);
  if (options.status === 'active') tasks = tasks.filter((task) => !isCompletedDto(task));
  if (options.status === 'completed') tasks = tasks.filter(isCompletedDto);
  const scope = normalizedStatus === 'completed'
    ? 'completed'
    : normalizedStatus === 'active'
      ? 'active'
      : 'all';
  return {
    listName: listNameById.get(numericListId) || 'Tasks',
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
    const project = getOrCreateProject(tenantId, userId, input.listName);
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

  const result = db.transaction(() => {
    const mutationId = randomId('task_mutation');
    const updatedAt = nowIso();
    const newSyncState: TaskSyncState = existingTask.syncState === 'local_only'
      ? 'local_only'
      : providerTargetWarning
        ? 'failed_permanent'
        : 'queued';
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
      newSyncState === 'local_only' ? 'synced' : providerTargetWarning ? 'failed' : 'queued',
    );
    return { mutationId };
  })();

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

	    return { mutationId, warning: target.warning, provider: target.provider };
	  })();

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
      issueCode: conflictRetry
        ? 'provider_conflict' as TaskSyncWarningCode
        : missingContainerCode,
      provider: link?.provider || null,
    };
  })();

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
  },
) {
  assertScope(tenantId, userId);
  const db = getDb();
  const existingTask = getTaskByNexusId(tenantId, userId, input.taskId);
  if (!existingTask) {
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
      input.operation,
      existingTask.localVersion,
      JSON.stringify(input.patch || {}),
      nowIso(),
      mutationStatus,
    );
    return { mutationId };
  })();

  return {
    task: getTaskByNexusId(tenantId, userId, input.taskId) || existingTask,
    mutationId: result.mutationId,
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
