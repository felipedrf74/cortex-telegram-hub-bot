// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Week-level reflow service — slice C6 of the Week-Level Adaptability
 * + Periodization plan (v2.1).
 *
 * Powers `POST /api/v1/training/week/:weekId/reflow`. Two modes:
 *
 *   - 'preview': observation-only. Returns the WOULD-BE adapted
 *     shape without mutating any session. Writes an optional ledger
 *     row with scope='preview' and adaptation_revision=NULL.
 *
 *   - 'apply': mutating. Single transaction; bumps adaptation_revision;
 *     writes exactly one ledger row; runs the caller-supplied
 *     `applyMutation` callback to mutate session rows; requires an
 *     `idempotencyKey` for 24h deduplication (per v2.1 contract).
 *
 * Composition:
 *   - A0/A0b adaptation ledger (recordAdaptation / recordPreviewAdaptation
 *     / findAdaptationByIdempotencyKey).
 *   - `applyMutation` callback — caller-owned function that mutates
 *     training_sessions / training_weeks for the actual reflow.
 *     Runs inside the same transaction that bumps the revision so
 *     "row mutated AND revision recorded" or "neither" — never half.
 *
 * Idempotency: 'apply' mode REQUIRES an idempotencyKey (Codex P1 fix).
 * Duplicate keys within the 24h ledger lookup window collapse onto
 * the existing row with mutated=false. The A0b layer's
 * UNIQUE(plan_id, idempotency_key) backstops races.
 */

import { logger } from '../utils/logger';
import {
  AdaptationPlanNotFoundError,
  findAdaptationByIdempotencyKey,
  recordAdaptation,
  recordPreviewAdaptation,
  type RecordAdaptationResult,
} from './training-plan-adaptations';
import { getDb } from './database';

export type ReflowMode = 'preview' | 'apply';

export interface ReflowInput {
  planId: number;
  weekId: number;
  mode: ReflowMode;
  /** Free-form trigger discriminator (e.g., 'manual_reflow', 'missed_session'). */
  trigger: string;
  /** Sessions the user wants preserved (never moved or dropped). */
  sessionsToPreserve?: number[];
  /**
   * Required for `mode='apply'` (per v2.1 contract: 24h dedup
   * window). Optional for 'preview'. apply-mode calls without a key
   * throw to make the contract violation loud.
   */
  idempotencyKey?: string;
  /** Science policy version stamped on the ledger row. */
  sciencePolicyVersion: string;
  /** Snapshot of feature flags relevant to this reflow. */
  featureFlagSnapshot?: Record<string, unknown>;
  /**
   * Caller-computed before/after patch. Engines (C8) compute the
   * actual reflow plan; this module persists it.
   */
  beforePatch?: unknown;
  afterPatch?: unknown;
  /** Decision reasons emitted by the engine. */
  decisionReasonCodes?: readonly string[];
  actor?: 'system' | 'user' | 'admin';
  /**
   * Caller-supplied mutation callback. Runs inside the SAME
   * transaction as the revision bump + ledger insert, so the
   * mutation is atomically tied to the ledger row.
   *
   * Callback contract (R8 P0-1):
   *   - Bare `number` return: legacy shape — reports mutated row
   *     count only, nothing is merged into the ledger's afterPatch.
   *   - `ApplyMutationResult` object: lets the caller report
   *     `mutatedRows` AND attach per-action detail
   *     (`perActionResults`) that executeWeekReflow merges into the
   *     ledger row's afterPatch BEFORE recordAdaptation persists it.
   *
   * The structured return shape replaces the prior closure-over-let
   * + getter pattern in route handlers. That pattern worked only
   * because applyTxn ran applyMutation before recordAdaptation read
   * the getter; a future reorder would silently serialize an empty
   * array into the audit row. The explicit channel removes the
   * ordering dependency.
   */
  applyMutation?: (db: import('better-sqlite3').Database) => ApplyMutationResult;
}

/**
 * R8 P0-1 — discriminated return shape for applyMutation. The
 * legacy `number` return remains valid (no afterPatch merge).
 * Callers that want per-action detail in the ledger should return
 * the object form.
 */
export type ApplyMutationResult =
  | number
  | {
      mutatedRows: number;
      /**
       * Per-action breakdown merged into the ledger row's
       * afterPatch as `perActionResults`. Opaque to executeWeekReflow.
       */
      perActionResults?: unknown;
    };

export interface ReflowResult {
  mode: ReflowMode;
  adaptationId: number;
  adaptationRevision: number | null;
  alreadyExisted: boolean;
  /**
   * True only when apply mode ran the `applyMutation` callback AND
   * the callback reported ≥1 mutated row. Codex P1 contract fix —
   * a ledger row alone is not "mutation".
   */
  mutated: boolean;
  /** Number of session rows the apply callback mutated. */
  mutatedRows: number;
  /**
   * R8 P0-1 — per-action detail returned by the apply callback,
   * surfaced so route handlers can render it on the response without
   * needing to capture it via outer-scope `let` mutation. Undefined
   * when `applyMutation` returned a bare number, was absent, or
   * returned no `perActionResults`.
   */
  perActionResults?: unknown;
}

/**
 * Sentinel thrown when apply mode is invoked without an
 * idempotencyKey. Codex P1: contract violation, surfaced loudly.
 */
export class ReflowMissingIdempotencyKeyError extends Error {
  constructor() {
    super(
      "executeWeekReflow: 'apply' mode requires an idempotencyKey " +
      'per the 24h dedup contract.',
    );
    this.name = 'ReflowMissingIdempotencyKeyError';
  }
}

/**
 * Execute a week-level reflow.
 *
 * Preview path:
 *   - Calls `recordPreviewAdaptation` (no revision bump).
 *   - Returns `mutated: false, mutatedRows: 0, adaptationRevision: null`.
 *
 * Apply path:
 *   - REQUIRES `idempotencyKey` (Codex P1 — contract enforcement).
 *   - Pre-checks for existing row; returns existing with mutated=false on hit.
 *   - Inside ONE transaction: bumps revision + writes ledger row +
 *     runs `applyMutation` callback. Throws roll the entire
 *     transaction back.
 *   - `mutated=true` only when the callback reported ≥1 row changed.
 *     A ledger-row-only success counts as `mutated=false`.
 */
export function executeWeekReflow(input: ReflowInput): ReflowResult {
  const db = getDb();

  // Validate plan + week existence.
  const week = db.prepare(`
    SELECT id, plan_id FROM training_weeks WHERE id = ? AND plan_id = ?
  `).get(input.weekId, input.planId) as { id: number; plan_id: number } | undefined;
  if (!week) {
    throw new Error(`Week ${input.weekId} not found on plan ${input.planId}`);
  }

  // R8 P3 fix — normalize the idempotency key at the service
  // boundary so direct callers (tests, background jobs, future
  // skill wiring) can't bypass the route-layer trim that R7 P2
  // added. The route already trims; this guarantees the contract
  // even when the route is bypassed.
  //
  //   - Strip whitespace.
  //   - Treat empty / whitespace-only as missing (`undefined`).
  //   - Apply this BEFORE the existing required-key check so
  //     `'  '` lands in the same error path as the missing case.
  //
  // Preview keeps the key optional (preview rows ignore dedup),
  // but we still trim/normalize when present so a non-empty
  // preview key stays consistent with how apply would store it.
  const normalizedKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : undefined;
  const idempotencyKey =
    normalizedKey && normalizedKey.length > 0 ? normalizedKey : undefined;

  if (input.mode === 'preview') {
    const result = recordPreviewAdaptation({
      planId: input.planId,
      triggerType: input.trigger,
      triggerPayload: {
        weekId: input.weekId,
        sessionsToPreserve: input.sessionsToPreserve ?? [],
      },
      afterPatch: input.afterPatch,
      decisionReasonCodes: input.decisionReasonCodes,
      sciencePolicyVersion: input.sciencePolicyVersion,
      featureFlagSnapshot: input.featureFlagSnapshot,
      actor: input.actor ?? 'user',
    });
    return {
      mode: 'preview',
      adaptationId: result.adaptationId,
      adaptationRevision: null,
      alreadyExisted: false,
      mutated: false,
      mutatedRows: 0,
    };
  }

  // Apply mode: REQUIRE idempotency key (Codex P1 contract).
  // R8 P3 — the normalized key is now the source of truth, so the
  // original input value is intentionally ignored after this point.
  if (idempotencyKey === undefined) {
    throw new ReflowMissingIdempotencyKeyError();
  }

  // Apply mode: check idempotency dedup using the NORMALIZED key
  // so a future caller sending `"  k  "` matches a stored `"k"`.
  const existing = findAdaptationByIdempotencyKey(input.planId, idempotencyKey);
  if (existing) {
    logger.info(
      { planId: input.planId, weekId: input.weekId, idempotencyKey },
      'week_reflow.idempotency_hit',
    );
    return {
      mode: 'apply',
      adaptationId: existing.id,
      adaptationRevision: existing.adaptation_revision,
      alreadyExisted: true,
      mutated: false,
      mutatedRows: 0,
    };
  }

  // Apply mode: run mutation + ledger inside a single transaction.
  // `recordAdaptation` already wraps its bump+insert in a
  // transaction; we extend that scope by invoking `applyMutation`
  // within the same db.transaction closure.
  let result: RecordAdaptationResult;
  let mutatedRows = 0;
  let capturedPerActionResults: unknown = undefined;

  const applyTxn = db.transaction((): RecordAdaptationResult => {
    // 1. Run the caller's mutation (if any). R8 P0-1 — the callback
    //    may return a bare number (legacy) OR the structured shape.
    //    We capture perActionResults locally so the ledger merge
    //    below has an explicit input rather than reaching for a
    //    closure variable in the caller's scope.
    if (input.applyMutation) {
      const mr = input.applyMutation(db);
      if (typeof mr === 'number') {
        mutatedRows = Math.max(0, mr);
      } else {
        mutatedRows = Math.max(0, mr.mutatedRows);
        if (mr.perActionResults !== undefined) {
          capturedPerActionResults = mr.perActionResults;
        }
      }
    }
    // R8 P0-1 — merge perActionResults into afterPatch BEFORE
    // recordAdaptation reads it. This removes the prior dependency
    // on a getter that closed over an outer `let` in the caller's
    // scope; the merge happens here, in one place, with an explicit
    // value not subject to txn-callback reordering.
    const mergedAfterPatch =
      capturedPerActionResults !== undefined && typeof input.afterPatch === 'object' && input.afterPatch !== null
        ? { ...(input.afterPatch as Record<string, unknown>), perActionResults: capturedPerActionResults }
        : input.afterPatch;
    // 2. Bump revision + write ledger row inside the SAME transaction.
    //    (recordAdaptation uses db.transaction internally, but
    //    better-sqlite3 nests transactions as savepoints so this is
    //    safe.)
    return recordAdaptation({
      planId: input.planId,
      scope: 'week',
      triggerType: input.trigger,
      triggerPayload: {
        weekId: input.weekId,
        sessionsToPreserve: input.sessionsToPreserve ?? [],
        mutatedRows,
      },
      beforePatch: input.beforePatch,
      afterPatch: mergedAfterPatch,
      decisionReasonCodes: input.decisionReasonCodes,
      sciencePolicyVersion: input.sciencePolicyVersion,
      featureFlagSnapshot: input.featureFlagSnapshot,
      // R8 P3 — write the trimmed/normalized key so the stored
      // value matches what the dedup lookup above would see on a
      // retry.
      idempotencyKey,
      actor: input.actor ?? 'user',
    });
  });

  try {
    result = applyTxn();
  } catch (err) {
    // R8 P2-7 — the prior `if (instanceof X) throw; throw;` shape
    // was a tautological pass-through; the catch existed only to
    // satisfy a now-removed branch. Replace with a logger.error
    // for non-AdaptationPlanNotFoundError throws so rolled-back
    // apply transactions are observable in SRE dashboards.
    if (!(err instanceof AdaptationPlanNotFoundError)) {
      logger.error(
        {
          err,
          planId: input.planId,
          weekId: input.weekId,
          idempotencyKey,
          mode: input.mode,
        },
        'week_reflow.transaction_rolled_back',
      );
    }
    throw err;
  }

  return {
    mode: 'apply',
    adaptationId: result.adaptationId,
    adaptationRevision: result.adaptationRevision,
    alreadyExisted: result.alreadyExisted,
    // Codex P1: mutated is true only when applyMutation reported ≥1 row.
    mutated: mutatedRows > 0 && !result.alreadyExisted,
    mutatedRows,
    perActionResults: capturedPerActionResults,
  };
}
