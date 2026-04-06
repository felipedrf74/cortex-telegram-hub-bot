// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getCached, setCache, clearCache } from '../../services/cache-store';
import { sendSuccess, sendError } from '../response-helpers';

// Cache TTLs
const LISTS_CACHE_TTL = 300;  // 5 min for list names (rarely change)
const TASKS_CACHE_TTL = 120;  // 2 min for task items (change more often)

function getTodo() {
  return require('../../services/microsoft-todo');
}

export function taskRoutes(): Router {
  const router = Router();

  /** GET /api/v1/tasks/lists — cached in SQLite for 5 min */
  router.get('/lists', async (_req, res: Response) => {
    try {
      // Check SQLite cache first (survives restarts, fast)
      const cached = getCached<any>('task-lists');
      if (cached) {
        sendSuccess(res, cached, { cached: true });
        return;
      }

      const todo = getTodo();
      const result = await todo.getLists();
      const listsArray = result?.data || result || [];
      const lists = Array.isArray(listsArray) ? listsArray : [];

      const formatted = lists.map((l: any) => ({
        id: l.id,
        name: l.displayName || l.name,
        taskCount: -1,
      }));

      const payload = { lists: formatted };
      setCache('task-lists', payload, LISTS_CACHE_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch lists', 500);
    }
  });

  /**
   * GET /api/v1/tasks/filtered?filter=overdue|dueToday|all
   * Returns tasks across ALL lists in a single call (no N+1).
   * Cached in SQLite for 2 minutes.
   */
  router.get('/filtered', async (req, res: Response) => {
    const filter = (req.query.filter as string) || 'all';
    const cacheKey = `tasks-filtered:${filter}`;

    const cached = getCached<any>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const todo = getTodo();
      const result = await todo.getAllPendingTasks();
      const allTasks = result?.data || result || [];
      if (!Array.isArray(allTasks)) {
        sendSuccess(res, { tasks: [], count: 0 });
        return;
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

      const tasks = filtered.map((t: any) => ({
        id: t.id, title: t.title,
        body: t.body?.content || t.body || null,
        importance: t.importance || 'normal',
        status: t.status || 'notStarted',
        dueDateTime: t.dueDateTime?.dateTime || t.dueDateTime || null,
        listId: t.listId || null,
        listName: t.listName || null,
        checklistItems: null,
        createdDateTime: t.createdDateTime || null,
      }));

      const payload = { tasks, count: tasks.length };
      setCache(cacheKey, payload, TASKS_CACHE_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/filtered failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch tasks', 500);
    }
  });

  /** GET /api/v1/tasks/list/:listId — cached per list for 2 min */
  router.get('/list/:listId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId } = req.params;
      const status = req.query.status as string | undefined;

      // Check SQLite cache
      const cacheKey = `tasks:${listId}:${status || 'all'}`;
      const cached = getCached<any>(cacheKey);
      if (cached) {
        sendSuccess(res, cached, { cached: true });
        return;
      }

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

      const formatted = (Array.isArray(tasks) ? tasks : []).map((t: any) => ({
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

      const payload = { listName, tasks: formatted };
      setCache(cacheKey, payload, TASKS_CACHE_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch list tasks', 500);
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { title, listName, dueDateTime, importance, body } = req.body;

      if (!title) {
        sendError(res, 'BAD_REQUEST', 'title is required');
        return;
      }

      const result = await todo.createTask({
        title, listName: listName || 'Tasks',
        dueDateTime: dueDateTime || undefined,
        importance: importance || 'normal',
        body: body || undefined,
      });
      const task = result?.data || result;

      // Invalidate task caches (new task changes list contents)
      invalidateTaskCaches();

      sendSuccess(res, { task }, { status: 201 });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create task', 500);
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;

      const ALLOWED_FIELDS = new Set(['title', 'body', 'importance', 'status', 'dueDateTime']);
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_FIELDS.has(key)) updates[key] = value;
      }

      const result = await todo.updateTask(listId, taskId, updates);
      const task = result?.data || result;

      invalidateTaskCaches(listId);
      sendSuccess(res, { task });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update task', 500);
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;

      const result = await todo.completeTask(listId, taskId);
      const task = result?.data || result;

      invalidateTaskCaches(listId);
      sendSuccess(res, { task, message: `✅ Completed: ${task?.title || 'task'}` });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks complete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to complete task', 500);
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;

      await todo.deleteTask(listId, taskId);
      invalidateTaskCaches(listId);
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete task', 500);
    }
  });

  return router;
}

/** Invalidate task caches after mutations (create, update, complete, delete) */
function invalidateTaskCaches(listId?: string): void {
  clearCache('task-lists');
  // Cross-list pending cache shared with the chat fast-path interceptor.
  clearCache('fastpath:pending-tasks');
  // Filtered task views (used by /api/v1/tasks/filtered).
  clearCache('tasks-filtered:all');
  clearCache('tasks-filtered:overdue');
  clearCache('tasks-filtered:dueToday');
  if (listId) {
    clearCache(`tasks:${listId}:all`);
    clearCache(`tasks:${listId}:notStarted`);
    clearCache(`tasks:${listId}:completed`);
  }
  // Re-warm cache in background after mutation
  setTimeout(() => warmTaskCache().catch(() => {}), 1000);
}

/**
 * Pre-populate task cache in background so users never wait for MS Graph.
 * Called on startup and every 2 minutes via setInterval.
 */
export async function warmTaskCache(): Promise<void> {
  try {
    const todo = getTodo();

    // Cache list names (fast, single MS Graph call)
    const result = await todo.getLists();
    const listsArray = result?.data || result || [];
    const lists = Array.isArray(listsArray) ? listsArray : [];
    const formatted = lists.map((l: any) => ({
      id: l.id,
      name: l.displayName || l.name,
      taskCount: -1,
    }));
    setCache('task-lists', { lists: formatted }, LISTS_CACHE_TTL);

    // Cache the cross-list "all pending tasks" snapshot used by both
    // /api/v1/tasks/filtered AND the chat fast-path (/overdue, /duetoday, etc.)
    // so the iOS chat command flow never has to wait for MS Graph.
    try {
      const pendingResult = await todo.getAllPendingTasks();
      if (pendingResult?.success) {
        // Raw TodoTask[] for the chat-fastpath module
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
        const cacheKey = `tasks:${listId}:notStarted`;

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
          setCache(cacheKey, { listName, tasks: taskFormatted }, TASKS_CACHE_TTL);
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
