// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-provider-list sync selection (M12 connect flow).
 *
 * A single source of truth for "does this provider list participate in sync?".
 * The connect endpoint (`POST /api/v1/tasks/sync/connect`) writes one row per
 * provider list the user was shown — sync_enabled = 1 for the lists they
 * selected, 0 for the rest. The gate is consulted in three places so a
 * de-selected list is skipped everywhere:
 *
 *   1. sync-engine pull — disabled lists are never imported, and their tasks
 *      are excluded from full-pull reconciliation (so they are never
 *      false-marked provider_missing).
 *   2. task-mutation-sync-worker push — a mutation whose target provider list
 *      is disabled is kept local (never written to the provider).
 *
 * Default is "no row = enabled". A user who never calls connect (old client)
 * has no selection rows, so every list stays enabled — identical to the
 * pre-M12 import-everything behavior.
 *
 * Keyed by the PROVIDER list id (not a nexus_list_id) so it is durable BEFORE
 * the list has ever been imported — task_container_mappings cannot hold this
 * because its nexus_list_id is NOT NULL and only exists post-import.
 */

import crypto from 'crypto';
import { getDb } from '../database';

/** Providers whose lists can be selectively synced. */
export type TaskListSelectionProvider = 'ms_todo' | 'todoist' | 'notion';

const SELECTABLE_PROVIDERS = new Set<string>(['ms_todo', 'todoist', 'notion']);

/** Narrow an arbitrary provider string to a selectable task provider. */
export function normalizeTaskListSelectionProvider(
  value: unknown,
): TaskListSelectionProvider | null {
  if (typeof value !== 'string') return null;
  const provider = value.trim().toLowerCase();
  return SELECTABLE_PROVIDERS.has(provider)
    ? (provider as TaskListSelectionProvider)
    : null;
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export interface TaskListSelectionEntry {
  providerListId: string;
  syncEnabled: boolean;
}

/**
 * Persist a full selection for (tenant, user, provider). Each entry is
 * upserted by (provider, provider_list_id): re-connecting with a new selection
 * overwrites the old enabled/disabled flags. Returns the resulting counts.
 */
export function setTaskListSyncSelection(input: {
  tenantId: number;
  userId: number;
  provider: TaskListSelectionProvider;
  entries: TaskListSelectionEntry[];
}): { enabledCount: number; disabledCount: number } {
  const { tenantId, userId, provider } = input;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO task_list_sync_selection (
       id, tenant_id, user_id, provider, provider_list_id, sync_enabled
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, provider, provider_list_id)
     DO UPDATE SET
       sync_enabled = excluded.sync_enabled,
       updated_at = datetime('now')`,
  );

  let enabledCount = 0;
  let disabledCount = 0;
  const seen = new Set<string>();
  const apply = db.transaction((entries: TaskListSelectionEntry[]) => {
    for (const entry of entries) {
      const providerListId = String(entry.providerListId || '').trim();
      if (!providerListId || seen.has(providerListId)) continue;
      seen.add(providerListId);
      upsert.run(randomId('task_list_sel'), tenantId, userId, provider, providerListId, entry.syncEnabled ? 1 : 0);
      if (entry.syncEnabled) enabledCount += 1;
      else disabledCount += 1;
    }
  });
  apply(input.entries);
  return { enabledCount, disabledCount };
}

/**
 * The set of provider list ids explicitly disabled (sync_enabled = 0) for this
 * (tenant, user, provider). Empty when the user never made a selection — the
 * default-enabled case. Consumers treat "not in this set" as enabled.
 */
export function getDisabledProviderListIds(
  tenantId: number,
  userId: number,
  provider: string,
): Set<string> {
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT provider_list_id
       FROM task_list_sync_selection
       WHERE tenant_id = ? AND user_id = ? AND provider = ? AND sync_enabled = 0`,
    ).all(tenantId, userId, provider) as Array<{ provider_list_id: string }>;
    return new Set(rows.map((row) => row.provider_list_id));
  } catch {
    // Selection table absent (isolated tests / partial migration) — fail open
    // to the backward-compatible "everything enabled" default.
    return new Set<string>();
  }
}

/**
 * Whether a specific provider list participates in sync. Defaults to true when
 * no explicit selection row exists (backward-compatible import-everything).
 */
export function isProviderListSyncEnabled(
  tenantId: number,
  userId: number,
  provider: string,
  providerListId: string | null | undefined,
): boolean {
  if (!providerListId) return true;
  const db = getDb();
  try {
    const row = db.prepare(
      `SELECT sync_enabled
       FROM task_list_sync_selection
       WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_list_id = ?
       LIMIT 1`,
    ).get(tenantId, userId, provider, providerListId) as { sync_enabled: number } | undefined;
    if (!row) return true;
    return row.sync_enabled !== 0;
  } catch {
    return true;
  }
}

/**
 * Drop all selection rows for (tenant, user, provider). Called on disconnect so
 * a later reconnect starts from the default "everything enabled" state.
 * Returns the number of rows removed.
 */
export function clearTaskListSyncSelection(
  tenantId: number,
  userId: number,
  provider: string,
): number {
  const db = getDb();
  try {
    const result = db.prepare(
      `DELETE FROM task_list_sync_selection
       WHERE tenant_id = ? AND user_id = ? AND provider = ?`,
    ).run(tenantId, userId, provider);
    return result.changes ?? 0;
  } catch {
    return 0;
  }
}
