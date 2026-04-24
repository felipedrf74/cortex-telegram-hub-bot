// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Service — high-level write API for the unified task store.
 *
 * This is the only thing handlers, AI tool calls, and the iOS API should
 * touch when they want to create / complete / delete a task. The service
 * handles the read-from-store / write-to-provider split:
 *
 *     create  → write to user's default provider → upsert into store
 *     complete → resolve task to provider → call adapter → mark store
 *     delete   → resolve task to provider → call adapter → mark store
 *     read     → query store directly (NEVER touch provider APIs)
 *
 * If the default provider is unavailable (no adapter, not connected, or
 * lacks the requested capability), writes fall back to a Nexus-local
 * task with provider='nexus' so the user is never blocked.
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  upsertTask,
  getTaskById,
  getTaskWithUserId,
  markTaskCompleted,
  markTaskDeleted,
  getDefaultProvider,
  getAllTasks,
  TaskFilters,
} from './unified-task-store';
import { getAdapter } from './sync-engine';
import { invalidateTaskCaches } from '../task-cache-invalidator';
import { NormalizedTask, NormalizedStatus, TaskProvider } from './types';

/**
 * Look up the local row id for a task by (user, provider, externalId).
 * Used by createTask after a successful upsert so the returned object has
 * the freshly-assigned auto-increment id — without requiring upsertTask to
 * change its return shape.
 */
function findLocalIdFor(userId: number, provider: TaskProvider, externalId: string): number | null {
  try {
    const row = getDb().prepare(
      'SELECT id FROM unified_tasks WHERE user_id = ? AND provider = ? AND external_id = ?',
    ).get(userId, provider, externalId) as { id: number } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function invalidateTaskMutationCaches(userId: number, task?: Pick<NormalizedTask, 'projectId'> | null): void {
  invalidateTaskCaches({
    userId,
    listIds: task?.projectId != null ? [String(task.projectId)] : [],
    includeDerivedSurfaces: true,
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  dueDate?: string;
  dueIsDatetime?: boolean;
  priority?: number;
  projectName?: string;
  tags?: string[];
  notes?: string;
}

/**
 * Create a task. Tries the user's default provider first; falls back to a
 * Nexus-local row if the provider is unreachable or doesn't support create.
 *
 * Always invalidates task-facing, Home/dashboard, plan, and AI context caches
 * so service-level writes stay consistent with REST task mutations.
 */
export async function createTask(
  userId: number,
  input: CreateTaskInput,
): Promise<NormalizedTask> {
  const defaultProvider = getDefaultProvider(userId);
  const adapter = getAdapter(defaultProvider);

  // Fast path: provider unavailable → local
  if (!adapter || !adapter.isConnected(userId) || !adapter.capabilities.canCreate) {
    return createLocalTask(userId, input);
  }

  try {
    // Hand the partial task to the adapter — adapters fill in `provider`
    // and `externalId` from the upstream API response.
    const created = await adapter.createTask(userId, {
      title: input.title,
      description: input.description,
      status: 'pending',
      priority: input.priority ?? 0,
      dueDate: input.dueDate,
      dueIsDatetime: input.dueIsDatetime,
      projectName: input.projectName,
      tags: input.tags,
      notes: input.notes,
    });

    upsertTask(userId, created);

    // Re-fetch by id so callers see the auto-assigned local id (the
    // adapter only knows about the external_id; upsertTask wrote a fresh
    // row with a new auto-increment that the in-memory `created` lacks).
    const localId = findLocalIdFor(userId, created.provider, created.externalId);
    const freshTask = localId ? (getTaskById(localId) ?? created) : created;
    invalidateTaskMutationCaches(userId, freshTask);
    return freshTask;
  } catch (err) {
    logger.warn({ err, userId, provider: defaultProvider }, 'createTask via provider failed — falling back to local');
    return createLocalTask(userId, input);
  }
}

/**
 * Create a Nexus-local task with provider='nexus'. The external_id is a
 * random UUID — there's no upstream provider to assign one. These rows
 * stay in the unified store forever (no sync engine claims them).
 */
function createLocalTask(userId: number, input: CreateTaskInput): NormalizedTask {
  const externalId = `nexus_${crypto.randomBytes(8).toString('hex')}`;
  const task: NormalizedTask = {
    provider: 'nexus',
    externalId,
    title: input.title,
    description: input.description,
    status: 'pending',
    priority: input.priority ?? 0,
    dueDate: input.dueDate,
    dueIsDatetime: input.dueIsDatetime,
    projectName: input.projectName ?? 'Inbox',
    tags: input.tags,
    notes: input.notes,
  };
  upsertTask(userId, task);

  // Re-fetch so the returned task has the freshly-assigned local id
  const localId = findLocalIdFor(userId, 'nexus', externalId);
  const freshTask = localId ? (getTaskById(localId) ?? task) : task;
  invalidateTaskMutationCaches(userId, freshTask);
  return freshTask;
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
 * Delete a task. Same provider-first-then-store contract as completeTask.
 * Local rows are soft-deleted in place; provider rows are hard-deleted
 * upstream and soft-deleted in the store (so the row remains a dedup target).
 */
export async function deleteTask(userId: number, taskId: number): Promise<void> {
  const found = getTaskWithUserId(taskId);
  if (!found) throw new Error(`Task ${taskId} not found`);
  if (found.userId !== userId) throw new Error('Task does not belong to user');

  const task = found.task;
  if (task.provider !== 'nexus') {
    const adapter = getAdapter(task.provider);
    if (adapter?.capabilities.canDelete && adapter.isConnected(userId)) {
      try {
        await adapter.deleteTask(userId, task.externalId);
      } catch (err) {
        logger.warn({ err, taskId, provider: task.provider }, 'Provider deleteTask failed — marking local anyway');
      }
    }
  }

  markTaskDeleted(taskId);
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

/** Look up a single task by local id. */
export function getTask(taskId: number): NormalizedTask | null {
  return getTaskById(taskId);
}

// Re-export status type for callers that build filters
export type { NormalizedStatus, TaskProvider };
