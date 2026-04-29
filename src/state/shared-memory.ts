// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { resolveChatTenantScope } from '../services/chat-tenant-scope';

export interface SharedMemoryEntry {
  id: number;
  tenant_id: number;
  key: string;
  value: string;
  source_domain: string;
  expires_at: string | null;
  visibility_scope?: string;
  scope_status?: string;
  created_by?: number | null;
  created_at: string;
  updated_at: string;
  user_id: number;
}

/** Upsert a cross-domain fact. Optional expires_at (ISO 8601) for auto-cleanup. */
export function setSharedMemory(
  userId: number,
  key: string,
  value: string,
  sourceDomain: string,
  expiresAt?: string,
  tenantId?: number,
): SharedMemoryEntry {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'shared_memory_set',
    layer: 'delivery',
    details: { key, sourceDomain },
  });
  if (!scope) {
    throw new Error('CHAT_SCOPE_INVALID: refusing to store shared memory without valid tenant/user scope');
  }
  db.prepare(`
    INSERT INTO shared_memory (tenant_id, user_id, visibility_scope, scope_status, created_by, key, value, source_domain, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, key) DO UPDATE SET
      value = excluded.value,
      source_domain = excluded.source_domain,
      expires_at = excluded.expires_at,
      visibility_scope = excluded.visibility_scope,
      scope_status = excluded.scope_status,
      created_by = excluded.created_by,
      updated_at = datetime('now')
  `).run(scope.tenantId, userId, scope.visibilityScope, scope.scopeStatus, scope.createdBy, key, value, sourceDomain, expiresAt || null);
  return db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND key = ?')
    .get(scope.tenantId, userId, key) as SharedMemoryEntry;
}

// Rate-limit expired entry cleanup — at most once per 5 minutes
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Get all active (non-expired) shared memory entries for a user, or a single key. */
export function getSharedMemory(userId: number, key?: string, tenantId?: number): SharedMemoryEntry[] {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'shared_memory_read',
    layer: 'delivery',
    details: key ? { key } : undefined,
  });
  if (!scope) return [];
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    db.prepare(`DELETE FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
    lastCleanup = now;
  }

  if (key) {
    const row = db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND key = ? AND scope_status = ?')
      .get(scope.tenantId, userId, key, 'active');
    return row ? [row as SharedMemoryEntry] : [];
  }
  return db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND scope_status = ? ORDER BY updated_at DESC')
    .all(scope.tenantId, userId, 'active') as SharedMemoryEntry[];
}

/** Remove a shared memory entry by key. Returns true if deleted. */
export function removeSharedMemory(userId: number, key: string, tenantId?: number): boolean {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'shared_memory_remove',
    layer: 'delivery',
    details: { key },
  });
  if (!scope) return false;
  const result = db.prepare('DELETE FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND key = ? AND scope_status = ?')
    .run(scope.tenantId, userId, key, 'active');
  return result.changes > 0;
}

/** Build a compact summary of shared memory for injection into domain state context. */
export function getSharedMemorySummary(userId: number, tenantId?: number): string {
  const entries = getSharedMemory(userId, undefined, tenantId);
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.key}: ${e.value} (from ${e.source_domain})`);
  return `\nShared context:\n${lines.join('\n')}`;
}
