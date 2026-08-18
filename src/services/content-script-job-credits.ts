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

import { logger } from '../utils/logger';
import type { BillingPlan } from './plan-quotas';
import { isAiCreditAdmissionEnabled } from './ai-credit-admission';
import type { AiCreditReservation } from './ai-credit-ledger';
import {
  captureAiCreditReservation,
  listAiCreditReservationsForRequest,
  releaseAiCreditReservation,
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
}): ReserveContentScriptJobCreditsResult {
  if (!isAiCreditAdmissionEnabled()) return { kind: 'disabled' };

  const tenantScope = String(input.tenantId);
  const prior = listAiCreditReservationsForRequest({
    tenantScope,
    userId: input.userId,
    workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
    requestHash: input.jobId,
  });
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
  const admitted = reserveAiCredits({
    userId: input.userId,
    plan: input.plan,
    operationClass: input.longForm ? scriptClass : 'standard',
    replayScope: {
      tenantScope,
      workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
      requestHash: input.jobId,
      clientOperationId: `${input.jobId}#a${prior.length + 1}`,
    },
    now: input.now,
  });

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

export type SettleContentScriptJobCreditsResult =
  | { kind: 'no_reservation' }
  | { kind: 'already_settled' }
  | { kind: 'captured' }
  | { kind: 'released' }
  | { kind: 'error' };

/**
 * Settle the newest open reservation for a job. Never throws: job state is
 * the source of truth, and a settlement fault must not break the job
 * transition — it is logged and left for the stale-reservation sweeper.
 */
export function settleContentScriptJobCredits(input: {
  tenantId: number;
  userId: number;
  jobId: string;
  outcome: 'captured' | 'released';
  now?: Date;
}): SettleContentScriptJobCreditsResult {
  try {
    const reservations = listAiCreditReservationsForRequest({
      tenantScope: String(input.tenantId),
      userId: input.userId,
      workload: CONTENT_SCRIPT_JOB_CREDITS_WORKLOAD,
      requestHash: input.jobId,
    });
    const open = [...reservations].reverse().find((entry) => entry.state === 'reserved');
    if (!open) {
      return { kind: reservations.length > 0 ? 'already_settled' : 'no_reservation' };
    }
    if (input.outcome === 'captured') {
      const result = captureAiCreditReservation({
        reservationId: open.id,
        resultRef: input.jobId,
        now: input.now,
      });
      return { kind: result.kind === 'captured' ? 'captured' : 'already_settled' };
    }
    const result = releaseAiCreditReservation({ reservationId: open.id, now: input.now });
    return { kind: result.kind === 'released' ? 'released' : 'already_settled' };
  } catch (error) {
    logger.error(
      { jobId: input.jobId, outcome: input.outcome, err: error },
      'content-script-job-credits: settlement failed; reservation left for the sweeper',
    );
    return { kind: 'error' };
  }
}
