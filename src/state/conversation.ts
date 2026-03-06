import { getDb } from '../services/database';
import { DomainMessage, DomainName } from '../domains/types';

const MAX_HISTORY_MESSAGES = 10;

export function getConversationHistory(domain: DomainName): DomainMessage[] {
  const db = getDb();
  // Only keep last N messages to control token usage
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE domain = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(domain, MAX_HISTORY_MESSAGES) as DomainMessage[];
  return rows.reverse();
}

export function addToConversation(domain: DomainName, role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)
  `).run(domain, role, content);
}

export function clearConversation(domain: DomainName): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE domain = ?').run(domain);
}

export function clearAllConversations(): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations').run();
}
