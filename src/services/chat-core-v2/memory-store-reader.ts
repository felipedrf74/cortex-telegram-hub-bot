// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { resolveChatCoreV2ActivationConfig } from './activation-flags';
import { listChatV2MemoryItems } from './memory-store';
import type { ChatCoreV2Domain, MemoryItemType } from './types';

/**
 * WP-17 (§5.F/§5.G). The LEAN, projection-only memory shape that is allowed to
 * cross out of the store toward the orchestrator/route-decision. It carries
 * ONLY `{type, domain, value}` — it deliberately drops `sensitivity`,
 * `confidence`, `expiresAt`, `sourceTurnId`, `memoryId`, `status`, and the
 * scope ids so none of those internal/privacy fields can ever leak into a
 * prompt or a route-decision input. The full record stays inside the store.
 */
export interface ChatCoreV2MemoryContextItem {
  type: MemoryItemType;
  domain?: ChatCoreV2Domain;
  value: string;
}

export interface LoadChatV2MemoryContextInput {
  tenantId: string | number;
  userId: string | number;
  /** Optional injected env (test seam); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Optional domain scope (e.g. the turn's primary domain). */
  domain?: ChatCoreV2Domain;
  /** Optional "now" for deterministic expiry filtering in tests. */
  now?: string;
}

/**
 * WP-17 (§5.F): the in-prompt confidence floor. Items below this confidence are
 * NEVER projected into the orchestrator context. NOTE: confidence is an
 * informativeness signal only — it is explicitly NOT an injection-safety
 * control (see the sentinel wrap in local-chat-orchestrator). A high-confidence
 * `user_correction` is still untrusted user text and must still be sentinel-
 * wrapped before it reaches a prompt.
 */
export const CHAT_CORE_V2_MEMORY_CONTEXT_MIN_CONFIDENCE = 0.75;

/**
 * WP-17 (§5.F): hard cap on the number of memory items projected into a single
 * turn's context. Bounds both prompt-length inflation and the route-decision
 * input size.
 */
export const CHAT_CORE_V2_MEMORY_CONTEXT_MAX_ITEMS = 10;

/**
 * WP-17 reader (§5.F/§5.G). Loads the active, non-expired, sufficiently-
 * confident memory for the requesting tenant+user and returns the LEAN
 * `{type, domain, value}` projection ONLY.
 *
 * Behavior-preserving / DEFAULT-OFF guarantees:
 *  - returns `[]` when the master orchestrator mode resolves to 'off' (the
 *    kill-switch dominates — no DB read, nothing injected, legacy behavior);
 *  - caps the result at CHAT_CORE_V2_MEMORY_CONTEXT_MAX_ITEMS (10);
 *  - only items with confidence >= CHAT_CORE_V2_MEMORY_CONTEXT_MIN_CONFIDENCE;
 *  - strictly scoped to the requesting tenantId AND userId (String()-coerced);
 *  - never throws — any error (bad DB, schema drift) collapses to `[]` so the
 *    turn proceeds exactly as it would with no memory.
 */
export function loadChatV2MemoryContextForOrchestrator(
  input: LoadChatV2MemoryContextInput,
  db?: Database.Database,
): ChatCoreV2MemoryContextItem[] {
  const env = input.env ?? process.env;
  // Kill-switch: mode=off → no read, no injection, bit-identical legacy turn.
  if (resolveChatCoreV2ActivationConfig(env).mode === 'off') return [];

  // Enforce string scope at the boundary (the store is TEXT-keyed). This also
  // guards against an empty/whitespace scope (which the store rejects) by
  // collapsing to [] rather than throwing on the hot path.
  const tenantId = String(input.tenantId).trim();
  const userId = String(input.userId).trim();
  if (!tenantId || !userId) return [];

  try {
    const database = db ?? getDb();
    const records = listChatV2MemoryItems(
      { tenantId, userId },
      database,
      {
        status: 'active',
        domain: input.domain,
        now: input.now,
        // Pull the store-side ceiling first; we still re-cap below after the
        // confidence filter so the post-filter result honors the 10-item cap.
        limit: CHAT_CORE_V2_MEMORY_CONTEXT_MAX_ITEMS * 4,
      },
    );

    const projected: ChatCoreV2MemoryContextItem[] = [];
    for (const record of records) {
      if (record.confidence < CHAT_CORE_V2_MEMORY_CONTEXT_MIN_CONFIDENCE) continue;
      // LEAN projection ONLY — never copy sensitivity/confidence/expiresAt/etc.
      projected.push({
        type: record.type,
        domain: record.domain,
        value: record.value,
      });
      if (projected.length >= CHAT_CORE_V2_MEMORY_CONTEXT_MAX_ITEMS) break;
    }
    return projected;
  } catch (err) {
    // Never throw into the turn. A read failure must degrade to no-memory.
    logger.warn(
      {
        tenantId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 memory context read failed; proceeding with no memory',
    );
    return [];
  }
}
