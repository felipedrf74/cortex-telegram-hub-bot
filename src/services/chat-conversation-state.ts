// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// M13: durable conversation continuity.
//
// The per-user "active chat domain" pin used to live only in an in-process
// Map inside src/api/routes/chat-message-context.ts, so every restart wiped
// short-term continuity ("make it shorter" follow-ups, low-confidence
// classifier pinning, degraded-mode domain fallback). This module makes the
// DB (chat_conversation_state, migration 257) the source of truth with the
// Map demoted to a private read cache:
//
//   * rememberActiveChatDomain writes through: Map first, then a single-row
//     upsert per (tenant_id, user_id). A DB failure never breaks the turn —
//     we fail open to the Map and warn.
//   * getActiveChatDomain reads the Map; on a cache miss (e.g. after a
//     restart) it falls back to the DB row, honoring the exact same
//     5-minute TTL semantics the Map always had.
//   * anchor entities (ids the turn referenced) are stored alongside the pin
//     with a 30-minute read-time decay. There is NO cron: staleness is
//     enforced at read time only.
//
// Deliberately light on imports (database + logger + domain types) so the
// router/classifier can consume it without pulling the domain-handler graph.

import { getDb } from './database';
import type { DomainName } from '../domains/types';
import { logger } from '../utils/logger';

// Keep the constant exactly as it has always been (5-minute domain pin).
// chat-message-context re-exports it for existing consumers.
export const CHAT_ACTIVE_DOMAIN_TTL_MS = 5 * 60 * 1000;

// Anchor entities decay at read time after 30 minutes.
export const CHAT_ANCHOR_ENTITY_TTL_MS = 30 * 60 * 1000;

// Bound the stored anchor list so the single row can never grow unbounded.
const MAX_ANCHOR_ENTITIES = 24;

export interface ChatAnchorEntity {
  entityId: string;
  referencedAt: number;
}

export interface ChatContinuityWriteExtras {
  conversationId?: string | null;
  lastAssistantMessageId?: string | null;
  anchorEntityIds?: readonly string[];
}

export interface DurableChatContinuity {
  tenantId: number;
  userId: number;
  conversationId: string | null;
  /** TTL-honored: null when the pin is older than CHAT_ACTIVE_DOMAIN_TTL_MS. */
  domain: DomainName | null;
  domainAt: number | null;
  lastAssistantMessageId: string | null;
  /** Read-time decayed: only anchors referenced within the last 30 minutes. */
  anchorEntities: ChatAnchorEntity[];
  updatedAt: number | null;
}

interface ChatConversationStateRow {
  tenant_id: number;
  user_id: number;
  conversation_id: string | null;
  last_domain: string | null;
  last_domain_at: string | null;
  last_assistant_message_id: string | null;
  anchor_entities_json: string | null;
  updated_at: string | null;
}

const activeDomainCache = new Map<string, { domain: DomainName; timestamp: number }>();

function scopedTenantId(userId: number, tenantId?: number): number {
  return typeof tenantId === 'number' && Number.isFinite(tenantId) && tenantId > 0
    ? tenantId
    : userId;
}

function cacheKey(userId: number, tenantId?: number): string {
  return `${scopedTenantId(userId, tenantId)}:${userId}`;
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAnchors(json: string | null): ChatAnchorEntity[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ChatAnchorEntity =>
      !!entry
      && typeof entry === 'object'
      && typeof (entry as ChatAnchorEntity).entityId === 'string'
      && typeof (entry as ChatAnchorEntity).referencedAt === 'number'
      && Number.isFinite((entry as ChatAnchorEntity).referencedAt));
  } catch {
    return [];
  }
}

function readRow(userId: number, tenantId?: number): ChatConversationStateRow | null {
  try {
    const row = getDb().prepare(`
      SELECT tenant_id, user_id, conversation_id, last_domain, last_domain_at,
             last_assistant_message_id, anchor_entities_json, updated_at
      FROM chat_conversation_state
      WHERE tenant_id = ? AND user_id = ?
    `).get(scopedTenantId(userId, tenantId), userId) as ChatConversationStateRow | undefined;
    return row ?? null;
  } catch (err) {
    // Fail open: durable continuity is best-effort; the Map cache still
    // carries the current process.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      'chat_conversation_state read failed — continuing on in-process cache',
    );
    return null;
  }
}

function mergeAnchors(
  existingJson: string | null,
  anchorEntityIds: readonly string[] | undefined,
  timestamp: number,
): string | null {
  if (!anchorEntityIds || anchorEntityIds.length === 0) return null; // keep existing via COALESCE
  const merged = new Map<string, ChatAnchorEntity>();
  for (const anchor of parseAnchors(existingJson)) {
    // Write-time prune uses the same 30-minute decay window so the stored
    // list stays bounded; read-time decay remains authoritative.
    if (timestamp - anchor.referencedAt < CHAT_ANCHOR_ENTITY_TTL_MS) {
      merged.set(anchor.entityId, anchor);
    }
  }
  for (const entityId of anchorEntityIds) {
    if (typeof entityId === 'string' && entityId.length > 0) {
      merged.set(entityId, { entityId, referencedAt: timestamp });
    }
  }
  const bounded = [...merged.values()]
    .sort((a, b) => b.referencedAt - a.referencedAt)
    .slice(0, MAX_ANCHOR_ENTITIES);
  return JSON.stringify(bounded);
}

/**
 * Write-through remember: Map cache first (turn correctness never depends on
 * the DB), then upsert the durable row. Tenant-scoped via the same
 * tenant-fallback-to-user convention as the legacy Map key.
 */
export function rememberActiveChatDomain(
  userId: number,
  domain: DomainName,
  timestamp = Date.now(),
  tenantId?: number,
  extras?: ChatContinuityWriteExtras,
): void {
  activeDomainCache.set(cacheKey(userId, tenantId), { domain, timestamp });

  try {
    const db = getDb();
    const tenant = scopedTenantId(userId, tenantId);
    const existing = db.prepare(
      'SELECT anchor_entities_json FROM chat_conversation_state WHERE tenant_id = ? AND user_id = ?',
    ).get(tenant, userId) as { anchor_entities_json: string | null } | undefined;

    db.prepare(`
      INSERT INTO chat_conversation_state (
        tenant_id, user_id, conversation_id, last_domain, last_domain_at,
        last_assistant_message_id, anchor_entities_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id) DO UPDATE SET
        conversation_id = COALESCE(excluded.conversation_id, conversation_id),
        last_domain = excluded.last_domain,
        last_domain_at = excluded.last_domain_at,
        last_assistant_message_id = COALESCE(excluded.last_assistant_message_id, last_assistant_message_id),
        anchor_entities_json = COALESCE(excluded.anchor_entities_json, anchor_entities_json),
        updated_at = excluded.updated_at
    `).run(
      tenant,
      userId,
      extras?.conversationId ?? null,
      domain,
      new Date(timestamp).toISOString(),
      extras?.lastAssistantMessageId ?? null,
      mergeAnchors(existing?.anchor_entities_json ?? null, extras?.anchorEntityIds, timestamp),
      new Date().toISOString(),
    );
  } catch (err) {
    // Fail open: the DB write must never break the chat turn.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId, domain },
      'chat_conversation_state write failed — turn continues on in-process cache',
    );
  }
}

/**
 * TTL-honoring active-domain read. Map-first; on a cache miss (fresh process)
 * the durable row is consulted and re-cached with its original timestamp so
 * expiry behaves exactly like the pre-M13 Map.
 */
export function getActiveChatDomain(userId: number, now = Date.now(), tenantId?: number): DomainName | null {
  const key = cacheKey(userId, tenantId);
  const cached = activeDomainCache.get(key);
  if (cached) {
    return now - cached.timestamp < CHAT_ACTIVE_DOMAIN_TTL_MS ? cached.domain : null;
  }

  const row = readRow(userId, tenantId);
  const domainAt = parseIsoMs(row?.last_domain_at ?? null);
  if (!row?.last_domain || domainAt === null) return null;

  const domain = row.last_domain as DomainName;
  // Re-populate the read cache with the durable timestamp so subsequent
  // reads (and expiry) match the write-through state.
  activeDomainCache.set(key, { domain, timestamp: domainAt });
  return now - domainAt < CHAT_ACTIVE_DOMAIN_TTL_MS ? domain : null;
}

export function clearActiveChatDomain(userId: number, tenantId?: number): void {
  activeDomainCache.delete(cacheKey(userId, tenantId));
  try {
    // Adversarial-review fix (2026-07): clear ONLY the domain-pin columns.
    // conversation_id / last_assistant_message_id / anchor_entities_json are
    // longer-lived continuity (30-min anchor decay, restart recovery of the
    // last assistant reply) and must survive a domain-pin reset.
    getDb().prepare(`
      UPDATE chat_conversation_state
      SET last_domain = NULL, last_domain_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND user_id = ?
    `).run(new Date().toISOString(), scopedTenantId(userId, tenantId), userId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      'chat_conversation_state clear failed — cleared in-process cache only',
    );
  }
}

/**
 * Typed durable read API (M14/M16 consumers). Reads the DB row directly
 * (source of truth), applies the 5-minute domain TTL and the 30-minute
 * anchor decay at read time. Returns null when no durable row exists or the
 * DB is unavailable (fail-open).
 */
export function getDurableChatContinuity(
  userId: number,
  tenantId?: number,
  now = Date.now(),
): DurableChatContinuity | null {
  const row = readRow(userId, tenantId);
  if (!row) return null;

  const domainAt = parseIsoMs(row.last_domain_at);
  const domainFresh = row.last_domain !== null
    && domainAt !== null
    && now - domainAt < CHAT_ACTIVE_DOMAIN_TTL_MS;

  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    domain: domainFresh ? (row.last_domain as DomainName) : null,
    domainAt,
    lastAssistantMessageId: row.last_assistant_message_id,
    anchorEntities: parseAnchors(row.anchor_entities_json)
      .filter((anchor) => now - anchor.referencedAt < CHAT_ANCHOR_ENTITY_TTL_MS),
    updatedAt: parseIsoMs(row.updated_at),
  };
}

/**
 * Test seam: clears ONLY the in-process read cache (simulates a restart).
 * Durable rows are isolated per test via the mocked database.
 */
export function resetChatConversationStateForTests(): void {
  activeDomainCache.clear();
}
