// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Router — resolves which task provider to use per user.
 *
 * Decision logic:
 * 1. If user has MS To-Do OAuth tokens → use microsoft-todo
 * 2. If user has Todoist OAuth tokens → use todoist-adapter
 * 3. Otherwise → use native-adapter (SQLite-backed)
 *
 * The iOS task routes call getTaskProvider(userId) to get the right
 * service module. The returned module exposes the same interface as
 * microsoft-todo (getLists, getTasks, createTask, etc.) so the routes
 * don't need to change.
 */

import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { NativeTaskAdapter } from './native-adapter';

// Singleton native adapter
const nativeAdapter = new NativeTaskAdapter();

export type TaskProviderType = 'ms_todo' | 'todoist' | 'nexus';

/**
 * Determine which task provider a user should use.
 * Checks oauth-store for connected providers.
 */
export function resolveTaskProvider(userId: number): TaskProviderType {
  try {
    const { isConnected } = require('../oauth-store');

    // Priority: MS To-Do > Todoist > Native
    if (isConnected(userId, 'outlook')) return 'ms_todo';
    if (isConnected(userId, 'todoist')) return 'todoist';
  } catch {
    // oauth-store not available — default to native
  }

  return 'nexus';
}

/**
 * Get a microsoft-todo-compatible interface for the user's task provider.
 *
 * For MS To-Do users: returns the actual microsoft-todo module
 * (which uses getGraphClient() → per-user via the middleware override).
 *
 * For native users: returns a wrapper around NativeTaskAdapter that
 * matches the microsoft-todo module's function signatures so the
 * existing task routes work without changes.
 */
export function getTaskProviderForUser(userId: number) {
  const provider = resolveTaskProvider(userId);

  if (provider === 'ms_todo') {
    return require('../microsoft-todo');
  }

  if (provider === 'todoist') {
    return require('../microsoft-todo'); // TODO: wire todoist adapter
  }

  // Native adapter — return a microsoft-todo-compatible wrapper
  return createNativeWrapper(userId);
}

/**
 * Wraps the NativeTaskAdapter to match microsoft-todo's function signatures.
 * The iOS task routes call getLists(), getTasks(), createTask(), etc. with
 * the same shape — this wrapper translates between the two interfaces.
 */
function createNativeWrapper(userId: number) {
  return {
    async getLists() {
      const projects = await nativeAdapter.getProjects(userId);
      return {
        success: true,
        data: projects.map(p => ({
          id: p.externalId,
          displayName: p.name,
          isOwner: true,
          isShared: false,
          wellknownListName: p.isDefault ? 'defaultList' : undefined,
        })),
      };
    },

    async getTasks(listId: string, listName?: string, filter?: { status?: string }) {
      const result = await nativeAdapter.getTasks(userId, { projectId: listId });
      let tasks = result.tasks;

      if (filter?.status) {
        const statusMap: Record<string, string> = {
          notStarted: 'pending',
          completed: 'completed',
          inProgress: 'in_progress',
        };
        const normalized = statusMap[filter.status] || filter.status;
        tasks = tasks.filter(t => t.status === normalized);
      }

      return {
        success: true,
        data: tasks.map(t => taskToMsTodoShape(t, listId, listName || '')),
      };
    },

    async getAllPendingTasks() {
      const result = await nativeAdapter.getTasks(userId);
      const pending = result.tasks.filter(t => t.status !== 'completed');
      return {
        success: true,
        data: pending.map(t => taskToMsTodoShape(t, String(t.projectId || ''), t.projectName || '')),
      };
    },

    async createTask(listId: string, listName: string, data: any) {
      const projects = await nativeAdapter.getProjects(userId);
      const parsedListId = typeof listId === 'string' ? parseInt(listId, 10) : NaN;
      const matchedProject = projects.find((project) => {
        if (!Number.isNaN(parsedListId) && Number(project.externalId) === parsedListId) return true;
        if (listName && project.name.toLowerCase() === String(listName).trim().toLowerCase()) return true;
        return false;
      });
      const fallbackProject = matchedProject || projects.find((project) => project.isDefault) || projects[0];
      const task = await nativeAdapter.createTask(userId, {
        title: data.title || '(Untitled)',
        description: data.body || undefined,
        status: 'pending',
        priority: data.importance === 'high' ? 3 : data.importance === 'low' ? 1 : 2,
        dueDate: data.dueDateTime || undefined,
        projectId: fallbackProject ? parseInt(fallbackProject.externalId, 10) : undefined,
        projectName: fallbackProject?.name || listName,
      });
      return {
        success: true,
        data: taskToMsTodoShape(
          task,
          fallbackProject?.externalId || listId,
          fallbackProject?.name || listName,
        ),
      };
    },

    async updateTask(listId: string, taskId: string, data: any) {
      const updates: any = {};
      if (data.title) updates.title = data.title;
      if (data.body !== undefined) updates.description = data.body;
      if (data.importance) updates.priority = data.importance === 'high' ? 3 : data.importance === 'low' ? 1 : 2;
      if (data.status) updates.status = data.status === 'completed' ? 'completed' : 'pending';
      if (data.dueDateTime !== undefined) updates.dueDate = data.dueDateTime || undefined;

      await nativeAdapter.updateTask(userId, taskId, updates);
      return { success: true, data: { id: taskId } };
    },

    async completeTask(listId: string, taskId: string) {
      await nativeAdapter.completeTask(userId, taskId);
      return { success: true, data: { id: taskId, status: 'completed' } };
    },

    async uncompleteTask(listId: string, taskId: string) {
      await nativeAdapter.updateTask(userId, taskId, { status: 'pending' as any });
      return { success: true, data: { id: taskId, status: 'notStarted' } };
    },

    async deleteTask(listId: string, taskId: string) {
      await nativeAdapter.deleteTask(userId, taskId);
      return { success: true, data: undefined };
    },

    async createList(displayName: string) {
      const db = require('../database').getDb();
      const maxPos = (db.prepare(
        'SELECT COALESCE(MAX(position), 0) as m FROM native_task_lists WHERE user_id = ?'
      ).get(userId) as { m: number }).m;
      const result = db.prepare(
        'INSERT INTO native_task_lists (user_id, name, position) VALUES (?, ?, ?)'
      ).run(userId, displayName, maxPos + 1);
      return {
        success: true,
        data: { id: String(result.lastInsertRowid), displayName },
      };
    },

    async deleteList(listId: string) {
      const db = require('../database').getDb();
      const parsedListId = parseInt(listId, 10);
      const list = db.prepare(
        'SELECT id, is_default FROM native_task_lists WHERE id = ? AND user_id = ?'
      ).get(parsedListId, userId) as { id: number; is_default: number } | undefined;
      if (!list) {
        return { success: false, data: undefined, error: 'List not found' };
      }
      if (list.is_default) {
        return { success: false, data: undefined, error: 'Cannot delete the default list' };
      }
      db.prepare('DELETE FROM native_tasks WHERE list_id = ? AND user_id = ?').run(parsedListId, userId);
      db.prepare('DELETE FROM native_task_lists WHERE id = ? AND user_id = ?').run(parsedListId, userId);
      return { success: true, data: undefined };
    },

    async getDefaultList() {
      const projects = await nativeAdapter.getProjects(userId);
      const defaultList = projects.find(p => p.isDefault) || projects[0];
      if (!defaultList) return null;
      return { id: defaultList.externalId, displayName: defaultList.name };
    },

    async findListByName(name: string) {
      const projects = await nativeAdapter.getProjects(userId);
      const found = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (!found) return null;
      return { id: found.externalId, displayName: found.name };
    },

    async getTasksDueInRange(startDate: string, endDate: string) {
      const result = await nativeAdapter.getTasks(userId);
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      const dueTasks = result.tasks.filter((task) => {
        if (!task.dueDate) return false;
        const due = new Date(task.dueDate).getTime();
        return Number.isFinite(due) && due >= start && due <= end;
      });
      return {
        success: true,
        data: dueTasks.map((task) =>
          taskToMsTodoShape(task, String(task.projectId || ''), task.projectName || '')
        ),
      };
    },

    async searchTasks(query: string) {
      const normalizedQuery = String(query || '').trim().toLowerCase();
      const result = await nativeAdapter.getTasks(userId);
      const matches = result.tasks.filter((task) => {
        if (!normalizedQuery) return true;
        const haystack = [
          task.title,
          task.description,
          task.notes,
          task.projectName,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      });
      return {
        success: true,
        data: matches.map((task) =>
          taskToMsTodoShape(task, String(task.projectId || ''), task.projectName || '')
        ),
      };
    },

    async moveTask(listId: string, taskId: string, targetListId: string, targetListName?: string) {
      const parsedTargetListId = parseInt(targetListId, 10);
      await nativeAdapter.updateTask(userId, taskId, { projectId: parsedTargetListId } as any);
      return {
        success: true,
        data: { id: taskId, listId: targetListId, listName: targetListName || '' },
      };
    },

    async getCompletedTasksInRange(startDate: string, endDate: string) {
      const result = await nativeAdapter.getTasks(userId);
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      const completedTasks = result.tasks.filter((task) => {
        if (!task.completedAt) return false;
        const completed = new Date(task.completedAt).getTime();
        return Number.isFinite(completed) && completed >= start && completed <= end;
      });
      return {
        success: true,
        data: completedTasks.map((task) =>
          taskToMsTodoShape(task, String(task.projectId || ''), task.projectName || '')
        ),
      };
    },

    async getChecklistItems(_listId: string, _taskId: string) {
      return {
        success: true,
        data: [],
      };
    },

    async addChecklistItem(_listId: string, _taskId: string, _displayName: string) {
      return {
        success: false,
        data: null,
        error: 'Checklist items are not supported by the active task provider.',
      };
    },
  };
}

/** Convert NormalizedTask to microsoft-todo's TodoTask shape for route compat */
function taskToMsTodoShape(t: any, listId: string, listName: string) {
  return {
    id: t.externalId || String(t.id),
    listId,
    listName,
    title: t.title,
    body: t.description || t.notes || null,
    importance: t.priority >= 3 ? 'high' : t.priority >= 2 ? 'normal' : 'low',
    status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'inProgress' : 'notStarted',
    dueDateTime: t.dueDate || null,
    reminderDateTime: null,
    isReminderOn: false,
    createdDateTime: t.completedAt || new Date().toISOString(),
    completedDateTime: t.completedAt || null,
  };
}
