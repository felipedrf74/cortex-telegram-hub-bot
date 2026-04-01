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
};

export function getConversationHistory(domain: DomainName): DomainMessage[] {
  const db = getDb();
  const limit = HISTORY_LIMITS[domain] ?? 8;
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE domain = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(domain, limit) as DomainMessage[];
  return rows.reverse();
}

export function addToConversation(domain: DomainName, role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)
  `).run(domain, role, content);

  // Prune old rows beyond 2× the read limit to keep the table bounded
  const maxKeep = (HISTORY_LIMITS[domain] ?? 8) * 2;
  db.prepare(`
    DELETE FROM conversations WHERE domain = ? AND id NOT IN (
      SELECT id FROM conversations WHERE domain = ? ORDER BY created_at DESC LIMIT ?
    )
  `).run(domain, domain, maxKeep);
}

/**
 * Get the last assistant message for a domain (if it was the most recent message).
 * Returns null if the last message was from the user (conversation already answered).
 * Used by the router to provide conversation context to the classifier.
 */
export function getLastAssistantMessage(domain: DomainName): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT role, content FROM conversations
    WHERE domain = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(domain) as DomainMessage | undefined;

  if (!row || row.role !== 'assistant') return null;
  return row.content;
}

export function clearConversation(domain: DomainName): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE domain = ?').run(domain);
}

export function clearAllConversations(): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations').run();
}
