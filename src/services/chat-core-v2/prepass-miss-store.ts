// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-2 rank 5 — persistence + mode-gated emission for Chat Core v2 Layer-1
 * prepass recall-misses.
 *
 * A "recall-miss" is a turn where the deterministic prepass candidate set did
 * NOT contain the capability the route decision ultimately selected — exactly
 * the signal `migrations/175_chat_v2_prepass_miss_log.sql` persists.
 *
 * OFF-MODE INERTNESS (load-bearing): the ONLY emission entry point,
 * `maybeEmitPrepassRecallMiss()`, returns WITHOUT touching the DB whenever
 * CHAT_CORE_V2_ORCHESTRATOR_MODE is off/absent (or the tenant is demoted off via
 * the WP-07 kill-switch). No row, no counter, no table creation. The live OFF
 * route (`routeMessage` in chat-message-routes.ts) never calls into this module,
 * so an off-mode turn writes ZERO new rows. The active-mode shadow / canary / on
 * paths are the sole writers.
 *
 * PRIVACY: the only content column is `message_hash`, a one-way HMAC digest
 * built by `buildPrepassRecallFailureRecord` (prepass-miss-log.ts). No raw user
 * message text, prompt text, or other free-text PII is ever passed to or stored
 * by this module. tenant/user/turn ids are the same internal scoping identifiers
 * `chat_v2_trace_spans` already persists.
 *
 * FIRE-AND-FORGET: `recordPrepassRecallFailure` is a single INSERT wrapped in
 * try/catch and NEVER throws — a persistence failure can never block or fail a
 * chat turn.
 */

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  resolveChatCoreV2ActivationConfig,
  isChatCoreV2MasterKillSwitchOff,
} from './activation-flags';
import {
  buildPrepassRecallFailureRecord,
  type PrepassRecallFailureRecord,
} from './prepass-miss-log';

export const CHAT_CORE_V2_PREPASS_MISS_STORE_VERSION = 'chat_core_v2_prepass_miss_store@1.0.0';

type EnvLike = Record<string, string | undefined>;

/**
 * A fully-built, HMAC-only recall-miss row ready to persist. The `record` is the
 * privacy-safe payload (`messageHash` etc.); the raw `turnId` / `tenantId` /
 * `userId` are the internal scoping identifiers (matching `chat_v2_trace_spans`)
 * and the `expectedCapabilityIds` are the recall target the prepass missed.
 */
export interface PrepassRecallFailurePersistInput {
  /** Internal turn id (scoping, not PII). */
  turnId: string;
  /** Internal tenant id (scoping, not PII). */
  tenantId: string;
  /** Internal user id (scoping, not PII). */
  userId: string;
  /** The HMAC-only record (messageHash, candidate ids, reason codes, …). */
  record: PrepassRecallFailureRecord;
  /** The capability ids the prepass should have recalled but did not. */
  expectedCapabilityIds: string[];
}

/** Idempotent DDL for the prepass-miss-log table (mirrors migration 175). */
export function ensureChatCoreV2PrepassMissLogTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_prepass_miss_log (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id                   TEXT NOT NULL,
      tenant_id                 TEXT NOT NULL,
      user_id                   TEXT NOT NULL,
      message_hash              TEXT NOT NULL,
      expected_capability_ids   TEXT NOT NULL DEFAULT '[]',
      candidate_capability_ids  TEXT NOT NULL DEFAULT '[]',
      locale                    TEXT NOT NULL DEFAULT 'unknown',
      reason_codes              TEXT NOT NULL DEFAULT '[]',
      schema_version            TEXT NOT NULL,
      recorded_at               TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at                TEXT NOT NULL DEFAULT (datetime('now', '+30 days'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_prepass_miss_log_tenant_recorded
      ON chat_v2_prepass_miss_log(tenant_id, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_chat_v2_prepass_miss_log_retention
      ON chat_v2_prepass_miss_log(expires_at);
  `);
}

/**
 * Persist ONE prepass recall-miss row. Single INSERT, FIRE-AND-FORGET: any
 * failure (missing table, closed db, driver error) is swallowed and logged — it
 * NEVER throws, so a chat turn can never be blocked or failed by this write.
 *
 * The caller is responsible for the off-mode gate; this raw persistence helper
 * just writes when invoked. Production callers should go through
 * `maybeEmitPrepassRecallMiss()`, which applies the mode gate first.
 *
 * Returns `true` when a row was inserted, `false` when the write was swallowed.
 */
export function recordPrepassRecallFailure(
  db: Database.Database,
  input: PrepassRecallFailurePersistInput,
): boolean {
  try {
    ensureChatCoreV2PrepassMissLogTable(db);
    db.prepare(
      `INSERT INTO chat_v2_prepass_miss_log
         (turn_id, tenant_id, user_id, message_hash,
          expected_capability_ids, candidate_capability_ids,
          locale, reason_codes, schema_version, recorded_at, expires_at)
       VALUES
         (@turnId, @tenantId, @userId, @messageHash,
          @expectedCapabilityIds, @candidateCapabilityIds,
          @locale, @reasonCodes, @schemaVersion, @recordedAt, @expiresAt)`,
    ).run({
      turnId: input.turnId,
      tenantId: input.tenantId,
      userId: input.userId,
      messageHash: input.record.messageHash,
      expectedCapabilityIds: JSON.stringify(normalizeIds(input.expectedCapabilityIds)),
      candidateCapabilityIds: JSON.stringify(normalizeIds(input.record.candidateCapabilityIds)),
      locale: input.record.locale,
      reasonCodes: JSON.stringify(normalizeIds(input.record.reasonCodes)),
      schemaVersion: input.record.schemaVersion,
      recordedAt: input.record.createdAt,
      expiresAt: addDaysIso(input.record.createdAt, 30),
    });
    return true;
  } catch (err) {
    // Fire-and-forget: never throw into the caller. A persistence failure is
    // observability loss, not a turn failure.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_PREPASS_MISS_STORE_VERSION,
      },
      'Chat Core v2 prepass recall-miss persist failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

export interface MaybeEmitPrepassRecallMissInput {
  /** Internal turn id (scoping, not PII). */
  turnId: string;
  /** Internal tenant id (scoping, not PII). */
  tenantId: string;
  /** Internal user id (scoping, not PII). */
  userId: string;
  /** Raw user message — hashed via HMAC, NEVER stored as text. */
  message: string;
  /** Detected locale (bounded enum / 'unknown'). */
  locale: string;
  /** The capability ids the prepass should have recalled (route's selection). */
  expectedCapabilityIds: string[];
  /** The prepass candidate ids that were actually produced. */
  candidateCapabilityIds: string[];
  /** Machine reason codes describing the miss. */
  reasonCodes: string[];
  /** Optional final/selected capability for the record (audit only). */
  finalCapabilityId?: string;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
  /** Test/override seam for env; defaults to process.env. */
  env?: EnvLike;
  /** Optional db; defaults to getDb(). */
  db?: Database.Database;
}

/**
 * Mode-gated emission entry point. This is the ONLY function active-mode callers
 * (shadow observe flow, orchestration gate under canary/on) should use.
 *
 * OFF-MODE INERTNESS: returns `false` WITHOUT any DB access when
 *   - the resolved orchestrator mode is 'off' (or absent ⇒ parsed as off), OR
 *   - the per-tenant master kill-switch forces this tenant off/shadow-demoted.
 * In those cases NO row is written and the table is never even touched.
 *
 * Under an ACTIVE mode (shadow / canary / on) it builds the HMAC-only record and
 * fire-and-forgets a single INSERT. It NEVER throws.
 *
 * Returns `true` only when a row was actually persisted.
 */
export function maybeEmitPrepassRecallMiss(input: MaybeEmitPrepassRecallMissInput): boolean {
  try {
    const env = input.env ?? process.env;

    // (1) OFF-MODE INERTNESS — the load-bearing guard. No DB access at all when
    //     the orchestrator mode is off/absent. An active mode is shadow/canary/on.
    const mode = resolveChatCoreV2ActivationConfig(env).mode;
    if (mode === 'off') return false;

    // (2) Honor the per-tenant kill-switch (WP-07 demotion reaches us without a
    //     restart). A demoted tenant emits nothing even under an active env mode.
    if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) return false;

    const hmacSecret = resolvePrepassMissHmacSecret(env);
    if (!hmacSecret) {
      // No secret ⇒ we cannot build a privacy-safe hash; skip rather than store
      // anything weak. Never store raw text.
      return false;
    }

    const record = buildPrepassRecallFailureRecord({
      hmacSecret,
      tenantId: String(input.tenantId),
      userId: String(input.userId),
      message: input.message,
      locale: input.locale,
      candidateCapabilityIds: input.candidateCapabilityIds,
      finalCapabilityId: input.finalCapabilityId,
      reasonCodes: input.reasonCodes,
      createdAt: input.createdAt,
    });

    const db = input.db ?? getDb();
    return recordPrepassRecallFailure(db, {
      turnId: String(input.turnId),
      tenantId: String(input.tenantId),
      userId: String(input.userId),
      record,
      expectedCapabilityIds: input.expectedCapabilityIds,
    });
  } catch (err) {
    // Belt-and-suspenders: the whole emission is fire-and-forget.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_PREPASS_MISS_STORE_VERSION,
      },
      'Chat Core v2 prepass recall-miss emission failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

export interface PrepassRecallFailureRow {
  id: number;
  turnId: string;
  tenantId: string;
  userId: string;
  messageHash: string;
  expectedCapabilityIds: string[];
  candidateCapabilityIds: string[];
  locale: string;
  reasonCodes: string[];
  schemaVersion: string;
  recordedAt: string;
  expiresAt: string;
}

/**
 * Read recall-miss rows scoped to a single tenant (and optionally a single
 * user), newest first. TENANT scoping is enforced at the query boundary — a
 * tenant can never read another tenant's rows. Returns [] when the table does
 * not exist yet (fresh DB) rather than throwing.
 */
export function listPrepassRecallFailures(
  db: Database.Database,
  scope: { tenantId: string; userId?: string },
  limit = 100,
): PrepassRecallFailureRow[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  let rows: PrepassMissDbRow[];
  try {
    if (scope.userId !== undefined) {
      rows = db
        .prepare(
          `SELECT id, turn_id, tenant_id, user_id, message_hash,
                  expected_capability_ids, candidate_capability_ids,
                  locale, reason_codes, schema_version, recorded_at, expires_at
           FROM chat_v2_prepass_miss_log
           WHERE tenant_id = ? AND user_id = ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(String(scope.tenantId), String(scope.userId), safeLimit) as PrepassMissDbRow[];
    } else {
      rows = db
        .prepare(
          `SELECT id, turn_id, tenant_id, user_id, message_hash,
                  expected_capability_ids, candidate_capability_ids,
                  locale, reason_codes, schema_version, recorded_at, expires_at
           FROM chat_v2_prepass_miss_log
           WHERE tenant_id = ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(String(scope.tenantId), safeLimit) as PrepassMissDbRow[];
    }
  } catch {
    return [];
  }
  return rows.map(mapRow);
}

interface PrepassMissDbRow {
  id: number;
  turn_id: string;
  tenant_id: string;
  user_id: string;
  message_hash: string;
  expected_capability_ids: string;
  candidate_capability_ids: string;
  locale: string;
  reason_codes: string;
  schema_version: string;
  recorded_at: string;
  expires_at: string;
}

function mapRow(row: PrepassMissDbRow): PrepassRecallFailureRow {
  return {
    id: row.id,
    turnId: row.turn_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    messageHash: row.message_hash,
    expectedCapabilityIds: parseJsonArray(row.expected_capability_ids),
    candidateCapabilityIds: parseJsonArray(row.candidate_capability_ids),
    locale: row.locale,
    reasonCodes: parseJsonArray(row.reason_codes),
    schemaVersion: row.schema_version,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
  };
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the HMAC secret used to hash the message. Reuses the same secrets the
 * shadow-route hook already accepts so deployments do not need a new variable.
 */
function resolvePrepassMissHmacSecret(env: EnvLike): string | null {
  const secret = env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET
    ?? env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET
    ?? env.CLASSIFY_SHADOW_HASH_SECRET;
  const trimmed = secret?.trim();
  return trimmed ? trimmed : null;
}

function normalizeIds(values: string[]): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

/**
 * Add `days` to an ISO timestamp, returning an ISO string. Falls back to a raw
 * `+days*86400000ms` offset; if the input is unparseable, returns it unchanged
 * (the DB column default would otherwise apply, but we always pass a value).
 */
function addDaysIso(iso: string, days: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString();
}
