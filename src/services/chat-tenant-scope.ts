// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  isValidTenantUserId,
  recordTenantScopeAnomaly,
  type TenantScopeAnomalyLayer,
} from './tenant-scope-observability';

export type ChatVisibilityScope =
  | 'user_private'
  | 'tenant_shared'
  | 'tenant_admin_visible'
  | 'platform_admin_visible'
  | 'system_internal';

export type ChatScopeStatus = 'active' | 'quarantined';

export interface ChatTenantScope {
  tenantId: number;
  userId: number;
  visibilityScope: ChatVisibilityScope;
  scopeStatus: ChatScopeStatus;
  createdBy: number;
}

export interface ChatTenantScopeInput {
  userId: number | null | undefined;
  tenantId?: number | null;
  visibilityScope?: ChatVisibilityScope | null;
  operation: string;
  layer?: TenantScopeAnomalyLayer;
  details?: Record<string, unknown>;
}

export const DEFAULT_CHAT_VISIBILITY_SCOPE: ChatVisibilityScope = 'user_private';

export function isValidChatTenantId(tenantId: number | null | undefined): tenantId is number {
  return isValidTenantUserId(tenantId);
}

export function resolveChatTenantId(userId: number, tenantId?: number | null): number {
  if (isValidChatTenantId(tenantId)) return tenantId;
  return userId;
}

export function resolveChatTenantScope(input: ChatTenantScopeInput): ChatTenantScope | null {
  const layer = input.layer ?? 'delivery';
  if (!isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer,
      operation: input.operation,
      reason: input.userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: input.details,
    });
    return null;
  }

  const tenantId = resolveChatTenantId(input.userId, input.tenantId);
  if (!isValidChatTenantId(tenantId)) {
    recordTenantScopeAnomaly({
      layer,
      operation: input.operation,
      reason: 'invalid_user_scope',
      userId: input.userId,
      details: {
        ...input.details,
        tenantId,
      },
    });
    return null;
  }

  return {
    tenantId,
    userId: input.userId,
    visibilityScope: input.visibilityScope ?? DEFAULT_CHAT_VISIBILITY_SCOPE,
    scopeStatus: 'active',
    createdBy: input.userId,
  };
}

export function isActiveChatScopeStatus(status: string | null | undefined): boolean {
  return !status || status === 'active';
}
