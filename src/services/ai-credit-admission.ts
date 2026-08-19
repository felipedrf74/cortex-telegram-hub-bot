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
import { isHybridKillSwitchEngaged } from './hybrid-runtime-kill-switches';
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
  /**
   * Server-computed content hash. Interactive callers MUST pass a hash of the
   * actual request so two different messages that reuse one client id resolve
   * to different reservations. Defaulting to the client id (below) is only
   * safe for callers whose client id is already content-unique.
   */
  requestHash?: string;
  /**
   * Durable jobs (content scripts) legitimately re-enter their own in-flight
   * reservation on retry. Interactive paths must NOT: an in-flight replay
   * there is a concurrent duplicate and re-running would bill one reservation
   * for two provider calls. Default false rejects in-flight replays.
   */
  allowInFlightReplay?: boolean;
  now?: Date;
}

export type AiCreditDenial = Extract<
  ReserveAiCreditsResult,
  | { kind: 'insufficient_credits' }
  | { kind: 'daily_cap_exceeded' }
  | { kind: 'operation_not_available' }
>;

export class AiCreditAdmissionDeniedError extends Error {
  readonly code = 'AI_CREDITS_DENIED';
  constructor(readonly denial: AiCreditDenial) {
    super(
      denial.kind === 'insufficient_credits'
        ? `Insufficient AI credits: required ${denial.requiredCredits}, available ${denial.availableCredits}`
        : denial.kind === 'daily_cap_exceeded'
          ? `Daily AI credit cap reached: required ${denial.requiredCredits}, remaining ${denial.dailyRemainingCredits}`
          : `Operation class ${denial.operationClass} is not available on the ${denial.plan} plan`,
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

export class AiCreditInFlightError extends Error {
  readonly code = 'AI_CREDIT_OPERATION_IN_FLIGHT';
  constructor(readonly reservation: AiCreditReservation) {
    super('An identical operation is already in progress; not dispatching a second provider call');
    this.name = 'AiCreditInFlightError';
  }
}

export function isAiCreditAdmissionEnabled(): boolean {
  return config.hybridCredits?.enabled === true
    && !isHybridKillSwitchEngaged('hybrid_credits');
}

export interface AiCreditAdmissionContext {
  /** Null when admission is disabled and the wrapper is a passthrough. */
  reservationId: number | null;
}

/**
 * Admit, run, and settle one credit-bearing operation. On success the
 * reservation captures exactly once; on failure or cancellation it releases.
 */
export async function withAiCreditAdmission<T>(
  input: AiCreditAdmissionInput,
  run: (context: AiCreditAdmissionContext) => Promise<T>,
): Promise<T> {
  if (!isAiCreditAdmissionEnabled()) {
    return run({ reservationId: null });
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
    // A still-reserved replay is a concurrent duplicate. Re-entering run()
    // would dispatch a second provider call billed to one reservation — the
    // amplification vector. Only durable jobs that explicitly continue their
    // own in-flight operation may pass allowInFlightReplay.
    if (!input.allowInFlightReplay) {
      throw new AiCreditInFlightError(admitted.reservation);
    }
    reservation = admitted.reservation;
  } else {
    throw new AiCreditAdmissionDeniedError(admitted);
  }

  try {
    const result = await run({ reservationId: reservation.id });
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
