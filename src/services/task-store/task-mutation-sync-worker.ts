// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { runWithContext } from '../../utils/request-context';
import { isConnected } from '../oauth-store';
import { getTaskProviderForUser } from './task-router';
import { projectTaskForProvider } from './task-provider-capabilities';
import { recordTaskSyncIssue, resolveTaskSyncIssue } from './task-sync-issues';
import { assertTransition } from './task-sync-transitions';
import { buildTaskSyncedSnapshot } from './task-sync-snapshot';
import { computeTaskContentFingerprint } from './todoist-correlation';
import type { OfflineTaskDto, TaskSyncState, TaskSyncWarningCode } from './offline-first-task-service';

type LinkProvider = 'ms_todo' | 'todoist' | 'nexus_local';

type TaskMutationRow = {
  mutation_id: string;
  client_mutation_id: string;
  idempotency_key: string;
  tenant_id: number;
  user_id: number;
  task_id: string | null;
  operation: string;
  base_local_version: number | null;
  patch_json: string;
  status: string;
  retry_count: number;
  provider_idempotency_key: string | null;
  created_at?: string | null;
};

type TaskProviderLinkRow = {
  id: string;
  task_id: string;
  tenant_id: number;
  user_id: number;
  provider: LinkProvider;
  provider_account_id: string;
  provider_task_id: string | null;
  provider_list_id: string | null;
  provider_project_id: string | null;
  provider_version: string | null;
  provider_updated_at?: string | null;
  link_state: string;
};

type UnifiedTaskRow = {
  id: number;
  tenant_id: number;
  user_id: number;
  provider: string;
  external_id: string;
  project_id: number | null;
  project_name: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  status: string;
  priority: number | null;
  due_date: string | null;
  due_is_datetime: number | null;
  provider_data: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  nexus_task_id: string;
  local_version: number | null;
  sync_state: TaskSyncState | null;
  deleted_at: string | null;
};

export interface TaskMutationSyncBatchResult {
  processed: number;
  synced: number;
  failedRetryable: number;
  failedPermanent: number;
  providerDisconnected: number;
  conflicts: number;
  deadLettered: number;
}

const DEFAULT_LIMIT = 25;
const PROVIDER_WRITE_TIMEOUT_MS = 12_000;
const STALE_TASK_LEASE_MINUTES = 10;
const MAX_RETRY_COUNT_BEFORE_DEAD_LETTER = 8;
// Auth-parked rows (401/403/not-connected → next_retry_at NULL) are re-armed
// once their provider is connected again; rows older than this are
// dead-lettered with an issue instead of retried against a long-gone grant.
const AUTH_PARK_REQUEUE_MAX_AGE_DAYS = 30;
const RATE_WINDOW_MS = 60_000;
const PROVIDER_WRITE_LIMITS = {
  global: 500,
  provider: 180,
  tenant: 90,
  account: 60,
};
const CIRCUIT_OPEN_AFTER_RETRYABLE_FAILURES = 5;
const CIRCUIT_OPEN_MS = 5 * 60_000;

const providerWriteRateBuckets = new Map<string, { windowStart: number; count: number }>();
const providerWriteCircuits = new Map<string, { failureCount: number; openedUntil: number; lastFailureAt: number }>();

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function priorityToImportance(value: unknown): 'low' | 'normal' | 'high' {
  const priority = typeof value === 'number' ? value : Number(value || 0);
  if (priority >= 3) return 'high';
  if (priority === 1) return 'low';
  return 'normal';
}

function normalizeChecklistItems(value: unknown): Array<{ id: string; displayName: string; isChecked: boolean }> {
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
    .filter((item): item is { id: string; displayName: string; isChecked: boolean } => item != null);
}

function rowToOfflineTask(row: UnifiedTaskRow): OfflineTaskDto {
  const providerData = parseJson<Record<string, unknown>>(row.provider_data, {});
  return {
    id: row.nexus_task_id,
    title: row.title || '(Untitled)',
    body: row.notes || row.description || null,
    importance: priorityToImportance(row.priority),
    status: row.is_deleted ? 'cancelled' : row.status,
    dueDateTime: row.due_date || null,
    recurrence: providerData.recurrence || null,
    listId: row.project_id != null ? String(row.project_id) : null,
    listName: row.project_name || null,
    checklistItems: normalizeChecklistItems(providerData.checklistItems),
    createdDateTime: row.created_at || null,
    syncProvider: row.provider || 'nexus',
    syncState: row.sync_state || 'queued',
    syncWarnings: [],
    localVersion: row.local_version || 1,
    deletedAt: row.deleted_at || null,
  };
}

function classifyProviderError(err: unknown): {
  code: TaskSyncWarningCode;
  syncState: TaskSyncState;
  retryable: boolean;
  linkState: string;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err || 'provider_sync_failed');
  const statusCode = extractProviderStatusCode(err);
  if (statusCode === 401 || statusCode === 403) {
    return { code: 'provider_auth_expired', syncState: 'provider_disconnected', retryable: false, linkState: 'disconnected', message };
  }
  if (statusCode === 412 || statusCode === 409) {
    return { code: 'provider_conflict', syncState: 'conflict', retryable: false, linkState: 'conflict', message };
  }
  if (statusCode === 429) {
    return { code: 'provider_rate_limited', syncState: 'failed_retryable', retryable: true, linkState: 'stale', message };
  }
  if (statusCode != null && statusCode >= 500 && statusCode <= 599) {
    return { code: 'provider_timeout', syncState: 'failed_retryable', retryable: true, linkState: 'stale', message };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { code: 'provider_task_missing', syncState: 'provider_missing', retryable: false, linkState: 'provider_missing', message };
  }
  if (statusCode === 400 || statusCode === 422) {
    return { code: 'manual_resolution_required', syncState: 'failed_permanent', retryable: false, linkState: 'stale', message };
  }
  const normalized = message.toLowerCase();
  if (/not connected|unauthorized|invalid_grant|auth|token|forbidden|401|403/.test(normalized)) {
    return { code: 'provider_auth_expired', syncState: 'provider_disconnected', retryable: false, linkState: 'disconnected', message };
  }
  if (/provider_conflict|precondition|if-match|etag|412|conflict/.test(normalized)) {
    return { code: 'provider_conflict', syncState: 'conflict', retryable: false, linkState: 'conflict', message };
  }
  if (/rate.?limit|429/.test(normalized)) {
    return { code: 'provider_rate_limited', syncState: 'failed_retryable', retryable: true, linkState: 'stale', message };
  }
  if (/timeout|timed out|econnreset|503|502|504/.test(normalized)) {
    return { code: 'provider_timeout', syncState: 'failed_retryable', retryable: true, linkState: 'stale', message };
  }
  if (/not found|404|gone/.test(normalized)) {
    return { code: 'provider_task_missing', syncState: 'provider_missing', retryable: false, linkState: 'provider_missing', message };
  }
  if (/bad request|400|unsupported|cannot accept/.test(normalized)) {
    return { code: 'manual_resolution_required', syncState: 'failed_permanent', retryable: false, linkState: 'stale', message };
  }
  return { code: 'retry_scheduled', syncState: 'failed_retryable', retryable: true, linkState: 'stale', message };
}

function extractProviderStatusCode(err: unknown): number | null {
  const candidates = [
    (err as any)?.statusCode,
    (err as any)?.status,
    (err as any)?.code,
    (err as any)?.response?.status,
    (err as any)?.response?.statusCode,
    (err as any)?.cause?.statusCode,
    (err as any)?.cause?.status,
    (err as any)?.data?.statusCode,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return null;
}

function retryAt(retryCount: number): string {
  const capped = Math.min(Math.max(retryCount + 1, 1), 8);
  const seconds = Math.min(15 * 2 ** capped, 60 * 60);
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function rateBucketAllowed(key: string, limit: number): boolean {
  const now = Date.now();
  const bucket = providerWriteRateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    providerWriteRateBuckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function providerCircuitKey(link: TaskProviderLinkRow): string {
  return `${link.provider}:${link.provider_account_id}`;
}

function providerWriteBudgetAllowed(tenantId: number, link: TaskProviderLinkRow): boolean {
  if (!rateBucketAllowed('global', PROVIDER_WRITE_LIMITS.global)) return false;
  if (!rateBucketAllowed(`provider:${link.provider}`, PROVIDER_WRITE_LIMITS.provider)) return false;
  if (!rateBucketAllowed(`tenant:${tenantId}`, PROVIDER_WRITE_LIMITS.tenant)) return false;
  return rateBucketAllowed(`account:${providerCircuitKey(link)}`, PROVIDER_WRITE_LIMITS.account);
}

function assertProviderCircuitClosed(link: TaskProviderLinkRow): void {
  const circuit = providerWriteCircuits.get(providerCircuitKey(link));
  if (!circuit || circuit.openedUntil <= Date.now()) return;
  throw new Error(`${link.provider}_provider_timeout_circuit_open`);
}

function recordProviderWriteSuccess(link: TaskProviderLinkRow | null): void {
  if (!link || link.provider === 'nexus_local') return;
  providerWriteCircuits.delete(providerCircuitKey(link));
}

function recordProviderWriteFailure(link: TaskProviderLinkRow | null, failure: {
  code: TaskSyncWarningCode;
  retryable: boolean;
}): void {
  if (!link || link.provider === 'nexus_local' || !failure.retryable) return;
  if (!['provider_timeout', 'provider_rate_limited', 'retry_scheduled'].includes(failure.code)) return;
  const key = providerCircuitKey(link);
  const now = Date.now();
  const existing = providerWriteCircuits.get(key);
  const failureCount = existing && now - existing.lastFailureAt <= CIRCUIT_OPEN_MS
    ? existing.failureCount + 1
    : 1;
  providerWriteCircuits.set(key, {
    failureCount,
    lastFailureAt: now,
    openedUntil: failureCount >= CIRCUIT_OPEN_AFTER_RETRYABLE_FAILURES
      ? now + CIRCUIT_OPEN_MS
      : existing?.openedUntil || 0,
  });
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

function readyMutations(limit: number, scope: { tenantId?: number; userId?: number } = {}): TaskMutationRow[] {
  const where: string[] = [
    `(status IN ('queued', 'accepted_local')
      OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
      OR (
        status = 'syncing'
        AND locked_at IS NOT NULL
        AND julianday('now') - julianday(locked_at) > ? / 1440.0
      ))`,
  ];
  const args: Array<string | number> = [nowIso(), STALE_TASK_LEASE_MINUTES];
  if (scope.tenantId != null) {
    where.push('tenant_id = ?');
    args.push(scope.tenantId);
  }
  if (scope.userId != null) {
    where.push('user_id = ?');
    args.push(scope.userId);
  }
  args.push(limit);
  return getDb().prepare(
    `SELECT *
     FROM task_mutations
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(...args) as TaskMutationRow[];
}

function getTaskForMutation(mutation: TaskMutationRow): UnifiedTaskRow | null {
  if (!mutation.task_id) return null;
  const row = getDb().prepare(
    `SELECT *
     FROM unified_tasks
     WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?
     LIMIT 1`,
  ).get(mutation.tenant_id, mutation.user_id, mutation.task_id) as UnifiedTaskRow | undefined;
  return row || null;
}

function mutationProviderFilter(mutation: TaskMutationRow): LinkProvider | null {
  const patch = parseJson<Record<string, unknown>>(mutation.patch_json, {});
  const raw = patch.providerLinkProvider || patch.provider;
  if (raw === 'microsoft_todo') return 'ms_todo';
  if (raw === 'ms_todo' || raw === 'todoist' || raw === 'nexus_local') return raw;
  if (raw === 'nexus') return 'nexus_local';
  return null;
}

function getProviderLink(mutation: TaskMutationRow): TaskProviderLinkRow | null {
  if (!mutation.task_id) return null;
  const providerFilter = mutationProviderFilter(mutation);
  const providerWhere = providerFilter ? 'AND provider = ?' : '';
  const args: Array<string | number> = [mutation.tenant_id, mutation.user_id, mutation.task_id];
  if (providerFilter) args.push(providerFilter);
  const row = getDb().prepare(
    `SELECT *
     FROM task_provider_links
     WHERE tenant_id = ? AND user_id = ? AND task_id = ?
       ${providerWhere}
     ORDER BY
       CASE link_state
         WHEN 'pending_delete' THEN CASE WHEN ? = 'task.delete' THEN 0 ELSE 2 END
         WHEN 'pending_create' THEN CASE WHEN ? = 'task.delete' THEN 1 ELSE 0 END
         WHEN 'pending_update' THEN 1
         WHEN 'linked' THEN 3
         ELSE 4
       END,
       updated_at DESC
     LIMIT 1`,
  ).get(...args, mutation.operation, mutation.operation) as TaskProviderLinkRow | undefined;
  return row || null;
}

function markMutationSyncing(mutation: TaskMutationRow, providerIdempotencyKey: string): void {
  getDb().prepare(
    `UPDATE task_mutations
     SET status = 'syncing',
         locked_at = ?,
         worker_id = ?,
         provider_idempotency_key = COALESCE(provider_idempotency_key, ?)
	     WHERE mutation_id = ? AND status IN ('queued', 'accepted_local', 'failed', 'syncing')`,
  ).run(nowIso(), `task-worker:${process.pid}`, providerIdempotencyKey, mutation.mutation_id);
}

function markSynced(mutation: TaskMutationRow, task: UnifiedTaskRow | null, link: TaskProviderLinkRow | null, input: {
  providerTaskId?: string | null;
  providerVersion?: string | null;
  providerUpdatedAt?: string | null;
  syncState?: TaskSyncState;
  localOnlyFields?: string[];
} = {}): void {
  const db = getDb();
  const completedAt = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE task_mutations
       SET status = 'synced',
           completed_at = ?,
           last_error_code = NULL,
           last_error_message = NULL,
           next_retry_at = NULL,
           locked_at = NULL
       WHERE mutation_id = ?`,
    ).run(completedAt, mutation.mutation_id);

    if (task) {
      db.prepare(
        `UPDATE unified_tasks
         SET sync_state = ?,
             updated_at = CASE WHEN is_deleted = 1 THEN updated_at ELSE datetime('now') END
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(input.syncState || 'synced', task.tenant_id, task.user_id, task.nexus_task_id);
    }

    if (link) {
      // M2B snapshot capture: record the local content this push delivered as
      // the link's last agreed sync base (merge base for conflict resolution).
      // Deletes keep the prior snapshot — the link is being orphaned anyway.
      const syncedSnapshot = task && mutation.operation !== 'task.delete'
        ? buildTaskSyncedSnapshot({
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.due_date,
          dueIsDatetime: task.due_is_datetime,
          notes: task.notes ?? task.description,
        })
        : null;
      // Orphaned links (delete pushed) surrender their provider id: a
      // retained id would keep occupying the legacy UNIQUE slot and block
      // any future re-link of that provider task to a live row.
      db.prepare(
        `UPDATE task_provider_links
	         SET provider_task_id = CASE WHEN ? = 'task.delete' THEN NULL ELSE COALESCE(?, provider_task_id) END,
	             provider_version = COALESCE(?, provider_version),
	             provider_updated_at = COALESCE(?, provider_updated_at),
	             link_state = CASE WHEN ? = 'task.delete' THEN 'orphaned' ELSE 'linked' END,
	             last_synced_snapshot = COALESCE(?, last_synced_snapshot),
	             last_synced_at = ?,
             last_verified_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        mutation.operation,
        input.providerTaskId || null,
        input.providerVersion || null,
        input.providerUpdatedAt || null,
        mutation.operation,
        syncedSnapshot,
        completedAt,
        completedAt,
        completedAt,
        link.id,
      );
    }
  })();

  recordProviderWriteSuccess(link);

  if (mutation.task_id && link) {
    const db = getDb();
    db.prepare(
      `UPDATE task_sync_issues
       SET state = 'resolved', resolved_at = datetime('now')
       WHERE tenant_id = ? AND user_id = ? AND task_id = ?
         AND COALESCE(provider, '') = COALESCE(?, '')
         AND state = 'open'
         AND code <> 'unsupported_field_local_only'`,
    ).run(mutation.tenant_id, mutation.user_id, mutation.task_id, link.provider);
    if (!input.localOnlyFields || input.localOnlyFields.length === 0) {
      resolveTaskSyncIssue({
        tenantId: mutation.tenant_id,
        userId: mutation.user_id,
        taskId: mutation.task_id,
        provider: link.provider,
        code: 'unsupported_field_local_only',
      });
    }
  }
}

function markFailure(mutation: TaskMutationRow, task: UnifiedTaskRow | null, link: TaskProviderLinkRow | null, failure: {
  code: TaskSyncWarningCode;
  syncState: TaskSyncState;
  retryable: boolean;
  linkState: string;
  message: string;
}): void {
  const db = getDb();
  const nextRetry = failure.retryable ? retryAt(mutation.retry_count) : null;
  db.transaction(() => {
    db.prepare(
      `UPDATE task_mutations
       SET status = ?,
           retry_count = retry_count + 1,
           last_error_code = ?,
           last_error_message = ?,
           next_retry_at = ?,
           locked_at = NULL
       WHERE mutation_id = ?`,
    ).run(
      failure.syncState === 'conflict' ? 'conflict' : 'failed',
      failure.code,
      failure.message.slice(0, 500),
      nextRetry,
      mutation.mutation_id,
    );

    if (task) {
      db.prepare(
        `UPDATE unified_tasks
         SET sync_state = ?, updated_at = datetime('now')
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(failure.syncState, task.tenant_id, task.user_id, task.nexus_task_id);
    }

    if (link) {
      db.prepare(
        `UPDATE task_provider_links
         SET link_state = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(failure.linkState, link.id);
    }
  })();

  if (mutation.task_id) {
    recordTaskSyncIssue({
      tenantId: mutation.tenant_id,
      userId: mutation.user_id,
      taskId: mutation.task_id,
      provider: link?.provider,
      code: failure.code,
      message: failure.message,
      details: { retryable: failure.retryable, nextRetry },
    });
  }

  recordProviderWriteFailure(link, failure);
}

function markDeadLetter(mutation: TaskMutationRow, code: TaskSyncWarningCode, message: string): void {
  getDb().prepare(
    `UPDATE task_mutations
     SET status = 'dead_letter',
         last_error_code = ?,
         last_error_message = ?,
         locked_at = NULL
     WHERE mutation_id = ?`,
  ).run(code, message.slice(0, 500), mutation.mutation_id);
  if (mutation.task_id) {
    recordTaskSyncIssue({
      tenantId: mutation.tenant_id,
      userId: mutation.user_id,
      taskId: mutation.task_id,
      code,
      message,
      details: { reason: 'dead_letter' },
    });
  }
}

function providerContainerId(link: TaskProviderLinkRow): string | null {
  return link.provider === 'ms_todo' ? link.provider_list_id : link.provider_project_id || link.provider_list_id;
}

function extractProviderTaskId(value: any): string | null {
  const candidates = [
    value?.data?.id,
    value?.data?.externalId,
    value?.task?.id,
    value?.id,
    value?.externalId,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate);
  }
  return null;
}

function extractProviderVersion(value: any): string | null {
  const data = value?.data || value?.task || value || {};
  const providerData = data.providerData || {};
  const candidates = [
    data.providerVersion,
    data['@odata.etag'],
    data.etag,
    data.eTag,
    providerData['@odata.etag'],
    providerData.etag,
    providerData.eTag,
    providerData.revision,
    providerData.sync_id,
    providerData.syncId,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate);
  }
  return null;
}

function extractProviderUpdatedAt(value: any): string | null {
  const data = value?.data || value?.task || value || {};
  const providerData = data.providerData || {};
  const candidates = [
    data.providerUpdatedAt,
    data.lastModifiedDateTime,
    data.updatedAt,
    data.updated_at,
    providerData.lastModifiedDateTime,
    providerData.updated_at,
    providerData.modified_at,
    providerData.updatedAt,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate);
  }
  return null;
}

function todoistProviderFingerprint(value: any): string | null {
  const data = value?.data || value?.task || value || {};
  if (!data || typeof data !== 'object') return null;
  return computeTaskContentFingerprint(data);
}

/**
 * Provider-version (etag/fingerprint) extraction, shared with the conflict
 * resolution flow (task-conflict-resolution.ts): Todoist has no etag, so the
 * link stores a content fingerprint; every other provider stores its etag.
 */
export function extractLinkProviderVersion(link: { provider: string }, value: any): string | null {
  if (link.provider === 'todoist') {
    return todoistProviderFingerprint(value);
  }
  return extractProviderVersion(value);
}

function providerExternalIds(value: any): string[] {
  const data = value?.data || value?.task || value || {};
  const providerData = data.providerData || {};
  const linkedResources = [
    ...(Array.isArray(data.linkedResources) ? data.linkedResources : []),
    ...(Array.isArray(providerData.linkedResources) ? providerData.linkedResources : []),
  ];
  const ids = linkedResources
    .map((resource: any) => resource?.externalId || resource?.external_id || resource?.externalID)
    .filter((candidate: unknown): candidate is string | number => candidate != null && String(candidate).trim().length > 0)
    .map((candidate: string | number) => String(candidate));
  const nexusIds = [
    data.nexusTaskId,
    data.nexus_task_id,
    providerData.nexusTaskId,
    providerData.nexus_task_id,
  ].filter((candidate): candidate is string | number => candidate != null && String(candidate).trim().length > 0)
    .map((candidate) => String(candidate));
  return [...ids, ...nexusIds];
}

function isTaskProviderConnected(userId: number, provider: LinkProvider): boolean {
  if (provider === 'nexus_local') return true;
  try {
    return provider === 'ms_todo'
      ? isConnected(userId, 'outlook')
      : isConnected(userId, 'todoist');
  } catch {
    return false;
  }
}

function ensureProviderSuccess(value: any, fallbackMessage: string): void {
  if (value && typeof value === 'object' && value.success === false) {
    const err = new Error(String(value.error || value.message || fallbackMessage));
    if (value.statusCode != null) (err as any).statusCode = value.statusCode;
    if (value.status != null) (err as any).status = value.status;
    throw err;
  }
}

type RecoveredProviderTask = {
  providerTaskId: string;
  providerVersion?: string | null;
  providerUpdatedAt?: string | null;
};

async function recoverProviderTaskFromSearch(providerApi: any, task: UnifiedTaskRow, link: TaskProviderLinkRow): Promise<RecoveredProviderTask | null> {
  let result: unknown;
  const containerId = providerContainerId(link);
  if (typeof providerApi.getTasks === 'function' && containerId) {
    result = await withTimeout(
      Promise.resolve(providerApi.getTasks(containerId, task.project_name || 'Tasks')),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_retry_list_scan',
    );
  } else if (typeof providerApi.searchTasks === 'function') {
    result = await withTimeout(
      Promise.resolve(providerApi.searchTasks(task.nexus_task_id)),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_search',
    );
  } else {
    return null;
  }
  const resultAny = result as any;
  const rows = Array.isArray(resultAny?.data) ? resultAny.data : Array.isArray(resultAny) ? resultAny : [];
  const matches = rows.filter((candidate: any) => {
    const externalIds = providerExternalIds(candidate);
    const candidateListId = String(candidate?.listId || candidate?.parentFolderId || candidate?.project_id || candidate?.projectId || '');
    return externalIds.includes(task.nexus_task_id) && (!containerId || !candidateListId || candidateListId === containerId);
  });
  if (matches.length !== 1) return null;
  const providerTaskId = extractProviderTaskId(matches[0]);
  if (!providerTaskId) return null;
  return {
    providerTaskId,
    providerVersion: extractLinkProviderVersion(link, matches[0]),
    providerUpdatedAt: extractProviderUpdatedAt(matches[0]),
  };
}

async function assertTodoistProviderUnchanged(providerApi: any, mutation: TaskMutationRow, link: TaskProviderLinkRow, task: UnifiedTaskRow): Promise<void> {
  if (link.provider !== 'todoist') return;
  if (!['task.update', 'task.complete', 'task.reopen'].includes(mutation.operation)) return;
  if (!link.provider_task_id || typeof providerApi.getTask !== 'function') return;
  const containerId = providerContainerId(link);
  if (!containerId) return;
  const fresh = await withTimeout(
    Promise.resolve(providerApi.getTask(containerId, link.provider_task_id, task.project_name || 'Tasks')),
    PROVIDER_WRITE_TIMEOUT_MS,
    'task_provider_conflict_read',
  );
  ensureProviderSuccess(fresh, 'task_provider_conflict_read_failed');
  const knownVersion = link.provider_version || link.provider_updated_at;
  const freshVersion = knownVersion?.startsWith('fp:')
    ? todoistProviderFingerprint(fresh)
    : extractProviderVersion(fresh) || extractProviderUpdatedAt(fresh) || todoistProviderFingerprint(fresh);
  if (knownVersion && freshVersion && String(freshVersion) !== String(knownVersion)) {
    throw new Error('provider_conflict: provider task changed since last verified sync');
  }
}

async function reconcileProviderChecklistItems(providerApi: any, task: UnifiedTaskRow, link: TaskProviderLinkRow, providerTaskId: string): Promise<void> {
  if (link.provider !== 'ms_todo') return;
  if (typeof providerApi.getChecklistItems !== 'function' || typeof providerApi.addChecklistItem !== 'function') return;
  const desired = rowToOfflineTask(task).checklistItems || [];
  const containerId = providerContainerId(link);
  if (!containerId || desired.length === 0) return;

  const currentResult = await withTimeout(
    Promise.resolve(providerApi.getChecklistItems(containerId, providerTaskId)),
    PROVIDER_WRITE_TIMEOUT_MS,
    'task_provider_checklist_get',
  );
  ensureProviderSuccess(currentResult, 'task_provider_checklist_get_failed');
  const currentRows = Array.isArray((currentResult as any)?.data) ? (currentResult as any).data : [];
  const normalizeName = (value: unknown) => String(value || '').trim().toLowerCase();
  const currentByName = new Map<string, any>();
  for (const item of currentRows) {
    const name = normalizeName(item?.displayName || item?.title || item?.name);
    if (name) currentByName.set(name, item);
  }

  const desiredByName = new Map<string, { id: string; displayName: string; isChecked: boolean }>();
  for (const item of desired) {
    const name = normalizeName(item.displayName);
    if (name) desiredByName.set(name, item);
  }

  for (const item of desiredByName.values()) {
    const existing = currentByName.get(normalizeName(item.displayName));
    if (!existing) {
      const added = await withTimeout(
        Promise.resolve(providerApi.addChecklistItem(containerId, providerTaskId, item.displayName)),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_checklist_add',
      );
      ensureProviderSuccess(added, 'task_provider_checklist_add_failed');
      continue;
    }
    if (typeof providerApi.updateChecklistItem === 'function' && Boolean(existing.isChecked) !== Boolean(item.isChecked)) {
      const updated = await withTimeout(
        Promise.resolve(providerApi.updateChecklistItem(containerId, providerTaskId, existing.id, item.isChecked)),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_checklist_update',
      );
      ensureProviderSuccess(updated, 'task_provider_checklist_update_failed');
    }
  }

  if (typeof providerApi.deleteChecklistItem === 'function') {
    for (const existing of currentRows) {
      const name = normalizeName(existing?.displayName || existing?.title || existing?.name);
      if (!name || desiredByName.has(name) || !existing?.id) continue;
      const deleted = await withTimeout(
        Promise.resolve(providerApi.deleteChecklistItem(containerId, providerTaskId, existing.id)),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_checklist_delete',
      );
      ensureProviderSuccess(deleted, 'task_provider_checklist_delete_failed');
    }
  }
}

async function writeProviderMutation(mutation: TaskMutationRow, task: UnifiedTaskRow, link: TaskProviderLinkRow, providerIdempotencyKey: string): Promise<{
  providerTaskId: string | null;
  providerVersion?: string | null;
  providerUpdatedAt?: string | null;
  syncState?: TaskSyncState;
  localOnlyFields?: string[];
}> {
  if (link.provider === 'nexus_local') {
    return { providerTaskId: link.provider_task_id || task.nexus_task_id, syncState: 'local_only' };
  }

  if (!isTaskProviderConnected(mutation.user_id, link.provider)) {
    throw new Error(`${link.provider}_not_connected`);
  }

  const providerApi = getTaskProviderForUser(mutation.user_id, link.provider);
  const containerId = providerContainerId(link);
  if (!containerId && mutation.operation !== 'task.delete') {
    throw new Error(link.provider === 'todoist' ? 'provider_project_missing' : 'provider_list_missing');
  }
  assertProviderCircuitClosed(link);
  if (!providerWriteBudgetAllowed(mutation.tenant_id, link)) {
    throw new Error(`${link.provider}_provider_rate_limited_backpressure`);
  }

  const providerTaskId = link.provider_task_id;
  const taskDto = rowToOfflineTask(task);
  const projection = projectTaskForProvider(taskDto, link.provider);
  const projectedSyncState: TaskSyncState | undefined = projection.localOnlyFields.length > 0
    ? 'partially_synced'
    : undefined;
  for (const warning of projection.warnings) {
    recordTaskSyncIssue({
      tenantId: mutation.tenant_id,
      userId: mutation.user_id,
      taskId: task.nexus_task_id,
      provider: link.provider,
      code: warning.code,
      message: warning.message,
      details: { field: warning.field },
    });
  }

  if (mutation.operation === 'task.delete') {
    if (!providerTaskId || !containerId) return { providerTaskId: providerTaskId || null };
    const deleted = await withTimeout(
      Promise.resolve(providerApi.deleteTask(containerId, providerTaskId)),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_delete',
    );
    ensureProviderSuccess(deleted, 'task_provider_delete_failed');
    return { providerTaskId };
  }

  if (!providerTaskId) {
    const recovered = await recoverProviderTaskFromSearch(providerApi, task, link);
    if (recovered) {
      await reconcileProviderChecklistItems(providerApi, task, link, recovered.providerTaskId);
      return {
        providerTaskId: recovered.providerTaskId,
        providerVersion: recovered.providerVersion,
        providerUpdatedAt: recovered.providerUpdatedAt,
        syncState: projectedSyncState,
        localOnlyFields: projection.localOnlyFields,
      };
    }
    const created = await withTimeout(
      Promise.resolve(providerApi.createTask(containerId, task.project_name || 'Tasks', projection.providerPayload, {
        idempotencyKey: providerIdempotencyKey,
        nexusTaskId: task.nexus_task_id,
      })),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_create',
    );
    ensureProviderSuccess(created, 'task_provider_create_failed');
    const createdTaskId = extractProviderTaskId(created);
    if (!createdTaskId) throw new Error('provider_create_missing_task_id');
    await reconcileProviderChecklistItems(providerApi, task, link, createdTaskId);
    return {
      providerTaskId: createdTaskId,
      providerVersion: extractLinkProviderVersion(link, created),
      providerUpdatedAt: extractProviderUpdatedAt(created),
      syncState: projectedSyncState,
      localOnlyFields: projection.localOnlyFields,
    };
  }

  if (mutation.operation === 'task.move') {
    const recovered = await recoverProviderTaskFromSearch(providerApi, task, link);
    let movedProviderTaskId = recovered?.providerTaskId || null;
    let movedProviderVersion = recovered?.providerVersion || null;
    let movedProviderUpdatedAt = recovered?.providerUpdatedAt || null;
    if (!movedProviderTaskId) {
      const created = await withTimeout(
        Promise.resolve(providerApi.createTask(containerId, task.project_name || 'Tasks', projection.providerPayload, {
          idempotencyKey: providerIdempotencyKey,
          nexusTaskId: task.nexus_task_id,
        })),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_move_create',
      );
      ensureProviderSuccess(created, 'task_provider_move_create_failed');
      movedProviderTaskId = extractProviderTaskId(created);
      if (!movedProviderTaskId) throw new Error('provider_move_create_missing_task_id');
      movedProviderVersion = extractLinkProviderVersion(link, created);
      movedProviderUpdatedAt = extractProviderUpdatedAt(created);
    }

    const patch = parseJson<Record<string, any>>(mutation.patch_json, {});
    const previousContainers = patch.previousProviderContainers || {};
    const previous = previousContainers[link.provider] || {};
    const previousContainerId = link.provider === 'ms_todo'
      ? previous.providerListId || containerId
      : previous.providerProjectId || previous.providerListId || containerId;
    const deletedOriginal = await withTimeout(
      Promise.resolve(providerApi.deleteTask(previousContainerId, providerTaskId)),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_move_delete_original',
    );
    ensureProviderSuccess(deletedOriginal, 'task_provider_move_delete_original_failed');
    await reconcileProviderChecklistItems(providerApi, task, link, movedProviderTaskId);
    return {
      providerTaskId: movedProviderTaskId,
      providerVersion: movedProviderVersion,
      providerUpdatedAt: movedProviderUpdatedAt,
      syncState: projectedSyncState,
      localOnlyFields: projection.localOnlyFields,
    };
  }

  await assertTodoistProviderUnchanged(providerApi, mutation, link, task);

  if (mutation.operation === 'task.complete') {
    const completed = await withTimeout(
      Promise.resolve(providerApi.completeTask(containerId, providerTaskId, task.project_name || 'Tasks', {
        ifMatch: link.provider === 'ms_todo' ? link.provider_version || undefined : undefined,
      })),
      PROVIDER_WRITE_TIMEOUT_MS,
      'task_provider_complete',
    );
    ensureProviderSuccess(completed, 'task_provider_complete_failed');
    return {
    providerTaskId,
    providerVersion: extractLinkProviderVersion(link, completed),
      providerUpdatedAt: extractProviderUpdatedAt(completed),
      syncState: projectedSyncState,
      localOnlyFields: projection.localOnlyFields,
    };
  }

  if (mutation.operation === 'task.reopen') {
    let reopened: unknown;
    if (typeof providerApi.uncompleteTask === 'function') {
      reopened = await withTimeout(
        Promise.resolve(providerApi.uncompleteTask(containerId, providerTaskId, task.project_name || 'Tasks', {
          ifMatch: link.provider === 'ms_todo' ? link.provider_version || undefined : undefined,
        })),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_reopen',
      );
    } else {
      reopened = await withTimeout(
        Promise.resolve(providerApi.updateTask(containerId, providerTaskId, { status: 'notStarted' }, task.project_name || 'Tasks', {
          ifMatch: link.provider === 'ms_todo' ? link.provider_version || undefined : undefined,
          nexusTaskId: task.nexus_task_id,
        })),
        PROVIDER_WRITE_TIMEOUT_MS,
        'task_provider_reopen',
      );
    }
    ensureProviderSuccess(reopened, 'task_provider_reopen_failed');
    return {
    providerTaskId,
      providerVersion: extractLinkProviderVersion(link, reopened),
      providerUpdatedAt: extractProviderUpdatedAt(reopened),
      syncState: projectedSyncState,
      localOnlyFields: projection.localOnlyFields,
    };
  }

  if (typeof providerApi.updateTask !== 'function') {
    throw new Error('provider_update_unsupported');
  }
  const updated = await withTimeout(
    Promise.resolve(providerApi.updateTask(containerId, providerTaskId, projection.providerPayload, task.project_name || 'Tasks', {
      ifMatch: link.provider === 'ms_todo' ? link.provider_version || undefined : undefined,
      nexusTaskId: task.nexus_task_id,
    })),
    PROVIDER_WRITE_TIMEOUT_MS,
    'task_provider_update',
  );
  ensureProviderSuccess(updated, 'task_provider_update_failed');
  await reconcileProviderChecklistItems(providerApi, task, link, providerTaskId);
  return {
    providerTaskId,
    providerVersion: extractLinkProviderVersion(link, updated),
    providerUpdatedAt: extractProviderUpdatedAt(updated),
    syncState: projectedSyncState,
    localOnlyFields: projection.localOnlyFields,
  };
}

async function processMutation(mutation: TaskMutationRow): Promise<'synced' | 'failed_retryable' | 'failed_permanent' | 'provider_disconnected' | 'conflict' | 'dead_letter'> {
  if (mutation.status === 'failed' && mutation.retry_count >= MAX_RETRY_COUNT_BEFORE_DEAD_LETTER) {
    markDeadLetter(mutation, 'manual_resolution_required', 'Task provider sync exceeded the retry limit and needs user-visible repair.');
    return 'dead_letter';
  }

  const task = getTaskForMutation(mutation);
  const link = getProviderLink(mutation);
  const providerIdempotencyKey = link
    ? `${link.provider}:${link.provider_account_id}:${mutation.task_id || 'unknown'}:${mutation.operation}:${mutation.mutation_id}`
    : `nexus_local:${mutation.user_id}:${mutation.task_id || 'unknown'}:${mutation.operation}:${mutation.mutation_id}`;
  markMutationSyncing(mutation, providerIdempotencyKey);

  if (!task) {
    markDeadLetter(mutation, 'manual_resolution_required', 'Task mutation has no matching Nexus task row.');
    return 'dead_letter';
  }
  const providerCleanupDelete = mutation.operation === 'task.delete'
    && link
    && link.provider !== 'nexus_local'
    && link.link_state === 'pending_delete';
  if (!link || link.provider === 'nexus_local' || (task.sync_state === 'local_only' && !providerCleanupDelete)) {
    markSynced(mutation, task, link, { providerTaskId: task.nexus_task_id, syncState: 'local_only' });
    return 'synced';
  }
  if (task.sync_state === 'conflict') {
    markFailure(mutation, task, link, {
      code: 'provider_conflict',
      syncState: 'conflict',
      retryable: false,
      linkState: 'conflict',
      message: 'Task has unresolved local/provider conflict.',
    });
    return 'conflict';
  }

  try {
    const providerWrite = await runWithContext(
      {
        source: 'cron:task_mutation_sync',
        userId: mutation.user_id,
        tenantId: mutation.tenant_id,
      },
      () => writeProviderMutation(mutation, task, link, providerIdempotencyKey),
    );
    markSynced(mutation, task, link, {
      providerTaskId: providerWrite.providerTaskId,
      providerVersion: providerWrite.providerVersion,
      providerUpdatedAt: providerWrite.providerUpdatedAt,
      syncState: providerCleanupDelete
        ? task.sync_state || 'queued'
        : task.is_deleted ? 'synced' : providerWrite.syncState || 'synced',
      localOnlyFields: providerWrite.localOnlyFields,
    });
    return 'synced';
  } catch (err) {
    const failure = classifyProviderError(err);
    if (mutation.operation === 'task.delete' && failure.code === 'provider_task_missing') {
      markSynced(mutation, task, link, { providerTaskId: link.provider_task_id, syncState: 'synced' });
      return 'synced';
    }
    if (/provider_list_missing|provider_project_missing/.test(failure.message)) {
      failure.code = failure.message.includes('project') ? 'provider_project_missing' : 'provider_list_missing';
      failure.syncState = 'failed_permanent';
      failure.retryable = false;
      failure.linkState = 'stale';
    }
    markFailure(mutation, task, link, failure);
    if (failure.syncState === 'provider_disconnected') return 'provider_disconnected';
    if (failure.syncState === 'conflict') return 'conflict';
    return failure.retryable ? 'failed_retryable' : 'failed_permanent';
  }
}

/**
 * Re-arm mutations parked by an auth failure (`provider_auth_expired` →
 * status 'failed' with next_retry_at NULL, which readyMutations never
 * re-selects) once their provider is connected again. Reconnect used to be
 * pull-only, so these rows were stranded forever and the next pull silently
 * masked the divergence (NEX-03). Runs at every batch start, so both the
 * OAuth-reconnect kick and the cron pick the rows up in the same tick.
 *
 * Scoping: only auth-parked rows. Permanent failures with other codes
 * (provider_list_missing, manual_resolution_required) and rows with no
 * error code stay parked — re-arming them would just burn the dead-letter
 * retry budget until their root cause is repaired.
 */
export function requeueAuthParkedMutations(scope: {
  tenantId?: number;
  userId?: number;
} = {}): { requeued: number; deadLettered: number } {
  const db = getDb();
  const where: string[] = [
    "status = 'failed'",
    'next_retry_at IS NULL',
    "last_error_code = 'provider_auth_expired'",
  ];
  const args: unknown[] = [];
  if (scope.tenantId != null) {
    where.push('COALESCE(tenant_id, user_id) = ?');
    args.push(scope.tenantId);
  }
  if (scope.userId != null) {
    where.push('user_id = ?');
    args.push(scope.userId);
  }
  const rows = db.prepare(
    `SELECT * FROM task_mutations WHERE ${where.join(' AND ')}`,
  ).all(...args) as TaskMutationRow[];

  let requeued = 0;
  let deadLettered = 0;
  for (const mutation of rows) {
    const link = mutation.task_id
      ? getProviderLink(mutation)
      : null;
    if (!link || link.provider === 'nexus_local') continue;
    if (!isTaskProviderConnected(mutation.user_id, link.provider)) continue;

    const createdAt = Date.parse(`${mutation.created_at || ''}`);
    const ageDays = Number.isFinite(createdAt)
      ? (Date.now() - createdAt) / 86_400_000
      : 0;
    if (ageDays > AUTH_PARK_REQUEUE_MAX_AGE_DAYS) {
      assertTransition('mutation_status', 'failed', 'dead_letter', { mutationId: mutation.mutation_id });
      markDeadLetter(
        mutation,
        'provider_auth_expired',
        `Mutation parked for ${Math.floor(ageDays)} days while the provider was disconnected; exceeded the ${AUTH_PARK_REQUEUE_MAX_AGE_DAYS}-day requeue window and needs manual review.`,
      );
      deadLettered += 1;
      continue;
    }

    db.prepare(
      `UPDATE task_mutations
       SET next_retry_at = ?, locked_at = NULL
       WHERE mutation_id = ? AND status = 'failed' AND next_retry_at IS NULL`,
    ).run(nowIso(), mutation.mutation_id);
    requeued += 1;
  }

  if (requeued > 0 || deadLettered > 0) {
    logger.info(
      { requeued, deadLettered, tenantId: scope.tenantId, userId: scope.userId },
      'Re-armed auth-parked task mutations after provider reconnect',
    );
  }
  return { requeued, deadLettered };
}

export async function runTaskMutationSyncBatch(options: {
  limit?: number;
  tenantId?: number;
  userId?: number;
} = {}): Promise<TaskMutationSyncBatchResult> {
  const limit = Math.min(Math.max(Number(options.limit || DEFAULT_LIMIT), 1), 100);
  try {
    requeueAuthParkedMutations({ tenantId: options.tenantId, userId: options.userId });
  } catch (err) {
    logger.warn({ err }, 'Auth-parked mutation requeue failed (non-fatal)');
  }
  const mutations = readyMutations(limit, { tenantId: options.tenantId, userId: options.userId });

  const result: TaskMutationSyncBatchResult = {
    processed: 0,
    synced: 0,
    failedRetryable: 0,
    failedPermanent: 0,
    providerDisconnected: 0,
    conflicts: 0,
    deadLettered: 0,
  };

  for (const mutation of mutations) {
    result.processed += 1;
    try {
      const status = await processMutation(mutation);
      if (status === 'synced') result.synced += 1;
      else if (status === 'failed_retryable') result.failedRetryable += 1;
      else if (status === 'failed_permanent') result.failedPermanent += 1;
      else if (status === 'provider_disconnected') result.providerDisconnected += 1;
      else if (status === 'conflict') result.conflicts += 1;
      else result.deadLettered += 1;
    } catch (err) {
      result.deadLettered += 1;
      logger.error({ err, mutationId: mutation.mutation_id }, 'Task mutation sync worker failed unexpectedly');
      markDeadLetter(
        mutation,
        'manual_resolution_required',
        err instanceof Error ? err.message : 'task_mutation_worker_failed',
      );
    }
  }

  return result;
}

export function getTaskSyncOperationalMetrics(tenantId?: number, userId?: number) {
  // Scoped to the requesting user when provided — the tenant-wide aggregate
  // leaked other members' backlog counts in multi-user tenants (NEX-26).
  const conditions: string[] = [];
  const scopeArgs: Array<number> = [];
  if (tenantId != null) {
    conditions.push('tenant_id = ?');
    scopeArgs.push(tenantId);
  }
  if (userId != null) {
    conditions.push('user_id = ?');
    scopeArgs.push(userId);
  }
  const tenantWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const args = scopeArgs;
  const db = getDb();
  const mutationRows = db.prepare(
    `SELECT status, COALESCE(last_error_code, '') AS error_code, COUNT(*) AS count,
            MAX(strftime('%s','now') - strftime('%s', created_at)) AS oldest_age_seconds,
            AVG(strftime('%s','now') - strftime('%s', created_at)) AS average_age_seconds
     FROM task_mutations
     ${tenantWhere}
     GROUP BY status, COALESCE(last_error_code, '')`,
  ).all(...args) as Array<{
    status: string;
    error_code: string;
    count: number;
    oldest_age_seconds: number | null;
    average_age_seconds: number | null;
  }>;
  const syncStateRows = db.prepare(
    `SELECT sync_state, COUNT(*) AS count
     FROM unified_tasks
     ${tenantWhere}
     GROUP BY sync_state`,
  ).all(...args) as Array<{ sync_state: string | null; count: number }>;
  const issueRows = db.prepare(
    `SELECT code, provider, COUNT(*) AS count
     FROM task_sync_issues
     ${tenantWhere ? `${tenantWhere} AND state = 'open'` : "WHERE state = 'open'"}
     GROUP BY code, provider`,
  ).all(...args) as Array<{ code: string; provider: string | null; count: number }>;
  const duplicateLinkRows = db.prepare(
    `SELECT provider, COUNT(*) AS duplicate_groups
     FROM (
       SELECT provider, provider_account_id, provider_task_id, COUNT(*) AS count
       FROM task_provider_links
       ${tenantWhere ? `${tenantWhere} AND` : 'WHERE'} provider != 'nexus_local'
         AND provider_task_id IS NOT NULL
         AND provider_task_id != ''
         AND link_state != 'orphaned'
       GROUP BY tenant_id, user_id, provider, provider_account_id, provider_task_id
       HAVING COUNT(*) > 1
     )
     GROUP BY provider`,
  ).all(...args) as Array<{ provider: string; duplicate_groups: number }>;
  const observabilityRows = (() => {
    try {
      return db.prepare(
        `SELECT event_type, operation, COUNT(*) AS count
         FROM task_sync_observability_events
         ${tenantWhere}
         GROUP BY event_type, operation`,
      ).all(...args) as Array<{ event_type: string; operation: string | null; count: number }>;
    } catch {
      return [];
    }
  })();
  const localOnlyTaskCount = syncStateRows
    .filter((row) => row.sync_state === 'local_only')
    .reduce((sum, row) => sum + row.count, 0);
  const providerDisconnectedTaskCount = syncStateRows
    .filter((row) => row.sync_state === 'provider_disconnected')
    .reduce((sum, row) => sum + row.count, 0);
  const providerMissingTaskCount = syncStateRows
    .filter((row) => row.sync_state === 'provider_missing')
    .reduce((sum, row) => sum + row.count, 0);
  const conflictTaskCount = syncStateRows
    .filter((row) => row.sync_state === 'conflict')
    .reduce((sum, row) => sum + row.count, 0);
  const providerTimeoutCount = issueRows
    .filter((row) => row.code === 'provider_timeout')
    .reduce((sum, row) => sum + row.count, 0);
  const providerRateLimitCount = issueRows
    .filter((row) => row.code === 'provider_rate_limited')
    .reduce((sum, row) => sum + row.count, 0);
  const openProviderCircuits = Array.from(providerWriteCircuits.entries())
    .filter(([, circuit]) => circuit.openedUntil > Date.now())
    .map(([key, circuit]) => ({
      key,
      failureCount: circuit.failureCount,
      openedUntil: new Date(circuit.openedUntil).toISOString(),
    }));
  const duplicatePreventionHits = observabilityRows
    .filter((row) => row.event_type === 'duplicate_prevention_hit')
    .reduce((sum, row) => sum + row.count, 0);

  return {
    generatedAt: nowIso(),
    mutationBacklog: mutationRows,
    taskSyncStates: syncStateRows.map((row) => ({ syncState: row.sync_state || 'unknown', count: row.count })),
    openIssues: issueRows,
    taskCounts: {
      localOnly: localOnlyTaskCount,
      providerDisconnected: providerDisconnectedTaskCount,
      providerMissing: providerMissingTaskCount,
      conflicts: conflictTaskCount,
    },
    providerFailureCounters: {
      providerTimeout: providerTimeoutCount,
      providerRateLimited: providerRateLimitCount,
    },
    duplicateProviderLinks: duplicateLinkRows.map((row) => ({
      provider: row.provider,
      duplicateGroups: row.duplicate_groups,
    })),
    duplicatePreventionHits,
    observabilityEvents: observabilityRows,
    backpressure: {
      rateWindowMs: RATE_WINDOW_MS,
      limits: PROVIDER_WRITE_LIMITS,
      openProviderCircuits,
    },
  };
}
