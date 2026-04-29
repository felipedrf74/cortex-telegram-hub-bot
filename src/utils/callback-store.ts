// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from '../services/database';
import { logger } from './logger';
import {
  DEFAULT_CHAT_VISIBILITY_SCOPE,
  resolveChatTenantScope,
  type ChatVisibilityScope,
} from '../services/chat-tenant-scope';

// ─── Inline Keyboard Callback Store ─────────────────────────────────

interface CallbackEntry {
  data: any;
  expires: number;
  tenantId?: number;
  userId?: number;
  createdBy?: number | null;
  visibilityScope?: ChatVisibilityScope | 'system_internal';
  scopeStatus?: 'active' | 'quarantined';
  sourceMessageId?: string | null;
  actionType?: string | null;
  consumedAtMs?: number | null;
}

const callbackStore = new Map<string, CallbackEntry>();

interface CallbackRow {
  data_json: string;
  expires_at_ms: number;
  tenant_id?: number;
  user_id?: number;
  created_by?: number | null;
  visibility_scope?: string;
  scope_status?: string;
  source_message_id?: string | null;
  action_type?: string | null;
  consumed_at_ms?: number | null;
}

export interface CallbackScope {
  tenantId?: number;
  userId: number;
  sourceMessageId?: string | null;
  actionType?: string | null;
  visibilityScope?: ChatVisibilityScope;
}

function getDbSafe() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function deletePersistedCallback(ref: string): void {
  const db = getDbSafe();
  if (!db) return;
  db.prepare('DELETE FROM callback_entries WHERE ref = ?').run(ref);
}

function hasColumn(table: string, column: string): boolean {
  const db = getDbSafe();
  if (!db) return false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

function hasCallbackScopeColumns(): boolean {
  return hasColumn('callback_entries', 'tenant_id')
    && hasColumn('callback_entries', 'user_id')
    && hasColumn('callback_entries', 'scope_status')
    && hasColumn('callback_entries', 'consumed_at_ms');
}

function prunePersistedCallbacks(nowMs = Date.now()): void {
  const db = getDbSafe();
  if (!db) return;
  db.prepare('DELETE FROM callback_entries WHERE expires_at_ms <= ?').run(nowMs);
}

function persistCallback(ref: string, entry: CallbackEntry): void {
  const db = getDbSafe();
  if (!db) return;

  try {
    if (hasCallbackScopeColumns()) {
      db.prepare(`
        INSERT INTO callback_entries (
          ref,
          data_json,
          created_at_ms,
          expires_at_ms,
          tenant_id,
          user_id,
          created_by,
          visibility_scope,
          scope_status,
          source_message_id,
          action_type,
          consumed_at_ms,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(ref) DO UPDATE SET
          data_json = excluded.data_json,
          created_at_ms = excluded.created_at_ms,
          expires_at_ms = excluded.expires_at_ms,
          tenant_id = excluded.tenant_id,
          user_id = excluded.user_id,
          created_by = excluded.created_by,
          visibility_scope = excluded.visibility_scope,
          scope_status = excluded.scope_status,
          source_message_id = excluded.source_message_id,
          action_type = excluded.action_type,
          consumed_at_ms = excluded.consumed_at_ms,
          updated_at = datetime('now')
      `).run(
        ref,
        JSON.stringify(entry.data),
        Date.now(),
        entry.expires,
        entry.tenantId ?? 0,
        entry.userId ?? 0,
        entry.createdBy ?? null,
        entry.visibilityScope ?? 'system_internal',
        entry.scopeStatus ?? 'quarantined',
        entry.sourceMessageId ?? null,
        entry.actionType ?? null,
        entry.consumedAtMs ?? null,
      );
      return;
    }

    db.prepare(`
      INSERT INTO callback_entries (ref, data_json, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET
        data_json = excluded.data_json,
        created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        updated_at = datetime('now')
    `).run(ref, JSON.stringify(entry.data), Date.now(), entry.expires);
  } catch (err) {
    logger.warn({ err, ref }, 'Failed to persist callback entry');
  }
}

function loadPersistedCallback(ref: string): CallbackEntry | null {
  const db = getDbSafe();
  if (!db) return null;

  const scopedColumns = hasCallbackScopeColumns();
  const row = db.prepare(scopedColumns
    ? `
      SELECT data_json, expires_at_ms,
             tenant_id, user_id, created_by, visibility_scope, scope_status,
             source_message_id, action_type, consumed_at_ms
      FROM callback_entries
      WHERE ref = ?
    `
    : `
      SELECT data_json, expires_at_ms
      FROM callback_entries
      WHERE ref = ?
    `).get(ref) as CallbackRow | undefined;

  if (!row) return null;
  if (row.expires_at_ms <= Date.now()) {
    deletePersistedCallback(ref);
    return null;
  }

  try {
    return {
      data: JSON.parse(row.data_json),
      expires: row.expires_at_ms,
      tenantId: row.tenant_id,
      userId: row.user_id,
      createdBy: row.created_by ?? null,
      visibilityScope: row.visibility_scope as CallbackEntry['visibilityScope'],
      scopeStatus: row.scope_status as CallbackEntry['scopeStatus'],
      sourceMessageId: row.source_message_id ?? null,
      actionType: row.action_type ?? null,
      consumedAtMs: row.consumed_at_ms ?? null,
    };
  } catch (err) {
    logger.warn({ err, ref }, 'Persisted callback payload is invalid — dropping row');
    deletePersistedCallback(ref);
    return null;
  }
}

function isActiveScopedEntry(
  entry: CallbackEntry,
  scope: { tenantId: number; userId: number },
): boolean {
  return entry.scopeStatus === 'active'
    && entry.consumedAtMs == null
    && entry.tenantId === scope.tenantId
    && entry.userId === scope.userId;
}

function isLegacyEntry(entry: CallbackEntry): boolean {
  return !entry.tenantId && !entry.userId && entry.scopeStatus !== 'active';
}

function touchScopedCallback(ref: string): void {
  const db = getDbSafe();
  if (!db || !hasCallbackScopeColumns()) return;
  try {
    db.prepare(`
      UPDATE callback_entries
      SET last_used_at_ms = ?, use_count = COALESCE(use_count, 0) + 1, updated_at = datetime('now')
      WHERE ref = ?
    `).run(Date.now(), ref);
  } catch (err) {
    logger.debug?.({ err, ref }, 'Failed to touch scoped callback');
  }
}

// Time-based cleanup every 10 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of callbackStore) {
    if (entry.expires < now) {
      callbackStore.delete(key);
      deletePersistedCallback(key);
    }
  }
  prunePersistedCallbacks(now);
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

/**
 * Store callback data with a short-lived TTL.
 * @param data   Arbitrary payload retrieved later via getCallback()
 * @param ttlMs  Time-to-live in ms (default 5 min; content workflow uses 24 h)
 */
export function storeCallback(data: any, ttlMs = 300_000): string {
  const expires = Date.now() + ttlMs;
  const ref = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const entry: CallbackEntry = { data, expires, scopeStatus: 'quarantined', visibilityScope: 'system_internal' };
  callbackStore.set(ref, entry);
  persistCallback(ref, entry);
  return ref;
}

export function getCallback(ref: string): any | null {
  const entry = callbackStore.get(ref);
  if (entry) {
    if (entry.expires < Date.now()) {
      callbackStore.delete(ref);
      deletePersistedCallback(ref);
      return null;
    }
    return isLegacyEntry(entry) ? entry.data : null;
  }

  const persisted = loadPersistedCallback(ref);
  if (!persisted) return null;
  callbackStore.set(ref, persisted);
  return isLegacyEntry(persisted) ? persisted.data : null;
}

export function storeCallbackForScope(data: any, scope: CallbackScope, ttlMs = 300_000): string {
  const resolved = resolveChatTenantScope({
    userId: scope.userId,
    tenantId: scope.tenantId,
    visibilityScope: scope.visibilityScope ?? DEFAULT_CHAT_VISIBILITY_SCOPE,
    operation: 'chat_callback_store',
    layer: 'delivery',
    details: {
      actionType: scope.actionType ?? null,
      hasSourceMessageId: Boolean(scope.sourceMessageId),
    },
  });
  if (!resolved) {
    throw new Error('CHAT_CALLBACK_SCOPE_INVALID: refusing to store callback without tenant/user scope');
  }

  const expires = Date.now() + ttlMs;
  const ref = crypto.randomBytes(16).toString('hex');
  const entry: CallbackEntry = {
    data,
    expires,
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    createdBy: resolved.createdBy,
    visibilityScope: resolved.visibilityScope,
    scopeStatus: resolved.scopeStatus,
    sourceMessageId: scope.sourceMessageId ?? null,
    actionType: scope.actionType ?? null,
    consumedAtMs: null,
  };
  callbackStore.set(ref, entry);
  persistCallback(ref, entry);
  return ref;
}

export function getCallbackForScope(ref: string, scope: { tenantId?: number; userId: number }): any | null {
  const resolved = resolveChatTenantScope({
    userId: scope.userId,
    tenantId: scope.tenantId,
    operation: 'chat_callback_read',
    layer: 'delivery',
  });
  if (!resolved) return null;

  const cached = callbackStore.get(ref);
  if (cached) {
    if (cached.expires < Date.now()) {
      callbackStore.delete(ref);
      deletePersistedCallback(ref);
      return null;
    }
    if (!isActiveScopedEntry(cached, resolved)) return null;
    touchScopedCallback(ref);
    return cached.data;
  }

  const persisted = loadPersistedCallback(ref);
  if (!persisted) return null;
  callbackStore.set(ref, persisted);
  if (!isActiveScopedEntry(persisted, resolved)) return null;
  touchScopedCallback(ref);
  return persisted.data;
}

export function consumeCallbackForScope(ref: string, scope: { tenantId?: number; userId: number }): boolean {
  const data = getCallbackForScope(ref, scope);
  if (!data) return false;

  const now = Date.now();
  const cached = callbackStore.get(ref);
  if (cached) {
    cached.consumedAtMs = now;
    callbackStore.set(ref, cached);
  }

  const db = getDbSafe();
  if (db && hasCallbackScopeColumns()) {
    try {
      db.prepare(`
        UPDATE callback_entries
        SET consumed_at_ms = ?, last_used_at_ms = ?, use_count = COALESCE(use_count, 0) + 1, updated_at = datetime('now')
        WHERE ref = ? AND tenant_id = ? AND user_id = ? AND scope_status = 'active' AND consumed_at_ms IS NULL
      `).run(now, now, ref, scope.tenantId ?? scope.userId, scope.userId);
    } catch (err) {
      logger.warn({ err, ref, userId: scope.userId, tenantId: scope.tenantId }, 'Failed to consume scoped callback');
    }
  }
  return true;
}

export function __resetCallbackCacheForTests(): void {
  callbackStore.clear();
}
