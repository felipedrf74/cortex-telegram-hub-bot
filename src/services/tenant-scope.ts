// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logAudit } from './audit-trail';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export interface TenantScope {
  userId: number;
  tenantId: number;
}

export interface TenantScopedRequestLike {
  userId?: unknown;
  tenantId?: unknown;
  ip?: string;
  originalUrl?: string;
  path?: string;
}

export class TenantScopeError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'TenantScopeError';
    this.code = code;
    this.status = status;
  }
}

export function assertTenantScope(
  req: TenantScopedRequestLike,
  operation = 'tenant_scope',
): TenantScope {
  const userId = typeof req.userId === 'number' ? req.userId : null;
  const tenantId = typeof req.tenantId === 'number' ? req.tenantId : null;

  const hasValidUser = isValidTenantUserId(userId);
  const hasValidTenant = isValidTenantUserId(tenantId);

  if (!hasValidUser || !hasValidTenant) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: hasValidUser && tenantId == null ? 'missing_tenant_scope' : 'invalid_user_scope',
      userId: hasValidUser ? userId : null,
      details: {
        hasTenantId: tenantId != null,
        path: req.originalUrl ?? req.path ?? null,
      },
    });
    throw new TenantScopeError('UNAUTHORIZED', 'Invalid authenticated tenant scope');
  }

  return { userId, tenantId };
}

export function requireMutationScope(
  req: TenantScopedRequestLike,
  tableName: string,
  operation = 'mutation_scope',
): TenantScope {
  const scope = assertTenantScope(req, operation);
  logAudit({
    userId: scope.userId,
    tenantId: scope.tenantId,
    actorId: scope.userId,
    action: 'mutation_scope',
    resource: tableName,
    details: {
      operation,
      path: req.originalUrl ?? req.path ?? null,
    },
    ipAddress: req.ip,
  });
  return scope;
}

/**
 * Service-layer guard for functions that previously accepted `tenantId?` and
 * fell back to `userId` when it was missing. The skill-hardening QA on
 * 2026-05-18 identified 4 such sites where the silent fallback could mask a
 * route-layer bug. Service functions should now call this helper and throw
 * loudly when a validated tenantId is absent — the route layer must
 * `assertTenantScope(req)` first and pass the result through.
 *
 * Throws synchronously with a stable error code so callers can detect
 * it in tests without depending on error message wording.
 */
export function requireTenantIdParam(tenantId: unknown, contextName: string): number {
  if (typeof tenantId !== 'number' || !Number.isFinite(tenantId) || tenantId <= 0 || !Number.isSafeInteger(tenantId)) {
    const err = new TenantScopeError(
      'TENANT_SCOPE_REQUIRED',
      `${contextName} requires a validated tenantId (positive safe integer); got ${typeof tenantId}=${String(tenantId)}`,
      400,
    );
    recordTenantScopeAnomaly({
      layer: 'service',
      operation: contextName,
      reason: 'missing_tenant_scope',
      userId: null,
      details: { received: String(tenantId) },
    });
    if (/\btraining\b/i.test(contextName)) {
      incrementTrainingGenerationCounter('tenant_scope_missing_blocked_total');
    }
    throw err;
  }
  return tenantId;
}
