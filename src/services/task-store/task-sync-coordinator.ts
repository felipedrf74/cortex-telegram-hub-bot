// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Sync Coordinator (M6) — single-flight over BOTH the mutation push and
 * the provider pull per (tenantId, userId) scope.
 *
 * Before M6 there was NO concurrency guard around `syncProvider`: the
 * OAuth-connect force-pull could interleave with the 15-minute cron full pull
 * and false-mark rows provider_missing (a full-pull reconciliation ran
 * against a half-imported task set — live race). Every sync entry point now
 * becomes a REASON routed through `requestTaskSync`:
 *
 *   - 'cron'       — the 15-minute task_sync job (push + pull + reconciliation)
 *   - 'kick'       — debounced post-mutation push (task-mutation-sync-worker)
 *   - 'connect'    — OAuth reconnect initial sync (portal/oauth-routes)
 *   - 'force_sync' — POST /api/v1/tasks/sync/now
 *   - 'delta_tick' — the 5-minute delta pull job (TASK_MS_DELTA_SYNC)
 *
 * While a run is active for a scope, further requests COALESCE into exactly
 * ONE follow-up run whose options are the union of every coalesced request —
 * a burst of kicks and a force-sync during a cron pull produce one catch-up
 * run, not a queue. The coordinator itself is NOT flag-gated: serializing the
 * existing entry points is the race fix and changes no per-step behavior.
 *
 * Import note: this module and the worker form a deliberate, benign cycle
 * (worker's debounced kick calls requestTaskSync at TIMER time, never during
 * module init) — both sides only touch each other's bindings at call time.
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { runTaskMutationSyncBatch } from './task-mutation-sync-worker';
import { syncProvider, listRegisteredAdapters, getAdapter } from './sync-engine';
import { isSyncEnabled } from './unified-task-store';
import { runTaskProviderLinkReconciliation } from './task-reconciliation-job';
import type { SyncResult, TaskProvider } from './types';
import type { TaskMutationSyncBatchResult } from './task-mutation-sync-worker';

export type TaskSyncReason = 'cron' | 'kick' | 'connect' | 'force_sync' | 'delta_tick';

export interface TaskSyncScopeRef {
  tenantId: number;
  userId: number;
}

export interface TaskSyncRunOptions {
  /** Run the mutation push batch. Default true. */
  push?: boolean;
  /** Providers to pull: 'all' connected adapters, an explicit list, or none. Default 'none'. */
  pull?: 'all' | 'none' | TaskProvider[];
  /** Bypass the poll-interval gate on the pull (manual force-sync). */
  pullForce?: boolean;
  /** Restrict the pull to adapters with hasIncrementalSync (the delta tick). */
  deltaOnly?: boolean;
  /** Run the provider-link reconciliation pass after the pull (cron parity). */
  reconcile?: boolean;
  /** Mutation batch size for the push step. */
  mutationLimit?: number;
}

export interface TaskSyncRunSummary {
  syncRequestId: string;
  reasons: TaskSyncReason[];
  startedAt: string;
  finishedAt: string;
  push: TaskMutationSyncBatchResult | null;
  pull: SyncResult[];
  reconciledLinks: number;
  errors: string[];
}

export interface TaskSyncRequestResult {
  /** 'started' — this request began a run; 'coalesced' — merged into the follow-up. */
  status: 'started' | 'coalesced';
  syncRequestId: string;
  /** Resolves with the run summary; never rejects. */
  completion: Promise<TaskSyncRunSummary>;
}

type ActiveRun = {
  syncRequestId: string;
  reasons: TaskSyncReason[];
  promise: Promise<TaskSyncRunSummary>;
};

type PendingRun = {
  syncRequestId: string;
  reasons: TaskSyncReason[];
  options: TaskSyncRunOptions;
  promise: Promise<TaskSyncRunSummary>;
  resolve: (summary: TaskSyncRunSummary) => void;
};

const activeRuns = new Map<string, ActiveRun>();
const pendingRuns = new Map<string, PendingRun>();

function scopeKey(scope: TaskSyncScopeRef): string {
  return `${scope.tenantId}:${scope.userId}`;
}

function randomRunId(): string {
  if (typeof crypto.randomUUID === 'function') return `task_sync_run_${crypto.randomUUID()}`;
  return `task_sync_run_${crypto.randomBytes(16).toString('hex')}`;
}

function mergePull(
  left: TaskSyncRunOptions['pull'],
  right: TaskSyncRunOptions['pull'],
): TaskSyncRunOptions['pull'] {
  const a = left ?? 'none';
  const b = right ?? 'none';
  if (a === 'all' || b === 'all') return 'all';
  if (a === 'none') return b;
  if (b === 'none') return a;
  return Array.from(new Set([...a, ...b]));
}

/** Union of two coalesced requests: the follow-up must satisfy both. */
function mergeOptions(left: TaskSyncRunOptions, right: TaskSyncRunOptions): TaskSyncRunOptions {
  return {
    push: (left.push !== false) || (right.push !== false),
    pull: mergePull(left.pull, right.pull),
    pullForce: left.pullForce === true || right.pullForce === true,
    // A restriction survives only when EVERY coalesced request wanted it —
    // a delta-only tick folded into a full cron pull runs the full pull.
    deltaOnly: left.deltaOnly === true && right.deltaOnly === true,
    reconcile: left.reconcile === true || right.reconcile === true,
    mutationLimit: Math.max(left.mutationLimit ?? 0, right.mutationLimit ?? 0) || undefined,
  };
}

async function executeRun(
  scope: TaskSyncScopeRef,
  syncRequestId: string,
  reasons: TaskSyncReason[],
  options: TaskSyncRunOptions,
): Promise<TaskSyncRunSummary> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let push: TaskMutationSyncBatchResult | null = null;
  const pull: SyncResult[] = [];
  let reconciledLinks = 0;

  try {
    if (options.push !== false) {
      try {
        push = await runTaskMutationSyncBatch({
          tenantId: scope.tenantId,
          userId: scope.userId,
          limit: options.mutationLimit ?? 25,
        });
      } catch (err) {
        errors.push(`push: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn({ err, ...scope, reasons }, 'Task sync coordinator push step failed');
      }
    }

    const pullSpec = options.pull ?? 'none';
    if (pullSpec !== 'none') {
      try {
        // 'all' mirrors syncAllProviders: honor the user's sync-enabled
        // preference and skip disconnected adapters. Explicit provider lists
        // (the connect flow) call syncProvider directly, exactly like the
        // legacy connect path — syncProvider reports 'Not connected' itself.
        const skipAll = pullSpec === 'all' && !isSyncEnabled(scope.userId);
        if (!skipAll) {
          const providers: TaskProvider[] = pullSpec === 'all'
            ? listRegisteredAdapters()
            : pullSpec;
          for (const provider of providers) {
            const adapter = getAdapter(provider);
            if (pullSpec === 'all' && (!adapter || !adapter.isConnected(scope.userId))) continue;
            if (options.deltaOnly && !adapter?.capabilities?.hasIncrementalSync) continue;
            try {
              pull.push(await syncProvider(scope.userId, provider, {
                force: options.pullForce === true,
              }));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              errors.push(`pull ${provider}: ${message}`);
              pull.push({
                provider,
                tasksUpserted: 0,
                tasksDeleted: 0,
                projectsUpserted: 0,
                durationMs: 0,
                errors: [message],
              });
            }
          }
        }
      } catch (err) {
        errors.push(`pull: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn({ err, ...scope, reasons }, 'Task sync coordinator pull step failed');
      }
    }

    if (options.reconcile === true) {
      try {
        const result = await runTaskProviderLinkReconciliation({
          tenantId: scope.tenantId,
          userId: scope.userId,
          limit: 50,
        });
        reconciledLinks = Number((result as { scannedLinks?: number })?.scannedLinks ?? 0) || 0;
      } catch (err) {
        errors.push(`reconcile: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn({ err, ...scope, reasons }, 'Task sync coordinator reconciliation step failed');
      }
    }
  } catch (err) {
    // executeRun must never reject — the completion promise is a contract.
    errors.push(err instanceof Error ? err.message : String(err));
    logger.error({ err, ...scope, reasons }, 'Task sync coordinator run failed unexpectedly');
  }

  return {
    syncRequestId,
    reasons,
    startedAt,
    finishedAt: new Date().toISOString(),
    push,
    pull,
    reconciledLinks,
    errors,
  };
}

function startRun(
  scope: TaskSyncScopeRef,
  key: string,
  syncRequestId: string,
  reasons: TaskSyncReason[],
  options: TaskSyncRunOptions,
  deliver?: (summary: TaskSyncRunSummary) => void,
): Promise<TaskSyncRunSummary> {
  const run: ActiveRun = { syncRequestId, reasons, promise: undefined as unknown as Promise<TaskSyncRunSummary> };
  activeRuns.set(key, run);
  run.promise = (async () => {
    try {
      const summary = await executeRun(scope, syncRequestId, reasons, options);
      deliver?.(summary);
      return summary;
    } finally {
      activeRuns.delete(key);
      const pending = pendingRuns.get(key);
      if (pending) {
        pendingRuns.delete(key);
        startRun(scope, key, pending.syncRequestId, pending.reasons, pending.options, pending.resolve);
      }
    }
  })();
  return run.promise;
}

/**
 * Request a sync for a scope. If no run is active it starts immediately;
 * otherwise the request coalesces into the single follow-up run and resolves
 * when that follow-up finishes.
 */
export function requestTaskSync(
  scope: TaskSyncScopeRef,
  reason: TaskSyncReason,
  options: TaskSyncRunOptions = {},
): TaskSyncRequestResult {
  const key = scopeKey(scope);
  const active = activeRuns.get(key);

  if (!active) {
    const syncRequestId = randomRunId();
    const completion = startRun(scope, key, syncRequestId, [reason], { ...options });
    return { status: 'started', syncRequestId, completion };
  }

  let pending = pendingRuns.get(key);
  if (!pending) {
    let resolveFn: (summary: TaskSyncRunSummary) => void = () => undefined;
    const promise = new Promise<TaskSyncRunSummary>((resolve) => {
      resolveFn = resolve;
    });
    pending = {
      syncRequestId: randomRunId(),
      reasons: [reason],
      options: { ...options },
      promise,
      resolve: resolveFn,
    };
    pendingRuns.set(key, pending);
  } else {
    pending.reasons.push(reason);
    pending.options = mergeOptions(pending.options, options);
  }
  return { status: 'coalesced', syncRequestId: pending.syncRequestId, completion: pending.promise };
}

/** Whether a run is currently active (or a follow-up is queued) for a scope. */
export function isTaskSyncActive(tenantId: number, userId: number): {
  active: boolean;
  reasons: TaskSyncReason[];
  queued: boolean;
} {
  const key = scopeKey({ tenantId, userId });
  const active = activeRuns.get(key);
  return {
    active: !!active,
    reasons: active ? [...active.reasons] : [],
    queued: pendingRuns.has(key),
  };
}

/** Test-only: drop all in-flight bookkeeping between vitest runs. */
export function _resetTaskSyncCoordinatorForTests(): void {
  activeRuns.clear();
  pendingRuns.clear();
}
