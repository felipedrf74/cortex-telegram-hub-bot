import { getDb } from '../services/database';

export interface SavedIdea {
  id: number;
  title: string;
  source_date: string;
  status: string;
  created_at: string;
}

export function saveIdea(title: string, sourceDate: string): SavedIdea {
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO saved_ideas (title, source_date) VALUES (?, ?)'
  ).run(title, sourceDate);
  return db.prepare('SELECT * FROM saved_ideas WHERE id = ?').get(result.lastInsertRowid) as SavedIdea;
}

export function getSavedIdeas(status = 'saved'): SavedIdea[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM saved_ideas WHERE status = ? ORDER BY created_at DESC'
  ).all(status) as SavedIdea[];
}

export function markIdeaUsed(id: number): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE saved_ideas SET status = 'used' WHERE id = ?"
  ).run(id);
  return result.changes > 0;
}

export function deleteIdea(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM saved_ideas WHERE id = ?').run(id);
  return result.changes > 0;
}
