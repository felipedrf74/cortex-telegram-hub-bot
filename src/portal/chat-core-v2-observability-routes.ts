// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-12 — admin-scoped portal observability surface for Chat Core v2.
 *
 * Exposes four operator-only endpoints that read the privacy-safe Chat Core v2
 * telemetry tables and a write-risk human-review resolution action:
 *
 *   GET  …/auto-revert-decisions  — the per-tenant auto-revert ledger (WP-07,
 *                                    migration 173). Surfaces `tenant_id` (the
 *                                    per-tenant audit key) plus safe-scalar
 *                                    decision fields for the admin grid.
 *   GET  …/failure-events         — failed trace spans (status='failed',
 *                                    migration 161). PRIVACY: `attributes_json`
 *                                    is NEVER selected, and `redacted_summary`
 *                                    is run through a whitelist scrubber because
 *                                    failure summaries carry the most
 *                                    diagnostic / least-redacted content.
 *   GET  …/eval-samples           — sampled online-eval references
 *                                    (status='sampled', migration 162).
 *                                    PRIVACY: `metadata_json` is NEVER selected.
 *   POST …/human-reviews/:id/decide — resolves a WP-10 write-risk human review
 *                                    via the REAL `decideChatV2HumanReview`
 *                                    store export (the resolution consumer the
 *                                    WP-10 queue + WP-08 expiry sweep need).
 *
 * Default-off: every route is registered ONLY when
 * `resolveChatCoreV2ActivationConfig(process.env).mode !== 'off'` — a SINGLE
 * canonical parser, never an inline `toLowerCase().trim()` (§5.A). When the
 * orchestrator is off the routes are absent and a request 404s (Express
 * default), so the observability surface leaks nothing while the feature is
 * dark.
 *
 * Admin auth: every route is guarded by `requirePortalAdminToken` (operator
 * only), matching the WP-13 gate-readiness route and the other admin-scoped
 * portal routes. The guard runs BEFORE the data handler, so a rejected request
 * never touches the database.
 *
 * Privacy posture (§1.3 / §5.J): responses carry ONLY counts / enums / hashes /
 * safe scalars + `tenant_id` (the per-tenant audit key). No message text, user
 * input, prompt fragments, provider payloads, `attributes_json`, or
 * `metadata_json` are ever projected. The GET reads select an explicit column
 * whitelist (never `SELECT *`), so the JSON-blob columns are not even read out
 * of SQLite.
 *
 * Graceful no-such-table: each read is wrapped so a missing table (fresh DB,
 * migrations not yet applied) yields a 200 honest empty envelope rather than a
 * 500.
 */

import { type Express, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { resolveChatCoreV2ActivationConfig } from '../services/chat-core-v2/activation-flags';
import { decideChatV2HumanReview } from '../services/chat-core-v2/human-review-queue';
import type { HumanReviewDecision } from '../services/chat-core-v2/types';
import { sendPortalInternalError } from './http';

const ROUTE_PREFIX = '/api/v1/internal/chat-core-v2/observability';

export const CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE = `${ROUTE_PREFIX}/auto-revert-decisions`;
export const CHAT_CORE_V2_FAILURE_EVENTS_ROUTE = `${ROUTE_PREFIX}/failure-events`;
export const CHAT_CORE_V2_EVAL_SAMPLES_ROUTE = `${ROUTE_PREFIX}/eval-samples`;
export const CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE = `${ROUTE_PREFIX}/human-reviews/:id/decide`;

/** Hard 200-row cap on every list endpoint (additive, bounded admin grids). */
const MAX_ROWS = 200;

const VALID_DECISIONS: ReadonlySet<HumanReviewDecision> = new Set<HumanReviewDecision>([
  'approve',
  'deny',
  'request_changes',
]);

/**
 * Registers the WP-12 observability routes, but ONLY when the orchestrator mode
 * is not 'off' (default-off). The mode is resolved through the single canonical
 * parser; `env` is injectable for tests. All routes are admin-scoped.
 */
export function registerPortalChatCoreV2ObservabilityRoutes(
  app: Express,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveChatCoreV2ActivationConfig(env).mode === 'off') {
    return;
  }

  app.get(CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE, requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, rows: readAutoRevertDecisions(getDb()) });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Portal request failed',
        'Portal: chat-core-v2 auto-revert decisions request failed',
      );
    }
  });

  app.get(CHAT_CORE_V2_FAILURE_EVENTS_ROUTE, requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, rows: readFailureEvents(getDb()) });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Portal request failed',
        'Portal: chat-core-v2 failure events request failed',
      );
    }
  });

  app.get(CHAT_CORE_V2_EVAL_SAMPLES_ROUTE, requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, rows: readEvalSamples(getDb()) });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Portal request failed',
        'Portal: chat-core-v2 eval samples request failed',
      );
    }
  });

  app.post(CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const reviewId = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
      if (!reviewId) {
        res.status(400).json({ ok: false, error: { code: 'INVALID_REVIEW_ID', message: 'reviewId is required' } });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = body.decision;
      if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision as HumanReviewDecision)) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'INVALID_DECISION',
            message: `decision must be one of: ${[...VALID_DECISIONS].join(', ')}`,
          },
        });
        return;
      }

      const reviewerUserId = typeof body.reviewerUserId === 'string' ? body.reviewerUserId.trim() : '';
      if (!reviewerUserId) {
        res.status(400).json({
          ok: false,
          error: { code: 'INVALID_REVIEWER', message: 'reviewerUserId is required' },
        });
        return;
      }

      const decisionNote = typeof body.decisionNote === 'string' ? body.decisionNote : undefined;

      let updated;
      try {
        updated = decideChatV2HumanReview(
          {
            reviewId,
            reviewerUserId,
            decision: decision as HumanReviewDecision,
            decisionNote,
          },
          getDb(),
        );
      } catch (decisionErr) {
        // Domain errors (not found / not pending / invalid input) are operator
        // mistakes, not server faults — surface a safe 409 without leaking
        // internals or PII.
        res.status(409).json({
          ok: false,
          error: {
            code: 'REVIEW_NOT_RESOLVABLE',
            message: decisionErr instanceof Error ? decisionErr.message : 'Human review could not be resolved',
          },
        });
        return;
      }

      res.json({ ok: true, review: projectHumanReview(updated) });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Portal request failed',
        'Portal: chat-core-v2 human-review decide request failed',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Read projections — explicit column whitelists (never SELECT *), so the
// JSON-blob columns (attributes_json / metadata_json) are never read.
// ---------------------------------------------------------------------------

interface AutoRevertDecisionRow {
  id: number;
  tenantId: string;
  actions: unknown[];
  affectedLanguages: unknown[];
  reasonCodes: unknown[];
  metricsSnapshot: Record<string, unknown>;
  decidedAt: string;
}

/**
 * Auto-revert ledger (WP-07, migration 173). Surfaces `tenant_id` (per-tenant
 * audit key) plus the safe-scalar decision fields. The JSON columns on this
 * table are, by the migration-173 contract, SAFE SCALARS ONLY (no PII), so they
 * are parsed and surfaced for the operator grid. 200-row cap, newest first.
 */
function readAutoRevertDecisions(db: Database.Database): AutoRevertDecisionRow[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT id, tenant_id, actions_json, affected_languages_json,
                reason_codes_json, metrics_snapshot_json, decided_at
         FROM chat_v2_auto_revert_decisions
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(MAX_ROWS) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id),
    tenantId: String(row.tenant_id),
    actions: parseJsonArray(row.actions_json),
    affectedLanguages: parseJsonArray(row.affected_languages_json),
    reasonCodes: parseJsonArray(row.reason_codes_json),
    metricsSnapshot: parseJsonObject(row.metrics_snapshot_json),
    decidedAt: String(row.decided_at),
  }));
}

interface FailureEventRow {
  id: number;
  traceSpanId: string;
  turnId: string;
  tenantId: string;
  kind: string;
  name: string;
  status: string;
  sensitivity: string;
  redactedSummary: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
}

/**
 * Failed trace spans (migration 161, status='failed').
 *
 * PRIVACY (§1.3): `attributes_json` is intentionally absent from the SELECT, so
 * it is never read or projected. Failure spans carry the most diagnostic and
 * least-redacted content, so `redacted_summary` is additionally passed through
 * `scrubFailureSummary` — a whitelist scrubber that keeps only known-safe
 * structured diagnostic tokens (status/kind/error-class identifiers) and drops
 * any free-form text that could be a message fragment. 200-row cap, newest
 * first.
 */
function readFailureEvents(db: Database.Database): FailureEventRow[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT id, trace_span_id, turn_id, tenant_id, kind, name, status,
                sensitivity, redacted_summary, started_at, ended_at, duration_ms
         FROM chat_v2_trace_spans
         WHERE status = 'failed'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(MAX_ROWS) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id),
    traceSpanId: String(row.trace_span_id),
    turnId: String(row.turn_id),
    tenantId: String(row.tenant_id),
    kind: String(row.kind),
    name: String(row.name),
    status: String(row.status),
    sensitivity: String(row.sensitivity),
    redactedSummary: scrubFailureSummary(row.redacted_summary),
    startedAt: String(row.started_at),
    endedAt: stringOrNull(row.ended_at),
    durationMs: Number(row.duration_ms),
  }));
}

interface EvalSampleRow {
  id: number;
  sampleId: string;
  turnId: string;
  tenantId: string;
  routeMethod: string;
  domain: string | null;
  risk: string;
  sensitivity: string;
  reason: string;
  sampleRate: number;
  status: string;
  createdAt: string;
}

/**
 * Sampled online-eval references (migration 162, status='sampled').
 *
 * PRIVACY: `metadata_json` is intentionally absent from the SELECT, so it is
 * never read or projected. Only safe scalars / enums + `tenant_id` are
 * surfaced. 200-row cap, newest first.
 */
function readEvalSamples(db: Database.Database): EvalSampleRow[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT id, sample_id, turn_id, tenant_id, route_method, domain, risk,
                sensitivity, reason, sample_rate, status, created_at
         FROM chat_v2_online_eval_samples
         WHERE status = 'sampled'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(MAX_ROWS) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id),
    sampleId: String(row.sample_id),
    turnId: String(row.turn_id),
    tenantId: String(row.tenant_id),
    routeMethod: String(row.route_method),
    domain: stringOrNull(row.domain),
    risk: String(row.risk),
    sensitivity: String(row.sensitivity),
    reason: String(row.reason),
    sampleRate: Number(row.sample_rate),
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

interface ProjectedHumanReview {
  id: number;
  reviewId: string;
  turnId: string;
  tenantId: string;
  domain: string;
  reason: string;
  status: string;
  sensitivity: string;
  reviewerUserId?: string;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
}

/**
 * Project a resolved human review to SAFE fields only. Notably omits
 * `redactedSummary`, `decisionNote`, `userId`, and the free-form `metadata`
 * object — none of those are needed to confirm a decision and any could carry
 * operator/user text.
 */
function projectHumanReview(record: {
  id: number;
  reviewId: string;
  turnId: string;
  tenantId: string;
  domain: string;
  reason: string;
  status: string;
  sensitivity: string;
  reviewerUserId?: string;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
}): ProjectedHumanReview {
  return {
    id: record.id,
    reviewId: record.reviewId,
    turnId: record.turnId,
    tenantId: record.tenantId,
    domain: record.domain,
    reason: record.reason,
    status: record.status,
    sensitivity: record.sensitivity,
    reviewerUserId: record.reviewerUserId,
    requestedAt: record.requestedAt,
    decidedAt: record.decidedAt,
    expiresAt: record.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Privacy helpers
// ---------------------------------------------------------------------------

/**
 * Whitelist scrubber for a FAILED span's `redacted_summary`.
 *
 * Failure summaries are the highest-risk free-text column in the observability
 * surface: failure paths frequently log diagnostic context (the raw user
 * message, partial provider output, exception messages) that escapes ordinary
 * redaction. Rather than trust the upstream redaction, this scrubber keeps only
 * the structured, machine-shaped diagnostic tokens we explicitly recognise and
 * drops everything else.
 *
 * A token is kept ONLY if it is one of:
 *   1. A structured `key:value` / `key=value` diagnostic token built purely
 *      from `[A-Za-z0-9._-]` segments around a single `:` or `=` separator
 *      (e.g. `status:failed`, `kind:model`, `error_class=ETIMEDOUT`,
 *      `duration_ms=5000`), OR
 *   2. A bare token on the explicit ALLOWLIST of known diagnostic keywords
 *      (e.g. `timeout`, `aborted`).
 *
 * A bare prose word (`divorce`, `salary`, `the`, `user`) is NOT structured and
 * is NOT on the allowlist, so it is dropped — the whitelist is closed, not
 * "anything alphanumeric". Tokens with spaces, sentence punctuation, `@`, `/`,
 * quotes, or that exceed the per-token length cap are dropped as potential
 * message fragments. If nothing survives, a neutral placeholder is returned so
 * the operator still sees the row exists.
 */
export function scrubFailureSummary(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  if (text.length === 0) return '[redacted]';

  // A structured diagnostic token: alphanumeric/._- segments around exactly
  // one ':' or '=' separator. This is the only "shape" we trust from a failed
  // span, since structured telemetry keys carry no free-form user text.
  const STRUCTURED_TOKEN = /^[A-Za-z0-9._-]+[:=][A-Za-z0-9._-]+$/;
  // A closed allowlist of bare diagnostic keywords with no PII risk.
  const BARE_KEYWORD_ALLOWLIST: ReadonlySet<string> = new Set([
    'timeout',
    'timed_out',
    'aborted',
    'cancelled',
    'canceled',
    'rejected',
    'failed',
    'error',
    'unavailable',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'throttled',
    'overloaded',
    'invalid',
    'unsupported',
    'blocked',
  ]);
  const MAX_TOKEN_LEN = 48;
  const MAX_TOKENS = 12;

  const safeTokens = text
    .split(/\s+/)
    .filter((token) => {
      if (token.length === 0 || token.length > MAX_TOKEN_LEN) return false;
      if (STRUCTURED_TOKEN.test(token)) return true;
      return BARE_KEYWORD_ALLOWLIST.has(token.toLowerCase());
    })
    .slice(0, MAX_TOKENS);

  if (safeTokens.length === 0) return '[redacted]';
  return safeTokens.join(' ');
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
