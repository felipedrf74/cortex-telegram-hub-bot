// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Disconnect data-choice (M12).
 *
 * When a user disconnects a task provider they choose what happens to the
 * tasks that provider fed into Nexus:
 *
 *   - keep    : today's behavior — nothing is touched (only the sync-state row
 *               is cleared by the caller). Tasks and links stay as-is.
 *   - archive : the provider's imported task rows become local-only and their
 *               active provider links are orphaned (provider ids surrendered
 *               per the M4 canonical-links invariant). Tasks stay visible and
 *               editable; reconnecting re-imports them fresh.
 *   - remove  : the provider-ORIGIN imported rows are soft-deleted; their links
 *               are orphaned. Nexus-created tasks that merely synced TO the
 *               provider are KEPT (archived to local-only) — only true imports
 *               are removed.
 *
 * Origin is discriminated by link ownership + row provider (NOT the useless
 * hardcoded source_of_truth column, per M4 R1-e): a provider-imported link
 * (ownership = 'provider_imported', link_state active) whose unified_tasks row
 * `provider` equals the disconnecting provider is a real import; the same link
 * on a `provider = 'nexus'` row is a Nexus task that was pushed out.
 */

import { getDb } from '../database';

export type TaskDisconnectPolicy = 'keep' | 'archive' | 'remove';
export type TaskDisconnectProvider = 'ms_todo' | 'todoist' | 'notion';

export interface TaskDisconnectCounts {
  /** Provider-origin rows converted to local-only (archive policy). */
  archivedCount: number;
  /** Provider-origin rows soft-deleted (remove policy). */
  removedCount: number;
  /**
   * Nexus-origin rows (provider != disconnecting provider) that had an active
   * link and were converted to local-only. Always kept, never removed.
   */
  keptLocalCount: number;
}

const DISCONNECT_POLICIES = new Set<string>(['keep', 'archive', 'remove']);

export function normalizeTaskDisconnectPolicy(value: unknown): TaskDisconnectPolicy | null {
  if (value === undefined || value === null || value === '') return 'keep';
  if (typeof value !== 'string') return null;
  const policy = value.trim().toLowerCase();
  return DISCONNECT_POLICIES.has(policy) ? (policy as TaskDisconnectPolicy) : null;
}

/** Map an OAuth connection provider to its task-store provider, if any. */
export function taskProviderForConnection(provider: string): TaskDisconnectProvider | null {
  if (provider === 'outlook' || provider === 'ms_todo') return 'ms_todo';
  if (provider === 'todoist') return 'todoist';
  if (provider === 'notion') return 'notion';
  return null;
}

interface DisconnectLinkRow {
  link_id: string;
  row_id: number;
  row_provider: string;
}

/**
 * Apply the archive/remove data-choice to a provider's imported tasks. `keep`
 * is a no-op (returns zeroed counts). Idempotent: it only touches rows with an
 * ACTIVE provider-imported link, and archiving/removing orphans that link, so
 * a second call finds nothing left to do.
 */
export function applyTaskDisconnectPolicy(input: {
  tenantId: number;
  userId: number;
  provider: TaskDisconnectProvider;
  policy: TaskDisconnectPolicy;
}): TaskDisconnectCounts {
  const counts: TaskDisconnectCounts = { archivedCount: 0, removedCount: 0, keptLocalCount: 0 };
  if (input.policy === 'keep') return counts;

  const { tenantId, userId, provider, policy } = input;
  const db = getDb();

  const links = db.prepare(
    `SELECT l.id AS link_id, t.id AS row_id, t.provider AS row_provider
     FROM task_provider_links l
     JOIN unified_tasks t
       ON t.nexus_task_id = l.task_id
      AND t.user_id = l.user_id
      AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
     WHERE l.tenant_id = ? AND l.user_id = ? AND l.provider = ?
       AND l.ownership = 'provider_imported'
       AND l.link_state NOT IN ('orphaned')
       AND t.is_deleted = 0`,
  ).all(tenantId, userId, provider) as DisconnectLinkRow[];

  if (links.length === 0) return counts;

  const now = new Date().toISOString();
  const toLocalOnly = db.prepare(
    `UPDATE unified_tasks
     SET sync_state = 'local_only', updated_at = datetime('now')
     WHERE id = ?`,
  );
  const softDelete = db.prepare(
    `UPDATE unified_tasks
     SET is_deleted = 1, deleted_at = ?, sync_state = 'local_only', updated_at = datetime('now')
     WHERE id = ?`,
  );
  // Orphan + surrender the provider id (M4 / migration 234 invariant: orphaned
  // links must not retain a provider_task_id, or re-linking on reconnect throws).
  const orphanLink = db.prepare(
    `UPDATE task_provider_links
     SET link_state = 'orphaned', provider_task_id = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  );

  const apply = db.transaction((rows: DisconnectLinkRow[]) => {
    for (const row of rows) {
      const providerOrigin = row.row_provider === provider;
      if (providerOrigin && policy === 'remove') {
        softDelete.run(now, row.row_id);
        counts.removedCount += 1;
      } else if (providerOrigin && policy === 'archive') {
        toLocalOnly.run(row.row_id);
        counts.archivedCount += 1;
      } else {
        // Nexus-origin row that merely synced to the provider: always kept.
        toLocalOnly.run(row.row_id);
        counts.keptLocalCount += 1;
      }
      orphanLink.run(row.link_id);
    }
  });
  apply(links);

  return counts;
}
