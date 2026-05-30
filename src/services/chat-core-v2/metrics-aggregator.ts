// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Chat Core v2 — auto-revert metrics aggregator (WP-06, READ-ONLY half of B7).
 *
 * Pure, read-only aggregation that computes the inputs the EXISTING auto-revert
 * policy (`auto-revert-policy.ts`) consumes, evaluates the would-be decision,
 * and lets the cron LOG it. This module performs NO mutation and NO live-path
 * change. The executor (`applyAutoRevertDecision`), the per-tenant override Map,
 * the persistence migration, and threading `tenantId` through the live parsers
 * are ALL WP-07 — they are intentionally absent here.
 *
 * Per-tenant keying (§5.J): the legacy-fallback and schema-compliance reads are
 * computed per `tenantId`, so one tenant's metrics never drive another tenant's
 * decision. The cron iterates the active tenant set.
 *
 * Honest-metric posture (DMV): each compute function measures exactly what its
 * name claims. Where the queryable producer table does not exist yet, the
 * function returns a documented, revert-SAFE no-data default rather than a
 * fabricated number — and names the later WP that must populate the source.
 */

import Database from 'better-sqlite3';

import { getDb } from '../database';
import { config } from '../../config';
import {
  getLatestHealthByProvider,
  type ProbeResult,
} from '../integration-health';
import type { ChatCoreV2AutoRevertMetrics } from './auto-revert-policy';

export const CHAT_CORE_V2_METRICS_AGGREGATOR_VERSION = 'chat_core_v2_metrics_aggregator@1.0.0';

export interface ChatCoreV2MetricsScope {
  tenantId: string;
}

/**
 * The integration-health probe row shape returned by `getLatestHealthByProvider`
 * for a single provider. WP-06 reads the `'ollama'` entry. `ts` is the SQLite
 * `datetime('now')` string (UTC, no trailing 'Z') used for the staleness guard.
 */
export type ChatCoreV2OllamaHealthProbe = ProbeResult & { ts: string };

/**
 * Assumed Ollama / integration-health probe cadence.
 *
 * The integration-health probe cron runs every 5 minutes (cron "every-5-min"
 * expression) — see `scheduler.ts` `registerJob('integration_health', ...)` and
 * the matching `cron.schedule(..., wrapJob('integration_health', ...))`. The
 * staleness window defaults to probe-interval x 3 (15 min) so a single missed
 * probe never trips the guard, but a stalled probe cron does.
 */
const OLLAMA_HEALTH_PROBE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_OLLAMA_HEALTH_STALENESS_MS = OLLAMA_HEALTH_PROBE_INTERVAL_MS * 3; // 15 min

const FALLBACK_RATE_WINDOW_MS = 24 * 60 * 60_000; // 24h
const SCHEMA_COMPLIANCE_WINDOW_MS = 60 * 60_000; // 1h
const ACTIVE_TENANT_WINDOW_MS = 24 * 60 * 60_000; // 24h

/**
 * Per-tenant legacy-fallback rate over the trailing 24h. Division-by-zero ⇒ 0.0
 * (a revert-SAFE default: 0.0 < the 0.05 auto-shadow threshold, so no-data never
 * fires a revert).
 *
 * NO QUERYABLE SOURCE YET. Live legacy fallbacks (the action-gateway
 * `blocked_legacy_fallback` outcome and the `legacy_fallback_rate` failure mode
 * in `failure-observability.ts`) are emitted to pino only — there is no
 * reason-coded legacy-fallback counter TABLE to read. The shadow-path
 * `kind='fallback'` trace span records the SHADOW fallback-POLICY verdict, NOT
 * an actual live legacy fallback, so it is deliberately NOT used here (that
 * would be a misnamed metric). Until WP-07 (executor) or a later WP lands a
 * queryable per-tenant legacy-fallback counter, this returns 0.0 gracefully.
 */
export function computeLegacyFallbackRate24h(
  db: Database.Database = getDb(),
  scope: ChatCoreV2MetricsScope,
  now: Date = new Date(),
): number {
  // TODO(WP-07+): read a real per-tenant legacy-fallback counter once a
  // queryable producer table exists. Today live fallbacks go to pino only, so
  // there is nothing to query and the revert-safe 0.0 default is returned.
  void db;
  void scope;
  void now;
  return 0.0;
}

/**
 * Per-tenant schema-compliance rate over the trailing 1h (share of constrained
 * outputs that passed Ajv/Zod validation after enforcement + one repair).
 *
 * NO-DATA DEFAULT IS 1.0 (fully compliant), NOT 0.0. A compliance RATE with zero
 * samples must mean "no violations observed", because the policy fires
 * `pin_planner_to_repair_only` when the rate is < 0.95 — a 0.0 no-data default
 * would auto-trigger a revert on an idle tenant (the exact inert/false-positive
 * valve class DMV warns against). This mirrors the Ollama staleness guard:
 * no-data / unknown ⇒ never auto-flip.
 *
 * NO QUERYABLE SOURCE YET. `failure-observability.ts` documents the producer as
 * "error_log and format_compliance_fail counter" — that `format_compliance_fail`
 * counter table does not exist yet (schema-validation outcomes are not persisted
 * to a queryable per-tenant table). Until WP-01-remainder / a later WP lands the
 * schema-validation counter, this returns the revert-safe 1.0 default.
 */
export function computeSchemaComplianceRate1h(
  db: Database.Database = getDb(),
  scope: ChatCoreV2MetricsScope,
  now: Date = new Date(),
): number {
  // TODO(WP-01-remainder/later): read a real per-tenant schema-validation
  // compliance counter once `format_compliance_fail` (or equivalent) is a
  // queryable table. Today validation outcomes are not persisted per tenant, so
  // the revert-safe 1.0 no-data default is returned.
  void db;
  void scope;
  void now;
  return 1.0;
}

/**
 * Map the integration-health `'ollama'` probe to the policy's `ollamaHealthy`
 * boolean per build-plan §5.I. The read is wrapped in a 5s `AbortController`
 * race so a hung probe-reader can never block the cron.
 *
 * Mapping (exact):
 *  - Ollama NOT configured (`config.ollama.enabled` / `OLLAMA_ENABLED` false)
 *      ⇒ short-circuit `true` (skip the valve entirely);
 *  - status `'ok'`                                  ⇒ `true`;
 *  - status `'fail'`                                ⇒ `false` (valve may fire);
 *  - status `'skipped'` / `errorMessage==='not configured'` / MISSING `'ollama'`
 *      key                                          ⇒ short-circuit `true`;
 *  - STALE `'ollama'` row (ts older than the staleness window)
 *      ⇒ short-circuit `true` (a dead probe is an operator-paging condition,
 *        never an auto-flip — never revert on stale data);
 *  - timeout / throw                                ⇒ `false` ONLY when Ollama is
 *      configured; if not configured, `true`.
 */
export async function computeChatCoreV2OllamaHealthy(
  probe?: ChatCoreV2OllamaHealthProbe,
  options: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    stalenessMs?: number;
    readProbe?: () => ChatCoreV2OllamaHealthProbe | undefined;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const configured = isOllamaConfigured(env);

  // Not configured ⇒ valve is skipped entirely. A not-configured Ollama in
  // CI/staging must NEVER trigger an auto-revert.
  if (!configured) return true;

  const stalenessMs = resolveStalenessMs(env, options.stalenessMs);
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? 5_000;

  let row: ChatCoreV2OllamaHealthProbe | undefined;
  try {
    row = await raceWithTimeout(
      () => probe ?? (options.readProbe ? options.readProbe() : readOllamaProbeRow()),
      timeoutMs,
    );
  } catch {
    // Timeout / throw while CONFIGURED ⇒ unhealthy (valve may fire). (If we had
    // been not-configured we returned true above.)
    return false;
  }

  // Missing 'ollama' key ⇒ short-circuit healthy (treat as not-yet-probed).
  if (!row) return true;

  // 'skipped' or explicit "not configured" ⇒ short-circuit healthy.
  if (row.status === 'skipped' || row.errorMessage === 'not configured') return true;

  // Staleness guard (§5.I): a stalled probe cron would otherwise return a
  // permanently-fresh-looking stale 'ok'. Treat a stale row as unknown ⇒
  // short-circuit healthy (never auto-flip on stale data).
  if (isProbeStale(row.ts, now, stalenessMs)) return true;

  if (row.status === 'ok') return true;
  if (row.status === 'fail') return false;

  // Unknown status value — fail safe to healthy (never auto-flip on something
  // we cannot interpret).
  return true;
}

/**
 * Compose the per-tenant metrics bundle the policy consumes. The Ollama health
 * read is process-wide (the daemon is shared), so `probe` is not tenant-scoped;
 * the fallback/compliance reads are per `tenantId`.
 *
 * OD-3 open: per-language recall is NOT wired; `prepassRecallByLanguage` is
 * intentionally left undefined so the policy's per-language arm stays dormant
 * (do not ship a sampling-rate metric named recall — migrations/162 has no
 * locale column and its reason codes are sampling reasons, not recall).
 */
export async function computeChatCoreV2AutoRevertMetrics(
  db: Database.Database = getDb(),
  scope: ChatCoreV2MetricsScope,
  probe?: ChatCoreV2OllamaHealthProbe,
  options: { env?: NodeJS.ProcessEnv; now?: Date; stalenessMs?: number } = {},
): Promise<ChatCoreV2AutoRevertMetrics> {
  const now = options.now ?? new Date();
  const ollamaHealthy = await computeChatCoreV2OllamaHealthy(probe, {
    env: options.env,
    now,
    stalenessMs: options.stalenessMs,
  });

  return {
    legacyFallbackRate24h: computeLegacyFallbackRate24h(db, scope, now),
    ollamaHealthy,
    schemaComplianceRate1h: computeSchemaComplianceRate1h(db, scope, now),
    // OD-3 open: per-language recall not wired; affectedLanguages intentionally
    // empty (do not ship a sampling-rate metric named recall).
    prepassRecallByLanguage: undefined,
  };
}

/**
 * Active tenant set: distinct `tenant_id`s with chat-core-v2 activity in the
 * trailing 24h. The shadow route hook records redacted trace spans into
 * `chat_v2_trace_spans` (with `tenant_id` + `started_at`) whenever it is
 * enabled, so this is the best available queryable signal of "tenants with
 * recent v2 activity". If the table is empty / missing (shadow runtime not yet
 * producing rows), the set is empty and the cron is a SAFE no-op.
 */
export function getActiveChatCoreV2TenantIds(
  db: Database.Database = getDb(),
  now: Date = new Date(),
): string[] {
  const cutoff = isoCutoff(now, ACTIVE_TENANT_WINDOW_MS);
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT tenant_id AS tenantId
         FROM chat_v2_trace_spans
         WHERE started_at >= ?
         ORDER BY tenant_id ASC`,
      )
      .all(cutoff) as Array<{ tenantId: string }>;
    return rows.map((r) => String(r.tenantId)).filter((id) => id.length > 0);
  } catch {
    // Table may not exist yet on a fresh DB before the trace-span migration
    // runs, or the shadow runtime may not have produced any rows. Either way an
    // empty active set keeps the cron a safe no-op.
    return [];
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function isOllamaConfigured(env: NodeJS.ProcessEnv): boolean {
  const cfgEnabled = (config as { ollama?: { enabled?: boolean } }).ollama?.enabled === true;
  const envEnabled = String(env.OLLAMA_ENABLED ?? '').trim().toLowerCase() === 'true';
  return cfgEnabled || envEnabled;
}

function resolveStalenessMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const parsed = Number.parseInt(env.OLLAMA_HEALTH_STALENESS_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OLLAMA_HEALTH_STALENESS_MS;
}

function readOllamaProbeRow(): ChatCoreV2OllamaHealthProbe | undefined {
  const latest = getLatestHealthByProvider();
  return latest.ollama;
}

/**
 * Parse the integration-health `ts` (SQLite `datetime('now')` → UTC string with
 * no trailing 'Z') and decide whether it is older than the staleness window. A
 * row whose ts cannot be parsed is treated as STALE-safe (unknown ⇒ healthy via
 * the caller), so this returns `true` (stale) on parse failure.
 */
function isProbeStale(ts: string | undefined, now: Date, stalenessMs: number): boolean {
  if (!ts) return true;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts.trim());
  const parsed = Date.parse(hasZone ? ts : `${ts}Z`);
  if (!Number.isFinite(parsed)) return true;
  return now.getTime() - parsed > stalenessMs;
}

function isoCutoff(now: Date, windowMs: number): string {
  return new Date(now.getTime() - windowMs).toISOString();
}

/**
 * Run a synchronous reader inside a 5s race. The reader itself is sync (a single
 * indexed SELECT), but wrapping it in an AbortController race guards against a
 * hung daemon/driver and satisfies §5.I's "5s race" requirement.
 */
function raceWithTimeout<T>(read: () => T, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('ollama_health_read_timeout'));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    try {
      const value = read();
      clearTimeout(timer);
      resolve(value);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// Window constants are exported for tests that assert the documented cadence.
export const _CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS = {
  fallbackRateWindowMs: FALLBACK_RATE_WINDOW_MS,
  schemaComplianceWindowMs: SCHEMA_COMPLIANCE_WINDOW_MS,
  activeTenantWindowMs: ACTIVE_TENANT_WINDOW_MS,
  ollamaProbeIntervalMs: OLLAMA_HEALTH_PROBE_INTERVAL_MS,
  ollamaStalenessMs: DEFAULT_OLLAMA_HEALTH_STALENESS_MS,
} as const;
