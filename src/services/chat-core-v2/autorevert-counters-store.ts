// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-2 rank 6 — per-tenant per-hour counter store for the Chat Core v2
 * auto-revert metrics aggregator.
 *
 * Two counters back the aggregator's previously-hardcoded revert-safe
 * placeholders (`metrics-aggregator.ts`):
 *   - `chat_v2_schema_compliance_counter` — pass/fail of constrained outputs,
 *     summed over the trailing 1h to produce the schema-compliance rate;
 *   - `chat_v2_legacy_fallback_counter`   — fallback/total under an active mode,
 *     summed over the trailing 24h to produce the legacy-fallback rate.
 * (Migration `177_chat_v2_autorevert_counters.sql`.)
 *
 * OFF-MODE INERTNESS (load-bearing): these increment helpers are RAW writers —
 * they write when called. The off-mode gate lives at the CALL SITES, which only
 * fire under an active path:
 *   - schema-compliance increments come from `planChatCoreV2ShadowTurnWithPlanner`
 *     (shadow-orchestrator.ts), which only does anything when a planner is
 *     injected (shadow+/sandbox) — off-mode inert by construction;
 *   - legacy-fallback increments come from `runChatCoreV2OrchestrationGate`
 *     (orchestration-gate.ts) AFTER it has already proven the env mode is
 *     canary/on AND the per-tenant master kill-switch is not forcing this tenant
 *     off — so the increment can never run on the off-mode live route.
 * When CHAT_CORE_V2_ORCHESTRATOR_MODE is off/absent neither call site executes,
 * so both tables stay EMPTY and the aggregator returns its dormant-safe defaults.
 *
 * REVERT-SAFE DEFAULTS: when a counter table is EMPTY for a tenant the read
 * helpers return null counts and the aggregator falls back to its documented
 * no-data default (compliance 1.0, fallback 0.0).
 *
 * PRIVACY: every column is a safe scalar — internal tenant_id, a coarse hour
 * bucket string, and integer counters. NO raw user message text, prompt text, or
 * other PII is ever passed to or stored by this module.
 *
 * FIRE-AND-FORGET: every increment is wrapped in try/catch and NEVER throws — a
 * persistence failure can never block or fail a chat turn.
 *
 * TENANT SCOPING: every read and write is keyed by `tenant_id`, so one tenant's
 * counters can never roll into or be read as another tenant's.
 */

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';

export const CHAT_CORE_V2_AUTOREVERT_COUNTERS_STORE_VERSION =
  'chat_core_v2_autorevert_counters_store@1.0.0';

/** Idempotent DDL for the schema-compliance counter table (mirrors migration 177). */
export function ensureChatCoreV2SchemaComplianceCounterTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_schema_compliance_counter (
      tenant_id     TEXT NOT NULL,
      window_start  TEXT NOT NULL,
      pass_count    INTEGER NOT NULL DEFAULT 0,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_schema_compliance_counter_tenant_window
      ON chat_v2_schema_compliance_counter(tenant_id, window_start);
  `);
}

/** Idempotent DDL for the legacy-fallback counter table (mirrors migration 177). */
export function ensureChatCoreV2LegacyFallbackCounterTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_counter (
      tenant_id       TEXT NOT NULL,
      window_start    TEXT NOT NULL,
      fallback_count  INTEGER NOT NULL DEFAULT 0,
      total_count     INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_fallback_counter_tenant_window
      ON chat_v2_legacy_fallback_counter(tenant_id, window_start);
  `);
}

/** Ensure BOTH counter tables exist (convenience for tests / boot). */
export function ensureChatCoreV2AutoRevertCounterTables(db: Database.Database = getDb()): void {
  ensureChatCoreV2SchemaComplianceCounterTable(db);
  ensureChatCoreV2LegacyFallbackCounterTable(db);
}

/**
 * The coarse hour bucket key for a timestamp: 'YYYY-MM-DDTHH' in UTC. Deliberately
 * truncated to the hour so a row can never fingerprint an individual turn.
 */
export function chatCoreV2HourBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
}

/**
 * Increment the per-tenant per-hour schema-compliance counter for the CURRENT
 * hour bucket. `valid === true` (validated or repaired) bumps pass_count;
 * `valid === false` (unrepairable) bumps fail_count. Upsert keyed by
 * (tenant_id, window_start).
 *
 * FIRE-AND-FORGET: never throws. The caller owns the off-mode gate; this raw
 * helper just writes when invoked (the only production caller is the shadow
 * planner path, which is off-mode inert by construction).
 *
 * Returns `true` when a row was written/updated, `false` when swallowed.
 */
export function incrementSchemaCompliance(
  db: Database.Database,
  tenantId: string,
  outcome: { valid: boolean },
  now: Date = new Date(),
): boolean {
  try {
    ensureChatCoreV2SchemaComplianceCounterTable(db);
    const windowStart = chatCoreV2HourBucket(now);
    const passDelta = outcome.valid ? 1 : 0;
    const failDelta = outcome.valid ? 0 : 1;
    db.prepare(
      `INSERT INTO chat_v2_schema_compliance_counter
         (tenant_id, window_start, pass_count, fail_count, updated_at)
       VALUES (@tenantId, @windowStart, @passDelta, @failDelta, @updatedAt)
       ON CONFLICT(tenant_id, window_start) DO UPDATE SET
         pass_count = pass_count + @passDelta,
         fail_count = fail_count + @failDelta,
         updated_at = @updatedAt`,
    ).run({
      tenantId: String(tenantId),
      windowStart,
      passDelta,
      failDelta,
      updatedAt: now.toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_AUTOREVERT_COUNTERS_STORE_VERSION,
      },
      'Chat Core v2 schema-compliance counter increment failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

/**
 * Increment the per-tenant per-hour legacy-fallback counter for the CURRENT hour
 * bucket. Every active-mode turn observed at the gate bumps total_count;
 * `fellBack === true` (the gate declined / a legacy fallback occurred) ALSO bumps
 * fallback_count. Upsert keyed by (tenant_id, window_start).
 *
 * FIRE-AND-FORGET: never throws. The caller owns the active-mode gate; the only
 * production caller (`runChatCoreV2OrchestrationGate`) has already proven the
 * mode is canary/on and the per-tenant kill-switch is not off before calling.
 *
 * Returns `true` when a row was written/updated, `false` when swallowed.
 */
export function incrementLegacyFallback(
  db: Database.Database,
  tenantId: string,
  outcome: { fellBack: boolean },
  now: Date = new Date(),
): boolean {
  try {
    ensureChatCoreV2LegacyFallbackCounterTable(db);
    const windowStart = chatCoreV2HourBucket(now);
    const fallbackDelta = outcome.fellBack ? 1 : 0;
    db.prepare(
      `INSERT INTO chat_v2_legacy_fallback_counter
         (tenant_id, window_start, fallback_count, total_count, updated_at)
       VALUES (@tenantId, @windowStart, @fallbackDelta, 1, @updatedAt)
       ON CONFLICT(tenant_id, window_start) DO UPDATE SET
         fallback_count = fallback_count + @fallbackDelta,
         total_count = total_count + 1,
         updated_at = @updatedAt`,
    ).run({
      tenantId: String(tenantId),
      windowStart,
      fallbackDelta,
      updatedAt: now.toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_AUTOREVERT_COUNTERS_STORE_VERSION,
      },
      'Chat Core v2 legacy-fallback counter increment failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

export interface SchemaComplianceSums {
  pass: number;
  fail: number;
}

/**
 * Sum pass/fail over all hour buckets at or after `cutoffWindowStart` for one
 * tenant. `cutoffWindowStart` is an inclusive hour-bucket string ('YYYY-MM-DDTHH')
 * so the trailing-window comparison is a lexicographic >= on the bucket key.
 * Returns null when the table is missing or no rows match (the EMPTY-table case),
 * which the aggregator maps to its revert-safe 1.0 default.
 */
export function sumSchemaComplianceSince(
  db: Database.Database,
  tenantId: string,
  cutoffWindowStart: string,
): SchemaComplianceSums | null {
  try {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(pass_count), 0) AS pass,
           COALESCE(SUM(fail_count), 0) AS fail
         FROM chat_v2_schema_compliance_counter
         WHERE tenant_id = ? AND window_start >= ?`,
      )
      .get(String(tenantId), cutoffWindowStart) as { pass: number; fail: number } | undefined;
    if (!row) return null;
    const pass = Number(row.pass) || 0;
    const fail = Number(row.fail) || 0;
    if (pass + fail <= 0) return null; // no samples → revert-safe default upstream
    return { pass, fail };
  } catch {
    // Table missing on a fresh DB → treat as no-data (revert-safe default).
    return null;
  }
}

export interface LegacyFallbackSums {
  fallback: number;
  total: number;
}

/**
 * Sum fallback/total over all hour buckets at or after `cutoffWindowStart` for
 * one tenant. Returns null when the table is missing or no rows match (the
 * EMPTY-table case), which the aggregator maps to its revert-safe 0.0 default.
 */
export function sumLegacyFallbackSince(
  db: Database.Database,
  tenantId: string,
  cutoffWindowStart: string,
): LegacyFallbackSums | null {
  try {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(fallback_count), 0) AS fallback,
           COALESCE(SUM(total_count), 0)    AS total
         FROM chat_v2_legacy_fallback_counter
         WHERE tenant_id = ? AND window_start >= ?`,
      )
      .get(String(tenantId), cutoffWindowStart) as { fallback: number; total: number } | undefined;
    if (!row) return null;
    const fallback = Number(row.fallback) || 0;
    const total = Number(row.total) || 0;
    if (total <= 0) return null; // no samples → revert-safe default upstream
    return { fallback, total };
  } catch {
    return null;
  }
}
