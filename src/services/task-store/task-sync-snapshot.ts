// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Last-synced content snapshot for task provider links (migration 235).
 *
 * A compact, provider-agnostic JSON record of the task content both sides
 * agreed on at the last successful sync. Written:
 *   - by the push worker (`markSynced`) from the local content it just pushed;
 *   - by the pull path (`ensureProviderLinkForTask`) when provider content is
 *     imported, applied onto a linked row, or verified hash-equal;
 *   - by conflict resolution (`keep_provider`) from the applied provider copy.
 *
 * It is intentionally NOT updated when a pull detects a divergence on a
 * pending-local row (the conflict path) — the snapshot must keep pointing at
 * the last agreed base so future 3-way merge can attribute each side's edits.
 */

export interface TaskSyncedSnapshot {
  title: string;
  status: string;
  priority: number;
  dueDate: string | null;
  dueIsDatetime: boolean;
  notes: string | null;
}

export function buildTaskSyncedSnapshot(fields: {
  title: string | null | undefined;
  status: string | null | undefined;
  priority: number | null | undefined;
  dueDate: string | null | undefined;
  dueIsDatetime: boolean | number | null | undefined;
  notes: string | null | undefined;
}): string {
  const snapshot: TaskSyncedSnapshot = {
    title: String(fields.title || ''),
    status: String(fields.status || 'pending'),
    priority: Number.isFinite(Number(fields.priority)) ? Number(fields.priority) : 0,
    dueDate: fields.dueDate || null,
    dueIsDatetime: Boolean(fields.dueIsDatetime),
    notes: fields.notes || null,
  };
  return JSON.stringify(snapshot);
}

export function parseTaskSyncedSnapshot(value: string | null | undefined): TaskSyncedSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TaskSyncedSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      title: String(parsed.title || ''),
      status: String(parsed.status || 'pending'),
      priority: Number.isFinite(Number(parsed.priority)) ? Number(parsed.priority) : 0,
      dueDate: parsed.dueDate || null,
      dueIsDatetime: Boolean(parsed.dueIsDatetime),
      notes: parsed.notes || null,
    };
  } catch {
    return null;
  }
}
