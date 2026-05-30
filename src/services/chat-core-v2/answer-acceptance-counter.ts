// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-3 rank 8 — Chat Core v2 answer-acceptance counter: an INERT, canary-only
 * EXIT-metric scaffold (per-tenant per-locale).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES (the Phase-3 canary EXIT metric):
 *   The answer-acceptance RATE per coarse locale bucket. The canary EXIT
 *   thresholds are:
 *     en >= 90%, pt-BR >= 85%, pt-PT >= 80%, mixed >= 75%.
 *   These are DISTINCT from WP-13 recall@8 and from the composer-mode counter —
 *   a separate measurement axis. This module only ACCUMULATES the rate; it never
 *   decides exit and never claims promotion-readiness.
 *
 * CANARY-ONLY INERTNESS (load-bearing):
 *   `incrementAnswerAcceptance(...)` is a RAW writer — it writes when called. Per
 *   the WO it is shipped as a TESTED, seeded API rather than wired to a live
 *   call site, so there is NO live write path in this wave; in off / shadow / on
 *   / absent nothing calls it and the table stays EMPTY. Any future call site
 *   MUST be canary-gated (e.g. behind `shouldServeCanaryForTenant`) so the
 *   off-mode live route stays inert.
 *
 * THIS IS NOT THE PROMOTION GATE:
 *   The acceptance rate is a canary EXIT metric, NEVER promotion-readiness.
 *   `gateCanPromote` (gate-metrics-store.ts) stays the SOLE promotion authority.
 *   Nothing here reads or writes it.
 *
 * REVERT-SAFE DEFAULT:
 *   When a (tenant, locale) scope is EMPTY, `computeAnswerAcceptanceRate()`
 *   returns null (no data) — NOT a misleading 0, which would falsely read as
 *   "0% accepted" and could trip an exit check on a dormant tenant.
 *
 * PRIVACY:
 *   Every column/argument is a SAFE SCALAR — internal tenant_id, a coarse locale
 *   bucket, integer counters, and a timestamp. NO raw user message/prompt/answer
 *   text is read, stored, or logged.
 *
 * FIRE-AND-FORGET:
 *   The UPSERT is wrapped in try/catch and NEVER throws — a persistence failure
 *   can never block or fail a chat turn.
 *
 * TENANT SCOPING:
 *   Every read and write is keyed by tenant_id, so one tenant's counts can never
 *   roll into or be read as another tenant's.
 */

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';

export const CHAT_CORE_V2_ANSWER_ACCEPTANCE_COUNTER_VERSION =
  'chat_core_v2_answer_acceptance_counter@1.0.0';

/**
 * The coarse locale buckets for the canary EXIT metric. Unknown / unset locales
 * normalize to `'mixed'` (the safest, lowest-threshold bucket) so an
 * unclassifiable turn can never be silently dropped or mis-credited to a
 * stricter bucket.
 */
export type ChatCoreV2AcceptanceLocaleBucket = 'en' | 'pt-BR' | 'pt-PT' | 'mixed';

/** All acceptance locale buckets, in a stable order (handy for tests/rollups). */
export const CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS: readonly ChatCoreV2AcceptanceLocaleBucket[] = [
  'en',
  'pt-BR',
  'pt-PT',
  'mixed',
] as const;

/** The documented canary EXIT thresholds per bucket. NOT used to gate anything here. */
export const CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS: Record<ChatCoreV2AcceptanceLocaleBucket, number> = {
  en: 0.9,
  'pt-BR': 0.85,
  'pt-PT': 0.8,
  mixed: 0.75,
};

/**
 * Normalize an arbitrary locale string to a coarse acceptance bucket.
 *
 *  - 'en*'          → 'en'
 *  - 'pt-BR'/'pt_br'→ 'pt-BR'
 *  - other 'pt*'    → 'pt-PT'
 *  - 'mixed'/unknown/empty/null → 'mixed'  (the catch-all, lowest-threshold bucket)
 *
 * Deliberately distinct from `normalizeChatCoreV2Locale` (response-contracts),
 * which has no `mixed` bucket and folds unknowns into `en` — the wrong default
 * for an EXIT metric (it must never inflate the strict `en` bucket).
 */
export function normalizeChatCoreV2AcceptanceLocaleBucket(
  locale: string | null | undefined,
): ChatCoreV2AcceptanceLocaleBucket {
  const normalized = String(locale ?? '').trim().toLowerCase().replace('_', '-');
  if (normalized.length === 0) return 'mixed';
  if (normalized === 'mixed') return 'mixed';
  if (normalized.startsWith('pt-br')) return 'pt-BR';
  if (normalized.startsWith('pt')) return 'pt-PT';
  if (normalized.startsWith('en')) return 'en';
  return 'mixed';
}

/** Idempotent DDL for the answer-acceptance counter table (mirrors migration 179). */
export function ensureChatCoreV2AnswerAcceptanceCounterTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_answer_acceptance_counter (
      tenant_id      TEXT NOT NULL,
      locale         TEXT NOT NULL,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      total_count    INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, locale)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_answer_acceptance_counter_tenant_locale
      ON chat_v2_answer_acceptance_counter(tenant_id, locale);
  `);
}

/**
 * Increment the per-tenant per-locale answer-acceptance counter. Every observed
 * answer bumps total_count; `accepted === true` ALSO bumps accepted_count.
 * Upsert keyed by (tenant_id, locale-bucket).
 *
 * FIRE-AND-FORGET: never throws. The caller owns the canary gate; this raw
 * helper just writes when invoked.
 *
 * Returns `true` when a row was written/updated, `false` when swallowed.
 */
export function incrementAnswerAcceptance(
  db: Database.Database,
  tenantId: string,
  locale: string | null | undefined,
  outcome: { accepted: boolean },
  now: Date = new Date(),
): boolean {
  try {
    ensureChatCoreV2AnswerAcceptanceCounterTable(db);
    const bucket = normalizeChatCoreV2AcceptanceLocaleBucket(locale);
    const acceptedDelta = outcome.accepted ? 1 : 0;
    db.prepare(
      `INSERT INTO chat_v2_answer_acceptance_counter
         (tenant_id, locale, accepted_count, total_count, updated_at)
       VALUES (@tenantId, @locale, @acceptedDelta, 1, @updatedAt)
       ON CONFLICT(tenant_id, locale) DO UPDATE SET
         accepted_count = accepted_count + @acceptedDelta,
         total_count = total_count + 1,
         updated_at = @updatedAt`,
    ).run({
      tenantId: String(tenantId),
      locale: bucket,
      acceptedDelta,
      updatedAt: now.toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        storeVersion: CHAT_CORE_V2_ANSWER_ACCEPTANCE_COUNTER_VERSION,
      },
      'Chat Core v2 answer-acceptance counter increment failed (swallowed; turn unaffected)',
    );
    return false;
  }
}

/**
 * The read scope for `computeAnswerAcceptanceRate`. `tenantId` REQUIRED (tenant
 * scoping is mandatory). Locale comes from the `locale` argument; pass `'all'`
 * to roll up across every bucket for the tenant.
 */
export interface AnswerAcceptanceScope {
  tenantId: string;
}

export interface AnswerAcceptanceRate {
  bucket: ChatCoreV2AcceptanceLocaleBucket | 'all';
  accepted: number;
  total: number;
  /** accepted/total, or null when total === 0 (the revert-safe empty default). */
  rate: number | null;
}

/**
 * Compute accepted/total for a tenant at a locale.
 *
 *  - `locale` is normalized to a bucket; pass the sentinel `'all'` to roll up
 *    across every bucket for the tenant.
 *  - Returns `rate: null` (REVERT-SAFE) when there is no data (total === 0 or the
 *    table is missing) — never a misleading 0 that would read as "0% accepted".
 *
 * Tenant-scoped: a tenant's rate can never include another tenant's counts.
 */
export function computeAnswerAcceptanceRate(
  db: Database.Database,
  locale: string | 'all' | null | undefined,
  scope: AnswerAcceptanceScope,
): AnswerAcceptanceRate {
  const isAll = locale === 'all';
  const bucket: ChatCoreV2AcceptanceLocaleBucket | 'all' = isAll
    ? 'all'
    : normalizeChatCoreV2AcceptanceLocaleBucket(locale);
  try {
    const row = isAll
      ? (db
          .prepare(
            `SELECT
               COALESCE(SUM(accepted_count), 0) AS accepted,
               COALESCE(SUM(total_count), 0)    AS total
             FROM chat_v2_answer_acceptance_counter
             WHERE tenant_id = ?`,
          )
          .get(String(scope.tenantId)) as { accepted: number; total: number } | undefined)
      : (db
          .prepare(
            `SELECT
               COALESCE(SUM(accepted_count), 0) AS accepted,
               COALESCE(SUM(total_count), 0)    AS total
             FROM chat_v2_answer_acceptance_counter
             WHERE tenant_id = ? AND locale = ?`,
          )
          .get(String(scope.tenantId), bucket) as { accepted: number; total: number } | undefined);

    const accepted = Number(row?.accepted) || 0;
    const total = Number(row?.total) || 0;
    // REVERT-SAFE: no samples ⇒ rate null (no data), never a misleading 0.
    const rate = total > 0 ? accepted / total : null;
    return { bucket, accepted, total, rate };
  } catch {
    // Table missing on a fresh DB ⇒ treat as no-data (revert-safe null rate).
    return { bucket, accepted: 0, total: 0, rate: null };
  }
}
