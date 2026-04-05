// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';

// Lazy-load MS Todo service
function getTodo() {
  return require('../../services/microsoft-todo');
}

export function taskRoutes(): Router {
  const router = Router();

  /** GET /api/v1/tasks/lists */
  router.get('/lists', async (_req, res: Response) => {
    try {
      const todo = getTodo();
      const result = await todo.getLists();
      const listsArray = result?.data || result || [];
      const lists = Array.isArray(listsArray) ? listsArray : [];

      // Return lists without counts (fetching counts per list = N+1 = 12s for 10 lists)
      // Counts are fetched lazily when the user opens a specific list
      const formatted = lists.map((l: any) => ({
        id: l.id,
        name: l.displayName || l.name,
        taskCount: -1, // -1 = not yet loaded (iOS shows "..." instead of 0)
      }));

      res.json({ lists: formatted });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/tasks/list/:listId?status=notStarted */
  router.get('/list/:listId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId } = req.params;
      const status = req.query.status as string | undefined;

      // getTasks(listId, listName, filter)
      // We don't know the listName here, so pass empty — it's used for display only
      const listsResult = await todo.getLists();
      const lists = listsResult?.data || [];
      const list = Array.isArray(lists) ? lists.find((l: any) => l.id === listId) : null;
      const listName = list?.displayName || list?.name || 'Tasks';

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

      res.json({ listName, tasks: formatted });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/list failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { title, listName, dueDateTime, importance, body } = req.body;

      if (!title) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'title is required' } });
        return;
      }

      const result = await todo.createTask({
        title,
        listName: listName || 'Tasks',
        dueDateTime: dueDateTime || undefined,
        importance: importance || 'normal',
        body: body || undefined,
      });
      const task = result?.data || result;

      res.status(201).json({ task });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks create failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;
      const updates = req.body;

      const result = await todo.updateTask(listId, taskId, updates);
      const task = result?.data || result;
      res.json({ task });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks update failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;

      const result = await todo.completeTask(listId, taskId);
      const task = result?.data || result;
      res.json({
        task,
        message: `✅ Completed: ${task?.title || 'task'}`,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks complete failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const todo = getTodo();
      const { listId, taskId } = req.params;

      await todo.deleteTask(listId, taskId);
      res.json({ deleted: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks delete failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return router;
}
