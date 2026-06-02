// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { resolveChatCoreV2ActivationConfig } from './activation-flags';
import { upsertChatV2MemoryItem } from './memory-store';
import type { AuditSensitivity, ChatCoreV2Domain, MemoryItem, MemoryItemType } from './types';

/**
 * WP-17 (§5.F): the stored `value` column is uncapped TEXT, and a
 * `user_correction` value is user-authored text. We bound the STORED length so
 * a single correction can never write an unbounded blob; the orchestrator also
 * re-caps to 200 chars at injection time. This is the at-rest cap (generous so
 * a legitimate decision rationale is not mangled); the in-prompt cap is the
 * tighter 200-char limit enforced in local-chat-orchestrator.
 */
export const CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS = 1000;

export type ChatCoreV2TurnOutcomeKind = 'verified' | 'correction';

export interface TryWriteChatV2MemoryInput {
  /** The outcome that occurred on this turn. */
  outcome: ChatCoreV2TurnOutcomeKind;
  tenantId: string | number;
  userId: string | number;
  /** The text to remember (the rationale on verified, the correction text on correction). */
  value: string;
  /** Domain of the outcome — drives sensitivity mapping. */
  domain?: ChatCoreV2Domain;
  /** The turn id that produced this outcome (used to derive a deterministic memoryId). */
  sourceTurnId: string;
  /** Confidence assigned to the memory (defaults differ by outcome). */
  confidence?: number;
  /** Optional injected env (test seam); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Optional "now" for deterministic timestamps in tests. */
  now?: string;
}

/**
 * WP-17 (§5.B/§5.F) domain → sensitivity mapping. A correction/rationale in a
 * financial or health-adjacent domain carries a higher at-rest sensitivity so
 * retention (WP-08) and any future export honor it. Unknown/absent domains
 * default to 'personal' (the conservative non-'normal' floor — this is
 * user-authored text, never assume it is non-personal).
 */
export function resolveChatV2MemorySensitivity(domain: ChatCoreV2Domain | undefined): AuditSensitivity {
  switch (domain) {
    case 'finance':
      return 'financial';
    case 'training':
      return 'health_adjacent';
    case 'connections':
      return 'credential_adjacent';
    default:
      return 'personal';
  }
}

/**
 * WP-17 writer (§5.F). Fire-and-forget: it NEVER throws and NEVER blocks the
 * turn. It writes a `decision_rationale` memory item on a verified outcome and
 * a `user_correction` item on a correction. The memoryId is a deterministic
 * sha256 of `${outcome}:${tenantId}:${userId}:${sourceTurnId}` so a retry of
 * the same turn is idempotent (the store's ON CONFLICT updates in place rather
 * than inserting a duplicate row). On any failure it logs and returns — the
 * caller does not await a result it can act on.
 *
 * Kill-switch: returns immediately (no write) when mode resolves to 'off'.
 */
export function tryWriteChatV2MemoryFromTurnOutcome(
  input: TryWriteChatV2MemoryInput,
  db?: Database.Database,
): void {
  try {
    const env = input.env ?? process.env;
    if (resolveChatCoreV2ActivationConfig(env).mode === 'off') return;

    const tenantId = String(input.tenantId).trim();
    const userId = String(input.userId).trim();
    const sourceTurnId = String(input.sourceTurnId ?? '').trim();
    const rawValue = String(input.value ?? '').trim();
    if (!tenantId || !userId || !sourceTurnId || !rawValue) return;

    const type: MemoryItemType = input.outcome === 'correction'
      ? 'user_correction'
      : 'decision_rationale';

    const value = truncateStoredValue(rawValue);
    const sensitivity = resolveChatV2MemorySensitivity(input.domain);
    const confidence = clampConfidence(
      input.confidence ?? (input.outcome === 'correction' ? 0.9 : 0.8),
    );
    const timestamp = input.now ?? new Date().toISOString();
    const memoryId = deriveDeterministicMemoryId(input.outcome, tenantId, userId, sourceTurnId);

    const item: MemoryItem = {
      memoryId,
      userId,
      tenantId,
      type,
      domain: input.domain,
      value,
      sourceTurnId,
      confidence,
      sensitivity,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    upsertChatV2MemoryItem(item, db ?? getDb());
  } catch (err) {
    // Fire-and-forget: a write failure must never surface to the turn.
    logger.warn(
      {
        outcome: input.outcome,
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 memory write failed (non-blocking)',
    );
  }
}

function truncateStoredValue(value: string): string {
  return value.length <= CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS
    ? value
    : value.slice(0, CHAT_CORE_V2_MEMORY_STORED_VALUE_MAX_CHARS);
}

function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.8;
  return Math.min(1, Math.max(0, confidence));
}

function deriveDeterministicMemoryId(
  outcome: ChatCoreV2TurnOutcomeKind,
  tenantId: string,
  userId: string,
  sourceTurnId: string,
): string {
  const hash = createHash('sha256')
    .update(`${outcome}:${tenantId}:${userId}:${sourceTurnId}`)
    .digest('hex')
    .slice(0, 24);
  return `chat_v2_mem:${outcome}:${hash}`;
}
