// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Credit admission wrapper for user-visible AI operations (hybrid AI plan §2).
 *
 * Contract:
 * - One admission wraps one user-visible operation. Everything inside `run` —
 *   sections, retries, continuation, repair, validation, provider fallback —
 *   settles against the single reservation and never charges twice.
 * - Ordering: callers apply entitlement, account-state, and exact-skill
 *   authorization BEFORE this wrapper; provider-dollar controls
 *   (`withAiBudgetReservation`) and provider work run INSIDE `run`.
 * - Default OFF: with `config.hybridCredits.enabled` false this is a pure
 *   passthrough with no ledger reads or writes.
 * - Replay: an in-flight replay (same scope, still reserved) re-enters `run`
 *   under the existing reservation; a settled replay throws
 *   AiCreditReplaySettledError and never dispatches provider work again.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { resolveBillingPlanForUser } from './plan-quotas';
import type { AiCreditOperationClass } from './ai-credit-policy';
import {
  AiCreditReservation,
  ReserveAiCreditsResult,
  captureAiCreditReservation,
  releaseAiCreditReservation,
  reserveAiCredits,
} from './ai-credit-ledger';

export interface AiCreditAdmissionInput {
  userId: number;
  tenantScope: string;
  operationClass: AiCreditOperationClass;
  workload: string;
  clientOperationId: string;
  /** Defaults to the client operation id when the caller has no content hash. */
  requestHash?: string;
  now?: Date;
}

export type AiCreditDenial = Extract<
  ReserveAiCreditsResult,
  { kind: 'insufficient_credits' } | { kind: 'daily_cap_exceeded' }
>;

export class AiCreditAdmissionDeniedError extends Error {
  readonly code = 'AI_CREDITS_DENIED';
  constructor(readonly denial: AiCreditDenial) {
    super(
      denial.kind === 'insufficient_credits'
        ? `Insufficient AI credits: required ${denial.requiredCredits}, available ${denial.availableCredits}`
        : `Daily AI credit cap reached: required ${denial.requiredCredits}, remaining ${denial.dailyRemainingCredits}`,
    );
    this.name = 'AiCreditAdmissionDeniedError';
  }
}

export class AiCreditReplaySettledError extends Error {
  readonly code = 'AI_CREDIT_REPLAY_SETTLED';
  constructor(readonly reservation: AiCreditReservation) {
    super(`AI credit operation already settled as ${reservation.state}; not dispatching again`);
    this.name = 'AiCreditReplaySettledError';
  }
}

export function isAiCreditAdmissionEnabled(): boolean {
  return config.hybridCredits?.enabled === true;
}

/**
 * Admit, run, and settle one credit-bearing operation. On success the
 * reservation captures exactly once; on failure or cancellation it releases.
 */
export async function withAiCreditAdmission<T>(
  input: AiCreditAdmissionInput,
  run: () => Promise<T>,
): Promise<T> {
  if (!isAiCreditAdmissionEnabled()) {
    return run();
  }

  const plan = resolveBillingPlanForUser(input.userId);
  const replayScope = {
    tenantScope: input.tenantScope,
    workload: input.workload,
    requestHash: input.requestHash ?? input.clientOperationId,
    clientOperationId: input.clientOperationId,
  };
  const admitted = reserveAiCredits({
    userId: input.userId,
    plan,
    operationClass: input.operationClass,
    replayScope,
    now: input.now,
  });

  let reservation: AiCreditReservation;
  if (admitted.kind === 'reserved') {
    reservation = admitted.reservation;
  } else if (admitted.kind === 'replay') {
    if (admitted.reservation.state !== 'reserved') {
      throw new AiCreditReplaySettledError(admitted.reservation);
    }
    reservation = admitted.reservation;
  } else {
    throw new AiCreditAdmissionDeniedError(admitted);
  }

  try {
    const result = await run();
    const settled = captureAiCreditReservation({ reservationId: reservation.id, now: input.now });
    if (settled.kind !== 'captured' && !(settled.kind === 'invalid_state' && settled.state === 'captured')) {
      logger.warn(
        { reservationId: reservation.id, settled: settled.kind },
        'ai-credit-admission: capture did not settle as captured',
      );
    }
    return result;
  } catch (error) {
    const released = releaseAiCreditReservation({ reservationId: reservation.id, now: input.now });
    if (released.kind !== 'released' && !(released.kind === 'invalid_state' && released.state !== 'reserved')) {
      logger.warn(
        { reservationId: reservation.id, released: released.kind },
        'ai-credit-admission: release did not settle cleanly',
      );
    }
    throw error;
  }
}
