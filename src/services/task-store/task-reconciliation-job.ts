// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../database';
import { isConnected } from '../oauth-store';
import { logger } from '../../utils/logger';
import { getTaskProviderForUser } from './task-router';
import { recordTaskSyncIssue, resolveTaskSyncIssue } from './task-sync-issues';
import type { TaskSyncWarningCode } from './offline-first-task-service';

type LinkProvider = 'ms_todo' | 'todoist' | 'nexus_local';

type ReconciliationLinkRow = {
  id: string;
  task_id: string;
  tenant_id: number;
  user_id: number;
  provider: LinkProvider;
  provider_account_id: string;
  provider_task_id: string | null;
  provider_list_id: string | null;
  provider_project_id: string | null;
  last_verified_at: string | null;
  link_state: string;
  project_name: string | null;
  task_sync_state: string | null;
  is_deleted: number;
};

export interface TaskReconciliationResult {
  scannedLinks: number;
  verifiedLinks: number;
  staleLinks: number;
  duplicateLinks: number;
  providerMissing: number;
  providerDisconnected: number;
  missingContainers: number;
  failed: number;
}

const DEFAULT_LIMIT = 50;
const VERIFY_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
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

function providerConnected(userId: number, provider: LinkProvider): boolean {
  if (provider === 'nexus_local') return true;
  try {
    return provider === 'ms_todo'
      ? isConnected(userId, 'outlook')
      : isConnected(userId, 'todoist');
  } catch {
    return false;
  }
}

function providerContainerId(row: ReconciliationLinkRow): string | null {
  return row.provider === 'ms_todo'
    ? row.provider_list_id
    : row.provider_project_id || row.provider_list_id;
}

function isProviderMissingResponse(value: any): boolean {
  if (value == null) return true;
  if (value && typeof value === 'object') {
    if (value.success === false) {
      const error = String(value.error || value.message || '').toLowerCase();
      return /not found|404|gone|missing/.test(error);
    }
    if (value.success === true && value.data == null) return true;
  }
  return false;
}

function markIssue(row: ReconciliationLinkRow, code: TaskSyncWarningCode, message: string, details: Record<string, unknown> = {}): void {
  recordTaskSyncIssue({
    tenantId: row.tenant_id,
    userId: row.user_id,
    taskId: row.task_id,
    provider: row.provider,
    code,
    message,
    details,
  });
}

function markLinkState(row: ReconciliationLinkRow, linkState: string, syncState: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE task_provider_links
       SET link_state = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(linkState, row.id);
    db.prepare(
      `UPDATE unified_tasks
       SET sync_state = ?, updated_at = datetime('now')
       WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
    ).run(syncState, row.tenant_id, row.user_id, row.task_id);
  })();
}

function markVerified(row: ReconciliationLinkRow): void {
  const verifiedAt = nowIso();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE task_provider_links
       SET link_state = 'linked',
           last_verified_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(verifiedAt, verifiedAt, row.id);
    if (['stale', 'provider_missing', 'provider_disconnected', 'failed_retryable'].includes(String(row.task_sync_state || ''))) {
      db.prepare(
        `UPDATE unified_tasks
         SET sync_state = 'synced', updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
      ).run(verifiedAt, row.tenant_id, row.user_id, row.task_id);
    }
  })();
  resolveTaskSyncIssue({ tenantId: row.tenant_id, userId: row.user_id, taskId: row.task_id, provider: row.provider });
}

function needsFreshnessCheck(row: ReconciliationLinkRow): boolean {
  if (!row.last_verified_at) return true;
  const verifiedAt = new Date(row.last_verified_at).getTime();
  return !Number.isFinite(verifiedAt) || Date.now() - verifiedAt > STALE_AFTER_MS;
}

function scanDuplicateProviderLinks(tenantId?: number, userId?: number): number {
  const where = [
    "provider != 'nexus_local'",
    'provider_task_id IS NOT NULL',
    "provider_task_id != ''",
    "link_state != 'orphaned'",
  ];
  const args: Array<number | string> = [];
  if (tenantId != null) {
    where.push('tenant_id = ?');
    args.push(tenantId);
  }
  if (userId != null) {
    where.push('user_id = ?');
    args.push(userId);
  }

  const duplicates = getDb().prepare(
    `SELECT tenant_id, user_id, provider, provider_account_id, provider_task_id,
            GROUP_CONCAT(task_id) AS task_ids,
            COUNT(*) AS count
     FROM task_provider_links
     WHERE ${where.join(' AND ')}
     GROUP BY tenant_id, user_id, provider, provider_account_id, provider_task_id
     HAVING COUNT(*) > 1`,
  ).all(...args) as Array<{
    tenant_id: number;
    user_id: number;
    provider: LinkProvider;
    provider_account_id: string;
    provider_task_id: string;
    task_ids: string;
    count: number;
  }>;

  for (const duplicate of duplicates) {
    const taskIds = String(duplicate.task_ids || '').split(',').filter(Boolean);
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `UPDATE task_provider_links
         SET link_state = 'conflict', updated_at = datetime('now')
         WHERE tenant_id = ? AND user_id = ? AND provider = ?
           AND provider_account_id = ? AND provider_task_id = ?`,
      ).run(
        duplicate.tenant_id,
        duplicate.user_id,
        duplicate.provider,
        duplicate.provider_account_id,
        duplicate.provider_task_id,
      );
      for (const taskId of taskIds) {
        db.prepare(
          `UPDATE unified_tasks
           SET sync_state = 'conflict', updated_at = datetime('now')
           WHERE tenant_id = ? AND user_id = ? AND nexus_task_id = ?`,
        ).run(duplicate.tenant_id, duplicate.user_id, taskId);
        recordTaskSyncIssue({
          tenantId: duplicate.tenant_id,
          userId: duplicate.user_id,
          taskId,
          provider: duplicate.provider,
          code: 'provider_conflict',
          message: 'Multiple Nexus tasks are linked to the same provider task. Review required.',
          details: {
            providerTaskId: duplicate.provider_task_id,
            duplicateCount: duplicate.count,
          },
        });
      }
    })();
  }

  return duplicates.length;
}

function reconciliationCandidates(limit: number, tenantId?: number, userId?: number): ReconciliationLinkRow[] {
  const where = [
    "l.provider != 'nexus_local'",
    "l.link_state NOT IN ('orphaned', 'pending_create', 'pending_update', 'pending_delete')",
    't.is_deleted = 0',
  ];
  const args: Array<number | string> = [];
  if (tenantId != null) {
    where.push('l.tenant_id = ?');
    args.push(tenantId);
  }
  if (userId != null) {
    where.push('l.user_id = ?');
    args.push(userId);
  }
  args.push(limit);

  return getDb().prepare(
    `SELECT l.*,
            t.project_name,
            t.sync_state AS task_sync_state,
            t.is_deleted
     FROM task_provider_links l
     INNER JOIN unified_tasks t
       ON t.tenant_id = l.tenant_id
      AND t.user_id = l.user_id
      AND t.nexus_task_id = l.task_id
     WHERE ${where.join(' AND ')}
     ORDER BY
       CASE WHEN l.last_verified_at IS NULL THEN 0 ELSE 1 END,
       l.last_verified_at ASC,
       l.updated_at ASC
     LIMIT ?`,
  ).all(...args) as ReconciliationLinkRow[];
}

async function reconcileLink(row: ReconciliationLinkRow, result: TaskReconciliationResult): Promise<void> {
  const containerId = providerContainerId(row);
  if (!containerId) {
    result.missingContainers += 1;
    const isTodoist = row.provider === 'todoist';
    markLinkState(row, 'stale', 'failed_permanent');
    markIssue(
      row,
      isTodoist ? 'provider_project_missing' : 'provider_list_missing',
      isTodoist
        ? 'The provider project no longer exists. Choose a new sync target.'
        : 'The provider list no longer exists. Choose a new sync target.',
      { reason: 'reconciliation_missing_container' },
    );
    return;
  }

  if (!providerConnected(row.user_id, row.provider)) {
    result.providerDisconnected += 1;
    markLinkState(row, 'disconnected', 'provider_disconnected');
    markIssue(row, 'provider_disconnected', 'Saved locally. Sync will resume when the provider reconnects.', {
      reason: 'reconciliation_provider_disconnected',
    });
    return;
  }

  if (!row.provider_task_id) {
    result.staleLinks += 1;
    markLinkState(row, 'stale', 'stale');
    markIssue(row, 'retry_scheduled', 'Provider link is stale. Reconciliation is waiting for provider task identity.', {
      reason: 'reconciliation_missing_provider_task_id',
    });
    return;
  }

  if (!needsFreshnessCheck(row) && row.link_state === 'linked') {
    return;
  }

  const providerApi = getTaskProviderForUser(row.user_id, row.provider === 'nexus_local' ? 'nexus' : row.provider);
  if (typeof providerApi.getTask !== 'function') {
    result.staleLinks += 1;
    markLinkState(row, 'stale', 'stale');
    markIssue(row, 'retry_scheduled', 'Provider link is stale. Reconciliation could not verify this provider yet.', {
      reason: 'reconciliation_get_task_unavailable',
    });
    return;
  }

  const providerResult = await withTimeout(
    Promise.resolve(providerApi.getTask(containerId, row.provider_task_id, row.project_name || 'Tasks')),
    VERIFY_TIMEOUT_MS,
    'task_provider_reconcile_get_task',
  );

  if (isProviderMissingResponse(providerResult)) {
    result.providerMissing += 1;
    markLinkState(row, 'provider_missing', 'provider_missing');
    markIssue(row, 'provider_task_missing', 'Provider no longer has this task.', {
      reason: 'reconciliation_provider_missing',
    });
    return;
  }

  if (providerResult && typeof providerResult === 'object' && (providerResult as any).success === false) {
    result.staleLinks += 1;
    markLinkState(row, 'stale', 'stale');
    markIssue(row, 'retry_scheduled', 'Provider link verification failed. Retry scheduled.', {
      reason: 'reconciliation_provider_error',
      error: String((providerResult as any).error || (providerResult as any).message || 'provider_error').slice(0, 200),
    });
    return;
  }

  result.verifiedLinks += 1;
  markVerified(row);
}

export async function runTaskProviderLinkReconciliation(options: {
  limit?: number;
  tenantId?: number;
  userId?: number;
} = {}): Promise<TaskReconciliationResult> {
  const limit = Math.min(Math.max(Number(options.limit || DEFAULT_LIMIT), 1), 200);
  const result: TaskReconciliationResult = {
    scannedLinks: 0,
    verifiedLinks: 0,
    staleLinks: 0,
    duplicateLinks: scanDuplicateProviderLinks(options.tenantId, options.userId),
    providerMissing: 0,
    providerDisconnected: 0,
    missingContainers: 0,
    failed: 0,
  };

  const rows = reconciliationCandidates(limit, options.tenantId, options.userId);
  for (const row of rows) {
    result.scannedLinks += 1;
    try {
      await reconcileLink(row, result);
    } catch (err) {
      result.failed += 1;
      logger.warn({
        err,
        userId: row.user_id,
        tenantId: row.tenant_id,
        provider: row.provider,
        taskId: row.task_id,
      }, 'Task provider link reconciliation failed');
      markLinkState(row, 'stale', 'stale');
      markIssue(row, 'retry_scheduled', 'Provider link reconciliation failed. Retry scheduled.', {
        reason: 'reconciliation_exception',
      });
    }
  }

  return result;
}
