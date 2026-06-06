// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Chat Core v2 — auto-revert executor (WP-07, the WRITE half of B7).
 *
 * `applyAutoRevertDecision(tenantId, decision, metrics, db?)` is the safety valve
 * that turns an evaluated `ChatCoreV2AutoRevertDecision` into:
 *   1. ONE durable audit row in `chat_v2_auto_revert_decisions` (incl. a
 *      `keep_current_mode` no-op row) carrying ONLY SAFE SCALARS in the metrics
 *      snapshot (numbers / enums / booleans — NEVER raw strings / PII), and
 *   2. per-action mutations applied to ONLY that tenant's runtime-override Map
 *      entry (per-tenant isolation, §5.J — tenant A's decision never touches
 *      tenant B), and
 *   3. an optional operator page via `CHAT_CORE_V2_PAGER_WEBHOOK_URL`.
 *
 * SAFETY: every external effect is non-blocking. A DB write failure, an absent /
 * non-https / non-2xx / timed-out pager — none of these throw out of this
 * function. The auto-revert cron must never crash on a failed effect.
 *
 * The live-path seam is in `activation-flags.ts`: the override Map mutated here is
 * the same Map `isChatCoreV2MasterKillSwitchOff(env, tenantId)` consults, so a
 * `flip_*_to_shadow` reaches `chat-message-routes` (`:1024/:1146/:1332`) WITHOUT a
 * restart. KILL-SWITCH PRECEDENCE is preserved: the Map can only DEMOTE; an
 * env-off path can never be promoted by an override.
 */

import { createHash } from 'crypto';

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  getChatCoreV2RuntimeOverride,
  setChatCoreV2RuntimeOverride,
  type ChatCoreV2TenantOverride,
} from './activation-flags';
import type {
  ChatCoreV2AutoRevertAction,
  ChatCoreV2AutoRevertDecision,
  ChatCoreV2AutoRevertMetrics,
} from './auto-revert-policy';

export const CHAT_CORE_V2_AUTO_REVERT_EXECUTOR_VERSION = 'chat_core_v2_auto_revert_executor@1.0.0';

/**
 * The SAFE-SCALAR-ONLY projection of the metrics that is persisted to
 * `metrics_snapshot_json`. By construction this carries only numbers / booleans
 * (and a count) — no raw strings from user input, no PII. The per-language arm
 * is reduced to a COUNT, never the (potentially identifying) language keys/values
 * map, to keep the snapshot scalar-only.
 */
export interface ChatCoreV2AutoRevertMetricsSnapshot {
  legacyFallbackRate24h: number;
  ollamaHealthy: boolean;
  schemaComplianceRate1h: number;
  perLanguageArmTrackedCount: number;
}

/**
 * Project the raw metrics down to SAFE SCALARS ONLY for persistence. Anything
 * that is not a finite number / boolean is dropped. The per-language map is
 * collapsed to its tracked-key count (a scalar), never persisted as a map.
 */
export function buildAutoRevertMetricsSnapshot(
  metrics: ChatCoreV2AutoRevertMetrics,
): ChatCoreV2AutoRevertMetricsSnapshot {
  const perLanguage = metrics.prepassRecallByLanguage ?? {};
  return {
    legacyFallbackRate24h: safeNumber(metrics.legacyFallbackRate24h),
    ollamaHealthy: metrics.ollamaHealthy === true,
    schemaComplianceRate1h: safeNumber(metrics.schemaComplianceRate1h),
    perLanguageArmTrackedCount: Object.keys(perLanguage).length,
  };
}

/**
 * Apply one evaluated auto-revert decision for a SINGLE tenant. Persists the
 * audit row, mutates only this tenant's override entry, and (for `page_operator`)
 * fires a non-fatal page. Returns void; never throws.
 */
export async function applyAutoRevertDecision(
  tenantId: string,
  decision: ChatCoreV2AutoRevertDecision,
  metrics: ChatCoreV2AutoRevertMetrics,
  db?: Database.Database,
): Promise<void> {
  const snapshot = buildAutoRevertMetricsSnapshot(metrics);

  // 1) Persist — non-blocking. A DB failure must not block the valve or crash
  //    the cron. A keep_current_mode (no-op) decision is persisted too.
  persistAutoRevertDecision(tenantId, decision, snapshot, db);

  // 2) Apply per-action mutations to ONLY this tenant's override Map entry.
  //    Per-tenant isolation (§5.J): we read+merge this tenant's existing entry
  //    and never read or write another tenant's key.
  let shouldPage = false;
  for (const action of decision.actions) {
    if (applyActionToTenantOverride(tenantId, action, decision.affectedLanguages)) {
      shouldPage = true;
    }
  }

  // 3) Page the operator (non-fatal) if any action requested it.
  if (shouldPage) {
    await pageOperator(tenantId, decision, snapshot);
  }
}

/**
 * Apply a single action to this tenant's override entry (read-merge-write, scoped
 * by tenantId). Returns true iff the action is `page_operator` (so the caller can
 * page once). `keep_current_mode` is a no-op. KILL-SWITCH PRECEDENCE: the entry
 * may only DEMOTE — `mode` is only ever set to 'shadow', never promoted.
 */
function applyActionToTenantOverride(
  tenantId: string,
  action: ChatCoreV2AutoRevertAction,
  affectedLanguages: string[],
): boolean {
  switch (action) {
    case 'flip_global_to_shadow': {
      // Renamed-in-intent to "flip THIS tenant to shadow" (§5.J): scoped to the
      // tenantId, never process-global.
      const next: ChatCoreV2TenantOverride = {
        ...(getChatCoreV2RuntimeOverride(tenantId) ?? {}),
        mode: 'shadow',
      };
      setChatCoreV2RuntimeOverride(tenantId, next);
      return false;
    }
    case 'pin_planner_to_repair_only': {
      const next: ChatCoreV2TenantOverride = {
        ...(getChatCoreV2RuntimeOverride(tenantId) ?? {}),
        plannerPinnedToRepairOnly: true,
      };
      setChatCoreV2RuntimeOverride(tenantId, next);
      return false;
    }
    case 'flip_language_to_shadow': {
      const existing = getChatCoreV2RuntimeOverride(tenantId) ?? {};
      const merged = new Set<string>(existing.languageShadow ?? []);
      for (const language of affectedLanguages) {
        if (typeof language === 'string' && language.length > 0) merged.add(language);
      }
      const next: ChatCoreV2TenantOverride = {
        ...existing,
        languageShadow: [...merged],
      };
      setChatCoreV2RuntimeOverride(tenantId, next);
      return false;
    }
    case 'page_operator':
      return true;
    case 'keep_current_mode':
    default:
      return false;
  }
}

/**
 * Persist exactly one decision row. Wrapped in try/catch — a DB failure is logged
 * (token only, no raw tenant id) and swallowed so the valve never blocks.
 */
function persistAutoRevertDecision(
  tenantId: string,
  decision: ChatCoreV2AutoRevertDecision,
  snapshot: ChatCoreV2AutoRevertMetricsSnapshot,
  db?: Database.Database,
): void {
  try {
    const handle = db ?? getDb();
    handle
      .prepare(
        `INSERT INTO chat_v2_auto_revert_decisions
           (tenant_id, actions_json, affected_languages_json, reason_codes_json, metrics_snapshot_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        JSON.stringify(decision.actions),
        JSON.stringify(decision.affectedLanguages),
        JSON.stringify(decision.reasonCodes),
        JSON.stringify(snapshot),
      );
  } catch (err) {
    // Non-blocking: a persistence failure must not stop the Map mutation or the
    // pager, and must never crash the cron. No raw tenant id in the log.
    logger.warn(
      {
        event: 'chat_core_v2_auto_revert_persist_failed',
        tenantToken: opaqueTenantToken(tenantId),
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 auto-revert decision persistence failed (non-blocking)',
    );
  }
}

/**
 * Fire a single operator page via `CHAT_CORE_V2_PAGER_WEBHOOK_URL`. NON-FATAL by
 * contract: returns without throwing on an absent / non-https URL, a non-2xx
 * response, a network error, or a 5s `AbortController` timeout. The payload
 * carries ONLY safe scalars + decision enums + an opaque tenant token — never a
 * raw tenant id, raw message text, or any PII.
 */
async function pageOperator(
  tenantId: string,
  decision: ChatCoreV2AutoRevertDecision,
  snapshot: ChatCoreV2AutoRevertMetricsSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const rawUrl = String(env.CHAT_CORE_V2_PAGER_WEBHOOK_URL ?? '').trim();
    if (!rawUrl) return; // absent — non-fatal no-op.

    // https-only guard: refuse to page over a non-https endpoint.
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:') return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    try {
      const res = await fetch(rawUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'chat_core_v2_auto_revert_page',
          version: CHAT_CORE_V2_AUTO_REVERT_EXECUTOR_VERSION,
          // No raw tenant id in the pager payload — opaque token only.
          tenantToken: opaqueTenantToken(tenantId),
          actions: decision.actions,
          reasonCodes: decision.reasonCodes,
          affectedLanguageCount: decision.affectedLanguages.length,
          metrics: snapshot,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          {
            event: 'chat_core_v2_auto_revert_page_non_2xx',
            tenantToken: opaqueTenantToken(tenantId),
            status: res.status,
          },
          'Chat Core v2 auto-revert pager returned non-2xx (non-fatal)',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // AbortError / network error / anything else — non-fatal.
    logger.warn(
      {
        event: 'chat_core_v2_auto_revert_page_failed',
        tenantToken: opaqueTenantToken(tenantId),
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 auto-revert pager failed (non-fatal)',
    );
  }
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Opaque, non-reversible token for a tenant id, used ONLY in logs / the pager
 * payload so the raw id never leaks (mirrors the per-tenant handling in
 * `scheduler.ts`). The DB row's `tenant_id` column legitimately stores the raw id
 * (it is the per-tenant audit key, per the schema contract); logs/pager do not.
 */
function opaqueTenantToken(tenantId: string, env: NodeJS.ProcessEnv = process.env): string {
  const salt =
    env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET ||
    env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET ||
    env.CLASSIFY_SHADOW_HASH_SECRET ||
    'chat_core_v2_auto_revert_executor_token_salt@1';
  return createHash('sha256').update(`${salt}:tenant:${tenantId}`).digest('hex').slice(0, 16);
}
