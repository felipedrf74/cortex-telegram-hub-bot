// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Service — read API for the unified task store, plus the LEGACY
 * complete-task write path.
 *
 * M5 single write path: task WRITES flow through the offline-first ledger
 * (offline-first-task-service.ts). `completeTask` below is retained ONLY as
 * the legacy branch behind TASK_SINGLE_WRITE_PATH=0 in the chat-core-v2
 * command executor (its sole consumer); it is removed with the flag after
 * the staging soak. The former createTask/deleteTask write helpers had no
 * remaining consumers and were deleted with M5.
 *
 *     complete → resolve task to provider → call adapter → mark store
 *     read     → query store directly (NEVER touch provider APIs)
 */

import { logger } from '../../utils/logger';
import { resolveTaskProvider } from './task-router';
import { listNativeTasks } from './native-adapter';
import {
  getTaskById,
  getTaskByIdForUser,
  getTaskWithUserId,
  markTaskCompleted,
  getAllTasks,
  TaskFilters,
} from './unified-task-store';
import { getAdapter } from './sync-engine';
import { invalidateTaskCaches } from '../cache-coherence-registry';
import { NormalizedTask, NormalizedStatus, TaskProvider } from './types';

function invalidateTaskMutationCaches(userId: number, task?: Pick<NormalizedTask, 'projectId'> | null): void {
  invalidateTaskCaches({
    userId,
    listIds: task?.projectId != null ? [String(task.projectId)] : [],
    includeDerivedSurfaces: true,
  });
}

/**
 * Mark a task complete. Resolves the local id back to (provider, externalId)
 * and tells the upstream provider before updating the store — this way the
 * user-facing UI never claims success on a write the provider rejected.
 *
 * Local Nexus-tasks (provider='nexus') skip the adapter call entirely.
 */
export async function completeTask(userId: number, taskId: number): Promise<void> {
  const found = getTaskWithUserId(taskId);
  if (!found) throw new Error(`Task ${taskId} not found`);
  if (found.userId !== userId) throw new Error('Task does not belong to user');

  const task = found.task;
  if (task.provider !== 'nexus') {
    const adapter = getAdapter(task.provider);
    if (adapter?.capabilities.canComplete && adapter.isConnected(userId)) {
      try {
        await adapter.completeTask(userId, task.externalId);
      } catch (err) {
        logger.warn({ err, taskId, provider: task.provider }, 'Provider completeTask failed — marking local anyway');
      }
    }
  }

  markTaskCompleted(taskId);
  invalidateTaskMutationCaches(userId, task);
}

/**
 * Read all tasks for a user — proxies to the unified store.
 *
 * This is what the iOS API and the AI tool layer should call. NEVER call
 * provider APIs at read time: 1) it's slow (500ms+ MS Graph round trip),
 * 2) it bypasses the dedup/sort logic in the store, 3) it leaks provider
 * details into call sites that should be provider-agnostic.
 */
export function listTasks(userId: number, filters?: TaskFilters): NormalizedTask[] {
  return getAllTasks(userId, filters);
}

/**
 * Provider-aware token-zero read of a user's tasks.
 *
 * `listTasks`/`getAllTasks` only read `unified_tasks` (the synced-provider
 * mirror). A native user's tasks live in `native_tasks` and are never
 * mirrored there, so a unified-only read reports "no open tasks" right after
 * a chat creates one. Route the read by the user's resolved provider so the
 * chat deterministic read sees what was actually written. Stays synchronous
 * and never calls a provider API — both stores are local SQLite.
 */
export function listTasksForUser(userId: number, filters?: TaskFilters): NormalizedTask[] {
  if (resolveTaskProvider(userId) === 'nexus') {
    const byProviderId = new Map<string, NormalizedTask>();

    // Native tasks are the canonical store for Nexus-local users, but older
    // local rows and some test/setup paths can still exist only in
    // unified_tasks. Include both stores without double-counting rows that
    // task-service mirrored into unified_tasks after a native adapter write.
    for (const task of getAllTasks(userId, filters)) {
      byProviderId.set(`${task.provider}:${task.externalId}`, task);
    }
    for (const task of listNativeTasks(userId, filters)) {
      byProviderId.set(`${task.provider}:${task.externalId}`, task);
    }

    return Array.from(byProviderId.values());
  }
  return getAllTasks(userId, filters);
}

/** Look up a single task by local id. */
export function getTask(taskId: number): NormalizedTask | null {
  return getTaskById(taskId);
}

/** Look up a single task by local id and user scope. Prefer this before write verification. */
export function getTaskForUser(userId: number, taskId: number): NormalizedTask | null {
  return getTaskByIdForUser(userId, taskId);
}

// Re-export status type for callers that build filters
export type { NormalizedStatus, TaskProvider };
