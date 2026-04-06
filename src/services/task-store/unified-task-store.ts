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

// ─── Row mapping ────────────────────────────────────────────────────────

interface UnifiedTaskRow {
  id: number;
  user_id: number;
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
}

interface UnifiedProjectRow {
  id: number;
  user_id: number;
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
export function upsertTask(userId: number, task: NormalizedTask): UpsertResult {
  const db = getDb();
  const hash = computeContentHash(task);

  const existing = db.prepare(
    'SELECT id, content_hash FROM unified_tasks WHERE user_id = ? AND provider = ? AND external_id = ?',
  ).get(userId, task.provider, task.externalId) as
    | { id: number; content_hash: string }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO unified_tasks (
        user_id, provider, external_id, project_id, project_name, title,
        description, status, priority, due_date, due_is_datetime, tags, notes,
        completed_at, assignee, url, provider_data, content_hash, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      userId,
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
    );
    return 'inserted';
  }

  // Hot path: hash unchanged → no write
  if (existing.content_hash === hash) return 'unchanged';

  db.prepare(
    `UPDATE unified_tasks SET
       title = ?, description = ?, status = ?, priority = ?,
       due_date = ?, due_is_datetime = ?, tags = ?, notes = ?,
       completed_at = ?, project_name = ?, project_id = ?, url = ?,
       provider_data = ?, content_hash = ?, is_deleted = 0,
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
    existing.id,
  );
  return 'updated';
}

/** Upsert a project. Same idempotency contract as `upsertTask`. */
export function upsertProject(userId: number, project: NormalizedProject): UpsertResult {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, name, color, task_count FROM unified_projects WHERE user_id = ? AND provider = ? AND external_id = ?',
  ).get(userId, project.provider, project.externalId) as
    | { id: number; name: string; color: string | null; task_count: number }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO unified_projects (
        user_id, provider, external_id, name, color, is_default, task_count, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      userId,
      project.provider,
      project.externalId,
      project.name,
      project.color ?? null,
      project.isDefault ? 1 : 0,
      project.taskCount ?? 0,
    );
    return 'inserted';
  }

  const unchanged =
    existing.name === project.name &&
    (existing.color ?? null) === (project.color ?? null) &&
    existing.task_count === (project.taskCount ?? 0);
  if (unchanged) return 'unchanged';

  db.prepare(
    `UPDATE unified_projects SET name = ?, color = ?, is_default = ?, task_count = ?, synced_at = datetime('now')
     WHERE id = ?`,
  ).run(
    project.name,
    project.color ?? null,
    project.isDefault ? 1 : 0,
    project.taskCount ?? 0,
    existing.id,
  );
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
): number {
  const db = getDb();

  if (currentExternalIds.length === 0) {
    // No tasks in provider → mark all this provider's rows as deleted
    const result = db.prepare(
      `UPDATE unified_tasks SET is_deleted = 1, updated_at = datetime('now')
       WHERE user_id = ? AND provider = ? AND is_deleted = 0`,
    ).run(userId, provider);
    return result.changes;
  }

  // SQLite has a default LIMIT of ~999 host parameters per statement, so
  // chunk the delete-set when a user has more than ~900 tasks per provider.
  // Build the placeholder string once per chunk.
  const CHUNK = 900;
  let totalDeleted = 0;
  const allRows = db.prepare(
    `SELECT id, external_id FROM unified_tasks
     WHERE user_id = ? AND provider = ? AND is_deleted = 0`,
  ).all(userId, provider) as { id: number; external_id: string }[];

  const seen = new Set(currentExternalIds);
  const stale = allRows.filter((r) => !seen.has(r.external_id));

  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const result = db.prepare(
      `UPDATE unified_tasks SET is_deleted = 1, updated_at = datetime('now')
       WHERE id IN (${placeholders})`,
    ).run(...chunk.map((r) => r.id));
    totalDeleted += result.changes;
  }
  return totalDeleted;
}

// ─── Reads ─────────────────────────────────────────────────────────────

export function getTaskById(taskId: number): NormalizedTask | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(taskId) as
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

export function getPendingTasks(userId: number): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ? AND status = 'pending' AND is_deleted = 0
     ORDER BY priority DESC, due_date ASC NULLS LAST, updated_at DESC`,
  ).all(userId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getOverdueTasks(userId: number): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND due_date IS NOT NULL
       AND date(due_date) < date('now')
     ORDER BY due_date ASC`,
  ).all(userId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getTasksDueToday(userId: number): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND date(due_date) = date('now')
     ORDER BY priority DESC, due_date ASC`,
  ).all(userId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export function getTasksDueThisWeek(userId: number): NormalizedTask[] {
  const db = getDb();
  // SQLite's `date('now', 'weekday 0', '+7 days')` gives next Sunday — close
  // enough to "this week" for the briefing context.
  const rows = db.prepare(
    `SELECT * FROM unified_tasks
     WHERE user_id = ?
       AND status = 'pending'
       AND is_deleted = 0
       AND due_date IS NOT NULL
       AND date(due_date) >= date('now')
       AND date(due_date) <= date('now', '+7 days')
     ORDER BY due_date ASC, priority DESC`,
  ).all(userId) as UnifiedTaskRow[];
  return rows.map(rowToTask);
}

export interface TaskFilters {
  status?: NormalizedStatus;
  provider?: TaskProvider;
  projectName?: string;
  includeDeleted?: boolean;
}

/** Generic query — used by the high-level service when no special view fits. */
export function getAllTasks(userId: number, filters?: TaskFilters): NormalizedTask[] {
  const db = getDb();
  const where: string[] = ['user_id = ?'];
  const args: unknown[] = [userId];

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

export function getProjects(userId: number): NormalizedProject[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM unified_projects WHERE user_id = ? ORDER BY name ASC`,
  ).all(userId) as UnifiedProjectRow[];
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
    `UPDATE unified_tasks SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?`,
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

export function getTaskStats(userId: number): TaskStoreStats {
  const db = getDb();
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 THEN 1 ELSE 0 END) AS total_pending,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) < date('now') THEN 1 ELSE 0 END) AS total_overdue,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) = date('now') THEN 1 ELSE 0 END) AS total_today,
       SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) >= date('now') AND date(due_date) <= date('now', '+7 days') THEN 1 ELSE 0 END) AS total_week
     FROM unified_tasks WHERE user_id = ?`,
  ).get(userId) as {
    total_pending: number | null;
    total_overdue: number | null;
    total_today: number | null;
    total_week: number | null;
  };

  const byProviderRows = db.prepare(
    `SELECT provider, COUNT(*) AS cnt
     FROM unified_tasks
     WHERE user_id = ? AND status = 'pending' AND is_deleted = 0
     GROUP BY provider`,
  ).all(userId) as { provider: string; cnt: number }[];

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
      DELETE FROM user_task_preferences;
      DELETE FROM daily_context_cache;
    `);
  } catch (err) {
    logger.warn({ err }, '_resetForTests failed');
  }
}
