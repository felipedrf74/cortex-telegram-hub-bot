// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Adaptation ledger — slice A0b of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Audit substrate for every adaptive change to a training plan. Each
 * call to `recordAdaptation()` writes EXACTLY ONE row capturing what
 * triggered the adaptation, what the plan looked like before, what it
 * looks like after, which science-policy version was active, which
 * feature flags were on, and which decision-reason codes were emitted.
 *
 * Hard invariants:
 *
 *   1. Every `adaptation_revision` bump on `fitness_training_plans`
 *      has exactly ONE ledger row. Enforced by:
 *        - `UNIQUE(plan_id, adaptation_revision)` partial index (DB
 *          backstop); and
 *        - the `recordAdaptation` transaction that wraps the bump +
 *          insert in a single BEGIN/COMMIT.
 *
 *   2. Adaptive writes are atomic. A crash mid-flow either leaves both
 *      the counter bumped AND the row written, or neither — never a
 *      half-applied state.
 *
 *   3. Preview/explanation-only rows DO NOT bump the counter. Use
 *      `recordPreviewAdaptation` for those; they write a row with
 *      `scope = 'preview'` and `adaptation_revision = NULL`.
 *
 *   4. Rollback is append-only. `rollbackAdaptation(id)` does not
 *      delete the original row; it inserts a NEW row that reverses the
 *      patch, sets `rollback_of_adaptation_id` to the original's id,
 *      and bumps the revision. Rollback is allowed ONLY when the
 *      original is the latest revision (optimistic lock) — newer
 *      revisions block rollback until they themselves are rolled back.
 *
 *   5. Idempotency: when a caller supplies `idempotencyKey`, duplicate
 *      requests with the same `(plan_id, idempotency_key)` collapse to
 *      the existing row. The DB-level `UNIQUE(plan_id,
 *      idempotency_key)` partial index backstops a pre-check race.
 *
 *   6. Privacy: rows whose `trigger_payload_json` contains
 *      health-sensitive data may be read with a `ViewerRole` argument
 *      that redacts the payload for non-admin viewers. The raw payload
 *      is always preserved on disk for owner queries + audit.
 *
 * This module owns the ledger primitive. The orchestration — when to
 * record what — lives in the slices that call into it: B5 (deload),
 * B7 (taper), C6 (week reflow), C8 (scenario classifier), and the
 * privacy/consent slice A4p (redaction policy).
 */

import type Database from 'better-sqlite3';

import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  getAdaptationRevision,
  incrementAdaptationRevision,
} from './training-plan-lifecycle';

export type AdaptationScope = 'plan' | 'week' | 'session' | 'preview';
export type AdaptationActor = 'system' | 'user' | 'admin';

/**
 * Used by readers to opt into payload redaction. Owners + admins see
 * the raw `trigger_payload_json`; support sees the redacted summary
 * (sensitive triggers replaced with a marker that still preserves the
 * trigger type). Per slice A4p (privacy/consent), only the *content*
 * of sensitive payloads is redacted; the existence of the adaptation
 * row is never hidden — that would break support workflows.
 */
export type ViewerRole = 'owner' | 'support' | 'admin';

/**
 * Trigger-type values whose `trigger_payload_json` may contain
 * health-sensitive details (pain location, illness symptoms, RED-S
 * indicators, menstrual status). When read as `ViewerRole = 'support'`,
 * these payloads are replaced with `{ redacted: true, reason: 'health_sensitive' }`.
 *
 * The list lives here (and not on the row) so that adding new
 * trigger types in future slices automatically inherits the redaction
 * rule by classification, not by per-row flagging.
 */
export const HEALTH_SENSITIVE_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'safety_pause',
  'medical_referral',
  'pain_flag',
  'illness_flag',
  'red_s_screening',
  'injury_status',
  'menstrual_symptom',
]);

/**
 * R3 P2 fix — bucketed category used for both user-deletion AND
 * support-view redaction. Replaces the original trigger_type
 * (e.g. 'pain_flag', 'red_s_screening') so non-admin readers and
 * post-deletion records cannot infer which sensitive event type
 * the row recorded.
 */
export const REDACTED_TRIGGER_BUCKET = 'health_sensitive';

export interface AdaptationLedgerRow {
  id: number;
  plan_id: number;
  adaptation_revision: number | null;
  scope: AdaptationScope;
  trigger_type: string;
  trigger_payload_json: string | null;
  before_patch_json: string | null;
  after_patch_json: string | null;
  decision_reason_codes_json: string | null;
  science_policy_version: string;
  feature_flag_snapshot: string | null;
  idempotency_key: string | null;
  rollback_of_adaptation_id: number | null;
  actor: AdaptationActor;
  created_at: string;
}

export interface RecordAdaptationInput {
  planId: number;
  /** 'plan' | 'week' | 'session'. Use `recordPreviewAdaptation` for previews. */
  scope: Exclude<AdaptationScope, 'preview'>;
  triggerType: string;
  triggerPayload?: unknown;
  beforePatch?: unknown;
  afterPatch?: unknown;
  decisionReasonCodes?: readonly string[];
  sciencePolicyVersion: string;
  featureFlagSnapshot?: Record<string, unknown>;
  /** When set, duplicate requests with the same key collapse to one row. */
  idempotencyKey?: string;
  actor?: AdaptationActor;
}

export interface RecordPreviewInput {
  planId: number;
  triggerType: string;
  triggerPayload?: unknown;
  /** Forecast patch — what the adaptation *would* do if applied. */
  afterPatch?: unknown;
  decisionReasonCodes?: readonly string[];
  sciencePolicyVersion: string;
  featureFlagSnapshot?: Record<string, unknown>;
  actor?: AdaptationActor;
}

export interface RecordAdaptationResult {
  /** Inserted (or pre-existing on idempotency collapse) ledger row id. */
  adaptationId: number;
  /** Revision this row records. NULL only for preview rows. */
  adaptationRevision: number | null;
  /** True when an idempotency key collapsed onto a pre-existing row. */
  alreadyExisted: boolean;
}

export interface RollbackInput {
  /** Id of the adaptation row to reverse. Must be the latest revision. */
  adaptationId: number;
  actor?: AdaptationActor;
  /** Optional note appended to the rollback row's trigger_payload_json. */
  reasonNote?: string;
}

export interface RollbackResult {
  /** NEW ledger row id created by the rollback. The original is preserved. */
  rollbackAdaptationId: number;
  /** Revision the NEW row records — one greater than the original's. */
  newAdaptationRevision: number;
}

export class AdaptationPlanNotFoundError extends Error {
  constructor(public readonly planId: number) {
    super(`Plan ${planId} not found`);
    this.name = 'AdaptationPlanNotFoundError';
  }
}

export class AdaptationIdempotencyConflictError extends Error {
  constructor(
    public readonly planId: number,
    public readonly key: string,
  ) {
    super(`Adaptation idempotency conflict for plan ${planId}, key ${key}`);
    this.name = 'AdaptationIdempotencyConflictError';
  }
}

export class AdaptationRollbackNotLatestError extends Error {
  constructor(
    public readonly adaptationId: number,
    public readonly recordedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(
      `Cannot rollback adaptation ${adaptationId}: it recorded revision ` +
      `${recordedRevision} but the plan is currently at ${currentRevision}. ` +
      `Rollback is allowed only for the latest revision.`,
    );
    this.name = 'AdaptationRollbackNotLatestError';
  }
}

export class AdaptationAlreadyRolledBackError extends Error {
  constructor(public readonly adaptationId: number) {
    super(`Adaptation ${adaptationId} has already been rolled back`);
    this.name = 'AdaptationAlreadyRolledBackError';
  }
}

export class AdaptationPreviewNotRollbackableError extends Error {
  constructor(public readonly adaptationId: number) {
    super(
      `Adaptation ${adaptationId} has scope='preview'; preview rows do not ` +
      `mutate plan state and cannot be rolled back.`,
    );
    this.name = 'AdaptationPreviewNotRollbackableError';
  }
}

/**
 * Record a persisted adaptive event. Bumps `adaptation_revision` on
 * the parent plan and inserts exactly one ledger row, atomically.
 *
 * Idempotency: when `idempotencyKey` is supplied, this function first
 * checks for an existing row with the same `(plan_id, idempotency_key)`.
 * If found, returns the existing row without bumping the revision.
 * The DB-level UNIQUE backstops a pre-check race.
 *
 * Throws:
 *   - `AdaptationPlanNotFoundError` when the plan id does not exist.
 *   - `AdaptationIdempotencyConflictError` only in the rare case where
 *     the pre-check passed but a concurrent insert won the race; the
 *     caller is expected to re-call `findAdaptationByIdempotencyKey`
 *     to retrieve the winning row.
 */
export function recordAdaptation(
  input: RecordAdaptationInput,
): RecordAdaptationResult {
  // Idempotency pre-check (cheap; short-circuits without a transaction).
  if (input.idempotencyKey) {
    const existing = findAdaptationByIdempotencyKey(input.planId, input.idempotencyKey);
    if (existing) {
      return {
        adaptationId: existing.id,
        adaptationRevision: existing.adaptation_revision,
        alreadyExisted: true,
      };
    }
  }

  const actor: AdaptationActor = input.actor ?? 'system';
  const db = getDb();

  // Single transaction: bump revision → insert ledger row. On any
  // throw, better-sqlite3 rolls back both the UPDATE and the INSERT.
  const txn = db.transaction((): RecordAdaptationResult => {
    const newRevision = incrementAdaptationRevision(input.planId);
    if (newRevision === null) {
      throw new AdaptationPlanNotFoundError(input.planId);
    }

    try {
      const inserted = db.prepare(`
        INSERT INTO training_plan_adaptations (
          plan_id, adaptation_revision, scope, trigger_type,
          trigger_payload_json, before_patch_json, after_patch_json,
          decision_reason_codes_json, science_policy_version,
          feature_flag_snapshot, idempotency_key, actor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.planId,
        newRevision,
        input.scope,
        input.triggerType,
        input.triggerPayload !== undefined ? JSON.stringify(input.triggerPayload) : null,
        input.beforePatch !== undefined ? JSON.stringify(input.beforePatch) : null,
        input.afterPatch !== undefined ? JSON.stringify(input.afterPatch) : null,
        input.decisionReasonCodes ? JSON.stringify(input.decisionReasonCodes) : null,
        input.sciencePolicyVersion,
        input.featureFlagSnapshot ? JSON.stringify(input.featureFlagSnapshot) : null,
        input.idempotencyKey ?? null,
        actor,
      );

      return {
        adaptationId: Number(inserted.lastInsertRowid),
        adaptationRevision: newRevision,
        alreadyExisted: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        input.idempotencyKey &&
        /UNIQUE constraint failed.*idempotency/i.test(message)
      ) {
        // Concurrent racer beat us to the same idempotency key
        // between the pre-check and this INSERT. Transaction rolls
        // back; surface a distinctive error so the caller can
        // re-fetch.
        throw new AdaptationIdempotencyConflictError(input.planId, input.idempotencyKey);
      }
      throw err;
    }
  });

  return txn();
}

/**
 * Record a *preview* of an adaptation without mutating plan state.
 * Inserts a ledger row with `scope = 'preview'` and
 * `adaptation_revision = NULL`. Useful for week-reflow previews (slice
 * C6) and explainability flows where the user wants to see "what would
 * happen if I accept this suggestion?" before applying.
 *
 * Preview rows do NOT bump the revision counter, do NOT participate in
 * the `UNIQUE(plan_id, adaptation_revision)` invariant (the index is
 * partial on `WHERE adaptation_revision IS NOT NULL`), and cannot be
 * rolled back (use C6 apply if the user accepts; otherwise leave the
 * preview as historical record).
 */
export function recordPreviewAdaptation(
  input: RecordPreviewInput,
): { adaptationId: number } {
  const db = getDb();
  const actor: AdaptationActor = input.actor ?? 'system';

  // Verify the plan exists. We don't bump the revision, so we do a
  // direct existence check rather than relying on
  // incrementAdaptationRevision's null-return path.
  const planExists = db.prepare(
    'SELECT 1 FROM fitness_training_plans WHERE id = ?',
  ).get(input.planId);
  if (!planExists) {
    throw new AdaptationPlanNotFoundError(input.planId);
  }

  const inserted = db.prepare(`
    INSERT INTO training_plan_adaptations (
      plan_id, adaptation_revision, scope, trigger_type,
      trigger_payload_json, before_patch_json, after_patch_json,
      decision_reason_codes_json, science_policy_version,
      feature_flag_snapshot, idempotency_key, actor
    ) VALUES (?, NULL, 'preview', ?, ?, NULL, ?, ?, ?, ?, NULL, ?)
  `).run(
    input.planId,
    input.triggerType,
    input.triggerPayload !== undefined ? JSON.stringify(input.triggerPayload) : null,
    input.afterPatch !== undefined ? JSON.stringify(input.afterPatch) : null,
    input.decisionReasonCodes ? JSON.stringify(input.decisionReasonCodes) : null,
    input.sciencePolicyVersion,
    input.featureFlagSnapshot ? JSON.stringify(input.featureFlagSnapshot) : null,
    actor,
  );

  return { adaptationId: Number(inserted.lastInsertRowid) };
}

/**
 * Reverse a previously-recorded adaptation. Append-only: the original
 * row is preserved; a NEW row is inserted with `before_patch` and
 * `after_patch` swapped (so the net effect on a replayer is undoing
 * the original), `rollback_of_adaptation_id` set to the original's id,
 * `trigger_type = 'rollback'`, and a fresh `adaptation_revision`.
 *
 * Enforces "latest-only" rollback: the target adaptation's revision
 * must equal the plan's current `adaptation_revision`. This prevents
 * corrupting state by rolling back an old adaptation while newer ones
 * still depend on it. To rollback an older adaptation, callers must
 * first rollback every newer one.
 *
 * Throws:
 *   - `AdaptationPlanNotFoundError` — original row missing.
 *   - `AdaptationPreviewNotRollbackableError` — original is a preview.
 *   - `AdaptationAlreadyRolledBackError` — a later rollback row
 *     already references this id (defensive — the latest-only check
 *     should prevent this, but the explicit check protects against
 *     concurrent rollback races).
 *   - `AdaptationRollbackNotLatestError` — original is not the latest
 *     revision.
 */
export function rollbackAdaptation(input: RollbackInput): RollbackResult {
  const db = getDb();
  const actor: AdaptationActor = input.actor ?? 'admin';

  const txn = db.transaction((): RollbackResult => {
    const original = db.prepare(`
      SELECT * FROM training_plan_adaptations WHERE id = ?
    `).get(input.adaptationId) as AdaptationLedgerRow | undefined;

    if (!original) {
      throw new AdaptationPlanNotFoundError(input.adaptationId);
    }
    if (original.scope === 'preview' || original.adaptation_revision === null) {
      throw new AdaptationPreviewNotRollbackableError(input.adaptationId);
    }

    // Defensive: has this adaptation already been rolled back?
    const existingRollback = db.prepare(`
      SELECT id FROM training_plan_adaptations
      WHERE rollback_of_adaptation_id = ? AND plan_id = ?
      LIMIT 1
    `).get(input.adaptationId, original.plan_id) as { id: number } | undefined;
    if (existingRollback) {
      throw new AdaptationAlreadyRolledBackError(input.adaptationId);
    }

    // Optimistic lock: original must be the latest revision.
    const currentRevision = getAdaptationRevision(original.plan_id);
    if (currentRevision !== original.adaptation_revision) {
      throw new AdaptationRollbackNotLatestError(
        input.adaptationId,
        original.adaptation_revision,
        currentRevision ?? -1,
      );
    }

    // Bump revision for the new rollback row.
    const newRevision = incrementAdaptationRevision(original.plan_id);
    if (newRevision === null) {
      throw new AdaptationPlanNotFoundError(original.plan_id);
    }

    // Swap before/after to invert the patch. The science_policy_version
    // stays the SAME as the original so reproducibility holds — the
    // rollback undoes a specific adaptation under a specific policy.
    const inverseTriggerPayload = input.reasonNote
      ? { reasonNote: input.reasonNote }
      : null;

    const inserted = db.prepare(`
      INSERT INTO training_plan_adaptations (
        plan_id, adaptation_revision, scope, trigger_type,
        trigger_payload_json, before_patch_json, after_patch_json,
        decision_reason_codes_json, science_policy_version,
        feature_flag_snapshot, idempotency_key, rollback_of_adaptation_id,
        actor
      ) VALUES (?, ?, ?, 'rollback', ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      original.plan_id,
      newRevision,
      original.scope, // The rollback affects the same scope as the original.
      inverseTriggerPayload !== null ? JSON.stringify(inverseTriggerPayload) : null,
      // Swap: original.after becomes rollback's before, and vice versa.
      original.after_patch_json,
      original.before_patch_json,
      original.decision_reason_codes_json,
      original.science_policy_version,
      original.feature_flag_snapshot,
      original.id,
      actor,
    );

    return {
      rollbackAdaptationId: Number(inserted.lastInsertRowid),
      newAdaptationRevision: newRevision,
    };
  });

  return txn();
}

/**
 * Fetch the ledger row for an exact `(plan, revision)` tuple. Used by
 * reproducibility flows: "show me the state of this plan at revision N".
 */
export function getAdaptationByRevision(
  planId: number,
  adaptationRevision: number,
  viewerRole: ViewerRole = 'owner',
): AdaptationLedgerRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM training_plan_adaptations
    WHERE plan_id = ? AND adaptation_revision = ?
    LIMIT 1
  `).get(planId, adaptationRevision) as AdaptationLedgerRow | undefined;
  return row ? redactRowIfNeeded(row, viewerRole) : null;
}

/**
 * Fetch a ledger row by an idempotency key. Returns null if no such
 * row exists. Used by `recordAdaptation`'s pre-check.
 */
export function findAdaptationByIdempotencyKey(
  planId: number,
  idempotencyKey: string,
): AdaptationLedgerRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM training_plan_adaptations
    WHERE plan_id = ? AND idempotency_key = ?
    LIMIT 1
  `).get(planId, idempotencyKey) as AdaptationLedgerRow | undefined;
  return row ?? null;
}

/**
 * Count non-safety applied (`scope != 'preview'`, `adaptation_revision IS NOT NULL`)
 * adaptations for a plan within a recent window. R5 P1 fix — the
 * `classifyTrainingScenario` rate-limiter checks `recentReflowCount24h`
 * + `recentReflowCount7d` against `CoachPlanPolicy.adaptationRateLimits`,
 * but both call sites (reflow + coach-analysis) previously passed only
 * the limits, never the counts, defaulting them to 0. That meant the
 * limiter was a no-op and users could submit unlimited apply reflows.
 *
 * Rules:
 *   - `scope = 'preview'` rows are excluded (they don't bump the
 *     revision and don't count toward churn).
 *   - Rollback rows (`rollback_of_adaptation_id IS NOT NULL`) are
 *     excluded — they're remediation, not user-initiated churn.
 *   - Safety overrides — typed-trigger health pauses written by the
 *     system — are exempt by contract. Today every adaptive write
 *     carries actor='user' OR actor='system'. System rollbacks are
 *     already filtered above; system pauses for safety carry the
 *     `medical_referral` decision-reason in
 *     `decision_reason_codes_json`, so we exclude those too.
 *   - The window is computed in SQLite UTC (`datetime('now', '-N hours')`)
 *     to match the `created_at` column written via `datetime('now')`.
 *
 * Returns a non-negative integer.
 */
export function countNonSafetyAppliedAdaptations(
  planId: number,
  hoursBack: number,
): number {
  if (!Number.isFinite(hoursBack) || hoursBack <= 0) return 0;
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM training_plan_adaptations
    WHERE plan_id = ?
      AND adaptation_revision IS NOT NULL
      AND scope <> 'preview'
      AND rollback_of_adaptation_id IS NULL
      AND (decision_reason_codes_json IS NULL
           OR decision_reason_codes_json NOT LIKE '%medical_referral%')
      AND created_at >= datetime('now', ?)
  `).get(planId, `-${Math.round(hoursBack)} hours`) as { n: number };
  return Number.isFinite(row?.n) ? row.n : 0;
}

/**
 * List adaptations for a plan, newest first. Optionally filter by
 * scope, actor, or time window. Used by support views and the
 * "adaptation history" UI.
 */
export function getAdaptationsForPlan(
  planId: number,
  opts: {
    scope?: AdaptationScope;
    actor?: AdaptationActor;
    sinceISO?: string;
    limit?: number;
    viewerRole?: ViewerRole;
  } = {},
): AdaptationLedgerRow[] {
  const db = getDb();
  const conditions: string[] = ['plan_id = ?'];
  const params: Array<string | number> = [planId];

  if (opts.scope) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.actor) {
    conditions.push('actor = ?');
    params.push(opts.actor);
  }
  if (opts.sinceISO) {
    conditions.push('created_at >= ?');
    params.push(opts.sinceISO);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  params.push(limit);

  const rows = db.prepare(`
    SELECT * FROM training_plan_adaptations
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params) as AdaptationLedgerRow[];

  const viewerRole = opts.viewerRole ?? 'owner';
  return rows.map((row) => redactRowIfNeeded(row, viewerRole));
}

/**
 * Apply role-based redaction to a single row. When the viewer is
 * 'support' and the trigger is health-sensitive, replace the
 * `trigger_payload_json` with a redaction marker. Owner and admin
 * viewers see the raw payload.
 *
 * The ROW is always returned — redaction never hides the existence of
 * an adaptation, only its sensitive contents.
 */
function redactRowIfNeeded(
  row: AdaptationLedgerRow,
  viewerRole: ViewerRole,
): AdaptationLedgerRow {
  if (viewerRole !== 'support') return row;
  if (!HEALTH_SENSITIVE_TRIGGER_TYPES.has(row.trigger_type)) return row;
  // R3 P2 fix — alias the `trigger_type` column too. Previously the
  // function only redacted the JSON payload; the column itself still
  // surfaced 'pain_flag', 'red_s_screening', etc. to support readers.
  return {
    ...row,
    trigger_type: REDACTED_TRIGGER_BUCKET,
    trigger_payload_json: JSON.stringify({
      redacted: true,
      reason: 'health_sensitive',
      triggerType: REDACTED_TRIGGER_BUCKET,
    }),
  };
}

/**
 * Permanently delete sensitive payloads from older ledger rows. Called
 * by the privacy/consent slice (A4p) when a user requests deletion of
 * their health/readiness history. The ledger ROWS are preserved (for
 * audit) but their `trigger_payload_json` is replaced with a
 * redaction marker.
 *
 * Returns the count of affected rows.
 */
export function purgeSensitivePayloadsForUser(
  userId: number,
): number {
  const db = getDb();
  // The ledger joins through fitness_training_plans → user_id; we
  // only redact rows whose plan belongs to this user.
  //
  // Codex R2 P2 fix — on USER-DELETION the redacted payload must NOT
  // retain the specific trigger_type. Knowing the user once had a
  // 'red_s_screening' / 'menstrual_symptom' / 'pain_flag' event
  // category is itself a sensitive disclosure to support viewers.
  // We bucket every sensitive trigger as `health_sensitive` so the
  // ledger row's existence is preserved (audit) without revealing
  // the category.
  const sensitiveList = Array.from(HEALTH_SENSITIVE_TRIGGER_TYPES);
  const placeholders = sensitiveList.map(() => '?').join(', ');
  // R3 P2 fix — also bucket the `trigger_type` COLUMN. The previous
  // update only rewrote `trigger_payload_json`; the column was left
  // as the original category (e.g. 'pain_flag'), so any support
  // query `WHERE trigger_type = 'pain_flag'` could still enumerate
  // a deleted user's sensitive event categories. Now both fields
  // collapse to the 'health_sensitive' bucket on user deletion.
  //
  // R4 P3 fix — Codex caught that the previous version interpolated
  // `${REDACTED_TRIGGER_BUCKET}` directly into the SQL string. The
  // constant is compile-time, but the *pattern* is the kind of habit
  // that silently turns into an injection vector when someone later
  // makes the bucket configurable. Bind the bucket name as a real
  // SQL parameter so the value can never escape the string literal,
  // even if the constant grows to include a quote character later.
  const result = db.prepare(`
    UPDATE training_plan_adaptations
       SET trigger_payload_json = json_object(
             'redacted', json('true'),
             'reason', 'user_deletion',
             'triggerType', ?
           ),
           trigger_type = ?
     WHERE trigger_type IN (${placeholders})
       AND plan_id IN (
         SELECT id FROM fitness_training_plans WHERE user_id = ?
       )
  `).run(REDACTED_TRIGGER_BUCKET, REDACTED_TRIGGER_BUCKET, ...sensitiveList, userId);
  if (result.changes > 0) {
    logger.info({ userId, affected: result.changes }, 'training_plan_adaptations.purge_sensitive_payloads');
  }
  return result.changes;
}
