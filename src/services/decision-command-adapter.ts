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
import {
  decisionActionVersionForItem,
  decisionDismissVersionForItem,
} from './chat-core-v2/command-status-policy';
import type {
  AICommandEnvelope,
  CommandStatus,
} from './chat-core-v2/types';
import type { DecisionApiItem } from './decision-center';
import {
  contentApprovalVersionForObject,
  directOwnedContentObjectForDecision,
  type DecisionContentCommandAction,
} from './decision-command-effects';

export const DECISION_COMMAND_ADAPTER_VERSION = 'decision_command_adapter@1.1.0';
export const DECISION_COMMAND_DISMISS_CAPABILITY_ID = 'decision_center.dismiss';
export const DECISION_COMMAND_DISMISS_ACTION_ID = 'dismiss';
export const DECISION_COMMAND_FIXER_CAPABILITY_ID = 'decision_center.accept_chat_action_fix';
export const DECISION_COMMAND_FIXER_ACTION_ID = 'accept_chat_action_fix';
export const DECISION_COMMAND_CONTENT_CAPABILITY_IDS = Object.freeze({
  approve_script: 'content.approve_script',
  request_rewrite: 'content.request_rewrite',
} satisfies Record<DecisionContentCommandAction, string>);

const DISMISS_ELIGIBLE_STATUSES = new Set(['unread', 'read']);
const DOMAIN_ACTION_ELIGIBLE_STATUSES = new Set(['unread', 'read', 'failed', 'snoozed']);
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
  item?: Pick<DecisionApiItem, 'status' | 'sourceSkill' | 'relatedEntities' | 'actions'> | null;
}): boolean {
  const item = input.item;
  if (!item) return false;
  if (input.actionId === DECISION_COMMAND_DISMISS_ACTION_ID) {
    return DISMISS_ELIGIBLE_STATUSES.has(String(item.status ?? ''));
  }
  if (!Array.isArray(item.actions) || !item.actions.some((action) => action.id === input.actionId)) return false;
  if (!DOMAIN_ACTION_ELIGIBLE_STATUSES.has(String(item.status ?? ''))) return false;
  if (isContentCommandAction(input.actionId)) {
    return item.sourceSkill === 'content'
      && item.relatedEntities.some((entity) => entity.type === 'content_workflow_object' && !!entity.id);
  }
  if (input.actionId === DECISION_COMMAND_FIXER_ACTION_ID) {
    return item.sourceSkill === 'chat'
      && item.relatedEntities.some((entity) => entity.type === 'chat_action_fixer_review' && !!entity.id);
  }
  return false;
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
  const contract = commandContractFor(input);
  const permissionSnapshotVersion = `decision-center-permissions:${input.tenantId}:${input.userId}:${contract.capabilityId}:v1`;
  const commandId = commandIdFor(input.item.decisionId, input.actionId, input.idempotencyKey);

  return {
    commandId,
    commandSchemaVersion: `${contract.commandType}@1.0.0`,
    previewSchemaVersion: contract.previewSchemaVersion,
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.tenantId),
    userId: String(input.userId),
    domain: contract.domain,
    commandType: contract.commandType,
    origin: 'decision_center',
    payload: contract.payload,
    basedOn: {
      entityIds: Object.keys(contract.entityVersions),
      entityVersions: contract.entityVersions,
      contextHash: contextHashFor(input.item.decisionId, input.actionId, contract.entityVersions),
      createdAt: now.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: contract.entityVersions,
      requiredPermissionsVersion: permissionSnapshotVersion,
      requiredDecisionVersion: contract.decisionVersion,
      invariants: contract.invariants,
    },
    authorization: {
      actorUserId: String(input.userId),
      tenantId: String(input.tenantId),
      actingSurface: 'system_automation',
      delegatedScopes: contract.delegatedScopes,
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
  const expectedCapabilityId = capabilityIdForAction(input.actionId);
  if (!capability || capability.capabilityId !== expectedCapabilityId) {
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

  const translated = translatedEffects(input.actionId, input.item, command, capability.capabilityId, result);
  return {
    readBackOk: true,
    expectedEffect: translated.expectedEffect,
    actualEffect: translated.actualEffect,
    message: result.response?.text || translated.fallbackMessage,
  };
}

function commandContractFor(input: {
  item: DecisionApiItem;
  actionId: string;
  userId: number;
  tenantId: number;
}): {
  capabilityId: string;
  domain: 'decision_center' | 'content';
  commandType: string;
  previewSchemaVersion: string;
  decisionVersion: string;
  entityVersions: Record<string, string>;
  payload: Record<string, unknown>;
  invariants: AICommandEnvelope<Record<string, unknown>>['preconditions']['invariants'];
  delegatedScopes: string[];
} {
  const decisionEntityId = `decision:${input.item.decisionId}`;
  const commonPayload = {
    actionId: input.actionId,
    decisionId: input.item.decisionId,
    currentStatus: input.item.status,
    sourceSkill: input.item.sourceSkill,
    type: input.item.type,
    urgency: input.item.urgency,
  };

  if (input.actionId === DECISION_COMMAND_DISMISS_ACTION_ID) {
    const decisionVersion = decisionDismissVersionForItem(input.item);
    return {
      capabilityId: DECISION_COMMAND_DISMISS_CAPABILITY_ID,
      domain: 'decision_center',
      commandType: 'decision_center.dismiss',
      previewSchemaVersion: 'decision_preview_card@1.0.0',
      decisionVersion,
      entityVersions: { [decisionEntityId]: decisionVersion },
      payload: { ...commonPayload, operation: 'dismiss', targetStatus: 'dismissed' },
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be dismissible when the command executes.',
        check: 'decision_is_active',
      }],
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
    };
  }

  const decisionVersion = decisionActionVersionForItem(input.item);
  if (isContentCommandAction(input.actionId)) {
    const object = directOwnedContentObjectForDecision(input.item, input.userId, input.tenantId);
    if (!object) {
      throw new DecisionCommandAdapterError(
        'DECISION_ACTION_NOT_ALLOWED',
        'Content approval is not eligible for Command Bus execution.',
        409,
        { actionId: input.actionId, reason: 'direct_private_owner_target_required' },
      );
    }
    const contentEntityId = `content_workflow_object:${object.id}`;
    const contentVersion = contentApprovalVersionForObject(object);
    const commandType = DECISION_COMMAND_CONTENT_CAPABILITY_IDS[input.actionId];
    return {
      capabilityId: commandType,
      domain: 'content',
      commandType,
      previewSchemaVersion: 'content_brief_preview_card@1.0.0',
      decisionVersion,
      entityVersions: {
        [decisionEntityId]: decisionVersion,
        [contentEntityId]: contentVersion,
      },
      payload: {
        ...commonPayload,
        operation: input.actionId === 'approve_script' ? 'approve' : 'request_rewrite',
        contentObjectId: object.id,
        currentApprovalState: object.approvalState,
        targetApprovalState: input.actionId === 'approve_script' ? 'approved' : 'rejected',
      },
      invariants: [
        {
          type: 'decision_status',
          description: 'Decision must still be active when the content action executes.',
          check: 'decision_is_active',
        },
        {
          type: 'content_owner_scope',
          description: 'Content object must remain private and owned by the authenticated actor.',
          check: 'content_object_is_direct_private_owner_target',
        },
      ],
      delegatedScopes: ['decision_center:read', 'decision_center:write', 'content:read', 'content:write'],
    };
  }

  if (input.actionId === DECISION_COMMAND_FIXER_ACTION_ID) {
    return {
      capabilityId: DECISION_COMMAND_FIXER_CAPABILITY_ID,
      domain: 'decision_center',
      commandType: 'decision_center.accept_chat_action_fix',
      previewSchemaVersion: 'decision_preview_card@1.0.0',
      decisionVersion,
      entityVersions: { [decisionEntityId]: decisionVersion },
      payload: {
        ...commonPayload,
        operation: 'accept_projection_only_correction',
        targetStatus: 'actioned',
        providerActionExecuted: false,
        freshConfirmationRequired: true,
      },
      invariants: [
        {
          type: 'decision_status',
          description: 'Decision must still be active when the correction is accepted.',
          check: 'decision_is_active',
        },
        {
          type: 'projection_only',
          description: 'Correction acceptance records review state and must never execute a provider action.',
          check: 'chat_fixer_is_projection_only',
        },
      ],
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
    };
  }

  throw new DecisionCommandAdapterError(
    'DECISION_ACTION_NOT_ALLOWED',
    'Decision action is not eligible for Command Bus execution.',
    400,
    { actionId: input.actionId },
  );
}

function translatedEffects(
  actionId: string,
  item: DecisionApiItem,
  command: AICommandEnvelope<Record<string, unknown>>,
  capabilityId: string,
  result: ChatCoreV2CommandExecutionResult,
): {
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  fallbackMessage: string;
} {
  const commonExpected = {
    viaCommandBus: true,
    commandType: command.commandType,
    capabilityId,
    adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
  };
  const commonActual = {
    viaCommandBus: true,
    commandBusOutcomeRecorded: true,
    commandStatus: result.status,
    commandId: result.commandId,
    capabilityId,
    adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
  };
  if (actionId === DECISION_COMMAND_DISMISS_ACTION_ID) {
    return {
      expectedEffect: { decisionStatus: 'dismissed', ...commonExpected },
      actualEffect: {
        decisionStatus: 'dismissed',
        dismissedDecisionId: result.dismissedDecisionId ?? item.decisionId,
        decisionOutcomeRecorded: true,
        ...commonActual,
      },
      fallbackMessage: 'Decision was declined/dismissed through Command Bus.',
    };
  }
  if (isContentCommandAction(actionId)) {
    const expectedApprovalState = actionId === 'approve_script' ? 'approved' : 'rejected';
    return {
      expectedEffect: {
        decisionStatus: 'actioned',
        contentApprovalState: expectedApprovalState,
        ...commonExpected,
      },
      actualEffect: {
        decisionStatus: 'actioned',
        actionedDecisionId: result.actionedDecisionId ?? item.decisionId,
        contentObjectId: result.contentObjectId,
        contentApprovalState: result.contentApprovalState ?? expectedApprovalState,
        providerActionExecuted: false,
        ...commonActual,
      },
      fallbackMessage: actionId === 'approve_script' ? 'Content was approved.' : 'Changes were requested.',
    };
  }
  return {
    expectedEffect: { decisionStatus: 'actioned', providerActionExecuted: false, ...commonExpected },
    actualEffect: {
      decisionStatus: 'actioned',
      actionedDecisionId: result.actionedDecisionId ?? item.decisionId,
      providerActionExecuted: false,
      freshConfirmationRequired: result.freshConfirmationRequired !== false,
      ...commonActual,
    },
    fallbackMessage: 'Chat action correction was accepted for a fresh confirmation.',
  };
}

function capabilityIdForAction(actionId: string): string | null {
  if (actionId === DECISION_COMMAND_DISMISS_ACTION_ID) return DECISION_COMMAND_DISMISS_CAPABILITY_ID;
  if (actionId === DECISION_COMMAND_FIXER_ACTION_ID) return DECISION_COMMAND_FIXER_CAPABILITY_ID;
  if (isContentCommandAction(actionId)) return DECISION_COMMAND_CONTENT_CAPABILITY_IDS[actionId];
  return null;
}

function isContentCommandAction(actionId: string): actionId is DecisionContentCommandAction {
  return actionId === 'approve_script' || actionId === 'request_rewrite';
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
    || gate.reason === 'permission_version_changed'
    || gate.reason === 'tenant_policy_version_changed'
    || gate.reason === 'integration_connection_version_changed'
    || gate.reason === 'auth_time_invalid'
    || gate.reason === 'auth_time_expired'
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

function contextHashFor(decisionId: string, actionId: string, entityVersions: Record<string, string>): string {
  return `decision-center:${sha256Hex({ decisionId, actionId, entityVersions }).slice(0, 32)}`;
}

function safeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^0-9a-z]+/g, '_').replace(/^_+|_+$/g, '') || 'action';
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
