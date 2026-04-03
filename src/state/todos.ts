// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { Todo } from '../domains/types';

export function createTodo(userId: number, data: {
  title: string;
  description?: string;
  domain?: string;
  priority?: string;
  due_date?: string;
  tags?: string;
}): Todo {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO todos (user_id, title, description, domain, priority, due_date, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId,
    data.title,
    data.description || null,
    data.domain || 'general',
    data.priority || 'medium',
    data.due_date || null,
    data.tags || null
  );
  return getTodoById(userId, result.lastInsertRowid as number)!;
}

export function getTodoById(userId: number, id: number): Todo | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM todos WHERE user_id = ? AND id = ?').get(userId, id) as Todo | undefined;
}

export function listTodos(userId: number, filters?: {
  domain?: string;
  status?: string;
  priority?: string;
}): Todo[] {
  const db = getDb();
  let query = 'SELECT * FROM todos WHERE user_id = ?';
  const params: any[] = [userId];

  if (filters?.domain) {
    query += ' AND domain = ?';
    params.push(filters.domain);
  }
  if (filters?.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  } else {
    query += ' AND status IN (?, ?)';
    params.push('pending', 'in_progress');
  }
  if (filters?.priority) {
    query += ' AND priority = ?';
    params.push(filters.priority);
  }

  query += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, due_date ASC';
  return db.prepare(query).all(...params) as Todo[];
}

export function completeTodo(userId: number, id: number): Todo | undefined {
  const db = getDb();
  db.prepare(`
    UPDATE todos SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE user_id = ? AND id = ?
  `).run(userId, id);
  return getTodoById(userId, id);
}

export function deleteTodo(userId: number, id: number): boolean {
  const db = getDb();
  db.prepare(`
    UPDATE todos SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND id = ?
  `).run(userId, id);
  return true;
}

export function countCompletedThisWeek(userId: number): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM todos
    WHERE user_id = ? AND status = 'done'
    AND completed_at >= datetime('now', 'weekday 0', '-7 days')
  `).get(userId) as { count: number };
  return row.count;
}
