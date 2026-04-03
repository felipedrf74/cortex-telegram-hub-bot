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
  db.prepare(`
    INSERT INTO conversations (user_id, domain, role, content) VALUES (?, ?, ?, ?)
  `).run(userId, domain, role, content);

  // Prune old rows beyond 2× the read limit to keep the table bounded
  const maxKeep = (HISTORY_LIMITS[domain] ?? 8) * 2;
  db.prepare(`
    DELETE FROM conversations WHERE user_id = ? AND domain = ? AND id NOT IN (
      SELECT id FROM conversations WHERE user_id = ? AND domain = ? ORDER BY created_at DESC LIMIT ?
    )
  `).run(userId, domain, userId, domain, maxKeep);
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
