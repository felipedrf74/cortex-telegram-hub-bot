// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { DomainMessage, DomainName } from '../domains/types';
import { resolveChatTenantScope } from '../services/chat-tenant-scope';

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

type ConversationLifecycleState = 'active' | 'archived' | 'deleted' | 'errored' | 'tenant_migrated' | 'quarantined';

function hasColumn(table: string, column: string): boolean {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function conversationLifecycleFilter(): string {
  return hasColumn('conversations', 'conversation_state') ? "AND conversation_state = 'active'" : '';
}

export function getConversationHistory(userId: number, domain: DomainName, tenantId?: number): DomainMessage[] {
  const db = getDb();
  const limit = HISTORY_LIMITS[domain] ?? 8;
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_read',
    layer: 'delivery',
    details: { domain },
  });
  if (!scope) return [];
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active'
      ${conversationLifecycleFilter()}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(scope.tenantId, userId, domain, limit) as DomainMessage[];
  return rows.reverse();
}

export function addToConversation(
  userId: number,
  domain: DomainName,
  role: 'user' | 'assistant',
  content: string,
  tenantId?: number,
): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_add',
    layer: 'delivery',
    details: { domain, role },
  });
  if (!scope) return;
  // Atomic INSERT + prune. Wrapping in a transaction guarantees either
  // both run or neither runs — so a prune failure can't leave the table
  // above its cap, and an INSERT failure won't accidentally prune the
  // last row of the previous history. better-sqlite3's `db.transaction`
  // returns a callable that BEGIN/COMMITs around the inner function and
  // ROLLBACKs on throw. Audit Month 2 #5.
  const writeTx = db.transaction((
    tenant: number,
    u: number,
    d: DomainName,
    r: 'user' | 'assistant',
    c: string,
  ) => {
    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(tenant, u, u, d, r, c);

    // Prune old rows beyond 2× the read limit to keep the table bounded
    const maxKeep = (HISTORY_LIMITS[d] ?? 8) * 2;
    db.prepare(`
      DELETE FROM conversations WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active' AND id NOT IN (
        SELECT id FROM conversations WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active' ${conversationLifecycleFilter()} ORDER BY created_at DESC LIMIT ?
      )
    `).run(tenant, u, d, tenant, u, d, maxKeep);
  });
  writeTx(scope.tenantId, userId, domain, role, content);
}

export function syncLastAssistantConversationMessage(
  userId: number,
  domain: DomainName,
  content: string,
  tenantId?: number,
): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_sync_assistant',
    layer: 'delivery',
    details: { domain },
  });
  if (!scope) return;
  const syncTx = db.transaction((tenant: number, u: number, d: DomainName, c: string) => {
    const lastRow = db.prepare(`
      SELECT id, role FROM conversations
      WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active'
        ${conversationLifecycleFilter()}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(tenant, u, d) as { id: number; role: 'user' | 'assistant' } | undefined;

    if (lastRow?.role === 'assistant') {
      db.prepare(`
        UPDATE conversations
        SET content = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).run(c, lastRow.id, tenant, u);
      return;
    }

    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, 'assistant', ?)
    `).run(tenant, u, u, d, c);

    const maxKeep = (HISTORY_LIMITS[d] ?? 8) * 2;
    db.prepare(`
      DELETE FROM conversations WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active' AND id NOT IN (
        SELECT id FROM conversations WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active' ${conversationLifecycleFilter()} ORDER BY created_at DESC LIMIT ?
      )
    `).run(tenant, u, d, tenant, u, d, maxKeep);
  });

  syncTx(scope.tenantId, userId, domain, content);
}

/**
 * Get the last assistant message for a domain (if it was the most recent message).
 * Returns null if the last message was from the user (conversation already answered).
 * Used by the router to provide conversation context to the classifier.
 */
export function getLastAssistantMessage(userId: number, domain: DomainName, tenantId?: number): string | null {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_last_assistant',
    layer: 'delivery',
    details: { domain },
  });
  if (!scope) return null;
  const row = db.prepare(`
    SELECT role, content FROM conversations
    WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active'
      ${conversationLifecycleFilter()}
    ORDER BY created_at DESC
    LIMIT 1
  `).get(scope.tenantId, userId, domain) as DomainMessage | undefined;

  if (!row || row.role !== 'assistant') return null;
  return row.content;
}

export function clearConversation(userId: number, domain: DomainName, tenantId?: number): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_clear_domain',
    layer: 'delivery',
    details: { domain },
  });
  if (!scope) return;
  db.prepare('DELETE FROM conversations WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = ?')
    .run(scope.tenantId, userId, domain, 'active');
}

export function clearAllConversations(userId: number, tenantId?: number): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_clear_all',
    layer: 'delivery',
  });
  if (!scope) return;
  db.prepare('DELETE FROM conversations WHERE tenant_id = ? AND user_id = ? AND scope_status = ?')
    .run(scope.tenantId, userId, 'active');
}

export function markConversationLifecycle(
  userId: number,
  domain: DomainName,
  state: ConversationLifecycleState,
  tenantId?: number,
  timestamp = new Date().toISOString(),
): boolean {
  const db = getDb();
  if (!hasColumn('conversations', 'conversation_state')) return false;
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'conversation_history_mark_lifecycle',
    layer: 'delivery',
    details: { domain, state },
  });
  if (!scope) return false;
  const result = db.prepare(`
    UPDATE conversations
    SET conversation_state = ?,
        archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
        deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END,
        errored_at = CASE WHEN ? = 'errored' THEN ? ELSE errored_at END
    WHERE tenant_id = ? AND user_id = ? AND domain = ? AND scope_status = 'active'
  `).run(
    state,
    state,
    timestamp,
    state,
    timestamp,
    state,
    timestamp,
    scope.tenantId,
    userId,
    domain,
  );
  return result.changes > 0;
}
