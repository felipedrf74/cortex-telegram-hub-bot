// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Canonical task priority semantics (M10, NEX-17 backend half).
 *
 * `unified_tasks.priority` and the REST `priority` field share ONE scale:
 *
 *   0 = none/unset, 1 = P1 (highest) … 4 = P4 (lowest)
 *
 * Historical note: migration 039 documented the column as
 * "0=none, 1=low, 2=medium, 3=high, 4=urgent". M10 redefines the scale to
 * match the iOS P1–P4 model the REST contract now exposes; linked ms_todo
 * rows self-heal on the next pull (the inbound mapping below flips their
 * content hash), and Nexus-local rows are re-stamped on their next edit.
 *
 * Outbound (priority → coarse importance) — the SHIPPED mapping. P2 → 'high'
 * deliberately (a P2→normal draft would visibly demote every P2 task in
 * Outlook):
 *
 *   P1 (1) → 'high'
 *   P2 (2) → 'high'
 *   P3 (3) → 'normal'
 *   P4 (4) → 'low'
 *   none (0 / unknown) → 'normal'
 *
 * Inbound (importance → priority) — the sensible inverse of the table above:
 *
 *   'urgent'/'important' (client synonyms only) → 1 / 2
 *   'high'   → 2
 *   'normal'/'medium' → 3
 *   'low'    → 4
 *   unknown  → 0
 *
 * The tables are deliberately ASYMMETRIC: 'high' imports as P2, never P1, so
 * P1 stays user-assigned only — a provider can only say "high", and treating
 * that as P1 would silently promote every pushed P2 echo. The echo-stability
 * rule (sameImportanceBucket + preserve in unified-task-store.upsertTask)
 * keeps a stored P1 intact when its own push echoes back as 'high'.
 */

export type TaskImportance = 'low' | 'normal' | 'high';

export const TASK_PRIORITY_NONE = 0;
export const TASK_PRIORITY_MIN = 0;
export const TASK_PRIORITY_MAX = 4;

/** True when the value is a valid wire priority: an integer 0–4. */
export function isValidTaskPriorityInput(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TASK_PRIORITY_MIN
    && value <= TASK_PRIORITY_MAX;
}

/** Clamp a stored column value onto the wire scale (anything odd → none). */
export function normalizeStoredTaskPriority(value: unknown): number {
  const priority = Number(value);
  if (!Number.isInteger(priority)) return TASK_PRIORITY_NONE;
  if (priority < TASK_PRIORITY_MIN || priority > TASK_PRIORITY_MAX) return TASK_PRIORITY_NONE;
  return priority;
}

/** Outbound P1–P4 → coarse importance (the SHIPPED mapping — see header). */
export function priorityToImportance(value: unknown): TaskImportance {
  switch (normalizeStoredTaskPriority(value)) {
    case 1:
    case 2:
      return 'high';
    case 4:
      return 'low';
    default:
      // 3 (P3) and 0/none both project to 'normal'.
      return 'normal';
  }
}

/**
 * Inbound importance string → P1–P4. Providers only ever send
 * high/normal/low; 'urgent'/'important'/'medium' are client/chat synonyms
 * kept for the REST `importance` input. See the header for why 'high' → 2.
 */
export function importanceToPriority(value: unknown): number {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'urgent':
      return 1;
    case 'high':
    case 'important':
      return 2;
    case 'normal':
    case 'medium':
      return 3;
    case 'low':
      return 4;
    default:
      return TASK_PRIORITY_NONE;
  }
}

/**
 * Echo-stability predicate: two priorities that project onto the SAME coarse
 * importance bucket are indistinguishable to a coarse provider, so a stored
 * fine-grained value must win over an incoming echo (P1 pushed as 'high'
 * comes back as importance 'high' → importanceToPriority gives 2 → same
 * bucket → keep 1). A DIFFERENT bucket is a real provider-side change.
 */
export function sameImportanceBucket(a: unknown, b: unknown): boolean {
  return priorityToImportance(a) === priorityToImportance(b);
}

/**
 * ORDER BY fragment for the P1-first sort: 1,2,3,4 then none (0) last.
 * Callers append direction/tiebreakers.
 */
export function taskPriorityRankSql(column: string): string {
  return `CASE WHEN COALESCE(${column}, 0) BETWEEN 1 AND 4 THEN ${column} ELSE 5 END`;
}
