// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getCached, setCache, clearCache, getCachedSWR, setCacheSWR, userCacheKey } from '../../services/cache-store';
import { invalidatePlanningCaches } from '../../services/plan-cache-invalidator';
import { sendSuccess, sendError } from '../response-helpers';
import * as microsoftTodo from '../../services/microsoft-todo';
import { getTaskProviderForUser, resolveTaskProvider } from '../../services/task-store/task-router';
import { resolveTaskCreationList } from '../../services/task-store/task-list-resolution';
import { getOwnerBootstrapUser } from '../../services/user-service';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

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
function swrRefresh(key: string, fn: () => Promise<void>): void {
  if (swrInFlight.has(key)) return;
  swrInFlight.add(key);
  // Detached so the response goes out immediately.
  fn().catch((err) => logger.debug({ err, key }, 'SWR background refresh failed'))
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
      const cacheKey = userId ? `u:${userId}:task-lists` : 'task-lists';
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
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch lists', 500);
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
      // Invalidate lists cache
      const cacheKey = userId ? `u:${userId}:task-lists` : 'task-lists';
      const { clearCache } = require('../../services/cache-store');
      clearCache(cacheKey);
      sendSuccess(res, result.data, { status: 201 });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists POST failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create list', 500);
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
    const cacheKey = userId ? `u:${userId}:tasks-filtered:${filter}` : `tasks-filtered:${filter}`;
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

      // Lisbon timezone for date comparison
      const now = new Date();
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: config.app.timezone });

      function getDueDateLisbon(t: any): string | null {
        const raw = t.dueDateTime?.dateTime || t.dueDateTime;
        if (!raw) return null;
        return new Date(raw).toLocaleDateString('en-CA', { timeZone: config.app.timezone });
      }

      let filtered = allTasks;
      if (filter === 'overdue') {
        filtered = allTasks.filter((t: any) => {
          const dueStr = getDueDateLisbon(t);
          return dueStr && dueStr < todayStr;
        });
      } else if (filter === 'dueToday') {
        filtered = allTasks.filter((t: any) => {
          const dueStr = getDueDateLisbon(t);
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
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch tasks', 500);
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
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch list tasks', 500);
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const userId = (req as any).userId;
      const syncProvider = resolveTaskProvider(userId);
      const todo = getTodo(req);
      const { title, listName, dueDateTime, importance, body } = req.body;

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

      const result = await todo.createTask(list.id, list.displayName, {
        title,
        dueDateTime: dueDateTime || undefined,
        importance: (importance || 'normal') as 'low' | 'normal' | 'high',
        body: body || undefined,
      });

      if (!result?.success) {
        logger.error({ err: result?.error, list: list.displayName }, 'iOS tasks create failed at MS Graph');
        sendError(res, 'CREATE_FAILED', result?.error || 'Failed to create task in Microsoft To Do', 500);
        return;
      }

      // Invalidate task caches (new task changes list contents)
      invalidateTaskCaches(list.id, userId);

      sendSuccess(
        res,
        { task: normalizeTaskDto(result.data, syncProvider, { listId: list.id, listName: list.displayName }) },
        { status: 201 }
      );
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create task', 500);
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;
      const listName = await resolveTaskListName(todo, listId);

      const ALLOWED_FIELDS = new Set(['title', 'body', 'importance', 'status', 'dueDateTime']);
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_FIELDS.has(key)) updates[key] = value;
      }

      const result = await todo.updateTask(listId, taskId, updates, listName);
      const task = await resolveMutatedTask(todo, listId, taskId, listName, result?.data || result);

      invalidateTaskCaches(listId, (req as any).userId);
      sendSuccess(
        res,
        { task: normalizeTaskDto(task, resolveTaskProvider((req as any).userId), { listId, listName }) },
      );
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update task', 500);
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;
      const listName = await resolveTaskListName(todo, listId);

      const result = await todo.completeTask(listId, taskId, listName);
      const task = await resolveMutatedTask(todo, listId, taskId, listName, result?.data || result);
      const normalizedTask = normalizeTaskDto(task, resolveTaskProvider((req as any).userId), { listId, listName });

      invalidateTaskCaches(listId, (req as any).userId);
      sendSuccess(res, { task: normalizedTask, message: `✅ Completed: ${normalizedTask.title || 'task'}` });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks complete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to complete task', 500);
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

      // MS Graph: PATCH /me/todo/lists/{listId}/tasks/{taskId}/checklistItems/{itemId}
      const { getGraphClient } = require('../../services/microsoft-auth');
      const client = getGraphClient(req);
      const result = await client
        .api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`)
        .patch({ isChecked });

      sendSuccess(res, { item: result });
    } catch (err: any) {
      logger.error({ err }, 'iOS checklist toggle failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to toggle checklist item', 500);
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

      invalidateTaskCaches(listId, (req as any).userId);
      invalidateTaskCaches(targetListId, (req as any).userId);

      sendSuccess(res, { task: newTask, movedFrom: listId, movedTo: targetListId });
    } catch (err: any) {
      logger.error({ err }, 'iOS task move failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to move task', 500);
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo(req);
      const { listId, taskId } = req.params;

      await todo.deleteTask(listId, taskId);
      invalidateTaskCaches(listId, (req as any).userId);
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete task', 500);
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
function invalidateTaskCaches(listId?: string, userId?: number): void {
  const prefixes = userId ? [`u:${userId}:`, ''] : [''];
  for (const p of prefixes) {
    clearCache(`${p}task-lists`);
    clearCache(`${p}fastpath:pending-tasks`);
    clearCache(`${p}tasks-filtered:all`);
    clearCache(`${p}tasks-filtered:overdue`);
    clearCache(`${p}tasks-filtered:dueToday`);
    if (listId) {
      clearCache(`${p}tasks:${listId}:all`);
      clearCache(`${p}tasks:${listId}:notStarted`);
      clearCache(`${p}tasks:${listId}:completed`);
    }
  }
  invalidatePlanningCaches(userId);
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
    // SWR write — fresh window matches old TTL, stale grace gives the next
    // 30 min of "instant" responses even if the warmer hits a transient error.
    setCacheSWR('task-lists', { lists: formatted }, LISTS_CACHE_TTL, LISTS_SWR_STALE);

    // Cache the cross-list "all pending tasks" snapshot used by both
    // /api/v1/tasks/filtered AND the chat fast-path (/overdue, /duetoday, etc.)
    // so the iOS chat command flow never has to wait for MS Graph.
    try {
      if (pendingResult?.success) {
        // Raw TodoTask[] for the chat-fastpath module
        // System-level warm cache (Telegram bot context, no specific userId)
        setCache('fastpath:pending-tasks', pendingResult.data, TASKS_CACHE_TTL);
      }
    } catch {
      // Non-critical — fast-path will fall back to a fresh fetch on miss
    }

    // Cache pending tasks for each list (parallel — all at once)
    await Promise.allSettled(
      lists.map(async (l: any) => {
        const listId = l.id;
        const listName = l.displayName || l.name || 'Tasks';
        const cacheKey = `tasks:${listId}:notStarted`; // System-level warm (Telegram bot)

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

async function resolveTaskListName(todo: any, listId: string): Promise<string> {
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

  try {
    const refreshed = await todo.getTasks(listId, listName);
    const tasks = Array.isArray(refreshed?.data) ? refreshed.data : [];
    return tasks.find((task: any) => String(task.id) === String(taskId)) || candidate;
  } catch {
    return candidate;
  }
}
