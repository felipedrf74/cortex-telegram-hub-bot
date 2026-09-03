// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Job-level credit charging for durable Content script jobs (plan §2/§3,
 * NH-0033).
 *
 * Contract:
 * - One reservation per user-visible generation attempt: admission (or a
 *   user-initiated retry) reserves; internal sections, checkpoints, repair,
 *   continuation, and infrastructure requeues settle against that single
 *   reservation and never charge again.
 * - Long-form jobs charge their delivery class (Addendum C): standard and
 *   scheduled scripts cost 10 credits, priority scripts 12; shorter jobs
 *   charge a standard operation (1).
 * - Settlement follows job truth: `completed` captures once, `failed` and
 *   `cancelled` release. Settlement runs even if the admission flag was
 *   turned off mid-flight, so an admitted reservation never strands.
 * - This module returns typed denials instead of throwing so the job service
 *   can raise its own ContentScriptJobError without a module cycle.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import type { BillingPlan } from './plan-quotas';
import { isAiCreditAdmissionEnabled } from './ai-credit-admission';
import type { AiCreditReservation } from './ai-credit-ledger';
import {
  captureAiCreditReservation,
  listAiCreditReservationsForRequest,
  reserveAiCredits,
} from './ai-credit-ledger';

export const CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD = 'content_script_job';

export type ReserveContentScriptJobCreditsResult =
  | { kind: 'disabled' }
  | { kind: 'reserved'; reservation: AiCreditReservation }
  | { kind: 'denied'; code: string; message: string; statusCode: number };

export function reserveContentScriptJobCredits(input: {
  tenantId: number;
  userId: number;
  jobId: string;
  plan: BillingPlan;
  longForm: boolean;
  deliveryMode?: 'standard' | 'scheduled' | 'priority';
  now?: Date;
}, database: Database.Database = getDb()): ReserveContentScriptJobCreditsResult {
  if (!isAiCreditAdmissionEnabled()) return { kind: 'disabled' };

  const tenantScope = String(input.tenantId);
  const prior = listAiCreditReservationsForRequest({
    tenantScope,
    userId: input.userId,
    workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
    requestHash: input.jobId,
  }, database);
  const latest = prior[prior.length - 1];
  if (latest && latest.state === 'reserved') {
    // An in-flight attempt already holds this job's reservation; continue
    // under it instead of minting a second charge.
    return { kind: 'reserved', reservation: latest };
  }
  const deliveryMode = input.deliveryMode ?? 'standard';
  const scriptClass = deliveryMode === 'priority'
    ? 'priority_script'
    : deliveryMode === 'scheduled'
      ? 'scheduled_script'
      : 'standard_script';
  // Delivery mode prices the operation whenever it is requested: a short job
  // that asks for priority scheduling buys priority and pays for it. Only
  // plain standard short jobs fall back to a standard operation.
  const operationClass = input.longForm || deliveryMode !== 'standard'
    ? scriptClass
    : 'standard';
  const admitted = reserveAiCredits({
    userId: input.userId,
    plan: input.plan,
    operationClass,
    replayScope: {
      tenantScope,
      workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
      requestHash: input.jobId,
      clientOperationId: `${input.jobId}#a${prior.length + 1}`,
    },
    now: input.now,
  }, database);

  if (admitted.kind === 'reserved') {
    return { kind: 'reserved', reservation: admitted.reservation };
  }
  if (admitted.kind === 'replay') {
    if (admitted.reservation.state === 'reserved') {
      return { kind: 'reserved', reservation: admitted.reservation };
    }
    return {
      kind: 'denied',
      code: 'CONTENT_SCRIPT_CREDITS_REPLAY_SETTLED',
      message: 'This script operation already settled its credits.',
      statusCode: 409,
    };
  }
  if (admitted.kind === 'operation_not_available') {
    return {
      kind: 'denied',
      code: 'AI_OPERATION_NOT_AVAILABLE',
      message: `Script generation is not available on the ${admitted.plan} plan.`,
      statusCode: 403,
    };
  }
  if (admitted.kind === 'daily_cap_exceeded') {
    return {
      kind: 'denied',
      code: 'AI_CREDIT_DAILY_CAP',
      message: `Daily AI credit cap reached: this script needs ${admitted.requiredCredits} credits and ${admitted.dailyRemainingCredits} of ${admitted.dailyCapCredits} remain today.`,
      statusCode: 429,
    };
  }
  return {
    kind: 'denied',
    code: 'INSUFFICIENT_AI_CREDITS',
    message: `This script needs ${admitted.requiredCredits} AI credits; ${admitted.availableCredits} are available.${admitted.packCtaEligible ? ' Add a credit pack to continue.' : ''}`,
    statusCode: 402,
  };
}

export class ContentScriptJobCreditSettlementError extends Error {
  readonly code = 'CONTENT_SCRIPT_CREDIT_SETTLEMENT_FAILED';
  readonly status = 503;

  constructor(readonly settlementState: string) {
    super('The script state could not be committed with its credit settlement.');
    this.name = 'ContentScriptJobCreditSettlementError';
  }
}

export type ReleaseContentScriptJobCreditsForTerminalResult =
  | 'released'
  | 'already_settled'
  | 'no_reservation';

function hasAiCreditReservationStore(database: Database.Database): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present
      FROM sqlite_master
     WHERE type = 'table' AND name = 'ai_credit_reservations'
  `).get());
}

/**
 * Release the newest open reservation as part of the caller's terminal job
 * transaction. Unlike the legacy best-effort settlement helper, this path
 * fails closed: cancellation/failure state and its credit release either both
 * commit or both roll back. Supplying the caller database also preserves that
 * invariant in scoped tests and one-shot maintenance processes.
 */
export function releaseContentScriptJobCreditsForTerminal(
  input: {
    tenantId: number;
    userId: number;
    jobId: string;
    now?: Date;
  },
  database: Database.Database = getDb(),
): ReleaseContentScriptJobCreditsForTerminalResult {
  const release = (): ReleaseContentScriptJobCreditsForTerminalResult => {
    if (!hasAiCreditReservationStore(database)) {
      if (!isAiCreditAdmissionEnabled()) return 'no_reservation';
      throw new ContentScriptJobCreditSettlementError('reservation_store_missing');
    }
    const reservations = database.prepare(`
      SELECT id, state
        FROM ai_credit_reservations
       WHERE tenant_scope = ?
         AND user_id = ?
         AND workload = ?
         AND request_hash = ?
       ORDER BY id ASC
    `).all(
      String(input.tenantId),
      input.userId,
      CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
      input.jobId,
    ) as Array<{ id: number; state: string }>;
    const open = [...reservations].reverse().find((entry) => entry.state === 'reserved');
    if (!open) return reservations.length > 0 ? 'already_settled' : 'no_reservation';

    const result = database.prepare(`
      UPDATE ai_credit_reservations
         SET state = 'released', settled_at = ?
       WHERE id = ? AND state = 'reserved'
    `).run((input.now ?? new Date()).toISOString(), open.id);
    if (result.changes !== 1) {
      throw new ContentScriptJobCreditSettlementError('release_conflict');
    }
    const readback = database.prepare(`
      SELECT state FROM ai_credit_reservations WHERE id = ?
    `).get(open.id) as { state?: string } | undefined;
    if (readback?.state !== 'released') {
      throw new ContentScriptJobCreditSettlementError(readback?.state ?? 'release_readback_missing');
    }
    return 'released';
  };

  try {
    return database.inTransaction
      ? release()
      : database.transaction(release).immediate();
  } catch (error) {
    if (error instanceof ContentScriptJobCreditSettlementError) throw error;
    throw new ContentScriptJobCreditSettlementError('release_error');
  }
}

/**
 * Capture the reservation as part of the caller's durable completion
 * transaction. Any existing reservation that cannot be captured aborts the
 * caller transaction, so a delivered result and its charge cannot diverge.
 */
export function captureContentScriptJobCreditsForCompletion(input: {
  tenantId: number;
  userId: number;
  jobId: string;
  now?: Date;
}, database: Database.Database = getDb()): 'captured' | 'already_captured' | 'no_reservation' {
  if (!hasAiCreditReservationStore(database)) {
    if (!isAiCreditAdmissionEnabled()) return 'no_reservation';
    throw new ContentScriptJobCreditSettlementError('reservation_store_missing');
  }
  const reservations = listAiCreditReservationsForRequest({
    tenantScope: String(input.tenantId),
    userId: input.userId,
    workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
    requestHash: input.jobId,
  }, database);
  const open = [...reservations].reverse().find((entry) => entry.state === 'reserved');
  if (open) {
    const result = captureAiCreditReservation({
      reservationId: open.id,
      resultRef: input.jobId,
      now: input.now,
    }, database);
    if (result.kind !== 'captured') {
      throw new ContentScriptJobCreditSettlementError(result.kind);
    }
    return 'captured';
  }
  if (reservations.length === 0) return 'no_reservation';
  const latest = reservations[reservations.length - 1];
  if (latest?.state === 'captured') return 'already_captured';
  throw new ContentScriptJobCreditSettlementError(latest?.state ?? 'unknown');
}
