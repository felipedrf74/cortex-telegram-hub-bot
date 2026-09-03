// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { getDb } from '../database';
import type { DecisionCommandReceipt, DecisionMutationCommand } from './contracts';
import {
  createDecisionCommandReceipt,
  decisionCommandReceiptId,
  persistDecisionCommandReceipt,
  readDecisionCommandReceipt,
} from './command-response-receipts';
import { DecisionCenterError } from './errors';

export const DECISION_MUTATION_RECEIPT_SCHEMA_VERSION = 'decision_mutation_receipt@1.0.0' as const;

interface StoredMutationReceipt<Result> {
  readonly schemaVersion: typeof DECISION_MUTATION_RECEIPT_SCHEMA_VERSION;
  readonly commandSchemaVersion: DecisionMutationCommand['schemaVersion'];
  readonly operation: DecisionMutationCommand['operation'];
  readonly resourceId: string;
  readonly requestHash: string;
  readonly result: Result;
}

interface StoredMutationReceiptRow<Result> {
  readonly receipt: StoredMutationReceipt<Result>;
  readonly createdAt: string;
}

export interface DecisionMutationReceiptResult<Result> {
  readonly result: Result;
  readonly idempotent: boolean;
  readonly commandReceipt?: DecisionCommandReceipt;
}

/**
 * Execute one synchronous Decision mutation and persist its exact readback in
 * the existing lifecycle ledger in the same transaction. A replay with the
 * same key returns the prior result; a key reused for a different command is
 * rejected instead of executing either payload ambiguously.
 */
export function executeDecisionMutationWithReceipt<Result>(
  command: DecisionMutationCommand,
  mutate: () => Result,
): DecisionMutationReceiptResult<Result> {
  const db = getDb();
  const eventId = receiptEventId(command);
  const requestHash = commandRequestHash(command);

  return db.transaction(() => {
    const existing = readReceipt<Result>(eventId, command.scope.userId, command.scope.tenantId);
    if (existing) return replayReceipt(existing, command, requestHash);

    const result = mutate();
    const receipt: StoredMutationReceipt<Result> = {
      schemaVersion: DECISION_MUTATION_RECEIPT_SCHEMA_VERSION,
      commandSchemaVersion: command.schemaVersion,
      operation: command.operation,
      resourceId: command.decisionId,
      requestHash,
      result,
    };
    db.prepare(`
      INSERT INTO decision_lifecycle_events (
        event_id, decision_id, user_id, tenant_id, event, action_id,
        reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'mutation_receipt', ?, 'idempotent_command_receipt', ?, ?)
    `).run(
      eventId,
      command.decisionId,
      command.scope.userId,
      command.scope.tenantId,
      command.operation,
      JSON.stringify(receipt),
      command.requestedAt,
    );
    const commandReceipt = persistResponseReceipt(
      command,
      result,
      requestHash,
      new Date().toISOString(),
    );
    return Object.freeze({ result, idempotent: false, commandReceipt });
  })();
}

function replayReceipt<Result>(
  row: StoredMutationReceiptRow<Result>,
  command: DecisionMutationCommand,
  requestHash: string,
): DecisionMutationReceiptResult<Result> {
  const { receipt } = row;
  const compatibleIdentity = matchingStoredIdentity(receipt, command, requestHash);
  if (receipt.schemaVersion !== DECISION_MUTATION_RECEIPT_SCHEMA_VERSION
    || receipt.commandSchemaVersion !== command.schemaVersion
    || receipt.operation !== command.operation
    || !compatibleIdentity) {
    throw new DecisionCenterError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different Decision Center mutation.',
      409,
      { operation: command.operation },
    );
  }
  const existingCommandReceipt = readDecisionCommandReceipt(
    responseReceiptId(command),
    command.decisionId,
    command.scope.userId,
    command.scope.tenantId,
  );
  // Predecessor binaries persisted the exact mutation result but did not yet
  // create the additive command-response receipt. Exact replay upgrades that
  // row in the same transaction, bound to the current opaque resource
  // identity; the domain mutation is never executed again.
  const commandReceipt = existingCommandReceipt ?? persistResponseReceipt(
    command,
    receipt.result,
    receipt.requestHash,
    row.createdAt,
  );
  return Object.freeze({
    result: receipt.result,
    idempotent: true,
    ...(commandReceipt ? { commandReceipt } : {}),
  });
}

function persistResponseReceipt<Result>(
  command: DecisionMutationCommand,
  result: Result,
  requestHash: string,
  completedAt: string,
): DecisionCommandReceipt {
  return persistDecisionCommandReceipt({
    receipt: createDecisionCommandReceipt({
      receiptId: responseReceiptId(command),
      decisionId: command.decisionId,
      operation: command.operation,
      actionId: command.actionId,
      idempotencyKey: command.idempotencyKey,
      status: 'succeeded',
      completedAt,
      requestedRecordVersion: command.recordVersion,
      requestedContextVersion: command.contextVersion,
      verification: {
        readBackOk: true,
        expectedEffect: { requestHash },
        actualEffect: {
          resultHash: createHash('sha256').update(stableJson(result)).digest('hex'),
        },
        message: 'The exact mutation result was committed with its replay receipt.',
      },
    }),
    userId: command.scope.userId,
    tenantId: command.scope.tenantId,
  });
}

function matchingStoredIdentity<Result>(
  receipt: StoredMutationReceipt<Result>,
  command: DecisionMutationCommand,
  requestHash: string,
): boolean {
  if (receipt.resourceId === command.decisionId && receipt.requestHash === requestHash) return true;
  return compatibleLegacyResourceIds(command).some((resourceId) => (
    receipt.resourceId === resourceId
    && receipt.requestHash === commandRequestHash(commandWithResourceIdentity(command, resourceId))
  ));
}

function compatibleLegacyResourceIds(command: DecisionMutationCommand): string[] {
  if (command.operation === 'update_preferences' && command.decisionId === 'decision-preferences') {
    return [`decision-preferences:${command.scope.tenantId}:${command.scope.userId}`];
  }
  if ((command.operation === 'suppress_type' || command.operation === 'unsuppress_type')
      && command.decisionId.startsWith('decision-suppression:')) {
    const sourceSkill = command.payload.sourceSkill;
    const type = command.payload.type;
    const recipe = command.payload.recipe;
    if (typeof sourceSkill === 'string' && sourceSkill
        && typeof type === 'string' && type
        && (recipe == null || typeof recipe === 'string')) {
      return [`decision-suppression:${sourceSkill}:${type}:${recipe || '*'}`];
    }
  }
  return [];
}

function commandWithResourceIdentity(
  command: DecisionMutationCommand,
  decisionId: string,
): DecisionMutationCommand {
  return {
    ...command,
    decisionId,
    readback: {
      ...command.readback,
      entityId: decisionId,
    },
  };
}

function responseReceiptId(command: DecisionMutationCommand): string {
  return decisionCommandReceiptId({
    decisionId: command.decisionId,
    operation: command.operation,
    actionId: command.actionId,
    userId: command.scope.userId,
    tenantId: command.scope.tenantId,
    idempotencyKey: command.idempotencyKey,
  });
}

function readReceipt<Result>(
  eventId: string,
  userId: number,
  tenantId: number,
): StoredMutationReceiptRow<Result> | null {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson, created_at AS createdAt
      FROM decision_lifecycle_events
     WHERE event_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'mutation_receipt' AND reason = 'idempotent_command_receipt'
     LIMIT 1
  `).get(eventId, userId, tenantId) as { metadataJson: string; createdAt: string } | undefined;
  if (!row) return null;
  try {
    return {
      receipt: JSON.parse(row.metadataJson) as StoredMutationReceipt<Result>,
      createdAt: row.createdAt,
    };
  } catch (cause) {
    throw new DecisionCenterError(
      'DECISION_MUTATION_RECEIPT_INVALID',
      'The stored Decision Center mutation receipt is invalid.',
      500,
      undefined,
      cause instanceof Error ? { cause } : undefined,
    );
  }
}

function receiptEventId(command: DecisionMutationCommand): string {
  return `decision-command-${createHash('sha256')
    .update(`${command.scope.tenantId}:${command.scope.userId}:${command.operation}:${command.idempotencyKey}`)
    .digest('hex')}`;
}

function commandRequestHash(command: DecisionMutationCommand): string {
  return createHash('sha256').update(stableJson({
    decisionId: command.decisionId,
    operation: command.operation,
    actionId: command.actionId,
    scope: command.scope,
    channel: command.channel,
    recordVersion: command.recordVersion,
    contextVersion: command.contextVersion,
    approval: command.approval,
    execution: command.execution,
    readback: command.readback,
    payload: command.payload,
  })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
