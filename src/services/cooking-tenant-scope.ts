// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type CookingVisibilityScope =
  | 'user_private'
  | 'tenant_shared'
  | 'tenant_admin_visible'
  | 'platform_internal';

export type CookingScopeStatus = 'active' | 'quarantined' | 'archived' | 'deleted';

export interface CookingScopeInsert {
  tenantId: number;
  ownerUserId: number;
  visibilityScope: CookingVisibilityScope;
  lifecycleState: string;
  scopeStatus: CookingScopeStatus;
  createdBy: number;
  updatedBy: number;
  auditMetadataJson: string;
}

export function resolveCookingTenantId(userId: number, tenantId?: number | null): number {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('COOKING_SCOPE_INVALID_USER: userId must be a positive safe integer');
  }
  if (tenantId === undefined || tenantId === null) return userId;
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('COOKING_SCOPE_INVALID_TENANT: tenantId must be a positive safe integer');
  }
  return tenantId;
}

export function cookingScopeForInsert(
  userId: number,
  tenantId?: number | null,
  visibilityScope: CookingVisibilityScope = 'user_private',
  lifecycleState = 'active',
): CookingScopeInsert {
  return {
    tenantId: resolveCookingTenantId(userId, tenantId),
    ownerUserId: userId,
    visibilityScope,
    lifecycleState,
    scopeStatus: 'active',
    createdBy: userId,
    updatedBy: userId,
    auditMetadataJson: '{}',
  };
}

export function cookingPrivateScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  return `(
    ${c('scope_status')} = 'active'
    AND ${c('visibility_scope')} = 'user_private'
    AND ${c('tenant_id')} = ?
    AND ${c('owner_user_id')} = ?
  )`;
}

export function cookingScopeParams(userId: number, tenantId?: number | null): [number, number] {
  return [resolveCookingTenantId(userId, tenantId), userId];
}
