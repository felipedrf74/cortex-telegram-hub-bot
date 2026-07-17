// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { setCache, setCacheSWR } from '../../services/cache-store';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import * as microsoftTodo from '../../services/microsoft-todo';
import { getTaskProviderForUser, resolveTaskProvider } from '../../services/task-store/task-router';
import { getOwnerBootstrapUser } from '../../services/user-service';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { assertTenantScope } from '../../services/tenant-scope';
import { invalidateTaskCaches } from '../../services/cache-coherence-registry';
import {
  capTaskPageSize,
  normalizeTaskListScope,
  statusForTaskScope,
} from '../../services/task-working-set-policy';
import { buildNexusAnswerContract } from '../../services/chat-answer-contract';
import { safeRecordChatV2DeterministicReadEvidence } from '../../services/chat-deterministic-read-evidence';
import { isSingleWritePathEnabled } from '../../services/task-store/single-write-path';
import {
  addOfflineTaskChecklistItem,
  assignOfflineTaskProvider,
  createOfflineFirstTask,
  createOfflineFirstTaskList,
  deleteOfflineFirstTaskList,
  getOfflineFilteredTasks,
  getOfflineTaskById,
  getOfflineTaskChanges,
  getOfflineTaskLists,
  getOfflineTasksForList,
  getOfflineTaskSnapshot,
  moveOfflineFirstTask,
  recordLocalTaskMutation,
  retryOfflineTaskSync,
  resolveOfflineNexusTaskId,
  toggleOfflineTaskChecklistItem,
  updateOfflineFirstTask,
} from '../../services/task-store/offline-first-task-service';
import { getTaskSyncOperationalMetrics } from '../../services/task-store/task-mutation-sync-worker';
import { requestTaskSync } from '../../services/task-store/task-sync-coordinator';
import { getDb } from '../../services/database';
import {
  getTaskConflictPreview,
  resolveTaskConflict,
} from '../../services/task-store/task-conflict-resolution';

// Cache TTLs
const LISTS_CACHE_TTL = 300;  // 5 min for list names (rarely change)
const TASKS_CACHE_TTL = 120;  // 2 min for task items (change more often)

// SWR pattern: serve cached responses up to `staleSec` past the fresh boundary,
// while triggering an async refresh in the background. The user always sees
// instant responses; the next request gets the refreshed data.
const LISTS_SWR_STALE = 1800;  // 30 min stale grace for lists
const TASKS_SWR_STALE = 600;   // 10 min stale grace for individual lists

// ── POST /sync/now policy (M6) ─────────────────────────────────────────
// Bounded-wait hybrid: run-and-await up to the wait budget (env-overridable
// for tests, mirroring the task-store flag helpers) → 200 with a fresh
// /sync/status-shaped summary; already-active/coalesced, initial-import, or
// timeout → 202 { syncRequestId, status: 'queued' }. Per-user fixed-window
// rate limit mirrors the worker's provider-write bucket pattern.
const SYNC_NOW_DEFAULT_WAIT_MS = 8_000;
const SYNC_NOW_RATE_LIMIT = 6;
const SYNC_NOW_RATE_WINDOW_MS = 60_000;
const syncNowRateBuckets = new Map<number, { windowStart: number; count: number }>();

function syncNowWaitMs(): number {
  const parsed = Number(process.env.TASK_SYNC_NOW_WAIT_MS || '');
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return SYNC_NOW_DEFAULT_WAIT_MS;
}

function allowSyncNow(userId: number): boolean {
  const now = Date.now();
  const bucket = syncNowRateBuckets.get(userId);
  if (!bucket || now - bucket.windowStart >= SYNC_NOW_RATE_WINDOW_MS) {
    syncNowRateBuckets.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= SYNC_NOW_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

/** Test-only: clear the per-user force-sync rate limiter. */
export function _resetTaskSyncNowRateLimiterForTests(): void {
  syncNowRateBuckets.clear();
}

/**
 * A provider whose very first import has not completed yet (status 'syncing'
 * with no successful sync recorded) — force-sync answers 202 while that
 * initial import (or a delta 410 resync riding the active run) is in flight.
 */
function isInitialTaskImportInProgress(userId: number): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM task_sync_state
       WHERE user_id = ? AND status = 'syncing' AND last_sync_at IS NULL
       LIMIT 1`,
    ).get(userId);
    return !!row;
  } catch {
    return false;
  }
}

async function awaitSyncCompletion<T>(completion: Promise<T>, waitMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function dateKeyInAppTimezone(
  value: Date | string,
  timezone = config.app.timezone || 'Europe/Lisbon',
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function taskDueDateKey(
  task: any,
  timezone = config.app.timezone || 'Europe/Lisbon',
): string | null {
  const raw = task?.dueDateTime?.dateTime || task?.dueDateTime;
  if (!raw) return null;
  return dateKeyInAppTimezone(raw, timezone);
}

function normalizedTaskStatus(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

function isTaskStatusOnlyPatch(body: unknown): body is { status?: unknown; idempotencyKey?: unknown; clientMutationId?: unknown; baseLocalVersion?: unknown } {
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => ['status', 'idempotencyKey', 'clientMutationId', 'baseLocalVersion'].includes(key));
}

/**
 * Map a VERSION_CONFLICT (optional client OCC, NEX-24) to the 409 contract:
 * the current task DTO rides in error.details so the client can rebase
 * without a second read. Returns true when the error was handled.
 */
function sendVersionConflict(res: Response, err: any): boolean {
  if (err?.code !== 'VERSION_CONFLICT') return false;
  sendError(res, 'VERSION_CONFLICT', err.message || 'Task changed since the client base version', 409, {
    currentTask: err.currentTask || null,
  });
  return true;
}

function isCompletedLikeTask(task: any): boolean {
  switch (normalizedTaskStatus(task?.status)) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'cancelled':
    case 'canceled':
      return true;
    default:
      return false;
  }
}

function recordTasksFilteredApiReadEvidence(input: {
  userId: number;
  tenantId: number | undefined;
  filter: string;
  payload: { count?: unknown };
  cached: boolean;
}): void {
  const tenantId = typeof input.tenantId === 'number' && input.tenantId > 0 ? input.tenantId : input.userId;
  const normalizedMessage = `GET /api/v1/tasks/filtered?filter=${input.filter}`;
  const requestId = `tasks-filtered:${tenantId}:${input.userId}:${input.filter}:${Date.now()}`;
  const count = typeof input.payload.count === 'number' ? input.payload.count : 0;
  safeRecordChatV2DeterministicReadEvidence({
    tenantId,
    userId: input.userId,
    requestId,
    normalizedMessage,
    tokenZeroSurface: 'api',
    tokenZeroPreserved: true,
    tenantUserIsolationPassed: true,
    response: {
      id: requestId,
      text: `Tasks API returned ${count} item${count === 1 ? '' : 's'}.`,
      domain: 'tasks',
      routeMethod: 'api',
      metadata: {
        chatReasoning: buildNexusAnswerContract({
          intent: 'tasks.read',
          ownerSkill: 'tasks',
          routeMethod: 'api',
          routeKind: 'local_read',
          groundingRequirement: 'local',
          expectedResponseShape: 'task_options',
          language: 'en',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          confidence: 1,
          traceId: requestId,
          fallback: input.cached ? { fallbackType: 'cached_read' } : undefined,
        }),
      },
    },
  });
}

/**
 * Get the task provider for the current request's user.
 * If the user has MS To-Do connected → microsoft-todo module.
 * If not → native SQLite task adapter (same interface).
 *
 * M5: only the legacy (TASK_SINGLE_WRITE_PATH=0) branches of the two list
 * routes still call this; it goes away with the flag after the soak.
 */
function getTodo(req?: any) {
  if (req?.userId) {
    try {
      return getTaskProviderForUser(req.userId);
    } catch {
      // task-router not available — fall back to MS To-Do
    }
  }
  return microsoftTodo;
}

export function taskRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'tasks_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/tasks/lists — cached in SQLite with SWR semantics.
   *
   * - Within 5 min of fetch: served instantly as fresh.
   * - 5 min – 35 min: served instantly as stale, background refresh triggered.
   * - >35 min: synchronous fetch (cold path, very rare given 2-min cache warmer).
   */
  router.get('/lists', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_lists_local_read');
      sendSuccess(res, getOfflineTaskLists(tenantId, userId));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists failed');
      sendInternalError(res, 'Failed to fetch lists');
    }
  });

  router.get('/snapshot', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_snapshot_local_read');
      sendSuccess(res, getOfflineTaskSnapshot(tenantId, userId, {
        pageSize: capTaskPageSize(req.query.pageSize, 75, 200),
      }));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/snapshot failed');
      sendInternalError(res, 'Failed to fetch task snapshot');
    }
  });

  router.get('/changes', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_changes_local_read');
      const sinceCursor = typeof req.query.sinceCursor === 'string' ? req.query.sinceCursor : undefined;
      sendSuccess(res, getOfflineTaskChanges(tenantId, userId, sinceCursor));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/changes failed');
      sendInternalError(res, 'Failed to fetch task changes');
    }
  });

  router.get('/sync/status', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_sync_status_local_read');
      sendSuccess(res, getTaskSyncOperationalMetrics(tenantId, userId));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/status failed');
      sendInternalError(res, 'Failed to fetch task sync status');
    }
  });

  /**
   * POST /api/v1/tasks/sync/now — real force-sync (M6, token-zero surface).
   *
   * Runs push + forced pull through the task-sync coordinator (single-flight
   * per scope — providers are only ever reached through it, and delta mode
   * only when TASK_MS_DELTA_SYNC is on). Bounded-wait hybrid:
   *   - run finished within the wait budget → 200 with the run summary plus
   *     a fresh /sync/status-shaped payload;
   *   - a sync was already active (request coalesced), an initial import or
   *     410 resync is in flight, or the wait budget elapsed → 202
   *     { syncRequestId, status: 'queued' } — the run keeps going.
   * Rate-limited per user (fixed window) → 429 RATE_LIMITED.
   */
  router.post('/sync/now', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_sync_now_mutation');
      if (!allowSyncNow(userId)) {
        sendError(res, 'RATE_LIMITED', 'Too many sync requests. Try again shortly.', 429);
        return;
      }

      const request = requestTaskSync({ tenantId, userId }, 'force_sync', {
        push: true,
        pull: 'all',
        pullForce: true,
      });

      if (request.status === 'coalesced' || isInitialTaskImportInProgress(userId)) {
        sendSuccess(res, { syncRequestId: request.syncRequestId, status: 'queued' }, { status: 202 });
        return;
      }

      const summary = await awaitSyncCompletion(request.completion, syncNowWaitMs());
      if (!summary) {
        sendSuccess(res, { syncRequestId: request.syncRequestId, status: 'queued' }, { status: 202 });
        return;
      }

      sendSuccess(res, {
        syncRequestId: request.syncRequestId,
        status: 'completed',
        sync: {
          startedAt: summary.startedAt,
          finishedAt: summary.finishedAt,
          push: summary.push,
          pull: summary.pull,
          errors: summary.errors,
        },
        ...getTaskSyncOperationalMetrics(tenantId, userId),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/now failed');
      sendInternalError(res, 'Failed to run task sync');
    }
  });

  /**
   * GET /api/v1/tasks/working-set — bounded app-facing snapshot.
   *
   * This is the first-load contract for iOS. It returns enough active task
   * truth to paint the Tasks tab without pulling completed history into the
   * active UI state. Historical completed tasks stay behind explicit,
   * paginated list reads.
   */
  router.get('/working-set', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_working_set_local_read');
      sendSuccess(res, getOfflineTaskSnapshot(tenantId, userId, {
        pageSize: capTaskPageSize(req.query.pageSize, 75, 200),
      }));
    } catch (err: any) {
      if (err?.code || err?.status) {
        sendError(res, err?.code ?? 'UNAUTHORIZED', err?.message ?? 'Authenticated user required', err?.status ?? 401);
        return;
      }
      logger.error({ err }, 'iOS tasks/working-set failed');
      sendInternalError(res, 'Failed to fetch task working set');
    }
  });

  /**
   * POST /api/v1/tasks/lists — create a new task list.
   * Body: { name: string }
   * M5: writes the offline-first ledger (instant local visibility, async
   * provider push); the legacy provider route survives behind
   * TASK_SINGLE_WRITE_PATH=0.
   */
  router.post('/lists', async (req, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendError(res, 'VALIDATION', 'name is required', 400);
        return;
      }
      if (isSingleWritePathEnabled()) {
        // M5 ledger path (NEX-10): the local unified_projects row exists
        // immediately, so GET /lists shows the new list instantly; the
        // provider push is journaled for the mutation worker.
        const { userId: scopedUserId, tenantId } = assertTenantScope(req as any, 'tasks_lists_create_local_mutation');
        const result = createOfflineFirstTaskList(tenantId, scopedUserId, {
          name: name.trim(),
          idempotencyKey: req.body?.idempotencyKey,
          clientMutationId: req.body?.clientMutationId,
        });
        invalidateTaskCaches({ userId: scopedUserId, includeDerivedSurfaces: false });
        // CONTRACT PIN: deployed iOS decodes `id` and `displayName` as
        // NON-OPTIONAL strings and uses `id` for subsequent reads, so `id`
        // MUST be the local project row id that GET /lists returns.
        sendSuccess(res, { id: result.list.id, displayName: result.list.name }, { status: 201 });
        return;
      }
      // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
      const todo = getTodo(req);
      const result = await todo.createList(name.trim());
      if (!result?.success) {
        sendError(res, 'UNSUPPORTED', result?.error || 'Task list creation is not supported by the active task provider', 400);
        return;
      }
      invalidateTaskCaches({ userId, includeDerivedSurfaces: false });
      sendSuccess(res, result.data, { status: 201 });
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid list create request', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks/lists POST failed');
      sendInternalError(res, 'Failed to create list');
    }
  });

  /**
   * GET /api/v1/tasks/filtered?filter=overdue|dueToday|all
   * Returns tasks across ALL lists in a single call (no N+1).
   * SWR-cached: 2 min fresh, 10 min stale grace.
   */
  router.get('/filtered', async (req, res: Response) => {
    const filter = (req.query.filter as string) || 'all';
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_filtered_local_read');
      const payload = getOfflineFilteredTasks(tenantId, userId, filter);
      recordTasksFilteredApiReadEvidence({
        userId,
        tenantId,
        filter,
        payload,
        cached: false,
      });
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/filtered failed');
      sendInternalError(res, 'Failed to fetch tasks');
    }
  });

  /**
   * GET /api/v1/tasks/list/:listId — SWR-cached per list.
   *
   * - 2 min fresh window
   * - 10 min stale grace (background refresh on stale hits)
   */
  router.get('/list/:listId', async (req, res: Response) => {
    const { listId } = req.params;
    const scope = normalizeTaskListScope(req.query.scope, req.query.status);
    const status = statusForTaskScope(scope, req.query.status);
    const pageSize = capTaskPageSize(req.query.pageSize ?? req.query.limit, scope === 'completed' ? 50 : 75, 150);
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_list_local_read');
      sendSuccess(res, getOfflineTasksForList(tenantId, userId, listId, {
        status,
        pageSize,
        listName: typeof req.query.listName === 'string' ? req.query.listName : undefined,
      }));
      return;
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/list failed');
      sendInternalError(res, 'Failed to fetch list tasks');
      return;
    }

  });

  /** GET /api/v1/tasks/:listId/:taskId — full task detail for drill-down/edit flows */
  router.get('/:listId/:taskId', async (req, res: Response) => {
    try {
      const { taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_detail_local_read');
      const task = getOfflineTaskById(tenantId, userId, taskId);
      if (!task) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      sendSuccess(res, { task });
    } catch (err: any) {
      logger.error({ err }, 'iOS task detail failed');
      sendInternalError(res, 'Failed to fetch task detail');
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_create_local_mutation');
      const { title, listName, dueDateTime, importance, body, recurrence, idempotencyKey, clientMutationId } = req.body;

      if (!title) {
        sendError(res, 'BAD_REQUEST', 'title is required');
        return;
      }

      const result = createOfflineFirstTask(tenantId, userId, {
        title,
        listName,
        dueDateTime,
        importance,
        body,
        recurrence,
        idempotencyKey,
        clientMutationId,
      });
      invalidateTaskRouteCaches(result.task.listId || undefined, userId);
      sendSuccess(res, result, { status: 201 });
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'BAD_REQUEST', err.message || 'Invalid task payload', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks create failed');
      sendInternalError(res, 'Failed to create task');
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      {
        const { listId, taskId } = req.params;
        const { userId: scopedUserId, tenantId: scopedTenantId } = assertTenantScope(req as any, 'tasks_update_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, scopedUserId, taskId);
        if (nexusTaskId) {
          const statusOnlyPatch = isTaskStatusOnlyPatch(req.body);
          const normalizedStatus = normalizedTaskStatus(req.body?.status);
          if (statusOnlyPatch && ['completed', 'complete', 'done'].includes(normalizedStatus)) {
            const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
              taskId: nexusTaskId,
              operation: 'task.complete',
              idempotencyKey: req.body?.idempotencyKey,
              clientMutationId: req.body?.clientMutationId,
              patch: { status: 'completed' },
              baseLocalVersion: req.body?.baseLocalVersion,
            });
            invalidateTaskRouteCaches(listId, scopedUserId);
            sendSuccess(res, result);
            return;
          }
          if (statusOnlyPatch && ['notstarted', 'pending', 'open', 'inprogress'].includes(normalizedStatus)) {
            const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
              taskId: nexusTaskId,
              operation: 'task.reopen',
              idempotencyKey: req.body?.idempotencyKey,
              clientMutationId: req.body?.clientMutationId,
              patch: { status: req.body?.status || 'notStarted' },
              baseLocalVersion: req.body?.baseLocalVersion,
            });
            invalidateTaskRouteCaches(listId, scopedUserId);
            sendSuccess(res, result);
            return;
          }
          const result = updateOfflineFirstTask(scopedTenantId, scopedUserId, {
            taskId: nexusTaskId,
            title: req.body?.title,
            body: req.body?.body,
            importance: req.body?.importance,
            status: req.body?.status,
            dueDateTime: req.body?.dueDateTime,
            recurrence: req.body?.recurrence,
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, scopedUserId);
          sendSuccess(res, result);
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS tasks update failed');
      sendInternalError(res, 'Failed to update task');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      {
        const { userId: scopedUserId, tenantId: scopedTenantId } = assertTenantScope(req as any, 'tasks_complete_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, scopedUserId, taskId);
        if (nexusTaskId) {
          const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
            taskId: nexusTaskId,
            operation: 'task.complete',
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            patch: { status: 'completed' },
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, scopedUserId);
          sendSuccess(res, {
            ...result,
            alreadyCompleted: false,
            message: `✅ Completed: ${result.task.title || 'task'}`,
          });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS tasks complete failed');
      sendInternalError(res, 'Failed to complete task');
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId/checklist/:itemId — toggle a checklist item */
  router.patch('/:listId/:taskId/checklist/:itemId', async (req, res: Response) => {
    try {
      const { listId, taskId, itemId } = req.params;
      const { isChecked } = req.body;

      if (typeof isChecked !== 'boolean') {
        sendError(res, 'VALIDATION', 'isChecked (boolean) is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_checklist_toggle_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      const result = toggleOfflineTaskChecklistItem(tenantId, userId, {
        taskId: nexusTaskId,
        itemId,
        isChecked,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, {
        item: result.item,
        task: result.task,
        mutationId: result.mutationId,
        clientMutationId: result.clientMutationId,
        idempotencyKey: result.idempotencyKey,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Checklist item not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid checklist mutation', 400);
        return;
      }
      logger.error({ err }, 'iOS checklist toggle failed');
      sendInternalError(res, 'Failed to toggle checklist item');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/checklist — add a checklist item */
  router.post('/:listId/:taskId/checklist', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const displayName = String(req.body?.displayName || '').trim();

      if (!displayName) {
        sendError(res, 'VALIDATION', 'displayName is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_checklist_add_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      const result = addOfflineTaskChecklistItem(tenantId, userId, {
        taskId: nexusTaskId,
        displayName,
        itemId: req.body?.itemId,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(
        res,
        {
          item: result.item,
          task: result.task,
          mutationId: result.mutationId,
          clientMutationId: result.clientMutationId,
          idempotencyKey: result.idempotencyKey,
          idempotentReplay: result.idempotentReplay,
        },
        { status: 201 },
      );
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid checklist mutation', 400);
        return;
      }
      logger.error({ err }, 'iOS checklist add failed');
      sendInternalError(res, 'Failed to add checklist item');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/move — move task to a different list */
  router.post('/:listId/:taskId/move', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const { targetListId } = req.body;

      if (!targetListId) {
        sendError(res, 'VALIDATION', 'targetListId is required', 400);
        return;
      }

      {
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_move_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
        if (nexusTaskId) {
          const result = moveOfflineFirstTask(tenantId, userId, {
            taskId: nexusTaskId,
            targetListId,
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, userId);
          invalidateTaskRouteCaches(targetListId, userId);
          sendSuccess(res, { ...result, movedFrom: listId, movedTo: targetListId });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS task move failed');
      sendInternalError(res, 'Failed to move task');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/sync/assign-provider — choose provider sync target. */
  router.post('/:listId/:taskId/sync/assign-provider', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const provider = req.body?.provider;
      if (!provider) {
        sendError(res, 'VALIDATION', 'provider is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_assign_provider_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }

      const result = assignOfflineTaskProvider(tenantId, userId, {
        taskId: nexusTaskId,
        provider,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      } as any);
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid provider assignment', 400);
        return;
      }
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      logger.error({ err }, 'iOS task assign provider failed');
      sendInternalError(res, 'Failed to assign task provider');
    }
  });

  /**
   * GET /api/v1/tasks/:listId/:taskId/sync/conflict — conflict resolve preview.
   *
   * Live re-fetches the provider copy (reconciliation-style getTask probe,
   * 10s timeout) so the user decides against the provider's CURRENT content:
   * { conflictId, mine, theirs|null, providerVersion, providerMissing,
   * fetchedAt }. 404 CONFLICT_NOT_FOUND when the task has no unresolved
   * conflict; 503 PROVIDER_UNAVAILABLE when the provider cannot be reached.
   */
  router.get('/:listId/:taskId/sync/conflict', async (req, res: Response) => {
    try {
      const { taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_conflict_preview_read');
      const preview = await getTaskConflictPreview(tenantId, userId, taskId);
      sendSuccess(res, preview);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found in local task store', 404);
        return;
      }
      if (err?.code === 'CONFLICT_NOT_FOUND') {
        sendError(res, 'CONFLICT_NOT_FOUND', err.message || 'Task has no unresolved sync conflict', 404);
        return;
      }
      if (err?.code === 'PROVIDER_UNAVAILABLE') {
        sendError(res, 'PROVIDER_UNAVAILABLE', err.message || 'Provider is unreachable. Try again shortly.', 503);
        return;
      }
      logger.error({ err }, 'iOS task conflict preview failed');
      sendInternalError(res, 'Failed to load task conflict preview');
    }
  });

  /**
   * POST /api/v1/tasks/:listId/:taskId/sync/resolve — resolve a sync conflict.
   * Body: { strategy: 'keep_local'|'keep_provider', expectedProviderVersion?,
   * idempotencyKey?, clientMutationId? }. A provided expectedProviderVersion
   * that no longer matches the live provider copy returns 409 CONFLICT_STALE
   * with a refreshed preview in error.details.preview.
   */
  router.post('/:listId/:taskId/sync/resolve', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const strategy = req.body?.strategy;
      if (strategy !== 'keep_local' && strategy !== 'keep_provider') {
        sendError(res, 'VALIDATION', "strategy must be 'keep_local' or 'keep_provider'", 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_conflict_resolve_local_mutation');
      const result = await resolveTaskConflict(tenantId, userId, {
        taskId,
        strategy,
        expectedProviderVersion: req.body?.expectedProviderVersion,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid conflict resolution request', 400);
        return;
      }
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found in local task store', 404);
        return;
      }
      if (err?.code === 'CONFLICT_NOT_FOUND') {
        sendError(res, 'CONFLICT_NOT_FOUND', err.message || 'Task has no unresolved sync conflict', 404);
        return;
      }
      if (err?.code === 'CONFLICT_STALE') {
        sendError(res, 'CONFLICT_STALE', err.message || 'Provider copy changed since the conflict preview', 409, {
          preview: err.preview || null,
        });
        return;
      }
      if (err?.code === 'PROVIDER_UNAVAILABLE') {
        sendError(res, 'PROVIDER_UNAVAILABLE', err.message || 'Provider is unreachable. Try again shortly.', 503);
        return;
      }
      logger.error({ err }, 'iOS task conflict resolve failed');
      sendInternalError(res, 'Failed to resolve task conflict');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/sync/retry — retry queued/failed provider sync. */
  router.post('/:listId/:taskId/sync/retry', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_retry_sync_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }

      const result = retryOfflineTaskSync(tenantId, userId, {
        taskId: nexusTaskId,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      logger.error({ err }, 'iOS task retry sync failed');
      sendInternalError(res, 'Failed to retry task sync');
    }
  });

  /** DELETE /api/v1/tasks/lists/:listId — delete a task list/project when supported. */
  router.delete('/lists/:listId', async (req, res: Response) => {
    try {
      const { listId } = req.params;
      if (isSingleWritePathEnabled()) {
        // M5 ledger path (NEX-10): the local row disappears from GET /lists
        // immediately; the provider push (with the PROVIDER container id
        // captured at journal time, never the local numeric row id) runs on
        // the mutation worker.
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_lists_delete_local_mutation');
        deleteOfflineFirstTaskList(tenantId, userId, {
          listId,
          idempotencyKey: req.body?.idempotencyKey || (req.query?.idempotencyKey as string | undefined),
          clientMutationId: req.body?.clientMutationId || (req.query?.clientMutationId as string | undefined),
        });
        invalidateTaskCaches({ userId, listIds: [listId], includeDerivedSurfaces: true });
        sendSuccess(res, { deleted: true });
        return;
      }

      // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
      const todo = getTodo(req);
      if (typeof todo.deleteList !== 'function') {
        sendError(res, 'UNSUPPORTED', 'Task list deletion is not supported by the active task provider', 400);
        return;
      }

      const result = await todo.deleteList(listId);
      if (!result?.success) {
        sendError(res, 'UNSUPPORTED', result?.error || 'Task list deletion is not supported by the active task provider', 400);
        return;
      }

      invalidateTaskCaches({ userId: (req as any).userId, listIds: [listId], includeDerivedSurfaces: true });
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'List not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid list delete request', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks list delete failed');
      sendInternalError(res, 'Failed to delete task list');
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      {
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_delete_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
        if (nexusTaskId) {
          const result = recordLocalTaskMutation(tenantId, userId, {
            taskId: nexusTaskId,
            operation: 'task.delete',
            idempotencyKey: req.body?.idempotencyKey || req.query?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId || req.query?.clientMutationId,
            patch: { deleted: true },
            baseLocalVersion: req.body?.baseLocalVersion ?? (req.query?.baseLocalVersion as number | undefined),
          });
          invalidateTaskRouteCaches(listId, userId);
          sendSuccess(res, { deleted: true, ...result });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS tasks delete failed');
      sendInternalError(res, 'Failed to delete task');
    }
  });

  return router;
}

/** Invalidate task caches after mutations (create, update, complete, delete).
 * Clears both user-specific and legacy (owner) keys for backward compat. */
function invalidateTaskRouteCaches(listId?: string, userId?: number): void {
  invalidateTaskCaches({
    userId,
    listIds: listId ? [listId] : [],
    includeDerivedSurfaces: true,
  });
  // Re-warm cache in background after mutation
  setTimeout(() => warmTaskCache().catch(() => {}), 1000);
}

/**
 * Pre-populate task cache in background from the Nexus local read model.
 * Called on startup and every 2 minutes via setInterval.
 */
export async function warmTaskCache(): Promise<void> {
  try {
    const owner = getOwnerBootstrapUser();
    if (!owner?.id) {
      logger.debug('Skipping task cache warm — owner bootstrap user unavailable');
      return;
    }
    const snapshot = getOfflineTaskSnapshot(owner.id, owner.id, { pageSize: 200 });
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const lists = Array.isArray(snapshot.lists) ? snapshot.lists : [];
    const pendingTasks = tasks.filter((task: any) => !isCompletedLikeTask(task));
    const formatted = lists.map((list: any) => ({
      id: String(list.id),
      name: list.name || 'Tasks',
      taskCount: Number(list.taskCount || 0),
    }));
    // Hardening 2026-04-21: the warmer previously wrote to GLOBAL keys
    // (`task-lists`, `fastpath:pending-tasks`, `tasks:${listId}:notStarted`)
    // containing the OWNER'S data. Any read that fell back to those
    // keys leaked owner data to non-owner callers. All three write
    // sites are now scoped to the owner's userId. The iOS route
    // reads from `u:${userId}:*` and the Telegram fastpath reads via
    // `getPendingTasksCacheKey(userId)` which already composes the
    // scoped key when userId is provided.
    setCacheSWR(`u:${owner.id}:task-lists`, { lists: formatted }, LISTS_CACHE_TTL, LISTS_SWR_STALE);

    // Cache the cross-list "all pending tasks" snapshot used by both
    // /api/v1/tasks/filtered AND the chat fast-path (/overdue, /duetoday, etc.)
    // so the iOS chat command flow can render from Nexus local truth.
    try {
      setCache(`u:${owner.id}:fastpath:pending-tasks`, pendingTasks, TASKS_CACHE_TTL);
    } catch {
      // Non-critical — fast-path will fall back to a fresh fetch on miss
    }

    for (const list of formatted) {
      const taskFormatted = pendingTasks.filter((task: any) => String(task.listId || '') === String(list.id));
      setCacheSWR(
        `u:${owner.id}:tasks:${list.id}:notStarted`,
        { listName: list.name, tasks: taskFormatted },
        TASKS_CACHE_TTL,
        TASKS_SWR_STALE,
      );
    }

    logger.debug({ listCount: formatted.length }, 'Task cache warmed from local task read model');
  } catch (err) {
    logger.debug({ err }, 'Task cache warming failed (non-critical)');
  }
}
