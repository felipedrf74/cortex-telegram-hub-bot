import { getDb } from '../services/database';
import { Todo } from '../domains/types';

export function createTodo(data: {
  title: string;
  description?: string;
  domain?: string;
  priority?: string;
  due_date?: string;
  tags?: string;
}): Todo {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO todos (title, description, domain, priority, due_date, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.title,
    data.description || null,
    data.domain || 'general',
    data.priority || 'medium',
    data.due_date || null,
    data.tags || null
  );
  return getTodoById(result.lastInsertRowid as number)!;
}

export function getTodoById(id: number): Todo | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Todo | undefined;
}

export function listTodos(filters?: {
  domain?: string;
  status?: string;
  priority?: string;
}): Todo[] {
  const db = getDb();
  let query = 'SELECT * FROM todos WHERE 1=1';
  const params: any[] = [];

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

export function completeTodo(id: number): Todo | undefined {
  const db = getDb();
  db.prepare(`
    UPDATE todos SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return getTodoById(id);
}

export function deleteTodo(id: number): boolean {
  const db = getDb();
  db.prepare(`
    UPDATE todos SET status = 'cancelled', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return true;
}

export function countCompletedThisWeek(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM todos
    WHERE status = 'done'
    AND completed_at >= datetime('now', 'weekday 0', '-7 days')
  `).get() as { count: number };
  return row.count;
}
