// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M6 latency flags (Gate R2). Both default OFF and flip only after the
 * owner-run staging probes pass — see the M6 milestone notes.
 *
 *   - TASK_SYNC_PUSH_KICK: debounced push-kick after ledger mutations
 *     (scheduleTaskMutationKick in task-mutation-sync-worker.ts).
 *   - TASK_MS_DELTA_SYNC: Microsoft Graph To Do delta pulls (per-list
 *     deltaLink cursors in microsoft-todo-adapter.ts) plus the every-5-minutes
 *     delta tick in the scheduler.
 *
 * Same shape as the M5 single-write-path helper: the env is re-read on every
 * call so tests can vi.stubEnv both states without module re-imports. Unlike
 * TASK_SINGLE_WRITE_PATH these are opt-IN flags — unset means OFF, and
 * unflagged behavior stays byte-identical to the pre-M6 pipeline.
 */

function flagEnabled(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

export function isTaskSyncPushKickEnabled(): boolean {
  return flagEnabled(process.env.TASK_SYNC_PUSH_KICK);
}

export function isTaskMsDeltaSyncEnabled(): boolean {
  return flagEnabled(process.env.TASK_MS_DELTA_SYNC);
}
