// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { DomainMessage, DomainName } from '../domains/types';

// Per-domain limits: secretary needs deep history for multi-step tasks,
// triathlon/content produce verbose responses (training plans, scripts)
// so fewer messages avoids bloating the context window.
const HISTORY_LIMITS: Record<string, number> = {
  secretary: 10,
  triathlon: 6,
  content: 6,
  finance: 8,
  cooking: 8,
};

export function getConversationHistory(userId: number, domain: DomainName): DomainMessage[] {
  const db = getDb();
  const limit = HISTORY_LIMITS[domain] ?? 8;
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE user_id = ? AND domain = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, domain, limit) as DomainMessage[];
  return rows.reverse();
}

export function addToConversation(userId: number, domain: DomainName, role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  // Atomic INSERT + prune. Wrapping in a transaction guarantees either
  // both run or neither runs — so a prune failure can't leave the table
  // above its cap, and an INSERT failure won't accidentally prune the
  // last row of the previous history. better-sqlite3's `db.transaction`
  // returns a callable that BEGIN/COMMITs around the inner function and
  // ROLLBACKs on throw. Audit Month 2 #5.
  const writeTx = db.transaction((
    u: number,
    d: DomainName,
    r: 'user' | 'assistant',
    c: string,
  ) => {
    db.prepare(`
      INSERT INTO conversations (user_id, domain, role, content) VALUES (?, ?, ?, ?)
    `).run(u, d, r, c);

    // Prune old rows beyond 2× the read limit to keep the table bounded
    const maxKeep = (HISTORY_LIMITS[d] ?? 8) * 2;
    db.prepare(`
      DELETE FROM conversations WHERE user_id = ? AND domain = ? AND id NOT IN (
        SELECT id FROM conversations WHERE user_id = ? AND domain = ? ORDER BY created_at DESC LIMIT ?
      )
    `).run(u, d, u, d, maxKeep);
  });
  writeTx(userId, domain, role, content);
}

export function syncLastAssistantConversationMessage(userId: number, domain: DomainName, content: string): void {
  const db = getDb();
  const syncTx = db.transaction((u: number, d: DomainName, c: string) => {
    const lastRow = db.prepare(`
      SELECT id, role FROM conversations
      WHERE user_id = ? AND domain = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(u, d) as { id: number; role: 'user' | 'assistant' } | undefined;

    if (lastRow?.role === 'assistant') {
      db.prepare(`
        UPDATE conversations
        SET content = ?
        WHERE id = ?
      `).run(c, lastRow.id);
      return;
    }

    db.prepare(`
      INSERT INTO conversations (user_id, domain, role, content) VALUES (?, ?, 'assistant', ?)
    `).run(u, d, c);

    const maxKeep = (HISTORY_LIMITS[d] ?? 8) * 2;
    db.prepare(`
      DELETE FROM conversations WHERE user_id = ? AND domain = ? AND id NOT IN (
        SELECT id FROM conversations WHERE user_id = ? AND domain = ? ORDER BY created_at DESC LIMIT ?
      )
    `).run(u, d, u, d, maxKeep);
  });

  syncTx(userId, domain, content);
}

/**
 * Get the last assistant message for a domain (if it was the most recent message).
 * Returns null if the last message was from the user (conversation already answered).
 * Used by the router to provide conversation context to the classifier.
 */
export function getLastAssistantMessage(userId: number, domain: DomainName): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT role, content FROM conversations
    WHERE user_id = ? AND domain = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, domain) as DomainMessage | undefined;

  if (!row || row.role !== 'assistant') return null;
  return row.content;
}

export function clearConversation(userId: number, domain: DomainName): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE user_id = ? AND domain = ?').run(userId, domain);
}

export function clearAllConversations(userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}
