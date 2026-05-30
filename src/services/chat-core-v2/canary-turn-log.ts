// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-3 rank 8 — Chat Core v2 canary turn log: an INERT, canary-only
 * measurement scaffold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CANARY-ONLY INERTNESS (the load-bearing invariant of this module):
 *   `maybeRecordCanaryTurn(input, {env, db})` is a strict NO-OP unless
 *   `shouldServeCanaryForTenant(tenantId, env)` is true — i.e. ONLY when
 *   CHAT_CORE_V2_ORCHESTRATOR_MODE === 'canary' AND the per-tenant master
 *   kill-switch is not forcing this tenant off AND the tenant is in the canary
 *   cohort allowlist. In off / shadow / on / absent (absent parses to 'off'),
 *   and for any non-cohort or killed tenant, it writes NOTHING — no throw, no DB
 *   write, no boot impact. (`recordCanaryTurn` is the RAW writer behind the gate;
 *   callers that use it directly own the gate themselves.)
 *
 * THIS IS NOT THE PROMOTION GATE:
 *   Rows here are a coarse traffic-shape measurement, NEVER promotion-readiness.
 *   `gateCanPromote` (gate-metrics-store.ts) remains the SOLE promotion authority
 *   and stays false until a real corpus is persisted. This module NEVER reads,
 *   writes, or influences `gateCanPromote`.
 *
 * PRIVACY:
 *   Every persisted column is a SAFE SCALAR — internal tenant/user ids, an opaque
 *   turn-id correlation handle, a matched route path/method, a fixed
 *   reasoning-tier label, a numeric confidence, a coarse locale bucket, and
 *   timestamps. NO raw user message/prompt/answer text is read, stored, or
 *   logged. The input type does not even carry message text.
 *
 * FIRE-AND-FORGET:
 *   The INSERT is wrapped in try/catch and NEVER throws — a persistence failure
 *   can never block or fail a chat turn.
 *
 * TENANT + USER SCOPING:
 *   Every row carries tenant_id + user_id; the gate is per-tenant, so one
 *   tenant's rows can never be written under another tenant's gate.
 */

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';
import { shouldServeCanaryForTenant } from './canary-gate-guard';
import { normalizeChatCoreV2AcceptanceLocaleBucket } from './answer-acceptance-counter';

export const CHAT_CORE_V2_CANARY_TURN_LOG_VERSION = 'chat_core_v2_canary_turn_log@1.0.0';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Default retention horizon for a canary turn row (mirrors migration 178's +90d). */
export const CHAT_CORE_V2_CANARY_TURN_LOG_RETENTION_DAYS = 90;

/**
 * A single safe-scalar canary turn row. NO raw message/prompt/answer text — only
 * scoping identifiers, an opaque turn handle, route/tier/confidence/locale
 * scalars, and timestamps.
 */
export interface CanaryTurnLogRow {
  tenantId: string;
  userId: string;
  turnId: string;
  routePath?: string | null;
  routeMethod?: string | null;
  reasoningTier?: string | null;
  /** Numeric confidence; clamped to [0,1] before persist. */
  confidence?: number | null;
  /** Raw locale string; normalized to a coarse bucket before persist. */
  locale?: string | null;
  recordedAt?: Date;
}

/** Idempotent DDL for the canary turn log table (mirrors migration 178). */
export function ensureChatCoreV2CanaryTurnLogTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_canary_turn_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id      TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      turn_id        TEXT NOT NULL,
      route_path     TEXT,
      route_method   TEXT,
      reasoning_tier TEXT,
      confidence     REAL,
      locale         TEXT,
      recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at     TEXT NOT NULL DEFAULT (datetime('now', '+90 days'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_canary_turn_log_tenant_recorded_at
      ON chat_v2_canary_turn_log(tenant_id, recorded_at);
  `);
}

/** Clamp a possibly-undefined numeric confidence into [0,1]; null when absent/non-finite. */
function clampConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** ISO timestamp `days` after `from`. Used for the explicit expires_at horizon. */
function isoPlusDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * RAW fire-and-forget INSERT of one canary turn row. Writes when called — the
 * canary gate lives at the call site (`maybeRecordCanaryTurn`). NEVER throws.
 *
 * Returns `true` when a row was written, `false` when swallowed.
 */
export function recordCanaryTurn(db: Database.Database, row: CanaryTurnLogRow): boolean {
  try {
    ensureChatCoreV2CanaryTurnLogTable(db);
    const recordedAt = row.recordedAt ?? new Date();
    db.prepare(
      `INSERT INTO chat_v2_canary_turn_log
         (tenant_id, user_id, turn_id, route_path, route_method, reasoning_tier,
          confidence, locale, recorded_at, expires_at)
       VALUES
         (@tenantId, @userId, @turnId, @routePath, @routeMethod, @reasoningTier,
          @confidence, @locale, @recordedAt, @expiresAt)`,
    ).run({
      tenantId: String(row.tenantId),
      userId: String(row.userId),
      turnId: String(row.turnId),
      routePath: row.routePath ?? null,
      routeMethod: row.routeMethod ?? null,
      reasoningTier: row.reasoningTier ?? null,
      confidence: clampConfidence(row.confidence),
      // Normalize to a coarse bucket so the persisted locale is always safe-scalar
      // and aligns with the answer-acceptance EXIT-metric buckets.
      locale: normalizeChatCoreV2AcceptanceLocaleBucket(row.locale),
      recordedAt: recordedAt.toISOString(),
      expiresAt: isoPlusDays(recordedAt, CHAT_CORE_V2_CANARY_TURN_LOG_RETENTION_DAYS),
    });
    return true;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_CANARY_TURN_LOG_VERSION,
      },
      'Chat Core v2 canary turn log insert failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

export interface MaybeRecordCanaryTurnDeps {
  /** Environment source. Defaults to process.env. */
  env?: EnvLike;
  /** Target db. Defaults to the shared app db. */
  db?: Database.Database;
}

/**
 * CANARY-GATED recorder. A strict NO-OP unless
 * `shouldServeCanaryForTenant(input.tenantId, env)` is true. In off / shadow /
 * on / absent, and for any non-cohort or killed tenant, this writes NOTHING and
 * returns `false` WITHOUT touching the db. Under canary+cohort it delegates to
 * the fire-and-forget `recordCanaryTurn`.
 *
 * Returns `true` only when a row was actually written.
 */
export function maybeRecordCanaryTurn(
  input: CanaryTurnLogRow,
  deps: MaybeRecordCanaryTurnDeps = {},
): boolean {
  const env = (deps.env ?? process.env) as EnvLike;
  // The single gate: canary mode + per-tenant kill-switch not off + in cohort.
  if (!shouldServeCanaryForTenant(input.tenantId, env as Record<string, string | undefined>)) {
    return false;
  }
  const db = deps.db ?? getDb();
  return recordCanaryTurn(db, input);
}
