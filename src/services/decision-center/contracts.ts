// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DecisionCenterError } from './errors';

export const DECISION_MUTATION_COMMAND_SCHEMA_VERSION = 'decision_mutation_command@1.0.0' as const;
export const DECISION_COMMAND_RECEIPT_SCHEMA_VERSION = 'decision_command_receipt@1.0.0' as const;

export interface DecisionScope {
  readonly userId: number;
  readonly tenantId: number;
}

export interface DecisionClock {
  now(): Date;
}

export interface DecisionIsoWeek {
  readonly weekYear: number;
  readonly weekNumber: number;
  readonly key: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

/**
 * One immutable request snapshot for every daily/weekly planning read.
 * `clock` is injected for deterministic downstream work; derived date fields
 * are all computed from the single `capturedAt` instant.
 */
export interface DecisionPlanningContext {
  readonly scope: DecisionScope;
  readonly timezone: string;
  readonly locale: string;
  readonly localDate: string;
  readonly isoWeek: DecisionIsoWeek;
  readonly capturedAt: string;
  readonly clock: DecisionClock;
}

export type DecisionMutationChannel =
  | 'rest'
  | 'ios'
  | 'portal'
  | 'chat'
  | 'shortcut'
  | 'apns'
  | 'automation'
  | 'internal';

export type DecisionMutationOperation =
  | 'create_intent'
  | 'act'
  | 'review'
  | 'edit'
  | 'snooze'
  | 'dismiss'
  | 'mark_viewed'
  | 'refresh'
  | 'update_preferences'
  | 'suppress_type'
  | 'unsuppress_type'
  | 'record_exposure'
  | 'recompute_plan';

export type DecisionCommandReceiptStatus = 'succeeded' | 'partially_failed' | 'failed';

/**
 * Privacy-minimized immutable readback captured for one exact mutation.
 * The full current item remains the top-level response and is deliberately not
 * duplicated into the receipt because it contains user-authored copy and scope
 * identifiers.
 */
export interface DecisionCommandReceiptReadbackItem {
  readonly decisionId: string;
  readonly recordVersion: number;
  readonly contextVersion?: string;
  readonly status: string;
  readonly snoozedUntil?: string;
  readonly actionId?: string;
  readonly actionStatus?: string;
}

export interface DecisionCommandReceiptVerification {
  readonly readBackOk: boolean;
  readonly expectedEffect: Readonly<Record<string, unknown>>;
  readonly actualEffect: Readonly<Record<string, unknown>>;
  readonly message: string;
}

/**
 * Stable evidence for the original idempotent command. The enclosing response
 * may contain a newer current item; this object always describes the exact
 * attempt bound to `idempotencyKeyHash`.
 */
export interface DecisionCommandReceipt {
  readonly schemaVersion: typeof DECISION_COMMAND_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly decisionId: string;
  readonly operation: DecisionMutationOperation;
  readonly actionId?: string;
  /** Lowercase SHA-256 hex of the stable key. The raw key never crosses this contract. */
  readonly idempotencyKeyHash: string;
  readonly status: DecisionCommandReceiptStatus;
  readonly executionAttemptId?: string;
  readonly completedAt: string;
  readonly requestedRecordVersion?: number;
  readonly requestedContextVersion?: string;
  readonly resultRecordVersion?: number;
  readonly resultContextVersion?: string;
  readonly readbackItem?: DecisionCommandReceiptReadbackItem;
  readonly verification?: DecisionCommandReceiptVerification;
}

export type DecisionApprovalLevel =
  | 'none'
  | 'user_confirmation'
  | 'strong_confirmation'
  | 'admin_review';

export interface DecisionApprovalEvidence {
  readonly level: Exclude<DecisionApprovalLevel, 'none'>;
  readonly actorUserId: number;
  readonly confirmedAt: string;
  /** A durable reference or digest, never the raw confirmation phrase/token. */
  readonly evidenceRef: string;
}

export interface DecisionMutationApproval {
  readonly requiredLevel: DecisionApprovalLevel;
  readonly evidence: DecisionApprovalEvidence | null;
}

export interface DecisionMutationExecution {
  readonly executorId: string;
  readonly strategy: 'synchronous' | 'background';
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly reversible: boolean;
  readonly supportsIdempotency: true;
}

export interface DecisionMutationReadback {
  readonly verifierId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly mode: 'exact' | 'versioned';
  readonly expectedState: Readonly<Record<string, unknown>>;
}

export interface DecisionMutationCommand<Payload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly schemaVersion: typeof DECISION_MUTATION_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly decisionId: string;
  readonly operation: DecisionMutationOperation;
  readonly actionId: string | null;
  readonly scope: DecisionScope;
  readonly channel: DecisionMutationChannel;
  readonly idempotencyKey: string;
  /** Explicit null means the legacy caller supplied no record precondition. */
  readonly recordVersion: number | null;
  /** Explicit null means the legacy caller supplied no context precondition. */
  readonly contextVersion: string | null;
  readonly approval: DecisionMutationApproval;
  readonly execution: DecisionMutationExecution;
  readonly readback: DecisionMutationReadback;
  readonly payload: Payload;
  readonly requestedAt: string;
}

export type DecisionMutationCommandInput<Payload extends Readonly<Record<string, unknown>>> =
  Omit<DecisionMutationCommand<Payload>, 'schemaVersion'>;

const APPROVAL_STRENGTH: Readonly<Record<DecisionApprovalLevel, number>> = Object.freeze({
  none: 0,
  user_confirmation: 1,
  strong_confirmation: 2,
  admin_review: 3,
});

/**
 * Construct and validate the shared command used by every mutation surface.
 * APNs/automation execution fails closed unless both optimistic-concurrency
 * versions are present; those surfaces must open the app instead.
 */
export function createDecisionMutationCommand<Payload extends Readonly<Record<string, unknown>>>(
  input: DecisionMutationCommandInput<Payload>,
): DecisionMutationCommand<Payload> {
  assertScope(input.scope);
  assertNonBlank(input.commandId, 'commandId', 200);
  assertNonBlank(input.decisionId, 'decisionId', 200);
  assertNonBlank(input.idempotencyKey, 'idempotencyKey', 255, 'IDEMPOTENCY_KEY_REQUIRED');
  assertIsoInstant(input.requestedAt, 'requestedAt');

  if (input.actionId !== null) assertNonBlank(input.actionId, 'actionId', 160);
  if (input.recordVersion !== null && (!Number.isSafeInteger(input.recordVersion) || input.recordVersion < 1)) {
    throw new DecisionCenterError(
      'DECISION_VERSION_INVALID',
      'recordVersion must be a positive integer or null.',
      400,
      { field: 'recordVersion' },
    );
  }
  if (input.contextVersion !== null) assertNonBlank(input.contextVersion, 'contextVersion', 255);

  if (input.operation !== 'create_intent'
    && (input.channel === 'apns' || input.channel === 'automation')
    && (input.recordVersion === null || input.contextVersion === null)) {
    throw new DecisionCenterError(
      'DECISION_PRECONDITION_REQUIRED',
      `${input.channel} mutations require current record and context versions.`,
      428,
      { channel: input.channel },
    );
  }

  assertApproval(input.approval, input.scope);
  assertNonBlank(input.execution.executorId, 'execution.executorId', 200, 'DECISION_EXECUTOR_REQUIRED');
  assertNonBlank(input.readback.verifierId, 'readback.verifierId', 200, 'DECISION_READBACK_REQUIRED');
  assertNonBlank(input.readback.entityType, 'readback.entityType', 160, 'DECISION_READBACK_REQUIRED');
  assertNonBlank(input.readback.entityId, 'readback.entityId', 255, 'DECISION_READBACK_REQUIRED');

  return Object.freeze({
    ...input,
    schemaVersion: DECISION_MUTATION_COMMAND_SCHEMA_VERSION,
    scope: Object.freeze({ ...input.scope }),
    approval: Object.freeze({
      ...input.approval,
      evidence: input.approval.evidence ? Object.freeze({ ...input.approval.evidence }) : null,
    }),
    execution: Object.freeze({ ...input.execution }),
    readback: Object.freeze({
      ...input.readback,
      expectedState: Object.freeze({ ...input.readback.expectedState }),
    }),
    payload: Object.freeze({ ...input.payload }) as Payload,
  });
}

function assertScope(scope: DecisionScope): void {
  if (!Number.isSafeInteger(scope.userId) || scope.userId < 1
    || !Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1) {
    throw new DecisionCenterError(
      'DECISION_SCOPE_INVALID',
      'Decision mutations require positive integer user and tenant identifiers.',
      400,
    );
  }
}

function assertApproval(approval: DecisionMutationApproval, scope: DecisionScope): void {
  if (approval.requiredLevel === 'none') {
    if (approval.evidence !== null) {
      throw new DecisionCenterError(
        'DECISION_MUTATION_INVALID',
        'Approval evidence is not allowed when no approval is required.',
        400,
        { field: 'approval.evidence' },
      );
    }
    return;
  }

  const evidence = approval.evidence;
  if (!evidence
    || APPROVAL_STRENGTH[evidence.level] < APPROVAL_STRENGTH[approval.requiredLevel]
    || evidence.actorUserId !== scope.userId) {
    throw new DecisionCenterError(
      'DECISION_APPROVAL_REQUIRED',
      `Decision mutation requires ${approval.requiredLevel}.`,
      409,
      { requiredLevel: approval.requiredLevel },
    );
  }
  assertIsoInstant(evidence.confirmedAt, 'approval.evidence.confirmedAt');
  assertNonBlank(evidence.evidenceRef, 'approval.evidence.evidenceRef', 255, 'DECISION_APPROVAL_REQUIRED');
}

function assertNonBlank(
  value: string,
  field: string,
  maxLength: number,
  code: 'DECISION_MUTATION_INVALID' | 'IDEMPOTENCY_KEY_REQUIRED' | 'DECISION_EXECUTOR_REQUIRED' | 'DECISION_READBACK_REQUIRED' | 'DECISION_APPROVAL_REQUIRED' = 'DECISION_MUTATION_INVALID',
): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new DecisionCenterError(code, `${field} must be a non-empty string of at most ${maxLength} characters.`, 400, { field });
  }
}

function assertIsoInstant(value: string, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DecisionCenterError(
      'DECISION_MUTATION_INVALID',
      `${field} must be a valid ISO-8601 timestamp.`,
      400,
      { field },
    );
  }
}
