// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Sync Engine — orchestrates task pulls from registered TaskProviderAdapters.
 *
 * Lifecycle:
 *   1. Adapters self-register via `registerAdapter()` at app boot
 *   2. Scheduler cron calls `syncAllProviders(userId)` every 15 minutes
 *   3. For each connected adapter, the engine:
 *        a. updates sync_state.status = 'syncing'
 *        b. pulls projects → upserts via store
 *        c. pulls tasks (with sync cursor if supported) → upserts via store
 *        d. on full pull (no cursor), soft-deletes tasks that disappeared
 *        e. saves new cursor + status='idle' to sync_state
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
import { SyncResult, TaskProvider } from './types';

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

  try {
    updateSyncStatus(userId, provider, 'syncing');

    // ── Sync projects first so task→project FK can be resolved later ──
    try {
      const projects = await adapter.getProjects(userId);
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

    const { tasks, nextCursor } = await adapter.getTasks(userId, { sinceCursor: cursor || undefined });

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
