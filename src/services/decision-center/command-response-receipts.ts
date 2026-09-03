// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

import { getDb } from '../database';

import {
  DECISION_COMMAND_RECEIPT_SCHEMA_VERSION,
  type DecisionCommandReceipt,
  type DecisionCommandReceiptReadbackItem,
  type DecisionCommandReceiptStatus,
  type DecisionCommandReceiptVerification,
  type DecisionMutationCommand,
  type DecisionMutationOperation,
} from './contracts';
import { DecisionCenterError } from './errors';
import type { DecisionApiItem } from './types';

const DECISION_MUTATION_OPERATIONS = new Set<DecisionMutationOperation>([
  'create_intent',
  'act',
  'review',
  'edit',
  'snooze',
  'dismiss',
  'mark_viewed',
  'refresh',
  'update_preferences',
  'suppress_type',
  'unsuppress_type',
  'record_exposure',
  'recompute_plan',
]);

const RECEIPT_STATUSES = new Set<DecisionCommandReceiptStatus>([
  'succeeded',
  'partially_failed',
  'failed',
]);

const ITEM_MUTATION_OPERATIONS = new Set<DecisionMutationOperation>([
  'act',
  'review',
  'edit',
  'snooze',
  'dismiss',
  'mark_viewed',
  'refresh',
]);

const EXECUTION_PROOF_OPERATIONS = new Set<DecisionMutationOperation>([
  'act',
  'snooze',
  'dismiss',
]);

const PRIVATE_EFFECT_KEYS = new Set([
  'body',
  'commandcontract',
  'content',
  'description',
  'email',
  'idempotencykey',
  'idempotencyrequestfingerprint',
  'message',
  'name',
  'prompt',
  'raw',
  'scope',
  'summary',
  'tenantid',
  'title',
  'userid',
]);

// Normalize first, then reject private concepts wherever they appear in a
// compound/camelCase key (for example `emailAddress`, `promptText`, or
// `contentTitle`). Receipt evidence is deliberately fail-closed: known-safe
// status/version fields do not contain any of these fragments.
const PRIVATE_EFFECT_KEY_FRAGMENTS = Object.freeze([
  'body',
  'commandcontract',
  'content',
  'description',
  'email',
  'idempotency',
  'message',
  'name',
  'prompt',
  'raw',
  'scope',
  'summary',
  'tenant',
  'title',
  'user',
]);

export interface CreateDecisionCommandReceiptInput {
  readonly receiptId: string;
  readonly decisionId: string;
  readonly operation: DecisionMutationOperation;
  readonly actionId?: string | null;
  readonly idempotencyKey: string;
  readonly status: DecisionCommandReceiptStatus;
  readonly executionAttemptId?: string | null;
  readonly completedAt: string;
  readonly requestedRecordVersion?: number | null;
  readonly requestedContextVersion?: string | null;
  readonly readbackItem?: DecisionCommandReceiptReadbackItem | null;
  readonly verification?: DecisionCommandReceiptVerification | null;
}

export interface PersistDecisionCommandReceiptInput {
  readonly receipt: DecisionCommandReceipt;
  readonly userId: number;
  readonly tenantId: number;
}

export interface CompactDecisionExecutionReceiptEvidenceInput {
  readonly expectedEffect: Readonly<Record<string, unknown>>;
  readonly actualEffect: Readonly<Record<string, unknown>>;
  readonly effectResults: unknown;
  readonly status: DecisionCommandReceiptStatus;
  readonly errorCode?: unknown;
}

export interface PrivacySafeDecisionMutationCommandContract {
  readonly schemaVersion: string;
  readonly operation: DecisionMutationOperation;
  readonly actionId: string | null;
  readonly channel: string;
  readonly idempotencyKeyHash: string;
  readonly recordVersion: number | null;
  readonly contextVersion: string | null;
  readonly approval: Readonly<{ requiredLevel: string }>;
  readonly execution: Readonly<{
    executorId: string;
    strategy: string;
    riskLevel: string;
    reversible: boolean;
    supportsIdempotency: boolean;
  }>;
  readonly readback: Readonly<{
    verifierId: string;
    mode: string;
  }>;
  readonly requestedAt: string;
}

export function decisionIdempotencyKeyHash(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

/**
 * Project a mutation command into the bounded structural evidence that may be
 * exposed by Decision history. Raw journal keys, authenticated scope, user
 * payload, approval evidence, and entity/readback values intentionally stay
 * out of lifecycle metadata.
 */
export function privacySafeDecisionMutationCommandContract(
  command: DecisionMutationCommand,
): PrivacySafeDecisionMutationCommandContract {
  return deepFreeze({
    schemaVersion: command.schemaVersion,
    operation: command.operation,
    actionId: command.actionId,
    channel: command.channel,
    idempotencyKeyHash: decisionIdempotencyKeyHash(command.idempotencyKey),
    recordVersion: command.recordVersion,
    contextVersion: command.contextVersion,
    approval: { requiredLevel: command.approval.requiredLevel },
    execution: {
      executorId: command.execution.executorId,
      strategy: command.execution.strategy,
      riskLevel: command.execution.riskLevel,
      reversible: command.execution.reversible,
      supportsIdempotency: command.execution.supportsIdempotency,
    },
    readback: {
      verifierId: command.readback.verifierId,
      mode: command.readback.mode,
    },
    requestedAt: command.requestedAt,
  });
}

/**
 * Read-side privacy guard for predecessor rows that stored a full mutation
 * command. The original row remains immutable for internal replay, while the
 * history projection exposes only the same structural shape used by new rows.
 */
export function privacySafeDecisionLifecycleMetadata(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const metadata: Record<string, unknown> = { ...value };
  if (!hasOwn(metadata, 'commandContract')) return metadata;
  const projected = projectStoredDecisionMutationCommandContract(metadata.commandContract);
  if (projected) metadata.commandContract = projected;
  else delete metadata.commandContract;
  return metadata;
}

export function decisionCommandReceiptId(input: {
  decisionId: string;
  operation: DecisionMutationOperation;
  actionId?: string | null;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
}): string {
  return `dcr_${createHash('sha256').update(stableJson({
    schemaVersion: DECISION_COMMAND_RECEIPT_SCHEMA_VERSION,
    decisionId: input.decisionId,
    operation: input.operation,
    actionId: input.actionId ?? null,
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
  })).digest('hex')}`;
}

export function compactDecisionCommandReadback(
  item: Pick<DecisionApiItem,
    'decisionId' | 'recordVersion' | 'contextVersion' | 'status' | 'snoozedUntil'>,
  action?: { actionId?: string | null; actionStatus?: string | null },
): DecisionCommandReceiptReadbackItem {
  return Object.freeze({
    decisionId: item.decisionId,
    recordVersion: item.recordVersion,
    ...(item.contextVersion ? { contextVersion: item.contextVersion } : {}),
    status: item.status,
    ...(item.snoozedUntil ? { snoozedUntil: item.snoozedUntil } : {}),
    ...(action?.actionId ? { actionId: action.actionId } : {}),
    ...(action?.actionStatus ? { actionStatus: action.actionStatus } : {}),
  });
}

/**
 * Fixed allowlist for action-execution evidence. Arbitrary executor/provider
 * result fields contribute only to a SHA-256 digest and can never become
 * immutable user history as plaintext.
 */
export function compactDecisionExecutionReceiptEvidence(
  input: CompactDecisionExecutionReceiptEvidenceInput,
): {
  expectedEffect: Readonly<Record<string, unknown>>;
  actualEffect: Readonly<Record<string, unknown>>;
} {
  const effectStatusCounts: Record<string, number> = {};
  if (Array.isArray(input.effectResults)) {
    for (const value of input.effectResults.slice(0, 40)) {
      if (!isPlainObject(value)) continue;
      const status = value.status;
      if (typeof status !== 'string'
          || !['pending', 'succeeded', 'failed', 'compensated', 'unknown'].includes(status)) continue;
      effectStatusCounts[status] = (effectStatusCounts[status] ?? 0) + 1;
    }
  }
  const expectedVerifier = evidenceToken(input.expectedEffect.verifier);
  const expectedStatus = evidenceToken(input.expectedEffect.expectedStatus);
  const requestFingerprint = typeof input.expectedEffect.idempotencyRequestFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(input.expectedEffect.idempotencyRequestFingerprint)
    ? input.expectedEffect.idempotencyRequestFingerprint
    : undefined;
  const errorCode = evidenceToken(input.errorCode);
  return Object.freeze({
    expectedEffect: Object.freeze({
      evidenceHash: createHash('sha256').update(stableJson(input.expectedEffect)).digest('hex'),
      ...(expectedVerifier ? { verifier: expectedVerifier } : {}),
      ...(expectedStatus ? { expectedStatus } : {}),
      ...(requestFingerprint ? { requestFingerprint } : {}),
    }),
    actualEffect: Object.freeze({
      evidenceHash: createHash('sha256').update(stableJson(input.actualEffect)).digest('hex'),
      executionStatus: input.status,
      ...(errorCode ? { errorCode } : {}),
      effectStatusCounts: Object.freeze(effectStatusCounts),
    }),
  });
}

/**
 * Recover the exact action-specific response from the existing scoped
 * execution ledger and prove that it is the value bound by the immutable
 * command receipt. The receipt keeps only a digest, so user-authored executor
 * output is neither duplicated into lifecycle history nor trusted if the
 * mutable execution row no longer matches that digest.
 */
export function verifiedDecisionExecutionReadback(
  receipt: DecisionCommandReceipt,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || !isBoundedExecutionReadback(value)) {
    throw invalidReceiptError('Decision execution readback is not a bounded JSON object.');
  }
  const encoded = stableJson(value);
  if (encoded.length > 131_072) {
    throw invalidReceiptError('Decision execution readback exceeds its bounded response contract.');
  }
  const expectedHash = receipt.verification?.actualEffect.evidenceHash;
  if (typeof expectedHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedHash)
      || createHash('sha256').update(encoded).digest('hex') !== expectedHash) {
    throw invalidReceiptError('Decision execution readback no longer matches its immutable receipt.');
  }
  return deepFreeze(value);
}

function isBoundedExecutionReadback(
  value: unknown,
  depth = 0,
  budget: { entries: number } = { entries: 0 },
): boolean {
  if (depth > 12 || budget.entries > 2_000) return false;
  if (value == null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 32_768;
  if (Array.isArray(value)) {
    if (value.length > 500) return false;
    budget.entries += value.length;
    return value.every((entry) => isBoundedExecutionReadback(entry, depth + 1, budget));
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 500) return false;
  budget.entries += entries.length;
  return entries.every(([key, entry]) => (
    key.length <= 200
    && key !== '__proto__'
    && key !== 'prototype'
    && key !== 'constructor'
    && isBoundedExecutionReadback(entry, depth + 1, budget)
  ));
}

export function createDecisionCommandReceipt(
  input: CreateDecisionCommandReceiptInput,
): DecisionCommandReceipt {
  if (input.actionId != null && (typeof input.actionId !== 'string' || !input.actionId)) {
    throw invalidReceiptError('Decision command receipt action identity is invalid.');
  }
  if (input.executionAttemptId != null
      && (typeof input.executionAttemptId !== 'string' || !input.executionAttemptId)) {
    throw invalidReceiptError('Decision command receipt attempt identity is invalid.');
  }
  if (input.requestedRecordVersion != null && !isPositiveInteger(input.requestedRecordVersion)) {
    throw invalidReceiptError('Decision command receipt requested record version is invalid.');
  }
  if (input.requestedContextVersion != null
      && (typeof input.requestedContextVersion !== 'string' || !input.requestedContextVersion)) {
    throw invalidReceiptError('Decision command receipt requested context version is invalid.');
  }
  const readback = input.readbackItem ?? undefined;
  const verification = input.verification
    ? minimizeReceiptVerification(input.verification, input.operation, input.status)
    : undefined;
  const receipt = Object.freeze({
    schemaVersion: DECISION_COMMAND_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId,
    decisionId: input.decisionId,
    operation: input.operation,
    ...(input.actionId ? { actionId: input.actionId } : {}),
    idempotencyKeyHash: decisionIdempotencyKeyHash(input.idempotencyKey),
    status: input.status,
    ...(input.executionAttemptId ? { executionAttemptId: input.executionAttemptId } : {}),
    completedAt: normalizeReceiptInstant(input.completedAt),
    ...(isPositiveInteger(input.requestedRecordVersion)
      ? { requestedRecordVersion: input.requestedRecordVersion }
      : {}),
    ...(input.requestedContextVersion
      ? { requestedContextVersion: input.requestedContextVersion }
      : {}),
    ...(readback ? { resultRecordVersion: readback.recordVersion } : {}),
    ...(readback?.contextVersion ? { resultContextVersion: readback.contextVersion } : {}),
    ...(readback ? { readbackItem: Object.freeze({ ...readback }) } : {}),
    ...(verification ? { verification } : {}),
  });
  return validateDecisionCommandReceipt(receipt);
}

/** Persist an immutable receipt into the existing scoped lifecycle ledger. */
export function persistDecisionCommandReceipt(
  input: PersistDecisionCommandReceiptInput,
): DecisionCommandReceipt {
  const inserted = getDb().prepare(`
    INSERT OR IGNORE INTO decision_lifecycle_events (
      event_id, decision_id, user_id, tenant_id, event, to_status, action_id,
      reason, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'mutation_receipt', ?, ?, 'immutable_command_receipt', ?, ?)
  `).run(
    input.receipt.receiptId,
    input.receipt.decisionId,
    input.userId,
    input.tenantId,
    input.receipt.readbackItem?.status ?? null,
    input.receipt.actionId ?? input.receipt.operation,
    JSON.stringify({ commandReceipt: input.receipt }),
    input.receipt.completedAt,
  );
  if (inserted.changes === 1) return input.receipt;

  // INSERT OR IGNORE closes the read-then-insert race for simultaneous
  // cross-device replays. An ignored insert is accepted only when the exact
  // immutable receipt already exists in the same authenticated scope.
  const existingAnyScope = getDb().prepare(`
    SELECT user_id AS userId, tenant_id AS tenantId, metadata_json AS metadataJson
      FROM decision_lifecycle_events
     WHERE event_id = ?
     LIMIT 1
  `).get(input.receipt.receiptId) as {
    userId: number;
    tenantId: number;
    metadataJson: string;
  } | undefined;
  if (!existingAnyScope
      || existingAnyScope.userId !== input.userId
      || existingAnyScope.tenantId !== input.tenantId) {
    throw invalidReceiptError('A Decision command receipt collided with another authenticated scope.');
  }
  const existing = parseReceiptMetadata(existingAnyScope.metadataJson);
  if (!existing || stableJson(existing) !== stableJson(input.receipt)) {
    throw invalidReceiptError('A Decision command receipt changed after it became durable.');
  }
  return existing;
}

export function readDecisionCommandReceipt(
  receiptId: string,
  decisionId: string,
  userId: number,
  tenantId: number,
): DecisionCommandReceipt | null {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson
     FROM decision_lifecycle_events
     WHERE event_id = ? AND decision_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'mutation_receipt' AND reason = 'immutable_command_receipt'
     LIMIT 1
  `).get(receiptId, decisionId, userId, tenantId) as { metadataJson: string } | undefined;
  if (!row) return null;
  return parseReceiptMetadata(row.metadataJson);
}

export function listDecisionCommandReceipts(
  decisionId: string,
  userId: number,
  tenantId: number,
): DecisionCommandReceipt[] {
  const rows = getDb().prepare(`
    SELECT metadata_json AS metadataJson
      FROM decision_lifecycle_events
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'mutation_receipt' AND reason = 'immutable_command_receipt'
     ORDER BY rowid ASC
  `).all(decisionId, userId, tenantId) as Array<{ metadataJson: string }>;
  const receipts: DecisionCommandReceipt[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const receipt = parseReceiptMetadata(row.metadataJson);
    if (!receipt || seen.has(receipt.receiptId)) continue;
    seen.add(receipt.receiptId);
    receipts.push(receipt);
  }
  return receipts;
}

function parseReceiptMetadata(metadataJson: string): DecisionCommandReceipt | null {
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch (cause) {
    throw invalidReceiptError('Stored Decision command receipt metadata is not valid JSON.', cause);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const candidate = (metadata as Record<string, unknown>).commandReceipt;
  if (candidate == null) return null;
  return validateDecisionCommandReceipt(candidate);
}

function validateDecisionCommandReceipt(value: unknown): DecisionCommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidReceiptError('Stored Decision command receipt has an invalid shape.');
  }
  const receipt = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schemaVersion', 'receiptId', 'decisionId', 'operation', 'actionId',
    'idempotencyKeyHash', 'status', 'executionAttemptId', 'completedAt',
    'requestedRecordVersion', 'requestedContextVersion', 'resultRecordVersion',
    'resultContextVersion', 'readbackItem', 'verification',
  ]);
  if (Object.keys(receipt).some((key) => !allowedKeys.has(key))
      || receipt.schemaVersion !== DECISION_COMMAND_RECEIPT_SCHEMA_VERSION
      || typeof receipt.receiptId !== 'string'
      || !/^dcr_[a-f0-9]{64}(?:_partial)?$/.test(receipt.receiptId)
      || typeof receipt.decisionId !== 'string'
      || !receipt.decisionId
      || receipt.decisionId.length > 300
      || !DECISION_MUTATION_OPERATIONS.has(receipt.operation as DecisionMutationOperation)
      || typeof receipt.idempotencyKeyHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.idempotencyKeyHash)
      || !RECEIPT_STATUSES.has(receipt.status as DecisionCommandReceiptStatus)
      || typeof receipt.completedAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.completedAt))) {
    throw invalidReceiptError('Stored Decision command receipt failed contract validation.');
  }
  if (hasOwn(receipt, 'actionId')
      && (typeof receipt.actionId !== 'string' || !receipt.actionId || receipt.actionId.length > 200)) {
    throw invalidReceiptError('Stored Decision command receipt action identity is invalid.');
  }
  const operation = receipt.operation as DecisionMutationOperation;
  const hasPartialSuffix = (receipt.receiptId as string).endsWith('_partial');
  if (hasPartialSuffix !== (receipt.status === 'partially_failed')) {
    throw invalidReceiptError('Stored Decision command receipt suffix and terminal status do not agree.');
  }
  if ((operation === 'act' || operation === 'snooze' || operation === 'dismiss'
      || operation === 'review' || operation === 'edit') && typeof receipt.actionId !== 'string') {
    throw invalidReceiptError('Stored Decision command receipt is missing its action identity.');
  }
  if ((operation === 'snooze' && receipt.actionId !== 'snooze')
      || (operation === 'dismiss' && receipt.actionId !== 'dismiss' && receipt.actionId !== 'not_now')
      || (operation === 'review' && !/^review:(approve|reject|defer)$/.test(String(receipt.actionId)))
      || (operation === 'edit' && receipt.actionId !== 'edit_proposal')
      || ((operation === 'mark_viewed' || operation === 'refresh') && receipt.actionId != null)
      || (operation === 'create_intent' && receipt.actionId !== 'create_intent')
      || (operation === 'update_preferences' && receipt.actionId !== 'update_preferences')
      || (operation === 'suppress_type' && receipt.actionId !== 'suppress_type')
      || (operation === 'unsuppress_type' && receipt.actionId !== 'unsuppress_type')
      || (operation === 'record_exposure' && receipt.actionId !== 'record_exposure')
      || (operation === 'recompute_plan' && receipt.actionId !== 'recompute_plan')) {
    throw invalidReceiptError('Stored Decision command receipt operation and action do not agree.');
  }
  if (hasOwn(receipt, 'executionAttemptId')
      && (typeof receipt.executionAttemptId !== 'string'
        || !receipt.executionAttemptId
        || receipt.executionAttemptId.length > 200)) {
    throw invalidReceiptError('Stored Decision command receipt attempt identity is invalid.');
  }
  if ((operation === 'act' || operation === 'snooze' || operation === 'dismiss')
      && typeof receipt.executionAttemptId !== 'string') {
    throw invalidReceiptError('Stored Decision command receipt is missing its execution attempt identity.');
  }
  for (const field of ['requestedRecordVersion', 'resultRecordVersion'] as const) {
    if (hasOwn(receipt, field) && !isPositiveInteger(receipt[field])) {
      throw invalidReceiptError(`Stored Decision command receipt ${field} is invalid.`);
    }
  }
  for (const field of ['requestedContextVersion', 'resultContextVersion'] as const) {
    if (hasOwn(receipt, field)
        && (typeof receipt[field] !== 'string' || !receipt[field] || receipt[field].length > 255)) {
      throw invalidReceiptError(`Stored Decision command receipt ${field} is invalid.`);
    }
  }
  if (typeof receipt.requestedRecordVersion === 'number'
      && typeof receipt.resultRecordVersion === 'number'
      && receipt.resultRecordVersion < receipt.requestedRecordVersion) {
    throw invalidReceiptError('Stored Decision command receipt result predates its requested record version.');
  }
  validateReceiptReadback(receipt);
  validateReceiptVerification(receipt);
  validateSucceededReceiptProof(receipt);
  return deepFreeze(receipt) as unknown as DecisionCommandReceipt;
}

function validateSucceededReceiptProof(receipt: Record<string, unknown>): void {
  if (receipt.status !== 'succeeded') return;
  if (!hasOwn(receipt, 'verification')) {
    throw invalidReceiptError('A successful Decision command receipt requires complete verification evidence.');
  }

  const operation = receipt.operation as DecisionMutationOperation;
  const hasCompactReadbackProof = isPlainObject(receipt.readbackItem)
    && typeof receipt.resultRecordVersion === 'number';
  const hasExecutionProof = EXECUTION_PROOF_OPERATIONS.has(operation)
    && typeof receipt.executionAttemptId === 'string';
  if (ITEM_MUTATION_OPERATIONS.has(operation)
      && !hasCompactReadbackProof
      && !hasExecutionProof) {
    throw invalidReceiptError(
      'A successful Decision item mutation receipt requires compact readback or execution-attempt proof.',
    );
  }

  const isResolvedDefer = operation === 'snooze'
    || (operation === 'review' && receipt.actionId === 'review:defer');
  if (!isResolvedDefer) return;
  const readback = receipt.readbackItem as Record<string, unknown> | undefined;
  if (!readback
      || String(readback.status).toLowerCase() !== 'snoozed'
      || typeof readback.snoozedUntil !== 'string'
      || !Number.isFinite(Date.parse(readback.snoozedUntil))) {
    throw invalidReceiptError(
      'A successful Decision defer receipt requires the resolved snooze instant in compact readback.',
    );
  }
}

function validateReceiptReadback(receipt: Record<string, unknown>): void {
  if (!hasOwn(receipt, 'readbackItem')) return;
  if (!receipt.readbackItem || typeof receipt.readbackItem !== 'object' || Array.isArray(receipt.readbackItem)) {
    throw invalidReceiptError('Stored Decision command receipt readback is invalid.');
  }
  const readback = receipt.readbackItem as Record<string, unknown>;
  const allowed = new Set([
    'decisionId', 'recordVersion', 'contextVersion', 'status', 'snoozedUntil',
    'actionId', 'actionStatus',
  ]);
  if (Object.keys(readback).some((key) => !allowed.has(key))
      || readback.decisionId !== receipt.decisionId
      || !isPositiveInteger(readback.recordVersion)
      || typeof readback.status !== 'string'
      || !readback.status
      || readback.status.length > 100
      || (hasOwn(readback, 'contextVersion')
        && (typeof readback.contextVersion !== 'string'
          || !readback.contextVersion
          || readback.contextVersion.length > 255))
      || (hasOwn(readback, 'snoozedUntil')
        && (typeof readback.snoozedUntil !== 'string'
          || !Number.isFinite(Date.parse(readback.snoozedUntil))))
      || (hasOwn(readback, 'actionId')
        && (typeof readback.actionId !== 'string'
          || readback.actionId !== receipt.actionId
          || readback.actionId.length > 200))
      || (hasOwn(readback, 'actionStatus') && readback.actionStatus !== receipt.status)
      || receipt.resultRecordVersion !== readback.recordVersion
      || (readback.contextVersion == null && receipt.resultContextVersion != null)
      || (readback.contextVersion != null
        && receipt.resultContextVersion !== readback.contextVersion)) {
    throw invalidReceiptError('Stored Decision command receipt readback failed contract validation.');
  }
}

function validateReceiptVerification(receipt: Record<string, unknown>): void {
  if (!hasOwn(receipt, 'verification')) return;
  if (!receipt.verification || typeof receipt.verification !== 'object' || Array.isArray(receipt.verification)) {
    throw invalidReceiptError('Stored Decision command receipt verification is invalid.');
  }
  const verification = receipt.verification as Record<string, unknown>;
  const allowed = new Set(['readBackOk', 'expectedEffect', 'actualEffect', 'message']);
  const expectedMessage = `Decision ${String(receipt.operation)} ${String(receipt.status)}; authoritative readback ${verification.readBackOk ? 'matched' : 'did not match'}.`;
  if (Object.keys(verification).some((key) => !allowed.has(key))
      || typeof verification.readBackOk !== 'boolean'
      || !isPlainObject(verification.expectedEffect)
      || !isPlainObject(verification.actualEffect)
      || typeof verification.message !== 'string'
      || verification.message !== expectedMessage
      || verification.readBackOk !== (receipt.status === 'succeeded')
      || !isBoundedPrivacySafeReceiptEvidence(verification.expectedEffect)
      || !isBoundedPrivacySafeReceiptEvidence(verification.actualEffect)) {
    throw invalidReceiptError('Stored Decision command receipt verification failed contract validation.');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function isBoundedPrivacySafeReceiptEvidence(value: unknown, depth = 0): boolean {
  if (depth > 6) return value === null;
  if (value == null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 500;
  if (Array.isArray(value)) {
    return value.length <= 40
      && value.every((entry) => isBoundedPrivacySafeReceiptEvidence(entry, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 60 && entries.every(([key, entry]) => (
    key.length <= 100
    && !isPrivateEffectKey(key)
    && isBoundedPrivacySafeReceiptEvidence(entry, depth + 1)
  ));
}

function minimizeReceiptVerification(
  verification: DecisionCommandReceiptVerification,
  operation: DecisionMutationOperation,
  status: DecisionCommandReceiptStatus,
): DecisionCommandReceiptVerification {
  return Object.freeze({
    readBackOk: verification.readBackOk,
    expectedEffect: Object.freeze(minimizeReceiptEffect(verification.expectedEffect)),
    actualEffect: Object.freeze(minimizeReceiptEffect(verification.actualEffect)),
    // Receipt copy is deliberately generated here instead of copying an
    // executor/provider message that could contain user-authored text.
    message: `Decision ${operation} ${status}; authoritative readback ${verification.readBackOk ? 'matched' : 'did not match'}.`,
  });
}

function minimizeReceiptEffect(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return minimizeReceiptValue(value, 0) as Record<string, unknown>;
}

function minimizeReceiptValue(value: unknown, depth: number): unknown {
  if (depth > 6) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => minimizeReceiptValue(entry, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isPrivateEffectKey(key))
    .slice(0, 60)
    .map(([key, entry]) => [key, minimizeReceiptValue(entry, depth + 1)]));
}

function isPrivateEffectKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return PRIVATE_EFFECT_KEYS.has(normalized)
    || PRIVATE_EFFECT_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
    || normalized.endsWith('id')
    || normalized.endsWith('key');
}

function projectStoredDecisionMutationCommandContract(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null;
  const operation = typeof value.operation === 'string'
    && DECISION_MUTATION_OPERATIONS.has(value.operation as DecisionMutationOperation)
    ? value.operation as DecisionMutationOperation
    : null;
  if (!operation) return null;
  const rawIdempotencyKey = typeof value.idempotencyKey === 'string'
    ? value.idempotencyKey
    : null;
  const storedIdempotencyKeyHash = typeof value.idempotencyKeyHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.idempotencyKeyHash)
    ? value.idempotencyKeyHash
    : null;
  const idempotencyKeyHash = storedIdempotencyKeyHash
    ?? (rawIdempotencyKey ? decisionIdempotencyKeyHash(rawIdempotencyKey) : null);
  if (!idempotencyKeyHash) return null;

  const approval = isPlainObject(value.approval) ? value.approval : {};
  const execution = isPlainObject(value.execution) ? value.execution : {};
  const readback = isPlainObject(value.readback) ? value.readback : {};
  return deepFreeze({
    ...(typeof value.schemaVersion === 'string' && value.schemaVersion.length <= 100
      ? { schemaVersion: value.schemaVersion }
      : {}),
    operation,
    actionId: typeof value.actionId === 'string' && value.actionId.length <= 200
      ? value.actionId
      : null,
    ...(typeof value.channel === 'string' && value.channel.length <= 40
      ? { channel: value.channel }
      : {}),
    idempotencyKeyHash,
    recordVersion: isPositiveInteger(value.recordVersion) ? value.recordVersion : null,
    contextVersion: typeof value.contextVersion === 'string' && value.contextVersion.length <= 255
      ? value.contextVersion
      : null,
    ...(typeof approval.requiredLevel === 'string' && approval.requiredLevel.length <= 40
      ? { approval: { requiredLevel: approval.requiredLevel } }
      : {}),
    ...(typeof execution.executorId === 'string' && execution.executorId.length <= 200
      ? {
          execution: {
            executorId: execution.executorId,
            ...(typeof execution.strategy === 'string' && execution.strategy.length <= 40
              ? { strategy: execution.strategy }
              : {}),
            ...(typeof execution.riskLevel === 'string' && execution.riskLevel.length <= 40
              ? { riskLevel: execution.riskLevel }
              : {}),
            ...(typeof execution.reversible === 'boolean'
              ? { reversible: execution.reversible }
              : {}),
            ...(typeof execution.supportsIdempotency === 'boolean'
              ? { supportsIdempotency: execution.supportsIdempotency }
              : {}),
          },
        }
      : {}),
    ...(typeof readback.verifierId === 'string' && readback.verifierId.length <= 200
      ? {
          readback: {
            verifierId: readback.verifierId,
            ...(typeof readback.mode === 'string' && readback.mode.length <= 40
              ? { mode: readback.mode }
              : {}),
          },
        }
      : {}),
    ...(typeof value.requestedAt === 'string'
        && value.requestedAt.length <= 40
        && Number.isFinite(Date.parse(value.requestedAt))
      ? { requestedAt: new Date(value.requestedAt).toISOString() }
      : {}),
  });
}

function evidenceToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) return value;
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeReceiptInstant(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw invalidReceiptError('Decision command receipt completion time is invalid.');
  }
  return new Date(parsed).toISOString();
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function invalidReceiptError(message: string, cause?: unknown): DecisionCenterError {
  return new DecisionCenterError(
    'DECISION_COMMAND_RECEIPT_INVALID',
    message,
    500,
    undefined,
    cause instanceof Error ? { cause } : undefined,
  );
}
