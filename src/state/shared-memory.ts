// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import {
  DEFAULT_CHAT_VISIBILITY_SCOPE,
  resolveChatTenantScope,
  type ChatVisibilityScope,
} from '../services/chat-tenant-scope';

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

export interface SharedMemoryCorrectionInput {
  userId: number;
  tenantId?: number;
  key: string;
  correctedValue: string;
  sourceDomain: string;
  expiresAt?: string;
  visibilityScope?: ChatVisibilityScope;
}

export interface SharedMemoryScopeBuckets {
  userPrivate: SharedMemoryEntry[];
  tenantShared: SharedMemoryEntry[];
}

export interface SharedMemoryHistoryEntry {
  id: number;
  tenant_id: number;
  user_id: number;
  key: string;
  previous_value: string;
  new_value: string;
  previous_source_domain: string | null;
  new_source_domain: string;
  previous_expires_at: string | null;
  new_expires_at: string | null;
  previous_visibility_scope: string | null;
  new_visibility_scope: string;
  previous_scope_status: string | null;
  new_scope_status: string;
  corrected_by: number | null;
  corrected_at: string;
}

const SAFE_MEMORY_KEY_RE = /^[a-zA-Z0-9_.:-]{1,96}$/;
const MAX_MEMORY_VALUE_CHARS = 1200;
const UNSAFE_MEMORY_PATTERNS = [
  /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|password|passcode|bearer\s+[a-z0-9._-]+)\b/i,
  /\b(access[_-]?token|refresh[_-]?token|oauth[_-]?token|id[_-]?token|session[_-]?token)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9/+]{40}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk_live_|pk_live_)[A-Za-z0-9_]+\b/,
  /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/,
  /\bpostgres:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bmongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bmysql:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bFQoGZXIvYXdzE[A-Za-z0-9/+=]+/i,
  /\bDefaultEndpointsProtocol=.*?AccountKey=[^;\s]+/i,
  /\b(?:\d[ -]*?){13,19}\b/,
];

function normalizeVisibilityScope(scope?: ChatVisibilityScope | string | null): ChatVisibilityScope {
  switch (scope) {
    case 'tenant_shared':
    case 'tenant_admin_visible':
    case 'platform_admin_visible':
    case 'system_internal':
    case 'user_private':
      return scope;
    default:
      return DEFAULT_CHAT_VISIBILITY_SCOPE;
  }
}

function assertSafeSharedMemory(key: string, value: string): void {
  if (!SAFE_MEMORY_KEY_RE.test(key)) {
    throw new Error('CHAT_MEMORY_UNSAFE: memory key must be short, stable, and identifier-like');
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('CHAT_MEMORY_UNSAFE: memory value is required');
  }
  if (value.length > MAX_MEMORY_VALUE_CHARS) {
    throw new Error('CHAT_MEMORY_UNSAFE: memory value is too large for durable Chat memory');
  }
  if (UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error('CHAT_MEMORY_UNSAFE: refusing to store secrets, tokens, cards, or credential-like values');
  }
}

/** Upsert a cross-domain fact. Optional expires_at (ISO 8601) for auto-cleanup. */
export function setSharedMemory(
  userId: number,
  key: string,
  value: string,
  sourceDomain: string,
  expiresAt?: string,
  tenantId?: number,
  visibilityScope: ChatVisibilityScope = DEFAULT_CHAT_VISIBILITY_SCOPE,
): SharedMemoryEntry {
  const db = getDb();
  assertSafeSharedMemory(key, value);
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    visibilityScope,
    operation: 'shared_memory_set',
    layer: 'delivery',
    details: { key, sourceDomain },
  });
  if (!scope) {
    throw new Error('CHAT_SCOPE_INVALID: refusing to store shared memory without valid tenant/user scope');
  }
  const expiresAtValue = expiresAt || null;
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND key = ?')
      .get(scope.tenantId, userId, key) as SharedMemoryEntry | undefined;
    const shouldRecordHistory = Boolean(existing) && (
      existing!.value !== value
      || existing!.source_domain !== sourceDomain
      || (existing!.expires_at ?? null) !== expiresAtValue
      || normalizeVisibilityScope(existing!.visibility_scope) !== scope.visibilityScope
      || (existing!.scope_status ?? 'active') !== scope.scopeStatus
    );
    if (existing && shouldRecordHistory) {
      db.prepare(`
        INSERT INTO shared_memory_history (
          tenant_id,
          user_id,
          key,
          previous_value,
          new_value,
          previous_source_domain,
          new_source_domain,
          previous_expires_at,
          new_expires_at,
          previous_visibility_scope,
          new_visibility_scope,
          previous_scope_status,
          new_scope_status,
          corrected_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        userId,
        key,
        existing.value,
        value,
        existing.source_domain,
        sourceDomain,
        existing.expires_at ?? null,
        expiresAtValue,
        normalizeVisibilityScope(existing.visibility_scope),
        scope.visibilityScope,
        existing.scope_status ?? 'active',
        scope.scopeStatus,
        scope.createdBy,
      );
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
    `).run(scope.tenantId, userId, scope.visibilityScope, scope.scopeStatus, scope.createdBy, key, value, sourceDomain, expiresAtValue);
    return db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND key = ?')
      .get(scope.tenantId, userId, key) as SharedMemoryEntry;
  });
  return tx();
}

export function applySharedMemoryCorrection(input: SharedMemoryCorrectionInput): SharedMemoryEntry {
  const existing = getSharedMemory(input.userId, input.key, input.tenantId)[0];
  const visibilityScope = input.visibilityScope
    ?? normalizeVisibilityScope(existing?.visibility_scope)
    ?? DEFAULT_CHAT_VISIBILITY_SCOPE;
  return setSharedMemory(
    input.userId,
    input.key,
    input.correctedValue,
    input.sourceDomain,
    input.expiresAt,
    input.tenantId,
    visibilityScope,
  );
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
    const row = db.prepare(`
      SELECT * FROM shared_memory
      WHERE tenant_id = ?
        AND user_id = ?
        AND key = ?
        AND scope_status = ?
        AND visibility_scope IN ('user_private', 'tenant_shared')
    `).get(scope.tenantId, userId, key, 'active');
    return row ? [row as SharedMemoryEntry] : [];
  }
  return db.prepare(`
    SELECT * FROM shared_memory
    WHERE tenant_id = ?
      AND user_id = ?
      AND scope_status = ?
      AND visibility_scope IN ('user_private', 'tenant_shared')
    ORDER BY updated_at DESC
  `)
    .all(scope.tenantId, userId, 'active') as SharedMemoryEntry[];
}

export function getSharedMemoryByScope(userId: number, tenantId?: number): SharedMemoryScopeBuckets {
  const entries = getSharedMemory(userId, undefined, tenantId);
  return {
    userPrivate: entries.filter((entry) => normalizeVisibilityScope(entry.visibility_scope) === 'user_private'),
    tenantShared: entries.filter((entry) => normalizeVisibilityScope(entry.visibility_scope) === 'tenant_shared'),
  };
}

export function getSharedMemoryHistory(userId: number, key: string, tenantId?: number): SharedMemoryHistoryEntry[] {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'shared_memory_history_read',
    layer: 'delivery',
    details: { key },
  });
  if (!scope) return [];
  return db.prepare(`
    SELECT *
    FROM shared_memory_history
    WHERE tenant_id = ?
      AND user_id = ?
      AND key = ?
    ORDER BY id ASC
  `).all(scope.tenantId, userId, key) as SharedMemoryHistoryEntry[];
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
