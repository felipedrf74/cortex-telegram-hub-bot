// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { isDecisionActionExecutable } from './decision-center-action-truth-table';

export type SharedNotificationLifecycleStatus =
  | 'unread'
  | 'read'
  | 'viewed'
  | 'snoozed'
  | 'actioned'
  | 'dismissed'
  | 'failed'
  | 'expired'
  | 'superseded'
  | string;

export type SharedNotificationActionEffectiveState =
  | 'enabled'
  | 'disabled_unsupported'
  | 'disabled_not_implemented'
  | 'disabled_blocked_by_dependency'
  | 'disabled_requires_reconnect'
  | 'disabled_expired'
  | 'disabled_superseded'
  | 'disabled_already_actioned'
  | 'disabled_missing_details';

export interface SharedNotificationActionEffectiveStatus {
  actionId: string;
  effective: SharedNotificationActionEffectiveState;
  implemented: boolean;
  capabilityReason: string | null;
}

export interface SharedNotificationActionStateInput {
  actionId: string;
  status: SharedNotificationLifecycleStatus;
  expiresAt?: string | null;
  safeForFrontendAction?: boolean;
  blockedByDependency?: boolean;
  supported?: boolean;
  unsupportedReason?: string | null;
  reconnectRequired?: boolean;
  reconnectReason?: string | null;
  nowMs?: number;
}

export function computeSharedNotificationActionEffectiveStatus(
  input: SharedNotificationActionStateInput,
): SharedNotificationActionEffectiveStatus {
  const truthTableImplemented = isDecisionActionExecutable(input.actionId);
  const implemented = input.supported === false ? false : truthTableImplemented;
  const base = { actionId: input.actionId, implemented };

  if (input.supported === false) {
    return {
      ...base,
      effective: 'disabled_unsupported',
      capabilityReason: input.unsupportedReason ?? `Action '${input.actionId}' is not supported by this notification contract`,
    };
  }
  if (input.safeForFrontendAction === false) {
    return {
      ...base,
      effective: 'disabled_missing_details',
      capabilityReason: 'Decision details incomplete',
    };
  }
  if (!implemented) {
    if (input.reconnectRequired) {
      return {
        ...base,
        effective: 'disabled_requires_reconnect',
        capabilityReason: input.reconnectReason ?? 'Reconnect this provider in connection settings to resume syncing',
      };
    }
    return {
      ...base,
      effective: 'disabled_not_implemented',
      capabilityReason: `No deterministic executor wired for '${input.actionId}' yet`,
    };
  }
  if (isExpired(input.expiresAt, input.nowMs) || input.status === 'expired') {
    return { ...base, effective: 'disabled_expired', capabilityReason: null };
  }
  if (input.status === 'superseded' || input.status === 'dismissed') {
    return { ...base, effective: 'disabled_superseded', capabilityReason: null };
  }
  if (input.status === 'actioned') {
    return { ...base, effective: 'disabled_already_actioned', capabilityReason: null };
  }
  if (input.blockedByDependency) {
    return { ...base, effective: 'disabled_blocked_by_dependency', capabilityReason: 'Blocked by another decision' };
  }
  return { ...base, effective: 'enabled', capabilityReason: null };
}

function isExpired(expiresAt: string | null | undefined, nowMs?: number): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= (nowMs ?? Date.now());
}
