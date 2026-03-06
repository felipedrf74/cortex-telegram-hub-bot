import { getDb } from '../services/database';
import { Note } from '../domains/types';

export function saveNote(data: {
  content: string;
  domain?: string;
  tags?: string;
}): Note {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO notes (content, domain, tags) VALUES (?, ?, ?)
  `);
  const result = stmt.run(data.content, data.domain || 'general', data.tags || null);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid) as Note;
}

export function searchNotes(filters?: {
  query?: string;
  domain?: string;
  tag?: string;
}): Note[] {
  const db = getDb();
  let query = 'SELECT * FROM notes WHERE 1=1';
  const params: any[] = [];

  if (filters?.query) {
    query += ' AND content LIKE ?';
    params.push(`%${filters.query}%`);
  }
  if (filters?.domain) {
    query += ' AND domain = ?';
    params.push(filters.domain);
  }
  if (filters?.tag) {
    query += ' AND tags LIKE ?';
    params.push(`%${filters.tag}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT 20';
  return db.prepare(query).all(...params) as Note[];
}
