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
  NormalizedTask,
  NormalizedProject,
  TaskProviderCapabilities,
  SyncResult,
} from './types';

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

    return {
      tasks: rows.map(r => this.rowToNormalizedTask(r)),
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

  // MARK: - Private

  private rowToNormalizedTask(row: any): NormalizedTask {
    return {
      id: row.id,
      provider: 'nexus',
      externalId: String(row.id),
      projectId: row.list_id,
      projectName: row.list_name,
      title: row.title,
      description: row.body || undefined,
      status: row.status === 'completed' ? 'completed' : row.status === 'inProgress' ? 'in_progress' : 'pending',
      priority: this.importanceToPriority(row.importance),
      dueDate: row.due_date_time || undefined,
      dueIsDatetime: !!row.due_date_time?.includes('T'),
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      notes: row.body || undefined,
      completedAt: row.completed_at || undefined,
      recurrence: row.recurrence ? JSON.parse(row.recurrence) : undefined,
    };
  }

  private priorityToImportance(priority: number): string {
    if (priority >= 3) return 'high';
    if (priority >= 2) return 'normal';
    return 'low';
  }

  private importanceToPriority(importance: string): number {
    if (importance === 'high') return 3;
    if (importance === 'normal') return 2;
    return 1;
  }
}
