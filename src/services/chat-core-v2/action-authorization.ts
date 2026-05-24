// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import { findCommandCapability } from './command-bus';
import type {
  AIActionAuthorization,
  AICommandEnvelope,
  CapabilityDefinition,
} from './types';

export const CHAT_CORE_V2_ACTION_AUTHORIZATION_VERSION = 'chat_core_v2_action_authorization@1.0.0';

export type ChatCoreV2ActionAuthorizationReason =
  | 'wrong_actor'
  | 'wrong_tenant'
  | 'acting_surface_not_allowed'
  | 'missing_delegated_scope'
  | 'permission_snapshot_changed'
  | 'auth_time_invalid'
  | 'auth_time_expired'
  | 'unknown_command';

export interface BuildChatCoreV2ActionAuthorizationInput {
  actorUserId: string | number;
  tenantId: string | number;
  actingSurface: AIActionAuthorization['actingSurface'];
  delegatedScopes: string[];
  authTime?: string | Date;
  permissionPolicyVersion?: string;
  tenantPolicyVersion?: string;
  integrationConnectionVersion?: string;
  permissionSnapshotVersion?: string;
}

export interface ChatCoreV2ActionAuthorizationSnapshot {
  actorUserId: string | number;
  tenantId: string | number;
  actingSurface: AIActionAuthorization['actingSurface'];
  delegatedScopes?: string[];
  permissionSnapshotVersion?: string;
  now?: Date;
  maxAuthorizationAgeMs?: number;
  allowedSurfaces?: AIActionAuthorization['actingSurface'][];
}

export interface ChatCoreV2ActionAuthorizationVerdict {
  ok: boolean;
  authorizationVersion: string;
  actorUserId: string;
  tenantId: string;
  actingSurface: AIActionAuthorization['actingSurface'];
  permissionSnapshotVersion?: string;
  delegatedScopes: string[];
  reason?: ChatCoreV2ActionAuthorizationReason;
  missingScopes?: string[];
}

export function buildChatCoreV2ActionAuthorization(
  input: BuildChatCoreV2ActionAuthorizationInput,
): AIActionAuthorization {
  const delegatedScopes = normalizeScopes(input.delegatedScopes);
  const authTime = toIsoString(input.authTime ?? new Date());
  return {
    actorUserId: normalizeId(input.actorUserId),
    tenantId: normalizeId(input.tenantId),
    actingSurface: input.actingSurface,
    delegatedScopes,
    permissionSnapshotVersion: input.permissionSnapshotVersion ?? buildChatCoreV2PermissionSnapshotVersion({
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      actingSurface: input.actingSurface,
      delegatedScopes,
      permissionPolicyVersion: input.permissionPolicyVersion,
      tenantPolicyVersion: input.tenantPolicyVersion,
      integrationConnectionVersion: input.integrationConnectionVersion,
    }),
    authTime,
  };
}

export function buildChatCoreV2PermissionSnapshotVersion(input: {
  actorUserId: string | number;
  tenantId: string | number;
  actingSurface: AIActionAuthorization['actingSurface'];
  delegatedScopes: string[];
  permissionPolicyVersion?: string;
  tenantPolicyVersion?: string;
  integrationConnectionVersion?: string;
}): string {
  const payload = JSON.stringify({
    actorUserId: normalizeId(input.actorUserId),
    tenantId: normalizeId(input.tenantId),
    actingSurface: input.actingSurface,
    delegatedScopes: normalizeScopes(input.delegatedScopes),
    permissionPolicyVersion: input.permissionPolicyVersion ?? 'unknown',
    tenantPolicyVersion: input.tenantPolicyVersion ?? 'unknown',
    integrationConnectionVersion: input.integrationConnectionVersion ?? 'unknown',
  });
  return `perm:${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
}

export function evaluateChatCoreV2ActionAuthorization(
  authorization: AIActionAuthorization,
  snapshot: ChatCoreV2ActionAuthorizationSnapshot,
  requiredScopes: string[] = [],
): ChatCoreV2ActionAuthorizationVerdict {
  const actorUserId = normalizeId(snapshot.actorUserId);
  const tenantId = normalizeId(snapshot.tenantId);
  const delegatedScopes = normalizeScopes(snapshot.delegatedScopes ?? authorization.delegatedScopes);

  const base = {
    authorizationVersion: CHAT_CORE_V2_ACTION_AUTHORIZATION_VERSION,
    actorUserId,
    tenantId,
    actingSurface: snapshot.actingSurface,
    permissionSnapshotVersion: authorization.permissionSnapshotVersion,
    delegatedScopes,
  };

  if (authorization.actorUserId !== actorUserId) {
    return { ...base, ok: false, reason: 'wrong_actor' };
  }
  if (authorization.tenantId !== tenantId) {
    return { ...base, ok: false, reason: 'wrong_tenant' };
  }

  const allowedSurfaces = snapshot.allowedSurfaces ?? ['ios_chat', 'web_chat'];
  if (authorization.actingSurface !== snapshot.actingSurface || !allowedSurfaces.includes(authorization.actingSurface)) {
    return { ...base, ok: false, reason: 'acting_surface_not_allowed' };
  }

  const authTimeMs = Date.parse(authorization.authTime);
  if (!Number.isFinite(authTimeMs)) {
    return { ...base, ok: false, reason: 'auth_time_invalid' };
  }
  const maxAgeMs = snapshot.maxAuthorizationAgeMs;
  if (maxAgeMs != null && (snapshot.now ?? new Date()).getTime() - authTimeMs > maxAgeMs) {
    return { ...base, ok: false, reason: 'auth_time_expired' };
  }

  if (
    snapshot.permissionSnapshotVersion != null
    && authorization.permissionSnapshotVersion !== snapshot.permissionSnapshotVersion
  ) {
    return { ...base, ok: false, reason: 'permission_snapshot_changed' };
  }

  const delegated = new Set(delegatedScopes);
  const missingScopes = normalizeScopes(requiredScopes).filter((scope) => !delegated.has(scope));
  if (missingScopes.length > 0) {
    return { ...base, ok: false, reason: 'missing_delegated_scope', missingScopes };
  }

  return { ...base, ok: true };
}

export function evaluateChatCoreV2CommandAuthorization(
  envelope: AICommandEnvelope,
  snapshot: ChatCoreV2ActionAuthorizationSnapshot,
): ChatCoreV2ActionAuthorizationVerdict {
  const capability = findCommandCapability(envelope);
  if (!capability) {
    return {
      ok: false,
      authorizationVersion: CHAT_CORE_V2_ACTION_AUTHORIZATION_VERSION,
      actorUserId: normalizeId(snapshot.actorUserId),
      tenantId: normalizeId(snapshot.tenantId),
      actingSurface: snapshot.actingSurface,
      delegatedScopes: normalizeScopes(snapshot.delegatedScopes ?? envelope.authorization.delegatedScopes),
      reason: 'unknown_command',
    };
  }
  return evaluateChatCoreV2CapabilityAuthorization(envelope.authorization, snapshot, capability);
}

export function evaluateChatCoreV2CapabilityAuthorization(
  authorization: AIActionAuthorization,
  snapshot: ChatCoreV2ActionAuthorizationSnapshot,
  capability: Pick<CapabilityDefinition, 'requiredPermissions'>,
): ChatCoreV2ActionAuthorizationVerdict {
  return evaluateChatCoreV2ActionAuthorization(
    authorization,
    snapshot,
    capability.requiredPermissions,
  );
}

function normalizeId(value: string | number): string {
  return String(value);
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
