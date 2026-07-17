// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Push-kick registry (M6). The offline-first ledger writers need to nudge the
 * mutation worker after journaling, but a direct import would drag the whole
 * worker/coordinator/sync-engine graph into every module that touches the
 * ledger (and into every test suite that mocks around it). This zero-
 * dependency registry inverts the edge: the worker registers its
 * `scheduleTaskMutationKick` at module load, and producers call
 * `triggerTaskMutationKick` — a no-op until the worker is loaded (it always
 * is in production: the task routes import the worker at boot).
 */

export type TaskMutationKickFn = (tenantId: number, userId: number) => boolean;

let registeredKick: TaskMutationKickFn | null = null;

export function registerTaskMutationKick(fn: TaskMutationKickFn): void {
  registeredKick = fn;
}

/** Best-effort kick — false when no worker is registered or the kick declined. */
export function triggerTaskMutationKick(tenantId: number, userId: number): boolean {
  if (!registeredKick) return false;
  try {
    return registeredKick(tenantId, userId);
  } catch {
    return false;
  }
}

/** Test-only: detach any registered kick between vitest runs. */
export function _resetTaskMutationKickRegistryForTests(): void {
  registeredKick = null;
}
