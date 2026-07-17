// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task-sync state-transition table.
 *
 * Encodes, as data, every state transition the task-sync subsystem currently
 * performs across its three state machines:
 *
 *   - `mutation_status`   → task_mutations.status
 *   - `task_sync_state`   → unified_tasks.sync_state
 *   - `link_state`        → task_provider_links.link_state
 *
 * Each edge is annotated with the write site that performs it, so writers can
 * later adopt `assertTransition()` (planned for the failure-lifecycle work)
 * without re-deriving the graph. Until then this module is intentionally
 * side-effect free: `assertTransition` is FAIL-OPEN — it logs a warning on a
 * violation and returns false, but NEVER throws and never blocks the write.
 *
 * Rules for editing this table:
 *   - State names are wire-visible to deployed iOS clients (which render
 *     unknown syncState strings as healthy). Do NOT rename states; add new
 *     internal states only.
 *   - Removing an edge or adding an exit from a terminal state is a designed
 *     behavior change — update the fixture test in the same commit and say why.
 */

import { logger } from '../../utils/logger';

export type TaskSyncTransitionKind =
  | 'mutation_status'
  | 'task_sync_state'
  | 'link_state';

type TransitionTable = Readonly<Record<string, readonly string[]>>;

/**
 * task_mutations.status
 *
 * Insert-time statuses (see INITIAL_STATES): 'queued' (normal enqueue),
 * 'synced' (local_only short-circuit), 'failed' (create with unresolvable
 * sync target), 'conflict' (retry of a conflicted task re-records conflict).
 * 'accepted_local' is a legacy value: readable by readyMutations but never
 * written by current code — kept so a claim from an old row stays legal.
 */
const MUTATION_STATUS_TRANSITIONS: TransitionTable = {
  // worker claim: readyMutations selects queued/accepted_local/due-failed/
  // stale-'syncing' rows; markMutationSyncing sets 'syncing'
  // (task-mutation-sync-worker.ts:299-326, :373-381)
  queued: ['syncing'],
  accepted_local: ['syncing'],
  // failed rows are only re-claimable when next_retry_at is due
  // (worker:302); dead-letter applies to failed rows at the retry cap
  // (worker markDeadLetter:522-529, cap check :981)
  failed: ['syncing', 'dead_letter'],
  // stale-lease re-claim keeps status 'syncing' (worker:303-307);
  // markSynced → 'synced' (:396); markFailure → 'failed' or 'conflict'
  // (:474-482)
  syncing: ['syncing', 'synced', 'failed', 'conflict'],
  // Terminal today. 'conflict' having no exit is the documented
  // absorbing-state defect (NEX-06); the conflict-resolution work adds
  // exits by editing THIS table alongside the code.
  synced: [],
  conflict: [],
  dead_letter: [],
};

/**
 * unified_tasks.sync_state
 *
 * Pull-side guards partition the states:
 *   pending-local set  = queued/syncing/failed_retryable/conflict
 *     (hasPendingLocalMutation, unified-task-store.ts:326-333)
 *   recoverable-absence set = provider_missing/provider_disconnected/
 *     stale/failed_retryable (hasRecoverableProviderAbsenceState, :278-285)
 */
const NON_PENDING_SYNC_STATES = [
  'local_only',
  'synced',
  'partially_synced',
  'failed_permanent',
  'provider_disconnected',
  'provider_missing',
  'stale',
  'deleted_pending_sync',
] as const;

const TASK_SYNC_STATE_TRANSITIONS: TransitionTable = {
  // assign-provider queues a target (offline-first-task-service.ts:2035-2042);
  // pull overwrite path sets 'synced' for any non-pending row
  // (unified-task-store.ts:457-466); local delete tombstones (:759)
  local_only: ['queued', 'synced', 'deleted_pending_sync'],
  // worker outcomes: markSynced → synced/partially_synced (:408);
  // markFailure → failed_retryable/failed_permanent/provider_disconnected/
  // conflict/provider_missing (classifyProviderError:161-198, markFailure:492);
  // pull with hash diff on a pending row → conflict (:446-455);
  // full-pull absence on a pending row → conflict (markProviderMissingTask:344)
  queued: [
    'synced',
    'partially_synced',
    'failed_retryable',
    'failed_permanent',
    'provider_disconnected',
    'provider_missing',
    'conflict',
    'deleted_pending_sync',
  ],
  // 'syncing' is declared in TaskSyncState but never written by current
  // code (vestigial); if a legacy row holds it, the same worker/pull exits
  // as 'queued' apply.
  syncing: [
    'synced',
    'partially_synced',
    'failed_retryable',
    'failed_permanent',
    'provider_disconnected',
    'provider_missing',
    'conflict',
    'deleted_pending_sync',
  ],
  // retry cycle keeps the worker exits; recoverable-absence membership also
  // allows markProviderTaskSeen healing → synced (:287-306); reconciliation
  // markVerified → synced (task-reconciliation-job.ts:125-139)
  failed_retryable: [
    'synced',
    'partially_synced',
    'failed_retryable',
    'failed_permanent',
    'provider_disconnected',
    'provider_missing',
    'conflict',
    'deleted_pending_sync',
  ],
  // retryOfflineTaskSync re-queues when the target resolves
  // (offline-first-task-service.ts:2024-2042); pull overwrite → synced;
  // full-pull absence (non-pending) → provider_missing (:344);
  // reconciliation → stale/provider_disconnected/provider_missing/
  // failed_permanent (task-reconciliation-job.ts:264-325); delete tombstones
  failed_permanent: [
    'queued',
    'synced',
    'provider_missing',
    'provider_disconnected',
    'stale',
    'deleted_pending_sync',
  ],
  // provider_disconnected implies a parked local mutation, so since the
  // failure-lifecycle work it is pull-PROTECTED (pending guard): pulls can
  // conflict it on divergence but never overwrite it, and sighting the
  // provider copy no longer flips it to synced — only actual delivery
  // (markSynced after the re-armed push) or reconciliation markVerified do.
  provider_disconnected: [
    'queued',
    'synced', // markSynced after requeued push / reconciliation markVerified
    'conflict', // pull divergence while carrying a parked mutation
    'provider_missing',
    'stale',
    'failed_permanent',
    'deleted_pending_sync',
  ],
  provider_missing: [
    'queued',
    'synced', // reappearance heals (unified-task-store.ts:299-305)
    'provider_disconnected',
    'stale',
    'failed_permanent',
    'deleted_pending_sync',
  ],
  stale: [
    'queued',
    'synced',
    'provider_missing',
    'provider_disconnected',
    'failed_permanent',
    'deleted_pending_sync',
  ],
  synced: [
    'queued', // user edit enqueues a new mutation
    'partially_synced',
    'failed_retryable',
    'failed_permanent',
    'provider_disconnected',
    'provider_missing',
    'stale',
    'conflict', // 412/edit-vs-edit via worker; NOT via hash-diff pull (guard)
    'deleted_pending_sync',
    'synced',
  ],
  partially_synced: [
    'queued',
    'synced',
    'failed_retryable',
    'failed_permanent',
    'provider_disconnected',
    'provider_missing',
    'stale',
    'conflict',
    'deleted_pending_sync',
  ],
  // Absorbing today (NEX-06): retry re-records conflict
  // (offline-first-task-service.ts:2024-2032); pulls preserve it (pending
  // guard) — the only current exit is the tombstone via local delete.
  conflict: ['conflict', 'deleted_pending_sync'],
  // worker pushes the provider delete then marks synced (markSynced after
  // task.delete). Pull-overwrite resurrection (NEX-19) is closed: the state
  // is pending-guarded, so a divergent pull marks conflict instead.
  deleted_pending_sync: ['synced', 'conflict'],
};

/**
 * task_provider_links.link_state
 *
 * Insert-time states: 'pending_create' (nexus create with a resolved sync
 * target), 'linked' (pull import / nexus_local,
 * unified-task-store.ts:241-275).
 */
const LINK_STATE_TRANSITIONS: TransitionTable = {
  pending_create: [
    'linked', // markSynced non-delete (worker:414-434)
    'orphaned', // markSynced after task.delete (worker:420)
    'pending_update', // assign-provider/bulk retarget (offline-first:1726,2054)
    'pending_delete', // local delete before push (offline-first:1869)
    'stale',
    'disconnected',
    'conflict',
    'provider_missing', // markFailure linkState (worker:167-198, :500)
  ],
  pending_update: [
    'linked',
    'orphaned',
    'pending_delete',
    'stale',
    'disconnected',
    'conflict',
    'provider_missing',
  ],
  pending_delete: [
    'orphaned', // delete pushed
    'linked', // markSynced non-delete ops
    'stale',
    'disconnected',
    'conflict',
    'provider_missing',
  ],
  linked: [
    'linked', // markVerified refresh (task-reconciliation-job.ts:125)
    'pending_update',
    'pending_delete',
    'orphaned',
    'stale', // reconciliation (:264,287,301,325,368)
    'disconnected', // reconciliation (:278) / auth failures
    'provider_missing', // full-pull absence (unified-task-store.ts:352)
    'conflict', // duplicate scan (task-reconciliation-job.ts:188)
  ],
  stale: ['linked', 'pending_update', 'pending_delete', 'disconnected', 'provider_missing', 'conflict', 'orphaned'],
  disconnected: ['linked', 'stale', 'provider_missing', 'conflict', 'orphaned', 'pending_update', 'pending_delete'],
  provider_missing: ['linked', 'stale', 'disconnected', 'conflict', 'orphaned', 'pending_update', 'pending_delete'],
  // Duplicate-scan conflict is preserved by the upsert ON CONFLICT branch
  // (unified-task-store.ts:255-262); no current healer clears it (NEX-06
  // family). Orphaned is terminal.
  conflict: ['conflict', 'orphaned'],
  orphaned: [],
};

const TABLES: Readonly<Record<TaskSyncTransitionKind, TransitionTable>> = {
  mutation_status: MUTATION_STATUS_TRANSITIONS,
  task_sync_state: TASK_SYNC_STATE_TRANSITIONS,
  link_state: LINK_STATE_TRANSITIONS,
};

/** Legal states a brand-new row may be created with. */
export const INITIAL_STATES: Readonly<Record<TaskSyncTransitionKind, readonly string[]>> = {
  // offline-first-task-service.ts:1548,2216,2311,2396 (queued/synced),
  // create with unresolvable target (:1471-1485 → 'failed'),
  // conflicted-task retry re-record (:2024-2032 → 'conflict')
  mutation_status: ['queued', 'synced', 'failed', 'conflict'],
  // resolveTaskSyncTarget outcomes at insert (local_only/queued/
  // failed_permanent) + pull imports ('synced')
  task_sync_state: ['local_only', 'queued', 'failed_permanent', 'synced'],
  link_state: ['pending_create', 'linked'],
};

export function knownStates(kind: TaskSyncTransitionKind): string[] {
  return Object.keys(TABLES[kind]);
}

export function isTransitionAllowed(
  kind: TaskSyncTransitionKind,
  from: string,
  to: string,
): boolean {
  const table = TABLES[kind];
  const exits = table[from];
  if (!exits) return false;
  return exits.includes(to);
}

/**
 * Fail-open transition check. Logs (never throws) when a writer performs a
 * transition outside the table, so violations surface in observability
 * without ever blocking a write. Returns whether the transition is legal.
 */
export function assertTransition(
  kind: TaskSyncTransitionKind,
  from: string,
  to: string,
  context?: Record<string, unknown>,
): boolean {
  if (from === to && isTransitionAllowed(kind, from, to)) return true;
  const allowed = isTransitionAllowed(kind, from, to);
  if (!allowed) {
    logger.warn(
      { kind, from, to, ...context },
      'Task-sync state transition outside the allowed table',
    );
  }
  return allowed;
}

/** Test-only view of the raw tables (fixture pins the graph). */
export function _transitionTableForTests(kind: TaskSyncTransitionKind): TransitionTable {
  return TABLES[kind];
}
