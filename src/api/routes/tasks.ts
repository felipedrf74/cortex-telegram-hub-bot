// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getCached, setCache, getCachedSWR, setCacheSWR, userCacheKey } from '../../services/cache-store';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import * as microsoftTodo from '../../services/microsoft-todo';
import { getTaskProviderForUser, resolveTaskProvider } from '../../services/task-store/task-router';
import { resolveTaskCreationList, TaskListResolutionError } from '../../services/task-store/task-list-resolution';
import { getOwnerBootstrapUser, getUserTimezone } from '../../services/user-service';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { invalidateTaskCaches } from '../../services/task-cache-invalidator';
import { normalizeMicrosoftRecurrence } from '../../services/recurrence-utils';
import { recordSWRRefreshFailure, recordSWRRefreshSuccess } from '../../services/swr-refresh-observability';

// Cache TTLs
const LISTS_CACHE_TTL = 300;  // 5 min for list names (rarely change)
const TASKS_CACHE_TTL = 120;  // 2 min for task items (change more often)

// SWR pattern: serve cached responses up to `staleSec` past the fresh boundary,
// while triggering an async refresh in the background. The user always sees
// instant responses; the next request gets the refreshed data.
const LISTS_SWR_STALE = 1800;  // 30 min stale grace for lists
const TASKS_SWR_STALE = 600;   // 10 min stale grace for individual lists

// In-flight refresh tracker — prevents 50 concurrent SWR requests from
// triggering 50 background refreshes for the same key. Each key can have
// at most one in-flight background fetch at a time.
const swrInFlight = new Set<string>();
const completeTaskInFlight = new Map<string, Promise<{ task: any; alreadyCompleted: boolean }>>();

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

function swrRefresh(key: string, fn: () => Promise<void>): void {
  if (swrInFlight.has(key)) return;
  swrInFlight.add(key);
  // Detached so the response goes out immediately.
  fn()
    .then(() => recordSWRRefreshSuccess(key))
    .catch((err) => recordSWRRefreshFailure(key, err, { source: 'tasks_route', operation: 'task_swr_refresh' }))
    .finally(() => swrInFlight.delete(key));
}

/**
 * Get the task provider for the current request's user.
 * If the user has MS To-Do connected → microsoft-todo module.
 * If not → native SQLite task adapter (same interface).
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

function sendTaskProviderError(
  res: Response,
  err: unknown,
  operation: 'create' | 'read' | 'update' | 'delete',
): void {
  const raw = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' && 'message' in err ? String((err as any).message) : '');
  const message = raw.toLowerCase();
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as any).status) : undefined;

  if (status === 401 || status === 403 || /\b(invalid_grant|unauthorized|forbidden|expired|reauth|token)\b/.test(message)) {
    sendError(res, 'PROVIDER_AUTH_REQUIRED', 'Reconnect your task provider and try again.', 401);
    return;
  }

  if (status === 429 || /\b(rate|quota|throttle)\b/.test(message)) {
    sendError(res, 'PROVIDER_RATE_LIMITED', 'Your task provider is rate limited right now. Try again shortly.', 429);
    return;
  }

  if ((status && status >= 500) || /\b(timeout|network|unavailable|temporar|econnreset|etimedout)\b/.test(message)) {
    sendError(res, 'PROVIDER_TEMPORARY_UNAVAILABLE', 'Your task provider is temporarily unavailable. Try again shortly.', 503);
    return;
  }

  sendInternalError(res, `Failed to ${operation} task`, { code: 'TASK_PROVIDER_FAILED' });
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
      const userId = (req as any).userId;
      // Hardening 2026-04-21: refuse to serve task data without a
      // bound userId. Prior fallback read from the global key
      // `'task-lists'` which the warmer populates with the OWNER'S
      // lists — any route hit where the auth middleware failed to
      // set userId would then leak owner data to the caller.
      if (typeof userId !== 'number' || userId <= 0) {
        sendError(res, 'UNAUTHORIZED', 'Authenticated user required', 401);
        return;
      }
      const cacheKey = `u:${userId}:task-lists`;
      const swr = getCachedSWR<any>(cacheKey);

      if (swr) {
        // Serve cached value immediately. If it's stale, trigger an async
        // refresh so the NEXT request gets fresh data.
        sendSuccess(res, swr.value, { cached: true });
        if (!swr.fresh) {
          swrRefresh(cacheKey, async () => {
            const todo = getTodo(req);
            const result = await todo.getLists();
            const listsArray = result?.data || result || [];
            const lists = Array.isArray(listsArray) ? listsArray : [];
            const countByListId = await buildTaskCountMap(todo, lists);
            const formatted = formatTaskLists(lists, countByListId);
            setCacheSWR(cacheKey, { lists: formatted }, LISTS_CACHE_TTL, LISTS_SWR_STALE);
          });
        }
        return;
      }

      // Cold path: nothing in cache at all — synchronous fetch.
      const todo = getTodo(req);
      const result = await todo.getLists();
      const listsArray = result?.data || result || [];
      const lists = Array.isArray(listsArray) ? listsArray : [];
      const countByListId = await buildTaskCountMap(todo, lists);
      const formatted = formatTaskLists(lists, countByListId);

      const payload = { lists: formatted };
      setCacheSWR(cacheKey, payload, LISTS_CACHE_TTL, LISTS_SWR_STALE);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists failed');
      sendInternalError(res, 'Failed to fetch lists');
    }
  });

  /**
   * POST /api/v1/tasks/lists — create a new task list.
   * Body: { name: string }
   * Routes to MS To-Do createList or native adapter based on user.
   */
  router.post('/lists', async (req, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendError(res, 'VALIDATION', 'name is required', 400);
        return;
      }
      const todo = getTodo(req);
      const result = await todo.createList(name.trim());
      if (!result?.success) {
        sendError(res, 'UNSUPPORTED', result?.error || 'Task list creation is not supported by the active task provider', 400);
        return;
      }
      invalidateTaskCaches({ userId, includeDerivedSurfaces: false });
      sendSuccess(res, result.data, { status: 201 });
    } catch (err: any) {
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
    const userId = (req as any).userId;
    // Hardening 2026-04-21: same fail-closed posture as /lists.
    // Do NOT fall back to a global `tasks-filtered:${filter}` key
    // — the warmer writes owner data to that key and we would
    // leak it to any caller whose userId didn't resolve.
    if (typeof userId !== 'number' || userId <= 0) {
      sendError(res, 'UNAUTHORIZED', 'Authenticated user required', 401);
      return;
    }
    const cacheKey = `u:${userId}:tasks-filtered:${filter}`;
    const syncProvider = resolveTaskProvider(userId);

    // Helper for the actual fetch+filter+cache write.
    const fetchAndCache = async (): Promise<{ tasks: any[]; count: number }> => {
      const todo = getTodo(req);
      const result = await todo.getAllPendingTasks();
      const allTasks = result?.data || result || [];
      if (!Array.isArray(allTasks)) {
        const empty = { tasks: [], count: 0 };
        setCacheSWR(cacheKey, empty, TASKS_CACHE_TTL, TASKS_SWR_STALE);
        return empty;
      }

      // Reuse the same cross-list snapshot for the chat fast-path cache so
      // `/overdue`, `/dueToday`, and the task tab share one fresh view of
      // the user's pending tasks instead of paying duplicate provider reads.
      if (userId) {
        setCache(userCacheKey(userId, 'fastpath:pending-tasks'), allTasks, TASKS_CACHE_TTL);
      }

      // Use the configured app timezone for date-only comparisons so DST
      // boundaries do not depend on the server's local clock zone.
      const timezone = getUserTimezone(userId);
      const todayStr = dateKeyInAppTimezone(new Date(), timezone) || new Date().toISOString().slice(0, 10);

      let filtered = allTasks;
      if (filter === 'overdue') {
        filtered = allTasks.filter((t: any) => {
          const dueStr = taskDueDateKey(t, timezone);
          return dueStr && dueStr < todayStr;
        });
      } else if (filter === 'dueToday') {
        filtered = allTasks.filter((t: any) => {
          const dueStr = taskDueDateKey(t, timezone);
          return dueStr === todayStr;
        });
      }

      const tasks = filtered.map((t: any) => normalizeTaskDto(t, syncProvider));

      const payload = { tasks, count: tasks.length };
      setCacheSWR(cacheKey, payload, TASKS_CACHE_TTL, TASKS_SWR_STALE);
      return payload;
    };

    try {
      const swr = getCachedSWR<any>(cacheKey);
      if (swr) {
        sendSuccess(res, swr.value, { cached: true });
        if (!swr.fresh) swrRefresh(cacheKey, async () => { await fetchAndCache(); });
        return;
      }
      const payload = await fetchAndCache();
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
    const status = req.query.status as string | undefined;
    const userId = (req as any).userId;
    const cacheKey = userId ? `u:${userId}:tasks:${listId}:${status || 'all'}` : `tasks:${listId}:${status || 'all'}`;
    const syncProvider = resolveTaskProvider(userId);

    // Helper that does the actual MS Graph fetch + cache write.
    // Reused for both the cold-path response AND background refresh.
    const fetchAndCache = async (): Promise<any> => {
      const todo = getTodo(req);
      let listName = req.query.listName as string | undefined;
      if (!listName) {
        try {
          const listsResult = await todo.getLists();
          const lists = listsResult?.data || [];
          const list = Array.isArray(lists) ? lists.find((l: any) => l.id === listId) : null;
          listName = list?.displayName || list?.name || 'Tasks';
        } catch { listName = 'Tasks'; }
      }

      const tasksResult = await todo.getTasks(listId, listName, status ? { status } : undefined);
      const tasks = tasksResult?.data || [];

      const formatted = (Array.isArray(tasks) ? tasks : []).map((t: any) =>
        normalizeTaskDto(t, syncProvider, { listId, listName })
      );

      const payload = { listName, tasks: formatted };
      setCacheSWR(cacheKey, payload, TASKS_CACHE_TTL, TASKS_SWR_STALE);
      return payload;
    };

    try {
      const swr = getCachedSWR<any>(cacheKey);
      if (swr) {
        sendSuccess(res, swr.value, { cached: true });
        if (!swr.fresh) swrRefresh(cacheKey, async () => { await fetchAndCache(); });
        return;
      }
      const payload = await fetchAndCache();
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/list failed');
      sendInternalError(res, 'Failed to fetch list tasks');
    }
  });

  /** GET /api/v1/tasks/:listId/:taskId — full task detail for drill-down/edit flows */
  router.get('/:listId/:taskId', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const todo = getTodo(req);
      const listName = await resolveTaskListName(todo, listId, (req as any).userId);
      const task = await resolveTaskDetail(todo, listId, taskId, listName);

      sendSuccess(
        res,
        { task: normalizeTaskDto(task, resolveTaskProvider((req as any).userId), { listId, listName }) },
      );
    } catch (err: any) {
      logger.error({ err }, 'iOS task detail failed');
      sendInternalError(res, 'Failed to fetch task detail');
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const userId = (req as any).userId;
      const syncProvider = resolveTaskProvider(userId);
      const todo = getTodo(req);
      const { title, listName, dueDateTime, importance, body, recurrence } = req.body;
      const timezone = getUserTimezone(userId);

      if (!title) {
        sendError(res, 'BAD_REQUEST', 'title is required');
        return;
      }

      // The MS Todo service's createTask expects (listId, listName, data) as
      // separate args — NOT a single object. We must first resolve the list
      // by name (defaulting to the user's default list when none is given).
      const targetListName = String(listName || '').trim();
      const list = await resolveTaskCreationList(todo, targetListName);
      if (!list) {
        const label = targetListName || 'capture list';
        sendError(res, 'LIST_NOT_FOUND', `List "${label}" not found`, 404);
        return;
      }
      const resolvedListId = String(list.id);
      const resolvedListName = String(list.displayName || list.name || 'Tasks');

      const result = await todo.createTask(resolvedListId, resolvedListName, {
        title,
        dueDateTime: dueDateTime || undefined,
        importance: (importance || 'normal') as 'low' | 'normal' | 'high',
        body: body || undefined,
        recurrence: normalizeMicrosoftRecurrence(recurrence, dueDateTime || new Date()),
        timeZone: timezone,
      });

      if (!result?.success) {
        const reconciled = await findTaskCreatedDespiteProviderFailure(todo, resolvedListId, resolvedListName, {
          title,
          dueDateTime: dueDateTime || undefined,
        });
        if (reconciled) {
          invalidateTaskRouteCaches(resolvedListId, userId);
          sendSuccess(
            res,
            {
              task: normalizeTaskDto(reconciled, syncProvider, { listId: resolvedListId, listName: resolvedListName }),
              reconciled: true,
            },
            { status: 201 },
          );
          return;
        }
        logger.error({ err: result?.error, list: resolvedListName }, 'iOS tasks create failed at MS Graph');
        sendTaskProviderError(res, result?.error, 'create');
        return;
      }

      const createdTask = result.data?.id
        ? await resolveTaskDetail(
            todo,
            resolvedListId,
            String(result.data.id),
            resolvedListName,
            result.data,
          )
        : result.data;

      // Invalidate task caches (new task changes list contents)
      invalidateTaskRouteCaches(resolvedListId, userId);

      sendSuccess(
        res,
        { task: normalizeTaskDto(createdTask, syncProvider, { listId: resolvedListId, listName: resolvedListName }) },
        { status: 201 }
      );
    } catch (err: any) {
      if (err instanceof TaskListResolutionError) {
        sendError(
          res,
          err.code,
          err.message,
          err.code === 'TASK_LIST_AMBIGUOUS' ? 409 : 404,
          err.details,
        );
        return;
      }
      logger.error({ err }, 'iOS tasks create failed');
      sendInternalError(res, 'Failed to create task');
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;
      const userId = (req as any).userId;
      const listName = await resolveTaskListName(todo, listId, (req as any).userId);
      const timezone = getUserTimezone(userId);

      const ALLOWED_FIELDS = new Set(['title', 'body', 'importance', 'status', 'dueDateTime']);
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_FIELDS.has(key)) updates[key] = value;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'dueDateTime')) {
        updates.timeZone = timezone;
      }

      const result = await todo.updateTask(listId, taskId, updates, listName);
      const task = await resolveMutatedTask(todo, listId, taskId, listName, result?.data || result);

      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(
        res,
        { task: normalizeTaskDto(task, resolveTaskProvider(userId), { listId, listName }) },
      );
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks update failed');
      sendInternalError(res, 'Failed to update task');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;
      const userId = (req as any).userId;
      const completeKey = `${userId || 'anon'}:${listId}:${taskId}`;
      let completion = completeTaskInFlight.get(completeKey);
      if (!completion) {
        completion = completeTaskIdempotently(todo, listId, taskId, userId)
          .finally(() => completeTaskInFlight.delete(completeKey));
        completeTaskInFlight.set(completeKey, completion);
      }

      const { task, alreadyCompleted } = await completion;
      const normalizedTask = normalizeTaskDto(task, resolveTaskProvider(userId), {
        listId,
        listName: task?.listName,
      });

      sendSuccess(res, {
        task: normalizedTask,
        alreadyCompleted,
        message: `✅ Completed: ${normalizedTask.title || 'task'}`,
      });
    } catch (err: any) {
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

      if (resolveTaskProvider((req as any).userId) !== 'ms_todo') {
        sendError(res, 'UNSUPPORTED', 'Checklist items are not supported by the active task provider', 400);
        return;
      }

      const listName = await resolveTaskListName(getTodo(req), listId, (req as any).userId);

      // MS Graph: PATCH /me/todo/lists/{listId}/tasks/{taskId}/checklistItems/{itemId}
      const { getGraphClient } = require('../../services/microsoft-auth');
      const client = getGraphClient(req);
      const result = await client
        .api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`)
        .patch({ isChecked });

      invalidateTaskRouteCaches(listId, (req as any).userId);
      const task = await resolveTaskDetail(getTodo(req), listId, taskId, listName, { id: taskId, listId, listName });

      sendSuccess(res, {
        item: {
          id: result?.id || itemId,
          displayName: result?.displayName || '',
          isChecked: result?.isChecked ?? isChecked,
        },
        task: normalizeTaskDto(task, resolveTaskProvider((req as any).userId), { listId, listName }),
      });
    } catch (err: any) {
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

      const todo = getTodo(req);
      if (typeof todo.addChecklistItem !== 'function') {
        sendError(res, 'UNSUPPORTED', 'Checklist items are not supported by the active task provider', 400);
        return;
      }

      const listName = await resolveTaskListName(todo, listId, (req as any).userId);
      const created = await todo.addChecklistItem(listId, taskId, displayName);
      if (!created?.success || !created.data) {
        sendInternalError(res, 'Failed to add checklist item');
        return;
      }

      invalidateTaskRouteCaches(listId, (req as any).userId);
      const task = await resolveTaskDetail(todo, listId, taskId, listName, { id: taskId, listId, listName });

      sendSuccess(
        res,
        {
          item: created.data,
          task: normalizeTaskDto(task, resolveTaskProvider((req as any).userId), { listId, listName }),
        },
        { status: 201 },
      );
    } catch (err: any) {
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

      // MS Graph doesn't have a native "move task" API. The pattern is:
      // 1. Read the task + its checklist items from the source list
      // 2. Create a copy in the target list
      // 3. Copy checklist items to the new task
      // 4. Delete the original
      //
      // TASK-M7: expanded to copy checklist items (previously lost on move)
      // and improved error handling so a partial success doesn't confuse the UI.
      const { getGraphClient } = require('../../services/microsoft-auth');
      const client = getGraphClient(req);

      // Step 1: Read original task + checklist items in parallel
      const [original, checklistRes] = await Promise.all([
        client.api(`/me/todo/lists/${listId}/tasks/${taskId}`).get(),
        client.api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`).get().catch(() => ({ value: [] })),
      ]);
      const checklistItems = checklistRes?.value || [];

      // Step 2: Create in target list (only copy user-editable fields)
      const newTask = await client.api(`/me/todo/lists/${targetListId}/tasks`).post({
        title: original.title,
        body: original.body,
        importance: original.importance,
        status: original.status,
        dueDateTime: original.dueDateTime,
        isReminderOn: original.isReminderOn,
        reminderDateTime: original.reminderDateTime,
      });

      // Step 3: Copy checklist items to the new task (best-effort, don't block on failure)
      if (checklistItems.length > 0 && newTask?.id) {
        await Promise.allSettled(
          checklistItems.map((ci: any) =>
            client.api(`/me/todo/lists/${targetListId}/tasks/${newTask.id}/checklistItems`).post({
              displayName: ci.displayName,
              isChecked: ci.isChecked ?? false,
            })
          )
        );
      }

      // Step 4: Delete from source list
      await client.api(`/me/todo/lists/${listId}/tasks/${taskId}`).delete();

      invalidateTaskRouteCaches(listId, (req as any).userId);
      invalidateTaskRouteCaches(targetListId, (req as any).userId);

      sendSuccess(res, { task: newTask, movedFrom: listId, movedTo: targetListId });
    } catch (err: any) {
      logger.error({ err }, 'iOS task move failed');
      sendInternalError(res, 'Failed to move task');
    }
  });

  /** DELETE /api/v1/tasks/lists/:listId — delete a task list/project when supported. */
  router.delete('/lists/:listId', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId } = req.params;
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
      logger.error({ err }, 'iOS tasks list delete failed');
      sendInternalError(res, 'Failed to delete task list');
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;

      await todo.deleteTask(listId, taskId);
      invalidateTaskRouteCaches(listId, (req as any).userId);
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks delete failed');
      sendInternalError(res, 'Failed to delete task');
    }
  });

  return router;
}

function normalizeTaskDto(
  task: any,
  syncProvider: string,
  defaults?: { listId?: string; listName?: string }
) {
  return {
    id: task.id,
    title: task.title,
    body: task.body?.content || task.body || null,
    importance: task.importance || 'normal',
    status: task.status || 'notStarted',
    dueDateTime: task.dueDateTime?.dateTime || task.dueDateTime || null,
    listId: task.listId || defaults?.listId || null,
    listName: task.listName || defaults?.listName || null,
    checklistItems: Array.isArray(task.checklistItems)
      ? task.checklistItems.map((ci: any) => ({
          id: ci.id,
          displayName: ci.displayName,
          isChecked: ci.isChecked ?? false,
        }))
      : null,
    createdDateTime: task.createdDateTime || null,
    syncProvider,
  };
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
 * Pre-populate task cache in background so users never wait for MS Graph.
 * Called on startup and every 2 minutes via setInterval.
 */
export async function warmTaskCache(): Promise<void> {
  try {
    const owner = getOwnerBootstrapUser();
    if (!owner?.id) {
      logger.debug('Skipping task cache warm — owner bootstrap user unavailable');
      return;
    }
    const todo = getTaskProviderForUser(owner.id);

    // Cache list names (fast, single MS Graph call)
    const result = await todo.getLists();
    const listsArray = result?.data || result || [];
    const lists = Array.isArray(listsArray) ? listsArray : [];
    const pendingResult = await todo.getAllPendingTasks().catch(() => null);
    const pendingTasks = Array.isArray(pendingResult?.data) ? pendingResult.data : [];
    const countByListId = pendingTasks.reduce((map: Map<string, number>, task: any) => {
      const listId = String(task?.listId || '');
      if (!listId) return map;
      map.set(listId, (map.get(listId) || 0) + 1);
      return map;
    }, new Map<string, number>());
    const formatted = formatTaskLists(lists, countByListId);
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
    // so the iOS chat command flow never has to wait for MS Graph.
    try {
      if (pendingResult?.success) {
        setCache(`u:${owner.id}:fastpath:pending-tasks`, pendingResult.data, TASKS_CACHE_TTL);
      }
    } catch {
      // Non-critical — fast-path will fall back to a fresh fetch on miss
    }

    // Cache pending tasks for each list (parallel — all at once).
    // Owner-scoped per Hardening 2026-04-21.
    await Promise.allSettled(
      lists.map(async (l: any) => {
        const listId = l.id;
        const listName = l.displayName || l.name || 'Tasks';
        const cacheKey = `u:${owner.id}:tasks:${listId}:notStarted`;

        // Skip if cache is still fresh
        if (getCached(cacheKey)) return;

        try {
          const tasksResult = await todo.getTasks(listId, listName, { status: 'notStarted' });
          const tasks = tasksResult?.data || [];
          const taskFormatted = (Array.isArray(tasks) ? tasks : []).map((t: any) => ({
            id: t.id, title: t.title,
            body: t.body?.content || t.body || null,
            importance: t.importance || 'normal',
            status: t.status || 'notStarted',
            dueDateTime: t.dueDateTime?.dateTime || t.dueDateTime || null,
            listId, listName,
            checklistItems: t.checklistItems?.map((ci: any) => ({
              id: ci.id, displayName: ci.displayName, isChecked: ci.isChecked ?? false,
            })) || null,
            createdDateTime: t.createdDateTime || null,
          }));
          setCacheSWR(cacheKey, { listName, tasks: taskFormatted }, TASKS_CACHE_TTL, TASKS_SWR_STALE);
        } catch {
          // Individual list failure is non-critical
        }
      }),
    );

    logger.debug({ listCount: lists.length }, 'Task cache warmed');
  } catch (err) {
    logger.debug({ err }, 'Task cache warming failed (non-critical)');
  }
}

function formatTaskLists(
  lists: any[],
  countByListId: Map<string, number>,
): Array<{ id: string; name: string; taskCount: number }> {
  return lists.map((l: any) => ({
    id: l.id,
    name: l.displayName || l.name,
    taskCount: countByListId.get(String(l.id)) || 0,
  }));
}

async function buildTaskCountMap(todo: any, lists: any[]): Promise<Map<string, number>> {
  const fromPendingSnapshot = await readTaskCountsFromPendingSnapshot(todo);
  if (fromPendingSnapshot) return fromPendingSnapshot;

  const countByListId = new Map<string, number>();
  const perList = await Promise.allSettled(
    lists.map(async (list: any) => {
      const listId = String(list.id || '');
      const listName = list.displayName || list.name || 'Tasks';
      const tasksResult = await todo.getTasks(listId, listName, { status: 'notStarted' });
      const tasks = Array.isArray(tasksResult?.data) ? tasksResult.data : [];
      return { listId, count: tasks.length };
    }),
  );

  for (const result of perList) {
    if (result.status !== 'fulfilled') continue;
    countByListId.set(result.value.listId, result.value.count);
  }

  return countByListId;
}

async function readTaskCountsFromPendingSnapshot(todo: any): Promise<Map<string, number> | null> {
  if (typeof todo?.getAllPendingTasks !== 'function') return null;

  try {
    const pendingResult = await todo.getAllPendingTasks();
    const pendingTasks = Array.isArray(pendingResult?.data) ? pendingResult.data : null;
    if (!pendingTasks) return null;

    return pendingTasks.reduce((map: Map<string, number>, task: any) => {
      const listId = String(task?.listId || '');
      if (!listId) return map;
      map.set(listId, (map.get(listId) || 0) + 1);
      return map;
    }, new Map<string, number>());
  } catch {
    return null;
  }
}

/**
 * Resolve a task list's display name by id.
 *
 * Perf fix (2026-04-21 tasks pass): prior implementation ALWAYS made a
 * live `todo.getLists()` call to MS Graph (~150-400ms). Every mutation
 * (PATCH / complete / checklist toggle) paid that round trip just to
 * look up a string. We now read from the user-scoped SWR cache
 * `u:${userId}:task-lists` first — which the iOS GET /tasks/lists path
 * warms on every list load and the 15-minute cron keeps fresh. Only on
 * a cache miss do we fall back to the live call.
 *
 * The cache value shape is `{ lists: [{ id, name, ... }] }`, the same
 * shape GET /tasks/lists returns (see formatTaskLists). The find-by-id
 * match is a straight string compare. A miss + live fetch is still a
 * correctness fallback, not a hot path.
 */
async function resolveTaskListName(todo: any, listId: string, userId?: number): Promise<string> {
  // Fast path: user-scoped SWR cache (saves one MS Graph RTT per mutation).
  if (typeof userId === 'number' && userId > 0) {
    try {
      const cached = getCachedSWR<{ lists?: Array<{ id?: string; name?: string; displayName?: string }> }>(
        `u:${userId}:task-lists`,
      );
      const match = cached?.value?.lists?.find((list) => String(list.id) === String(listId));
      const name = match?.displayName || match?.name;
      if (name) return name;
    } catch {
      // Fall through to live fetch on any cache error.
    }
  }

  // Cold path: live fetch (same behavior as before).
  try {
    const listsResult = await todo.getLists();
    const lists = Array.isArray(listsResult?.data) ? listsResult.data : [];
    const match = lists.find((list: any) => String(list.id) === String(listId));
    return match?.displayName || match?.name || 'Tasks';
  } catch {
    return 'Tasks';
  }
}

async function resolveMutatedTask(
  todo: any,
  listId: string,
  taskId: string,
  listName: string,
  candidate: any,
): Promise<any> {
  if (candidate?.title && (candidate?.listId || candidate?.listName)) return candidate;
  const fallback = {
    ...(candidate || { id: taskId }),
    id: candidate?.id || taskId,
    listId: candidate?.listId || listId,
    listName: candidate?.listName || listName,
  };

  try {
    const refreshed = await todo.getTasks(listId, listName);
    const tasks = Array.isArray(refreshed?.data) ? refreshed.data : [];
    return tasks.find((task: any) => String(task.id) === String(taskId)) || fallback;
  } catch {
    return fallback;
  }
}

async function completeTaskIdempotently(
  todo: any,
  listId: string,
  taskId: string,
  userId?: number,
): Promise<{ task: any; alreadyCompleted: boolean }> {
  const listName = await resolveTaskListName(todo, listId, userId);
  const current = await resolveTaskDetail(todo, listId, taskId, listName, null);
  if (String(current?.status || '').toLowerCase() === 'completed') {
    return { task: current, alreadyCompleted: true };
  }

  const result = await todo.completeTask(listId, taskId, listName);
  const task = await resolveMutatedTask(todo, listId, taskId, listName, result?.data || result);
  invalidateTaskRouteCaches(listId, userId);
  return { task, alreadyCompleted: false };
}

async function resolveTaskDetail(
  todo: any,
  listId: string,
  taskId: string,
  listName: string,
  candidate?: any,
): Promise<any> {
  if (typeof todo?.getTask === 'function') {
    try {
      const result = await todo.getTask(listId, taskId, listName);
      if (result?.success && result.data) return result.data;
    } catch {
      // Fall back to list-fetch resolution below.
    }
  }

  return resolveMutatedTask(todo, listId, taskId, listName, candidate || { id: taskId, listId, listName });
}

async function findTaskCreatedDespiteProviderFailure(
  todo: any,
  listId: string,
  listName: string,
  target: { title: string; dueDateTime?: string },
): Promise<any | null> {
  if (typeof todo?.getTasks !== 'function') return null;

  try {
    const result = await todo.getTasks(listId, listName, { status: 'notStarted' });
    const tasks = Array.isArray(result?.data) ? result.data : [];
    const wantedTitle = target.title.trim().toLowerCase();
    return tasks.find((task: any) => {
      const taskTitle = String(task?.title || '').trim().toLowerCase();
      if (taskTitle !== wantedTitle) return false;
      if (!target.dueDateTime) return true;
      const due = String(task?.dueDateTime?.dateTime || task?.dueDateTime || '');
      return due === target.dueDateTime;
    }) || null;
  } catch {
    return null;
  }
}
