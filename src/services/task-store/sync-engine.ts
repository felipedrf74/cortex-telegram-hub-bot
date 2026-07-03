// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Sync Engine — orchestrates task pulls from registered TaskProviderAdapters.
 *
 * Lifecycle:
 *   1. Adapters self-register via `registerAdapter()` at app boot
 *   2. Scheduler cron calls `syncAllProviders(userId)` every 15 minutes
 *   3. For each connected adapter, the engine:
 *        a. full-pull providers (hasIncrementalSync: false): skips the pull
 *           entirely (result.skipped = 'skipped_poll_interval') unless
 *           TASK_SYNC_POLL_INTERVAL_MINUTES have passed since the last
 *           successful sync — mutation pushes still run every tick via
 *           task-mutation-sync-worker, which does not go through here
 *        b. updates sync_state.status = 'syncing'
 *        c. pulls projects → upserts via store
 *        d. pulls tasks (with sync cursor if supported) → upserts via store,
 *           reusing the already-fetched project set so adapters don't
 *           re-fetch their list catalogue
 *        e. on full pull (no cursor), soft-deletes tasks that disappeared
 *        f. saves new cursor + status='idle' to sync_state
 *   4. Errors are caught per provider so one bad adapter doesn't tank the
 *      others — the failure goes to sync_state.error_message and the next
 *      cron tick will retry.
 *
 * Webhooks (Todoist, Notion-with-polling) bypass the cron and call
 * `syncProvider()` directly from the webhook handler for sub-second latency.
 */

import { logger } from '../../utils/logger';
import { TaskProviderAdapter } from './adapter-interface';
import {
  upsertTask,
  upsertProject,
  softDeleteMissing,
  getSyncState,
  saveSyncState,
  updateSyncStatus,
  isSyncEnabled,
} from './unified-task-store';
import { NormalizedProject, SyncResult, TaskProvider } from './types';

// ─── Poll-interval gate for full-pull providers ────────────────────────
// Providers without incremental sync (Notion, Microsoft To Do) re-download
// their ENTIRE task set on every pull. Doing that on every 15-minute cron
// tick is pure waste, so their pull only runs once the poll interval has
// elapsed since the last SUCCESSFUL sync. Incremental/webhook providers
// (Todoist) keep syncing every tick, and mutation pushes are unaffected —
// the scheduler runs task-mutation-sync-worker on every tick regardless.

const DEFAULT_POLL_INTERVAL_MINUTES = 45;

let cachedPollIntervalMinutes: number | null = null;

/**
 * Minutes a full-pull provider's sync stays "fresh" before the engine pulls
 * again. Read once from TASK_SYNC_POLL_INTERVAL_MINUTES (default 45); a
 * value of 0 disables the gate and restores pull-every-tick behavior.
 * Invalid/negative values fall back to the default.
 */
export function taskSyncPollIntervalMinutes(): number {
  if (cachedPollIntervalMinutes === null) {
    const raw = process.env.TASK_SYNC_POLL_INTERVAL_MINUTES;
    if (raw === undefined || raw.trim() === '') {
      cachedPollIntervalMinutes = DEFAULT_POLL_INTERVAL_MINUTES;
    } else {
      const parsed = Number(raw);
      cachedPollIntervalMinutes = Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : DEFAULT_POLL_INTERVAL_MINUTES;
    }
  }
  return cachedPollIntervalMinutes;
}

/** Test-only: re-read TASK_SYNC_POLL_INTERVAL_MINUTES on next access. */
export function _resetPollIntervalForTests(): void {
  cachedPollIntervalMinutes = null;
}

// ─── Adapter registry ──────────────────────────────────────────────────

const adapters = new Map<TaskProvider, TaskProviderAdapter>();
let builtInAdaptersAttempted = false;

function ensureBuiltInAdaptersRegistered(provider?: TaskProvider): void {
  if (builtInAdaptersAttempted) return;
  if (provider && provider !== 'ms_todo') return;
  builtInAdaptersAttempted = true;

  try {
    if (!adapters.has('ms_todo')) {
      const { MicrosoftTodoAdapter } = require('./microsoft-todo-adapter');
      registerAdapter(new MicrosoftTodoAdapter());
    }
  } catch (err) {
    logger.warn({ err }, 'Built-in Microsoft To Do adapter registration failed');
  }
}

/**
 * Register a TaskProviderAdapter at app startup. Subsequent calls with the
 * same provider name overwrite — useful for tests with mock adapters.
 */
export function registerAdapter(adapter: TaskProviderAdapter): void {
  adapters.set(adapter.provider, adapter);
  logger.info({ provider: adapter.provider }, 'Task provider adapter registered');
}

/** Look up a registered adapter (or undefined if none registered). */
export function getAdapter(provider: TaskProvider): TaskProviderAdapter | undefined {
  ensureBuiltInAdaptersRegistered(provider);
  return adapters.get(provider);
}

/** All currently registered adapter names — for diagnostics + portal display. */
export function listRegisteredAdapters(): TaskProvider[] {
  ensureBuiltInAdaptersRegistered();
  return Array.from(adapters.keys());
}

/** Test-only: clear the adapter registry between vitest runs. */
export function _resetAdaptersForTests(): void {
  adapters.clear();
  builtInAdaptersAttempted = false;
}

// ─── Sync orchestration ───────────────────────────────────────────────

/**
 * Sync all tasks from a single provider for a single user.
 * Idempotent — safe to call repeatedly. Returns a structured result so
 * callers (cron, webhook handler, manual /sync command) can log + display.
 */
export async function syncProvider(
  userId: number,
  provider: TaskProvider,
  options?: {
    /** Bypass the poll-interval gate (manual "/sync now", webhook catch-up). */
    force?: boolean;
  },
): Promise<SyncResult> {
  ensureBuiltInAdaptersRegistered(provider);
  const start = Date.now();
  const errors: string[] = [];
  let tasksUpserted = 0;
  let tasksDeleted = 0;
  let projectsUpserted = 0;

  const adapter = adapters.get(provider);
  if (!adapter) {
    return { provider, tasksUpserted: 0, tasksDeleted: 0, projectsUpserted: 0, durationMs: 0, errors: ['Adapter not registered'] };
  }
  if (!adapter.isConnected(userId)) {
    return { provider, tasksUpserted: 0, tasksDeleted: 0, projectsUpserted: 0, durationMs: 0, errors: ['Not connected'] };
  }

  const syncState = getSyncState(userId, provider);

  // ── Poll-interval gate (full-pull providers only) ──
  // Skip the pull while the last SUCCESSFUL sync (status 'idle' — error and
  // stale-'syncing' states retry immediately) is younger than the interval.
  // Deliberately does NOT touch sync_state, so "Last synced" stays truthful
  // and the stored timestamp keeps aging toward the next real pull.
  if (!options?.force && !adapter.capabilities.hasIncrementalSync) {
    const intervalMinutes = taskSyncPollIntervalMinutes();
    if (intervalMinutes > 0 && syncState?.status === 'idle' && syncState.last_sync_at) {
      const elapsedMs = Date.now() - Date.parse(syncState.last_sync_at);
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < intervalMinutes * 60_000) {
        logger.debug(
          { userId, provider, lastSyncAt: syncState.last_sync_at, intervalMinutes },
          'Task pull skipped — poll interval not yet elapsed for full-pull provider',
        );
        return {
          provider,
          tasksUpserted: 0,
          tasksDeleted: 0,
          projectsUpserted: 0,
          durationMs: 0,
          errors: [],
          skipped: 'skipped_poll_interval',
        };
      }
    }
  }

  try {
    updateSyncStatus(userId, provider, 'syncing');

    // ── Sync projects first so task→project FK can be resolved later ──
    // Keep the fetched set so getTasks can reuse it — the Microsoft To Do
    // adapter would otherwise re-fetch every list a second time per sync.
    let knownProjects: NormalizedProject[] | undefined;
    try {
      const projects = await adapter.getProjects(userId);
      knownProjects = projects;
      for (const project of projects) {
        const result = upsertProject(userId, project);
        if (result !== 'unchanged') projectsUpserted++;
      }
    } catch (err: any) {
      errors.push(`projects: ${err?.message || String(err)}`);
      logger.warn({ err, userId, provider }, 'Project sync failed (non-fatal)');
    }

    // ── Sync tasks (with cursor if the adapter supports incremental) ──
    const cursor = adapter.capabilities.hasIncrementalSync && syncState?.sync_cursor
      ? syncState.sync_cursor
      : undefined;

    const { tasks, nextCursor } = await adapter.getTasks(userId, {
      sinceCursor: cursor || undefined,
      knownProjects,
    });

    const seenExternalIds: string[] = [];
    for (const task of tasks) {
      try {
        const result = upsertTask(userId, task);
        if (result !== 'unchanged') tasksUpserted++;
        seenExternalIds.push(task.externalId);
      } catch (err: any) {
        errors.push(`upsert ${task.externalId}: ${err?.message || String(err)}`);
      }
    }

    // ── Soft-delete only on full sync ──
    // If we used a cursor, the response is a delta and we DON'T know what
    // wasn't returned — could be unchanged, could be deleted. Only the full
    // pull is authoritative on "this is the complete set."
    if (!cursor) {
      tasksDeleted = softDeleteMissing(userId, provider, seenExternalIds);
    }

    saveSyncState(userId, provider, {
      lastSyncAt: new Date().toISOString(),
      syncCursor: nextCursor ?? null,
      status: errors.length > 0 ? 'error' : 'idle',
      tasksSynced: tasks.length,
      durationMs: Date.now() - start,
      errorMessage: errors.length > 0 ? errors.slice(0, 3).join('; ') : undefined,
    });

    return {
      provider,
      tasksUpserted,
      tasksDeleted,
      projectsUpserted,
      durationMs: Date.now() - start,
      errors,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    errors.push(message);
    logger.error({ err, userId, provider }, 'syncProvider failed');
    saveSyncState(userId, provider, {
      lastSyncAt: new Date().toISOString(),
      status: 'error',
      durationMs: Date.now() - start,
      errorMessage: message,
    });
    return {
      provider,
      tasksUpserted,
      tasksDeleted: 0,
      projectsUpserted,
      durationMs: Date.now() - start,
      errors,
    };
  }
}

/**
 * Sync every connected adapter for a single user. Used by the 15-minute cron.
 *
 * Adapters run sequentially — not in parallel — so a slow adapter doesn't
 * starve the SQLite connection pool. With ≤4 providers and an avg pull of
 * <2s each, sequential takes ≤10s per user, well within the cron window.
 */
export async function syncAllProviders(userId: number): Promise<SyncResult[]> {
  if (!isSyncEnabled(userId)) {
    return [];
  }

  ensureBuiltInAdaptersRegistered();
  const results: SyncResult[] = [];
  for (const [provider, adapter] of adapters) {
    if (!adapter.isConnected(userId)) continue;
    try {
      results.push(await syncProvider(userId, provider));
    } catch (err) {
      logger.warn({ err, userId, provider }, 'syncAllProviders: provider failed');
      results.push({
        provider,
        tasksUpserted: 0,
        tasksDeleted: 0,
        projectsUpserted: 0,
        durationMs: 0,
        errors: [(err as Error).message],
      });
    }
  }
  return results;
}
