// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { listChatCoreV2CapabilitiesByDomain } from './capability-registry';
import type {
  AICommandEnvelope,
  CapabilityDefinition,
  CommandStatus,
} from './types';

export const CHAT_CORE_V2_COMMAND_BUS_GATE_VERSION = 'chat_core_v2_command_bus_gate@1.0.0';

export type ChatCoreV2CommandOperation = 'preview' | 'execute';

export type ChatCoreV2CommandRejectionReason =
  | 'unknown_command'
  | 'capability_not_previewable'
  | 'capability_not_executable'
  | 'restricted_command'
  | 'expired'
  | 'wrong_actor'
  | 'wrong_tenant'
  | 'missing_delegated_scope'
  | 'stale_entity_version'
  | 'permission_version_changed'
  | 'tenant_policy_version_changed'
  | 'integration_connection_version_changed'
  | 'decision_version_changed'
  | 'invariant_failed';

export interface ChatCoreV2CommandGateSnapshot {
  actorUserId: string;
  tenantId: string;
  delegatedScopes?: string[];
  currentEntityVersions?: Record<string, string>;
  permissionSnapshotVersion?: string;
  tenantPolicyVersion?: string;
  integrationConnectionVersion?: string;
  decisionVersion?: string;
  invariantResults?: Record<string, boolean>;
  now?: Date;
}

export interface ChatCoreV2CommandGateVerdict {
  ok: boolean;
  operation: ChatCoreV2CommandOperation;
  gateVersion: string;
  commandStatus: CommandStatus;
  capabilityId?: string;
  reason?: ChatCoreV2CommandRejectionReason;
  missingScopes?: string[];
  staleEntities?: Array<{
    entityId: string;
    expectedVersion: string;
    actualVersion?: string;
  }>;
  failedInvariants?: string[];
}

export function evaluateChatCoreV2CommandBusGate(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2CommandGateSnapshot,
  operation: ChatCoreV2CommandOperation,
): ChatCoreV2CommandGateVerdict {
  const identityVerdict = evaluateIdentity(envelope, snapshot, operation);
  if (identityVerdict) return identityVerdict;

  const expiredVerdict = evaluateExpiry(envelope, snapshot, operation);
  if (expiredVerdict) return expiredVerdict;

  const capability = findCommandCapability(envelope);
  if (!capability) {
    return rejected(operation, 'unknown_command', 'rejected_by_policy');
  }

  const capabilityVerdict = evaluateCapabilityOperation(capability, operation);
  if (capabilityVerdict) return capabilityVerdict;

  const scopeVerdict = evaluateDelegatedScopes(envelope, snapshot, capability, operation);
  if (scopeVerdict) return scopeVerdict;

  const preconditionVerdict = evaluatePreconditions(envelope, snapshot, operation, capability);
  if (preconditionVerdict) return preconditionVerdict;

  return {
    ok: true,
    operation,
    gateVersion: CHAT_CORE_V2_COMMAND_BUS_GATE_VERSION,
    commandStatus: operation === 'preview' ? 'previewed' : 'confirmed',
    capabilityId: capability.capabilityId,
  };
}

export function findCommandCapability(envelope: Pick<AICommandEnvelope, 'domain' | 'commandType'>): CapabilityDefinition | undefined {
  return listChatCoreV2CapabilitiesByDomain(envelope.domain)
    .find((capability) => capability.commandType === envelope.commandType);
}

function evaluateIdentity(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2CommandGateSnapshot,
  operation: ChatCoreV2CommandOperation,
): ChatCoreV2CommandGateVerdict | undefined {
  if (envelope.userId !== snapshot.actorUserId || envelope.authorization.actorUserId !== snapshot.actorUserId) {
    return rejected(operation, 'wrong_actor', 'rejected_by_policy');
  }
  if (envelope.tenantId !== snapshot.tenantId || envelope.authorization.tenantId !== snapshot.tenantId) {
    return rejected(operation, 'wrong_tenant', 'rejected_by_policy');
  }
  return undefined;
}

function evaluateExpiry(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2CommandGateSnapshot,
  operation: ChatCoreV2CommandOperation,
): ChatCoreV2CommandGateVerdict | undefined {
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (snapshot.now ?? new Date()).getTime()) {
    return rejected(operation, 'expired', 'expired');
  }
  return undefined;
}

function evaluateCapabilityOperation(
  capability: CapabilityDefinition,
  operation: ChatCoreV2CommandOperation,
): ChatCoreV2CommandGateVerdict | undefined {
  if (capability.risk === 'restricted' || capability.confirmationPolicy === 'never_execute') {
    return rejected(operation, 'restricted_command', 'rejected_by_policy', capability.capabilityId);
  }

  if (operation === 'preview') {
    if (capability.support.preview !== 'supported' && capability.support.preview !== 'preview_only') {
      return rejected(operation, 'capability_not_previewable', 'rejected_by_policy', capability.capabilityId);
    }
    return undefined;
  }

  if (capability.support.execute !== 'supported') {
    return rejected(operation, 'capability_not_executable', 'rejected_by_policy', capability.capabilityId);
  }
  return undefined;
}

function evaluateDelegatedScopes(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2CommandGateSnapshot,
  capability: CapabilityDefinition,
  operation: ChatCoreV2CommandOperation,
): ChatCoreV2CommandGateVerdict | undefined {
  const delegatedScopes = new Set(snapshot.delegatedScopes ?? envelope.authorization.delegatedScopes);
  const missingScopes = capability.requiredPermissions.filter((scope) => !delegatedScopes.has(scope));
  if (missingScopes.length > 0) {
    return {
      ...rejected(operation, 'missing_delegated_scope', 'rejected_by_policy', capability.capabilityId),
      missingScopes,
    };
  }
  return undefined;
}

function evaluatePreconditions(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2CommandGateSnapshot,
  operation: ChatCoreV2CommandOperation,
  capability: CapabilityDefinition,
): ChatCoreV2CommandGateVerdict | undefined {
  const staleEntities = Object.entries(envelope.preconditions.requiredEntityVersions)
    .filter(([entityId, expectedVersion]) => snapshot.currentEntityVersions?.[entityId] !== expectedVersion)
    .map(([entityId, expectedVersion]) => ({
      entityId,
      expectedVersion,
      actualVersion: snapshot.currentEntityVersions?.[entityId],
    }));
  if (staleEntities.length > 0) {
    return {
      ...rejected(operation, 'stale_entity_version', 'stale', capability.capabilityId),
      staleEntities,
    };
  }

  if (versionChanged(envelope.preconditions.requiredPermissionsVersion, snapshot.permissionSnapshotVersion)) {
    return rejected(operation, 'permission_version_changed', 'rejected_by_policy', capability.capabilityId);
  }
  if (versionChanged(envelope.preconditions.requiredTenantPolicyVersion, snapshot.tenantPolicyVersion)) {
    return rejected(operation, 'tenant_policy_version_changed', 'rejected_by_policy', capability.capabilityId);
  }
  if (versionChanged(envelope.preconditions.requiredIntegrationConnectionVersion, snapshot.integrationConnectionVersion)) {
    return rejected(operation, 'integration_connection_version_changed', 'rejected_by_policy', capability.capabilityId);
  }
  if (versionChanged(envelope.preconditions.requiredDecisionVersion, snapshot.decisionVersion)) {
    return rejected(operation, 'decision_version_changed', 'rejected_by_policy', capability.capabilityId);
  }

  const failedInvariants = envelope.preconditions.invariants
    .filter((invariant) => snapshot.invariantResults?.[invariant.check] !== true)
    .map((invariant) => invariant.check);
  if (failedInvariants.length > 0) {
    return {
      ...rejected(operation, 'invariant_failed', 'rejected_by_policy', capability.capabilityId),
      failedInvariants,
    };
  }

  return undefined;
}

function versionChanged(required: string | undefined, actual: string | undefined): boolean {
  return required !== undefined && required !== actual;
}

function rejected(
  operation: ChatCoreV2CommandOperation,
  reason: ChatCoreV2CommandRejectionReason,
  commandStatus: CommandStatus,
  capabilityId?: string,
): ChatCoreV2CommandGateVerdict {
  return {
    ok: false,
    operation,
    gateVersion: CHAT_CORE_V2_COMMAND_BUS_GATE_VERSION,
    commandStatus,
    capabilityId,
    reason,
  };
}
