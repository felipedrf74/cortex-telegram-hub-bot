// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Stable Decision Center error primitives shared by the rewritten modules.
 *
 * Existing public error codes can be carried by the generic class while the
 * rewrite-specific codes below give new contracts an exhaustive vocabulary.
 * Unknown exceptions are deliberately mapped to a 500 without reflecting the
 * original message to clients.
 */

export type DecisionCenterContractErrorCode =
  | 'DECISION_CONFIGURATION_INVALID'
  | 'DECISION_SCOPE_INVALID'
  | 'DECISION_PLANNING_CONTEXT_INVALID'
  | 'DECISION_MUTATION_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'DECISION_VERSION_INVALID'
  | 'DECISION_PRECONDITION_REQUIRED'
  | 'DECISION_APPROVAL_REQUIRED'
  | 'DECISION_EXECUTOR_REQUIRED'
  | 'DECISION_READBACK_REQUIRED'
  | 'DECISION_CURSOR_MALFORMED'
  | 'DECISION_CURSOR_STALE'
  | 'DECISION_REPOSITORY_NOT_READY'
  | 'DECISION_REPOSITORY_REQUIREMENT_INVALID'
  | 'DECISION_REPOSITORY_INSPECTION_FAILED'
  | 'DECISION_MUTATION_RECEIPT_INVALID'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'DECISION_INTERNAL_ERROR';

export interface DecisionCenterErrorEnvelope {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class DecisionCenterError<Code extends string = DecisionCenterContractErrorCode> extends Error {
  readonly code: Code;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: Code,
    message: string,
    status: number,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DecisionCenterError';
    this.code = code;
    this.status = status;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

export class DecisionCenterConfigurationError extends DecisionCenterError<'DECISION_CONFIGURATION_INVALID'> {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('DECISION_CONFIGURATION_INVALID', message, 500, details);
    this.name = 'DecisionCenterConfigurationError';
  }
}

export function isDecisionCenterError(value: unknown): value is DecisionCenterError<string> {
  return value instanceof DecisionCenterError;
}

/** Convert an arbitrary failure into a privacy-safe public error. */
export function normalizeDecisionCenterError(value: unknown): DecisionCenterError<string> {
  if (isDecisionCenterError(value)) return value;
  return new DecisionCenterError(
    'DECISION_INTERNAL_ERROR',
    'Decision Center could not complete the request.',
    500,
    undefined,
    value instanceof Error ? { cause: value } : undefined,
  );
}

export function decisionCenterErrorEnvelope(error: DecisionCenterError<string>): DecisionCenterErrorEnvelope {
  return {
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}
