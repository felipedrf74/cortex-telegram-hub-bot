// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Native Task Adapter — SQLite-backed task storage.
 *
 * For users who don't use Microsoft To-Do or Todoist. Provides a
 * fully autonomous task system with the same capabilities as external
 * providers: lists, tasks, priorities, due dates, recurrence, tags.
 *
 * Data is stored in native_task_lists + native_tasks tables. Each
 * user gets an "Inbox" default list on registration.
 *
 * Cross-module integration: Secretary can create tasks, Training
 * can schedule recovery tasks, Cooking can add shopping items —
 * all via the standard TaskProviderAdapter interface.
 */

import { getDb } from '../database';
import { logger } from '../../utils/logger';
import type { TaskProviderAdapter } from './adapter-interface';
import type {
  NormalizedChecklistItem,
  NormalizedTask,
  NormalizedProject,
  TaskProviderCapabilities,
  SyncResult,
} from './types';
import type { TaskFilters } from './unified-task-store';

export class NativeTaskAdapter implements TaskProviderAdapter {
  readonly provider = 'nexus' as const;

  readonly capabilities: TaskProviderCapabilities = {
    canCreate: true,
    canComplete: true,
    canDelete: true,
    canUpdate: true,
    canAssignDue: true,
    hasWebhooks: false,       // No external webhooks — we own the data
    hasIncrementalSync: false, // No sync needed — data is local
  };

  isConnected(_userId: number): boolean {
    // Native adapter is always "connected" — it doesn't depend on external OAuth
    return true;
  }

  async getProjects(userId: number): Promise<NormalizedProject[]> {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM native_task_lists WHERE user_id = ? ORDER BY is_default DESC, position ASC, name ASC'
    ).all(userId) as any[];

    // Auto-create default "Inbox" list if none exists
    if (rows.length === 0) {
      db.prepare(
        'INSERT INTO native_task_lists (user_id, name, is_default) VALUES (?, ?, 1)'
      ).run(userId, 'Inbox');
      return this.getProjects(userId);
    }

    return rows.map(r => ({
      provider: 'nexus' as const,
      externalId: String(r.id),
      name: r.name,
      color: r.color || undefined,
      isDefault: !!r.is_default,
    }));
  }

  async getTasks(
    userId: number,
    options?: { projectId?: string },
  ): Promise<{ tasks: NormalizedTask[]; nextCursor?: string }> {
    const db = getDb();
    let query = 'SELECT t.*, l.name AS list_name FROM native_tasks t JOIN native_task_lists l ON t.list_id = l.id WHERE t.user_id = ?';
    const params: any[] = [userId];

    if (options?.projectId) {
      query += ' AND t.list_id = ?';
      params.push(parseInt(options.projectId, 10));
    }

    query += ' ORDER BY t.position ASC, t.created_at DESC';

    const rows = db.prepare(query).all(...params) as any[];
    const tasks = rows.map(r => this.rowToNormalizedTask(r));
    const checklistByTask = this.getChecklistItemsForTasks(userId, tasks.map((task) => Number(task.id)));

    return {
      tasks: tasks.map((task) => ({
        ...task,
        checklistItems: checklistByTask.get(Number(task.id)) || [],
      })),
    };
  }

  async createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
  ): Promise<NormalizedTask> {
    const db = getDb();

    // Resolve list — use specified project or default Inbox
    let listId: number;
    if (task.projectId) {
      listId = task.projectId;
    } else {
      const defaultList = db.prepare(
        'SELECT id FROM native_task_lists WHERE user_id = ? AND is_default = 1'
      ).get(userId) as any;
      if (!defaultList) {
        // Auto-create inbox
        const result = db.prepare(
          'INSERT INTO native_task_lists (user_id, name, is_default) VALUES (?, ?, 1)'
        ).run(userId, 'Inbox');
        listId = Number(result.lastInsertRowid);
      } else {
        listId = defaultList.id;
      }
    }

    const importance = this.priorityToImportance(task.priority);
    const result = db.prepare(`
      INSERT INTO native_tasks (user_id, list_id, title, body, importance, status, due_date_time, recurrence, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      listId,
      task.title,
      task.description || task.notes || null,
      importance,
      task.status === 'completed' ? 'completed' : 'notStarted',
      task.dueDate || null,
      task.recurrence ? JSON.stringify(task.recurrence) : null,
      task.tags ? JSON.stringify(task.tags) : null,
    );

    const id = Number(result.lastInsertRowid);
    logger.info({ userId, taskId: id, title: task.title }, 'Native task created');

    return {
      ...task,
      id,
      provider: 'nexus',
      externalId: String(id),
    };
  }

  async completeTask(userId: number, externalId: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE native_tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(parseInt(externalId, 10), userId);
  }

  async deleteTask(userId: number, externalId: string): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM native_tasks WHERE id = ? AND user_id = ?')
      .run(parseInt(externalId, 10), userId);
  }

  async updateTask(
    userId: number,
    externalId: string,
    updates: Partial<NormalizedTask>,
  ): Promise<void> {
    const db = getDb();
    const sets: string[] = [];
    const params: any[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('body = ?'); params.push(updates.description); }
    if (updates.notes !== undefined) { sets.push('body = ?'); params.push(updates.notes); }
    if (updates.status !== undefined) {
      const sqlStatus = updates.status === 'completed' ? 'completed' : updates.status === 'in_progress' ? 'inProgress' : 'notStarted';
      sets.push('status = ?'); params.push(sqlStatus);
      if (updates.status === 'completed') {
        sets.push("completed_at = datetime('now')");
      }
    }
    if (updates.priority !== undefined) {
      sets.push('importance = ?');
      params.push(this.priorityToImportance(updates.priority));
    }
    if (updates.dueDate !== undefined) { sets.push('due_date_time = ?'); params.push(updates.dueDate || null); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
    if (updates.projectId !== undefined) {
      sets.push('list_id = ?');
      params.push(updates.projectId);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    params.push(parseInt(externalId, 10), userId);

    db.prepare(`UPDATE native_tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  }

  async getChecklistItems(userId: number, externalId: string): Promise<NormalizedChecklistItem[]> {
    const taskId = parseInt(externalId, 10);
    if (!Number.isInteger(taskId) || taskId <= 0) return [];
    const rows = getDb().prepare(`
      SELECT id, display_name, is_checked
      FROM native_task_checklist_items
      WHERE user_id = ? AND task_id = ?
      ORDER BY position ASC, id ASC
    `).all(userId, taskId) as any[];
    return rows.map((row) => ({
      id: String(row.id),
      displayName: row.display_name,
      isChecked: !!row.is_checked,
    }));
  }

  async addChecklistItem(
    userId: number,
    externalId: string,
    displayName: string,
  ): Promise<NormalizedChecklistItem> {
    const db = getDb();
    const taskId = parseInt(externalId, 10);
    const trimmed = String(displayName || '').trim();
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new Error('Invalid native task id');
    }
    if (!trimmed) {
      throw new Error('Checklist item title is required');
    }

    const task = db.prepare('SELECT id FROM native_tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as { id: number } | undefined;
    if (!task) {
      throw new Error('Task not found');
    }

    const maxPosition = db.prepare(`
      SELECT COALESCE(MAX(position), 0) AS position
      FROM native_task_checklist_items
      WHERE user_id = ? AND task_id = ?
    `).get(userId, taskId) as { position: number };

    const result = db.prepare(`
      INSERT INTO native_task_checklist_items (user_id, task_id, display_name, position)
      VALUES (?, ?, ?, ?)
    `).run(userId, taskId, trimmed, Number(maxPosition?.position || 0) + 1);

    db.prepare("UPDATE native_tasks SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(taskId, userId);

    return {
      id: String(result.lastInsertRowid),
      displayName: trimmed,
      isChecked: false,
    };
  }

  async updateChecklistItem(
    userId: number,
    externalId: string,
    itemId: string,
    isChecked: boolean,
  ): Promise<NormalizedChecklistItem> {
    const db = getDb();
    const taskId = parseInt(externalId, 10);
    const checklistId = parseInt(itemId, 10);
    if (!Number.isInteger(taskId) || !Number.isInteger(checklistId)) {
      throw new Error('Invalid native checklist id');
    }

    const result = db.prepare(`
      UPDATE native_task_checklist_items
      SET is_checked = ?, updated_at = datetime('now')
      WHERE id = ? AND task_id = ? AND user_id = ?
    `).run(isChecked ? 1 : 0, checklistId, taskId, userId);
    if (result.changes === 0) {
      throw new Error('Checklist item not found');
    }

    db.prepare("UPDATE native_tasks SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(taskId, userId);

    const row = db.prepare(`
      SELECT id, display_name, is_checked
      FROM native_task_checklist_items
      WHERE id = ? AND task_id = ? AND user_id = ?
    `).get(checklistId, taskId, userId) as any;

    return {
      id: String(row.id),
      displayName: row.display_name,
      isChecked: !!row.is_checked,
    };
  }

  // MARK: - Private

  private getChecklistItemsForTasks(userId: number, taskIds: number[]): Map<number, NormalizedChecklistItem[]> {
    const validTaskIds = taskIds.filter((id) => Number.isInteger(id) && id > 0);
    const byTask = new Map<number, NormalizedChecklistItem[]>();
    if (validTaskIds.length === 0) return byTask;

    const placeholders = validTaskIds.map(() => '?').join(', ');
    const rows = getDb().prepare(`
      SELECT id, task_id, display_name, is_checked
      FROM native_task_checklist_items
      WHERE user_id = ? AND task_id IN (${placeholders})
      ORDER BY task_id ASC, position ASC, id ASC
    `).all(userId, ...validTaskIds) as any[];

    for (const row of rows) {
      const taskId = Number(row.task_id);
      const items = byTask.get(taskId) || [];
      items.push({
        id: String(row.id),
        displayName: row.display_name,
        isChecked: !!row.is_checked,
      });
      byTask.set(taskId, items);
    }
    return byTask;
  }

  private rowToNormalizedTask(row: any): NormalizedTask {
    return mapNativeTaskRow(row);
  }

  private priorityToImportance(priority: number): string {
    if (priority >= 3) return 'high';
    if (priority >= 2) return 'normal';
    return 'low';
  }
}

/**
 * Map a raw `native_tasks` row (joined with its list) to a NormalizedTask.
 * Shared by the async adapter (`rowToNormalizedTask`) and the sync
 * `listNativeTasks` read below so the two can never drift.
 */
function mapNativeTaskRow(row: any): NormalizedTask {
  return {
    id: row.id,
    provider: 'nexus',
    externalId: String(row.id),
    projectId: row.list_id,
    projectName: row.list_name,
    title: row.title,
    description: row.body || undefined,
    status: row.status === 'completed' ? 'completed' : row.status === 'inProgress' ? 'in_progress' : 'pending',
    priority: row.importance === 'high' ? 3 : row.importance === 'normal' ? 2 : 1,
    dueDate: row.due_date_time || undefined,
    dueIsDatetime: !!row.due_date_time?.includes('T'),
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    notes: row.body || undefined,
    completedAt: row.completed_at || undefined,
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : undefined,
  };
}

/**
 * Synchronous, provider-local read of a native user's tasks. Mirrors the
 * unified store's getAllTasks() filter semantics (exact status match) so a
 * token-zero deterministic read can include native_tasks without going async
 * or touching any provider API. Native tasks are hard-deleted, so there is no
 * is_deleted column to filter.
 */
export function listNativeTasks(userId: number, filters?: TaskFilters): NormalizedTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.*, l.name AS list_name
       FROM native_tasks t
       JOIN native_task_lists l ON t.list_id = l.id
      WHERE t.user_id = ?
      ORDER BY t.position ASC, t.created_at DESC`,
  ).all(userId) as any[];
  let tasks = rows.map(mapNativeTaskRow);
  if (filters?.status) tasks = tasks.filter((task) => task.status === filters.status);
  if (filters?.provider) tasks = tasks.filter((task) => task.provider === filters.provider);
  if (filters?.projectName) tasks = tasks.filter((task) => task.projectName === filters.projectName);
  return tasks;
}
