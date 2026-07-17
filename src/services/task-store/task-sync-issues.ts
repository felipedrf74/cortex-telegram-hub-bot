// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from '../database';
import type { TaskSyncWarning, TaskSyncWarningCode } from './offline-first-task-service';

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function defaultIssueMessage(code: TaskSyncWarningCode, provider?: string | null): string {
  const providerName = provider === 'ms_todo' ? 'Microsoft To Do' : provider === 'todoist' ? 'Todoist' : 'Provider';
  switch (code) {
    case 'provider_disconnected':
      return `Saved locally. Sync will resume when ${providerName} reconnects.`;
    case 'provider_timeout':
      return `${providerName} timed out. Retry scheduled.`;
    case 'provider_rate_limited':
      return `${providerName} is rate-limited. Retry scheduled.`;
    case 'unsupported_field_local_only':
      return 'Saved in Nexus. Some details are local-only for this provider.';
    case 'provider_conflict':
      return `This task changed in ${providerName} too. Review conflict.`;
    case 'provider_task_missing':
      return `${providerName} no longer has this task.`;
    case 'provider_auth_expired':
      return `${providerName} authorization expired. Reconnect to resume sync.`;
    case 'provider_list_missing':
      return 'The provider list no longer exists. Choose a new sync target.';
    case 'provider_project_missing':
      return 'The provider project no longer exists. Choose a new sync target.';
    case 'retry_scheduled':
      return 'Provider sync failed. Retry scheduled.';
    case 'manual_resolution_required':
      return 'Provider sync needs user action.';
    case 'suspected_duplicate':
      return `Multiple ${providerName} tasks look like copies of this task. Review before sync resumes.`;
    default:
      return 'Task sync issue needs attention.';
  }
}

export function recordTaskSyncIssue(input: {
  tenantId: number;
  userId: number;
  taskId: string;
  provider?: string | null;
  code: TaskSyncWarningCode;
  message?: string;
  details?: Record<string, unknown>;
}): void {
  const db = getDb();
  const provider = input.provider || null;
  const existing = db.prepare(
    `SELECT id FROM task_sync_issues
     WHERE tenant_id = ? AND user_id = ? AND task_id = ?
       AND COALESCE(provider, '') = COALESCE(?, '')
       AND code = ? AND state = 'open'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(input.tenantId, input.userId, input.taskId, provider, input.code) as { id: string } | undefined;

  const message = input.message || defaultIssueMessage(input.code, provider);
  const detailsJson = JSON.stringify(input.details || {});
  if (existing) {
    db.prepare(
      `UPDATE task_sync_issues
       SET message = ?, details_json = ?, resolved_at = NULL
       WHERE id = ?`,
    ).run(message, detailsJson, existing.id);
    return;
  }

  db.prepare(
    `INSERT INTO task_sync_issues (
       id, task_id, tenant_id, user_id, provider, code, message, details_json, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(
    randomId('task_sync_issue'),
    input.taskId,
    input.tenantId,
    input.userId,
    provider,
    input.code,
    message,
    detailsJson,
  );
}

export function resolveTaskSyncIssue(input: {
  tenantId: number;
  userId: number;
  taskId: string;
  provider?: string | null;
  code?: TaskSyncWarningCode;
}): void {
  const where = [
    'tenant_id = ?',
    'user_id = ?',
    'task_id = ?',
    "state = 'open'",
  ];
  const args: unknown[] = [input.tenantId, input.userId, input.taskId];
  if (input.provider != null) {
    where.push("COALESCE(provider, '') = COALESCE(?, '')");
    args.push(input.provider);
  }
  if (input.code) {
    where.push('code = ?');
    args.push(input.code);
  }

  getDb().prepare(
    `UPDATE task_sync_issues
     SET state = 'resolved', resolved_at = datetime('now')
     WHERE ${where.join(' AND ')}`,
  ).run(...args);
}

export function getOpenTaskSyncWarningsForTasks(
  tenantId: number,
  userId: number,
  taskIds: string[],
): Map<string, TaskSyncWarning[]> {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  const warnings = new Map<string, TaskSyncWarning[]>();
  if (uniqueTaskIds.length === 0) return warnings;

  const chunkSize = 200;
  for (let i = 0; i < uniqueTaskIds.length; i += chunkSize) {
    const chunk = uniqueTaskIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT task_id, provider, code, message
       FROM task_sync_issues
       WHERE tenant_id = ? AND user_id = ? AND state = 'open'
         AND task_id IN (${placeholders})
       ORDER BY created_at ASC`,
    ).all(tenantId, userId, ...chunk) as Array<{
      task_id: string;
      provider: string | null;
      code: TaskSyncWarningCode;
      message: string | null;
    }>;

    for (const row of rows) {
      const list = warnings.get(row.task_id) || [];
      list.push({
        code: row.code,
        provider: row.provider || undefined,
        message: row.message || defaultIssueMessage(row.code, row.provider),
      });
      warnings.set(row.task_id, list);
    }
  }

  return warnings;
}
