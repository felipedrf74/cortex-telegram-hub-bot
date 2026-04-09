// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { Note } from '../domains/types';

export function saveNote(userId: number, data: {
  content: string;
  domain?: string;
  tags?: string;
}): Note {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO notes (user_id, content, domain, tags) VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(userId, data.content, data.domain || 'general', data.tags || null);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid) as Note;
}

export function searchNotes(userId: number, filters?: {
  query?: string;
  domain?: string;
  tag?: string;
  limit?: number;
}): Note[] {
  const db = getDb();
  let query = 'SELECT * FROM notes WHERE user_id = ?';
  const params: any[] = [userId];

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

  // Allow the caller to override the default limit — the iOS Notes
  // list view requests up to 100 so the "show all" state doesn't feel
  // truncated. The 20-item default is kept for existing callers that
  // don't pass a limit (e.g. the chat-domain context enricher).
  const limit = filters?.limit ?? 20;
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(query).all(...params) as Note[];
}

/**
 * Fetch a single note by id, scoped to the caller's user_id so one
 * user can't read another user's notes. Returns null if not found.
 */
export function getNoteById(userId: number, noteId: number): Note | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM notes WHERE id = ? AND user_id = ?'
  ).get(noteId, userId) as Note | undefined;
  return row ?? null;
}

/**
 * Patch an existing note. Only the fields present in `updates` are
 * written — omitted fields are left alone. Scoped to the caller's
 * user_id so one user can't edit another user's notes.
 *
 * Returns the updated row, or null if no row matched (wrong id or
 * cross-user write attempt).
 */
export function updateNote(
  userId: number,
  noteId: number,
  updates: { content?: string; domain?: string; tags?: string | null },
): Note | null {
  const db = getDb();

  // Build the SET clause dynamically so we only touch fields the
  // caller actually wants to change. Empty updates object is a no-op
  // that still returns the current row.
  const setParts: string[] = [];
  const params: any[] = [];

  if (updates.content !== undefined) {
    setParts.push('content = ?');
    params.push(updates.content);
  }
  if (updates.domain !== undefined) {
    setParts.push('domain = ?');
    params.push(updates.domain);
  }
  if (updates.tags !== undefined) {
    // `tags` is nullable — pass through whatever the caller gave us,
    // including explicit null (which clears tags).
    setParts.push('tags = ?');
    params.push(updates.tags);
  }

  if (setParts.length > 0) {
    const sql = `UPDATE notes SET ${setParts.join(', ')} WHERE id = ? AND user_id = ?`;
    params.push(noteId, userId);
    const result = db.prepare(sql).run(...params);
    if (result.changes === 0) return null;
  }

  return getNoteById(userId, noteId);
}

/**
 * Hard-delete a note. Scoped to user_id. Returns true if a row was
 * removed, false if no matching row existed.
 */
export function deleteNote(userId: number, noteId: number): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM notes WHERE id = ? AND user_id = ?'
  ).run(noteId, userId);
  return result.changes > 0;
}
