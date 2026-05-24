// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { getDb } from '../database';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  MemoryItem,
  MemoryItemType,
  MemoryStatus,
} from './types';

export interface ChatV2MemoryScope {
  userId: string;
  tenantId: string;
}

export interface ListChatV2MemoryItemsOptions {
  domain?: ChatCoreV2Domain;
  type?: MemoryItemType;
  status?: MemoryStatus;
  includeExpired?: boolean;
  now?: string;
  limit?: number;
}

export interface ChatV2MemoryRecord extends MemoryItem {
  id: number;
}

const CHAT_CORE_V2_DOMAINS: ReadonlySet<ChatCoreV2Domain> = new Set([
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
]);

const MEMORY_TYPES: ReadonlySet<MemoryItemType> = new Set([
  'conversation_summary',
  'user_preference',
  'domain_preference',
  'decision_rationale',
  'recurring_pattern',
  'user_correction',
  'ignored_suggestion',
  'safety_constraint',
]);

const MEMORY_STATUSES: ReadonlySet<MemoryStatus> = new Set([
  'active',
  'superseded',
  'deleted',
  'needs_confirmation',
]);

const AUDIT_SENSITIVITIES: ReadonlySet<AuditSensitivity> = new Set([
  'normal',
  'personal',
  'financial',
  'health_adjacent',
  'credential_adjacent',
]);

export function ensureChatCoreV2MemoryTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN (
        'conversation_summary',
        'user_preference',
        'domain_preference',
        'decision_rationale',
        'recurring_pattern',
        'user_correction',
        'ignored_suggestion',
        'safety_constraint'
      )),
      domain TEXT CHECK (domain IN (
        'secretary',
        'tasks',
        'training',
        'content',
        'cooking',
        'finance',
        'connections',
        'notifications',
        'decision_center'
      )),
      value TEXT NOT NULL,
      source_turn_id TEXT,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'needs_confirmation')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(tenant_id, user_id, memory_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_scope
      ON chat_v2_memory_items(tenant_id, user_id, status, type, domain, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_source_turn
      ON chat_v2_memory_items(source_turn_id);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_expiry
      ON chat_v2_memory_items(status, expires_at);
  `);
}

export function upsertChatV2MemoryItem(
  item: MemoryItem,
  db: Database.Database = getDb(),
): ChatV2MemoryRecord {
  ensureChatCoreV2MemoryTables(db);
  validateMemoryItem(item);

  db.prepare(`
    INSERT INTO chat_v2_memory_items (
      memory_id, user_id, tenant_id, type, domain, value, source_turn_id,
      confidence, sensitivity, status, created_at, updated_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, memory_id) DO UPDATE SET
      user_id = excluded.user_id,
      tenant_id = excluded.tenant_id,
      type = excluded.type,
      domain = excluded.domain,
      value = excluded.value,
      source_turn_id = excluded.source_turn_id,
      confidence = excluded.confidence,
      sensitivity = excluded.sensitivity,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).run(
    item.memoryId,
    item.userId,
    item.tenantId,
    item.type,
    item.domain ?? null,
    item.value,
    item.sourceTurnId ?? null,
    item.confidence,
    item.sensitivity,
    item.status,
    item.createdAt,
    item.updatedAt,
    item.expiresAt ?? null,
  );

  return getChatV2MemoryItem(item.memoryId, { userId: item.userId, tenantId: item.tenantId }, db)!;
}

export function getChatV2MemoryItem(
  memoryId: string,
  scope: ChatV2MemoryScope,
  db: Database.Database = getDb(),
): ChatV2MemoryRecord | null {
  ensureChatCoreV2MemoryTables(db);
  validateScope(scope);
  requireNonEmpty(memoryId, 'memoryId');

  const row = db.prepare(`
    SELECT * FROM chat_v2_memory_items
    WHERE memory_id = ? AND user_id = ? AND tenant_id = ?
  `).get(memoryId, scope.userId, scope.tenantId);
  return row ? mapMemoryRow(row) : null;
}

export function listChatV2MemoryItems(
  scope: ChatV2MemoryScope,
  db: Database.Database = getDb(),
  options: ListChatV2MemoryItemsOptions = {},
): ChatV2MemoryRecord[] {
  ensureChatCoreV2MemoryTables(db);
  validateScope(scope);
  validateListOptions(options);

  const conditions = ['user_id = ?', 'tenant_id = ?', 'status = ?'];
  const values: unknown[] = [scope.userId, scope.tenantId, options.status ?? 'active'];

  if (options.domain) {
    conditions.push('domain = ?');
    values.push(options.domain);
  }
  if (options.type) {
    conditions.push('type = ?');
    values.push(options.type);
  }
  if (!options.includeExpired) {
    conditions.push('(expires_at IS NULL OR expires_at > ?)');
    values.push(options.now ?? new Date().toISOString());
  }

  values.push(boundedLimit(options.limit));
  const rows = db.prepare(`
    SELECT * FROM chat_v2_memory_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(...values);
  return rows.map(mapMemoryRow);
}

export function setChatV2MemoryStatus(
  memoryId: string,
  scope: ChatV2MemoryScope,
  status: MemoryStatus,
  db: Database.Database = getDb(),
  updatedAt: string = new Date().toISOString(),
): ChatV2MemoryRecord | null {
  ensureChatCoreV2MemoryTables(db);
  validateScope(scope);
  requireNonEmpty(memoryId, 'memoryId');
  if (!MEMORY_STATUSES.has(status)) throw new Error(`Invalid Chat Core v2 memory status: ${status}`);
  requireNonEmpty(updatedAt, 'updatedAt');

  db.prepare(`
    UPDATE chat_v2_memory_items
    SET status = ?, updated_at = ?
    WHERE memory_id = ? AND user_id = ? AND tenant_id = ?
  `).run(status, updatedAt, memoryId, scope.userId, scope.tenantId);
  return getChatV2MemoryItem(memoryId, scope, db);
}

function validateMemoryItem(item: MemoryItem): void {
  validateScope(item);
  requireNonEmpty(item.memoryId, 'memoryId');
  requireNonEmpty(item.value, 'value');
  requireNonEmpty(item.createdAt, 'createdAt');
  requireNonEmpty(item.updatedAt, 'updatedAt');
  if (!MEMORY_TYPES.has(item.type)) throw new Error(`Invalid Chat Core v2 memory type: ${item.type}`);
  if (item.domain && !CHAT_CORE_V2_DOMAINS.has(item.domain)) throw new Error(`Invalid Chat Core v2 memory domain: ${item.domain}`);
  if (!AUDIT_SENSITIVITIES.has(item.sensitivity)) throw new Error(`Invalid Chat Core v2 memory sensitivity: ${item.sensitivity}`);
  if (!MEMORY_STATUSES.has(item.status)) throw new Error(`Invalid Chat Core v2 memory status: ${item.status}`);
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
}

function validateScope(scope: ChatV2MemoryScope): void {
  requireNonEmpty(scope.userId, 'userId');
  requireNonEmpty(scope.tenantId, 'tenantId');
}

function validateListOptions(options: ListChatV2MemoryItemsOptions): void {
  if (options.domain && !CHAT_CORE_V2_DOMAINS.has(options.domain)) throw new Error(`Invalid Chat Core v2 memory domain: ${options.domain}`);
  if (options.type && !MEMORY_TYPES.has(options.type)) throw new Error(`Invalid Chat Core v2 memory type: ${options.type}`);
  if (options.status && !MEMORY_STATUSES.has(options.status)) throw new Error(`Invalid Chat Core v2 memory status: ${options.status}`);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 25), 1), 250);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function mapMemoryRow(raw: unknown): ChatV2MemoryRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    memoryId: String(row.memory_id),
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    type: row.type as MemoryItemType,
    domain: stringOrUndefined(row.domain) as ChatCoreV2Domain | undefined,
    value: String(row.value),
    sourceTurnId: stringOrUndefined(row.source_turn_id),
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity as AuditSensitivity,
    status: row.status as MemoryStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: stringOrUndefined(row.expires_at),
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
