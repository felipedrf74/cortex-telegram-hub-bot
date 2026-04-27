// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training Plan Lifecycle Manager — slice 4.D.
 *
 * Closes Phase 0 audit regression #3 ("plans don't reliably create
 * calendar entries; cancellation doesn't reliably delete the old
 * ones"). The audit identified four compounding root causes:
 *
 *   1. No transactional wrapping around cancel-then-persist on
 *      regeneration — silent partial states are possible.
 *   2. No idempotent calendar create — partial failure leaves
 *      orphans, retry creates duplicates.
 *   3. No supersession state — `'superseded'` doesn't exist on the
 *      status enum; hard-delete is the only path.
 *   4. Silent error suppression on the regeneration cancel catch.
 *
 * This module addresses (2) and (3) directly:
 *
 *   - `recordCalendarOwnership` writes to a NON-CASCADED audit table
 *     so the (plan, event) link survives the FK wipe on plan
 *     deletion. That gives us a real audit trail and a reconciliation
 *     queue for transient external-delete failures.
 *
 *   - The unique index on (plan_id, plan_version, event_id, source)
 *     means a re-run of the persistence loop hits a deterministic
 *     "already recorded" skip — idempotency is enforced at both the
 *     application layer (pre-check) and the database layer (unique
 *     constraint backstop).
 *
 *   - `incrementPlanVersion` provides the per-plan generation counter
 *     that supersession needs. The status enum on
 *     `fitness_training_plans` stays the same (we don't add
 *     'superseded' — the audit explicitly preferred a separate
 *     version field over enum churn).
 *
 *   - `markCalendarOwnershipDeleted` records the cancellation outcome
 *     so future audits can reason about which events were intentionally
 *     removed vs. which became orphaned.
 *
 * (1) and (4) — the saga and the silent-suppression fix — are wired
 * by the calling routes, not in this module. This module owns the
 * audit-state primitive; the routes own the orchestration.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type AgendaOwnershipStatus = 'active' | 'deleted' | 'orphaned';

export interface AgendaEventOwnership {
  id: number;
  plan_id: number;
  plan_version: number;
  session_id: number | null;
  user_id: number;
  calendar_event_id: string;
  calendar_source: string;
  status: AgendaOwnershipStatus;
  created_at: string;
  deleted_at: string | null;
  delete_reason: string | null;
}

export interface RecordCalendarOwnershipInput {
  planId: number;
  planVersion: number;
  sessionId: number;
  userId: number;
  eventId: string;
  source: string;
}

/**
 * Result of a record attempt. `created` true means a new audit row;
 * `created` false means the (plan, plan_version, event, source) tuple
 * already existed — idempotent re-run safe.
 */
export interface RecordCalendarOwnershipResult {
  ok: boolean;
  created: boolean;
  ownershipId: number | null;
}

/**
 * Insert a new ownership audit row. Idempotent: re-running with the
 * same (planId, planVersion, eventId, source) tuple is a no-op (the
 * unique index on those four columns turns it into an
 * INSERT...OR IGNORE).
 *
 * Caller contract:
 *   - The external calendar event MUST already exist (this records
 *     ownership AFTER successful create, never before).
 *   - The session row's `calendar_event_id` MUST already be linked
 *     so the (session_id → event_id) join works on later reads.
 *
 * Returns `created: false` on idempotent skips so the caller can
 * count "newly recorded" vs. "already known" if needed.
 */
export function recordCalendarOwnership(
  input: RecordCalendarOwnershipInput,
): RecordCalendarOwnershipResult {
  const db = getDb();

  const existing = db.prepare(`
    SELECT id FROM training_agenda_event_ownership
    WHERE plan_id = ? AND plan_version = ? AND calendar_event_id = ? AND calendar_source = ?
    LIMIT 1
  `).get(
    input.planId,
    input.planVersion,
    input.eventId,
    input.source,
  ) as { id: number } | undefined;

  if (existing) {
    return { ok: true, created: false, ownershipId: existing.id };
  }

  try {
    const result = db.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(
      input.planId,
      input.planVersion,
      input.sessionId,
      input.userId,
      input.eventId,
      input.source,
    );
    return {
      ok: true,
      created: true,
      ownershipId: typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : (result.lastInsertRowid as number),
    };
  } catch (err) {
    // The unique index is the safety net: if a concurrent caller raced
    // us and inserted the same tuple between our read and write, the
    // INSERT throws SQLITE_CONSTRAINT. We treat that as a successful
    // idempotent skip rather than a failure.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      const refetched = db.prepare(`
        SELECT id FROM training_agenda_event_ownership
        WHERE plan_id = ? AND plan_version = ? AND calendar_event_id = ? AND calendar_source = ?
        LIMIT 1
      `).get(
        input.planId,
        input.planVersion,
        input.eventId,
        input.source,
      ) as { id: number } | undefined;
      return { ok: true, created: false, ownershipId: refetched?.id ?? null };
    }
    logger.warn(
      { err, planId: input.planId, eventId: input.eventId },
      'recordCalendarOwnership failed unexpectedly',
    );
    return { ok: false, created: false, ownershipId: null };
  }
}

export interface MarkOwnershipDeletedInput {
  eventId: string;
  source: string;
  reason?: string;
  status?: 'deleted' | 'orphaned';
}

/**
 * Transition an ownership row to a terminal state. Default status is
 * 'deleted' — used when the external calendar event was successfully
 * removed. Status 'orphaned' is used when the local plan row was
 * deleted (FK cascade) but the external delete failed and the event
 * remains in the user's calendar — the reconciliation queue picks
 * those up.
 *
 * Returns the count of rows transitioned. Idempotent: re-running on
 * an already-deleted row is a no-op.
 */
export function markCalendarOwnershipDeleted(
  input: MarkOwnershipDeletedInput,
): { ok: boolean; rowsAffected: number } {
  const db = getDb();
  const status = input.status ?? 'deleted';
  const statusPredicate = status === 'deleted'
    ? "status IN ('active', 'orphaned')"
    : "status = 'active'";
  const result = db.prepare(`
    UPDATE training_agenda_event_ownership
    SET status = ?, deleted_at = datetime('now'), delete_reason = ?
    WHERE calendar_event_id = ? AND calendar_source = ? AND ${statusPredicate}
  `).run(status, input.reason ?? null, input.eventId, input.source);
  return { ok: true, rowsAffected: result.changes };
}

/**
 * Find ALL ownership rows for a plan (any version, any status).
 * Used by the cancellation route to enumerate what was ever linked
 * to this plan, not just what's currently "alive" in the session
 * table — relevant when transient delete failures left active rows
 * behind that previous cancellations couldn't reach.
 */
export function findOwnershipsForPlan(planId: number): AgendaEventOwnership[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM training_agenda_event_ownership
    WHERE plan_id = ?
    ORDER BY plan_version DESC, id DESC
  `).all(planId) as AgendaEventOwnership[];
}

/**
 * Find ownership rows still 'active' for a user that may need
 * reconciliation: e.g. the local plan was deleted but the external
 * event delete failed transiently. Used by background reconcilers
 * and by the read paths that detect stale state.
 */
export function findOrphanedOwnerships(userId: number): AgendaEventOwnership[] {
  const db = getDb();
  return db.prepare(`
    SELECT o.*
    FROM training_agenda_event_ownership o
    LEFT JOIN training_sessions ts
      ON ts.calendar_event_id = o.calendar_event_id
     AND ts.calendar_source = o.calendar_source
    WHERE o.user_id = ?
      AND o.status = 'active'
      AND ts.id IS NULL
    ORDER BY o.created_at ASC
  `).all(userId) as AgendaEventOwnership[];
}

/**
 * Find ownership rows whose prior external delete failed and still
 * need a precise retry. These rows are the real reconciliation queue;
 * `findOrphanedOwnerships` above catches the FK-cascade aftermath
 * before a row has been marked terminal.
 */
export function findOwnershipsNeedingReconciliation(userId: number): AgendaEventOwnership[] {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM training_agenda_event_ownership
    WHERE user_id = ?
      AND status = 'orphaned'
    ORDER BY COALESCE(deleted_at, created_at) ASC, id ASC
  `).all(userId) as AgendaEventOwnership[];
}

/**
 * Increment a plan's `plan_version`. Used on regeneration so the
 * old session set + ownership audit can be cleanly superseded by a
 * new (plan_id, plan_version+1) tuple. Returns the new version, or
 * null if the plan doesn't exist.
 */
export function incrementPlanVersion(planId: number): number | null {
  const db = getDb();
  const result = db.prepare(`
    UPDATE fitness_training_plans
    SET plan_version = plan_version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(planId);
  if (result.changes === 0) return null;
  const row = db.prepare(
    'SELECT plan_version FROM fitness_training_plans WHERE id = ?',
  ).get(planId) as { plan_version: number } | undefined;
  return row?.plan_version ?? null;
}

/**
 * Get the current plan_version for a plan. Returns 1 (the default
 * for backfilled rows) if not found, since the migration's column
 * default is 1 — but `null` if the plan row doesn't exist at all.
 */
export function getPlanVersion(planId: number): number | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT plan_version FROM fitness_training_plans WHERE id = ?',
  ).get(planId) as { plan_version: number } | undefined;
  return row?.plan_version ?? null;
}

/**
 * Idempotency pre-check for the persistence loop: returns the
 * ownership row, if any, that already exists for this session +
 * (plan, plan_version). Used by `persistGeneratedTrainingPlan` to
 * skip event creation when a previous run already linked this
 * session.
 */
export function findExistingOwnership(input: {
  planId: number;
  planVersion: number;
  sessionId: number;
}): AgendaEventOwnership | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM training_agenda_event_ownership
    WHERE plan_id = ? AND plan_version = ? AND session_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(input.planId, input.planVersion, input.sessionId) as
    | AgendaEventOwnership
    | undefined;
  return row ?? null;
}
