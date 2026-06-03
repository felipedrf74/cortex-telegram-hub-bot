// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  findCommandCapability,
  type ChatCoreV2CommandGateVerdict,
} from './chat-core-v2/command-bus';
import {
  executeChatCoreV2Command,
  type ChatCoreV2CommandExecutionResult,
} from './chat-core-v2/command-executor';
import { decisionDismissVersionForItem } from './chat-core-v2/command-status-policy';
import type {
  AICommandEnvelope,
  CommandStatus,
} from './chat-core-v2/types';
import type { DecisionApiItem } from './decision-center';

export const DECISION_COMMAND_ADAPTER_VERSION = 'decision_command_adapter@1.0.0';
export const DECISION_COMMAND_DISMISS_CAPABILITY_ID = 'decision_center.dismiss';
export const DECISION_COMMAND_DISMISS_ACTION_ID = 'dismiss';

const DISMISS_ELIGIBLE_STATUSES = new Set(['unread', 'read']);
const DECISION_COMMAND_TTL_MS = 10 * 60 * 1000;

export type DecisionCommandAdapterErrorCode =
  | 'DECISION_ACTION_NOT_ALLOWED'
  | 'DECISION_EXPIRED'
  | 'DECISION_SUPERSEDED'
  | 'DECISION_READBACK_MISMATCH'
  | 'DECISION_ACTION_FAILED';

export class DecisionCommandAdapterError extends Error {
  code: DecisionCommandAdapterErrorCode;
  status: number;
  details: Record<string, unknown>;

  constructor(
    code: DecisionCommandAdapterErrorCode,
    message: string,
    status = 409,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DecisionCommandAdapterError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface DecisionCommandAdapterResult {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
}

export function isDecisionActionBusEligible(input: {
  actionId: string;
  item?: Pick<DecisionApiItem, 'status'> | null;
}): boolean {
  return input.actionId === DECISION_COMMAND_DISMISS_ACTION_ID
    && DISMISS_ELIGIBLE_STATUSES.has(String(input.item?.status ?? ''));
}

export function buildDecisionCommandEnvelope(input: {
  item: DecisionApiItem;
  actionId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  now?: Date;
}): AICommandEnvelope<Record<string, unknown>> {
  if (!isDecisionActionBusEligible({ actionId: input.actionId, item: input.item })) {
    throw new DecisionCommandAdapterError(
      'DECISION_ACTION_NOT_ALLOWED',
      'Decision action is not eligible for Command Bus execution.',
      400,
      { actionId: input.actionId, status: input.item.status },
    );
  }

  const now = input.now ?? new Date();
  const decisionVersion = decisionDismissVersionForItem(input.item);
  const entityId = `decision:${input.item.decisionId}`;
  const permissionSnapshotVersion = `decision-center-permissions:${input.tenantId}:${input.userId}:decision_center:v1`;
  const commandId = commandIdFor(input.item.decisionId, input.actionId, input.idempotencyKey);

  return {
    commandId,
    commandSchemaVersion: 'decision_center.dismiss@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.tenantId),
    userId: String(input.userId),
    domain: 'decision_center',
    commandType: 'decision_center.dismiss',
    origin: 'decision_center',
    payload: {
      operation: 'dismiss',
      actionId: input.actionId,
      decisionId: input.item.decisionId,
      currentStatus: input.item.status,
      targetStatus: 'dismissed',
      sourceSkill: input.item.sourceSkill,
      type: input.item.type,
      urgency: input.item.urgency,
    },
    basedOn: {
      entityIds: [entityId],
      entityVersions: {
        [entityId]: decisionVersion,
      },
      contextHash: contextHashFor(input.item.decisionId, input.actionId, decisionVersion),
      createdAt: now.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {
        [entityId]: decisionVersion,
      },
      requiredPermissionsVersion: permissionSnapshotVersion,
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be dismissible when the command executes.',
        check: 'decision_is_active',
      }],
    },
    authorization: {
      actorUserId: String(input.userId),
      tenantId: String(input.tenantId),
      actingSurface: 'system_automation',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion,
      authTime: now.toISOString(),
    },
    expiresAt: commandExpiresAt(now, input.item.expiresAt),
    idempotencyKey: input.idempotencyKey,
  };
}

export async function runDecisionActionViaCommandBus(input: {
  item: DecisionApiItem;
  actionId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  locale?: string | null;
  now?: Date;
}): Promise<DecisionCommandAdapterResult> {
  const now = input.now ?? new Date();
  const command = buildDecisionCommandEnvelope({ ...input, now });
  const capability = findCommandCapability(command);
  if (!capability || capability.capabilityId !== DECISION_COMMAND_DISMISS_CAPABILITY_ID) {
    throw new DecisionCommandAdapterError(
      'DECISION_ACTION_NOT_ALLOWED',
      'Decision Command Bus capability is unavailable.',
      409,
      {
        actionId: input.actionId,
        commandType: command.commandType,
        capabilityId: capability?.capabilityId ?? null,
      },
    );
  }

  const result = await executeChatCoreV2Command({
    command,
    capabilityId: capability.capabilityId,
    userId: input.userId,
    tenantId: input.tenantId,
    locale: input.locale,
    now,
  });
  if (!result.ok || result.status !== 'verified') {
    throw adapterErrorForExecution(result);
  }

  return {
    readBackOk: true,
    expectedEffect: {
      decisionStatus: 'dismissed',
      viaCommandBus: true,
      commandType: command.commandType,
      capabilityId: capability.capabilityId,
      adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
    },
    actualEffect: {
      decisionStatus: 'dismissed',
      viaCommandBus: true,
      commandBusOutcomeRecorded: true,
      commandStatus: result.status,
      commandId: result.commandId,
      capabilityId: capability.capabilityId,
      dismissedDecisionId: result.dismissedDecisionId ?? input.item.decisionId,
      adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
    },
    message: result.response?.text || 'Decision was declined/dismissed through Command Bus.',
  };
}

function adapterErrorForExecution(result: ChatCoreV2CommandExecutionResult): DecisionCommandAdapterError {
  const gate = result.gateVerdict;
  const code = codeForGate(gate, result.status, result.reason);
  const status = code === 'DECISION_EXPIRED' || code === 'DECISION_SUPERSEDED' || code === 'DECISION_READBACK_MISMATCH'
    ? 409
    : code === 'DECISION_ACTION_NOT_ALLOWED'
      ? 400
      : 500;
  return new DecisionCommandAdapterError(
    code,
    messageForCode(code),
    status,
    {
      adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
      commandId: result.commandId,
      capabilityId: result.capabilityId ?? null,
      commandStatus: result.status,
      commandBusReason: result.reason ?? null,
      gateReason: gate.reason ?? null,
      missingScopes: gate.missingScopes ?? [],
      staleEntities: gate.staleEntities ?? [],
      failedInvariants: gate.failedInvariants ?? [],
    },
  );
}

function codeForGate(
  gate: ChatCoreV2CommandGateVerdict,
  status: CommandStatus,
  reason?: string,
): DecisionCommandAdapterErrorCode {
  if (gate.reason === 'expired' || status === 'expired') return 'DECISION_EXPIRED';
  if (gate.reason === 'stale_entity_version' || gate.reason === 'decision_version_changed' || status === 'stale') {
    return 'DECISION_SUPERSEDED';
  }
  if (status === 'verification_failed' || reason === 'verification_failed') return 'DECISION_READBACK_MISMATCH';
  if (
    gate.reason === 'missing_delegated_scope'
    || gate.reason === 'invariant_failed'
    || gate.reason === 'wrong_actor'
    || gate.reason === 'wrong_tenant'
    || gate.reason === 'acting_surface_not_allowed'
    || gate.reason === 'unknown_command'
    || gate.reason === 'capability_not_executable'
    || gate.reason === 'restricted_command'
  ) {
    return 'DECISION_ACTION_NOT_ALLOWED';
  }
  return 'DECISION_ACTION_FAILED';
}

function messageForCode(code: DecisionCommandAdapterErrorCode): string {
  if (code === 'DECISION_EXPIRED') return 'Decision expired and can no longer be actioned.';
  if (code === 'DECISION_SUPERSEDED') return 'Decision was superseded by newer state.';
  if (code === 'DECISION_READBACK_MISMATCH') return 'Decision action read-back verification failed.';
  if (code === 'DECISION_ACTION_NOT_ALLOWED') return 'That action is not available for this decision.';
  return 'Decision action failed verification.';
}

function commandExpiresAt(now: Date, decisionExpiresAt?: string | null): string {
  const fallbackMs = now.getTime() + DECISION_COMMAND_TTL_MS;
  const decisionMs = typeof decisionExpiresAt === 'string' ? Date.parse(decisionExpiresAt) : NaN;
  const expiresMs = Number.isFinite(decisionMs) && decisionMs > now.getTime()
    ? Math.min(fallbackMs, decisionMs)
    : fallbackMs;
  return DateTime.fromMillis(expiresMs, { zone: 'utc' }).toISO() ?? new Date(expiresMs).toISOString();
}

function commandIdFor(decisionId: string, actionId: string, idempotencyKey: string): string {
  return `cmd_decision_${safeToken(actionId)}_${sha256Hex({ decisionId, actionId, idempotencyKey }).slice(0, 16)}`;
}

function contextHashFor(decisionId: string, actionId: string, decisionVersion: string): string {
  return `decision-center:${sha256Hex({ decisionId, actionId, decisionVersion }).slice(0, 32)}`;
}

function safeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^0-9a-z]+/g, '_').replace(/^_+|_+$/g, '') || 'action';
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
