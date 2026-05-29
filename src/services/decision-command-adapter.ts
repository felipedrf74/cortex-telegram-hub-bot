// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center → Chat Core v2 Command Bus adapter (flag-gated, OFF by default).
 *
 * Routes a Decision Center action through the COMMITTED Command Bus instead of the
 * legacy in-module executors, WITHOUT editing any src/services/chat-core-v2/** file —
 * it only CALLS committed exports. Activation is gated by
 * DECISION_CENTER_COMMAND_BUS_ENABLED (default OFF, scoped per user/tenant).
 *
 * The envelope is built so the executor's LIVE-recomputed execute-gate matches:
 * requiredEntityVersions + requiredDecisionVersion are derived from the SAME
 * decisionDismissVersionForItem() the executor's snapshot uses, and the
 * `decision_is_active` invariant resolves true while the decision is dismiss-eligible.
 *
 * See docs/decision-center/command-bus-integration-wo.md for the cutover plan and the
 * API assumptions Codex must confirm before any flag flip.
 */

import type { AICommandEnvelope } from './chat-core-v2/types';
import { executeChatCoreV2Command } from './chat-core-v2/command-executor';
import type { ChatCoreV2CommandExecutionResult } from './chat-core-v2/command-executor';
import { getChatCoreV2Capability } from './chat-core-v2/capability-registry';
import { decisionDismissVersionForItem, isDecisionDismissEligibleStatus } from './chat-core-v2/command-status-policy';
import { hashStable } from './chat-core-v2/deterministic-read/common';
import { DecisionActionError } from './decision-center';
import type { DecisionApiItem } from './decision-center';
import type { NotificationActionButton } from './notification-orchestrator';

export const DECISION_COMMAND_ADAPTER_VERSION = 'decision_command_adapter@1.0.0';
const COMMAND_TTL_MS = 10 * 60 * 1000;

/** Decision action ids eligible to route through the committed Command Bus (dismiss family for now). */
const DECISION_ACTION_TO_CAPABILITY: Record<string, string> = {
  dismiss: 'decision_center.dismiss',
  not_now: 'decision_center.dismiss',
  reject_reflow: 'decision_center.dismiss',
};

export interface DecisionAdapterOutcome {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
}

export function isDecisionActionBusEligible(actionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(DECISION_ACTION_TO_CAPABILITY, actionId);
}

/** Build the dismiss command envelope (origin 'decision_center') that matches the executor's live gate snapshot. */
export function buildDecisionDismissEnvelope(
  item: DecisionApiItem,
  userId: number,
  tenantId: number,
  now: Date,
): AICommandEnvelope<Record<string, unknown>> {
  const entityId = `decision:${item.decisionId}`;
  const decisionVersion = decisionDismissVersionForItem(item);
  const createdAt = now.toISOString();
  const payload = {
    operation: 'dismiss',
    decisionId: item.decisionId,
    title: item.title,
    currentStatus: item.status,
    targetStatus: 'dismissed',
    sourceSkill: item.sourceSkill,
    type: item.type,
    urgency: item.urgency,
    recommendedActionLabel: item.recommendedActionLabel,
  };
  const requiredEntityVersions = { [entityId]: decisionVersion };
  const permissionSnapshotVersion = `decision-center-permissions:${tenantId}:${userId}:decision_center:v1`;
  const commandId = `cmd_${hashStable({ origin: 'decision_center', tenantId, userId, decisionId: item.decisionId, decisionVersion })}`;
  return {
    commandId,
    commandSchemaVersion: 'decision_center.dismiss@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(tenantId),
    userId: String(userId),
    domain: 'decision_center',
    commandType: 'decision_center.dismiss',
    origin: 'decision_center',
    payload,
    basedOn: {
      entityIds: [entityId],
      entityVersions: requiredEntityVersions,
      contextHash: hashStable({ adapter: DECISION_COMMAND_ADAPTER_VERSION, payload }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions,
      requiredPermissionsVersion: permissionSnapshotVersion,
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be dismissible when the command executes.',
        check: 'decision_is_active',
      }],
    },
    authorization: {
      actorUserId: String(userId),
      tenantId: String(tenantId),
      actingSurface: 'system_automation',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion,
      authTime: createdAt,
    },
    expiresAt: new Date(now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `decision-center:${tenantId}:${userId}:decision_center.dismiss:${item.decisionId}:${commandId}`,
  };
}

/** Translate a bus failure into the existing DecisionActionError codes so the legacy catch path fires identically. */
function mapBusFailureToError(result: ChatCoreV2CommandExecutionResult): DecisionActionError {
  if (result.status === 'verification_failed') {
    return new DecisionActionError('DECISION_READBACK_MISMATCH', 'Command bus could not verify the decision mutation.', 409, { busStatus: result.status });
  }
  const reason = result.gateVerdict?.reason ?? result.reason ?? 'command_gate_rejected';
  switch (reason) {
    case 'stale_entity_version':
    case 'decision_version_changed':
      return new DecisionActionError('DECISION_SUPERSEDED', 'Decision changed before the action completed.', 409, { reason });
    case 'invariant_failed':
      return new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'Decision is no longer in an actionable state.', 409, { reason });
    case 'expired':
      return new DecisionActionError('DECISION_ACTION_EXPIRED', 'The command expired before execution.', 409, { reason });
    case 'missing_delegated_scope':
      return new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'Missing permission to act on this decision.', 409, { reason });
    default:
      return new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action could not be completed via the command bus.', 409, { reason });
  }
}

/**
 * Route a (dismiss-family) decision action through the committed Command Bus and translate the
 * result back into the legacy executeDecisionAction 4-field contract. Throws a mapped
 * DecisionActionError on gate/verification failure so performDecisionAction's existing
 * catch / markExecutionFailed / markDecisionFailed path fires identically to legacy.
 */
export async function runDecisionActionViaCommandBus(
  item: DecisionApiItem,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  now: Date = new Date(),
): Promise<DecisionAdapterOutcome> {
  const capabilityId = DECISION_ACTION_TO_CAPABILITY[action.id];
  if (!capabilityId) {
    throw new DecisionActionError('UNSUPPORTED_DECISION_ACTION', 'Action is not command-bus eligible.', 409, { actionId: action.id });
  }
  // Conservative pre-check mirroring the bus invariant; the executor re-checks the live status.
  if (!isDecisionDismissEligibleStatus(item.status)) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'Decision is not in a dismissible state.', 409, { status: item.status });
  }
  if (!getChatCoreV2Capability(capabilityId)) {
    throw new DecisionActionError('DECISION_ACTION_FAILED', 'Command capability is not registered.', 409, { capabilityId });
  }
  const command = buildDecisionDismissEnvelope(item, userId, tenantId, now);
  const result = await executeChatCoreV2Command({ command, capabilityId, userId, tenantId, now });
  if (!result.ok || result.status !== 'verified') {
    throw mapBusFailureToError(result);
  }
  return {
    readBackOk: true,
    expectedEffect: { decisionStatus: 'dismissed', via: 'command_bus', capabilityId },
    actualEffect: { decisionStatus: 'dismissed', dismissedDecisionId: result.dismissedDecisionId ?? item.decisionId, commandId: result.commandId },
    message: 'Decision was dismissed via the Chat Core v2 command bus.',
  };
}
